/** 主线判定所需的纯统计函数；不含业务语义，便于独立测试。 */

/** 样本标准差（除以 n-1）；样本量不足 2 时返回 null。 */
export function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/**
 * 当前值在历史样本中的百分位（0-100），采用「小于等于当前值的比例」口径。
 * 历史样本为空时返回 null。
 */
export function percentileRank(
  value: number,
  history: number[],
): number | null {
  if (history.length === 0) return null
  const below = history.filter((v) => v <= value).length
  return (below / history.length) * 100
}

/**
 * 升序名次，1 为最小值；并列取平均名次。
 * 平均名次保证并列项不会人为拉开秩相关。
 */
export function averageRanks(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value)

  const ranks = new Array<number>(values.length)
  let cursor = 0
  while (cursor < order.length) {
    let end = cursor
    while (end + 1 < order.length && order[end + 1].value === order[cursor].value) {
      end += 1
    }
    // 名次从 1 开始，并列区间 [cursor, end] 取平均
    const shared = (cursor + end) / 2 + 1
    for (let i = cursor; i <= end; i++) ranks[order[i].index] = shared
    cursor = end + 1
  }
  return ranks
}

/**
 * Spearman 秩相关系数，取值 [-1, 1]。
 * 长度不一致、样本不足 2、或任一侧全部并列（无方差）时返回 null。
 */
export function spearmanCorrelation(
  a: number[],
  b: number[],
): number | null {
  if (a.length !== b.length || a.length < 2) return null

  const ranksA = averageRanks(a)
  const ranksB = averageRanks(b)
  const meanA = ranksA.reduce((sum, v) => sum + v, 0) / ranksA.length
  const meanB = ranksB.reduce((sum, v) => sum + v, 0) / ranksB.length

  let covariance = 0
  let varianceA = 0
  let varianceB = 0
  for (let i = 0; i < ranksA.length; i++) {
    const devA = ranksA[i] - meanA
    const devB = ranksB[i] - meanB
    covariance += devA * devB
    varianceA += devA ** 2
    varianceB += devB ** 2
  }

  if (varianceA === 0 || varianceB === 0) return null
  return covariance / Math.sqrt(varianceA * varianceB)
}
