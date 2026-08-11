/**
 * 主线判定的类型与常量。纯声明，无计算逻辑。
 */
import type { MainlineThresholds } from './mainlineThresholds'

export type { MainlineThresholds } from './mainlineThresholds'
export { STYLE_THRESHOLDS, SECTOR_THRESHOLDS } from './mainlineThresholds'

/** 默认观察窗口：短、中、长三档；综合结论与标定均以 20 日为准。 */
export const DEFAULT_WINDOWS = [5, 20, 60]
/** 主观察窗口：综合 verdict、龙头与资金确认的基准，并与 calibrate 口径对齐。 */
export const PRIMARY_WINDOW = 20

export type MainlineVerdict =
  | 'mainline' // 分化 + 持续 + 龙头超额稳定
  | 'weak' // 分化且持续，但龙头超额不稳
  | 'rotation' // 分化但不持续，高低切换
  | 'none' // 分化度过低，齐涨齐跌
  | 'insufficient' // 数据不足

export type FlowDirection = 'inflow' | 'outflow' | 'flat'

export interface MainlineOptions {
  windows?: number[]
  /** 板块 → 资金流向，用于龙头资金确认；缺省则不做该项校验。 */
  flows?: Record<string, FlowDirection>
  /** 判定阈值，缺省用宽基风格口径。行业口径请传 SECTOR_THRESHOLDS。 */
  thresholds?: MainlineThresholds
}

export interface MainlineLeader {
  category: string
  categoryName: string
  /** 窗口累计收益 % */
  returnPct: number
}

export interface MainlineWindowResult {
  window: number
  /** 各板块窗口累计收益的样本标准差，单位为百分点。 */
  dispersion: number | null
  /** 分化度在过去约两年同口径样本中的分位（0-100）。 */
  dispersionPercentile: number | null
  /** 前半窗与后半窗收益排名的 Spearman 相关系数。 */
  persistence: number | null
  leader: MainlineLeader | null
  /** 龙头相对等权平均的日超额为正的天数占比（0-1）。 */
  leaderEdgeRatio: number | null
  verdict: MainlineVerdict
  reason: string
}

/**
 * 跨窗领先板块是否同一——N 很小时单窗 Spearman 噪音大，
 * 「20 与 60 是否同龙头」是更稳的描述性结构旁证，不进入 decideVerdict。
 */
export type LeaderAlignmentStatus =
  | 'aligned' // 20 与 60 同龙头（若有 5 且不同会在 summary 注明）
  | 'partial' // 仅部分辅窗与主窗同龙头，或缺 60 只能部分对齐
  | 'split' // 20 与 60 龙头不同
  | 'unknown' // 可比窗口不足

export interface LeaderAlignment {
  status: LeaderAlignmentStatus
  /** 如「20/60 同为上证50」；无法判断时为 null。 */
  summary: string | null
}

export interface MainlineReport {
  asOf: string | null
  /** 参与比较的板块数（取公共交易日后的口径）。 */
  categoryCount: number
  windows: MainlineWindowResult[]
  /** 综合结论：取主观察窗（默认 20 日）的判定，与历史检验口径一致。 */
  verdict: MainlineVerdict
  headline: string
  /**
   * 5 / 60 等辅窗与主窗分歧时的提示；无分歧为 null。
   * 综合不降级，但避免用户只看 20 日忽略中长期反证或短窗噪声。
   */
  caution: string | null
  /** 跨窗领先板块一致性；描述性旁证，不改综合 verdict。 */
  leaderAlignment: LeaderAlignment
  /** 主窗口龙头的资金是否同向确认；无资金数据时为 null。 */
  flowConfirmed: boolean | null
}

export const VERDICT_LABEL: Record<MainlineVerdict, string> = {
  mainline: '有主线',
  weak: '弱主线',
  rotation: '轮动无主线',
  none: '无主线',
  insufficient: '数据不足',
}

export const UNKNOWN_ALIGNMENT: LeaderAlignment = {
  status: 'unknown',
  summary: null,
}
