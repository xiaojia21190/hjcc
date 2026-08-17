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
  MarketActiveCapPoint,
  MarketActiveCapQuality,
  TurnoverPoint,
} from '../shared/types'
import {
  computeOfficialFetchDates,
  mergeTradingDates,
} from '../shared/backfill-window'
import { buildHuijinEstimate } from './lib/estimate'
import {
  buildHuijinHistory,
  dedupeHolderReports,
  mergeOfficialPoints,
  mergeScaleHistory,
} from './lib/merge'
import { formatCompletenessReport } from './lib/report'
import {
  NAV_FETCH_PAGES,
  serializeDashboard,
  slimEtfSnapshot,
} from './lib/payload'
import {
  fetchEtfUniverse,
  buildMarketActiveCapHistory,
  fetchMarketActiveCapHistory,
  fetchNavHistory,
  fetchScaleHistory,
  fetchTurnoverSnapshot,
  mergeQuoteWithPrevious,
  pickLargestPerCategory,
} from './sources/eastmoney'
import { sleep } from './sources/http'
import { mergeTurnoverHistory } from './lib/turnover'
import { fetchSectorTrend } from './sources/sector'
import { fetchMarginHistory } from './sources/margin'
import { fetchAllHolderReports } from './sources/sina'
import { fetchSseDailyShares, type OfficialDailySharePoint } from './sources/sse'
import { fetchSzseDailyShares } from './sources/szse'
import { fetchLatestMarketActiveCapHistory } from './sources/market-latest'
import { fetchTushareMarketSeries } from './sources/tushare'

const ROOT = join(import.meta.dir, '..')
const DATA_DIR = join(ROOT, 'data')
const OUT_FILE = join(DATA_DIR, 'dashboard.json')

const OFFICIAL_SHARE_OVERLAP_TRADING_DAYS = 5

/** 日频份额回填起点 */
const SHARE_BACKFILL_START = '2024-01-01'

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
        backfillStart: SHARE_BACKFILL_START,
      }),
    )
  }

  // 合并上次缺口日期（优先补抓）
  for (const { quote } of picks) {
    const prevGaps = previous?.etfs.find((e) => e.code === quote.code)?.source.shareFetchGaps
    if (prevGaps?.sseFailedDates?.length && quote.market === 'SH') {
      const dates = fetchDatesByCode.get(quote.code) ?? []
      const merged = [...new Set([...prevGaps.sseFailedDates, ...dates])].sort()
      fetchDatesByCode.set(quote.code, merged)
    }
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

    // 补抓上次 SZSE 失败区间
    const prevGaps = previous?.etfs.find((e) => e.code === quote.code)?.source.shareFetchGaps
    if (prevGaps?.szseFailedRanges?.length) {
      for (const range of prevGaps.szseFailedRanges) {
        const [start, end] = range.split('..').map((s) => s?.replace(/ p\d+$/, ''))
        if (start && end) {
          const { points: gapPoints } = await fetchSzseDailyShares(quote.code, start, end)
          histories.set(quote.code, mergeOfficialPoints(histories.get(quote.code) ?? [], gapPoints))
        }
      }
    }

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
  turnoverHistoryMerged?: TurnoverPoint[],
): Promise<EtfSnapshot> {
  const code = quote.code
  console.log(`\n→ ${category.name} ${code} ${quote.name}`)

  const [holderReportsFetched, scaleHistoryFetched, navHistoryFetched] =
    await Promise.all([
      fetchAllHolderReports(code, 12),
      fetchScaleHistory(code),
      fetchNavHistory(code, NAV_FETCH_PAGES),
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

  return slimEtfSnapshot({
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
    turnoverHistory: turnoverHistoryMerged ?? [],
    source: {
      holders:
        '新浪财经 FundPageInfoService.tabsdcyr（基金年报/半年报十大持有人）',
      scale:
        '上交所/深交所 ETF 规模（每日总份额）+ 天天基金 FundArchivesDatas type=gmbd（定期净资产）',
      quote: '东方财富 push2 / push2delay clist 完整分页（按 ETF 总市值选取）',
      huijinEstimate:
        '占比区间口径：下界从最近披露汇金份额起逐日累加交易所总份额净变化（份额变动全归因汇金）；上界维持最近披露汇金占比不变（被动等比例稀释）；展示值取区间加权（下界 2/3 + 上界 1/3）。趋势信号（份额流向、连续天数、5 日变化率）供方向参考。估算不代表汇金实际持仓。',
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
  })
}

interface MarketActiveCapResolution {
  history: MarketActiveCapPoint[]
  quality: MarketActiveCapQuality
}

async function resolveMarketActiveCapHistory(
  previous: DashboardData | null,
): Promise<MarketActiveCapResolution> {
  const warnings: string[] = []

  try {
    const history = await fetchMarketActiveCapHistory()
    if (history.length === 0) {
      throw new Error('东方财富历史日线返回空的 0AMV 序列')
    }
    return {
      history,
      quality: {
        source: 'eastmoney-history',
        asOf: history.at(-1)?.date ?? null,
        isPartial: false,
        warning: null,
      },
    }
  } catch (error) {
    warnings.push('东方财富历史日线不可用')
    console.warn('中证全指 0AMV 日线抓取失败，进入备用链', error)
  }

  const tushareToken = process.env.TUSHARE_TOKEN?.trim()
  const tushareFallbackEnabled = process.env.TUSHARE_FALLBACK === '1'
  if (tushareToken && tushareFallbackEnabled) {
    try {
      console.log('尝试 Tushare index_daily 0AMV 备用数据源')
      const history = buildMarketActiveCapHistory(
        await fetchTushareMarketSeries(tushareToken),
      )
      if (history.length === 0) {
        throw new Error('Tushare 返回空的 0AMV 序列')
      }
      return {
        history,
        quality: {
          source: 'tushare-history',
          asOf: history.at(-1)?.date ?? null,
          isPartial: false,
          warning: warnings.join('；'),
        },
      }
    } catch (error) {
      warnings.push('Tushare 备用源不可用')
      console.warn('Tushare 0AMV 备用数据源失败，继续尝试最新指数快照', error)
    }
  }

  try {
    const history = await fetchLatestMarketActiveCapHistory(
      previous?.marketActiveCapHistory ?? [],
    )
    return {
      history,
      quality: {
        source: 'latest-snapshot',
        asOf: history.at(-1)?.date ?? null,
        isPartial: true,
        warning: warnings.join('；'),
      },
    }
  } catch (error) {
    warnings.push('最新指数快照不可用，沿用上次缓存')
    console.warn('最新指数快照也失败，将沿用上次快照', error)
  }

  const history = previous?.marketActiveCapHistory ?? []
  return {
    history,
    quality: {
      source: 'cache',
      asOf: history.at(-1)?.date ?? null,
      isPartial: false,
      warning: warnings.join('；'),
    },
  }
}

async function main() {
  const previous = await loadPreviousDashboard()
  if (previous) {
    console.log(`发现上次快照 ${previous.updatedAt}，接口无有效报告时将保留该数据`)
  }
  console.log('抓取 ETF 全市场行情…')
  const [universeFetched, marketActiveCapResolution] = await Promise.all([
    fetchEtfUniverse(),
    resolveMarketActiveCapHistory(previous),
  ])
  const marketActiveCapFetched = marketActiveCapResolution.history
  const previousQuotes = new Map(previous?.etfs.map((etf) => [etf.code, etf.quote]) ?? [])
  const universe = universeFetched.map((quote) =>
    mergeQuoteWithPrevious(quote, previousQuotes.get(quote.code)),
  )
  const marketActiveCapHistory = marketActiveCapFetched
  console.log(`共 ${universe.length} 只 ETF`)
  console.log(`0AMV 市场日线 ${marketActiveCapHistory.length} 条`)

  console.log('抓取沪深两融市场合计…')
  let marginHistory = previous?.marginHistory ?? []
  try {
    const fetched = await fetchMarginHistory()
    marginHistory = fetched
    console.log(
      `两融历史 ${fetched.length} 日（${fetched[0]!.date} → ${fetched.at(-1)!.date}）`,
    )
  } catch (error) {
    console.warn('两融抓取失败，沿用上次快照', error)
  }

  // 板块日线要打数十个 push2his 请求，与 0AMV 同域名。必须等 0AMV 完成后再串行
  // 发起，否则叠加的请求量会触发东财域名级限流，把 0AMV 一起拖失败。
  console.log('抓取行业板块日线…')
  const sectorTrendFetched = await fetchSectorTrend()
  // 抓取失败时沿用上次快照，避免题材主线判定因单次网络故障整体消失
  const sectorTrend = sectorTrendFetched ?? previous?.sectorTrend ?? null

  const picked = await pickLargestPerCategory(universe)
  for (const p of picked) {
    console.log(
      `  选中 ${p.category.name}: ${p.quote.code} ${p.quote.name} 市值=${((p.quote.marketCap ?? 0) / 1e8).toFixed(2)} 亿`,
    )
  }

  // 场内换手率快照：6 只一包，一次 ulist 请求；失败不阻塞主流程
  const turnoverAsOf = marketActiveCapHistory.at(-1)?.date ?? null
  const turnoverSnapshot = turnoverAsOf
    ? await fetchTurnoverSnapshot(
        picked.map((p) => p.quote.code),
        turnoverAsOf,
      )
    : new Map<
        string,
        { date: string; turnoverPct: number | null; amountYuan: number | null }
      >()
  console.log(
    `场内换手率快照 ${turnoverSnapshot.size}/${picked.length} 只（asOf=${turnoverAsOf ?? '无交易日'}）`,
  )
  for (const p of picked) {
    const t = turnoverSnapshot.get(p.quote.code)
    if (t) {
      p.quote.turnoverPct = t.turnoverPct
      p.quote.amountYuan = t.amountYuan
    }
  }

  console.log('抓取交易所 ETF 每日总份额…')
  const { histories: officialShareHistories, gaps: shareFetchGaps } =
    await fetchOfficialShareHistories(
      picked,
      previous,
      mergeTradingDates(
        marketActiveCapHistory.map((point) => point.date),
        previous?.etfs.flatMap((etf) => etf.navHistory.map((point) => point.date)) ?? [],
      ),
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
        mergeTurnoverHistory(
          previous?.etfs.find((e) => e.code === p.quote.code)?.turnoverHistory ?? [],
          turnoverSnapshot.has(p.quote.code)
            ? [turnoverSnapshot.get(p.quote.code)!]
            : [],
        ),
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
    marketActiveCapQuality: marketActiveCapResolution.quality,
    marginHistory,
    sectorTrend,
    summary: {
      totalHuijinMarketValue: totalMv,
      latestActiveCapYi: latestActiveCap?.activeCapYi ?? null,
      latestActiveCapDate: latestActiveCap?.date ?? null,
      etfCount: etfs.length,
      latestReportDate: latestReport,
    },
  }

  const payload = serializeDashboard(dashboard)
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(OUT_FILE, payload, 'utf-8')
  await mkdir(join(ROOT, 'public'), { recursive: true })
  await writeFile(join(ROOT, 'public', 'dashboard.json'), payload, 'utf-8')
  console.log(`\n✓ 已写入 ${OUT_FILE}`)
  console.log(
    `  最近披露汇金合计估值: ${totalMv != null ? (totalMv / 1e8).toFixed(2) + ' 亿元' : 'N/A'}`,
  )
  console.log('')
  console.log(formatCompletenessReport(dashboard))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
