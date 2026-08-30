<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DashboardData, EtfSnapshot, MarketReportEvent } from '../shared/types'
import {
  DEFAULT_REFERENCE_DURATION_MS,
  fetchRefreshStatus,
  fetchRefreshLog,
  loadDashboard,
  refreshDashboard,
  supportsServerRefresh,
} from './api/dashboard'
import SummaryCards from './components/SummaryCards.vue'
import HuijinTrendChart from './components/HuijinTrendChart.vue'
import ActiveCapChart from './components/ActiveCapChart.vue'
import CrossValidationChart from './components/CrossValidationChart.vue'
import MarketInsightPanel from './components/MarketInsightPanel.vue'
import MainlinePanel from './components/MainlinePanel.vue'
import ShareTrendChart from './components/ShareTrendChart.vue'
import EtfTable from './components/EtfTable.vue'
import EtfDetail from './components/EtfDetail.vue'
import DataQualityBar from './components/DataQualityBar.vue'
import ForceBriefingPanel from './components/ForceBriefingPanel.vue'
import ForceVerdictPanel from './components/ForceVerdictPanel.vue'
import RetailPanel from './components/RetailPanel.vue'
import CiticPanel from './components/CiticPanel.vue'
import { downloadEtfCsv, downloadMarketCsv, downloadBriefingMd } from './utils/dashboardExport'
import { formatDateTime } from './utils/format'
import { waitForRefresh } from './utils/refreshWait'

const data = ref<DashboardData | null>(null)
const loading = ref(true)
const error = ref('')
const refreshing = ref(false)
const progress = ref(0)
const elapsedSec = ref(0)
const refreshLog = ref<string[]>([])
let logPollTimer: ReturnType<typeof setInterval> | null = null
const toast = ref({ show: false, tone: 'ok' as 'ok' | 'error', text: '' })
const selectedCode = ref('')
const metric = ref<'percent' | 'shares' | 'value'>('percent')
const shareMode = ref<'all' | 'single' | 'rate'>('all')
let toastTimer: ReturnType<typeof setTimeout> | null = null

const etfs = computed(() => data.value?.etfs ?? [])
const selected = computed<EtfSnapshot | null>(() => {
  if (!selectedCode.value) return etfs.value[0] ?? null
  return etfs.value.find((e) => e.code === selectedCode.value) ?? null
})
const showProgress = computed(() => refreshing.value || (loading.value && data.value != null))

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

function startLogPolling() {
  stopLogPolling()
  logPollTimer = setInterval(async () => {
    const log = await fetchRefreshLog()
    if (log) refreshLog.value = log.lines
  }, 2000)
}

function stopLogPolling() {
  if (logPollTimer) {
    clearInterval(logPollTimer)
    logPollTimer = null
  }
}

function showToast(tone: 'ok' | 'error', text: string) {
  toast.value = { show: true, tone, text }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value.show = false
  }, tone === 'ok' ? 4000 : 6000)
}

function applyDashboard(next: DashboardData) {
  data.value = next
  if (!selectedCode.value && next.etfs[0]) selectedCode.value = next.etfs[0].code
}

async function reload() {
  if (refreshing.value) return
  const first = data.value == null
  loading.value = true
  if (first) error.value = ''
  try {
    applyDashboard(await loadDashboard())
    error.value = ''
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (first) error.value = message
    else showToast('error', message)
  } finally {
    loading.value = false
  }
}

async function onRefresh() {
  if (refreshing.value) return
  refreshing.value = true
  elapsedSec.value = 0
  progress.value = 0
  refreshLog.value = []
  startLogPolling()
  try {
    const started = await refreshDashboard()
    if (!started.ok && started.message !== '正在抓取中') {
      showToast('error', started.message)
      return
    }
    const status = await fetchRefreshStatus()
    const result = await waitForRefresh({
      previousUpdatedAt: data.value?.updatedAt,
      referenceMs: status?.referenceDurationMs ?? DEFAULT_REFERENCE_DURATION_MS,
      loadDashboard,
      fetchStatus: fetchRefreshStatus,
      onTick(elapsed, nextProgress) {
        elapsedSec.value = Math.floor(elapsed / 1000)
        progress.value = nextProgress
      },
    })
    if (result.kind === 'updated') {
      applyDashboard(result.dashboard)
      showToast('ok', `已更新至 ${formatDateTime(result.dashboard.updatedAt)}`)
    } else {
      // failed：server 已 idle 但数据没变，或 server 不可达
      showToast('error', '抓取可能失败，详见服务器日志')
    }
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : String(e))
  } finally {
    refreshing.value = false
    progress.value = 0
    stopLogPolling()
  }
}

function onSelect(code: string) {
  selectedCode.value = code
  shareMode.value = 'single'
}

onMounted(reload)
onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
  stopLogPolling()
})
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
          数据更新 {{ formatDateTime(data.updatedAt) }}
        </span>
        <button class="btn ghost" :disabled="loading || refreshing" @click="reload">
          重新加载
        </button>
        <button
                v-if="supportsServerRefresh"
                class="btn primary"
                :disabled="refreshing"
                @click="onRefresh">
          <span v-if="refreshing" class="spinner" aria-hidden="true" />
          {{ refreshing ? `抓取中 · 已用时 ${elapsedSec} 秒` : '刷新公开数据' }}
        </button>
      </div>
    </header>

    <div
         v-if="showProgress"
         class="refresh-progress"
         :class="{ indeterminate: !refreshing }"
         role="status"
         aria-live="polite">
      <div class="refresh-progress-track">
        <div
             class="refresh-progress-bar"
             :style="{ width: `${Math.max(progress, 0.04) * 100}%` }" />
      </div>
      <p v-if="refreshing" class="muted refresh-progress-note">
        正在后台拉取公开数据，完成后自动刷新
      </p>
      <div v-if="refreshing && refreshLog.length > 0" class="refresh-log" role="log" aria-live="polite">
        <p
          v-for="(line, i) in refreshLog.slice(-12)"
          :key="i"
          class="refresh-log-line mono"
          :class="{ 'log-warn': /失败|降级|不可用|超时|timeout|error|warn/i.test(line) }"
        >{{ line }}</p>
      </div>
    </div>

    <main class="main">
      <div v-if="!data && loading" class="state">
        <span class="spinner" aria-hidden="true" />
        正在加载看板数据…
      </div>
      <div v-else-if="!data && error" class="state error">
        <p>{{ error }}</p>
        <p class="muted">
          请在项目根目录执行
          <code class="mono">bun run fetch</code> 后刷新。
        </p>
      </div>
      <template v-else>
        <ForceBriefingPanel
          v-if="data"
          :etfs="etfs"
          :market-history="data.marketActiveCapHistory ?? []"
        />

        <SummaryCards
                      :etfs="etfs"
                      :total-mv="data?.summary.totalHuijinMarketValue ?? null"
                      :active-cap-yi="data?.summary.latestActiveCapYi ?? null"
                      :active-cap-date="data?.summary.latestActiveCapDate ?? null"
                      :latest-report="data?.summary.latestReportDate ?? null"
                      :updated-at="data?.updatedAt || ''" />

        <DataQualityBar v-if="data" :data="data" />

        <ForceVerdictPanel
          v-if="data"
          :etfs="etfs"
          :market-history="data.marketActiveCapHistory ?? []"
        />

        <RetailPanel
          v-if="data"
          :etfs="etfs"
          :margin-history="data.marginHistory ?? []"
          :market-history="data.marketActiveCapHistory ?? []"
        />

        <CiticPanel
          v-if="data"
          :history="data.citicPositionHistory ?? []"
          :quality="data.citicPositionQuality ?? null"
        />

        <section class="card panel">
          <div class="panel-head">
            <div>
              <h2>汇金持仓趋势</h2>
              <p class="muted">
                虚线为占比区间估算加权点（tooltip 含 floor~ceil，宽区间标低分辨）；次轴细线为 ETF 总份额 5 日变化率，不能识别持有人
              </p>
            </div>
            <div class="seg">
              <button
                      :class="{ on: metric === 'percent' }"
                      @click="metric = 'percent'">
                占比%
              </button>
              <button
                      :class="{ on: metric === 'shares' }"
                      @click="metric = 'shares'">
                份额
              </button>
              <button
                      :class="{ on: metric === 'value' }"
                      @click="metric = 'value'">
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
                          :citic-history="data?.citicPositionHistory ?? []" />
          <CrossValidationChart
                          :etfs="etfs"
                          :market-history="data?.marketActiveCapHistory ?? []" />
          <MarketInsightPanel
                              :history="data?.marketActiveCapHistory ?? []"
                              :events="marketEvents" />
        </section>

        <section class="card panel">
          <div class="panel-head">
            <div>
              <h2>主线结构判定</h2>
              <p class="muted">
                横截面分化度、排名持续性与龙头超额；描述当下市场结构，不预测后市
              </p>
            </div>
          </div>
          <MainlinePanel
                         :etfs="data?.etfs ?? []"
                         :sector-trend="data?.sectorTrend ?? null" />
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
                      @click="shareMode = 'all'">
                全部对比
              </button>
              <button
                      :class="{ on: shareMode === 'rate' }"
                      @click="shareMode = 'rate'">
                5 日变化率
              </button>
              <button
                      :class="{ on: shareMode === 'single' }"
                      @click="shareMode = 'single'">
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
              <button
                      class="btn ghost"
                      type="button"
                      @click="downloadEtfCsv(etfs, data?.updatedAt)">
                导出 ETF CSV
              </button>
              <button
                      class="btn ghost"
                      type="button"
                      @click="downloadMarketCsv(data)">
                导出 0AMV CSV
              </button>
              <button
                      class="btn ghost"
                      type="button"
                      @click="data && downloadBriefingMd(data)">
                导出 Markdown 简报
              </button>
            </div>
          </div>
          <EtfTable
                    :etfs="etfs"
                    :selected-code="selectedCode"
                    @select="onSelect" />
        </section>

        <section class="card panel">
          <EtfDetail :etf="selected" />
        </section>

        <footer class="foot muted">
          <p>
            数据来源：上交所/深交所 ETF 每日总份额、新浪财经十大持有人、天天基金定期规模、东方财富

          <div v-if="toast.show" class="toast" :data-tone="toast.tone" role="status">
            {{ toast.text }}
          </div>
          ETF 行情/净值及中证全指日线。0AMV 按公开近似公式计算，定义参见
          <a href="https://www.compass.cn/shownews.php?nid=33751625" target="_blank"
             rel="noopener noreferrer">指南针说明</a>；
          汇金持仓通常于年报/半年报披露，非实时；最近披露期之后按占比区间口径估算（下界假设份额变动全归因汇金，上界假设汇金占比不变，展示值取区间加权），估算不代表实际持仓。
          </p>
          <p>仅供研究展示，不构成投资建议。请以交易所与基金正式公告为准。</p>
        </footer>
      </template>
    </main>
  </div>
</template>
