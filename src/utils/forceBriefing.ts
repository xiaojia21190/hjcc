/**
 * 主力规则简报：把三闸门判决和份额路径收成可扫读短评。
 * 不调用模型，不识别持有人，禁止「汇金买入/卖出」。
 */
import {
  DISCLAIMER,
  judgeHuijinForce,
  type FlowTone,
  type ForceEtfInput,
  type ForceMarketInput,
  type ForceTier,
  type ForceVerdict,
} from './forceVerdict'

export const QUIET_ABS_PCT_5D = 3
export const QUIET_CONSECUTIVE_DAYS = 3

export interface BriefingEtfInput extends ForceEtfInput {
  lastSharesYi: number | null
  sharesYi5dAgo: number | null
  quotePrice: number | null
}

export interface ForceBriefing {
  headline: string
  lead: string
  path: string
  intent: string | null
  bullets: string[]
  cautions: string[]
  disclaimer: string
  tone: FlowTone
  tier: ForceTier
}

function signedPct(value: number): string {
  const text = `${value.toFixed(2)}%`
  return value > 0 ? `+${text}` : text
}

function meanPricePct(etfs: BriefingEtfInput[]): number | null {
  const values = etfs
    .map((row) => row.priceChangePct5d)
    .filter((value): value is number => value != null)
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function capitalYi(row: BriefingEtfInput): number | null {
  if (row.lastSharesYi == null || row.sharesYi5dAgo == null) return null
  if (row.quotePrice == null || !(row.quotePrice > 0)) return null
  return (row.lastSharesYi - row.sharesYi5dAgo) * row.quotePrice
}

function countFlow(etfs: BriefingEtfInput[]) {
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

function countLine(etfs: BriefingEtfInput[], tone: FlowTone): string {
  const counts = countFlow(etfs)
  if (counts.known === 0) return '无有效流向'
  if (tone === 'inflow') return `${counts.inflow}/${counts.known} 只净流入`
  if (tone === 'outflow') return `${counts.outflow}/${counts.known} 只净流出`
  return `${counts.inflow}入/${counts.outflow}出/${counts.flat}平`
}

function moveScore(row: BriefingEtfInput): number {
  const yi = capitalYi(row)
  if (yi != null) return Math.abs(yi)
  return Math.abs(row.shareChangePct5d ?? 0)
}

function rankedByMove(etfs: BriefingEtfInput[]): BriefingEtfInput[] {
  return [...etfs].sort((a, b) => moveScore(b) - moveScore(a))
}

function isQuiet(row: BriefingEtfInput): boolean {
  const pct = row.shareChangePct5d
  const smallMove = pct == null || Math.abs(pct) < QUIET_ABS_PCT_5D
  return smallMove && row.consecutiveDays < QUIET_CONSECUTIVE_DAYS
}

function describeLeg(row: BriefingEtfInput): string {
  const parts = [row.categoryName]
  if (row.shareChangePct5d != null) parts.push(`5日 ${signedPct(row.shareChangePct5d)}`)
  if (row.consecutiveDays > 0 && row.shareTrend !== 'flat') {
    parts.push(`连续${row.consecutiveDays}日`)
  }
  const yi = capitalYi(row)
  if (yi != null) parts.push(`约${yi > 0 ? '+' : ''}${yi.toFixed(0)}亿`)
  return parts.join('，')
}

function composeHeadline(verdict: ForceVerdict): string {
  return verdict.intent ? `${verdict.label} · ${verdict.intent}` : verdict.label
}

function composeLead(verdict: ForceVerdict, etfs: BriefingEtfInput[]): string {
  return `${countLine(etfs, verdict.tone)}。${verdict.detail}。`
}

function composePath(verdict: ForceVerdict, etfs: BriefingEtfInput[]): string {
  if (verdict.tier === 'other') {
    return '篮子内进出对倒，更像风格再平衡；篮子外去向未知。'
  }
  if (verdict.tone !== 'inflow' && verdict.tone !== 'outflow') {
    return '篮子内方向不统一，不输出单一去向。'
  }
  const role = verdict.tone === 'outflow' ? '主出口' : '主入口'
  const top = rankedByMove(etfs.filter((row) => row.shareTrend === verdict.tone)).slice(0, 2)
  const quiet = etfs.filter(isQuiet).map((row) => row.categoryName)
  const chunks: string[] = []
  chunks.push(top.length > 0 ? `${role}：${top.map(describeLeg).join('；')}。` : `监测篮子整体${role === '主出口' ? '净流出' : '净流入'}。`)
  if (quiet.length > 0) chunks.push(`${quiet.join('、')}几乎没动。`)
  if (verdict.gates.alternative.status === 'pass') chunks.push('未见篮子内对倒。')
  chunks.push('篮子外去向未知。')
  return chunks.join('')
}

function composeIntent(
  verdict: ForceVerdict,
  etfs: BriefingEtfInput[],
): string | null {
  if (!verdict.intent) return null
  if (verdict.tier === 'other') return verdict.intent
  const price = meanPricePct(etfs)
  if (price == null) return verdict.intent
  if (verdict.tone === 'outflow' && price > 0) {
    return `${verdict.intent}。5日净值等权${signedPct(price)}，价升份额缩。`
  }
  if (verdict.tone === 'inflow' && price <= 0) {
    return `${verdict.intent}。5日净值等权${signedPct(price)}，价跌份额增。`
  }
  return `${verdict.intent}。5日净值等权${signedPct(price)}。`
}

function composeBullets(
  etfs: BriefingEtfInput[],
  market: ForceMarketInput,
): string[] {
  const lines = rankedByMove(etfs).slice(0, 3).map((row) => {
    const dir =
      row.shareTrend === 'inflow' ? '流入' : row.shareTrend === 'outflow' ? '流出' : '平坦'
    const pct = row.shareChangePct5d == null ? '—' : signedPct(row.shareChangePct5d)
    return `${row.categoryName}：${dir}，连续${row.consecutiveDays}日，5日 ${pct}`
  })
  if (market.activeCapYi != null && market.referenceMaYi != null) {
    const vs = market.activeCapYi >= market.referenceMaYi ? '高于' : '低于'
    lines.push(`0AMV ${market.activeCapYi.toFixed(0)} 亿，${vs}参考线。`)
  }
  return lines
}

function composeCautions(verdict: ForceVerdict, etfs: BriefingEtfInput[]): string[] {
  const extra = etfs
    .filter((row) => !row.hasHuijinDisclosure)
    .map((row) => row.categoryName)
  const lines = [...verdict.cautions]
  if (extra.length > 0) lines.push(`${extra.join('、')}无汇金披露，只作对照`)
  return lines
}

export function composeForceBriefing(
  etfs: BriefingEtfInput[],
  market: ForceMarketInput = { activeCapYi: null, referenceMaYi: null },
): ForceBriefing {
  const verdict = judgeHuijinForce(etfs, market)
  return {
    headline: composeHeadline(verdict),
    lead: composeLead(verdict, etfs),
    path: composePath(verdict, etfs),
    intent: composeIntent(verdict, etfs),
    bullets: composeBullets(etfs, market),
    cautions: composeCautions(verdict, etfs),
    disclaimer: DISCLAIMER,
    tone: verdict.tone,
    tier: verdict.tier,
  }
}
