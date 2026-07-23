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
  const dailyShareCovered = etfs.filter((etf) =>
    etf.scaleHistory.some((point) => point.frequency === 'daily'),
  ).length
  const dailyShareDates = etfs
    .map((etf) =>
      etf.scaleHistory.filter((point) => point.frequency === 'daily').at(-1)?.date,
    )
    .filter((date): date is string => !!date)
  const latestDailyShareDate = dailyShareDates.sort().at(-1) ?? null
  const disclosed = etfs.filter((etf) => etf.latestHuijin != null).length
  const cached = etfs.filter((etf) => etf.source.holdersFromCache).length

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
      label: 'ETF 日份额',
      status: dailyShareCovered === total ? '完整' : '部分可用',
      detail: `${dailyShareCovered}/${total} 只 · 最新 ${latestDailyShareDate ?? '—'}`,
      tone: (dailyShareCovered === total ? 'ok' : 'partial') as QualityTone,
    },
    {
      label: '汇金披露',
      status: disclosed === total ? '完整' : '待补充',
      detail: `${disclosed}/${total} 只 · 缓存沿用 ${cached} 只`,
      tone: (disclosed === total ? 'ok' : 'partial') as QualityTone,
    },
    {
      label: '持仓外推',
      status: '已关闭',
      detail: '非报告期不根据 ETF 份额推算汇金持仓',
      tone: 'ok' as QualityTone,
    },
  ]
})
</script>

<template>
  <section class="card quality-panel" aria-labelledby="data-quality-title">
    <div class="quality-head">
      <div>
        <h2 id="data-quality-title">数据质量</h2>
        <p class="muted">区分实时行情、官方日份额、持仓披露与未知区间</p>
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
