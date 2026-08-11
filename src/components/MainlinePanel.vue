<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot, SectorTrendData } from '../../shared/types'
import {
  evaluateMainline,
  pickPrimaryWindow,
  sectorTrendToSeries,
  SECTOR_THRESHOLDS,
  VERDICT_LABEL,
  type FlowDirection,
  type MainlineReport,
} from '../utils/mainlineSignals'

const props = withDefaults(
  defineProps<{
    etfs?: EtfSnapshot[]
    sectorTrend?: SectorTrendData | null
  }>(),
  { etfs: () => [], sectorTrend: null },
)

/** 各 ETF 最新一个估算点的份额流向，用作龙头资金确认。 */
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
      points: etf.navHistory.map((point) => ({ date: point.date, nav: point.nav })),
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

const panels = computed(() => [
  {
    key: 'style',
    title: '风格主线',
    scope: '6 只宽基 ETF · 大小盘与成长价值',
    report: styleReport.value,
    empty: '宽基净值序列不足',
  },
  {
    key: 'sector',
    title: '题材主线',
    scope: '申万二级行业板块',
    report: sectorReport.value,
    empty: '快照中暂无行业板块数据',
  },
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
  if (!report || report.flowConfirmed == null) return '无资金数据'
  return report.flowConfirmed ? '龙头份额净流入' : '龙头份额未同向'
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
      <span class="pill">5 / 20 / 60 日</span>
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
          </div>
          <div class="insight-signal-item">
            <div class="insight-label">20 日龙头</div>
            <div class="insight-value mono">
              {{ pickPrimaryWindow(panel.report.windows)?.leader?.categoryName ?? '—' }}
            </div>
            <div class="insight-detail muted">
              {{ signed(pickPrimaryWindow(panel.report.windows)?.leader?.returnPct) }} 区间累计
            </div>
          </div>
          <div class="insight-signal-item">
            <div class="insight-label">资金确认</div>
            <div class="insight-value mono">{{ flowText(panel.report) }}</div>
            <div class="insight-detail muted">
              截至 {{ panel.report.asOf ?? '—' }}
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
                <th class="num">龙头日超额胜率</th>
                <th>龙头</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in panel.report.windows" :key="row.window">
                <td class="mono">{{ row.window }} 日</td>
                <td>{{ VERDICT_LABEL[row.verdict] }}</td>
                <td class="num mono">{{ pct(row.dispersionPercentile) }}</td>
                <td class="num mono">{{ corr(row.persistence) }}</td>
                <td class="num mono">{{ ratioPct(row.leaderEdgeRatio) }}</td>
                <td>{{ row.leader?.categoryName ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-else class="muted insight-empty">{{ panel.empty }}</p>
    </div>

    <p class="muted insight-disclaimer">
      口径说明：分化度取历史两年分位，持续性为前半窗与后半窗收益排名的 Spearman
      相关，龙头日超额胜率为龙头跑赢等权平均的交易日占比。三项同时达标才记为「有主线」。
      综合结论取 20 日主观察窗（与历史检验一致）；5 / 60 日仅作分窗对照，不参与降级。
      <br />
      <strong>历史检验（风格口径）</strong>：2020-09 以来逐日回溯，判为「有主线」的样本，
      其龙头在其后 20 日相对等权平均<strong>平均跑输 0.72%</strong>、跑赢率 49.1%，前视拉长到
      120 日跑输扩大到约 4.3%；调高任何门槛都只会让跑输加剧。判为「有主线」后 20 日仍为
      「有主线」的比例（23.2%）也低于无条件基础比例（约 26%）。
      <strong>风格口径不具备已验证的预测能力，据此追逐宽基龙头在历史样本上是亏损的。</strong>
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
