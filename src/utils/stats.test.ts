import { describe, expect, test } from 'bun:test'
import { averageRanks, percentileRank, sampleStdDev, spearmanCorrelation } from './stats'

describe('sampleStdDev', () => {
  test('样本标准差按 n-1 计算', () => {
    expect(sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1381, 4)
  })

  test('全部相同的样本标准差为 0', () => {
    expect(sampleStdDev([3, 3, 3])).toBe(0)
  })

  test('样本量不足 2 时返回 null', () => {
    expect(sampleStdDev([1])).toBeNull()
    expect(sampleStdDev([])).toBeNull()
  })
})

describe('percentileRank', () => {
  test('按小于等于当前值的比例计算分位', () => {
    expect(percentileRank(3, [1, 2, 3, 4, 5])).toBe(60)
  })

  test('高于全部历史样本时为 100', () => {
    expect(percentileRank(9, [1, 2, 3])).toBe(100)
  })

  test('低于全部历史样本时为 0', () => {
    expect(percentileRank(0, [1, 2, 3])).toBe(0)
  })

  test('历史样本为空时返回 null', () => {
    expect(percentileRank(1, [])).toBeNull()
  })
})

describe('averageRanks', () => {
  test('升序名次从 1 开始', () => {
    expect(averageRanks([30, 10, 20])).toEqual([3, 1, 2])
  })

  test('并列项取平均名次', () => {
    expect(averageRanks([0.15, -0.08, 0, 0, 0, 0])).toEqual([6, 1, 3.5, 3.5, 3.5, 3.5])
  })

  test('全部并列时名次相同', () => {
    expect(averageRanks([5, 5, 5])).toEqual([2, 2, 2])
  })
})

describe('spearmanCorrelation', () => {
  test('完全同序为 1', () => {
    expect(spearmanCorrelation([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1)
  })

  test('完全反序为 -1', () => {
    expect(spearmanCorrelation([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1)
  })

  test('排名反转的前后半窗收益为 -1', () => {
    const first = [0.15, -0.08, 0, 0, 0, 0]
    const second = [-0.02, 0.03, 0, 0, 0, 0]
    expect(spearmanCorrelation(first, second)).toBeCloseTo(-1, 10)
  })

  test('单调非线性关系仍为 1', () => {
    expect(spearmanCorrelation([1, 2, 3], [1, 4, 9])).toBe(1)
  })

  test('任一侧无方差时返回 null', () => {
    expect(spearmanCorrelation([1, 2, 3], [5, 5, 5])).toBeNull()
  })

  test('长度不一致或样本不足时返回 null', () => {
    expect(spearmanCorrelation([1, 2, 3], [1, 2])).toBeNull()
    expect(spearmanCorrelation([1], [1])).toBeNull()
  })
})
