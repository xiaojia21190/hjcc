import { test, expect } from 'bun:test'
import type { CiticPositionPoint, MarketActiveCapPoint } from '../../shared/types'
import { buildActiveCapChartOption } from './activeCapChartOption'
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
      markLine?: {
        label?: Record<string, unknown>
        data?: { xAxis?: string; label?: { show?: boolean } }[]
      }
    }[]
    dataZoom: { start?: number; end?: number }[]
  }
}

function citicEventSeries(citic: CiticPositionPoint[]) {
  const option = build(citic)
  const series = option.series.find((s) => s.name === '中信大额事件')
  expect(series).toBeDefined()
  expect(series!.markLine).toBeDefined()
  return series!.markLine!
}

/** 100 个交易日的持仓：小额 ±50，eventIndices 处为 2σ 级大额 */
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

test('markLine 标签强制横排（rotate: 0）', () => {
  const markLine = citicEventSeries(makeCitic([30]))
  expect(markLine.label!.rotate).toBe(0)
})

test('中信事件密集时：竖线全保留，过密标签只隐藏文字', () => {
  // 事件 5/6/7 聚在一起，其余散布：minGap = ceil(250/10) = 25 根 K 线
  const eventIndices = [5, 6, 7, 40, 80]
  const data = citicEventSeries(makeCitic(eventIndices)).data!
  // 竖线数量 = 事件数量（全部保留，不删线）
  expect(data.length).toBe(5)
  const shown = data.filter((item) => item.label?.show !== false)
  const hidden = data.filter((item) => item.label?.show === false)
  // 6/7 与前一个已显示标签间距不足 → 隐藏
  expect(shown.map((item) => item.xAxis)).toEqual([isoDate(5), isoDate(40), isoDate(80)])
  expect(hidden.map((item) => item.xAxis)).toEqual([isoDate(6), isoDate(7)])
})

test('中信事件稀疏时：全部标签显示', () => {
  const data = citicEventSeries(makeCitic([10, 50, 90])).data!
  expect(data.length).toBe(3)
  expect(data.every((item) => item.label?.show !== false)).toBe(true)
})

test('setOption 合并模式下三个周期均能正常构造 option', () => {
  // BaseChart 用 setOption(option) 默认 merge 模式，周期切换时 option 需完整可重建
  for (const timeframe of ['daily', 'weekly', 'monthly'] as const) {
    const option = build([], 100, timeframe)
    expect(option).toBeDefined()
    expect(option.series.length).toBeGreaterThan(0)
    expect(option.dataZoom.length).toBe(2)
  }
})

test('日线 dataZoom 默认只看最近 10 个交易日，周/月线看全量', () => {
  // echarts dataZoom：start/end 为百分比 [0, 100]，相对轴范围 [0, n-1]
  const option = build([], 250, 'daily')
  const inside = option.dataZoom[0]
  expect(inside.start).toBeCloseTo((240 / 249) * 100, 1)
  expect(inside.end).toBe(100)
  // 可见根数 = round(249 * (100 - start) / 100) + 1 = 10
  const visible = Math.round((249 * (100 - (inside.start ?? 0))) / 100) + 1
  expect(visible).toBe(10)

  for (const timeframe of ['weekly', 'monthly'] as const) {
    const opt = build([], 100, timeframe)
    expect(opt.dataZoom[0].start).toBe(0)
    expect(opt.dataZoom[0].end).toBe(100)
  }
})

test('周线 dataZoom 展示全量周期', () => {
  const option = build([], 100, 'weekly')
  const inside = option.dataZoom[0]
  expect(inside.start).toBe(0)
  expect(inside.end).toBe(100)
})
