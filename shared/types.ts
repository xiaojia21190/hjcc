/** 指数/板块类别 */
export type IndexCategory =
  | 'sse50'
  | 'csi300'
  | 'csi500'
  | 'csi1000'
  | 'chinext'
  | 'star50'

export interface CategoryMeta {
  id: IndexCategory
  name: string
  shortName: string
  /** 用于匹配 ETF 名称的关键词 */
  keywords: string[]
  /** 候选代码（按历史规模大致排序，兜底） */
  candidates: string[]
}

export interface EtfQuote {
  code: string
  name: string
  price: number | null
  changePct: number | null
  /** 总市值/规模（元） */
  marketCap: number | null
  /** 流通市值（元） */
  floatCap: number | null
  market: 'SH' | 'SZ'
  /** 当日场内换手率（%），fltt=2 下为真实值；缺失为 null */
  turnoverPct?: number | null
  /** 当日场内成交额（元）；缺失为 null */
  amountYuan?: number | null
}

/** 场内换手率历史点；由每日快照 append 积累，无回填。 */
export interface TurnoverPoint {
  date: string
  /** 场内换手率（%），f8 口径 */
  turnoverPct: number | null
  /** 场内成交额（元） */
  amountYuan: number | null
}

export interface HolderRow {
  name: string
  shares: number
  percent: number
  isHuijin: boolean
}

export interface HolderReport {
  reportDate: string
  holders: HolderRow[]
  /** 汇金系合计份额 */
  huijinShares: number
  /** 汇金系合计占比 % */
  huijinPercent: number
}

export interface ScalePoint {
  date: string
  /** 期末总份额（亿份） */
  totalSharesYi: number
  /** 期末净资产（亿元） */
  netAssetYi: number
  purchaseYi: number | null
  redeemYi: number | null
  /** 相对上一交易日的基金总份额净变化（亿份）；不是申购、赎回毛额。 */
  netSubscriptionYi?: number | null
  netAssetChangePct: number | null
  /** daily 为交易所日频规模，periodic 为基金定期规模披露。 */
  frequency?: 'daily' | 'periodic'
  /** 总份额字段的数据来源。 */
  shareSource?: 'sse' | 'szse' | 'eastmoney'
  /** true 表示净资产由总份额 × 当日附近单位净值推算。 */
  netAssetEstimated?: boolean
}

export interface NavPoint {
  date: string
  nav: number
  accNav: number
  changePct: number | null
}

export interface HuijinPosition {
  reportDate: string
  shares: number
  percent: number
  /** 披露估值（元）= 报告期份额 * 报告日附近净值；无净值时为 null。 */
  marketValue: number | null
  entities: { name: string; shares: number; percent: number }[]
  /** 兼容字段；当前披露趋势不允许估算点。 */
  isEstimated?: boolean
}

export interface HuijinEstimatePoint {
  date: string
  /** 期末基金净资产（亿元） */
  netAssetYi: number
  /** 期末总份额（亿份） */
  totalSharesYi: number
  /** 同日持有人报告披露的汇金份额；非披露日为 null。 */
  huijinShares: number | null
  /** 披露份额按报告日附近单位净值计算的估值（亿元）。 */
  huijinValueYi: number | null
  /** 持有人报告披露的汇金占比。 */
  huijinPct: number | null
  /** true 表示该点为份额锚定估算点，非正式披露。 */
  isEstimated: boolean
  /** disclosed 为披露日；anchored 为占比区间估算；unavailable 为不可推算。 */
  estimateMethod?: 'disclosed' | 'anchored' | 'unavailable'
  /** 汇金持仓无法可靠估算时的原因 */
  unavailableReason?: string
  /** 占比区间下界（份额变动全归因汇金，悲观侧），亿份。仅 anchored 点。 */
  huijinSharesFloor?: number | null
  /** 占比区间上界（汇金占比不变，被动稀释，乐观侧），亿份。仅 anchored 点。 */
  huijinSharesCeil?: number | null
  /** 当日总份额相对前一交易日的方向（仅 anchored 估算点填充） */
  shareTrend?: 'inflow' | 'outflow' | 'flat'
  /** 连续同向天数（含当日，仅 anchored 估算点填充） */
  consecutiveDays?: number
  /** 近 5 个交易日总份额变化率 %；5 日内有缺失则为 null */
  shareChangePct5d?: number | null
}

/** 指南针 0AMV 活筹指数的公开公式估算（市场级序列，单位：亿元）。 */
export interface MarketActiveCapPoint {
  date: string
  /** SMA(沪深两市成交额, 10, 1) × 当日指数 / 前 5 日指数均值，亿元 */
  activeCapYi: number
  /** 中证全指收盘点位，作为市场价格代理 */
  marketIndex: number
  /** 沪深两市成交额：上证综指成交额 + 深证成指成交额，亿元 */
  marketAmountYi: number
  /** 0AMV 的 5 日参考均线，亿元 */
  referenceMaYi: number | null
}

export type MarketActiveCapDataSource =
  | 'tdx'
  | 'eastmoney-history'
  | 'tushare-history'
  | 'latest-snapshot'
  | 'cache'

/** 0AMV 本次快照实际使用的数据源和完整性状态。 */
export interface MarketActiveCapQuality {
  source: MarketActiveCapDataSource
  asOf: string | null
  /** true 表示最后一个点来自盘中/最新快照，而非完整历史日线。 */
  isPartial: boolean
  warning: string | null
}

/** 沪深两融市场合计日频点。 */
export interface MarginPoint {
  date: string
  /** 融资余额（元） */
  rzye: number
  /** 融资买入额（元） */
  rzmre: number
  /** 两融余额（元） */
  rzrqye: number
  /** 融资余额占流通市值比（%） */
  rzyezb: number | null
}

/** 持有人报告期事件；不是公告发布日期。 */
export interface MarketReportEvent {
  date: string
  label: string
}

/** 单个行业板块的收盘序列，与 SectorTrendData.dates 等长且按位对齐。 */
export interface SectorSeries {
  /** 东财板块代码，如 BK0475。 */
  code: string
  name: string
  closes: number[]
}

/**
 * 行业板块日线收盘矩阵，用于题材主线判定。
 * 全部板块共用一条交易日轴，抓取时已按交集对齐，因此天然可比。
 */
export interface SectorTrendData {
  /** 共用交易日轴，升序。 */
  dates: string[]
  sectors: SectorSeries[]
  /** 板块层级说明与数据来源。 */
  source: string
  fetchedAt: string
}

export interface EtfSnapshot {
  category: IndexCategory
  categoryName: string
  code: string
  name: string
  market: 'SH' | 'SZ'
  quote: EtfQuote | null
  /** 是否为本类别规模最大 */
  isLargest: boolean
  scaleHistory: ScalePoint[]
  navHistory: NavPoint[]
  /** 场内换手率历史（每日快照积累，无历史回填） */
  turnoverHistory: TurnoverPoint[]
  holderReports: HolderReport[]
  huijinHistory: HuijinPosition[]
  latestHuijin: HuijinPosition | null
  /** ETF 规模日期与汇金持仓的对齐序列：披露日为正式披露，最后披露期之后为份额锚定估算。 */
  huijinEstimateHistory: HuijinEstimatePoint[]
  source: {
    holders: string
    scale: string
    quote: string
    huijinEstimate: string
    fetchedAt: string
    holdersFromCache?: boolean
    holdersFetchedAt?: string
    holdersHistoryDeduplicated?: boolean
    /** 交易所日频份额抓取缺口（重试用尽仍失败的日期/区间），非空表示有数据缺口 */
    shareFetchGaps?: {
      sseFailedDates?: string[]
      szseFailedRanges?: string[]
      /** 上交所返回 200 但当日 result 为空（份额尚未发布）的日期；下次抓取会重试 */
      sseEmptyDates?: string[]
      /** 深交所区间内最后一个查询日未返回数据（份额尚未发布），下次抓取会重试 */
      szseEmptyDates?: string[]
    }
  }
}

export interface DashboardData {
  updatedAt: string
  categories: CategoryMeta[]
  etfs: EtfSnapshot[]
  /** 沪深市场 0AMV 活筹指数估算序列，不属于任何单只 ETF。 */
  marketActiveCapHistory: MarketActiveCapPoint[]
  /** 沪深两融市场合计历史；抓取失败时沿用上次快照 */
  marginHistory?: MarginPoint[]
  /** 0AMV 的定义、计算口径和数据来源说明。 */
  marketActiveCapSource: string
  /** 0AMV 本次抓取实际使用的来源和截止日期；旧快照可能没有此字段。 */
  marketActiveCapQuality?: MarketActiveCapQuality
  /** 行业板块日线矩阵；抓取失败时为 null，题材主线判定随之降级。 */
  sectorTrend: SectorTrendData | null
  summary: {
    /** 各 ETF 最近一期汇金披露份额按报告日附近净值计算的合计估值（元）。 */
    totalHuijinMarketValue: number | null
    /** 最新市场 0AMV 活筹指数估算值（亿元）。 */
    latestActiveCapYi: number | null
    latestActiveCapDate: string | null
    etfCount: number
    latestReportDate: string | null
  }
}
