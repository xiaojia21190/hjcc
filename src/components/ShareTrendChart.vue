<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot } from '../../shared/types'
import BaseChart from './BaseChart.vue'
import type { EChartsCoreOption } from 'echarts/core'

const props = withDefaults(
  defineProps<{
    etf?: EtfSnapshot | null
    etfs?: EtfSnapshot[]
    mode?: 'single' | 'all'
  }>(),
  { etf: null, etfs: () => [], mode: 'all' },
)

const palette = ['#3d9cf0', '#5eead4', '#f0b429', '#c084fc', '#f07178', '#7fd99a']
const OFFICIAL_DISPLAY_POINTS = 250
const axisStyle = {
  axisLine: { lineStyle: { color: 'rgba(148,163,184,0.25)' } },
  axisLabel: { color: '#93a4b8', fontSize: 11 },
  splitLine: { lineStyle: { color: 'rgba(148,163,184,0.08)' } },
}

function recentCutoff(dates: string[], years = 6): string | null {
  if (!dates.length) return null
  const latest = new Date(`${dates.sort().at(-1)}T00:00:00Z`)
  latest.setUTCFullYear(latest.getUTCFullYear() - years)
  return latest.toISOString().slice(0, 10)
}

const timeAxis = {
  type: 'time' as const,
  boundaryGap: false,
  ...axisStyle,
  axisLabel: {
    ...axisStyle.axisLabel,
    formatter: (value: number) => {
      const date = new Date(value)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    },
  },
}

const dataZoom = [
  { type: 'inside' as const, filterMode: 'none' as const },
  {
    type: 'slider' as const,
    height: 18,
    bottom: 8,
    borderColor: 'rgba(148,163,184,0.15)',
    backgroundColor: 'rgba(15,23,42,0.35)',
    fillerColor: 'rgba(61,156,240,0.18)',
    textStyle: { color: '#6b7c90', fontSize: 10 },
  },
]

function shareValueFormatter(value: unknown) {
  const numeric = Array.isArray(value) ? value[1] : value
  return numeric == null || numeric === '-' || !Number.isFinite(Number(numeric))
    ? '—'
    : `${Number(numeric).toFixed(2)} 亿份`
}

const option = computed<EChartsCoreOption>(() => {
  if (props.mode === 'single' && props.etf) {
    const dailyHistory = props.etf.scaleHistory.filter(
      (point) => point.frequency === 'daily',
    )
    const hist = dailyHistory.length
      ? dailyHistory.slice(-OFFICIAL_DISPLAY_POINTS)
      : props.etf.scaleHistory.slice(-24)
    const hasDaily = dailyHistory.length > 0
    const huijinMap = new Map(
      props.etf.huijinHistory.map((point) => [
        point.reportDate,
        point.shares / 1e8,
      ]),
    )
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: 'rgba(18,24,32,0.96)',
        borderColor: 'rgba(148,163,184,0.2)',
        textStyle: { color: '#e8eef7', fontSize: 12 },
        valueFormatter: shareValueFormatter,
      },
      legend: { top: 0, textStyle: { color: '#93a4b8' } },
      grid: { left: 62, right: 62, top: 42, bottom: 64 },
      dataZoom,
      xAxis: timeAxis,
      yAxis: [
        {
          type: 'value',
          name: '总份额（亿份）',
          nameTextStyle: { color: '#6b7c90' },
          ...axisStyle,
        },
        {
          type: 'value',
          name: '净变化（亿份）',
          nameTextStyle: { color: '#6b7c90' },
          ...axisStyle,
        },
      ],
      series: [
        {
          name: 'ETF 总份额',
          type: 'line',
          smooth: false,
          showSymbol: hist.length < 80,
          symbolSize: 5,
          data: hist.map((point) => [point.date, point.totalSharesYi]),
          itemStyle: { color: palette[0] },
          lineStyle: { width: 2.4 },
          areaStyle: { color: 'rgba(61,156,240,0.10)' },
        },
        {
          name: '汇金披露份额',
          type: 'line',
          smooth: false,
          connectNulls: false,
          showSymbol: true,
          symbolSize: 6,
          data: hist.map((point) => [point.date, huijinMap.get(point.date) ?? null]),
          itemStyle: { color: palette[2] },
          lineStyle: { width: 1.8, type: 'dashed' },
        },
        {
          name: hasDaily ? '每日净份额变化' : '期间净申赎',
          type: 'bar',
          yAxisIndex: 1,
          barMaxWidth: 14,
          data: hist.map((point) => [
            point.date,
            point.netSubscriptionYi ??
              (point.purchaseYi != null && point.redeemYi != null
                ? Number((point.purchaseYi - point.redeemYi).toFixed(2))
                : null),
          ]),
          itemStyle: { color: 'rgba(94,234,212,0.42)' },
        },
      ],
    }
  }

  const displayHistories = props.etfs.map((etf) => {
    const daily = etf.scaleHistory.filter((point) => point.frequency === 'daily')
    return { etf, history: daily.length ? daily.slice(-OFFICIAL_DISPLAY_POINTS) : etf.scaleHistory }
  })
  const allDates = displayHistories.flatMap(({ history }) =>
    history.map((point) => point.date),
  )
  const cutoff = recentCutoff(allDates)
  const series = displayHistories.map(({ etf, history: fullHistory }, index) => {
    const history = cutoff
      ? fullHistory.filter((point) => point.date >= cutoff)
      : fullHistory
    return {
      name: `${etf.categoryName} · 总份额`,
      type: 'line' as const,
      smooth: false,
      showSymbol: history.length < 80,
      symbolSize: 4,
      lineStyle: { width: 2 },
      itemStyle: { color: palette[index % palette.length] },
      data: history.map((point) => [point.date, point.totalSharesYi]),
    }
  })

  return {
    backgroundColor: 'transparent',
    color: palette,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      backgroundColor: 'rgba(18,24,32,0.96)',
      borderColor: 'rgba(148,163,184,0.2)',
      textStyle: { color: '#e8eef7', fontSize: 12 },
      valueFormatter: shareValueFormatter,
    },
    legend: { top: 0, type: 'scroll', textStyle: { color: '#93a4b8', fontSize: 12 } },
    grid: { left: 62, right: 20, top: 42, bottom: 64 },
    dataZoom,
    xAxis: timeAxis,
    yAxis: {
      type: 'value',
      name: '总份额（亿份）',
      nameTextStyle: { color: '#6b7c90', fontSize: 11 },
      ...axisStyle,
    },
    series,
  }
})
</script>

<template>
  <BaseChart :option="option" height="380px" />
</template>
