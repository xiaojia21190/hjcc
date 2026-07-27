<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EtfSnapshot } from '../../shared/types'
import {
  formatPct,
  formatShares,
  formatYi,
  shortName,
  yuanToYi,
  changeClass,
} from '../utils/format'

const props = defineProps<{
  etfs: EtfSnapshot[]
  selectedCode?: string
}>()

const emit = defineEmits<{
  select: [code: string]
}>()

type TableFilter = 'all' | 'disclosed' | 'attention'
type TableSort = 'category' | 'asset' | 'huijin' | 'change'

const filter = ref<TableFilter>('all')
const sort = ref<TableSort>('category')

const rows = computed(() =>
  props.etfs.map((e, categoryOrder) => {
    const latestScale = e.scaleHistory[e.scaleHistory.length - 1]
    const latestDisclosure = e.latestHuijin
    const anchoredPts = e.huijinEstimateHistory.filter(
      (p) => p.estimateMethod === 'anchored',
    )
    const latestAnchored =
      anchoredPts.length > 0 ? anchoredPts[anchoredPts.length - 1] : null
    return {
      code: e.code,
      categoryOrder,
      categoryName: e.categoryName,
      name: shortName(e.name),
      price: e.quote?.price,
      changePct: e.quote?.changePct,
      totalSharesYi: latestScale?.totalSharesYi ?? null,
      shareChangeYi:
        latestScale?.netSubscriptionYi ??
        (latestScale?.purchaseYi != null && latestScale?.redeemYi != null
          ? latestScale.purchaseYi - latestScale.redeemYi
          : null),
      netAssetYi: latestScale?.netAssetYi ?? null,
      netAssetEstimated: latestScale?.netAssetEstimated ?? false,
      scaleDate: latestScale?.date ?? null,
      reportDate: latestDisclosure?.reportDate ?? null,
      huijinShares: latestDisclosure?.shares ?? null,
      huijinPercent: latestDisclosure?.percent ?? null,
      huijinMv:
        latestDisclosure?.marketValue != null
          ? latestDisclosure.marketValue
          : null,
      hasHuijin: !!latestDisclosure,
      estValueYi: latestAnchored?.huijinValueYi ?? null,
      estShareTrend: latestAnchored?.shareTrend ?? null,
      estConsecutiveDays: latestAnchored?.consecutiveDays ?? null,
      estChangePct5d: latestAnchored?.shareChangePct5d ?? null,
    }
  }),
)

const disclosedCount = computed(() => rows.value.filter((row) => row.hasHuijin).length)
const attentionCount = computed(
  () => rows.value.filter((row) => !row.hasHuijin).length,
)

const visibleRows = computed(() => {
  const output = rows.value.filter((row) => {
    if (filter.value === 'disclosed') return row.hasHuijin
    if (filter.value === 'attention') return !row.hasHuijin
    return true
  })

  const nullable = (a: number | null, b: number | null, direction = 1) => {
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    return (a - b) * direction
  }

  return output.sort((a, b) => {
    if (sort.value === 'category') return a.categoryOrder - b.categoryOrder
    if (sort.value === 'asset') return nullable(a.netAssetYi, b.netAssetYi, -1)
    if (sort.value === 'huijin') return nullable(a.huijinPercent, b.huijinPercent, -1)
    return nullable(a.shareChangeYi, b.shareChangeYi, -1)
  })
})
</script>

<template>
  <div class="table-tools">
    <div class="table-filters" role="group" aria-label="ETF 状态筛选">
      <button
        type="button"
        :class="{ on: filter === 'all' }"
        :aria-pressed="filter === 'all'"
        @click="filter = 'all'"
      >
        全部 {{ rows.length }}
      </button>
      <button
        type="button"
        :class="{ on: filter === 'disclosed' }"
        :aria-pressed="filter === 'disclosed'"
        @click="filter = 'disclosed'"
      >
        已披露 {{ disclosedCount }}
      </button>
      <button
        type="button"
        :class="{ on: filter === 'attention' }"
        :aria-pressed="filter === 'attention'"
        @click="filter = 'attention'"
      >
        待关注 {{ attentionCount }}
      </button>
    </div>
    <label class="table-sort">
      <span>排序</span>
      <select v-model="sort" aria-label="ETF 表格排序">
        <option value="category">类别</option>
        <option value="asset">净资产</option>
        <option value="huijin">汇金占比</option>
        <option value="change">份额变动</option>
      </select>
    </label>
    <span class="table-count muted">显示 {{ visibleRows.length }}/{{ rows.length }} 只</span>
  </div>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>类别</th>
          <th>代码</th>
          <th>名称</th>
          <th class="num">现价</th>
          <th class="num">涨跌</th>
          <th>份额日期</th>
          <th class="num">基金总份额</th>
          <th class="num">净份额变化</th>
          <th class="num" title="基于交易所总份额流向，供判断汇金方向参考，不代表汇金实际操作">份额趋势</th>
          <th class="num">基金规模</th>
          <th>报告期</th>
          <th class="num">汇金份额</th>
          <th class="num">汇金占比</th>
          <th class="num">最近披露估值</th>
          <th class="num">估算持仓</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in visibleRows"
          :key="r.code"
          :class="{ active: r.code === selectedCode, dim: !r.hasHuijin }"
          tabindex="0"
          @click="emit('select', r.code)"
          @keydown.enter="emit('select', r.code)"
          @keydown.space.prevent="emit('select', r.code)"
        >
          <td><span class="pill">{{ r.categoryName }}</span></td>
          <td class="mono">{{ r.code }}</td>
          <td>{{ r.name }}</td>
          <td class="num mono">
            {{ r.price != null ? r.price.toFixed(3) : '—' }}
          </td>
          <td class="num mono" :class="changeClass(r.changePct)">
            {{ formatPct(r.changePct) }}
          </td>
          <td class="mono">{{ r.scaleDate || '—' }}</td>
          <td class="num mono">{{ formatShares(r.totalSharesYi != null ? r.totalSharesYi * 1e8 : null) }}</td>
          <td class="num mono" :class="changeClass(r.shareChangeYi)">
            {{ r.shareChangeYi != null ? `${r.shareChangeYi.toFixed(2)} 亿份` : '—' }}
          </td>
          <td
            class="num mono"
            :title="
              r.estShareTrend === 'inflow'
                ? '连续净流入，汇金占比被动稀释减缓'
                : r.estShareTrend === 'outflow'
                  ? '连续净流出，汇金占比被动上升'
                  : r.estChangePct5d != null
                    ? '份额持平'
                    : '无估算趋势'
            "
          >
            <template v-if="r.estShareTrend === 'inflow'">↑</template>
            <template v-else-if="r.estShareTrend === 'outflow'">↓</template>
            <template v-else>→</template>
            <span v-if="r.estConsecutiveDays && r.estShareTrend !== 'flat'">{{ r.estConsecutiveDays }}</span>
            <span v-if="r.estChangePct5d != null" class="muted">{{ r.estChangePct5d > 0 ? '+' : '' }}{{ r.estChangePct5d }}%</span>
          </td>
          <td class="num mono" :title="r.netAssetEstimated ? '总份额 × 当日附近单位净值估算' : undefined">
            {{ r.netAssetEstimated ? '≈ ' : '' }}{{ formatYi(r.netAssetYi) }}
          </td>
          <td class="mono">{{ r.reportDate || '—' }}</td>
          <td class="num mono">{{ formatShares(r.huijinShares) }}</td>
          <td class="num mono huijin">{{ formatPct(r.huijinPercent) }}</td>
          <td class="num mono">
            {{ yuanToYi(r.huijinMv) }}
            <span v-if="r.huijinMv != null" class="estimate-tag">披露</span>
          </td>
          <td
            class="num mono"
            :title="
              r.estValueYi != null
                ? '占比区间估算：下界份额变动全归因汇金，上界占比不变'
                : undefined
            "
          >
            {{ r.estValueYi != null ? formatYi(r.estValueYi) : '—' }}
            <span v-if="r.estValueYi != null" class="estimate-tag">估算</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="visibleRows.length === 0" class="table-empty muted">当前筛选没有匹配的 ETF</p>
  </div>
</template>
