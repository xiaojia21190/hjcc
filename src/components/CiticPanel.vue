<script setup lang="ts">
import { computed } from 'vue'
import type { CiticPositionPoint, CiticPositionQuality } from '../../shared/types'
import { judgeCiticPositions } from '../utils/citicSignals'

const props = withDefaults(
  defineProps<{
    history?: CiticPositionPoint[]
    quality?: CiticPositionQuality | null
  }>(),
  { history: () => [], quality: null },
)

const verdict = computed(() => judgeCiticPositions(props.history))

const PRODUCT_NAME: Record<string, string> = {
  IF: '沪深300',
  IH: '上证50',
  IC: '中证500',
  IM: '中证1000',
}

const SOURCE_TEXT: Record<string, string> = {
  tushare: 'Tushare',
  cffex: '中金所官网',
  cache: '沿用上次快照',
  unavailable: '未接入数据源',
}

const netChangeText = (value: number | null): string =>
  value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toLocaleString()} 手`

const rows = computed(() =>
  verdict.value.rows.map((row) => ({
    ...row,
    productName: PRODUCT_NAME[row.product] ?? row.product,
    netChange5dText: netChangeText(row.netChange5d),
  })),
)

const sourceText = computed(() => {
  const source = props.quality?.source
  return source ? SOURCE_TEXT[source] ?? source : '无数据'
})
</script>

<template>
  <section class="card panel citic" aria-labelledby="citic-title">
    <div class="panel-head">
      <div>
        <h2 id="citic-title">股指期货 · 中信席位多空</h2>
        <p class="muted">
          中信期货会员在 IF/IH/IC/IM 的净持仓中位数作方向代理；席位为全部客户汇总，非中信自身观点
        </p>
      </div>
      <span class="pill">{{ sourceText }}{{ verdict.date ? ` · ${verdict.date}` : '' }}</span>
    </div>

    <div class="force-verdict-grid citic-grid" v-if="verdict.productCount > 0">
      <div class="force-verdict-primary" :data-tone="verdict.tone" role="status">
        <div class="insight-label">综合倾向</div>
        <div class="insight-value">{{ verdict.status }}</div>
        <div class="insight-detail muted">{{ verdict.detail }}</div>
      </div>
      <div class="force-verdict-gate" :data-status="verdict.tone">
        <div class="insight-label">净持仓中位占比</div>
        <div class="insight-value">
          {{ verdict.medianNetRatioPct == null ? '—' : `${verdict.medianNetRatioPct >= 0 ? '+' : ''}${verdict.medianNetRatioPct.toFixed(1)}%` }}
        </div>
        <div class="insight-detail muted">四品种净占比中位数</div>
      </div>
      <div class="force-verdict-gate" :data-status="verdict.tone">
        <div class="insight-label">净持仓 5 日中位</div>
        <div class="insight-value">{{ netChangeText(verdict.medianNetChange5d) }}</div>
        <div class="insight-detail muted">净持仓 5 日变化中位数</div>
      </div>
      <div v-if="verdict.medianShortTop5Pct != null" class="force-verdict-gate">
        <div class="insight-label">空头前五集中度</div>
        <div class="insight-value">{{ verdict.medianShortTop5Pct.toFixed(1) }}%</div>
        <div class="insight-detail muted">
          四品种空头前五会员占全市场空头持仓中位数；越高越拥挤
        </div>
      </div>
    </div>

    <table class="citic-table" v-if="verdict.productCount > 0">
      <thead>
        <tr>
          <th>品种</th>
          <th>多单</th>
          <th>空单</th>
          <th>净持仓</th>
          <th>净占比</th>
          <th>5 日变化</th>
          <th>空头 Top5</th>
          <th>方向</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.product">
          <td>{{ row.product }} · {{ row.productName }}</td>
          <td class="mono">{{ row.longHold.toLocaleString() }}</td>
          <td class="mono">{{ row.shortHold.toLocaleString() }}</td>
          <td class="mono">{{ row.netHold >= 0 ? '+' : '' }}{{ row.netHold.toLocaleString() }}</td>
          <td class="mono">{{ row.netRatioPct >= 0 ? '+' : '' }}{{ row.netRatioPct.toFixed(1) }}%</td>
          <td class="mono">{{ row.netChange5dText }}</td>
          <td class="mono">{{ row.shortTop5Pct != null ? `${row.shortTop5Pct.toFixed(1)}%` : '—' }}</td>
          <td :data-direction="row.direction">{{ row.direction }}</td>
        </tr>
      </tbody>
    </table>

    <p v-else class="insight-detail caution">
      {{ verdict.detail }}{{ props.quality?.warning ? `（${props.quality.warning}）` : '' }}
    </p>

    <p v-for="line in verdict.cautions" :key="line" class="insight-detail caution">
      {{ line }}
    </p>
    <p class="muted insight-disclaimer">
      席位持仓为全部客户汇总，含套保/套利/对冲，只描述资金行为，不构成投资建议
    </p>
  </section>
</template>
