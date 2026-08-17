/**
 * 散户情绪反向三温度的历史收益标定。
 *
 * 方法：对历史每个交易日计算各情绪指标的分位读数，再看中证全指
 * 在其后 FORWARD 日内的收益，按五分位分组统计。反向指标有效的标志是——
 * 高温组（情绪过热）未来收益显著低于低温组，反之亦然；差异不足则
 * 明确报告「无显著预测力」，只作状态描述。
 *
 * 运行：bun run calibrate:retail
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { DashboardData } from '../shared/types'

const ROOT = join(import.meta.dir, '..')
/** 事后检验前视窗口（交易日）。 */
const FORWARD_DAYS = 20
/** 分位回看窗口。 */
const LOOKBACK = 250
/** 触发统计的最少历史样本。 */
const MIN_HISTORY = 250
/** 差异显著性：顶底组均值差 ≥ 合并标准误 × 此倍数才算信号。 */
const SIGNIFICANCE_SE = 2

interface Sample {
  /** 指标当日分位（0-100）。 */
  percentile: number
  /** 未来 FORWARD 日中证全指收益 %。 */
  forwardReturn: number
}

interface GroupStat {
  count: number
  mean: number
  median: number
  winRate: number
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function stdErr(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance / values.length)
}

function statOf(values: number[]): GroupStat {
  return {
    count: values.length,
    mean: mean(values),
    median: median(values),
    winRate: values.length === 0 ? 0 : values.filter((v) => v > 0).length / values.length,
  }
}

/** 逐日回溯：把「当日指标分位 → 未来收益」整理成样本集。 */
function buildSamples(
  daily: { date: string; value: number }[],
  closeByDate: Map<string, number>,
): Sample[] {
  const out: Sample[] = []
  for (let t = LOOKBACK; t < daily.length; t++) {
    const history = daily.slice(t - LOOKBACK, t).map((d) => d.value)
    if (history.length < MIN_HISTORY) continue
    const below = history.filter((v) => v <= daily[t]!.value).length
    const start = closeByDate.get(daily[t]!.date)
    const endRow = daily[t + FORWARD_DAYS]
    const end = endRow ? closeByDate.get(endRow.date) : undefined
    if (start == null || end == null || !(start > 0)) continue
    out.push({
      percentile: (below / history.length) * 100,
      forwardReturn: (end / start - 1) * 100,
    })
  }
  return out
}

/** 五分位分组打印 + 顶底差异显著性判定。 */
function report(label: string, samples: Sample[], hotIsBad: boolean): void {
  console.log(`\n${'─'.repeat(64)}`)
  console.log(`${label}｜样本 ${samples.length}`)
  console.log('  分位区间    样本   平均收益   中位收益   上涨率')
  const buckets: number[][] = []
  for (const [lo, hi] of [[0, 20], [20, 40], [40, 60], [60, 80], [80, 100.01]]) {
    buckets.push(
      samples
        .filter((s) => s.percentile >= lo! && s.percentile < hi!)
        .map((s) => s.forwardReturn),
    )
  }
  for (let i = 0; i < buckets.length; i++) {
    const stat = statOf(buckets[i]!)
    if (stat.count === 0) continue
    console.log(
      `  ${String(i * 20).padStart(4)}-${String(Math.min((i + 1) * 20, 100)).padEnd(5)} ` +
        `${String(stat.count).padStart(6)} ` +
        `${stat.mean >= 0 ? '+' : ''}${stat.mean.toFixed(2).padStart(8)}% ` +
        `${stat.median >= 0 ? '+' : ''}${stat.median.toFixed(2).padStart(8)}% ` +
        `${(stat.winRate * 100).toFixed(1).padStart(9)}%`,
    )
  }
  const top = buckets[4] ?? []
  const bottom = buckets[0] ?? []
  if (top.length < 20 || bottom.length < 20) {
    console.log('  结论：顶/底组样本不足，无法判定')
    return
  }
  const diff = mean(top) - mean(bottom)
  const se = stdErr([...top, ...bottom])
  const significant = se > 0 && Math.abs(diff) >= se * SIGNIFICANCE_SE
  if (!significant) {
    console.log(
      `  结论：无显著预测力（顶底差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp < ${SIGNIFICANCE_SE}×标准误），仅作状态描述`,
    )
    return
  }
  const direction =
    (diff < 0) === hotIsBad
      ? '反向信号成立（高温组未来收益更差）'
      : '顺向信号（高温组未来收益更好）'
  console.log(
    `  结论：${direction}，顶底差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp（≥ ${SIGNIFICANCE_SE}×标准误）`,
  )
}

async function main() {
  const raw = await readFile(join(ROOT, 'data', 'dashboard.json'), 'utf-8')
  const dashboard = JSON.parse(raw) as DashboardData
  const market = dashboard.marketActiveCapHistory ?? []
  const closeByDate = new Map(market.map((p) => [p.date, p.marketIndex]))
  console.log('='.repeat(64))
  console.log('散户情绪反向 · 历史收益标定')
  console.log(
    `收益基准：中证全指（marketIndex）｜前视 ${FORWARD_DAYS} 日｜分位回看 ${LOOKBACK} 日`,
  )
  console.log(
    `市场序列 ${market.length} 点（${market[0]?.date} → ${market.at(-1)?.date}）`,
  )

  // ── 杠杆维度：融资买入额 / 沪深成交额 ──
  const margin = dashboard.marginHistory ?? []
  const amountByDate = new Map(market.map((p) => [p.date, p.marketAmountYi]))
  const marginDaily = margin
    .map((p) => {
      const amt = amountByDate.get(p.date)
      if (amt == null || amt <= 0) return null
      return { date: p.date, value: (p.rzmre / (amt * 1e8)) * 100 }
    })
    .filter((x): x is { date: string; value: number } => x != null)
  if (marginDaily.length < MIN_HISTORY + FORWARD_DAYS) {
    console.log('\n杠杆维度：两融历史不足，跳过')
  } else {
    report(
      `杠杆温度｜融资买入占成交额比（${marginDaily[0]!.date} → ${marginDaily.at(-1)!.date}）`,
      buildSamples(marginDaily, closeByDate),
      true,
    )
  }

  // ── 申赎维度：六只宽基净申购率中位数 ──
  const ratesByDate = new Map<string, number[]>()
  for (const etf of dashboard.etfs) {
    const daily = etf.scaleHistory.filter((p) => p.frequency === 'daily')
    for (let i = 1; i < daily.length; i++) {
      const point = daily[i]!
      const prev = daily[i - 1]!
      if (point.netSubscriptionYi == null || !(prev.totalSharesYi > 0)) continue
      const rate = (point.netSubscriptionYi / prev.totalSharesYi) * 100
      const list = ratesByDate.get(point.date) ?? []
      list.push(rate)
      ratesByDate.set(point.date, list)
    }
  }
  const flowDaily = [...ratesByDate.entries()]
    .filter(([date]) => closeByDate.has(date))
    .map(([date, rates]) => ({ date, value: median(rates) }))
    .sort((a, b) => a.date.localeCompare(b.date))
  if (flowDaily.length < MIN_HISTORY + FORWARD_DAYS) {
    console.log(
      `\n申赎维度：份额历史 ${flowDaily.length} 日 < ${MIN_HISTORY + FORWARD_DAYS}，跳过`,
    )
  } else {
    report(
      `申赎温度｜净申购率中位数（${flowDaily[0]!.date} → ${flowDaily.at(-1)!.date}）`,
      buildSamples(flowDaily, closeByDate),
      true,
    )
  }

  // ── 交投维度：换手率（历史自接入日积累）──
  const turnoverDays = Math.max(
    0,
    ...dashboard.etfs.map((etf) => etf.turnoverHistory?.length ?? 0),
  )
  console.log(
    `\n交投维度：换手历史仅 ${turnoverDays} 日（需 ≥ ${MIN_HISTORY + FORWARD_DAYS}），待积累后可用`,
  )

  console.log('\n注：以上为历史描述性统计，不构成投资建议；样本覆盖单一市场周期，')
  console.log('    显著性门槛为 2×标准误的经验近似，未做多重检验校正。')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
