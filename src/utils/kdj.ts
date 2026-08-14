/** KDJ(9,3,3)，采用通达信 SMA(X,N,1) 平滑；单序列用自身滚动高低点代替 OHLC。 */
export interface KdjPoint {
  k: number
  d: number
  j: number
}

function windowRange(values: number[], end: number, period: number) {
  const start = Math.max(0, end - period + 1)
  let max = values[start]
  let min = values[start]
  for (let i = start + 1; i <= end; i++) {
    if (values[i] > max) max = values[i]
    if (values[i] < min) min = values[i]
  }
  return { max, min }
}

function rsvAt(values: number[], index: number, period: number): number {
  const { max, min } = windowRange(values, index, period)
  if (max === min) return 50
  return ((values[index] - min) / (max - min)) * 100
}

/** 通达信 SMA(X, N, 1) = (X + (N-1) * 前值) / N */
function smaNext(value: number, prev: number, n: number): number {
  return (value + (n - 1) * prev) / n
}

export function computeKdj(
  values: number[],
  period = 9,
  kSmooth = 3,
  dSmooth = 3,
): KdjPoint[] {
  if (values.length === 0) return []
  let k = 50
  let d = 50
  return values.map((_, index) => {
    const rsv = rsvAt(values, index, period)
    k = index === 0 ? rsv : smaNext(rsv, k, kSmooth)
    d = index === 0 ? k : smaNext(k, d, dSmooth)
    return {
      k: Number(k.toFixed(2)),
      d: Number(d.toFixed(2)),
      j: Number((3 * k - 2 * d).toFixed(2)),
    }
  })
}

export function kdjSignal(current?: KdjPoint, previous?: KdjPoint): string {
  if (current == null) return '数据不足'
  if (previous != null && previous.k < previous.d && current.k >= current.d) {
    return '金叉'
  }
  if (previous != null && previous.k >= previous.d && current.k < current.d) {
    return '死叉'
  }
  if (current.j >= 100 || current.k >= 80) return '超买'
  if (current.j <= 0 || current.k <= 20) return '超卖'
  return current.k >= current.d ? '多头' : '空头'
}
