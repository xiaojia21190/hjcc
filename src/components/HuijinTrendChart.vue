<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot, HuijinPosition, HuijinEstimatePoint } from '../../shared/types'
import BaseChart from './BaseChart.vue'
import type { EChartsCoreOption } from 'echarts/core'
import { estimateRangeYi, formatEstimateSharesRange } from '../utils/estimateDisplay'

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
  shareTrend?: 'inflow' | 'outflow' | 'flat'
  consecutiveDays?: number
  shareChangePct5d?: number | null
  rangeLabel?: string | null
  lowResolution?: boolean
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
    // 正式披露点（散点，不连线）：趋势图只锚定最新一期披露，
    // 更早的历史披露在详情面板展示，避免稀疏历史点撑出空白时间轴。
    const lastH = e.huijinHistory[e.huijinHistory.length - 1]
    const lastV = lastH ? disclosedValue(lastH) : null
    series.push({
      name: e.categoryName,
      type: 'scatter',
      symbolSize: 10,
      itemStyle: { color },
      data: lastV != null ? [{ value: [lastH!.reportDate, lastV] }] : [],
    })
    // 占比区间估算（虚线），从最近披露点桥接
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
        const range = estimateRangeYi(p)
        return {
          value: [p.date, v],
          estimated: true,
          shareTrend: p.shareTrend,
          consecutiveDays: p.consecutiveDays,
          shareChangePct5d: p.shareChangePct5d ?? null,
          rangeLabel: range ? formatEstimateSharesRange(range) : null,
          lowResolution: range?.lowResolution ?? false,
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
    // 份额 5 日变化率次轴曲线
    const changeData = anchored
      .map((p) =>
        p.shareChangePct5d != null
          ? { value: [p.date, p.shareChangePct5d], itemStyle: { color } }
          : null,
      )
      .filter(Boolean) as { value: [string, number]; itemStyle: { color: string } }[]
    if (changeData.length) {
      series.push({
        name: `${e.categoryName} 份额变化率`,
        type: 'line',
        yAxisIndex: 1,
        showSymbol: false,
        lineStyle: { width: 1, opacity: 0.5 },
        itemStyle: { color },
        data: changeData,
        tooltip: { show: false },
      } as Record<string, unknown>)
    }
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
          let suffix = ''
          if (p.data?.estimated) {
            const d = p.data
            const parts: string[] = ['占比区间估算']
            if (d.rangeLabel) parts.push(d.rangeLabel)
            if (d.lowResolution) parts.push('低分辨')
            if (d.shareTrend && d.shareTrend !== 'flat' && d.consecutiveDays) {
              const dir = d.shareTrend === 'inflow' ? '总份额净流入' : '总份额净流出'
              parts.push(`连续${d.consecutiveDays}日${dir}`)
            }
            if (d.shareChangePct5d != null) {
              parts.push(`总份额5日${d.shareChangePct5d > 0 ? '+' : ''}${d.shareChangePct5d}%`)
            }
            suffix = ' · ' + parts.join(' / ')
          }
          html += `<div>${p.marker}${p.seriesName}: ${Number(raw).toFixed(2)}${unit}${suffix}</div>`
        }
        return html
      },
    },
    legend: {
      top: 0,
      type: 'scroll',
      data: props.etfs.map((e) => e.categoryName),
      textStyle: { color: '#93a4b8', fontSize: 12 },
    },
    grid: { left: 52, right: 56, top: 56, bottom: 36 },
    xAxis: {
      type: 'time',
      ...axisStyle,
    },
    yAxis: [
      {
        type: 'value',
        name: yName,
        nameTextStyle: { color: '#6b7c90', fontSize: 11 },
        ...axisStyle,
      },
      {
        type: 'value',
        name: '5日份额变化率 %',
        nameTextStyle: { color: '#6b7c90', fontSize: 11 },
        ...axisStyle,
        splitLine: { show: false },
      },
    ],
    series,
  }
})
</script>

<template>
  <p v-if="hasVerifiedPoint" class="chart-note">
    实点为基金年报/半年报「十大持有人」正式披露；虚线为占比区间估算的加权展示点（下界 2/3 + 上界 1/3，非中值；tooltip 含 floor~ceil）。下界=份额变动全归因汇金，上界=披露占比不变。次轴细线为近 5 日<strong>ETF 总份额</strong>变化率，不能识别持有人，不代表汇金操作。
  </p>
  <p v-else class="chart-note">
    当前没有可验证的汇金持仓披露，暂不绘制持仓趋势。
  </p>
  <BaseChart :option="option" height="360px" />
</template>
