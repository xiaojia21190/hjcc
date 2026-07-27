<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot } from '../../shared/types'
import { formatPct, formatShares, formatYi, yuanToYi } from '../utils/format'
import { aggregateShareSignals } from '../utils/signals'

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
  // 各 ETF 估算末日可能不同（如深交所 ETF 滞后），用日期区间如实标注合计口径
  const estDates = latestAnchored.map((p) => p.date).sort()
  const estDateMin = estDates[0] ?? null
  const estDateMax = estDates[estDates.length - 1] ?? null
  const estDateLabel =
    estDateMin == null
      ? null
      : estDateMin === estDateMax
        ? estDateMin
        : `${estDateMin} ~ ${estDateMax}`
  // 份额信号聚合：各 ETF 最新 anchored 点的趋势信号
  const signalPoints = props.etfs
    .map((etf) => {
      const pts = etf.huijinEstimateHistory.filter(
        (p) => p.estimateMethod === 'anchored',
      )
      const last = pts.length > 0 ? pts[pts.length - 1] : null
      if (!last || last.shareTrend == null) return null
      return {
        shareTrend: last.shareTrend,
        consecutiveDays: last.consecutiveDays ?? 1,
        shareChangePct5d: last.shareChangePct5d ?? null,
        categoryName: etf.categoryName,
      }
    })
    .filter((p): p is NonNullable<typeof p> => p != null)
  const signal = aggregateShareSignals(signalPoints)
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
      label: '份额信号（汇金方向参考）',
      value: signal.headline,
      sub:
        [signal.highlightConsecutive, signal.highlightChange]
          .filter(Boolean)
          .join(' · ') || '无汇金披露锚点，暂不生成信号',
      accent:
        signal.tone === 'inflow'
          ? 'teal'
          : signal.tone === 'outflow'
            ? 'red'
            : 'orange',
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
      label: '汇金估算持仓（区间中值）',
      value: latestAnchored.length > 0 ? formatYi(estTotalYi) : '—',
      sub: estDateLabel
        ? `纳入 ${latestAnchored.length}/${props.etfs.length} 只 · 估算日 ${estDateLabel} · 仅供方向参考`
        : '无估算锚点',
      accent: 'orange',
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
