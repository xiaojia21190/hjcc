import { test, expect } from 'bun:test'
import type { CiticPositionPoint, MarketActiveCapPoint } from '../../shared/types'
import { buildActiveCapChartOption, citicNetChangeSeries } from './activeCapChartOption'
import type { KdjPoint } from './kdj'
import type { MacdPoint } from './macd'

const MACD: MacdPoint[] = []
const KDJ: KdjPoint[] = []

function isoDate(i: number): string {
  return new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10)
}

function makeHistory(n: number): MarketActiveCapPoint[] {
  const out: MarketActiveCapPoint[] = []
  for (let i = 0; i < n; i++) {
    out.push({ date: isoDate(i), marketIndex: 100 + i, activeCapYi: 100 + i, marketAmountYi: 50, referenceMaYi: 100 })
  }
  return out
}

function build(citic: CiticPositionPoint[], n = 250, timeframe: 'daily' | 'weekly' | 'monthly' = 'daily') {
  const history = makeHistory(n)
  return buildActiveCapChartOption(
    history,
    [],
    history.map(() => ({ dif: 0, dea: 0, macd: 0 })),
    history.map(() => ({ k: 50, d: 50, j: 50 })),
    timeframe,
    citic,
  ) as {
    series: {
      name: string
      type: string
      xAxisIndex?: number
      yAxisIndex?: number
      data?: unknown[]
      markLine?: unknown
      markPoint?: { data?: unknown[] }
    }[]
    grid: Record<string, unknown>[]
    xAxis: Record<string, unknown>[]
    yAxis: Record<string, unknown>[]
    dataZoom: { start?: number; end?: number; xAxisIndex?: number[] }[]
  }
}

function makeCitic(eventIndices: number[]): CiticPositionPoint[] {
  const out: CiticPositionPoint[] = []
  for (let i = 0; i < 100; i++) {
    out.push({
      date: isoDate(i),
      product: 'IF',
      longHold: 100,
      shortHold: 50,
      netHold: 50,
      longChange: 0,
      shortChange: 0,
      netChange: eventIndices.includes(i) ? 15382 : i % 2 ? 50 : -50,
    })
  }
  return out
}

test('中信净持仓序列：按日求和 + 2σ 大额标记', () => {
  const history = makeHistory(100)
  const citic = makeCitic([10, 20, 30])
  const { series, eventDates } = citicNetChangeSeries(citic, history.map((p) => p.date))
  // 每个交易日一个值
  expect(series.length).toBe(100)
  // 大额日的值 = 15382
  expect(series[10]).toBe(15382)
  // 普通日的值 = 50 或 -50
  expect(series[0]).toBe(-50)
  expect(series[1]).toBe(50)
  // 2σ 阈值下，15382 明显大于 50/-50 的分布 → 应被标记
  expect(eventDates.has(isoDate(10))).toBe(true)
  expect(eventDates.has(isoDate(20))).toBe(true)
  expect(eventDates.has(isoDate(30))).toBe(true)
  // 普通日不应被标记
  expect(eventDates.has(isoDate(0))).toBe(false)
  expect(eventDates.has(isoDate(1))).toBe(false)
})

test('中信净持仓序列：样本不足 20 时不产生大额标记', () => {
  const history = makeHistory(10)
  const citic = makeCitic([5]).slice(0, 10)
  const { series, eventDates } = citicNetChangeSeries(citic, history.map((p) => p.date))
  expect(series.length).toBe(10)
  expect(eventDates.size).toBe(0)
})

test('中信子图：有数据时存在独立 bar 系列（xAxisIndex=3）', () => {
  const option = build(makeCitic([10, 50]))
  const citicSeries = option.series.find((s) => s.name === '中信净持仓Δ（手）')
  expect(citicSeries).toBeDefined()
  expect(citicSeries!.type).toBe('bar')
  expect(citicSeries!.xAxisIndex).toBe(3)
  expect(citicSeries!.yAxisIndex).toBe(4)
})

test('中信子图：无数据时不渲染', () => {
  const option = build([])
  const citicSeries = option.series.find((s) => s.name === '中信净持仓Δ（手）')
  expect(citicSeries).toBeUndefined()
})

test('中信大额事件：markPoint 只在 2σ 日出现', () => {
  const option = build(makeCitic([10, 20, 30]))
  const citicSeries = option.series.find((s) => s.name === '中信净持仓Δ（手）')!
  expect(citicSeries.markPoint).toBeDefined()
  const points = citicSeries.markPoint!.data!
  expect(points.length).toBe(3)
  // 每个 markPoint 都有 coord（日期 + 数值）
  for (const p of points as { coord: [string, number] }[]) {
    expect(typeof p.coord[0]).toBe('string')
    expect(typeof p.coord[1]).toBe('number')
  }
})

test('中信大额事件：样本不足时不出现 markPoint', () => {
  const citic = makeCitic([5]).slice(0, 10)
  const option = build(citic, 100)
  const citicSeries = option.series.find((s) => s.name === '中信净持仓Δ（手）')!
  // 样本不足 20 天，sigma 无法稳定计算 → 无 markPoint
  expect(citicSeries.markPoint).toBeUndefined()
})

test('中信子图骨架：4 grid / 4 xAxis / 5 yAxis / dataZoom 控制 4 轴', () => {
  const option = build(makeCitic([10]))
  expect(option.grid.length).toBe(4)
  expect(option.xAxis.length).toBe(4)
  expect(option.yAxis.length).toBe(5)
  expect(option.dataZoom[0].xAxisIndex).toEqual([0, 1, 2, 3])
})

test('setOption 合并模式下三个周期均能正常构造 option', () => {
  for (const timeframe of ['daily', 'weekly', 'monthly'] as const) {
    const option = build(makeCitic([10]), 100, timeframe)
    expect(option).toBeDefined()
    expect(option.series.length).toBeGreaterThan(0)
    expect(option.dataZoom.length).toBe(2)
  }
})

test('日线 dataZoom 默认只看最近 10 个交易日，周/月线看全量', () => {
  const option = build(makeCitic([10]), 250, 'daily')
  const inside = option.dataZoom[0]
  expect(inside.start).toBeCloseTo((240 / 249) * 100, 1)
  expect(inside.end).toBe(100)
  const visible = Math.round((249 * (100 - (inside.start ?? 0))) / 100) + 1
  expect(visible).toBe(10)

  for (const timeframe of ['weekly', 'monthly'] as const) {
    const opt = build(makeCitic([10]), 100, timeframe)
    expect(opt.dataZoom[0].start).toBe(0)
    expect(opt.dataZoom[0].end).toBe(100)
  }
})
