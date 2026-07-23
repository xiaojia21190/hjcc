<script setup lang="ts">
import { computed } from 'vue'
import type { MarketActiveCapPoint, MarketReportEvent } from '../../shared/types'
import { changeClass, formatPct } from '../utils/format'
import { findMarketCrossings, percentChange } from '../utils/marketSignals'

const props = withDefaults(
  defineProps<{
    history?: MarketActiveCapPoint[]
    events?: MarketReportEvent[]
  }>(),
  { history: () => [], events: () => [] },
)

function signedPct(value: number | null) {
  if (value == null) return '—'
  return value > 0 ? `+${formatPct(value)}` : formatPct(value)
}

const signal = computed(() => {
  const history = props.history
  const latest = history.at(-1)
  const crossings = findMarketCrossings(history)
  const latestCrossing = crossings.at(-1)
  if (!latest || latest.referenceMaYi == null) {
    return {
      status: '参考线未形成',
      tone: '',
      gap: null,
      crossDate: null,
      crossDirection: null,
      daysSinceCross: null,
    }
  }

  const gap = percentChange(latest.referenceMaYi, latest.activeCapYi)
  return {
    status: gap != null && gap >= 0 ? '短期偏强' : '短期偏弱',
    tone: gap != null && gap >= 0 ? 'up' : 'down',
    gap,
    crossDate: latestCrossing?.date ?? null,
    crossDirection: latestCrossing?.direction === 'up' ? '上穿' : latestCrossing ? '下穿' : null,
    daysSinceCross: latestCrossing == null ? null : history.length - 1 - latestCrossing.index,
  }
})

const signalStats = computed(() => {
  const crossings = findMarketCrossings(props.history)
  const up = crossings.filter((crossing) => crossing.direction === 'up')
  const down = crossings.filter((crossing) => crossing.direction === 'down')
  const upCompleted = up.filter((crossing) => crossing.active20 != null)
  const downCompleted = down.filter((crossing) => crossing.active20 != null)
  return {
    upCount: up.length,
    downCount: down.length,
    upPositiveRate:
      upCompleted.length > 0
        ? (upCompleted.filter((crossing) => (crossing.active20 ?? 0) > 0).length / upCompleted.length) * 100
        : null,
    downNegativeRate:
      downCompleted.length > 0
        ? (downCompleted.filter((crossing) => (crossing.active20 ?? 0) < 0).length / downCompleted.length) * 100
        : null,
    upCompleted: upCompleted.length,
    downCompleted: downCompleted.length,
  }
})

const eventRows = computed(() =>
  props.events
    .map((event) => {
      const baseIndex = props.history.findIndex((point) => point.date >= event.date)
      if (baseIndex < 0) return null
      const base = props.history[baseIndex]
      const after5 = props.history[baseIndex + 5]
      const after20 = props.history[baseIndex + 20]
      return {
        ...event,
        baseDate: base.date,
        after5Date: after5?.date ?? null,
        after20Date: after20?.date ?? null,
        active5: percentChange(base.activeCapYi, after5?.activeCapYi),
        active20: percentChange(base.activeCapYi, after20?.activeCapYi),
        index5: percentChange(base.marketIndex, after5?.marketIndex),
        index20: percentChange(base.marketIndex, after20?.marketIndex),
      }
    })
    .filter((row): row is NonNullable<typeof row> => row != null)
    .slice(-8),
)
</script>

<template>
  <section class="market-insight" aria-labelledby="market-insight-title">
    <div class="insight-head">
      <div>
        <h3 id="market-insight-title">趋势状态与报告期影响</h3>
        <p class="muted">仅作公开公式的技术观察，不构成投资信号或因果结论</p>
      </div>
      <span class="pill">交易日窗口</span>
    </div>

    <div class="insight-signal-grid">
      <div class="insight-signal-primary" :data-tone="signal.tone">
        <div class="insight-label">当前状态</div>
        <div class="insight-value">{{ signal.status }}</div>
        <div class="insight-detail muted">
          {{ signal.gap == null ? '暂无可比较的参考线' : `距离参考线 ${signedPct(signal.gap)}` }}
        </div>
      </div>
      <div class="insight-signal-item">
        <div class="insight-label">最近一次穿越</div>
        <div class="insight-value mono">
          {{ signal.crossDirection && signal.crossDate ? `${signal.crossDirection} · ${signal.crossDate}` : '暂无' }}
        </div>
        <div class="insight-detail muted">
          {{ signal.daysSinceCross == null ? '历史中未形成穿越' : `距今 ${signal.daysSinceCross} 个交易日` }}
        </div>
      </div>
      <div class="insight-signal-item">
        <div class="insight-label">窗口定义</div>
        <div class="insight-value mono">+5 / +20</div>
        <div class="insight-detail muted">从报告期对应或之后首个交易日计</div>
      </div>
    </div>

    <div class="insight-impact">
      <div class="insight-impact-head">
        <h4>报告期后的市场变化</h4>
        <span class="muted">0AMV / 中证全指</span>
      </div>
      <div v-if="eventRows.length" class="table-wrap">
        <table class="data-table compact insight-table">
          <thead>
            <tr>
              <th>报告期</th>
              <th>基准交易日</th>
              <th class="num">+5 日 0AMV</th>
              <th class="num">+5 日指数</th>
              <th class="num">+20 日 0AMV</th>
              <th class="num">+20 日指数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in eventRows" :key="row.date + row.label">
              <td>{{ row.label }}</td>
              <td class="mono">{{ row.baseDate }}</td>
              <td class="num mono" :class="changeClass(row.active5)">{{ signedPct(row.active5) }}</td>
              <td class="num mono" :class="changeClass(row.index5)">{{ signedPct(row.index5) }}</td>
              <td class="num mono" :class="changeClass(row.active20)">{{ signedPct(row.active20) }}</td>
              <td class="num mono" :class="changeClass(row.index20)">{{ signedPct(row.index20) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted insight-empty">暂无可计算的持有人报告期事件</p>
    </div>

    <div class="insight-history">
      <div class="insight-impact-head">
        <h4>参考线穿越历史</h4>
        <span class="muted">+20 日 0AMV 方向一致率</span>
      </div>
      <div class="insight-history-grid" role="list">
        <div class="insight-history-item" role="listitem">
          <div class="insight-label">上穿样本</div>
          <div class="insight-value mono">{{ signalStats.upCount }} 次</div>
          <div class="insight-detail muted">完成窗口 {{ signalStats.upCompleted }} 次</div>
        </div>
        <div class="insight-history-item" role="listitem">
          <div class="insight-label">上穿后为正</div>
          <div class="insight-value mono">{{ signalStats.upPositiveRate == null ? '—' : formatPct(signalStats.upPositiveRate) }}</div>
          <div class="insight-detail muted">仅统计已完成 +20 日窗口</div>
        </div>
        <div class="insight-history-item" role="listitem">
          <div class="insight-label">下穿样本</div>
          <div class="insight-value mono">{{ signalStats.downCount }} 次</div>
          <div class="insight-detail muted">完成窗口 {{ signalStats.downCompleted }} 次</div>
        </div>
        <div class="insight-history-item" role="listitem">
          <div class="insight-label">下穿后为负</div>
          <div class="insight-value mono">{{ signalStats.downNegativeRate == null ? '—' : formatPct(signalStats.downNegativeRate) }}</div>
          <div class="insight-detail muted">仅统计已完成 +20 日窗口</div>
        </div>
      </div>
      <p class="muted insight-disclaimer">这是历史描述统计，不代表未来概率，也未扣除交易成本或考虑其他市场变量。</p>
    </div>
  </section>
</template>
