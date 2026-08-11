/**
 * 主线判定的度量层：序列对齐与四项横截面指标计算。
 * 只产出数字，不做任何阈值判定——判定逻辑见 mainlineSignals.ts。
 */
import { sampleStdDev, spearmanCorrelation } from './stats'

/** 计算持续性所需的最小窗口长度（前后半窗各至少 2 日）。 */
const MIN_PERSISTENCE_WINDOW = 4
/** 参与横截面比较的最小板块数。 */
const MIN_CATEGORIES = 3

export interface CategoryNavSeries {
  category: string
  categoryName: string
  /** 按日期升序的净值序列，作为板块收益代理。 */
  points: { date: string; nav: number }[]
}

export interface AlignedMatrix {
  dates: string[]
  categories: { category: string; categoryName: string }[]
  /** navs[categoryIndex][dateIndex] */
  navs: number[][]
}

/** 窗口区间，endIndex 为闭区间右端。 */
export interface WindowSpan {
  endIndex: number
  window: number
}

/**
 * 取各板块公共交易日的交集并对齐。
 * 用交集而非并集，是为了让分化度在时间上口径一致——板块数变化会改变
 * 标准差的分布，历史分位数将失去可比性。
 */
export function alignSeries(series: CategoryNavSeries[]): AlignedMatrix | null {
  const usable = series.filter((s) => s.points.length > 0)
  if (usable.length < MIN_CATEGORIES) return null

  const maps = usable.map((s) => new Map(s.points.map((p) => [p.date, p.nav])))
  const dates = [...maps[0].keys()]
    .filter((date) => maps.every((m) => isPositive(m.get(date))))
    .sort()
  if (dates.length === 0) return null

  return {
    dates,
    categories: usable.map((s) => ({
      category: s.category,
      categoryName: s.categoryName,
    })),
    navs: maps.map((m) => dates.map((date) => m.get(date) as number)),
  }
}

/** 净值必须为正，否则收益率计算会失真。 */
function isPositive(value: number | undefined): boolean {
  return value != null && Number.isFinite(value) && value > 0
}

/** 各板块在窗口内的累计收益 %；越界返回 null。 */
export function windowReturns(
  matrix: AlignedMatrix,
  span: WindowSpan,
): number[] | null {
  const startIndex = span.endIndex - span.window
  if (startIndex < 0) return null
  return matrix.navs.map((navs) => (navs[span.endIndex] / navs[startIndex] - 1) * 100)
}

/** 横截面分化度：各板块窗口累计收益的样本标准差，单位为百分点。 */
export function calcDispersion(
  matrix: AlignedMatrix,
  span: WindowSpan,
): number | null {
  const returns = windowReturns(matrix, span)
  return returns ? sampleStdDev(returns) : null
}

/** 逐日分化度序列，未满窗的位置为 null；用于定位当前分化度的历史分位。 */
export function dispersionSeries(
  matrix: AlignedMatrix,
  window: number,
): (number | null)[] {
  return matrix.dates.map((_, endIndex) => calcDispersion(matrix, { endIndex, window }))
}

/**
 * 持续性：前半窗与后半窗收益排名的 Spearman 相关系数。
 * 对累计收益而非单日涨幅取排名，样本量只有个位数时噪音显著更低。
 */
export function calcPersistence(
  matrix: AlignedMatrix,
  span: WindowSpan,
): number | null {
  if (span.window < MIN_PERSISTENCE_WINDOW) return null
  const startIndex = span.endIndex - span.window
  if (startIndex < 0) return null

  const midIndex = startIndex + Math.floor(span.window / 2)
  const first = matrix.navs.map((navs) => navs[midIndex] / navs[startIndex] - 1)
  const second = matrix.navs.map((navs) => navs[span.endIndex] / navs[midIndex] - 1)
  return spearmanCorrelation(first, second)
}

/**
 * 龙头相对等权平均的日超额为正的天数占比。
 * 真主线的超额曲线是台阶式上行；单日脉冲拉高的伪龙头该比例接近或低于 0.5。
 */
export function calcLeaderEdgeRatio(
  matrix: AlignedMatrix,
  leaderIndex: number,
  span: WindowSpan,
): number | null {
  const startIndex = span.endIndex - span.window
  if (startIndex < 0) return null

  let positive = 0
  for (let i = startIndex + 1; i <= span.endIndex; i++) {
    const daily = matrix.navs.map((navs) => navs[i] / navs[i - 1] - 1)
    const mean = daily.reduce((sum, v) => sum + v, 0) / daily.length
    if (daily[leaderIndex] > mean) positive += 1
  }
  return positive / span.window
}
