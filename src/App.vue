<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { DashboardData, EtfSnapshot, MarketReportEvent } from '../shared/types'
import {
  loadDashboard,
  refreshDashboard,
  supportsServerRefresh,
} from './api/dashboard'
import SummaryCards from './components/SummaryCards.vue'
import HuijinTrendChart from './components/HuijinTrendChart.vue'
import ActiveCapChart from './components/ActiveCapChart.vue'
import MarketInsightPanel from './components/MarketInsightPanel.vue'
import ShareTrendChart from './components/ShareTrendChart.vue'
import EtfTable from './components/EtfTable.vue'
import EtfDetail from './components/EtfDetail.vue'
import DataQualityBar from './components/DataQualityBar.vue'
import { downloadCsv } from './utils/csv'
import { computeMacd } from './utils/macd'

const data = ref<DashboardData | null>(null)
const loading = ref(true)
const error = ref('')
const refreshing = ref(false)
const selectedCode = ref('')
const metric = ref<'percent' | 'shares' | 'value'>('percent')
const shareMode = ref<'all' | 'single'>('all')

const etfs = computed(() => data.value?.etfs ?? [])
const selected = computed<EtfSnapshot | null>(() => {
  if (!selectedCode.value) return etfs.value[0] ?? null
  return etfs.value.find((e) => e.code === selectedCode.value) ?? null
})

const marketEvents = computed<MarketReportEvent[]>(() => {
  const byDate = new Map<string, string[]>()
  for (const etf of etfs.value) {
    for (const report of etf.holderReports) {
      if (report.huijinShares <= 0) continue
      const labels = byDate.get(report.reportDate) ?? []
      labels.push(etf.categoryName)
      byDate.set(report.reportDate, labels)
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, labels]) => ({
      date,
      label: `${labels.join(' / ')} 持有人报告期`,
    }))
})

function snapshotDate() {
  return data.value?.updatedAt.slice(0, 10) ?? new Date().toISOString().slice(0, 10)
}

function downloadEtfCsv() {
  const rows = etfs.value.map((etf) => {
    const scale = etf.scaleHistory.at(-1)
    const anchoredPts = etf.huijinEstimateHistory.filter(
      (p) => p.estimateMethod === 'anchored',
    )
    const latestAnchored = anchoredPts.at(-1) ?? null
    return [
      etf.categoryName,
      etf.code,
      etf.name,
      etf.quote?.price,
      etf.quote?.changePct,
      scale?.date,
      scale?.totalSharesYi,
      scale?.netSubscriptionYi ??
        (scale?.purchaseYi != null && scale.redeemYi != null
          ? scale.purchaseYi - scale.redeemYi
          : null),
      scale?.netAssetYi,
      etf.latestHuijin?.reportDate,
      etf.latestHuijin?.shares,
      etf.latestHuijin?.percent,
      etf.latestHuijin?.marketValue != null
        ? etf.latestHuijin.marketValue / 1e8
        : null,
      latestAnchored?.date ?? null,
      latestAnchored?.huijinShares != null
        ? latestAnchored.huijinShares / 1e8
        : null,
      latestAnchored?.huijinValueYi ?? null,
      latestAnchored ? '估算' : '无锚点',
    ]
  })
  downloadCsv(
    `huijin-etf-snapshot-${snapshotDate()}.csv`,
    [
      '类别',
      '代码',
      '名称',
      '现价',
      '涨跌幅%',
      '份额日期',
      '总份额_亿份',
      '净份额变化_亿份',
      '净资产_亿元',
      '汇金报告期',
      '汇金份额',
      '汇金占比%',
      '最近披露汇金估值_亿元',
      '估算日期',
      '估算汇金份额_亿份',
      '估算汇金估值_亿元',
      '持仓状态',
    ],
    rows,
  )
}

function downloadMarketCsv() {
  const history = data.value?.marketActiveCapHistory ?? []
  const macdPoints = computeMacd(history.map((point) => point.activeCapYi))
  downloadCsv(
    `market-0amv-${snapshotDate()}.csv`,
    ['日期', '0AMV估算_亿元', '中证全指收盘', '沪深两市成交额_亿元', '5日参考线_亿元', 'DIF', 'DEA', 'MACD'],
    history.map((point, index) => [
      point.date,
      point.activeCapYi,
      point.marketIndex,
      point.marketAmountYi,
      point.referenceMaYi,
      macdPoints[index]?.dif ?? '',
      macdPoints[index]?.dea ?? '',
      macdPoints[index]?.macd ?? '',
    ]),
  )
}

async function reload() {
  loading.value = true
  error.value = ''
  try {
    data.value = await loadDashboard()
    if (!selectedCode.value && data.value.etfs[0]) {
      selectedCode.value = data.value.etfs[0].code
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function onRefresh() {
  refreshing.value = true
  try {
    const r = await refreshDashboard()
    if (!r.ok) {
      error.value = r.message
    } else {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        try {
          const d = await loadDashboard()
          if (d.updatedAt && d.updatedAt !== data.value?.updatedAt) {
            data.value = d
            break
          }
        } catch {
          /* keep waiting */
        }
      }
      await reload()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    refreshing.value = false
  }
}

function onSelect(code: string) {
  selectedCode.value = code
  shareMode.value = 'single'
}

onMounted(reload)
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <div class="logo">HJ</div>
        <div>
          <h1>中央汇金 · 宽基 ETF 持仓监控</h1>
          <p class="muted">
            上证50 / 沪深300 / 中证500 / 中证1000 / 创业板 / 科创50 · 各类别取市值最大
            ETF
          </p>
        </div>
      </div>
      <div class="actions">
        <span v-if="data?.updatedAt" class="pill">
          数据更新 {{ data.updatedAt.replace('T', ' ').slice(0, 19) }}
        </span>
        <button class="btn ghost" :disabled="loading" @click="reload">
          重新加载
        </button>
        <button
          v-if="supportsServerRefresh"
          class="btn primary"
          :disabled="refreshing"
          @click="onRefresh"
        >
          {{ refreshing ? '抓取中…' : '刷新公开数据' }}
        </button>
      </div>
    </header>

    <main class="main">
      <div v-if="loading" class="state">正在加载看板数据…</div>
      <div v-else-if="error" class="state error">
        <p>{{ error }}</p>
        <p class="muted">
          请在项目根目录执行
          <code class="mono">bun run fetch</code> 后刷新。
        </p>
      </div>
      <template v-else>
        <SummaryCards
          :etfs="etfs"
          :total-mv="data?.summary.totalHuijinMarketValue ?? null"
          :active-cap-yi="data?.summary.latestActiveCapYi ?? null"
          :active-cap-date="data?.summary.latestActiveCapDate ?? null"
          :latest-report="data?.summary.latestReportDate ?? null"
          :updated-at="data?.updatedAt || ''"
        />

        <DataQualityBar v-if="data" :data="data" />

        <section class="card panel">
          <div class="panel-head">
            <div>
              <h2>汇金持仓趋势</h2>
              <p class="muted">
                实点为年报/半年报「十大持有人」披露；最近披露期之后的虚线为占比区间估算（下界假设份额变动全归因汇金，上界假设汇金占比不变）
              </p>
            </div>
            <div class="seg">
              <button
                :class="{ on: metric === 'percent' }"
                @click="metric = 'percent'"
              >
                占比%
              </button>
              <button
                :class="{ on: metric === 'shares' }"
                @click="metric = 'shares'"
              >
                份额
              </button>
              <button
                :class="{ on: metric === 'value' }"
                @click="metric = 'value'"
              >
                估值
              </button>
            </div>
          </div>
          <HuijinTrendChart :etfs="etfs" :metric="metric" />
        </section>

        <section class="card panel">
          <div class="panel-head">
            <div>
              <h2>0AMV 活筹估算（沪深市场）</h2>
              <p class="muted">
                中证全指作价格代理，上证综指 + 深证成指作成交额；指南针原版算法未公开
              </p>
            </div>
          </div>
          <ActiveCapChart
            :history="data?.marketActiveCapHistory ?? []"
            :events="marketEvents"
          />
          <MarketInsightPanel
            :history="data?.marketActiveCapHistory ?? []"
            :events="marketEvents"
          />
        </section>

        <section class="card panel">
          <div class="panel-head">
            <div>
              <h2>ETF 份额变化趋势</h2>
              <p class="muted">
                总份额来自交易所官方日频规模，净变化为相邻交易日份额差；单只模式仅标记汇金披露份额
              </p>
            </div>
            <div class="seg">
              <button
                :class="{ on: shareMode === 'all' }"
                @click="shareMode = 'all'"
              >
                全部对比
              </button>
              <button
                :class="{ on: shareMode === 'single' }"
                @click="shareMode = 'single'"
              >
                当前 ETF
              </button>
            </div>
          </div>
          <ShareTrendChart :mode="shareMode" :etfs="etfs" :etf="selected" />
        </section>

        <section class="card panel">
          <div class="panel-head">
            <div>
              <h2>分类最大规模 ETF 一览</h2>
              <p class="muted">点击行查看十大持有人明细；金色高亮为汇金系主体</p>
            </div>
            <div class="panel-actions">
              <button class="btn ghost" type="button" @click="downloadEtfCsv">
                导出 ETF CSV
              </button>
              <button class="btn ghost" type="button" @click="downloadMarketCsv">
                导出 0AMV CSV
              </button>
            </div>
          </div>
          <EtfTable
            :etfs="etfs"
            :selected-code="selectedCode"
            @select="onSelect"
          />
        </section>

        <section class="card panel">
          <EtfDetail :etf="selected" />
        </section>

        <footer class="foot muted">
          <p>
            数据来源：上交所/深交所 ETF 每日总份额、新浪财经十大持有人、天天基金定期规模、东方财富
            ETF 行情/净值及中证全指日线。0AMV 按公开近似公式计算，定义参见
            <a href="https://www.compass.cn/shownews.php?nid=33751625" target="_blank" rel="noopener noreferrer">指南针说明</a>；
            汇金持仓通常于年报/半年报披露，非实时；最近披露期之后按占比区间口径估算（下界假设份额变动全归因汇金，上界假设汇金占比不变，展示值取区间加权），估算不代表实际持仓。
          </p>
          <p>仅供研究展示，不构成投资建议。请以交易所与基金正式公告为准。</p>
        </footer>
      </template>
    </main>
  </div>
</template>
