/**
 * 风格主线判定：把分化度、持续性、龙头超额与资金确认四项度量收敛为一句判断。
 *
 * 口径限制：输入为宽基类别序列，只能判断风格主线（大盘/小盘、价值/成长），
 * 无法识别题材主线（需行业或概念板块级数据）。
 */
import { percentileRank } from './stats'
import type { SectorTrendData } from '../../shared/types'
import { STYLE_THRESHOLDS, type MainlineThresholds } from './mainlineThresholds'
import {
  alignSeries,
  calcDispersion,
  calcLeaderEdgeRatio,
  calcPersistence,
  dispersionSeries,
  windowReturns,
  type AlignedMatrix,
  type CategoryNavSeries,
} from './mainlineMetrics'

export type { CategoryNavSeries } from './mainlineMetrics'

/** 判定阈值与标定依据见 mainlineThresholds.ts；此处转出以保持单一入口。 */
export {
  STYLE_THRESHOLDS,
  SECTOR_THRESHOLDS,
  type MainlineThresholds,
} from './mainlineThresholds'

/** 分化度分位数的回溯样本量，约两年交易日。 */
const PERCENTILE_LOOKBACK = 480
/** 默认观察窗口：短、中、长三档。 */
export const DEFAULT_WINDOWS = [5, 20, 60]

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

export interface MainlineReport {
  asOf: string | null
  /** 参与比较的板块数（取公共交易日后的口径）。 */
  categoryCount: number
  windows: MainlineWindowResult[]
  /** 综合结论：取各窗口中最弱的一档。 */
  verdict: MainlineVerdict
  headline: string
  /** 主窗口龙头的资金是否同向确认；无资金数据时为 null。 */
  flowConfirmed: boolean | null
}

interface VerdictInput {
  dispersionPercentile: number | null
  persistence: number | null
  leaderEdgeRatio: number | null
}

function decideVerdict(
  input: VerdictInput,
  thresholds: MainlineThresholds,
): { verdict: MainlineVerdict; reason: string } {
  const { dispersionPercentile, persistence, leaderEdgeRatio } = input
  if (dispersionPercentile == null) {
    return { verdict: 'insufficient', reason: '历史样本不足，无法定位分化度分位' }
  }
  if (dispersionPercentile < thresholds.dispersionPercentileFloor) {
    return {
      verdict: 'none',
      reason: `分化度处于历史 ${dispersionPercentile.toFixed(0)}% 分位，齐涨齐跌`,
    }
  }
  if (persistence == null) {
    return { verdict: 'insufficient', reason: '窗口过短或排名无方差，无法计算持续性' }
  }
  if (persistence < thresholds.persistenceFloor) {
    return {
      verdict: 'rotation',
      reason: `分化明显但前后半窗排名相关仅 ${persistence.toFixed(2)}，属高低切轮动`,
    }
  }
  if (leaderEdgeRatio == null || leaderEdgeRatio < thresholds.leaderEdgeFloor) {
    const pct = ((leaderEdgeRatio ?? 0) * 100).toFixed(0)
    return {
      verdict: 'weak',
      reason: `方向可持续，但龙头日超额胜率仅 ${pct}%，涨幅集中于少数交易日`,
    }
  }
  return {
    verdict: 'mainline',
    reason:
      `分化处于 ${dispersionPercentile.toFixed(0)}% 分位、` +
      `排名相关 ${persistence.toFixed(2)}、` +
      `龙头超额胜率 ${(leaderEdgeRatio * 100).toFixed(0)}%`,
  }
}

function emptyWindow(window: number, reason: string): MainlineWindowResult {
  return {
    window,
    dispersion: null,
    dispersionPercentile: null,
    persistence: null,
    leader: null,
    leaderEdgeRatio: null,
    verdict: 'insufficient',
    reason,
  }
}

export interface EvaluateWindowOptions {
  window: number
  /** 观察终点索引，缺省为序列最后一个交易日；回测标定时用于回溯历史。 */
  endIndex?: number
  thresholds?: MainlineThresholds
  /** 预计算的逐日分化度序列；批量回测时传入，避免每个观察点重算整条序列。 */
  dispersionHistory?: (number | null)[]
}

/** 单窗口评估。 */
export function evaluateWindow(
  matrix: AlignedMatrix,
  options: EvaluateWindowOptions,
): MainlineWindowResult {
  const { window } = options
  const endIndex = options.endIndex ?? matrix.dates.length - 1
  const thresholds = options.thresholds ?? STYLE_THRESHOLDS
  const span = { endIndex, window }
  const returns = windowReturns(matrix, span)
  if (!returns) return emptyWindow(window, `交易日不足 ${window + 1} 天`)

  const dispersion = calcDispersion(matrix, span)
  const history = (options.dispersionHistory ?? dispersionSeries(matrix, window))
    .slice(Math.max(0, endIndex - PERCENTILE_LOOKBACK), endIndex)
    .filter((v): v is number => v != null)

  const leaderIndex = returns.indexOf(Math.max(...returns))
  const metrics: VerdictInput = {
    dispersionPercentile: dispersion == null ? null : percentileRank(dispersion, history),
    persistence: calcPersistence(matrix, span),
    leaderEdgeRatio: calcLeaderEdgeRatio(matrix, leaderIndex, span),
  }

  return {
    window,
    dispersion,
    ...metrics,
    leader: { ...matrix.categories[leaderIndex], returnPct: returns[leaderIndex] },
    ...decideVerdict(metrics, thresholds),
  }
}

export const VERDICT_LABEL: Record<MainlineVerdict, string> = {
  mainline: '有主线',
  weak: '弱主线',
  rotation: '轮动无主线',
  none: '无主线',
  insufficient: '数据不足',
}

/** 由弱到强的判定强度序列，用于取各窗口中最弱的一档。 */
const VERDICT_STRENGTH: MainlineVerdict[] = [
  'none',
  'rotation',
  'weak',
  'mainline',
]

/** 综合结论：短中长窗口全部为 mainline 才算强主线，任一窗口更弱则整体降级。 */
function combineVerdicts(windows: MainlineWindowResult[]): MainlineVerdict {
  const valid = windows.filter((w) => w.verdict !== 'insufficient')
  if (valid.length === 0) return 'insufficient'
  return valid.reduce((weakest, current) =>
    VERDICT_STRENGTH.indexOf(current.verdict) < VERDICT_STRENGTH.indexOf(weakest.verdict)
      ? current
      : weakest,
  ).verdict
}

function formatLeader(primary: MainlineWindowResult | undefined): string {
  if (!primary?.leader) return ''
  const { categoryName, returnPct } = primary.leader
  const sign = returnPct >= 0 ? '+' : ''
  return `，${primary.window}日龙头 ${categoryName} ${sign}${returnPct.toFixed(1)}%`
}

/** 主入口：多窗口评估一段行情是否存在风格主线。 */
export function evaluateMainline(
  series: CategoryNavSeries[],
  options: MainlineOptions = {},
): MainlineReport {
  const windowSizes = options.windows ?? DEFAULT_WINDOWS
  const matrix = alignSeries(series)
  if (!matrix) {
    return {
      asOf: null,
      categoryCount: 0,
      windows: windowSizes.map((w) => emptyWindow(w, '可比板块不足或无公共交易日')),
      verdict: 'insufficient',
      headline: '数据不足，无法判定主线',
      flowConfirmed: null,
    }
  }

  const windows = windowSizes.map((w) =>
    evaluateWindow(matrix, { window: w, thresholds: options.thresholds }),
  )
  const verdict = combineVerdicts(windows)
  // 主窗口取中位档（默认 20 日），作为龙头与资金确认的基准
  const primary = windows[Math.floor(windows.length / 2)] ?? windows[0]
  const flowConfirmed =
    options.flows == null || primary?.leader == null
      ? null
      : options.flows[primary.leader.category] === 'inflow'

  return {
    asOf: matrix.dates[matrix.dates.length - 1],
    categoryCount: matrix.categories.length,
    windows,
    verdict,
    headline: `${VERDICT_LABEL[verdict]}${formatLeader(primary)}`,
    flowConfirmed,
  }
}

/**
 * 把行业板块收盘矩阵转成主线判定输入。
 * 板块日线已在抓取阶段按公共交易日对齐，这里只做形状转换。
 */
export function sectorTrendToSeries(trend: SectorTrendData): CategoryNavSeries[] {
  return trend.sectors.map((sector) => ({
    category: sector.code,
    categoryName: sector.name,
    points: trend.dates.map((date, index) => ({ date, nav: sector.closes[index] })),
  }))
}
