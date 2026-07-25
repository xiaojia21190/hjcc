/**
 * 汇金持仓估算 — 占比区间口径。
 * 下界：份额变动全归因汇金（逐日累加净份额变化）。
 * 上界：汇金占比不变（被动等比例稀释）。
 * 展示值：区间加权（偏向下界）。
 */
import type { EtfSnapshot, HolderReport, NavPoint, ScalePoint } from '../../shared/types'
import { computeTrendSignals } from '../../shared/estimate-signals'
import { nearestNav } from './merge'

type HuijinEstimate = EtfSnapshot['huijinEstimateHistory'][number]

/** 区间加权常量：偏向下界（对齐"大额变动主要是汇金"先验） */
export const FLOOR_WEIGHT = 2 / 3
export const CEIL_WEIGHT = 1 / 3

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
  const latestAnchor =
    huijinReports.length > 0 ? huijinReports[huijinReports.length - 1] : null

  type EstimateWithNet = HuijinEstimate & { netSubscriptionYi: number | null }
  const raw: EstimateWithNet[] = []

  // floor 累加状态（亿份）；遇到披露日重置
  let floorYi: number | null = null

  for (const s of scale) {
    const report = disclosedByDate.get(s.date)
    const nav =
      nearestNav(navs, s.date) ??
      (s.totalSharesYi > 0 ? s.netAssetYi / s.totalSharesYi : null)

    if (report) {
      const huijinValueYi =
        nav != null ? (report.huijinShares * nav) / 1e8 : null
      raw.push({
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
      })
      // 披露日重置 floor 为披露值
      floorYi = report.huijinShares / 1e8
      continue
    }

    if (
      latestAnchor &&
      s.date > latestAnchor.reportDate &&
      s.frequency === 'daily' &&
      s.totalSharesYi > 0
    ) {
      // 初始化 floor（首个 anchored 点之前若未经过披露日）
      if (floorYi == null) floorYi = latestAnchor.huijinShares / 1e8

      // 累加下界
      const netSub = s.netSubscriptionYi ?? 0
      floorYi = Math.max(0, Math.min(floorYi + netSub, s.totalSharesYi))

      // 上界：占比不变
      const ceilYi = (s.totalSharesYi * latestAnchor.huijinPercent) / 100

      // 展示值
      const weightedYi = floorYi * FLOOR_WEIGHT + ceilYi * CEIL_WEIGHT
      const huijinShares = Math.round(weightedYi * 1e8)
      const huijinValueYi =
        nav != null ? Number((weightedYi * nav).toFixed(4)) : null

      raw.push({
        date: s.date,
        netAssetYi: s.netAssetYi,
        totalSharesYi: s.totalSharesYi,
        huijinShares,
        huijinValueYi,
        huijinPct: Number(((weightedYi / s.totalSharesYi) * 100).toFixed(2)),
        huijinSharesFloor: Number(floorYi.toFixed(6)),
        huijinSharesCeil: Number(ceilYi.toFixed(6)),
        isEstimated: true,
        estimateMethod: 'anchored' as const,
        netSubscriptionYi: s.netSubscriptionYi ?? null,
      })
      continue
    }

    raw.push({
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
    })
  }

  // 趋势信号（基于总份额流向，与口径无关）
  const anchoredIdx = raw
    .map((p, i) => (p.estimateMethod === 'anchored' ? i : -1))
    .filter((i) => i >= 0)
  if (anchoredIdx.length) {
    const signals = computeTrendSignals(
      anchoredIdx.map((i) => ({
        date: raw[i]!.date,
        totalSharesYi: raw[i]!.totalSharesYi,
        netSubscriptionYi: raw[i]!.netSubscriptionYi ?? null,
      })),
    )
    anchoredIdx.forEach((i, k) => {
      const sig = signals[k]!
      raw[i] = {
        ...raw[i]!,
        shareTrend: sig.shareTrend,
        consecutiveDays: sig.consecutiveDays,
        shareChangePct5d: sig.shareChangePct5d,
      }
    })
  }

  return raw.map(({ netSubscriptionYi: _omit, ...rest }) => rest)
}
