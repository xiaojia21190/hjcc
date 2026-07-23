<script setup lang="ts">
import { computed } from 'vue'
import type { MarketActiveCapPoint, MarketReportEvent } from '../../shared/types'
import BaseChart from './BaseChart.vue'
import type { EChartsCoreOption } from 'echarts/core'
import { changeClass, formatPct, formatYi } from '../utils/format'

const props = withDefaults(
  defineProps<{
    history?: MarketActiveCapPoint[]
    events?: MarketReportEvent[]
  }>(),
  { history: () => [], events: () => [] },
)

const axisStyle = {
  axisLine: { lineStyle: { color: 'rgba(148,163,184,0.25)' } },
  axisLabel: { color: '#93a4b8', fontSize: 11 },
  splitLine: { lineStyle: { color: 'rgba(148,163,184,0.08)' } },
}

function changePct(current: number, previous?: number): number | null {
  if (previous == null || previous === 0) return null
  return ((current / previous) - 1) * 100
}

const marketStats = computed(() => {
  const latest = props.history.at(-1)
  if (!latest) return []
  const previous = props.history.at(-2)
  const twentyDaysAgo = props.history.at(-21)
  const dayChange = changePct(latest.activeCapYi, previous?.activeCapYi)
  const twentyDayChange = changePct(
    latest.activeCapYi,
    twentyDaysAgo?.activeCapYi,
  )
  const referenceGap = changePct(
    latest.activeCapYi,
    latest.referenceMaYi ?? undefined,
  )

  return [
    {
      label: '最新 0AMV',
      value: formatYi(latest.activeCapYi),
      sub: latest.date,
      tone: '',
    },
    {
      label: '单日变化',
      value: formatPct(dayChange),
      sub: dayChange == null ? '缺少前一交易日' : dayChange >= 0 ? '活筹增加' : '活筹减少',
      tone: changeClass(dayChange),
    },
    {
      label: '20 日变化',
      value: formatPct(twentyDayChange),
      sub: twentyDayChange == null ? '历史不足' : twentyDayChange >= 0 ? '中期抬升' : '中期回落',
      tone: changeClass(twentyDayChange),
    },
    {
      label: '5 日参考线',
      value:
        referenceGap == null
          ? '—'
          : `${referenceGap >= 0 ? '上方' : '下方'} ${formatPct(Math.abs(referenceGap))}`,
      sub: referenceGap == null ? '参考线未形成' : referenceGap >= 0 ? '短期偏强' : '短期偏弱',
      tone: changeClass(referenceGap),
    },
    {
      label: '沪深两市成交额',
      value: formatYi(latest.marketAmountYi),
      sub: '上证综指 + 深证成指',
      tone: '',
    },
  ]
})

const option = computed<EChartsCoreOption>(() => {
  const history = props.history
  const dates = history.map((point) => point.date)
  const visibleStart = Math.max(0, dates.length - 250)
  const historyDates = new Set(dates)
  const events = props.events.filter((event) => historyDates.has(event.date))

  return {
    backgroundColor: 'transparent',
    color: ['#3d9cf0', '#f0b429', '#5eead4'],
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(18,24,32,0.96)',
      borderColor: 'rgba(148,163,184,0.2)',
      textStyle: { color: '#e8eef7', fontSize: 12 },
    },
    legend: {
      top: 0,
      textStyle: { color: '#93a4b8', fontSize: 12 },
    },
    grid: { left: 72, right: 72, top: 44, bottom: 70 },
    dataZoom: [
      {
        type: 'inside',
        startValue: visibleStart,
        endValue: Math.max(visibleStart, dates.length - 1),
      },
      {
        type: 'slider',
        height: 20,
        bottom: 16,
        startValue: visibleStart,
        endValue: Math.max(visibleStart, dates.length - 1),
        borderColor: 'rgba(148,163,184,0.15)',
        backgroundColor: 'rgba(15,23,42,0.35)',
        fillerColor: 'rgba(61,156,240,0.18)',
        textStyle: { color: '#6b7c90' },
      },
    ],
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: true,
      ...axisStyle,
      axisLabel: { ...axisStyle.axisLabel, formatter: (value: string) => value.slice(0, 7) },
    },
    yAxis: [
      {
        type: 'value',
        name: '0AMV 估算（亿元）',
        nameTextStyle: { color: '#6b7c90', fontSize: 11 },
        scale: true,
        ...axisStyle,
      },
      {
        type: 'value',
        name: '成交额（亿元）',
        nameTextStyle: { color: '#6b7c90', fontSize: 11 },
        splitLine: { show: false },
        axisLine: axisStyle.axisLine,
        axisLabel: axisStyle.axisLabel,
      },
    ],
    series: [
      {
        name: '0AMV 活筹估算',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: history.map((point) => point.activeCapYi),
        itemStyle: { color: '#3d9cf0' },
        lineStyle: { width: 2.4 },
        areaStyle: { color: 'rgba(61,156,240,0.10)' },
        markLine: events.length
          ? {
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
              data: events.map((event) => ({
                name: event.label,
                xAxis: event.date,
              })),
            }
          : undefined,
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
    ],
  }
})
</script>

<template>
  <div v-if="history.length === 0" class="state muted">暂无 0AMV 市场数据</div>
  <template v-else>
    <div class="market-stats" role="list" aria-label="0AMV 市场状态">
      <div v-for="stat in marketStats" :key="stat.label" class="market-stat" role="listitem">
        <div class="market-stat-label">{{ stat.label }}</div>
        <div class="market-stat-value mono" :class="stat.tone">{{ stat.value }}</div>
        <div class="market-stat-sub muted">{{ stat.sub }}</div>
      </div>
    </div>
    <p v-if="events.length" class="chart-note">
      金色虚线为汇金持有人报告期，估算规模期不会作为事件标记；报告期不等同于公告发布日期。
    </p>
    <BaseChart :option="option" height="420px" />
  </template>
</template>
