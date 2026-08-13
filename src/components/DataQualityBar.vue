<script setup lang="ts">
import { computed } from 'vue'
import type { DashboardData } from '../../shared/types'
import { estimateRangeYi } from '../utils/estimateDisplay'

const props = defineProps<{
  data: DashboardData
}>()

type QualityTone = 'ok' | 'partial' | 'warn'

function marketSourceLabel(source?: string): string {
  switch (source) {
    case 'eastmoney-history':
      return '东财历史日线'
    case 'tushare-history':
      return 'Tushare 历史日线'
    case 'latest-snapshot':
      return '东财最新快照'
    case 'cache':
      return '上次缓存'
    default:
      return '旧快照（来源未记录）'
  }
}

const items = computed(() => {
  const etfs = props.data.etfs
  const total = etfs.length
  const latestMarket = props.data.marketActiveCapHistory.at(-1)
  const latestEtfDate = etfs
    .map((etf) => etf.navHistory.at(-1)?.date)
    .filter((date): date is string => !!date)
    .sort()
    .at(-1)
  const latestSectorDate = props.data.sectorTrend?.dates.at(-1)
  const latestReferenceDate = [latestEtfDate, latestSectorDate]
    .filter((date): date is string => !!date)
    .sort()
    .at(-1)
  const marketDateLag =
    latestMarket != null &&
    latestReferenceDate != null &&
    latestMarket.date < latestReferenceDate
  const marketQuality = props.data.marketActiveCapQuality
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
  const sortedShareDates = [...dailyShareDates].sort()
  const latestDailyShareDate = sortedShareDates.at(-1) ?? null
  const earliestDailyShareDate = sortedShareDates[0] ?? null
  // 个别 ETF（如深交所）官方份额发布滞后时，最新日期会掩盖差异，需如实暴露
  const shareDateLag =
    latestDailyShareDate != null &&
    earliestDailyShareDate != null &&
    earliestDailyShareDate !== latestDailyShareDate
  const disclosed = etfs.filter((etf) => etf.latestHuijin != null).length
  const cached = etfs.filter((etf) => etf.source.holdersFromCache).length
  const anchoredEtfs = etfs.filter((etf) =>
    etf.huijinEstimateHistory.some((p) => p.estimateMethod === 'anchored'),
  )
  const lowResEtfs = anchoredEtfs.filter((etf) => {
    const last = [...etf.huijinEstimateHistory]
      .reverse()
      .find((p) => p.estimateMethod === 'anchored')
    return estimateRangeYi(last)?.lowResolution
  })

  return [
    {
      label: '0AMV 日线',
      status: !latestMarket
        ? '缺失'
        : marketQuality?.isPartial
          ? '临时快照'
          : marketDateLag
            ? '日期滞后'
            : '正常',
      detail: latestMarket
        ? [
            `${latestMarket.date} · ${props.data.marketActiveCapHistory.length} 个交易日`,
            marketSourceLabel(marketQuality?.source),
            marketDateLag ? `其他数据至 ${latestReferenceDate}` : null,
            marketQuality?.warning,
          ]
            .filter((part): part is string => !!part)
            .join(' · ')
        : '没有可用市场序列',
      tone: (!latestMarket
        ? 'warn'
        : marketQuality?.isPartial || marketDateLag
          ? 'partial'
          : 'ok') as QualityTone,
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
      detail: shareDateLag
        ? `${dailyShareCovered}/${total} 只 · 最新 ${latestDailyShareDate} · 个别滞后至 ${earliestDailyShareDate}`
        : `${dailyShareCovered}/${total} 只 · 最新 ${latestDailyShareDate ?? '—'}`,
      tone: (dailyShareCovered === total && !shareDateLag ? 'ok' : 'partial') as QualityTone,
    },
    {
      label: '汇金披露',
      status: disclosed === total ? '完整' : '待补充',
      detail: `${disclosed}/${total} 只 · 缓存沿用 ${cached} 只`,
      tone: (disclosed === total ? 'ok' : 'partial') as QualityTone,
    },
    {
      label: '持仓估算',
      status:
        anchoredEtfs.length === 0
          ? '未启用'
          : lowResEtfs.length > 0
            ? '部分低分辨'
            : '估算中',
      detail:
        anchoredEtfs.length === 0
          ? '无汇金披露锚点，不生成估算'
          : lowResEtfs.length > 0
            ? `占比区间 ${anchoredEtfs.length}/${total} 只 · ${lowResEtfs.length} 只区间过宽（≥30% 总份额）`
            : `占比区间 ${anchoredEtfs.length}/${total} 只 · 点估计可用`,
      tone: (anchoredEtfs.length === 0
        ? 'warn'
        : lowResEtfs.length > 0
          ? 'partial'
          : 'ok') as QualityTone,
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
