/**
 * 主线判定阈值标定。
 *
 * 方法：对历史每个交易日回溯判定，再看龙头在其后 FORWARD_DAYS 内
 * 相对等权平均的超额收益。阈值有效的标志是——被判为 mainline 的样本，
 * 其后龙头超额显著高于 rotation / none 组。据此扫描并反推各项门槛。
 *
 * 运行：bun run calibrate
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { DashboardData } from '../shared/types'
import {
  alignSeries,
  dispersionSeries,
  type AlignedMatrix,
} from '../src/utils/mainlineMetrics'
import {
  evaluateWindow,
  sectorTrendToSeries,
  STYLE_THRESHOLDS,
  type MainlineThresholds,
  type MainlineVerdict,
} from '../src/utils/mainlineSignals'

const ROOT = join(import.meta.dir, '..')
/** 事后检验的前视窗口，与主观察窗口一致。 */
const FORWARD_DAYS = 20
/** 分位数至少需要这么多历史样本才可信，之前的观察点丢弃。 */
const MIN_HISTORY = 250
/** 标定用的观察窗口。 */
const CALIBRATION_WINDOW = 20
/** 判定被认为可用的最低触发率，过低说明门槛太严、信号稀疏到没有实用价值。 */
const MIN_TRIGGER_RATE = 0.05

interface Sample {
  index: number
  verdict: MainlineVerdict
  /** 龙头在其后 forward 日相对等权平均的超额收益 %。 */
  forwardExcess: number
  /** forward 日之后的判定，用于检验状态本身是否延续。 */
  futureVerdict: MainlineVerdict | null
}

interface GroupStat {
  count: number
  share: number
  meanExcess: number
  medianExcess: number
  winRate: number
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length
}

/** 龙头在 [t, t+forward] 相对等权平均的超额收益 %。 */
function forwardExcess(
  matrix: AlignedMatrix,
  leaderIndex: number,
  span: { start: number; forward: number },
): number | null {
  const end = span.start + span.forward
  if (end >= matrix.dates.length) return null
  const returns = matrix.navs.map((navs) => navs[end] / navs[span.start] - 1)
  return (returns[leaderIndex] - mean(returns)) * 100
}

/** 对整段历史逐日回溯判定，产出可统计的样本集。 */
function backtest(
  matrix: AlignedMatrix,
  thresholds: MainlineThresholds,
  options: { window?: number; forward?: number } = {},
): Sample[] {
  const window = options.window ?? CALIBRATION_WINDOW
  const forward = options.forward ?? FORWARD_DAYS
  const history = dispersionSeries(matrix, window)
  const byCategory = new Map(matrix.categories.map((c, i) => [c.category, i]))
  const verdictAt = new Map<number, MainlineVerdict>()
  const partial: Omit<Sample, 'futureVerdict'>[] = []

  for (let t = MIN_HISTORY; t < matrix.dates.length; t++) {
    const result = evaluateWindow(matrix, {
      window,
      endIndex: t,
      thresholds,
      dispersionHistory: history,
    })
    if (result.verdict === 'insufficient' || !result.leader) continue
    verdictAt.set(t, result.verdict)
    const leaderIndex = byCategory.get(result.leader.category)
    if (leaderIndex == null) continue
    const excess = forwardExcess(matrix, leaderIndex, { start: t, forward })
    if (excess == null) continue
    partial.push({ index: t, verdict: result.verdict, forwardExcess: excess })
  }
  return partial.map((sample) => ({
    ...sample,
    futureVerdict: verdictAt.get(sample.index + forward) ?? null,
  }))
}

function statOf(samples: Sample[], total: number): GroupStat {
  const excess = samples.map((s) => s.forwardExcess)
  return {
    count: samples.length,
    share: total === 0 ? 0 : samples.length / total,
    meanExcess: mean(excess),
    medianExcess: median(excess),
    winRate: excess.length === 0 ? 0 : excess.filter((v) => v > 0).length / excess.length,
  }
}

const VERDICT_ORDER: MainlineVerdict[] = ['mainline', 'weak', 'rotation', 'none']

function printDistribution(samples: Sample[]): void {
  console.log('  判定        样本    占比    平均超额   中位超额   龙头跑赢率')
  for (const verdict of VERDICT_ORDER) {
    const stat = statOf(
      samples.filter((s) => s.verdict === verdict),
      samples.length,
    )
    if (stat.count === 0) continue
    console.log(
      `  ${verdict.padEnd(10)} ${String(stat.count).padStart(5)} ` +
        `${(stat.share * 100).toFixed(1).padStart(6)}% ` +
        `${stat.meanExcess >= 0 ? '+' : ''}${stat.meanExcess.toFixed(2).padStart(7)}% ` +
        `${stat.medianExcess >= 0 ? '+' : ''}${stat.medianExcess.toFixed(2).padStart(7)}% ` +
        `${(stat.winRate * 100).toFixed(1).padStart(9)}%`,
    )
  }
}

/** 扫描单项阈值，观察 mainline 组的样本量与事后表现如何随门槛变化。 */
function scanThreshold(
  matrix: AlignedMatrix,
  config: {
    label: string
    key: keyof MainlineThresholds
    values: number[]
    base: MainlineThresholds
  },
): void {
  console.log(`\n  ── 扫描 ${config.label} ──`)
  console.log('  取值    mainline样本  触发率   平均超额   龙头跑赢率   可用')
  for (const value of config.values) {
    const samples = backtest(matrix, { ...config.base, [config.key]: value })
    const hits = samples.filter((s) => s.verdict === 'mainline')
    const stat = statOf(hits, samples.length)
    const usable = stat.share >= MIN_TRIGGER_RATE && stat.meanExcess > 0
    console.log(
      `  ${String(value).padStart(5)} ${String(stat.count).padStart(12)} ` +
        `${(stat.share * 100).toFixed(1).padStart(7)}% ` +
        `${stat.meanExcess >= 0 ? '+' : ''}${stat.meanExcess.toFixed(2).padStart(7)}% ` +
        `${(stat.winRate * 100).toFixed(1).padStart(10)}% ` +
        `${usable ? '  ✓' : '  ·'}`,
    )
  }
}

/**
 * 前视窗口敏感性。短期反转与中期动量在不同尺度上主导，
 * 若超额随前视窗口拉长由负转正，说明判据识别的是状态而非短期收益方向。
 */
function scanForwardHorizon(matrix: AlignedMatrix, base: MainlineThresholds): void {
  console.log('\n  ── 前视窗口敏感性（mainline 组龙头超额）──')
  console.log('  前视    样本    平均超额   中位超额   龙头跑赢率')
  for (const forward of [5, 10, 20, 40, 60, 120]) {
    const samples = backtest(matrix, base, { forward })
    const stat = statOf(
      samples.filter((s) => s.verdict === 'mainline'),
      samples.length,
    )
    console.log(
      `  ${String(forward).padStart(4)}日 ${String(stat.count).padStart(6)} ` +
        `${stat.meanExcess >= 0 ? '+' : ''}${stat.meanExcess.toFixed(2).padStart(8)}% ` +
        `${stat.medianExcess >= 0 ? '+' : ''}${stat.medianExcess.toFixed(2).padStart(8)}% ` +
        `${(stat.winRate * 100).toFixed(1).padStart(10)}%`,
    )
  }
}

/** 状态持续性：判定为 mainline 后，该状态本身是否比无条件情形更容易延续。 */
function checkStatePersistence(matrix: AlignedMatrix, base: MainlineThresholds): void {
  const samples = backtest(matrix, base).filter((s) => s.futureVerdict != null)
  if (samples.length === 0) return
  const rateOf = (subset: Sample[]) =>
    subset.length === 0
      ? 0
      : subset.filter((s) => s.futureVerdict === 'mainline').length / subset.length
  const baseRate = rateOf(samples)
  const conditional = rateOf(samples.filter((s) => s.verdict === 'mainline'))
  console.log(`\n  ── 状态持续性（${FORWARD_DAYS} 日后仍为 mainline 的比例）──`)
  console.log(`  无条件基础比例      ${(baseRate * 100).toFixed(1)}%`)
  console.log(
    `  当前已是 mainline   ${(conditional * 100).toFixed(1)}%` +
      `（提升 ${((conditional - baseRate) * 100).toFixed(1)} 个百分点）`,
  )
}

function calibrate(label: string, matrix: AlignedMatrix, base: MainlineThresholds): void {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`${label}｜${matrix.categories.length} 个板块 × ${matrix.dates.length} 个交易日`)
  console.log(`区间 ${matrix.dates[0]} → ${matrix.dates[matrix.dates.length - 1]}`)
  console.log(`观察窗口 ${CALIBRATION_WINDOW} 日，事后检验 ${FORWARD_DAYS} 日`)
  console.log('='.repeat(72))

  const samples = backtest(matrix, base)
  if (samples.length === 0) {
    console.log('  有效样本不足，跳过')
    return
  }
  console.log(`\n  现行阈值下的判定分布（有效样本 ${samples.length}）：`)
  printDistribution(samples)

  scanForwardHorizon(matrix, base)
  checkStatePersistence(matrix, base)

  scanThreshold(matrix, {
    label: 'persistenceFloor（持续性门槛）',
    key: 'persistenceFloor',
    values: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
    base,
  })
  scanThreshold(matrix, {
    label: 'leaderEdgeFloor（龙头日超额胜率门槛）',
    key: 'leaderEdgeFloor',
    values: [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75],
    base,
  })
  scanThreshold(matrix, {
    label: 'dispersionPercentileFloor（分化度分位门槛）',
    key: 'dispersionPercentileFloor',
    values: [20, 30, 40, 50, 60, 70],
    base,
  })
}

async function main() {
  const raw = await readFile(join(ROOT, 'data', 'dashboard.json'), 'utf-8')
  const dashboard = JSON.parse(raw) as DashboardData

  const styleSeries = dashboard.etfs.map((etf) => ({
    category: etf.category,
    categoryName: etf.categoryName,
    points: etf.navHistory.map((point) => ({ date: point.date, nav: point.nav })),
  }))
  const styleMatrix = alignSeries(styleSeries)
  if (styleMatrix) {
    calibrate('宽基风格口径', styleMatrix, STYLE_THRESHOLDS)
  } else {
    console.log('宽基净值序列不足，跳过风格口径标定')
  }

  if (dashboard.sectorTrend) {
    const sectorMatrix = alignSeries(sectorTrendToSeries(dashboard.sectorTrend))
    if (sectorMatrix) calibrate('行业题材口径', sectorMatrix, STYLE_THRESHOLDS)
  } else {
    console.log('\n快照中无行业板块数据，跳过题材口径标定')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
