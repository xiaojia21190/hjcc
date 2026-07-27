/** 份额信号聚合：把各 ETF 最新 anchored 点的趋势信号浓缩为一句判断。 */

export interface SignalPoint {
  shareTrend: 'inflow' | 'outflow' | 'flat'
  consecutiveDays: number
  shareChangePct5d: number | null
  categoryName: string
}

export interface SignalSummary {
  /** 主数字，如 "4/5 只净流入" */
  headline: string
  /** 连续天数最长者，如 "沪深300 连续5日净流入"；无则 null */
  highlightConsecutive: string | null
  /** |5日变化率| 最大者，如 "中证500 5日 -8.4%"；无则 null */
  highlightChange: string | null
  /** 整体倾向：inflow 多数 / outflow 多数 / mixed / none(无数据) */
  tone: 'inflow' | 'outflow' | 'mixed' | 'none'
}

export function aggregateShareSignals(points: SignalPoint[]): SignalSummary {
  if (points.length === 0) {
    return { headline: '—', highlightConsecutive: null, highlightChange: null, tone: 'none' }
  }

  const total = points.length
  const inflowCount = points.filter((p) => p.shareTrend === 'inflow').length
  const outflowCount = points.filter((p) => p.shareTrend === 'outflow').length
  const flatCount = total - inflowCount - outflowCount

  // 主数字：明确多数时用占比表述，否则三向并列
  let headline: string
  let tone: SignalSummary['tone']
  if (inflowCount > outflowCount && inflowCount > flatCount) {
    headline = `${inflowCount}/${total} 只净流入`
    tone = 'inflow'
  } else if (outflowCount > inflowCount && outflowCount > flatCount) {
    headline = `${outflowCount}/${total} 只净流出`
    tone = 'outflow'
  } else {
    headline = `${inflowCount}入/${outflowCount}出/${flatCount}平`
    tone = 'mixed'
  }

  // 连续天数最长（排除 flat）
  const nonFlat = points.filter((p) => p.shareTrend !== 'flat')
  let highlightConsecutive: string | null = null
  if (nonFlat.length > 0) {
    const best = nonFlat.reduce((a, b) => (b.consecutiveDays > a.consecutiveDays ? b : a))
    const dir = best.shareTrend === 'inflow' ? '净流入' : '净流出'
    highlightConsecutive = `${best.categoryName} 连续${best.consecutiveDays}日${dir}`
  }

  // |5日变化率| 最大
  const withPct = points.filter((p) => p.shareChangePct5d != null)
  let highlightChange: string | null = null
  if (withPct.length > 0) {
    const best = withPct.reduce((a, b) =>
      Math.abs(b.shareChangePct5d!) > Math.abs(a.shareChangePct5d!) ? b : a,
    )
    const pct = best.shareChangePct5d!
    highlightChange = `${best.categoryName} 5日 ${pct > 0 ? '+' : ''}${pct}%`
  }

  return { headline, highlightConsecutive, highlightChange, tone }
}
