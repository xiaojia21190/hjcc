<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot } from '../../shared/types'
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

const option = computed<EChartsCoreOption>(() => {
  const palette = ['#3d9cf0', '#5eead4', '#f0b429', '#c084fc', '#f07178', '#7fd99a']
  const dateSet = new Set<string>()
  for (const e of props.etfs) {
    for (const h of e.huijinHistory) dateSet.add(h.reportDate)
  }
  const dates = [...dateSet].sort()

  const series = props.etfs.map((e, i) => {
    const map = new Map(e.huijinHistory.map((h) => [h.reportDate, h] as const))
    const data = dates.map((d) => {
      const h = map.get(d)
      if (!h) return null
      const value =
        props.metric === 'percent'
          ? h.percent
          : props.metric === 'shares'
            ? h.shares / 1e8
            : h.marketValue != null
              ? h.marketValue / 1e8
              : null
      if (value == null) return null
      return value
    })
    return {
      name: e.categoryName,
      type: 'line' as const,
      smooth: false,
      showSymbol: true,
      symbolSize: 7,
      lineStyle: { width: 2.2 },
      itemStyle: { color: palette[i % palette.length] },
      data,
    }
  })

  const yName =
    props.metric === 'percent'
      ? '占比 %'
      : props.metric === 'shares'
        ? '份额（亿份）'
        : '披露估值（亿元）'

  return {
    backgroundColor: 'transparent',
    color: palette,
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(18,24,32,0.95)',
      borderColor: 'rgba(148,163,184,0.2)',
      textStyle: { color: '#e8eef7', fontSize: 12 },
    },
    legend: {
      top: 0,
      textStyle: { color: '#93a4b8', fontSize: 12 },
    },
    grid: { left: 52, right: 20, top: 40, bottom: 36 },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
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
    仅展示基金年报/半年报十大持有人报告期；报告期之后不按 ETF 总份额外推汇金当前持仓。
  </p>
  <p v-else class="chart-note">
    当前没有可验证的汇金持仓披露，暂不绘制持仓趋势。
  </p>
  <BaseChart :option="option" height="360px" />
</template>
