import { describe, expect, test } from 'bun:test'
import { resampleActiveCap, type Timeframe } from './activeCapResample'
import type { MarketActiveCapPoint } from '../../shared/types'

function day(date: string, activeCap: number, amount: number, index: number): MarketActiveCapPoint {
  return { date, activeCapYi: activeCap, marketIndex: index, marketAmountYi: amount, referenceMaYi: null }
}

// 跨 3 个自然周、2 个自然月；第三周只有周三一天（不完整）
const HISTORY = [
  day('2026-02-02', 100, 10, 3000), // 周一，W05 第 1 天
  day('2026-02-03', 101, 12, 3010),
  day('2026-02-06', 102, 11, 3020), // W05 末
  day('2026-02-09', 103, 13, 3030), // W06 起，新一个月
  day('2026-02-13', 104, 14, 3040), // W06 末
  day('2026-02-18', 105, 15, 3050), // W07 起
  day('2026-02-19', 106, 16, 3060), // W07 末
  day('2026-03-03', 107, 17, 3070), // 3 月
  day('2026-03-04', 108, 18, 3080),
  day('2026-03-11', 109, 19, 3090), // 3 月最后一个交易日
]

describe('resampleActiveCap 日线', () => {
  test('原样返回', () => {
    expect(resampleActiveCap(HISTORY, 'daily')).toBe(HISTORY)
  })
})

describe('resampleActiveCap 周线', () => {
  test('按 ISO 周聚合，level 取末值、流量取合计', () => {
    const weekly = resampleActiveCap(HISTORY, 'weekly')
    expect(weekly.map((p) => p.date)).toEqual(['2026-W06', '2026-W07', '2026-W08', '2026-W10', '2026-W11（未走完）'])
    expect(weekly.map((p) => p.activeCapYi)).toEqual([102, 104, 106, 108, 109])
    expect(weekly.map((p) => p.marketAmountYi)).toEqual([33, 27, 31, 35, 19])
    expect(weekly.map((p) => p.marketIndex)).toEqual([3020, 3040, 3060, 3080, 3090])
  })

  test('最后一周不完整时标注', () => {
    const weekly = resampleActiveCap(HISTORY, 'weekly')
    expect(weekly.at(-1)!.date.endsWith('（未走完）')).toBe(true)
    expect(weekly.slice(0, -1).every((p) => !p.date.includes('（未走完）'))).toBe(true)
  })
})

describe('resampleActiveCap 月线', () => {
  test('按自然月聚合', () => {
    const monthly = resampleActiveCap(HISTORY, 'monthly')
    expect(monthly.map((p) => p.date)).toEqual(['2026-02', '2026-03（未走完）'])
    expect(monthly.map((p) => p.activeCapYi)).toEqual([106, 109])
    expect(monthly.map((p) => p.marketAmountYi)).toEqual([91, 54])
    expect(monthly.at(-1)!.date.endsWith('（未走完）')).toBe(true)
  })

  test('空历史安全', () => {
    expect(resampleActiveCap([], 'weekly')).toEqual([])
  })
})

describe('timeframe 全覆盖', () => {
  test.each<Timeframe>(['daily', 'weekly', 'monthly'])('%s 长度合理', (tf) => {
    const points = resampleActiveCap(HISTORY, tf)
    expect(points.length).toBeGreaterThanOrEqual(1)
    expect(points.length).toBeLessThanOrEqual(HISTORY.length)
  })
})
