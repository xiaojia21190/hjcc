import { describe, expect, test } from 'bun:test'
import { aggregateShareSignals } from './signals'

describe('aggregateShareSignals', () => {
  const mkPoint = (
    trend: 'inflow' | 'outflow' | 'flat',
    days: number,
    pct5d: number | null,
    cat: string,
  ) => ({
    shareTrend: trend,
    consecutiveDays: days,
    shareChangePct5d: pct5d,
    categoryName: cat,
  })

  test('inflow majority', () => {
    const points = [
      mkPoint('inflow', 3, 1.2, '沪深300'),
      mkPoint('inflow', 1, -0.5, '上证50'),
      mkPoint('inflow', 1, 0.9, '中证500'),
      mkPoint('outflow', 2, -8.4, '中证1000'),
      mkPoint('flat', 1, 0, '创业板'),
    ]
    const r = aggregateShareSignals(points)
    expect(r.headline).toBe('3/5 只净流入')
    expect(r.highlightConsecutive).toBe('沪深300 连续3日净流入')
    expect(r.highlightChange).toBe('中证1000 5日 -8.4%')
    expect(r.tone).toBe('inflow')
  })

  test('outflow majority', () => {
    const points = [
      mkPoint('outflow', 5, -3.1, '上证50'),
      mkPoint('outflow', 2, -1.0, '沪深300'),
      mkPoint('outflow', 1, -0.2, '中证500'),
      mkPoint('inflow', 1, 0.5, '中证1000'),
      mkPoint('flat', 1, 0, '创业板'),
    ]
    const r = aggregateShareSignals(points)
    expect(r.headline).toBe('3/5 只净流出')
    expect(r.highlightConsecutive).toBe('上证50 连续5日净流出')
    expect(r.tone).toBe('outflow')
  })

  test('mixed (no majority)', () => {
    const points = [
      mkPoint('inflow', 1, 0.5, '上证50'),
      mkPoint('inflow', 1, 0.3, '沪深300'),
      mkPoint('outflow', 1, -0.5, '中证500'),
      mkPoint('outflow', 1, -0.3, '中证1000'),
      mkPoint('flat', 1, 0, '创业板'),
    ]
    const r = aggregateShareSignals(points)
    expect(r.headline).toBe('2入/2出/1平')
    expect(r.tone).toBe('mixed')
  })

  test('empty input', () => {
    const r = aggregateShareSignals([])
    expect(r.headline).toBe('—')
    expect(r.highlightConsecutive).toBeNull()
    expect(r.highlightChange).toBeNull()
    expect(r.tone).toBe('none')
  })

  test('highlightChange picks largest absolute pct', () => {
    const points = [
      mkPoint('inflow', 1, 11.61, '创业板'),
      mkPoint('inflow', 2, 0.9, '沪深300'),
      mkPoint('inflow', 1, -8.45, '上证50'),
    ]
    const r = aggregateShareSignals(points)
    expect(r.highlightChange).toBe('创业板 5日 +11.61%')
  })

  test('all flat', () => {
    const points = [
      mkPoint('flat', 1, 0, '上证50'),
      mkPoint('flat', 1, 0, '沪深300'),
    ]
    const r = aggregateShareSignals(points)
    expect(r.headline).toBe('0入/0出/2平')
    expect(r.tone).toBe('mixed')
  })
})
