<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CiticPositionPoint, MarketActiveCapPoint, MarketReportEvent } from '../../shared/types'
import BaseChart from './BaseChart.vue'
import { changeClass, formatPct, formatYi } from '../utils/format'
import { computeMacd } from '../utils/macd'
import { computeKdj, kdjSignal } from '../utils/kdj'
import { buildActiveCapChartOption } from '../utils/activeCapChartOption'
import { resampleActiveCap, type Timeframe } from '../utils/activeCapResample'
import { activeCapPercentile } from '../utils/activeCapStats'

const props = withDefaults(
  defineProps<{
    history?: MarketActiveCapPoint[]
    events?: MarketReportEvent[]
    citicHistory?: CiticPositionPoint[]
  }>(),
  { history: () => [], events: () => [], citicHistory: () => [] },
)

const timeframe = ref<Timeframe>('daily')
const TIMEFRAME_LABEL: Record<Timeframe, string> = { daily: '日', weekly: '周', monthly: '月' }

/** 交易日近似换算：周 ≈ 5 个交易日，月 ≈ 21 个交易日 */
const LOOKBACK_DAYS: Record<Timeframe, { bars: number; unit: string }> = {
  daily: { bars: 20, unit: '日' },
  weekly: { bars: 4, unit: '周' },
  monthly: { bars: 2, unit: '月' },
}

const visible = computed(() => resampleActiveCap(props.history, timeframe.value))
const events = computed(() => props.events.filter((event) => visible.value.some((point) => point.date === event.date)))
const barCount = computed(() => Math.max(1, visible.value.length - 1))

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

const values = computed(() => visible.value.map((point) => point.activeCapYi))
const macd = computed(() => computeMacd(values.value))
const kdj = computed(() => computeKdj(values.value))
const percentile = computed(() => activeCapPercentile(props.history))

function pctTone(pct: number | null): string {
  if (pct == null) return ''
  if (pct >= 80) return 'up'
  if (pct <= 20) return 'down'
  return ''
}

const marketStats = computed(() => {
  const latest = visible.value.at(-1)
  if (!latest) return []
  const previous = visible.value.at(-2)
  const backBars = LOOKBACK_DAYS[timeframe.value]
  const longAgo = visible.value.at(-(backBars.bars + 1))
  const dayChange = changePct(latest.activeCapYi, previous?.activeCapYi)
  const twentyDayChange = changePct(latest.activeCapYi, longAgo?.activeCapYi)
  const referenceGap = changePct(latest.activeCapYi, latest.referenceMaYi ?? undefined)
  const macdLatest = macd.value.at(-1)
  const kdjLatest = kdj.value.at(-1)
  const pct = percentile.value

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
      sub: dayChange == null ? '缺少前一交易日' : `${TIMEFRAME_LABEL[timeframe.value]}线${dayChange >= 0 ? '活筹增加' : '活筹减少'}`,
      tone: changeClass(dayChange),
    },
    {
      label: `${backBars.bars} ${backBars.unit}变化`,
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
    {
      label: '1 年分位',
      value: pct?.oneYearPct == null ? '—' : `${pct.oneYearPct.toFixed(0)}%`,
      sub: pct?.oneYearPct == null ? '历史不足' : pct.oneYearPct >= 80 ? '高位区' : pct.oneYearPct <= 20 ? '低位区' : '区间内',
      tone: pctTone(pct?.oneYearPct ?? null),
    },
    {
      label: '3 年分位',
      value: pct?.threeYearPct == null ? '—' : `${pct.threeYearPct.toFixed(0)}%`,
      sub: pct?.threeYearPct == null ? '历史不足' : pct.threeYearPct >= 80 ? '历史高位' : pct.threeYearPct <= 20 ? '历史低位' : '历史区间内',
      tone: pctTone(pct?.threeYearPct ?? null),
    },
  ]
})

const option = computed(() =>
  buildActiveCapChartOption(
    visible.value,
    events.value,
    macd.value,
    kdj.value,
    timeframe.value,
    props.citicHistory,
  ),
)
</script>

<template>
  <div v-if="history.length === 0" class="state muted">暂无 0AMV 市场数据</div>
  <template v-else>
    <div class="seg">
      <button
        v-for="(value, label) in { daily: '日线', weekly: '周线', monthly: '月线' }"
        :key="value"
        :class="{ on: timeframe === value }"
        @click="timeframe = value as Timeframe">
        {{ label }}
      </button>
    </div>
    <div class="market-stats" role="list" aria-label="0AMV 市场状态">
      <div v-for="stat in marketStats" :key="stat.label" class="market-stat" role="listitem">
        <div class="market-stat-label">{{ stat.label }}</div>
        <div class="market-stat-value mono" :class="stat.tone">{{ stat.value }}</div>
        <div class="market-stat-sub muted">{{ stat.sub }}</div>
      </div>
    </div>
    <p v-if="events.length" class="chart-note">
      金色虚线仅标记汇金持有人报告期；报告期不等同于公告发布日期。红色点线标记中信期货大额增减持（|Δ| ≥ 2σ）。
    </p>
    <p class="chart-note muted">
      KDJ 用 0AMV 自身滚动高低点近似 RSV，不是个股 OHLC 口径；虚线为 20 / 50 / 80。周/月线由日线聚合：活筹取周期末值，成交额取周期合计，指标按周期重算。
    </p>
    <BaseChart :option="option" height="520px" />
  </template>
</template>
