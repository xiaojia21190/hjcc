/** MACD(12, 26, 9) 指标，采用国内行情软件惯例：MACD 柱 = 2 × (DIF - DEA)。 */
export interface MacdPoint {
  /** DIF = EMA12 - EMA26 */
  dif: number
  /** DEA = EMA(DIF, 9) */
  dea: number
  /** MACD 柱 = 2 × (DIF - DEA) */
  macd: number
}

/**
 * 计算 MACD 序列，长度与输入一致。
 * EMA 以首个值作为种子（等价于通达信 EMA 在数据起点处的行为）。
 */
export function computeMacd(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdPoint[] {
  if (values.length === 0) return []
  const fastK = 2 / (fast + 1)
  const slowK = 2 / (slow + 1)
  const signalK = 2 / (signal + 1)
  let fastEma = values[0]
  let slowEma = values[0]
  let dea = 0
  return values.map((value, index) => {
    fastEma = index === 0 ? value : value * fastK + fastEma * (1 - fastK)
    slowEma = index === 0 ? value : value * slowK + slowEma * (1 - slowK)
    const dif = fastEma - slowEma
    dea = index === 0 ? dif : dif * signalK + dea * (1 - signalK)
    return {
      dif: Number(dif.toFixed(2)),
      dea: Number(dea.toFixed(2)),
      macd: Number((2 * (dif - dea)).toFixed(2)),
    }
  })
}
