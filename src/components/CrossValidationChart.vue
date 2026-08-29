<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EtfSnapshot, MarketActiveCapPoint } from '../../shared/types'
import BaseChart from './BaseChart.vue'
import type { EChartsCoreOption } from 'echarts/core'
import { activeCapCorrelation } from '../utils/activeCapStats'

const props = withDefaults(
  defineProps<{
    etfs?: EtfSnapshot[]
    marketHistory?: MarketActiveCapPoint[]
  }>(),
  { etfs: () => [], marketHistory: () => [] },
)

const window = ref<60 | 120>(60)

const palette = ['#3d9cf0', '#5eead4', '#f0b429', '#c084fc', '#f07178', '#7fd99a']

/** 汇总各 ETF 近 5 日份额变化率（亿份口径，用于和 0AMV 日变化做秩相关） */
function basketShareChange(etfs: EtfSnapshot[]): { date: string; value: number }[] {
  const byDate = new Map<string, { sum: number; n: number }>()
  for (const etf of etfs) {
    const daily = etf.scaleHistory.filter((p) => p.frequency === 'daily')
    for (let i = 5; i < daily.length; i++) {
      const cur = daily[i]
      const base = daily[i - 5]
      const delta = cur.totalSharesYi - base.totalSharesYi
      const entry = byDate.get(cur.date) ?? { sum: 0, n: 0 }
      entry.sum += delta
      entry.n += 1
      byDate.set(cur.date, entry)
    }
  }
  return [...byDate.entries()]
    .filter(([, entry]) => entry.n >= 2)
    .map(([date, entry]) => ({ date, value: entry.sum / entry.n }))
}

/** 0AMV 单日变化（亿元口径） */
function amvDailyChange(history: MarketActiveCapPoint[]): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = []
  for (let i = 1; i < history.length; i++) {
    out.push({ date: history[i].date, value: history[i].activeCapYi - history[i - 1].activeCapYi })
  }
  return out
}

const correlations = computed(() => {
  if (props.marketHistory.length === 0 || props.etfs.length === 0) return null
  const share = basketShareChange(props.etfs)
  const amv = amvDailyChange(props.marketHistory)
  const corr60 = activeCapCorrelation(props.marketHistory, share, 60)
  const corr120 = activeCapCorrelation(props.marketHistory, share, 120)
  return { corr60, corr120, share, amv }
})

function corrText(value: number | null): { text: string; tone: string } {
  if (value == null) return { text: '样本不足', tone: 'muted' }
  const strength = Math.abs(value) >= 0.6 ? '较强' : Math.abs(value) >= 0.3 ? '中等' : '较弱'
  const dir = value > 0 ? '正相关' : value < 0 ? '负相关' : '无相关'
  return {
    text: `r=${value >= 0 ? '+' : ''}${value.toFixed(2)}（${dir}，${strength}）`,
    tone: Math.abs(value) >= 0.6 ? (value > 0 ? 'up' : 'down') : 'muted',
  }
}

const option = computed<EChartsCoreOption>(() => {
  const c = correlations.value
  if (!c) return {}
  const n = window.value
  const amvTail = c.amv.slice(-n)
  const shareTail = c.share.slice(-n)
  return {
    backgroundColor: 'transparent',
    color: ['#3d9cf0', '#5eead4'],
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(18,24,32,0.96)',
      borderColor: 'rgba(148,163,184,0.2)',
      textStyle: { color: '#e8eef7', fontSize: 12 },
    },
    legend: { top: 0, textStyle: { color: '#93a4b8', fontSize: 11 } },
    grid: [
      { left: 72, right: 72, top: 40, height: '40%' },
      { left: 72, right: 72, top: '58%', height: '30%' },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1] },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        height: 18,
        bottom: 8,
        borderColor: 'rgba(148,163,184,0.15)',
        fillerColor: 'rgba(61,156,240,0.18)',
        textStyle: { color: '#6b7c90', fontSize: 10 },
      },
    ],
    xAxis: [
      { type: 'category', data: amvTail.map((p) => p.date), axisLabel: { color: '#93a4b8', fontSize: 11 } },
      { type: 'category', data: shareTail.map((p) => p.date), gridIndex: 1, axisLabel: { show: false } },
    ],
    yAxis: [
      { type: 'value', name: '0AMV 单日变化（亿元）', nameTextStyle: { color: '#6b7c90', fontSize: 11 }, axisLabel: { color: '#93a4b8' }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.08)' } } },
      { type: 'value', name: '篮子份额 5 日变化（亿份）', gridIndex: 1, nameTextStyle: { color: '#6b7c90', fontSize: 11 }, axisLabel: { color: '#93a4b8' }, splitLine: { show: false } },
    ],
    series: [
      {
        name: '0AMV 单日变化',
        type: 'bar',
        data: amvTail.map((p) => ({
          value: p.value,
          itemStyle: { color: p.value >= 0 ? 'rgba(61,156,240,0.55)' : 'rgba(248,113,113,0.55)' },
        })),
        barMaxWidth: 10,
      },
      {
        name: '篮子份额 5 日变化',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        showSymbol: false,
        smooth: true,
        data: shareTail.map((p) => p.value),
        itemStyle: { color: '#5eead4' },
        lineStyle: { width: 1.8 },
      },
    ],
  }
})
</script>

<template>
  <div v-if="!correlations" class="state muted">0AMV 或 ETF 份额数据不足，暂不绘制交叉验证</div>
  <template v-else>
    <div class="panel-head" style="margin-bottom: 8px">
      <div>
        <p class="muted">
          上：0AMV 活筹单日变化（亿元）；下：六只宽基 ETF 份额 5 日变化（亿份，等权平均）。
          秩相关衡量"市场活筹抬升时 ETF 份额是否同步扩张"，不识别持有人、不构成因果。
        </p>
      </div>
      <div class="seg">
        <button :class="{ on: window === 60 }" @click="window = 60">近 60 日</button>
        <button :class="{ on: window === 120 }" @click="window = 120">近 120 日</button>
      </div>
    </div>
    <div class="cross-corr-row" role="list">
      <div class="cross-corr" role="listitem">
        <span class="muted">60 日秩相关</span>
        <strong :class="corrText(correlations.corr60).tone" class="mono">{{ corrText(correlations.corr60).text }}</strong>
      </div>
      <div class="cross-corr" role="listitem">
        <span class="muted">120 日秩相关</span>
        <strong :class="corrText(correlations.corr120).tone" class="mono">{{ corrText(correlations.corr120).text }}</strong>
      </div>
    </div>
    <BaseChart :option="option" height="420px" />
  </template>
</template>

<style scoped>
.cross-corr-row {
  display: flex;
  gap: 24px;
  margin-bottom: 8px;
}
.cross-corr {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}
.cross-corr .muted {
  font-size: 12px;
}
</style>
