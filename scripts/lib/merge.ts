import type {
  HolderReport,
  HuijinPosition,
  NavPoint,
  ScalePoint,
} from '../../shared/types'
import type { OfficialDailySharePoint } from '../sources/sse'

export function nearestNav(
  navs: NavPoint[],
  date: string,
): number | null {
  if (!navs.length) return null
  // 找 <= date 最近的
  let best: NavPoint | null = null
  for (const n of navs) {
    if (n.date <= date) best = n
    else break
  }
  if (best) return best.nav
  // 目标日期早于已抓到的最早净值时不能回退到最新净值，否则会产生数量级错误。
  return null
}

export function mergeScaleHistory(
  periodic: ScalePoint[],
  official: OfficialDailySharePoint[],
  navs: NavPoint[],
): ScalePoint[] {
  if (!official.length) {
    return periodic
      .map((point) => ({
        ...point,
        frequency: point.frequency ?? 'periodic',
        shareSource: point.shareSource ?? 'eastmoney',
        netAssetEstimated: point.netAssetEstimated ?? false,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  const periodicByDate = new Map(periodic.map((point) => [point.date, point]))
  const daily: ScalePoint[] = []
  let prior: OfficialDailySharePoint | null = null
  for (const point of official) {
    const disclosed = periodicByDate.get(point.date)
    const nav = nearestNav(navs, point.date)
    const estimatedNetAsset =
      disclosed?.netAssetYi && disclosed.netAssetYi > 0
        ? disclosed.netAssetYi
        : nav != null
          ? Number((point.totalSharesYi * nav).toFixed(6))
          : 0
    const netSubscriptionYi = prior
      ? Number((point.totalSharesYi - prior.totalSharesYi).toFixed(6))
      : null
    daily.push({
      date: point.date,
      totalSharesYi: point.totalSharesYi,
      purchaseYi: disclosed?.purchaseYi ?? null,
      redeemYi: disclosed?.redeemYi ?? null,
      netSubscriptionYi,
      netAssetYi: estimatedNetAsset,
      netAssetChangePct: disclosed?.netAssetChangePct ?? null,
      frequency: 'daily',
      shareSource: point.shareSource,
      netAssetEstimated: !(disclosed?.netAssetYi && disclosed.netAssetYi > 0),
    })
    prior = point
  }

  const dailyDates = new Set(daily.map((point) => point.date))
  return [
    ...periodic.filter((point) => !dailyDates.has(point.date)),
    ...daily,
  ]
    .map((point) => ({
      ...point,
      frequency: point.frequency ?? 'periodic',
      shareSource: point.shareSource ?? 'eastmoney',
      netAssetEstimated: point.netAssetEstimated ?? false,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

export function buildHuijinHistory(
  reports: HolderReport[],
  navs: NavPoint[],
): HuijinPosition[] {
  return reports
    .filter((r) => r.huijinShares > 0)
    .map((r) => {
      const entities = r.holders
        .filter((h) => h.isHuijin)
        .map((h) => ({
          name: h.name,
          shares: h.shares,
          percent: h.percent,
        }))
      const nav = nearestNav(navs, r.reportDate)
      return {
        reportDate: r.reportDate,
        shares: r.huijinShares,
        percent: r.huijinPercent,
        marketValue: nav != null ? r.huijinShares * nav : null,
        entities,
      } satisfies HuijinPosition
    })
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
}

export function dedupeHolderReports(reports: HolderReport[]): HolderReport[] {
  const seen = new Set<string>()
  return reports.filter((report) => {
    const fingerprint = JSON.stringify(
      report.holders.map((holder) => [holder.name, holder.shares, holder.percent]),
    )
    if (seen.has(fingerprint)) return false
    seen.add(fingerprint)
    return true
  })
}
