/**
 * 主线判定入口：单窗三闸门 + 多窗综合。
 *
 * 口径限制：宽基序列只能判断风格主线（大盘/小盘、价值/成长）；
 * 题材主线需行业或概念板块级数据（见 sectorTrendToSeries）。
 *
 * 对外 API 保持从本文件 re-export，调用方无需感知 types / aggregate 拆分。
 */
import { percentileRank } from './stats'
import type { SectorTrendData } from '../../shared/types'
import { STYLE_THRESHOLDS, type MainlineThresholds } from './mainlineThresholds'
import {
  combineVerdicts,
  formatAuxCaution,
  formatLeader,
  pickPrimaryWindow,
  summarizeLeaderAlignment,
} from './mainlineAggregate'
import {
  DEFAULT_WINDOWS,
  UNKNOWN_ALIGNMENT,
  VERDICT_LABEL,
  type MainlineOptions,
  type MainlineReport,
  type MainlineVerdict,
  type MainlineWindowResult,
} from './mainlineTypes'
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
export type {
  FlowDirection,
  LeaderAlignment,
  LeaderAlignmentStatus,
  MainlineLeader,
  MainlineOptions,
  MainlineReport,
  MainlineThresholds,
  MainlineVerdict,
  MainlineWindowResult,
} from './mainlineTypes'
export {
  DEFAULT_WINDOWS,
  PRIMARY_WINDOW,
  SECTOR_THRESHOLDS,
  STYLE_THRESHOLDS,
  VERDICT_LABEL,
} from './mainlineTypes'
export {
  formatAuxCaution,
  leaderRoleLabel,
  pickPrimaryWindow,
  sortWindowsForDisplay,
  summarizeLeaderAlignment,
} from './mainlineAggregate'

/** 分化度分位数的回溯样本量，约两年交易日。 */
const PERCENTILE_LOOKBACK = 480
/** 至少保留一定历史样本，避免少数点位生成看似精确的百分位。 */
const MIN_DISPERSION_HISTORY = 60

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
  if (history.length < MIN_DISPERSION_HISTORY) {
    return emptyWindow(
      window,
      `历史分化度样本不足 ${MIN_DISPERSION_HISTORY} 个，无法稳定定位分位`,
    )
  }

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
      caution: null,
      leaderAlignment: UNKNOWN_ALIGNMENT,
      flowConfirmed: null,
    }
  }

  const windows = windowSizes.map((w) =>
    evaluateWindow(matrix, { window: w, thresholds: options.thresholds }),
  )
  const primary = pickPrimaryWindow(windows)
  const verdict = combineVerdicts(windows)
  const leaderFlow =
    primary?.leader == null ? undefined : options.flows?.[primary.leader.category]
  const flowConfirmed =
    options.flows == null || primary?.leader == null || leaderFlow == null
      ? null
      : leaderFlow === 'inflow'

  return {
    asOf: matrix.dates[matrix.dates.length - 1],
    categoryCount: matrix.categories.length,
    windows,
    verdict,
    headline: `${VERDICT_LABEL[verdict]}${formatLeader(primary)}`,
    caution: formatAuxCaution(windows, primary),
    leaderAlignment: summarizeLeaderAlignment(windows, primary),
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
