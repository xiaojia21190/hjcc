/**
 * 汇金主力三闸门判决。纯函数，不识别持有人，不构成投资建议。
 */
import type { SignalSummary } from './signals'

export const MIN_CONSECUTIVE_STRONG = 3
export const MIN_SIDE_CONSECUTIVE_OTHER = 2
export const MIN_ABS_PCT_5D_OTHER = 2

export const DISCLAIMER =
  '不能识别持有人 · 只描述份额结构 · 不构成投资建议'

export const TIER_LABEL = {
  credible: '可采信',
  weak: '弱支持',
  uncertain: '无法判断',
  other: '更像其他资金',
} as const

export type ForceTier = keyof typeof TIER_LABEL
export type FlowTone = SignalSummary['tone']
export type Gate1Status = 'pass' | 'fail'
export type Gate2Status = 'strong' | 'weak' | 'fail'
export type Gate3Status = 'pass' | 'unresolved' | 'other'
export type FlowSide = 'inflow' | 'outflow'

export interface ForceEtfInput {
  categoryName: string
  hasHuijinDisclosure: boolean
  shareTrend: 'inflow' | 'outflow' | 'flat' | null
  consecutiveDays: number
  shareChangePct5d: number | null
  shareDate: string | null
  priceChangePct5d: number | null
  lowResolution: boolean
}

export interface ForceMarketInput {
  activeCapYi: number | null
  referenceMaYi: number | null
}

export interface ForceGate<S extends string> {
  status: S
  label: string
  reason: string
}

export interface ForceVerdict {
  tier: ForceTier
  label: string
  tone: FlowTone
  gates: {
    object: ForceGate<Gate1Status>
    structure: ForceGate<Gate2Status>
    alternative: ForceGate<Gate3Status>
  }
  intent: string | null
  detail: string
  cautions: string[]
  disclaimer: string
}

interface StructureResult {
  gate: ForceGate<Gate2Status>
  tone: FlowTone
  detail: string
}

function countTrends(etfs: ForceEtfInput[]) {
  let inflow = 0
  let outflow = 0
  let flat = 0
  for (const row of etfs) {
    if (row.shareTrend === 'inflow') inflow += 1
    else if (row.shareTrend === 'outflow') outflow += 1
    else if (row.shareTrend === 'flat') flat += 1
  }
  return { inflow, outflow, flat, known: inflow + outflow + flat }
}

function majorityOf(counts: ReturnType<typeof countTrends>): FlowSide | null {
  if (counts.inflow > counts.outflow && counts.inflow > counts.flat) return 'inflow'
  if (counts.outflow > counts.inflow && counts.outflow > counts.flat) return 'outflow'
  return null
}

function activeRows(etfs: ForceEtfInput[]): ForceEtfInput[] {
  return etfs.filter((row) => row.shareTrend === 'inflow' || row.shareTrend === 'outflow')
}

function longestStreak(etfs: ForceEtfInput[]) {
  const active = activeRows(etfs)
  if (active.length === 0) return { days: 0, dirs: new Set<string>(), names: [] as string[] }
  const days = Math.max(...active.map((row) => row.consecutiveDays))
  const top = active.filter((row) => row.consecutiveDays === days)
  return { days, dirs: new Set(top.map((row) => row.shareTrend)), names: top.map((row) => row.categoryName) }
}

function maxAbs5d(etfs: ForceEtfInput[]): ForceEtfInput | null {
  const ranked = etfs.filter((row) => row.shareChangePct5d != null)
  if (ranked.length === 0) return null
  return ranked.reduce((best, row) =>
    Math.abs(row.shareChangePct5d!) > Math.abs(best.shareChangePct5d!) ? row : best,
  )
}

function fiveDayAgrees(etfs: ForceEtfInput[], tone: FlowSide): boolean | null {
  const best = maxAbs5d(etfs)
  const pct = best?.shareChangePct5d
  if (pct == null || pct === 0) return null
  return tone === 'inflow' ? pct > 0 : pct < 0
}

function judgeObject(etfs: ForceEtfInput[]): ForceGate<Gate1Status> {
  if (etfs.length === 0) return { status: 'fail', label: '对象未过', reason: '无监测 ETF' }
  if (!etfs.some((row) => row.hasHuijinDisclosure)) {
    return { status: 'fail', label: '对象未过', reason: '无汇金披露锚点' }
  }
  if (!etfs.some((row) => row.shareTrend != null)) {
    return { status: 'fail', label: '对象未过', reason: '无日频份额流向' }
  }
  return { status: 'pass', label: '对象过', reason: '有披露且有日频份额' }
}

function singleLegStructure(etfs: ForceEtfInput[], streak: ReturnType<typeof longestStreak>): StructureResult | null {
  const sides = new Set(activeRows(etfs).map((row) => row.shareTrend))
  if (sides.size !== 1 || streak.days < MIN_CONSECUTIVE_STRONG) return null
  const tone = [...sides][0] as FlowSide
  const name = streak.names[0] ?? activeRows(etfs)[0]!.categoryName
  return {
    gate: { status: 'weak', label: '结构弱', reason: `仅${name}连续${streak.days}日` },
    tone,
    detail: `仅${name}连续${streak.days}日，覆盖面不够，属单腿`,
  }
}

function majorityStructure(etfs: ForceEtfInput[], majority: FlowSide): StructureResult {
  const streak = longestStreak(etfs)
  const conflict = streak.dirs.size !== 1 || !streak.dirs.has(majority)
  if (conflict) {
    return {
      gate: { status: 'weak', label: '结构弱', reason: '最长连续与多数方向不一致' },
      tone: majority,
      detail: '多数同向，但最长连续与多数方向不一致',
    }
  }
  if (fiveDayAgrees(etfs, majority) === false) {
    return {
      gate: { status: 'weak', label: '结构弱', reason: '5日幅度与多数方向不一致' },
      tone: majority,
      detail: '多数同向，但持续方向与5日幅度不一致',
    }
  }
  if (streak.days < MIN_CONSECUTIVE_STRONG) {
    return {
      gate: { status: 'weak', label: '结构弱', reason: `多数同向但连续不足${MIN_CONSECUTIVE_STRONG}日` },
      tone: majority,
      detail: `多数同向但连续不足${MIN_CONSECUTIVE_STRONG}日`,
    }
  }
  return {
    gate: { status: 'strong', label: '结构强', reason: `多数同向且连续${streak.days}日` },
    tone: majority,
    detail: `多数同向且连续${streak.days}日，幅度方向一致`,
  }
}

function judgeStructure(etfs: ForceEtfInput[]): StructureResult {
  const counts = countTrends(etfs)
  if (counts.known === 0) {
    return {
      gate: { status: 'fail', label: '结构未过', reason: '无日频份额流向' },
      tone: 'none',
      detail: '无日频份额序列',
    }
  }
  const majority = majorityOf(counts)
  if (!majority) {
    return (
      singleLegStructure(etfs, longestStreak(etfs)) ?? {
        gate: { status: 'fail', label: '结构未过', reason: '有进有出，无多数' },
        tone: 'mixed',
        detail: '有进有出，构不成统一篮子',
      }
    )
  }
  return majorityStructure(etfs, majority)
}

function judgeAlternative(etfs: ForceEtfInput[], structure: Gate2Status): ForceGate<Gate3Status> {
  if (structure !== 'fail') return { status: 'pass', label: '替代解释过', reason: '未见对倒腿' }
  const ranked = [...etfs]
    .filter((row) => row.shareChangePct5d != null)
    .sort((a, b) => Math.abs(b.shareChangePct5d!) - Math.abs(a.shareChangePct5d!))
  const first = ranked[0]?.shareChangePct5d
  const second = ranked[1]?.shareChangePct5d
  if (
    first != null &&
    second != null &&
    Math.sign(first) !== Math.sign(second) &&
    Math.abs(first) >= MIN_ABS_PCT_5D_OTHER &&
    Math.abs(second) >= MIN_ABS_PCT_5D_OTHER
  ) {
    return { status: 'other', label: '更像其他资金', reason: '最大两只5日变化反向' }
  }
  const inMax = Math.max(0, ...etfs.filter((row) => row.shareTrend === 'inflow').map((row) => row.consecutiveDays))
  const outMax = Math.max(0, ...etfs.filter((row) => row.shareTrend === 'outflow').map((row) => row.consecutiveDays))
  if (inMax >= MIN_SIDE_CONSECUTIVE_OTHER && outMax >= MIN_SIDE_CONSECUTIVE_OTHER) {
    return { status: 'other', label: '更像其他资金', reason: '两侧均连续≥2日' }
  }
  return { status: 'unresolved', label: '替代解释未排掉', reason: '混合流向，尚不足以认定再平衡' }
}

function combineTier(object: Gate1Status, structure: Gate2Status, alternative: Gate3Status): ForceTier {
  if (object === 'fail') return 'uncertain'
  if (alternative === 'other') return 'other'
  if (structure === 'fail') return 'uncertain'
  return structure === 'strong' ? 'credible' : 'weak'
}

function meanPricePct(etfs: ForceEtfInput[]): number | null {
  const values = etfs
    .map((row) => row.priceChangePct5d)
    .filter((value): value is number => value != null)
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function inferIntent(
  tier: ForceTier,
  tone: FlowTone,
  etfs: ForceEtfInput[],
  market: ForceMarketInput,
): string | null {
  if (tier === 'other') return '更像风格再平衡，不输出单一意图'
  if ((tier !== 'credible' && tier !== 'weak') || (tone !== 'inflow' && tone !== 'outflow')) return null
  const price = meanPricePct(etfs)
  if (price == null) return null
  const amvStrong =
    market.activeCapYi != null &&
    market.referenceMaYi != null &&
    market.activeCapYi >= market.referenceMaYi
  const amvWeak =
    market.activeCapYi != null &&
    market.referenceMaYi != null &&
    market.activeCapYi < market.referenceMaYi
  if (tone === 'inflow') {
    if (price <= 0) return '更像托底/接飞刀'
    return amvStrong ? '更像加仓或抬流动性' : '更像加仓，环境未确认'
  }
  if (price > 0) return '更像逢高减磅'
  return amvWeak ? '更像撤离' : '更像减仓，环境未确认'
}

function collectCautions(etfs: ForceEtfInput[], structure: ForceGate<Gate2Status>): string[] {
  const lines: string[] = []
  if (etfs.some((row) => row.lowResolution)) lines.push('估算低分辨，水平值不可用')
  const dates = new Set(etfs.map((row) => row.shareDate).filter((date): date is string => !!date))
  if (dates.size > 1) lines.push('份额日期不一致')
  if (structure.reason.includes('最长连续')) lines.push('最长连续与多数方向不一致')
  return lines
}

export function judgeHuijinForce(
  etfs: ForceEtfInput[],
  market: ForceMarketInput = { activeCapYi: null, referenceMaYi: null },
): ForceVerdict {
  const object = judgeObject(etfs)
  const structure = judgeStructure(etfs)
  const alternative = judgeAlternative(etfs, structure.gate.status)
  const tier = combineTier(object.status, structure.gate.status, alternative.status)
  return {
    tier,
    label: TIER_LABEL[tier],
    tone: structure.tone,
    gates: { object, structure: structure.gate, alternative },
    intent: inferIntent(tier, structure.tone, etfs, market),
    detail:
      tier === 'other'
        ? alternative.reason.includes('两侧')
          ? '两侧都有持续流向，更像再平衡'
          : '最大两只5日变化反向，更像再平衡'
        : structure.detail,
    cautions: collectCautions(etfs, structure.gate),
    disclaimer: DISCLAIMER,
  }
}
