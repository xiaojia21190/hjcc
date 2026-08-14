import { describe, expect, test } from 'bun:test'
import { kdjAxisMax, kdjAxisMin } from './activeCapChartOption'
import { formatActiveCapTooltip, formatChartNumber } from './activeCapTooltip'

describe('formatChartNumber', () => {
  test('保留两位小数', () => {
    expect(formatChartNumber(12.345)).toBe('12.35')
  })

  test('对象值和空值可解析', () => {
    expect(formatChartNumber({ value: -3.1 })).toBe('-3.10')
    expect(formatChartNumber(null)).toBe('—')
  })
})

describe('formatActiveCapTooltip', () => {
  test('按主图 / MACD / KDJ 分组', () => {
    const html = formatActiveCapTooltip([
      { axisValueLabel: '2026-08-13', seriesName: '0AMV 活筹估算', marker: '•', value: 100 },
      { seriesName: 'DIF', marker: '•', value: 1.2 },
      { seriesName: 'K', marker: '•', value: 66.7 },
      { seriesName: 'D', marker: '•', value: 55.6 },
    ])
    expect(html).toContain('2026-08-13')
    expect(html).toContain('主图')
    expect(html).toContain('MACD')
    expect(html).toContain('KDJ')
    expect(html.indexOf('主图')).toBeLessThan(html.indexOf('MACD'))
    expect(html.indexOf('MACD')).toBeLessThan(html.indexOf('KDJ'))
  })
})

describe('kdj 轴范围', () => {
  test('常规区间固定在 -20 到 120', () => {
    expect(kdjAxisMin({ min: 8 })).toBe(-20)
    expect(kdjAxisMax({ max: 96 })).toBe(120)
  })

  test('J 越界时向外扩整十', () => {
    expect(kdjAxisMin({ min: -33 })).toBe(-40)
    expect(kdjAxisMax({ max: 128 })).toBe(130)
  })
})
