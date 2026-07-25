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
  const disclosures = props.etfs
    .map((etf) => etf.latestHuijin)
    .filter((point): point is NonNullable<typeof point> => point != null)
  const avgPct =
    disclosures.length > 0
      ? disclosures.reduce((sum, point) => sum + point.percent, 0) /
        disclosures.length
      : null
  const totalShares = disclosures.reduce(
    (sum, point) => sum + point.shares,
    0,
  )
  const latestAnchored = props.etfs
    .map((etf) => {
      const pts = etf.huijinEstimateHistory.filter(
        (p) => p.estimateMethod === 'anchored',
      )
      return pts.length > 0 ? pts[pts.length - 1] : null
    })
    .filter((p): p is NonNullable<typeof p> => p != null)
  const estTotalYi = latestAnchored.reduce(
    (sum, p) => sum + (p.huijinValueYi ?? 0),
    0,
  )
  const estDate = latestAnchored.length > 0 ? latestAnchored[0].date : null
  return [
    {
      label: '汇金最近披露合计估值',
      value: yuanToYi(props.totalMv ?? null),
      sub: props.latestReport
        ? `最近报告期 ${props.latestReport} · 已披露 ${disclosures.length}/${props.etfs.length} 只`
        : '暂无汇金持仓披露',
      accent: 'gold',
    },
    {
      label: '汇金估算合计持仓',
      value: latestAnchored.length > 0 ? formatYi(estTotalYi) : '—',
      sub: estDate
        ? `估算日 ${estDate} · 占比区间估算`
        : '无估算锚点',
      accent: 'orange',
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
      label: '汇金最近披露合计份额',
      value: formatShares(totalShares),
      sub: '各基金最新公开持有人报告合计',
      accent: 'teal',
    },
    {
      label: '监测 ETF / 平均占比',
      value: `${props.etfs.length} 只`,
      sub: `已披露 ${disclosures.length} 只 · 披露占比平均 ${formatPct(avgPct)}`,
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
