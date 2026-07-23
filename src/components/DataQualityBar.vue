<script setup lang="ts">
import { computed } from 'vue'
import type { DashboardData } from '../../shared/types'

const props = defineProps<{
  data: DashboardData
}>()

type QualityTone = 'ok' | 'partial' | 'warn'

const items = computed(() => {
  const etfs = props.data.etfs
  const total = etfs.length
  const latestMarket = props.data.marketActiveCapHistory.at(-1)
  const quoteCount = etfs.filter(
    (etf) => etf.quote?.price != null && etf.quote.marketCap != null,
  ).length
  const scaleCovered = etfs.filter((etf) => etf.scaleHistory.length > 0).length
  const scaleDates = etfs
    .map((etf) => etf.scaleHistory.at(-1)?.date)
    .filter((date): date is string => !!date)
  const latestScaleDate = scaleDates.sort().at(-1) ?? null
  const disclosed = etfs.filter((etf) => etf.latestHuijin != null).length
  const cached = etfs.filter((etf) => etf.source.holdersFromCache).length
  const unavailable = etfs.filter(
    (etf) => etf.huijinEstimateHistory.at(-1)?.unavailableReason,
  ).length

  return [
    {
      label: '0AMV 日线',
      status: latestMarket ? '正常' : '缺失',
      detail: latestMarket
        ? `${latestMarket.date} · ${props.data.marketActiveCapHistory.length} 个交易日`
        : '没有可用市场序列',
      tone: (latestMarket ? 'ok' : 'warn') as QualityTone,
    },
    {
      label: 'ETF 行情',
      status: quoteCount === total ? '完整' : '部分可用',
      detail: `${quoteCount}/${total} 只具备价格与市值`,
      tone: (quoteCount === total ? 'ok' : 'partial') as QualityTone,
    },
    {
      label: '规模披露',
      status: scaleCovered === total ? '完整' : '部分可用',
      detail: `${scaleCovered}/${total} 只 · 最新 ${latestScaleDate ?? '—'}`,
      tone: (scaleCovered === total ? 'ok' : 'partial') as QualityTone,
    },
    {
      label: '汇金披露',
      status: disclosed === total ? '完整' : '待补充',
      detail: `${disclosed}/${total} 只 · 缓存沿用 ${cached} 只`,
      tone: (disclosed === total ? 'ok' : 'partial') as QualityTone,
    },
    {
      label: '估算校验',
      status: unavailable === 0 ? '通过' : '待新披露',
      detail: unavailable === 0 ? '最新规模期均可估算' : `${unavailable} 只超出可靠估算范围`,
      tone: (unavailable === 0 ? 'ok' : 'warn') as QualityTone,
    },
  ]
})
</script>

<template>
  <section class="card quality-panel" aria-labelledby="data-quality-title">
    <div class="quality-head">
      <div>
        <h2 id="data-quality-title">数据质量</h2>
        <p class="muted">区分实时行情、定期披露、缓存快照与估算可用性</p>
      </div>
      <span class="pill mono">快照 {{ data.updatedAt.slice(0, 10) }}</span>
    </div>
    <div class="quality-grid" role="list">
      <div v-for="item in items" :key="item.label" class="quality-item" role="listitem">
        <div class="quality-label">{{ item.label }}</div>
        <div class="quality-status" :data-tone="item.tone">
          <span class="quality-dot" aria-hidden="true"></span>
          <span>{{ item.status }}</span>
        </div>
        <div class="quality-detail muted">{{ item.detail }}</div>
      </div>
    </div>
  </section>
</template>
