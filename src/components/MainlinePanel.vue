<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot, SectorTrendData } from '../../shared/types'
import {
  evaluateMainline,
  leaderRoleLabel,
  pickPrimaryWindow,
  PRIMARY_WINDOW,
  sectorTrendToSeries,
  SECTOR_THRESHOLDS,
  sortWindowsForDisplay,
  VERDICT_LABEL,
  type FlowDirection,
  type LeaderAlignmentStatus,
  type MainlineLeader,
  type MainlineReport,
  type MainlineWindowResult,
} from '../utils/mainlineSignals'

const props = withDefaults(
  defineProps<{
    etfs?: EtfSnapshot[]
    sectorTrend?: SectorTrendData | null
  }>(),
  { etfs: () => [], sectorTrend: null },
)

interface MainlinePanelView {
  key: string
  title: string
  scope: string
  report: MainlineReport | null
  primaryLeader: MainlineLeader | null
  /** 主窗置顶、长窗在前的展示序；与 report.windows 计算序解耦。 */
  displayWindows: MainlineWindowResult[]
  empty: string
}

/** 各 ETF 最新日频总份额流向，仅作风格主线旁证（不能识别持有人）。 */
const styleFlows = computed(() => {
  const flows: Record<string, FlowDirection> = {}
  for (const etf of props.etfs) {
    const latest = [...etf.huijinEstimateHistory].reverse().find((p) => p.shareTrend)
    if (latest?.shareTrend) flows[etf.category] = latest.shareTrend
  }
  return flows
})

const styleReport = computed<MainlineReport>(() =>
  evaluateMainline(
    props.etfs.map((etf) => ({
      category: etf.category,
      categoryName: etf.categoryName,
      // 主线比较使用累计净值，避免 ETF 分红日的普通净值除息下跌制造假信号。
      points: etf.navHistory.map((point) => ({
        date: point.date,
        nav: point.accNav > 0 ? point.accNav : point.nav,
      })),
    })),
    { flows: styleFlows.value },
  ),
)

const sectorReport = computed<MainlineReport | null>(() =>
  props.sectorTrend
    ? evaluateMainline(sectorTrendToSeries(props.sectorTrend), {
        thresholds: SECTOR_THRESHOLDS,
      })
    : null,
)

function toPanel(
  key: string,
  title: string,
  scope: string,
  report: MainlineReport | null,
  empty: string,
): MainlinePanelView {
  return {
    key,
    title,
    scope,
    report,
    primaryLeader: report ? pickPrimaryWindow(report.windows)?.leader ?? null : null,
    displayWindows: report ? sortWindowsForDisplay(report.windows) : [],
    empty,
  }
}

const panels = computed(() => [
  toPanel(
    'style',
    '风格主线',
    '6 只宽基 ETF · 大小盘与成长价值',
    styleReport.value,
    '宽基净值序列不足',
  ),
  toPanel(
    'sector',
    '题材主线',
    '申万二级行业板块',
    sectorReport.value,
    '快照中暂无行业板块数据',
  ),
])

function pct(value: number | null, digits = 0): string {
  return value == null ? '—' : `${value.toFixed(digits)}%`
}

function ratioPct(value: number | null): string {
  return value == null ? '—' : `${(value * 100).toFixed(0)}%`
}

function signed(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function corr(value: number | null): string {
  return value == null ? '—' : value.toFixed(2)
}

function flowText(report: MainlineReport | null): string {
  if (!report || report.flowConfirmed == null) return '无份额数据'
  return report.flowConfirmed ? '龙头 ETF 总份额净流入' : '龙头 ETF 总份额未同向'
}

const ALIGNMENT_LABEL: Record<LeaderAlignmentStatus, string> = {
  aligned: '中长期同龙头',
  partial: '部分对齐',
  split: '中长期龙头切换',
  unknown: '跨窗不足',
}

function alignmentText(report: MainlineReport | null): string {
  if (!report) return '—'
  return ALIGNMENT_LABEL[report.leaderAlignment.status]
}

/** 5 日半窗过短，Spearman 噪声大，表格中降权展示。 */
function isNoisyWindow(row: MainlineWindowResult): boolean {
  return row.window <= 5
}

function isPrimaryWindow(row: MainlineWindowResult): boolean {
  return row.window === PRIMARY_WINDOW
}

function windowLabel(row: MainlineWindowResult): string {
  if (isPrimaryWindow(row)) return `${row.window} 日 · 主窗`
  if (isNoisyWindow(row)) return `${row.window} 日 · 高噪声`
  return `${row.window} 日`
}
</script>

<template>
  <section class="market-insight" aria-labelledby="mainline-title">
    <div class="insight-head">
      <div>
        <h3 id="mainline-title">主线结构判定</h3>
        <p class="muted">
          分化度、持续性与龙头超额三项横截面度量；描述当下市场结构，不预测后市
        </p>
      </div>
      <span class="pill">主 20 · 辅 5 / 60</span>
    </div>

    <div v-for="panel in panels" :key="panel.key" class="insight-impact">
      <div class="insight-impact-head">
        <h4>{{ panel.title }}</h4>
        <span class="muted">{{ panel.scope }}</span>
      </div>

      <template v-if="panel.report && panel.report.categoryCount > 0">
        <div class="insight-signal-grid">
          <div class="insight-signal-primary">
            <div class="insight-label">综合结论</div>
            <div class="insight-value">{{ VERDICT_LABEL[panel.report.verdict] }}</div>
            <div class="insight-detail muted">
              以 20 日主观察窗为准 · {{ panel.report.categoryCount }} 个板块
            </div>
            <div v-if="panel.report.caution" class="insight-detail caution">
              辅窗：{{ panel.report.caution }}
            </div>
          </div>
          <div class="insight-signal-item">
            <div class="insight-label">
              20 日{{ leaderRoleLabel(panel.primaryLeader?.returnPct) }}
            </div>
            <div class="insight-value mono">
              {{ panel.primaryLeader?.categoryName ?? '—' }}
            </div>
            <div class="insight-detail muted">
              {{ signed(panel.primaryLeader?.returnPct) }} 区间累计
            </div>
          </div>
          <div class="insight-signal-item">
            <div class="insight-label">跨窗领先</div>
            <div class="insight-value mono">{{ alignmentText(panel.report) }}</div>
            <div class="insight-detail muted">
              {{ panel.report.leaderAlignment.summary ?? '描述性旁证 · 不改综合结论' }}
            </div>
          </div>
          <div class="insight-signal-item">
            <div class="insight-label">份额旁证</div>
            <div class="insight-value mono">{{ flowText(panel.report) }}</div>
            <div class="insight-detail muted">
              总份额流向 · 截至 {{ panel.report.asOf ?? '—' }}
            </div>
          </div>
        </div>

        <div class="table-wrap">
          <table class="data-table compact insight-table">
            <thead>
              <tr>
                <th>窗口</th>
                <th>判定</th>
                <th class="num">分化度分位</th>
                <th class="num">前后半窗排名相关</th>
                <th class="num">日超额胜率</th>
                <th>领先板块</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in panel.displayWindows"
                :key="row.window"
                :class="{
                  'is-primary-window': isPrimaryWindow(row),
                  'is-noisy-window': isNoisyWindow(row),
                }"
                :title="row.reason"
              >
                <td class="mono">{{ windowLabel(row) }}</td>
                <td>{{ VERDICT_LABEL[row.verdict] }}</td>
                <td class="num mono">{{ pct(row.dispersionPercentile) }}</td>
                <td class="num mono">{{ corr(row.persistence) }}</td>
                <td class="num mono">{{ ratioPct(row.leaderEdgeRatio) }}</td>
                <td>
                  {{ row.leader?.categoryName ?? '—' }}
                  <span
                    v-if="row.leader && row.leader.returnPct < 0"
                    class="muted leader-role-tag"
                  >相对最强</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-else class="muted insight-empty">{{ panel.empty }}</p>
    </div>

    <p class="muted insight-disclaimer">
      口径说明：分化度取历史两年分位，持续性为前半窗与后半窗收益排名的 Spearman
      相关，日超额胜率为领先板块跑赢等权平均的交易日占比。三项同时达标才记为「有主线」。
      综合结论取 20 日主观察窗（与历史检验一致）；5 / 60 日仅作分窗对照，不参与降级。
      5 日半窗过短、秩相关噪声大，表中标为高噪声；窗口收益为负时领先板块称「相对最强」。
      「跨窗领先」比较 20 与 60 日领先板块是否同一，是 N 较小时对单窗 Spearman 的描述性旁证，不改综合结论。
      <br />
      <strong>历史检验（风格口径）</strong>：2020-09 以来逐日回溯，使用 ETF 累计净值；判为「有主线」的样本，
      其龙头在其后 20 日相对等权平均<strong>平均跑输 0.21%</strong>、跑赢率 47.1%，前视拉长到
      120 日约跑输 1.9%；扫描门槛后仍无稳定转正组合。判为「有主线」后 20 日仍为
      「有主线」的比例（24.8%）也低于无条件基础比例（约 27.1%）。
      <strong>风格口径不具备已验证的预测能力，不应据此追逐宽基龙头。</strong>
      <br />
      <strong>历史检验（题材口径）</strong>：方向相反——判为「有主线」的样本其龙头此后 20 日
      平均约 +3.3%、跑赢率约 50%，而「轮动无主线」组约 -3.8%、24%。但可用行情仅 600 个
      交易日，相邻观察点共享 19/20 的窗口，约 46 个样本折算后只有约 2 个独立事件，
      前视窗口敏感性亦不稳定。<strong>该正向结果尚不足以确认，不应作为交易依据。</strong>
      <br />
      两个口径都只用于描述当下市场结构；本面板不构成投资建议。
    </p>
  </section>
</template>
