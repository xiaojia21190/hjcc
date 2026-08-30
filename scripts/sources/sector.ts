// ---------- 行业板块日线（东财板块 push2 / push2his）----------
import type { SectorSeries, SectorTrendData } from '../../shared/types'
import { fetchMarketBars, type MarketBar } from './eastmoney'
import { fetchJson, sleep } from './http'

/**
 * 东财板块代码按层级分段，每一段各自完整覆盖一次全市场：
 * BK04-BK10 为申万二级（74 个），BK12-BK16 为申万三级（354 个）。
 * 只取二级段，保证板块互斥不重叠——重叠板块会同涨同跌，人为压低横截面分化度。
 * 选二级而非一级，是因为一级会把题材平均掉（「电子」会稀释掉半导体行情）。
 */
const LEVEL2_CODE_PATTERN = /^BK(0[4-9]|10)/
const SECTOR_LIST_HOSTS = [
  'https://push2.eastmoney.com',
  // push2delay 排最后：其 CDN 节点在 ARM Linux 上会 TCP 连接成功但 HTTP 永远不响应
  'https://push2delay.eastmoney.com',
]
const SECTOR_PAGE_SIZE = 100
const SECTOR_REFERER = 'https://quote.eastmoney.com/'
/** 保留的交易日数：需覆盖分位回溯 480 日 + 最长窗口 60 日。 */
const TREND_DAYS = 600
/** 日线起始日，留足冗余以便对齐后仍有 TREND_DAYS 个交易日。 */
const TREND_BEGIN = '20220101'
/** 数据点数低于中位数此比例的板块视为次新板块，剔除以免削减公共交易日轴。 */
const MIN_COVERAGE_RATIO = 0.95
/**
 * 板块日线走日线接口，该接口限流较严且曾出现按路径整体封禁。
 * 改为完全串行 + 秒级间隔，宁可慢也不要触发封禁——一旦被封，
 * 后续所有板块都会连带失败，代价远高于多花几十秒。
 */
const SECTOR_INTERVAL_MS = 900
/** 补抓轮的间隔更长，给对端多留冷却时间。 */
const SECTOR_RETRY_INTERVAL_MS = 2000
/**
 * 连续失败达到此数即中止本轮。区分「偶发抖动」与「域名级封禁」：
 * 前者零星出现、补抓可救；后者会让每个板块都失败，继续跑完 74 个
 * 只是白白拖十几分钟，还会延长封禁。
 */
const SECTOR_FAILURE_STREAK_LIMIT = 8

export const SECTOR_SOURCE_NOTE =
  '东方财富行业板块（申万二级口径，BK04-BK10 段），日线收盘价；' +
  '同层级板块互斥且完整覆盖全市场，按公共交易日对齐。'

interface SectorMeta {
  code: string
  name: string
}

interface SectorListResponse {
  data?: {
    total?: number
    diff?: { f12: string; f14: string }[]
  } | null
}

async function fetchSectorPage(page: number, host: string): Promise<SectorListResponse> {
  const url =
    `${host}/api/qt/clist/get?pn=${page}&pz=${SECTOR_PAGE_SIZE}` +
    '&po=1&np=1&fltt=2&invt=2&fid=f12&fs=m:90+t:2&fields=f12,f14'
  return fetchJson<SectorListResponse>(url, SECTOR_REFERER)
}

/** 拉取全部行业板块并筛出申万二级层级。 */
export async function fetchSectorList(): Promise<SectorMeta[]> {
  let first: SectorListResponse | null = null
  let host = SECTOR_LIST_HOSTS[0]
  for (const candidate of SECTOR_LIST_HOSTS) {
    try {
      first = await fetchSectorPage(1, candidate)
      host = candidate
      break
    } catch (error) {
      console.warn(`板块列表域名不可用 ${candidate}`, error)
    }
  }
  if (!first) throw new Error('板块列表主域名与备用域名均不可用')

  const total = first.data?.total ?? 0
  const rows = [...(first.data?.diff ?? [])]
  for (let page = 2; page <= Math.ceil(total / SECTOR_PAGE_SIZE); page++) {
    try {
      rows.push(...((await fetchSectorPage(page, host)).data?.diff ?? []))
    } catch (error) {
      console.warn(`板块列表第 ${page} 页失败`, error)
    }
    await sleep(SECTOR_INTERVAL_MS)
  }

  const level2 = rows
    .filter((row) => LEVEL2_CODE_PATTERN.test(row.f12))
    .map((row) => ({ code: String(row.f12), name: String(row.f14) }))
  console.log(`行业板块 ${level2.length}/${rows.length} 只（申万二级层级）`)
  return level2
}

interface RawSector extends SectorMeta {
  bars: MarketBar[]
}

export type { RawSector }

/** 单个板块日线抓取器；参数化以便测试补抓逻辑时不触网。 */
export type SectorBarFetcher = (meta: SectorMeta) => Promise<MarketBar[]>

/**
 * 串行抓取板块日线，并对首轮失败的板块补抓一轮。
 * 补抓是必要的：首轮失败的板块会被 alignSectors 当作次新板块剔除，
 * 一次网络抖动就会永久性地少掉一个板块，压低横截面分化度。
 */
export async function collectSectorBars(
  list: SectorMeta[],
  fetcher: SectorBarFetcher,
  options: {
    intervalMs?: number
    retryIntervalMs?: number
    failureStreakLimit?: number
  } = {},
): Promise<RawSector[]> {
  const interval = options.intervalMs ?? SECTOR_INTERVAL_MS
  const retryInterval = options.retryIntervalMs ?? SECTOR_RETRY_INTERVAL_MS
  const streakLimit = options.failureStreakLimit ?? SECTOR_FAILURE_STREAK_LIMIT

  const attempt = async (meta: SectorMeta, quiet: boolean): Promise<MarketBar[]> => {
    try {
      return await fetcher(meta)
    } catch (error) {
      if (!quiet) console.warn(`  板块日线 ${meta.code} ${meta.name} 失败`, error)
      return []
    }
  }

  const out: RawSector[] = list.map((meta) => ({ ...meta, bars: [] }))
  let streak = 0
  for (const [index, sector] of out.entries()) {
    if (index > 0) await sleep(interval)
    // 首轮失败不打印，留给补抓轮定论，避免同一板块刷两条告警
    sector.bars = await attempt(sector, true)
    streak = sector.bars.length > 0 ? 0 : streak + 1
    if (streak >= streakLimit) {
      console.warn(
        `  连续 ${streak} 只板块无数据，判定为接口不可用，中止本轮（剩余 ${out.length - index - 1} 只）`,
      )
      return out
    }
  }

  const pending = out.filter((sector) => sector.bars.length === 0)
  if (pending.length === 0) return out

  console.log(`  ${pending.length} 只板块首轮无数据，低速补抓…`)
  for (const [index, sector] of pending.entries()) {
    if (index > 0) await sleep(retryInterval)
    sector.bars = await attempt(sector, false)
  }
  const stillEmpty = out.filter((sector) => sector.bars.length === 0).length
  if (stillEmpty > 0) console.warn(`  补抓后仍有 ${stillEmpty} 只板块无数据`)
  return out
}

/** 按串行节流抓取板块日线，单个板块失败不影响整体。 */
async function fetchSectorBars(list: SectorMeta[]): Promise<RawSector[]> {
  return collectSectorBars(list, (meta) =>
    fetchMarketBars(`90.${meta.code}`, SECTOR_REFERER, {
      beg: TREND_BEGIN,
      lmt: TREND_DAYS * 2,
    }),
  )
}

/**
 * 先剔除数据点明显偏少的板块（多为次新板块），再取公共交易日交集。
 * 顺序不能反：直接取交集会让一个次新板块把整条时间轴削到几十天。
 */
export function alignSectors(raw: RawSector[]): {
  dates: string[]
  sectors: SectorSeries[]
} {
  const usable = raw.filter((sector) => sector.bars.length > 0)
  if (usable.length === 0) return { dates: [], sectors: [] }

  const counts = usable.map((sector) => sector.bars.length).sort((a, b) => a - b)
  const median = counts[Math.floor(counts.length / 2)]
  const kept = usable.filter((sector) => sector.bars.length >= median * MIN_COVERAGE_RATIO)
  const dropped = usable.length - kept.length
  if (dropped > 0) console.log(`  剔除 ${dropped} 只数据不足的板块`)

  const maps = kept.map(
    (sector) => new Map(sector.bars.map((bar) => [bar.date, bar.close])),
  )
  const dates = [...maps[0].keys()]
    .filter((date) => maps.every((map) => (map.get(date) ?? 0) > 0))
    .sort()
    .slice(-TREND_DAYS)

  return {
    dates,
    sectors: kept.map((sector, index) => ({
      code: sector.code,
      name: sector.name,
      closes: dates.map((date) => maps[index].get(date) as number),
    })),
  }
}

/** 抓取行业板块日线矩阵；任一环节失败返回 null，由调用方降级处理。 */
export async function fetchSectorTrend(): Promise<SectorTrendData | null> {
  try {
    const list = await fetchSectorList()
    if (list.length === 0) throw new Error('未筛出任何二级行业板块')

    const raw = await fetchSectorBars(list)
    const { dates, sectors } = alignSectors(raw)
    if (dates.length === 0 || sectors.length === 0) {
      throw new Error('板块日线对齐后为空')
    }

    console.log(
      `行业板块日线 ${sectors.length} 只 × ${dates.length} 个交易日` +
        `（${dates[0]} → ${dates[dates.length - 1]}）`,
    )
    return {
      dates,
      sectors,
      source: SECTOR_SOURCE_NOTE,
      fetchedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.warn('行业板块日线抓取失败，题材主线判定将降级', error)
    return null
  }
}
