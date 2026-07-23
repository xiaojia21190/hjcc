<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot, HuijinPosition, HuijinEstimatePoint } from '../../shared/types'
import BaseChart from './BaseChart.vue'
import type { EChartsCoreOption } from 'echarts/core'

const props = withDefaults(
  defineProps<{
    etfs: EtfSnapshot[]
    metric?: 'percent' | 'shares' | 'value'
  }>(),
  { metric: 'percent' },
)

const axisStyle = {
  axisLine: { lineStyle: { color: 'rgba(148,163,184,0.25)' } },
  axisLabel: { color: '#93a4b8', fontSize: 11 },
  splitLine: { lineStyle: { color: 'rgba(148,163,184,0.08)' } },
}

const hasVerifiedPoint = computed(() =>
  props.etfs.some((etf) => etf.huijinHistory.length > 0),
)

interface SeriesItem {
  value: [string, number]
  estimated?: boolean
  clampTriggered?: boolean
}

function disclosedValue(h: HuijinPosition): number | null {
  if (props.metric === 'percent') return h.percent
  if (props.metric === 'shares') return h.shares / 1e8
  return h.marketValue != null ? h.marketValue / 1e8 : null
}

function anchoredValue(p: HuijinEstimatePoint): number | null {
  if (props.metric === 'percent') return p.huijinPct
  if (props.metric === 'shares')
    return p.huijinShares != null ? p.huijinShares / 1e8 : null
  return p.huijinValueYi
}

const option = computed<EChartsCoreOption>(() => {
  const palette = ['#3d9cf0', '#5eead4', '#f0b429', '#c084fc', '#f07178', '#7fd99a']
  const series: Record<string, unknown>[] = []

  props.etfs.forEach((e, i) => {
    const color = palette[i % palette.length]
    // 正式披露点（实线）
    series.push({
      name: e.categoryName,
      type: 'line',
      showSymbol: true,
      symbolSize: 7,
      lineStyle: { width: 2.2 },
      itemStyle: { color },
      data: e.huijinHistory
        .map((h) => {
          const v = disclosedValue(h)
          return v != null ? { value: [h.reportDate, v] } : null
        })
        .filter(Boolean),
    })
    // 份额锚定估算（虚线），从最近披露点桥接
    const anchored = e.huijinEstimateHistory.filter(
      (p) => p.estimateMethod === 'anchored',
    )
    if (anchored.length === 0) return
    const bridge: SeriesItem[] = []
    const last = e.huijinHistory[e.huijinHistory.length - 1]
    if (last) {
      const v = disclosedValue(last)
      if (v != null) bridge.push({ value: [last.reportDate, v] })
    }
    const estData = anchored
      .map((p) => {
        const v = anchoredValue(p)
        if (v == null) return null
        return {
          value: [p.date, v],
          estimated: true,
          clampTriggered: p.clampTriggered ?? false,
        } satisfies SeriesItem
      })
      .filter(Boolean) as SeriesItem[]
    series.push({
      name: e.categoryName,
      type: 'line',
      showSymbol: false,
      lineStyle: { width: 1.6, type: 'dashed' },
      itemStyle: { color },
      data: [...bridge, ...estData],
    })
  })

  const yName =
    props.metric === 'percent'
      ? '占比 %'
      : props.metric === 'shares'
        ? '份额（亿份）'
        : '估值（亿元）'
  const unit =
    props.metric === 'percent' ? '%' : props.metric === 'shares' ? ' 亿份' : ' 亿元'

  return {
    backgroundColor: 'transparent',
    color: palette,
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(18,24,32,0.95)',
      borderColor: 'rgba(148,163,184,0.2)',
      textStyle: { color: '#e8eef7', fontSize: 12 },
      formatter: (params: unknown) => {
        const list = params as {
          seriesName: string
          marker: string
          value: [string, number] | null
          data: SeriesItem | null
        }[]
        if (!Array.isArray(list) || list.length === 0) return ''
        const date = String(list[0].value?.[0] ?? '').slice(0, 10)
        const seen = new Set<string>()
        let html = `<div style="font-weight:600;margin-bottom:4px">${date}</div>`
        for (const p of list) {
          const raw = Array.isArray(p.value) ? p.value[1] : null
          if (raw == null || seen.has(p.seriesName)) continue
          seen.add(p.seriesName)
          const suffix = p.data?.estimated
            ? p.data.clampTriggered
              ? ' · 估算 ⚠ clamp'
              : ' · 份额锚定估算'
            : ''
          html += `<div>${p.marker}${p.seriesName}: ${Number(raw).toFixed(2)}${unit}${suffix}</div>`
        }
        return html
      },
    },
    legend: {
      top: 0,
      textStyle: { color: '#93a4b8', fontSize: 12 },
    },
    grid: { left: 52, right: 20, top: 40, bottom: 36 },
    xAxis: {
      type: 'time',
      ...axisStyle,
    },
    yAxis: {
      type: 'value',
      name: yName,
      nameTextStyle: { color: '#6b7c90', fontSize: 11 },
      ...axisStyle,
    },
    series,
  }
})
</script>

<template>
  <p v-if="hasVerifiedPoint" class="chart-note">
    实点为基金年报/半年报「十大持有人」正式披露；最近披露期之后的虚线为份额锚定估算（假设汇金不主动赎回，tooltip 中 ⚠ 表示总份额已低于披露汇金份额）。
  </p>
  <p v-else class="chart-note">
    当前没有可验证的汇金持仓披露，暂不绘制持仓趋势。
  </p>
  <BaseChart :option="option" height="360px" />
</template>
