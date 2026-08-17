/**
 * 散户情绪反向判定：净申购率 mood + 滚动分位温度 + 汇金方向交叉象限。
 * 纯函数，不识别持有人，反向解读只是假设检验叙事，不构成投资建议。
 */
import type {
  EtfSnapshot,
  MarginPoint,
  MarketActiveCapPoint,
} from '../../shared/types'
import { collectForceInputs } from './forceVerdictCollect'
import { estimateRangeYi } from './estimateDisplay'
import { percentileRank } from './stats'
import {
  cumulativeNetSubRatePct,
  netSubscriptionRateSeries,
  otherCapitalSeries,
} from './retailMetrics'

/** 5 日累计净申购率 ≥ 此值（%）判定追涨量级；与 forceVerdict 的 5 日 2% 口径一致。 */
export const CHASE_PCT_5D = 2
/** 5 日累计净申购率 ≤ 此值（%）判定杀跌量级。 */
export const CAPITULATE_PCT_5D = -2
/** 净申购率分位回看窗口（交易日）。 */
export const PERCENTILE_LOOKBACK = 250
/** 分位 ≥ 此值视为高热。 */
export const HOT_PERCENTILE = 85
/** 分位 ≤ 此值视为冰点。 */
export const COLD_PERCENTILE = 15
/** 换手率分位回看窗口（交易日）。 */
export const TURNOVER_LOOKBACK = 250
/** 换手历史少于此天数不做分位（历史从接入日起积累）。 */
export const TURNOVER_MIN_HISTORY = 30
/** 换手分位 ≥ 此值视为亢奋。 */
export const TURNOVER_HOT = 85
/** 换手分位 ≤ 此值视为低迷。 */
export const TURNOVER_COLD = 15
/** 杠杆分位 ≥ 此值视为过热。 */
export const MARGIN_HOT = 85
/** 杠杆分位 ≤ 此值视为降杠杆。 */
export const MARGIN_COLD = 15

export const DISCLAIMER =
  '不能识别持有人 · 只描述申赎行为 · 反向解读仅是假设 · 不构成投资建议'

export type RetailMood = 'chasing' | 'capitulating' | 'calm'
export type CrossQuadrant =
  | 'contrarian-bull'
  | 'contrarian-warn'
  | 'aligned'
  | 'unclear'

export const MOOD_LABEL: Record<RetailMood, string> = {
  chasing: '追涨申购',
  capitulating: '杀跌赎回',
  calm: '平静',
}

export const QUADRANT_LABEL: Record<CrossQuadrant, string> = {
  'contrarian-bull': '对手盘吸纳 · 经典底部组合',
  'contrarian-warn': '拥挤追涨 · 警惕派发',
  aligned: '同向而行 · 无反向信息',
  unclear: '无法判断',
}

export interface MoodInput {
  categoryName: string
  netSub5dPct: number | null
}

/** 单只 mood：±2% 边界；null（样本不足）返回 null。 */
export function judgeMood(input: MoodInput): RetailMood | null {
  if (input.netSub5dPct == null) return null
  if (input.netSub5dPct >= CHASE_PCT_5D) return 'chasing'
  if (input.netSub5dPct <= CAPITULATE_PCT_5D) return 'capitulating'
  return 'calm'
}

/** 分位温度标签；null 表示样本不足。 */
export function temperatureLabel(percentile: number | null): string {
  if (percentile == null) return '样本不足'
  if (percentile >= HOT_PERCENTILE) return '高热'
  if (percentile >= 65) return '偏热'
  if (percentile <= COLD_PERCENTILE) return '冰点'
  if (percentile <= 35) return '偏冷'
  return '中性'
}

/** 交投温度标签（场内换手率分位）；null 表示样本不足。 */
export function turnoverLabel(percentile: number | null): string {
  if (percentile == null) return '样本不足'
  if (percentile >= TURNOVER_HOT) return '亢奋'
  if (percentile >= 65) return '活跃'
  if (percentile <= TURNOVER_COLD) return '低迷'
  if (percentile <= 35) return '清淡'
  return '常态'
}

/** 杠杆温度结果：主标签 + 余额变化供展示。 */
export interface MarginTemperature {
  label: string
}

/** 杠杆温度：融资买入占比分位为主标签。 */
export function marginTemperature(percentile: number | null): MarginTemperature {
  if (percentile == null) return { label: '样本不足' }
  if (percentile >= MARGIN_HOT) return { label: '杠杆过热' }
  if (percentile >= 65) return { label: '加杠杆' }
  if (percentile <= MARGIN_COLD) return { label: '降杠杆' }
  if (percentile <= 35) return { label: '去杠杆' }
  return { label: '常态' }
}

export interface RetailEtfRow {
  categoryName: string
  code: string
  hasHuijinDisclosure: boolean
  /** 5 日累计净申购率（%）。 */
  netSub5dPct: number | null
  /** 该 ETF 最新日净申购率在 250 日回看内的分位（0-100）。 */
  netSubPercentile: number | null
  mood: RetailMood | null
  /** 最新其他资金份额（亿份）；无披露 ETF 为 null。 */
  otherYi: number | null
  /** 其他资金份额 5 日变化率（%）；anchored 段不足 6 点为 null。 */
  otherChangePct5d: number | null
  /** 最新场内换手率（%）。 */
  turnoverPct: number | null
  /** 换手率 250 日分位；历史不足为 null。 */
  turnoverPercentile: number | null
}

export interface RetailVerdict {
  mood: RetailMood
  moodLabel: string
  /** 全体净申购率分位中位数对应的温度标签。 */
  temperatureLabel: string
  /** 中位分位（0-100），供展示。 */
  temperaturePercentile: number | null
  /** 场内换手率分位中位数对应的交投温度。 */
  turnoverLabel: string
  /** 换手分位中位数（0-100）。 */
  turnoverPercentile: number | null
  /** 杠杆温度标签（融资买入占成交额比分位）。 */
  marginLabel: string
  /** 融资买入占比 250 日分位。 */
  marginPercentile: number | null
  /** 融资余额 5 日变化率（%）。 */
  marginBalanceChangePct5d: number | null
  quadrant: CrossQuadrant
  quadrantLabel: string
  detail: string
  etfs: RetailEtfRow[]
  /** 有披露 ETF 的其他资金份额合计（亿份）；全部无披露为 null。 */
  otherTotalYi: number | null
  /** 合计口径 5 日变化率（%），按成分份额加权。 */
  otherTotalChangePct5d: number | null
  cautions: string[]
  disclaimer: string
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}

/** 汇金多数 tone：多数方向须严格大于其他两类。 */
function majorityHuijinTone(
  trends: ('inflow' | 'outflow' | 'flat' | null)[],
): 'inflow' | 'outflow' | 'flat' | null {
  let inflow = 0
  let outflow = 0
  let flat = 0
  for (const trend of trends) {
    if (trend === 'inflow') inflow += 1
    else if (trend === 'outflow') outflow += 1
    else if (trend === 'flat') flat += 1
  }
  if (inflow > outflow && inflow > flat) return 'inflow'
  if (outflow > inflow && outflow > flat) return 'outflow'
  if (flat > inflow && flat > outflow) return 'flat'
  return null
}

/** mood 多数投票：chasing 与 capitulating 互斥，须严格过半。 */
function majorityMood(moods: (RetailMood | null)[]): RetailMood {
  const valid = moods.filter((m): m is RetailMood => m != null)
  if (valid.length === 0) return 'calm'
  const chasing = valid.filter((m) => m === 'chasing').length
  const capitulating = valid.filter((m) => m === 'capitulating').length
  if (chasing > valid.length / 2) return 'chasing'
  if (capitulating > valid.length / 2) return 'capitulating'
  return 'calm'
}

function crossQuadrant(
  mood: RetailMood,
  huijinTone: 'inflow' | 'outflow' | 'flat' | null,
  temperature: string,
): CrossQuadrant {
  if (mood === 'calm') return 'unclear'
  if (huijinTone === 'inflow') {
    // 汇金增持 + 散户也追涨：矛盾，无反向结论；杀跌则是对手盘吸纳
    return mood === 'capitulating' ? 'contrarian-bull' : 'unclear'
  }
  if (huijinTone === 'outflow') {
    return mood === 'capitulating' ? 'aligned' : 'unclear'
  }
  // 汇金无多数方向：散户情绪需温度佐证才独立定案
  if (mood === 'chasing' && (temperature === '高热' || temperature === '偏热')) {
    return 'contrarian-warn'
  }
  if (mood === 'capitulating' && (temperature === '冰点' || temperature === '偏冷')) {
    return 'contrarian-bull'
  }
  return 'unclear'
}

function quadrantDetail(
  quadrant: CrossQuadrant,
  mood: RetailMood,
  huijinTone: 'inflow' | 'outflow' | 'flat' | null,
  temperature: string,
): string {
  const toneText =
    huijinTone === 'inflow'
      ? '汇金估算份额流入'
      : huijinTone === 'outflow'
        ? '汇金估算份额流出'
        : '汇金估算份额无多数方向'
  const moodText =
    mood === 'chasing'
      ? '宽基 ETF 边际资金持续净申购'
      : mood === 'capitulating'
        ? '宽基 ETF 边际资金持续净赎回'
        : '边际资金申赎平衡'
  const base = `${moodText}（温度${temperature}），${toneText}`
  switch (quadrant) {
    case 'contrarian-bull':
      return `${base}；反向解读：耐心钱在接情绪钱交出的筹码，历史底部常见组合。`
    case 'contrarian-warn':
      return `${base}；反向解读：增量以情绪钱为主，高位放量需警惕派发。`
    case 'aligned':
      return `${base}；两边同向，不提供对手盘信息。`
    default:
      return `${base}；信号互相矛盾或量级不足，不下反向结论。`
  }
}

function buildRow(etf: EtfSnapshot): {
  row: RetailEtfRow
  lastOtherYi: number | null
} {
  const rates = netSubscriptionRateSeries(etf.scaleHistory)
  const netSub5dPct = cumulativeNetSubRatePct(rates, 5)
  const currentRate = rates.at(-1)?.ratePct
  const history = rates
    .slice(-(PERCENTILE_LOOKBACK + 1), -1)
    .map((r) => r.ratePct)
    .filter((v): v is number => v != null)
  const netSubPercentile =
    currentRate != null && history.length > 0
      ? percentileRank(currentRate, history)
      : null

  const others = otherCapitalSeries(etf)
  const lastIdx = [...others].reverse().findIndex((p) => p.otherYi != null)
  const lastOther = lastIdx === -1 ? null : others[others.length - 1 - lastIdx]!
  let otherChangePct5d: number | null = null
  if (lastOther?.otherYi != null) {
    const idx = others.length - 1 - lastIdx
    const basePoint = idx >= 5 ? others[idx - 5] : null
    if (basePoint?.otherYi != null && basePoint.otherYi > 0) {
      otherChangePct5d = Number(
        (((lastOther.otherYi / basePoint.otherYi) - 1) * 100).toFixed(2),
      )
    }
  }

  const turnoverHistory = etf.turnoverHistory ?? []
  const lastTurnover = turnoverHistory.at(-1)
  const turnoverHistoryRates = turnoverHistory
    .slice(-(TURNOVER_LOOKBACK + 1), -1)
    .map((p) => p.turnoverPct)
    .filter((v): v is number => v != null)
  const turnoverPercentile =
    lastTurnover?.turnoverPct != null &&
    turnoverHistoryRates.length >= TURNOVER_MIN_HISTORY
      ? percentileRank(lastTurnover.turnoverPct, turnoverHistoryRates)
      : null

  return {
    row: {
      categoryName: etf.categoryName,
      code: etf.code,
      hasHuijinDisclosure: etf.latestHuijin != null,
      netSub5dPct,
      netSubPercentile,
      mood: judgeMood({ categoryName: etf.categoryName, netSub5dPct }),
      otherYi: lastOther?.otherYi ?? null,
      otherChangePct5d,
      turnoverPct: lastTurnover?.turnoverPct ?? null,
      turnoverPercentile,
    },
    lastOtherYi: lastOther?.otherYi ?? null,
  }
}

/** 主入口：从看板快照生成散户情绪反向判决。 */
export function judgeRetailSentiment(
  etfs: EtfSnapshot[],
  marginHistory: MarginPoint[] = [],
  marketHistory: MarketActiveCapPoint[] = [],
): RetailVerdict {
  const cautions: string[] = []
  const rows: RetailEtfRow[] = []

  for (const etf of etfs) {
    const { row } = buildRow(etf)
    if (!row.hasHuijinDisclosure) {
      cautions.push(
        `${etf.categoryName} 无汇金披露，仅总份额口径参与申赎判定，无法拆分其他资金`,
      )
    }
    const lastAnchored = [...etf.huijinEstimateHistory]
      .reverse()
      .find((p) => p.estimateMethod === 'anchored')
    if (estimateRangeYi(lastAnchored)?.lowResolution) {
      cautions.push(`${etf.categoryName} 估算区间过宽，其他资金份额点估计不可依赖`)
    }
    rows.push(row)
  }

  // 其他资金合计：各有披露 ETF 的最新其他份额求和（日期可能不同，仅作规模量级）；
  // 合计 5 日变化率 = 各成分 otherChangePct5d 的份额加权平均
  const sumRows = rows.filter((r) => r.otherYi != null)
  const otherTotalYi =
    sumRows.length > 0
      ? Number(sumRows.reduce((s, r) => s + r.otherYi!, 0).toFixed(2))
      : null
  let otherTotalChangePct5d: number | null = null
  const weighted = sumRows.filter((r) => r.otherChangePct5d != null)
  if (sumRows.length > 0 && weighted.length === sumRows.length) {
    const weightSum = sumRows.reduce((s, r) => s + r.otherYi!, 0)
    otherTotalChangePct5d = Number(
      (
        sumRows.reduce((s, r) => s + r.otherYi! * r.otherChangePct5d!, 0) / weightSum
      ).toFixed(2),
    )
  }

  const mood = majorityMood(rows.map((r) => r.mood))
  const tempPercentile = median(
    rows.map((r) => r.netSubPercentile).filter((v): v is number => v != null),
  )
  const temperature = temperatureLabel(tempPercentile)
  const turnoverPctMedian = median(
    rows.map((r) => r.turnoverPercentile).filter((v): v is number => v != null),
  )
  const turnoverTempLabel = turnoverLabel(turnoverPctMedian)

  // 杠杆温度：融资买入额 / 沪深成交额（marketAmountYi 亿元），公共日交集
  const amountByDate = new Map(
    marketHistory.map((p) => [p.date, p.marketAmountYi]),
  )
  const buyRatioSeries = marginHistory
    .map((p) => {
      const amountYuan = amountByDate.get(p.date)
      if (amountYuan == null || amountYuan <= 0) return null
      return { date: p.date, ratio: (p.rzmre / (amountYuan * 1e8)) * 100 }
    })
    .filter((x): x is { date: string; ratio: number } => x != null)
  const lastRatio = buyRatioSeries.at(-1)?.ratio ?? null
  const ratioHistory = buyRatioSeries
    .slice(-(TURNOVER_LOOKBACK + 1), -1)
    .map((x) => x.ratio)
  const marginPercentile =
    lastRatio != null && ratioHistory.length >= TURNOVER_MIN_HISTORY
      ? percentileRank(lastRatio, ratioHistory)
      : null
  const marginTemp = marginTemperature(marginPercentile)
  let marginBalanceChange5d: number | null = null
  if (marginHistory.length >= 6) {
    const last = marginHistory.at(-1)!
    const base = marginHistory.at(-6)!
    if (base.rzye > 0) {
      marginBalanceChange5d = Number(
        (((last.rzye / base.rzye) - 1) * 100).toFixed(2),
      )
    }
  }
  const huijinTone = majorityHuijinTone(
    collectForceInputs(etfs, []).etfs.map((e) => e.shareTrend),
  )
  const quadrant = crossQuadrant(mood, huijinTone, temperature)
  cautions.push('非汇金资金含机构、游资与散户，散户只是主要成分之一，不是全部')
  cautions.push('换手率历史自接入日起积累，分位在积累不足 30 日时不可用')
  cautions.push('两融是全市场口径，无法拆分到宽基 ETF 成分')

  return {
    mood,
    moodLabel: MOOD_LABEL[mood],
    temperatureLabel: temperature,
    temperaturePercentile: tempPercentile,
    turnoverLabel: turnoverTempLabel,
    turnoverPercentile: turnoverPctMedian,
    marginLabel: marginTemp.label,
    marginPercentile,
    marginBalanceChangePct5d: marginBalanceChange5d,
    quadrant,
    quadrantLabel: QUADRANT_LABEL[quadrant],
    detail: quadrantDetail(quadrant, mood, huijinTone, temperature),
    etfs: rows,
    otherTotalYi,
    otherTotalChangePct5d,
    cautions,
    disclaimer: DISCLAIMER,
  }
}
