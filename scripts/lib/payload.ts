import type {
  DashboardData,
  EtfSnapshot,
  HolderReport,
  HuijinEstimatePoint,
  NavPoint,
  ScalePoint,
} from '../../shared/types'

/** 覆盖主线 480+60，再留约 60 日缓冲。 */
export const NAV_KEEP_TRADING_DAYS = 600
/** 东财净值每页 50 条；16 页约 800 个交易日，足够裁窗。 */
export const NAV_FETCH_PAGES = 16

export function navKeepFromDate(input: {
  navs: NavPoint[]
  scale: ScalePoint[]
}): string | null {
  const firstDaily = input.scale.find((point) => point.frequency === 'daily')?.date
  const lastKeep =
    input.navs.length >= NAV_KEEP_TRADING_DAYS
      ? input.navs[input.navs.length - NAV_KEEP_TRADING_DAYS]?.date
      : null
  const candidates = [firstDaily, lastKeep].filter((date): date is string => Boolean(date))
  return candidates.sort()[0] ?? null
}

/** 保留日频份额起点之后的净值，以及每份持有人报告日附近的净值。 */
export function trimNavHistory(
  navs: NavPoint[],
  input: { scale: ScalePoint[]; reports: HolderReport[] },
): NavPoint[] {
  const sorted = [...navs].sort((a, b) => a.date.localeCompare(b.date))
  if (!sorted.length) return []
  const keepFrom = navKeepFromDate({ navs: sorted, scale: input.scale })
  const kept = new Map<string, NavPoint>()
  for (const nav of sorted) {
    if (!keepFrom || nav.date >= keepFrom) kept.set(nav.date, nav)
  }
  for (const report of input.reports) {
    let nearest: NavPoint | null = null
    for (const nav of sorted) {
      if (nav.date <= report.reportDate) nearest = nav
      else break
    }
    if (nearest) kept.set(nearest.date, nearest)
  }
  return [...kept.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** 丢掉没有流向信号的 unavailable 点，日频信号点与披露/估算点保留。 */
export function compactEstimateHistory(
  points: HuijinEstimatePoint[],
): HuijinEstimatePoint[] {
  return points.filter(
    (point) => point.estimateMethod !== 'unavailable' || point.shareTrend != null,
  )
}

export function slimEtfSnapshot(etf: EtfSnapshot): EtfSnapshot {
  return {
    ...etf,
    navHistory: trimNavHistory(etf.navHistory, {
      scale: etf.scaleHistory,
      reports: etf.holderReports,
    }),
    huijinEstimateHistory: compactEstimateHistory(etf.huijinEstimateHistory),
  }
}

export function slimDashboard(data: DashboardData): DashboardData {
  return {
    ...data,
    etfs: data.etfs.map(slimEtfSnapshot),
  }
}

export function serializeDashboard(data: DashboardData): string {
  return JSON.stringify(data)
}
