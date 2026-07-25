/**
 * 数据抓取：新浪财经十大持有人 + 东方财富规模/净值/行情
 * 仅使用公开网页接口，结果落盘 data/dashboard.json
 */
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { CATEGORIES } from '../shared/categories'
import type {
  DashboardData,
  EtfQuote,
  EtfSnapshot,
} from '../shared/types'
import { computeOfficialFetchDates } from '../shared/backfill-window'
import { buildHuijinEstimate } from './lib/estimate'
import {
  buildHuijinHistory,
  dedupeHolderReports,
  mergeScaleHistory,
} from './lib/merge'
import {
  fetchEtfUniverse,
  fetchMarketActiveCapHistory,
  fetchNavHistory,
  fetchScaleHistory,
  pickLargestPerCategory,
} from './sources/eastmoney'
import { sleep } from './sources/http'
import { fetchAllHolderReports } from './sources/sina'
import { fetchSseDailyShares, type OfficialDailySharePoint } from './sources/sse'
import { fetchSzseDailyShares } from './sources/szse'

const ROOT = join(import.meta.dir, '..')
const DATA_DIR = join(ROOT, 'data')
const OUT_FILE = join(DATA_DIR, 'dashboard.json')

const OFFICIAL_SHARE_OVERLAP_TRADING_DAYS = 5

async function loadPreviousDashboard(): Promise<DashboardData | null> {
  const candidates = [
    OUT_FILE,
    join(ROOT, 'public', 'dashboard.json'),
    join(ROOT, 'dist', 'dashboard.json'),
  ]
  let best: DashboardData | null = null
  let bestReports = 0
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf-8')) as DashboardData
      const reports = parsed.etfs.reduce(
        (sum, etf) => sum + (etf.holderReports?.length ?? 0),
        0,
      )
      if (reports > bestReports) {
        best = parsed
        bestReports = reports
      }
    } catch {
      /* no previous snapshot at this path */
    }
  }
  return best
}

export function officialPointsFromSnapshot(
  snapshot?: EtfSnapshot,
): OfficialDailySharePoint[] {
  if (!snapshot) return []
  return snapshot.scaleHistory
    .filter(
      (point) =>
        point.frequency === 'daily' &&
        (point.shareSource === 'sse' || point.shareSource === 'szse'),
    )
    .map((point) => ({
      date: point.date,
      totalSharesYi: point.totalSharesYi,
      shareSource: point.shareSource as 'sse' | 'szse',
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

export function mergeOfficialPoints(
  previous: OfficialDailySharePoint[],
  fetched: OfficialDailySharePoint[],
): OfficialDailySharePoint[] {
  const byDate = new Map(previous.map((point) => [point.date, point]))
  for (const point of fetched) byDate.set(point.date, point)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function fallbackWeekdays(): string[] {
  const dates: string[] = []
  const cursor = new Date()
  for (let offset = 0; offset < 420; offset++) {
    const day = new Date(cursor)
    day.setUTCDate(day.getUTCDate() - offset)
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      dates.push(day.toISOString().slice(0, 10))
    }
  }
  return dates.reverse()
}

async function fetchOfficialShareHistories(
  picks: Array<{ quote: EtfQuote }>,
  previous: DashboardData | null,
  marketDates: string[],
): Promise<{
  histories: Map<string, OfficialDailySharePoint[]>
  gaps: Map<string, { sseFailedDates?: string[]; szseFailedRanges?: string[] }>
}> {
  const histories = new Map<string, OfficialDailySharePoint[]>()
  const gaps = new Map<string, { sseFailedDates?: string[]; szseFailedRanges?: string[] }>()
  const fetchDatesByCode = new Map<string, string[]>()

  // 最近汇金披露日（取所有 ETF 末尾披露日的最大值）
  const allReportDates = (previous?.etfs ?? [])
    .flatMap((etf) => etf.huijinHistory.map((h) => h.reportDate))
    .sort()
  const latestHuijinReportDate = allReportDates.at(-1) ?? null

  for (const { quote } of picks) {
    const prior = officialPointsFromSnapshot(
      previous?.etfs.find((etf) => etf.code === quote.code),
    )
    histories.set(quote.code, prior)
    fetchDatesByCode.set(
      quote.code,
      computeOfficialFetchDates({
        existing: prior.map((p) => ({
          date: p.date,
          totalSharesYi: p.totalSharesYi,
          shareSource: p.shareSource,
        })),
        marketDates,
        latestHuijinReportDate,
        overlap: OFFICIAL_SHARE_OVERLAP_TRADING_DAYS,
      }),
    )
  }

  const shCodes = picks
    .map(({ quote }) => quote)
    .filter((quote) => quote.market === 'SH')
    .map((quote) => quote.code)
  const shDates = [
    ...new Set(shCodes.flatMap((code) => fetchDatesByCode.get(code) ?? [])),
  ].sort()
  if (shCodes.length && shDates.length) {
    const { points: fetched, failedDates } = await fetchSseDailyShares(shCodes, shDates)
    for (const code of shCodes) {
      histories.set(
        code,
        mergeOfficialPoints(histories.get(code) ?? [], fetched.get(code) ?? []),
      )
    }
    if (failedDates.length) {
      for (const code of shCodes)
        gaps.set(code, { sseFailedDates: failedDates })
    }
    console.log(`上交所 ETF 日份额：${shCodes.length} 只，查询 ${shDates.length} 个交易日，失败 ${failedDates.length} 日`)
  }

  const szQuotes = picks
    .map(({ quote }) => quote)
    .filter((quote) => quote.market === 'SZ')
  for (const quote of szQuotes) {
    const dates = fetchDatesByCode.get(quote.code) ?? []
    if (!dates.length) continue
    const { points: fetched, failedRanges } = await fetchSzseDailyShares(
      quote.code,
      dates[0]!,
      dates[dates.length - 1]!,
    )
    histories.set(
      quote.code,
      mergeOfficialPoints(histories.get(quote.code) ?? [], fetched),
    )
    if (failedRanges.length)
      gaps.set(quote.code, { szseFailedRanges: failedRanges })
    console.log(`深交所 ETF 日份额：${quote.code} 共 ${histories.get(quote.code)?.length ?? 0} 条，失败 ${failedRanges.length} 段`)
  }

  return { histories, gaps }
}

async function buildEtfSnapshot(
  category: (typeof CATEGORIES)[number],
  quote: EtfQuote,
  officialDailyShares: OfficialDailySharePoint[],
  previous?: EtfSnapshot,
  shareFetchGaps?: { sseFailedDates?: string[]; szseFailedRanges?: string[] },
): Promise<EtfSnapshot> {
  const code = quote.code
  console.log(`\n→ ${category.name} ${code} ${quote.name}`)

  const [holderReportsFetched, scaleHistoryFetched, navHistoryFetched] =
    await Promise.all([
      fetchAllHolderReports(code, 12),
      fetchScaleHistory(code),
      fetchNavHistory(code, 80),
    ])

  const holdersFromCache =
    holderReportsFetched.length === 0 && (previous?.holderReports.length ?? 0) > 0
  const rawHolderReports = holdersFromCache
    ? previous?.holderReports ?? []
    : holderReportsFetched
  const holderReports = dedupeHolderReports(rawHolderReports)
  const holdersHistoryDeduplicated =
    holderReports.length < rawHolderReports.length ||
    previous?.source.holdersHistoryDeduplicated === true
  const periodicScaleHistory =
    scaleHistoryFetched.length > 0
      ? scaleHistoryFetched
      : (previous?.scaleHistory ?? []).filter(
          (point) => point.frequency !== 'daily',
        )
  const navHistory =
    navHistoryFetched.length > 0
      ? navHistoryFetched
      : previous?.navHistory ?? []
  const scaleHistory = mergeScaleHistory(
    periodicScaleHistory,
    officialDailyShares,
    navHistory,
  )

  console.log(
    `  holders=${holderReports.length}${holdersFromCache ? ' (cache)' : ''} scale=${scaleHistory.length} daily=${officialDailyShares.length} nav=${navHistory.length}`,
  )

  const disclosedHuijinHistory = buildHuijinHistory(holderReports, navHistory)
  const huijinEstimateHistory = buildHuijinEstimate(
    scaleHistory,
    holderReports,
    navHistory,
  )
  const huijinHistory = disclosedHuijinHistory
  const latestHuijin =
    disclosedHuijinHistory.length > 0
      ? disclosedHuijinHistory[disclosedHuijinHistory.length - 1]
      : null

  return {
    category: category.id,
    categoryName: category.name,
    code,
    name: quote.name,
    market: quote.market,
    quote,
    isLargest: true,
    scaleHistory,
    navHistory,
    holderReports,
    huijinHistory,
    latestHuijin,
    huijinEstimateHistory,
    source: {
      holders:
        '新浪财经 FundPageInfoService.tabsdcyr（基金年报/半年报十大持有人）',
      scale:
        '上交所/深交所 ETF 规模（每日总份额）+ 天天基金 FundArchivesDatas type=gmbd（定期净资产）',
      quote: '东方财富 push2 / push2delay clist 完整分页（按 ETF 总市值选取）',
      huijinEstimate:
        '披露日展示正式披露份额与估值；最后披露期之后按份额锚定法估算（假设汇金不主动赎回，估算份额 = min(披露份额, 当日总份额)，总份额低于披露份额时触发 clamp 并标记可靠性下降）',
      holdersFromCache,
      holdersHistoryDeduplicated,
      holdersFetchedAt: holdersFromCache
        ? previous?.source.fetchedAt
        : new Date().toISOString(),
      shareFetchGaps: shareFetchGaps
        ? shareFetchGaps
        : undefined,
      fetchedAt: new Date().toISOString(),
    },
  }
}

async function main() {
  const previous = await loadPreviousDashboard()
  if (previous) {
    console.log(`发现上次快照 ${previous.updatedAt}，接口无有效报告时将保留该数据`)
  }
  console.log('抓取 ETF 全市场行情…')
  const [universe, marketActiveCapFetched] = await Promise.all([
    fetchEtfUniverse(),
    fetchMarketActiveCapHistory().catch((error) => {
      console.warn('中证全指 0AMV 数据抓取失败，将尝试沿用上次快照', error)
      return []
    }),
  ])
  const marketActiveCapHistory =
    marketActiveCapFetched.length > 0
      ? marketActiveCapFetched
      : previous?.marketActiveCapHistory ?? []
  console.log(`共 ${universe.length} 只 ETF`)
  console.log(`0AMV 市场日线 ${marketActiveCapHistory.length} 条`)

  const picked = await pickLargestPerCategory(universe)
  for (const p of picked) {
    console.log(
      `  选中 ${p.category.name}: ${p.quote.code} ${p.quote.name} 市值=${((p.quote.marketCap ?? 0) / 1e8).toFixed(2)} 亿`,
    )
  }

  console.log('抓取交易所 ETF 每日总份额…')
  const { histories: officialShareHistories, gaps: shareFetchGaps } =
    await fetchOfficialShareHistories(
      picked,
      previous,
      marketActiveCapHistory.map((point) => point.date),
    )

  const etfs: EtfSnapshot[] = []
  for (const p of picked) {
    try {
      const snap = await buildEtfSnapshot(
        p.category,
        p.quote,
        officialShareHistories.get(p.quote.code) ?? [],
        previous?.etfs.find((e) => e.code === p.quote.code),
        shareFetchGaps.get(p.quote.code),
      )
      etfs.push(snap)
      await sleep(300)
    } catch (e) {
      console.error(`失败 ${p.quote.code}`, e)
    }
  }

  let totalMv: number | null = 0
  let latestReport: string | null = null
  for (const e of etfs) {
    if (e.latestHuijin?.marketValue != null && totalMv != null) {
      totalMv += e.latestHuijin.marketValue
    }
    if (
      e.latestHuijin &&
      (!latestReport ||
        e.latestHuijin.reportDate > latestReport)
    ) {
      latestReport = e.latestHuijin.reportDate
    }
  }

  const latestActiveCap = marketActiveCapHistory.at(-1)

  const dashboard: DashboardData = {
    updatedAt: new Date().toISOString(),
    categories: CATEGORIES,
    etfs,
    marketActiveCapHistory,
    marketActiveCapSource:
      '指南针 0AMV（活筹指数）公开近似公式：SMA(沪深两市成交额,10,1) × 中证全指收盘 / 前5日中证全指均值；价格代理来自东方财富中证全指 000985，成交额为上证综指 000001 与深证成指 399001 日成交额之和。指南针原版算法未公开，本序列用于观察方向和趋势，不等同于 ETF 份额、基金净资产或官方 0AMV 绝对值。',
    summary: {
      totalHuijinMarketValue: totalMv,
      latestActiveCapYi: latestActiveCap?.activeCapYi ?? null,
      latestActiveCapDate: latestActiveCap?.date ?? null,
      etfCount: etfs.length,
      latestReportDate: latestReport,
    },
  }

  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(dashboard, null, 2), 'utf-8')
  // 同时写一份给前端 public
  await mkdir(join(ROOT, 'public'), { recursive: true })
  await writeFile(
    join(ROOT, 'public', 'dashboard.json'),
    JSON.stringify(dashboard, null, 2),
    'utf-8',
  )
  console.log(`\n✓ 已写入 ${OUT_FILE}`)
  console.log(
    `  最近披露汇金合计估值: ${totalMv != null ? (totalMv / 1e8).toFixed(2) + ' 亿元' : 'N/A'}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
