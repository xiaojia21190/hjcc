import { test, expect } from 'bun:test'
import { buildHuijinEstimate, FLOOR_WEIGHT, CEIL_WEIGHT } from './estimate'
import type { HolderReport, NavPoint, ScalePoint } from '../../shared/types'

function dailyPoint(date: string, totalSharesYi: number, netSub: number | null): ScalePoint {
  return {
    date, totalSharesYi,
    netAssetYi: totalSharesYi * 1.5,
    purchaseYi: null, redeemYi: null,
    netSubscriptionYi: netSub,
    netAssetChangePct: null,
    frequency: 'daily', shareSource: 'sse', netAssetEstimated: true,
  }
}

function navPt(date: string, value: number): NavPoint {
  return { date, nav: value, accNav: value, changePct: null }
}

function anchorReport(shares: number, percent: number): HolderReport {
  return {
    reportDate: '2025-12-31',
    holders: [{ name: '中央汇金投资有限责任公司', shares, percent, isHuijin: true }],
    huijinShares: shares,
    huijinPercent: percent,
  }
}

test('披露日标记 disclosed，不生成区间', () => {
  const scale = [dailyPoint('2025-12-31', 200, null)]
  const result = buildHuijinEstimate(scale, [anchorReport(100e8, 50)], [navPt('2025-12-31', 1.5)])
  expect(result[0]!.estimateMethod).toBe('disclosed')
  expect(result[0]!.huijinShares).toBe(100e8)
  expect(result[0]!.huijinSharesFloor).toBeUndefined()
})

test('anchored 点生成 floor/ceil 区间并累加', () => {
  const scale = [
    dailyPoint('2025-12-31', 200, null),
    dailyPoint('2026-01-02', 190, -10),
    dailyPoint('2026-01-03', 195, 5),
  ]
  const navs = [navPt('2025-12-31', 1.5), navPt('2026-01-02', 1.5), navPt('2026-01-03', 1.5)]
  const result = buildHuijinEstimate(scale, [anchorReport(100e8, 50)], navs)

  const p1 = result[1]!
  expect(p1.estimateMethod).toBe('anchored')
  expect(p1.isEstimated).toBe(true)
  // floor = clamp(100 + (-10), 0, 190) = 90
  expect(p1.huijinSharesFloor).toBeCloseTo(90, 4)
  // ceil = 190 × 50% = 95
  expect(p1.huijinSharesCeil).toBeCloseTo(95, 4)
  // 展示值 = 90*2/3 + 95*1/3 ≈ 91.667 亿份 → 份
  expect(p1.huijinShares).toBe(Math.round((90 * FLOOR_WEIGHT + 95 * CEIL_WEIGHT) * 1e8))
  // huijinValueYi = weightedYi × nav
  expect(p1.huijinValueYi).toBeCloseTo((90 * FLOOR_WEIGHT + 95 * CEIL_WEIGHT) * 1.5, 3)

  const p2 = result[2]!
  // floor = clamp(90 + 5, 0, 195) = 95
  expect(p2.huijinSharesFloor).toBeCloseTo(95, 4)
  // ceil = 195 × 50% = 97.5
  expect(p2.huijinSharesCeil).toBeCloseTo(97.5, 4)
})

test('floor 不为负', () => {
  const scale = [
    dailyPoint('2025-12-31', 100, null),
    dailyPoint('2026-01-02', 50, -60),
  ]
  const navs = [navPt('2025-12-31', 1), navPt('2026-01-02', 1)]
  const result = buildHuijinEstimate(scale, [anchorReport(10e8, 10)], navs)
  // floor = clamp(10 + (-60), 0, 50) = 0
  expect(result[1]!.huijinSharesFloor).toBe(0)
})

test('floor 不超过当日总份额', () => {
  const scale = [
    dailyPoint('2025-12-31', 100, null),
    dailyPoint('2026-01-02', 60, -10),
  ]
  const navs = [navPt('2025-12-31', 1), navPt('2026-01-02', 1)]
  const result = buildHuijinEstimate(scale, [anchorReport(80e8, 80)], navs)
  // floor = clamp(80 + (-10), 0, 60) = 60（被总份额截断）
  expect(result[1]!.huijinSharesFloor).toBeCloseTo(60, 4)
})

test('无锚点时全部 unavailable', () => {
  const reports: HolderReport[] = [{
    reportDate: '2025-12-31',
    holders: [{ name: '张三', shares: 100e8, percent: 50, isHuijin: false }],
    huijinShares: 0, huijinPercent: 0,
  }]
  const scale = [dailyPoint('2026-01-02', 100, 1)]
  const result = buildHuijinEstimate(scale, reports, [])
  expect(result[0]!.estimateMethod).toBe('unavailable')
  expect(result[0]!.huijinShares).toBeNull()
})

test('锚点日之前非披露点为 unavailable', () => {
  const scale = [
    dailyPoint('2025-06-30', 200, null),
    dailyPoint('2025-12-31', 200, 0),
  ]
  const result = buildHuijinEstimate(scale, [anchorReport(100e8, 50)], [navPt('2025-12-31', 1.5)])
  expect(result[0]!.estimateMethod).toBe('unavailable')
  expect(result[1]!.estimateMethod).toBe('disclosed')
})

test('anchored 点携带趋势信号', () => {
  const scale = [
    dailyPoint('2025-12-31', 200, null),
    dailyPoint('2026-01-02', 201, 1),
    dailyPoint('2026-01-03', 202, 1),
  ]
  const navs = [navPt('2025-12-31', 1), navPt('2026-01-02', 1), navPt('2026-01-03', 1)]
  const result = buildHuijinEstimate(scale, [anchorReport(100e8, 50)], navs)
  expect(result[1]!.shareTrend).toBe('inflow')
  expect(result[1]!.consecutiveDays).toBe(1)
  expect(result[2]!.consecutiveDays).toBe(2)
})

test('非 daily 点在锚点之后为 unavailable', () => {
  const periodic: ScalePoint = {
    date: '2026-03-31', totalSharesYi: 180, netAssetYi: 270,
    purchaseYi: null, redeemYi: null, netSubscriptionYi: null,
    netAssetChangePct: null, frequency: 'periodic', shareSource: 'eastmoney', netAssetEstimated: false,
  }
  const scale = [dailyPoint('2025-12-31', 200, null), periodic]
  const result = buildHuijinEstimate(scale, [anchorReport(100e8, 50)], [navPt('2025-12-31', 1.5)])
  expect(result[1]!.estimateMethod).toBe('unavailable')
})
