/** 从看板快照收集规则简报输入。 */
import type { EtfSnapshot, MarketActiveCapPoint } from '../../shared/types'
import type { BriefingEtfInput } from './forceBriefing'
import { collectForceInputs } from './forceVerdictCollect'
import type { ForceMarketInput } from './forceVerdict'

/**
 * 份额窗口与 shareChangePct5d 同口径：都在日频子序列
 * （即带 shareTrend 的点）上取第 i 期与第 i-5 期，见 shared/estimate-signals.ts。
 */
function shareWindow(etf: EtfSnapshot): Pick<BriefingEtfInput, 'lastSharesYi' | 'sharesYi5dAgo'> {
  const daily = etf.huijinEstimateHistory.filter((point) => point.shareTrend != null)
  const last = daily.at(-1)
  const ago = daily.at(-6)
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
