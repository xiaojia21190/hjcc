import { describe, expect, test } from 'bun:test'
import {
  estimateRangeYi,
  formatEstimateSharesRange,
  formatEstimateValueRange,
  lowResolutionLabel,
  LOW_RESOLUTION_WIDTH_RATIO,
} from './estimateDisplay'

describe('estimateRangeYi', () => {
  test('完整字段时计算宽度比与低分辨', () => {
    const range = estimateRangeYi({
      huijinShares: 22.63e8,
      huijinSharesFloor: 4.78,
      huijinSharesCeil: 58.33,
      totalSharesYi: 67.79,
    })
    expect(range).not.toBeNull()
    expect(range!.point).toBeCloseTo(22.63, 5)
    expect(range!.widthRatio).toBeGreaterThan(LOW_RESOLUTION_WIDTH_RATIO)
    expect(range!.lowResolution).toBe(true)
  })

  test('窄区间不标低分辨', () => {
    const range = estimateRangeYi({
      huijinShares: 90e8,
      huijinSharesFloor: 85,
      huijinSharesCeil: 100,
      totalSharesYi: 186,
    })
    expect(range!.widthRatio).toBeLessThan(LOW_RESOLUTION_WIDTH_RATIO)
    expect(range!.lowResolution).toBe(false)
  })

  test('缺字段返回 null', () => {
    expect(
      estimateRangeYi({
        huijinShares: 1e8,
        huijinSharesFloor: null,
        huijinSharesCeil: 2,
        totalSharesYi: 10,
      }),
    ).toBeNull()
  })
})

describe('format helpers', () => {
  test('份额区间文案', () => {
    const range = estimateRangeYi({
      huijinShares: 22.63e8,
      huijinSharesFloor: 4.78,
      huijinSharesCeil: 58.33,
      totalSharesYi: 67.79,
    })!
    expect(formatEstimateSharesRange(range)).toBe('22.63（4.78~58.33）亿份')
    expect(lowResolutionLabel(range)).toContain('低分辨')
  })

  test('估值区间按点估计隐含净值外推', () => {
    const range = estimateRangeYi({
      huijinShares: 10e8,
      huijinSharesFloor: 8,
      huijinSharesCeil: 12,
      totalSharesYi: 20,
    })!
    // 展示估值 15 亿 → 隐含 1.5 元/份
    expect(formatEstimateValueRange(15, range)).toBe('15.00 亿（12.00~18.00）')
  })
})
