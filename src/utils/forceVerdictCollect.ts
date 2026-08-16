/** 从看板快照收集主力判决输入。 */
import type { EtfSnapshot, MarketActiveCapPoint, NavPoint } from '../../shared/types'
import { estimateRangeYi } from './estimateDisplay'
import type { ForceEtfInput, ForceMarketInput } from './forceVerdict'

export function navChangePct5d(navs: readonly NavPoint[]): number | null {
  if (navs.length < 6) return null
  const last = navs[navs.length - 1]!
  const base = navs[navs.length - 6]!
  const lastNav = last.accNav > 0 ? last.accNav : last.nav
  const baseNav = base.accNav > 0 ? base.accNav : base.nav
  if (!(baseNav > 0)) return null
  return Number((((lastNav / baseNav) - 1) * 100).toFixed(2))
}

function toForceEtf(etf: EtfSnapshot): ForceEtfInput {
  const lastTrend = etf.huijinEstimateHistory.filter((point) => point.shareTrend != null).at(-1)
  const lastAnchored = [...etf.huijinEstimateHistory]
    .reverse()
    .find((point) => point.estimateMethod === 'anchored')
  return {
    categoryName: etf.categoryName,
    hasHuijinDisclosure: etf.latestHuijin != null,
    shareTrend: lastTrend?.shareTrend ?? null,
    consecutiveDays: lastTrend?.consecutiveDays ?? 0,
    shareChangePct5d: lastTrend?.shareChangePct5d ?? null,
    shareDate: lastTrend?.date ?? null,
    priceChangePct5d: navChangePct5d(etf.navHistory),
    lowResolution: estimateRangeYi(lastAnchored)?.lowResolution ?? false,
  }
}

export function collectForceInputs(
  etfs: EtfSnapshot[],
  marketHistory: MarketActiveCapPoint[],
): { etfs: ForceEtfInput[]; market: ForceMarketInput } {
  const latest = marketHistory.at(-1)
  return {
    etfs: etfs.map(toForceEtf),
    market: {
      activeCapYi: latest?.activeCapYi ?? null,
      referenceMaYi: latest?.referenceMaYi ?? null,
    },
  }
}
