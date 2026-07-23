<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot } from '../../shared/types'
import { formatPct, formatShares, formatYi, yuanToYi } from '../utils/format'

const props = defineProps<{
  etfs: EtfSnapshot[]
  totalMv?: number | null
  activeCapYi?: number | null
  activeCapDate?: string | null
  latestReport?: string | null
  updatedAt?: string
}>()

const cards = computed(() => {
  const estimates = props.etfs
    .map((etf) => ({ etf, point: etf.huijinEstimateHistory.at(-1) }))
    .filter(({ point }) => point?.huijinValueYi != null)
  const avgPct =
    estimates.length > 0
      ? estimates.reduce((s, { point }) => s + (point?.huijinPct ?? 0), 0) /
        estimates.length
      : null
  const totalShares = estimates.reduce(
    (s, { point }) => s + (point?.huijinShares ?? 0),
    0,
  )
  const latestScaleDate = props.etfs
    .map((etf) => etf.scaleHistory.at(-1)?.date)
    .filter((date): date is string => !!date)
    .sort()
    .at(-1)
  return [
    {
      label: '汇金估算合计市值',
      value: yuanToYi(props.totalMv ?? null),
      sub: latestScaleDate
        ? `规模期 ${latestScaleDate} · 可估算 ${estimates.length}/${props.etfs.length} 只`
        : '暂无规模期',
      accent: 'gold',
    },
    {
      label: '0AMV 活筹估算',
      value: formatYi(props.activeCapYi ?? null),
      sub: props.activeCapDate
        ? `交易日 ${props.activeCapDate} · 沪深成交额口径`
        : '暂无沪深市场 0AMV 数据',
      accent: 'blue',
    },
    {
      label: '汇金估算合计份额',
      value: formatShares(totalShares),
      sub: '按最近公开持有人披露锚定估算',
      accent: 'teal',
    },
    {
      label: '监测 ETF / 平均占比',
      value: `${props.etfs.length} 只`,
      sub: `可估算 ${estimates.length} 只 · 平均 ${formatPct(avgPct)}`,
      accent: 'purple',
    },
  ]
})
</script>

<template>
  <section class="summary">
    <div
      v-for="c in cards"
      :key="c.label"
      class="card summary-card"
      :data-accent="c.accent"
    >
      <div class="label">{{ c.label }}</div>
      <div class="value mono">{{ c.value }}</div>
      <div class="sub muted">{{ c.sub }}</div>
    </div>
  </section>
</template>
