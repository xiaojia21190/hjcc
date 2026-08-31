import type { EChartsCoreOption } from 'echarts/core'
import type { CiticPositionPoint, MarketActiveCapPoint, MarketReportEvent } from '../../shared/types'
import { formatActiveCapTooltip, MAIN_LEGEND } from './activeCapTooltip'
import type { KdjPoint } from './kdj'
import type { MacdPoint } from './macd'

const KDJ_GUIDES = [20, 50, 80]

export function kdjAxisMin(extent: { min: number }): number {
  return Math.min(-20, Math.floor(extent.min / 10) * 10)
}

export function kdjAxisMax(extent: { max: number }): number {
  return Math.max(120, Math.ceil(extent.max / 10) * 10)
}

const AXIS = {
  axisLine: { lineStyle: { color: 'rgba(148,163,184,0.25)' } },
  axisLabel: { color: '#93a4b8', fontSize: 11 },
  splitLine: { lineStyle: { color: 'rgba(148,163,184,0.08)' } },
}

const NAME_STYLE = { color: '#6b7c90', fontSize: 11 }

function categoryAxis(dates: string[], gridIndex?: number) {
  const showFull = dates.length <= 48 || dates.some((value) => value.includes('-W'))
  return {
    type: 'category' as const,
    data: dates,
    boundaryGap: true,
    ...AXIS,
    ...(gridIndex == null
      ? {
          axisLabel: {
            ...AXIS.axisLabel,
            formatter: (value: string) => (showFull ? value : value.slice(0, 7)),
          },
        }
      : { gridIndex, axisLabel: { show: false }, axisTick: { show: false } }),
  }
}

function valueAxis(name: string, extra: Record<string, unknown> = {}) {
  return { type: 'value' as const, name, nameTextStyle: NAME_STYLE, ...AXIS, ...extra }
}

function eventMarkLine(events: MarketReportEvent[]) {
  if (events.length === 0) return undefined
  return {
    symbol: ['none', 'none'],
    silent: false,
    lineStyle: { color: 'rgba(240,180,41,0.65)', type: 'dashed', width: 1 },
    label: {
      show: true,
      color: '#f0b429',
      fontSize: 10,
      formatter: '{b}',
      position: 'insideEndTop',
      rotate: 0,
    },
    data: events.map((event) => ({ name: event.label, xAxis: event.date })),
  }
}

/**
 * 中信期货席位净持仓日变化（四品种 netChange 求和，手）。
 * 返回与 dates 对齐的序列（缺失日为 null）和 2σ 大额标记日期集合。
 */
export function citicNetChangeSeries(
  citicHistory: CiticPositionPoint[],
  dates: string[],
): { series: (number | null)[]; eventDates: Set<string> } {
  const byDate = new Map<string, number>()
  const all: number[] = []
  for (const point of citicHistory) {
    if (point.netChange == null) continue
    byDate.set(point.date, (byDate.get(point.date) ?? 0) + point.netChange)
    all.push(point.netChange)
  }
  const series = dates.map((date) => byDate.get(date) ?? null)
  if (all.length < 20) return { series, eventDates: new Set() }
  const mean = all.reduce((s, v) => s + v, 0) / all.length
  const variance = all.reduce((s, v) => s + (v - mean) ** 2, 0) / (all.length - 1)
  const sigma = Math.sqrt(variance)
  if (sigma === 0) return { series, eventDates: new Set() }
  const threshold = 2 * sigma
  const eventDates = new Set<string>()
  for (const [date, sum] of byDate) {
    if (Math.abs(sum) >= threshold) eventDates.add(date)
  }
  return { series, eventDates }
}

function citicSeries(
  history: MarketActiveCapPoint[],
  citicHistory: CiticPositionPoint[],
) {
  const { series: netChange, eventDates } = citicNetChangeSeries(citicHistory, history.map((p) => p.date))
  const markPoint =
    eventDates.size > 0
      ? {
          symbol: 'pin' as const,
          symbolSize: 24,
          symbolOffset: [0, -10] as [number, number],
          itemStyle: { color: 'rgba(248,113,113,0.9)' },
          label: {
            show: true,
            formatter: () => '!',
            color: '#0f172a',
            fontSize: 10,
            fontWeight: 'bold' as const,
          },
          data: history
            .map((point, i) => ({ date: point.date, value: netChange[i] }))
            .filter((point) => point.value != null && eventDates.has(point.date))
            .map((point) => ({
              coord: [point.date, point.value],
              value: point.value as number,
            })),
        }
      : undefined
  return [
    {
      name: '中信净持仓Δ（手）',
      type: 'bar' as const,
      xAxisIndex: 3,
      yAxisIndex: 4,
      data: netChange,
      barMaxWidth: 10,
      itemStyle: {
        color: (params: { value?: number | null }) =>
          (params.value ?? 0) >= 0 ? 'rgba(248,113,113,0.7)' : 'rgba(74,222,128,0.7)',
      },
      markLine: {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: 'rgba(148,163,184,0.35)', type: 'solid', width: 1 },
        data: [{ yAxis: 0 }],
      },
      markPoint,
      z: 2,
    },
  ]
}

function priceSeries(
  history: MarketActiveCapPoint[],
  events: MarketReportEvent[],
) {
  return [
    {
      name: '0AMV 活筹估算',      type: 'line',
      smooth: true,
      showSymbol: false,
      data: history.map((point) => point.activeCapYi),
      itemStyle: { color: '#3d9cf0' },
      lineStyle: { width: 2.4 },
      areaStyle: { color: 'rgba(61,156,240,0.10)' },
      markLine: eventMarkLine(events),
      z: 3,
    },
    {
      name: '5 日参考线',
      type: 'line',
      smooth: true,
      showSymbol: false,
      data: history.map((point) => point.referenceMaYi),
      itemStyle: { color: '#f0b429' },
      lineStyle: { width: 1.6 },
      z: 4,
    },
    {
      name: '沪深两市成交额',
      type: 'bar',
      yAxisIndex: 1,
      data: history.map((point) => point.marketAmountYi),
      barMaxWidth: 8,
      itemStyle: { color: 'rgba(94,234,212,0.18)' },
      z: 1,
    },
  ]
}

function macdSeries(points: MacdPoint[]) {
  return [
    {
      name: 'DIF',
      type: 'line',
      xAxisIndex: 1,
      yAxisIndex: 2,
      showSymbol: false,
      data: points.map((point) => point.dif),
      itemStyle: { color: '#e8eef7' },
      lineStyle: { width: 1.4 },
      z: 2,
    },
    {
      name: 'DEA',
      type: 'line',
      xAxisIndex: 1,
      yAxisIndex: 2,
      showSymbol: false,
      data: points.map((point) => point.dea),
      itemStyle: { color: '#f0b429' },
      lineStyle: { width: 1.4, type: 'dashed' },
      z: 2,
    },
    {
      name: 'MACD 柱',
      type: 'bar',
      xAxisIndex: 1,
      yAxisIndex: 2,
      data: points.map((point) => ({
        value: point.macd,
        itemStyle: {
          color: point.macd >= 0 ? 'rgba(248,113,113,0.75)' : 'rgba(74,222,128,0.75)',
        },
      })),
      barMaxWidth: 6,
      z: 1,
    },
  ]
}

function kdjGuideLine() {
  return {
    silent: true,
    symbol: 'none',
    label: { show: false },
    lineStyle: { color: 'rgba(148,163,184,0.28)', type: 'dashed', width: 1 },
    data: KDJ_GUIDES.map((value) => ({ yAxis: value })),
  }
}

function kdjSeries(points: KdjPoint[]) {
  const line = (
    name: string,
    color: string,
    dashed: boolean,
    values: number[],
    markLine?: ReturnType<typeof kdjGuideLine>,
  ) => ({
    name,
    type: 'line' as const,
    xAxisIndex: 2,
    yAxisIndex: 3,
    showSymbol: false,
    data: values,
    itemStyle: { color },
    lineStyle: { width: 1.4, ...(dashed ? { type: 'dashed' as const } : {}) },
    markLine,
    z: 2,
  })
  return [
    line('K', '#5eead4', false, points.map((point) => point.k), kdjGuideLine()),
    line('D', '#c084fc', true, points.map((point) => point.d)),
    line('J', '#fb7185', false, points.map((point) => point.j)),
  ]
}

export function buildActiveCapChartOption(
  history: MarketActiveCapPoint[],
  events: MarketReportEvent[],
  macdPoints: MacdPoint[],
  kdjPoints: KdjPoint[],
  timeframe: 'daily' | 'weekly' | 'monthly' = 'daily',
  citicHistory: CiticPositionPoint[] = [],
): EChartsCoreOption {
  const dates = history.map((point) => point.date)
  const dateSet = new Set(dates.map((date) => date.split('（')[0]))
  const visibleEvents = events.filter((event) => dateSet.has(event.date))
  // 日线只展示最近 10 个交易日（图表不再尾随全历史，与中信事件标记的默认密度对齐）；
  // 周/月线周期数少，直接看全量。echarts dataZoom 的 start/end 为百分比，相对轴范围 [0, n-1]。
  const zoom =
    timeframe === 'daily'
      ? { start: (Math.max(0, dates.length - 10) / Math.max(1, dates.length - 1)) * 100, end: 100 }
      : { start: 0, end: 100 }
  const series: Record<string, unknown>[] = [
    ...priceSeries(history, visibleEvents),
  ]
  if (citicHistory.length > 0) {
    series.push(...citicSeries(history, citicHistory))
  }

  return {
    backgroundColor: 'transparent',
    color: ['#3d9cf0', '#f0b429', '#5eead4', '#e8eef7', '#f0b429', '#f87171', '#5eead4', '#c084fc', '#fb7185'],
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(18,24,32,0.96)',
      borderColor: 'rgba(148,163,184,0.2)',
      textStyle: { color: '#e8eef7', fontSize: 12 },
      formatter: formatActiveCapTooltip,
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    legend: {
      top: 0,
      data: [...MAIN_LEGEND],
      itemWidth: 10,
      itemGap: 10,
      textStyle: { color: '#93a4b8', fontSize: 11 },
    },
    grid: [
      { left: 72, right: 72, top: 52, height: '36%' },
      { left: 72, right: 72, top: '47%', height: '11%' },
      { left: 72, right: 72, top: '61%', height: '11%' },
      { left: 72, right: 72, top: '75%', height: '12%' },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2, 3], ...zoom },
      {
        type: 'slider',
        xAxisIndex: [0, 1, 2, 3],
        height: 20,
        bottom: 16,
        ...zoom,
        borderColor: 'rgba(148,163,184,0.15)',
        backgroundColor: 'rgba(15,23,42,0.35)',
        fillerColor: 'rgba(61,156,240,0.18)',
        textStyle: { color: '#6b7c90' },
      },
    ],
    xAxis: [
      categoryAxis(dates),
      categoryAxis(dates, 1),
      categoryAxis(dates, 2),
      categoryAxis(dates, 3),
    ],
    yAxis: [
      valueAxis('0AMV 估算（亿元）', { scale: true }),
      valueAxis('成交额（亿元）', { splitLine: { show: false } }),
      valueAxis('MACD', { gridIndex: 1, scale: true, splitNumber: 2, splitLine: { show: false } }),
      valueAxis('KDJ', {
        gridIndex: 2,
        min: kdjAxisMin,
        max: kdjAxisMax,
        interval: 20,
        splitLine: { show: false },
      }),
      valueAxis('中信净持仓Δ（手）', { gridIndex: 3, scale: true, splitNumber: 2, splitLine: { show: false } }),
    ],
    series: [
      ...series,
      ...macdSeries(macdPoints),
      ...kdjSeries(kdjPoints),
    ],
  }
}
