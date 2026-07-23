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
  netAssetChangePct: number | null
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
  /** 估算市值（元）= 份额 * 报告日附近净值；无净值时为 null */
  marketValue: number | null
  entities: { name: string; shares: number; percent: number }[]
  /** true 表示根据已验证披露对规模期做的估算，不是同日公告 */
  isEstimated?: boolean
}

export interface HuijinEstimatePoint {
  date: string
  /** 期末基金净资产（亿元） */
  netAssetYi: number
  /** 期末总份额（亿份） */
  totalSharesYi: number
  /** 用于估算的汇金份额；没有历史披露时为 null */
  huijinShares: number | null
  /** 汇金估算市值（亿元） */
  huijinValueYi: number | null
  /** 汇金估算市值 / 期末基金净资产 */
  huijinPct: number | null
  /** true 表示该点不是同日持有人披露，而是模型估算 */
  isEstimated: boolean
  /** 估算方法：披露值、披露期之间插值、沿用份额或按披露占比锚定 */
  estimateMethod?:
    | 'disclosed'
    | 'interpolated'
    | 'carry-forward'
    | 'ratio-anchored'
    | 'unavailable'
  /** 汇金持仓无法可靠估算时的原因 */
  unavailableReason?: string
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

/** 持有人报告期事件；不是公告发布日期。 */
export interface MarketReportEvent {
  date: string
  label: string
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
  holderReports: HolderReport[]
  huijinHistory: HuijinPosition[]
  latestHuijin: HuijinPosition | null
  /** ETF 规模期的汇金份额/市值估算序列 */
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
  }
}

export interface DashboardData {
  updatedAt: string
  categories: CategoryMeta[]
  etfs: EtfSnapshot[]
  /** 沪深市场 0AMV 活筹指数估算序列，不属于任何单只 ETF。 */
  marketActiveCapHistory: MarketActiveCapPoint[]
  /** 0AMV 的定义、计算口径和数据来源说明。 */
  marketActiveCapSource: string
  summary: {
    totalHuijinMarketValue: number | null
    /** 最新市场 0AMV 活筹指数估算值（亿元）。 */
    latestActiveCapYi: number | null
    latestActiveCapDate: string | null
    etfCount: number
    latestReportDate: string | null
  }
}
