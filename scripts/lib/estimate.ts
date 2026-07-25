import { computeTrendSignals } from '../../shared/estimate-signals'
import type {
  EtfSnapshot,
  HolderReport,
  NavPoint,
  ScalePoint,
} from '../../shared/types'
import { nearestNav } from './merge'

export type HuijinEstimate = EtfSnapshot['huijinEstimateHistory'][number]

export function buildHuijinEstimate(
  scale: ScalePoint[],
  reports: HolderReport[],
  navs: NavPoint[],
): HuijinEstimate[] {
  const huijinReports = reports
    .filter((report) => report.huijinShares > 0)
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
  const disclosedByDate = new Map(
    huijinReports.map((report) => [report.reportDate, report]),
  )
  // 只取最近一期汇金披露作为份额锚点，不做历史区间回填
  const latestAnchor =
    huijinReports.length > 0
      ? huijinReports[huijinReports.length - 1]
      : null

  type EstimateWithNet = HuijinEstimate & { netSubscriptionYi: number | null }
  const raw: EstimateWithNet[] = scale.map((s) => {
    const report = disclosedByDate.get(s.date)
    const nav =
      nearestNav(navs, s.date) ??
      (s.totalSharesYi > 0 ? s.netAssetYi / s.totalSharesYi : null)

    if (report) {
      const huijinValueYi =
        nav != null ? (report.huijinShares * nav) / 1e8 : null
      return {
        date: s.date,
        netAssetYi: s.netAssetYi,
        totalSharesYi: s.totalSharesYi,
        huijinShares: report.huijinShares,
        huijinValueYi:
          huijinValueYi != null ? Number(huijinValueYi.toFixed(4)) : null,
        huijinPct: report.huijinPercent,
        isEstimated: false,
        estimateMethod: 'disclosed' as const,
        netSubscriptionYi: s.netSubscriptionYi ?? null,
      }
    }

    // 份额锚定估算：仅在最近一期披露之后生成，假设汇金不主动赎回
    if (
      latestAnchor &&
      s.date > latestAnchor.reportDate &&
      s.frequency === 'daily' &&
      s.totalSharesYi > 0
    ) {
      const totalShares = s.totalSharesYi * 1e8
      const clampTriggered = totalShares < latestAnchor.huijinShares
      const estShares = Math.round(
        clampTriggered ? totalShares : latestAnchor.huijinShares,
      )
      const huijinValueYi =
        nav != null ? Number(((estShares * nav) / 1e8).toFixed(4)) : null
      return {
        date: s.date,
        netAssetYi: s.netAssetYi,
        totalSharesYi: s.totalSharesYi,
        huijinShares: estShares,
        huijinValueYi,
        huijinPct: clampTriggered
          ? 100
          : Number(
              ((latestAnchor.huijinShares / totalShares) * 100).toFixed(2),
            ),
        isEstimated: true,
        estimateMethod: 'anchored' as const,
        clampTriggered,
        netSubscriptionYi: s.netSubscriptionYi ?? null,
      }
    }

    return {
      date: s.date,
      netAssetYi: s.netAssetYi,
      totalSharesYi: s.totalSharesYi,
      huijinShares: null,
      huijinValueYi: null,
      huijinPct: null,
      isEstimated: false,
      estimateMethod: 'unavailable' as const,
      unavailableReason: !latestAnchor
        ? '暂无汇金持仓披露'
        : s.date <= latestAnchor.reportDate
          ? '最近披露日及之前，仅展示正式披露点'
          : '非日频份额数据点，不推算汇金持仓',
      netSubscriptionYi: s.netSubscriptionYi ?? null,
    }
  })

  // 对 anchored 点计算趋势信号（输入为 anchored 子序列，按日期升序）
  const anchoredIdx = raw
    .map((p, i) => (p.estimateMethod === 'anchored' ? i : -1))
    .filter((i) => i >= 0)
  if (anchoredIdx.length) {
    const signals = computeTrendSignals(
      anchoredIdx.map((i) => ({
        date: raw[i]!.date,
        totalSharesYi: raw[i]!.totalSharesYi,
        netSubscriptionYi: raw[i]!.netSubscriptionYi ?? null,
        clampTriggered: raw[i]!.clampTriggered,
      })),
    )
    anchoredIdx.forEach((i, k) => {
      const sig = signals[k]!
      raw[i] = {
        ...raw[i]!,
        shareTrend: sig.shareTrend,
        consecutiveDays: sig.consecutiveDays,
        shareChangePct5d: sig.shareChangePct5d,
        clampReliability: sig.clampReliability,
      }
    })
  }

  // 移除临时 netSubscriptionYi（HuijinEstimatePoint 不含该字段）
  return raw.map(({ netSubscriptionYi: _omit, ...rest }) => rest)
}
