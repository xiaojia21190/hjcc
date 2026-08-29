import type { MarketActiveCapPoint } from '../../shared/types'
import { percentileRank, spearmanCorrelation } from './stats'

/** 0AMV 在指定交易日窗口内的历史分位。 */
export interface ActiveCapPercentile {
  value: number
  /** 1 年（约 240 个交易日）分位 % */
  oneYearPct: number | null
  /** 3 年（约 720 个交易日）分位 % */
  threeYearPct: number | null
}

export function activeCapPercentile(history: MarketActiveCapPoint[]): ActiveCapPercentile | null {
  const latest = history.at(-1)
  if (!latest) return null
  const oneYear = history.slice(-240).map((point) => point.activeCapYi)
  const threeYear = history.slice(-720).map((point) => point.activeCapYi)
  return {
    value: latest.activeCapYi,
    oneYearPct: oneYear.length >= 60 ? percentileRank(latest.activeCapYi, oneYear) : null,
    threeYearPct: threeYear.length >= 120 ? percentileRank(latest.activeCapYi, threeYear) : null,
  }
}

/** 近 N 日 0AMV 与另一序列（对齐后）的 Spearman 秩相关。 */
export function activeCapCorrelation(
  history: MarketActiveCapPoint[],
  other: { date: string; value: number }[],
  window = 60,
): number | null {
  const byDate = new Map(other.map((point) => [point.date, point.value]))
  const tail = history.slice(-window)
  const pairs: { a: number; b: number }[] = []
  for (const point of tail) {
    const other = byDate.get(point.date)
    if (other == null) continue
    pairs.push({ a: point.activeCapYi, b: other })
  }
  return spearmanCorrelation(
    pairs.map((pair) => pair.a),
    pairs.map((pair) => pair.b),
  )
}

/** 均线分位带：近 N 日的 max/min，用于水位图 */
export function activeCapWaterLevel(
  history: MarketActiveCapPoint[],
  window = 720,
): { min: number; max: number; latest: number } | null {
  const tail = history.slice(-window)
  if (tail.length < 20) return null
  const values = tail.map((point) => point.activeCapYi)
  const latest = history.at(-1)!.activeCapYi
  return { min: Math.min(...values), max: Math.max(...values), latest }
}
