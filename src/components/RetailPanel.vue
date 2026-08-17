<script setup lang="ts">
import { computed } from 'vue'
import type {
  EtfSnapshot,
  MarginPoint,
  MarketActiveCapPoint,
} from '../../shared/types'
import { judgeRetailSentiment } from '../utils/retailSignals'

const props = withDefaults(
  defineProps<{
    etfs?: EtfSnapshot[]
    marginHistory?: MarginPoint[]
    marketHistory?: MarketActiveCapPoint[]
  }>(),
  { etfs: () => [], marginHistory: () => [], marketHistory: () => [] },
)

const verdict = computed(() =>
  judgeRetailSentiment(props.etfs, props.marginHistory, props.marketHistory),
)

const temperatureText = computed(() => {
  const v = verdict.value
  return v.temperaturePercentile == null
    ? v.temperatureLabel
    : `${v.temperatureLabel} · ${v.temperaturePercentile.toFixed(0)} 分位`
})

const otherTotalText = computed(() => {
  const v = verdict.value
  if (v.otherTotalYi == null) return '—'
  const change =
    v.otherTotalChangePct5d == null
      ? ''
      : `（5 日 ${v.otherTotalChangePct5d > 0 ? '+' : ''}${v.otherTotalChangePct5d.toFixed(2)}%）`
  return `${v.otherTotalYi.toFixed(1)} 亿份${change}`
})

const turnoverText = computed(() => {
  const v = verdict.value
  return v.turnoverPercentile == null
    ? v.turnoverLabel
    : `${v.turnoverLabel} · ${v.turnoverPercentile.toFixed(0)} 分位`
})

const marginText = computed(() => {
  const v = verdict.value
  const base =
    v.marginPercentile == null
      ? v.marginLabel
      : `${v.marginLabel} · ${v.marginPercentile.toFixed(0)} 分位`
  const change =
    v.marginBalanceChangePct5d == null
      ? ''
      : `（余额 5 日 ${v.marginBalanceChangePct5d > 0 ? '+' : ''}${v.marginBalanceChangePct5d.toFixed(2)}%）`
  return base + change
})

const MOOD_TEXT: Record<string, string> = {
  chasing: '追涨',
  capitulating: '杀跌',
  calm: '平静',
}

/** 逐只明细行：mood 着色数据属性。 */
const rows = computed(() =>
  verdict.value.etfs.map((row) => ({
    ...row,
    netSub5dText:
      row.netSub5dPct == null
        ? '—'
        : `${row.netSub5dPct > 0 ? '+' : ''}${row.netSub5dPct.toFixed(2)}%`,
    percentileText: row.netSubPercentile == null ? '—' : row.netSubPercentile.toFixed(0),
    otherText: row.otherYi == null ? '无披露' : `${row.otherYi.toFixed(1)} 亿份`,
    turnoverText:
      row.turnoverPct == null ? '—' : `${row.turnoverPct.toFixed(2)}%`,
    moodText: row.mood == null ? '—' : MOOD_TEXT[row.mood]!,
  })),
)
</script>

<template>
  <section class="card panel retail" aria-labelledby="retail-title">
    <div class="panel-head">
      <div>
        <h2 id="retail-title">散户情绪反向</h2>
        <p class="muted">
          宽基 ETF 边际申赎作非汇金资金情绪代理；净申购率 5 日累计与 250 日分位，再与汇金方向交叉
        </p>
      </div>
      <span class="pill">描述性结论</span>
    </div>

    <div class="force-verdict-grid retail-grid">
      <div class="force-verdict-primary" :data-quadrant="verdict.quadrant" role="status">
        <div class="insight-label">反向象限</div>
        <div class="insight-value">{{ verdict.quadrantLabel }}</div>
        <div class="insight-detail muted">{{ verdict.detail }}</div>
      </div>
      <div class="force-verdict-gate" :data-mood="verdict.mood">
        <div class="insight-label">情绪方向</div>
        <div class="insight-value">{{ verdict.moodLabel }}</div>
        <div class="insight-detail muted">六只宽基 5 日净申购率多数投票</div>
      </div>
      <div class="force-verdict-gate" :data-hot="verdict.temperatureLabel">
        <div class="insight-label">申赎温度</div>
        <div class="insight-value">{{ temperatureText }}</div>
        <div class="insight-detail muted">净申购率中位分位（250 日回看）</div>
      </div>
      <div class="force-verdict-gate">
        <div class="insight-label">其他资金存量</div>
        <div class="insight-value">{{ otherTotalText }}</div>
        <div class="insight-detail muted">总份额 − 汇金估算，有披露的 ETF 合计</div>
      </div>
      <div class="force-verdict-gate" :data-hot="verdict.turnoverLabel">
        <div class="insight-label">交投温度</div>
        <div class="insight-value">{{ turnoverText }}</div>
        <div class="insight-detail muted">场内换手率中位分位（250 日回看）</div>
      </div>
      <div class="force-verdict-gate" :data-hot="verdict.marginLabel">
        <div class="insight-label">杠杆温度</div>
        <div class="insight-value">{{ marginText }}</div>
        <div class="insight-detail muted">融资买入占成交额比分位（250 日）</div>
      </div>
    </div>

    <table class="retail-table">
      <thead>
        <tr>
          <th>类别</th>
          <th>5 日净申购率</th>
          <th>分位</th>
          <th>情绪</th>
          <th>换手%</th>
          <th>其他资金份额</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.code">
          <td>{{ row.categoryName }}</td>
          <td>{{ row.netSub5dText }}</td>
          <td>{{ row.percentileText }}</td>
          <td :data-mood="row.mood">{{ row.moodText }}</td>
          <td>{{ row.turnoverText }}</td>
          <td>{{ row.otherText }}</td>
        </tr>
      </tbody>
    </table>

    <p v-for="line in verdict.cautions" :key="line" class="insight-detail caution">
      {{ line }}
    </p>
    <p class="muted insight-disclaimer">{{ verdict.disclaimer }}</p>
  </section>
</template>
