<script setup lang="ts">
import { computed } from 'vue'
import type { MarketActiveCapPoint, MarketReportEvent } from '../../shared/types'
import BaseChart from './BaseChart.vue'
import { changeClass, formatPct, formatYi } from '../utils/format'
import { computeMacd } from '../utils/macd'
import { computeKdj, kdjSignal } from '../utils/kdj'
import { buildActiveCapChartOption } from '../utils/activeCapChartOption'

const props = withDefaults(
  defineProps<{
    history?: MarketActiveCapPoint[]
    events?: MarketReportEvent[]
  }>(),
  { history: () => [], events: () => [] },
)

function changePct(current: number, previous?: number): number | null {
  if (previous == null || previous === 0) return null
  return ((current / previous) - 1) * 100
}

function macdSignal(
  current?: { dif: number; dea: number },
  previous?: { dif: number; dea: number },
): string {
  if (current == null) return '数据不足'
  if (previous != null && previous.dif < previous.dea && current.dif >= current.dea) {
    return '金叉'
  }
  if (previous != null && previous.dif >= previous.dea && current.dif < current.dea) {
    return '死叉'
  }
  return current.dif >= current.dea ? '多头' : '空头'
}

const values = computed(() => props.history.map((point) => point.activeCapYi))
const macd = computed(() => computeMacd(values.value))
const kdj = computed(() => computeKdj(values.value))

const marketStats = computed(() => {
  const latest = props.history.at(-1)
  if (!latest) return []
  const previous = props.history.at(-2)
  const twentyDaysAgo = props.history.at(-21)
  const dayChange = changePct(latest.activeCapYi, previous?.activeCapYi)
  const twentyDayChange = changePct(latest.activeCapYi, twentyDaysAgo?.activeCapYi)
  const referenceGap = changePct(latest.activeCapYi, latest.referenceMaYi ?? undefined)
  const macdLatest = macd.value.at(-1)
  const kdjLatest = kdj.value.at(-1)

  return [
    {
      label: '最新 0AMV',
      value: formatYi(latest.activeCapYi),
      sub: latest.date,
      tone: '',
    },
    {
      label: '单日变化',
      value: formatPct(dayChange),
      sub: dayChange == null ? '缺少前一交易日' : dayChange >= 0 ? '活筹增加' : '活筹减少',
      tone: changeClass(dayChange),
    },
    {
      label: '20 日变化',
      value: formatPct(twentyDayChange),
      sub: twentyDayChange == null ? '历史不足' : twentyDayChange >= 0 ? '中期抬升' : '中期回落',
      tone: changeClass(twentyDayChange),
    },
    {
      label: '5 日参考线',
      value:
        referenceGap == null
          ? '—'
          : `${referenceGap >= 0 ? '上方' : '下方'} ${formatPct(Math.abs(referenceGap))}`,
      sub: referenceGap == null ? '参考线未形成' : referenceGap >= 0 ? '短期偏强' : '短期偏弱',
      tone: changeClass(referenceGap),
    },
    {
      label: 'MACD(12,26,9)',
      value: macdLatest == null ? '—' : macdLatest.macd.toFixed(2),
      sub: macdSignal(macdLatest, macd.value.at(-2)),
      tone: macdLatest == null ? '' : changeClass(macdLatest.macd),
    },
    {
      label: 'KDJ(9,3,3)',
      value:
        kdjLatest == null ? '—' : `${kdjLatest.k.toFixed(1)} / ${kdjLatest.d.toFixed(1)}`,
      sub:
        kdjLatest == null
          ? '数据不足'
          : `J ${kdjLatest.j.toFixed(1)} · ${kdjSignal(kdjLatest, kdj.value.at(-2))}`,
      tone: kdjLatest == null ? '' : changeClass(kdjLatest.k - kdjLatest.d),
    },
  ]
})

const option = computed(() =>
  buildActiveCapChartOption(props.history, props.events, macd.value, kdj.value),
)
</script>

<template>
  <div v-if="history.length === 0" class="state muted">暂无 0AMV 市场数据</div>
  <template v-else>
    <div class="market-stats" role="list" aria-label="0AMV 市场状态">
      <div v-for="stat in marketStats" :key="stat.label" class="market-stat" role="listitem">
        <div class="market-stat-label">{{ stat.label }}</div>
        <div class="market-stat-value mono" :class="stat.tone">{{ stat.value }}</div>
        <div class="market-stat-sub muted">{{ stat.sub }}</div>
      </div>
    </div>
    <p v-if="events.length" class="chart-note">
      金色虚线仅标记汇金持有人报告期；报告期不等同于公告发布日期。
    </p>
    <p class="chart-note muted">
      KDJ 用 0AMV 自身滚动高低点近似 RSV，不是个股 OHLC 口径；虚线为 20 / 50 / 80。
    </p>
    <BaseChart :option="option" height="520px" />
  </template>
</template>
