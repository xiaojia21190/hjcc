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
    },
    data: events.map((event) => ({ name: event.label, xAxis: event.date })),
  }
}

/** 中信期货净持仓 |netChange| 超过 2σ 的交易日，作为事件标记。 */
function citicEventDates(citicHistory: CiticPositionPoint[]): Map<string, string[]> {
  const byDate = new Map<string, CiticPositionPoint[]>()
  for (const point of citicHistory) {
    if (point.netChange == null) continue
    const list = byDate.get(point.date) ?? []
    list.push(point)
    byDate.set(point.date, list)
  }
  // 全样本 netChange 的 σ
  const all = citicHistory
    .map((point) => point.netChange)
    .filter((v): v is number => v != null)
  if (all.length < 20) return new Map()
  const mean = all.reduce((s, v) => s + v, 0) / all.length
  const variance = all.reduce((s, v) => s + (v - mean) ** 2, 0) / (all.length - 1)
  const sigma = Math.sqrt(variance)
  if (sigma === 0) return new Map()
  const threshold = 2 * sigma
  const events = new Map<string, string[]>()
  for (const [date, points] of byDate) {
    const maxAbs = points
      .map((p) => Math.abs(p.netChange!))
      .reduce((a, b) => (b > a ? b : a), 0)
    if (maxAbs >= threshold) {
      const sign = points.reduce((s, p) => s + (p.netChange ?? 0), 0) >= 0 ? '中信净增' : '中信净减'
      events.set(date, [`${sign} ${maxAbs.toLocaleString()} 手`])
    }
  }
  return events
}

function citicMarkLine(citicHistory: CiticPositionPoint[], dateSet: Set<string>) {
  const events = citicEventDates(citicHistory)
  const items: { name: string; xAxis: string }[] = []
  for (const [date, labels] of events) {
    if (!dateSet.has(date)) continue
    items.push({ name: labels.join(' / '), xAxis: date })
  }
  if (items.length === 0) return undefined
  return {
    symbol: ['none', 'none'],
    silent: false,
    lineStyle: { color: 'rgba(248,113,113,0.55)', type: 'dotted', width: 1 },
    label: {
      show: true,
      color: '#f87171',
      fontSize: 10,
      formatter: '{b}',
      position: 'insideEndBottom',
    },
    data: items,
  }
}

function priceSeries(
  history: MarketActiveCapPoint[],
  events: MarketReportEvent[],
) {
  return [
    {
      name: '0AMV 活筹估算',
      type: 'line',
      smooth: true,
      showSymbol: false,
      data: history.map((point) => point.activeCapYi),
      itemStyle: { color: '#3d9cf0' },
      lineStyle: { width: 2.4 },
      areaStyle: { color: 'rgba(61,156,240,0.10)' },
      markLine: eventMarkLine(events),
      z: 3,
    },
    // 中信大额增减持事件标记：用隐形线序列承载 markLine，避免主序列 markLine 冲突
    {
      name: '中信大额事件',
      type: 'line',
      showSymbol: false,
      data: [],
      lineStyle: { opacity: 0, width: 0 },
      markLine: undefined, // 由调用方注入
      z: 2,
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
  const visibleCount = timeframe === 'daily' ? 250 : dates.length
  const visibleStart = Math.max(0, dates.length - visibleCount)
  const visibleEnd = Math.max(visibleStart, dates.length - 1)
  const dateSet = new Set(dates.map((date) => date.split('（')[0]))
  const visibleEvents = events.filter((event) => dateSet.has(event.date))
  const citicMarkLineOption =
    citicHistory.length > 0 ? citicMarkLine(citicHistory, dateSet) : undefined
  const zoom = { startValue: visibleStart, endValue: visibleEnd }
  const series: Record<string, unknown>[] = [...priceSeries(history, visibleEvents)]
  if (citicMarkLineOption) {
    // 在隐形事件序列上注入 markLine
    const eventSeries = series.find((s) => s.name === '中信大额事件')
    if (eventSeries) eventSeries.markLine = citicMarkLineOption
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
      { left: 72, right: 72, top: 52, height: '38%' },
      { left: 72, right: 72, top: '54%', height: '13%' },
      { left: 72, right: 72, top: '72%', height: '13%' },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2], ...zoom },
      {
        type: 'slider',
        xAxisIndex: [0, 1, 2],
        height: 20,
        bottom: 16,
        ...zoom,
        borderColor: 'rgba(148,163,184,0.15)',
        backgroundColor: 'rgba(15,23,42,0.35)',
        fillerColor: 'rgba(61,156,240,0.18)',
        textStyle: { color: '#6b7c90' },
      },
    ],
    xAxis: [categoryAxis(dates), categoryAxis(dates, 1), categoryAxis(dates, 2)],
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
    ],
    series: [
      ...series,
      ...macdSeries(macdPoints),
      ...kdjSeries(kdjPoints),
    ],
  }
}
