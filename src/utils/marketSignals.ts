import type { MarketActiveCapPoint } from '../../shared/types'

export type MarketCrossDirection = 'up' | 'down'

export interface MarketCrossing {
  date: string
  direction: MarketCrossDirection
  index: number
  active5: number | null
  active20: number | null
  index5: number | null
  index20: number | null
}

export function percentChange(
  from: number | null | undefined,
  to: number | null | undefined,
): number | null {
  if (from == null || to == null || from === 0) return null
  return ((to / from) - 1) * 100
}

/** 找出 0AMV 与 5 日参考线的全部穿越，并附带后续交易日表现。 */
export function findMarketCrossings(
  history: MarketActiveCapPoint[],
): MarketCrossing[] {
  const crossings: MarketCrossing[] = []
  for (let index = 1; index < history.length; index++) {
    const current = history[index]
    const previous = history[index - 1]
    if (current.referenceMaYi == null || previous.referenceMaYi == null) continue
    const currentAbove = current.activeCapYi >= current.referenceMaYi
    const previousAbove = previous.activeCapYi >= previous.referenceMaYi
    if (currentAbove === previousAbove) continue
    const after5 = history[index + 5]
    const after20 = history[index + 20]
    crossings.push({
      date: current.date,
      direction: currentAbove ? 'up' : 'down',
      index,
      active5: percentChange(current.activeCapYi, after5?.activeCapYi),
      active20: percentChange(current.activeCapYi, after20?.activeCapYi),
      index5: percentChange(current.marketIndex, after5?.marketIndex),
      index20: percentChange(current.marketIndex, after20?.marketIndex),
    })
  }
  return crossings
}
