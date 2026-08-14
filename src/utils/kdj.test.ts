import { describe, expect, test } from 'bun:test'
import { computeKdj, kdjSignal } from './kdj'

describe('computeKdj', () => {
  test('空序列返回空数组', () => {
    expect(computeKdj([])).toEqual([])
  })

  test('常数序列 RSV 无波动，KDJ 保持 50', () => {
    expect(computeKdj([10, 10, 10, 10])).toEqual([
      { k: 50, d: 50, j: 50 },
      { k: 50, d: 50, j: 50 },
      { k: 50, d: 50, j: 50 },
      { k: 50, d: 50, j: 50 },
    ])
  })

  test('按通达信 SMA 计算 K/D/J', () => {
    const points = computeKdj([10, 12, 11, 13], 3)
    expect(points[0]).toEqual({ k: 50, d: 50, j: 50 })
    expect(points[1]).toEqual({ k: 66.67, d: 55.56, j: 88.89 })
    expect(points[2]).toEqual({ k: 61.11, d: 57.41, j: 68.52 })
    expect(points[3]).toEqual({ k: 74.07, d: 62.96, j: 96.3 })
  })

  test('上升序列末值偏向超买区', () => {
    const last = computeKdj([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).at(-1)
    expect(last?.k).toBeGreaterThan(80)
    expect(last?.j).toBeGreaterThan(last?.k ?? 0)
  })
})

describe('kdjSignal', () => {
  test('缺数据时提示不足', () => {
    expect(kdjSignal()).toBe('数据不足')
  })

  test('K 上穿 D 为金叉，下穿为死叉', () => {
    expect(kdjSignal({ k: 55, d: 52, j: 61 }, { k: 40, d: 50, j: 20 })).toBe('金叉')
    expect(kdjSignal({ k: 48, d: 52, j: 40 }, { k: 55, d: 50, j: 65 })).toBe('死叉')
  })

  test('交叉优先于超买超卖，其后按阈值判定', () => {
    expect(kdjSignal({ k: 85, d: 70, j: 115 })).toBe('超买')
    expect(kdjSignal({ k: 15, d: 25, j: -5 })).toBe('超卖')
    expect(kdjSignal({ k: 60, d: 50, j: 80 })).toBe('多头')
    expect(kdjSignal({ k: 40, d: 50, j: 20 })).toBe('空头')
  })
})
