/** 从看板快照收集规则简报输入。 */
import type { EtfSnapshot, MarketActiveCapPoint } from '../../shared/types'
import type { BriefingEtfInput } from './forceBriefing'
import { collectForceInputs } from './forceVerdictCollect'
import type { ForceMarketInput } from './forceVerdict'

function shareWindow(etf: EtfSnapshot): Pick<BriefingEtfInput, 'lastSharesYi' | 'sharesYi5dAgo'> {
  const history = etf.huijinEstimateHistory
  let lastIdx = -1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.shareTrend != null) {
      lastIdx = index
      break
    }
  }
  if (lastIdx < 0) return { lastSharesYi: null, sharesYi5dAgo: null }
  const last = history[lastIdx]
  const ago = history[lastIdx - 5]
  return {
    lastSharesYi: last?.totalSharesYi ?? null,
    sharesYi5dAgo: ago?.totalSharesYi ?? null,
  }
}

export function collectBriefingInputs(
  etfs: EtfSnapshot[],
  marketHistory: MarketActiveCapPoint[],
): { etfs: BriefingEtfInput[]; market: ForceMarketInput } {
  const collected = collectForceInputs(etfs, marketHistory)
  return {
    etfs: etfs.map((etf, index) => ({
      ...collected.etfs[index]!,
      ...shareWindow(etf),
      quotePrice: etf.quote?.price ?? null,
    })),
    market: collected.market,
  }
}
