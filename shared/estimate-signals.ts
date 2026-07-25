/** 趋势信号计算所需的输入点（来自 anchored 估算点序列，按日期升序） */
export interface SignalInput {
  date: string
  totalSharesYi: number
  /** 当日总份额相对前一交易日的净变化（亿份） */
  netSubscriptionYi: number | null
}

export interface SignalOutput {
  shareTrend: 'inflow' | 'outflow' | 'flat'
  consecutiveDays: number
  shareChangePct5d: number | null
}

/**
 * 从 anchored 估算点序列计算趋势信号。
 * 输入必须按日期升序、为同一 ETF 的连续交易日点。
 */
export function computeTrendSignals(points: SignalInput[]): SignalOutput[] {
  const out: SignalOutput[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const net = p.netSubscriptionYi
    const shareTrend: SignalOutput['shareTrend'] =
      net == null ? 'flat' : net > 0 ? 'inflow' : net < 0 ? 'outflow' : 'flat'

    // consecutiveDays：向前回溯同向
    let consecutiveDays = 1
    for (let j = i - 1; j >= 0; j--) {
      const prevNet = points[j]!.netSubscriptionYi
      const prevTrend: SignalOutput['shareTrend'] =
        prevNet == null ? 'flat' : prevNet > 0 ? 'inflow' : prevNet < 0 ? 'outflow' : 'flat'
      if (prevTrend === shareTrend && shareTrend !== 'flat') consecutiveDays++
      else break
    }

    // shareChangePct5d：第 i 个相对第 i-5 个
    let shareChangePct5d: number | null = null
    if (i - 5 >= 0) {
      const base = points[i - 5]!.totalSharesYi
      if (base > 0) {
        shareChangePct5d = Number((((p.totalSharesYi - base) / base) * 100).toFixed(2))
      }
    }

    out.push({ shareTrend, consecutiveDays, shareChangePct5d })
  }
  return out
}
