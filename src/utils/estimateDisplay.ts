/**
 * 汇金估算的前端展示辅助：区间文案与「低分辨」判定。
 * 不改估算公式，只决定怎么诚实展示 floor/ceil。
 */
import type { HuijinEstimatePoint } from '../../shared/types'
import { formatYi } from './format'

/** 区间宽度占当日总份额的比例达到此值，视为低分辨（点估计不可依赖）。 */
export const LOW_RESOLUTION_WIDTH_RATIO = 0.3

export interface EstimateRangeYi {
  /** 展示点（加权），亿份 */
  point: number
  floor: number
  ceil: number
  /** 当日基金总份额，亿份 */
  total: number
  /** (ceil - floor) / total */
  widthRatio: number
  lowResolution: boolean
}

/** 从 anchored 点提取亿份区间；字段不全则 null。 */
export function estimateRangeYi(
  point: Pick<
    HuijinEstimatePoint,
    'huijinShares' | 'huijinSharesFloor' | 'huijinSharesCeil' | 'totalSharesYi'
  > | null | undefined,
): EstimateRangeYi | null {
  if (
    point?.huijinShares == null ||
    point.huijinSharesFloor == null ||
    point.huijinSharesCeil == null ||
    !(point.totalSharesYi > 0)
  ) {
    return null
  }
  const floor = point.huijinSharesFloor
  const ceil = point.huijinSharesCeil
  const total = point.totalSharesYi
  const widthRatio = Math.max(0, (ceil - floor) / total)
  return {
    point: point.huijinShares / 1e8,
    floor,
    ceil,
    total,
    widthRatio,
    lowResolution: widthRatio >= LOW_RESOLUTION_WIDTH_RATIO,
  }
}

/** 「22.63（4.78~58.33）亿份」；无区间时退回单点。 */
export function formatEstimateSharesRange(range: EstimateRangeYi | null): string {
  if (!range) return '—'
  return `${range.point.toFixed(2)}（${range.floor.toFixed(2)}~${range.ceil.toFixed(2)}）亿份`
}

/**
 * 估值区间（亿元）≈ 份额区间 × (展示估值/展示份额)。
 * 无净值或份额为 0 时只返回展示点文案。
 */
export function formatEstimateValueRange(
  valueYi: number | null | undefined,
  range: EstimateRangeYi | null,
): string {
  if (valueYi == null || !Number.isFinite(valueYi)) return '—'
  if (!range || range.point <= 0) return formatYi(valueYi)
  const px = valueYi / range.point
  const floorYi = range.floor * px
  const ceilYi = range.ceil * px
  return `${formatYi(valueYi)}（${floorYi.toFixed(2)}~${ceilYi.toFixed(2)}）`
}

export function lowResolutionLabel(range: EstimateRangeYi | null): string | null {
  if (!range?.lowResolution) return null
  return `低分辨 · 区间宽 ${(range.widthRatio * 100).toFixed(0)}% 总份额`
}

export function estimateTooltip(
  range: EstimateRangeYi | null,
  valueYi?: number | null,
): string {
  if (!range) return '无可用占比区间'
  const parts = [
    `展示 ${range.point.toFixed(2)} 亿份（下界×2/3 + 上界×1/3）`,
    `区间 ${range.floor.toFixed(2)}~${range.ceil.toFixed(2)} 亿份`,
  ]
  if (valueYi != null && Number.isFinite(valueYi) && range.point > 0) {
    const px = valueYi / range.point
    parts.push(
      `估值约 ${valueYi.toFixed(2)}（${(range.floor * px).toFixed(2)}~${(range.ceil * px).toFixed(2)}）亿`,
    )
  }
  parts.push('下界=份额变动全归因汇金；上界=披露占比不变')
  if (range.lowResolution) {
    parts.push(lowResolutionLabel(range)!)
  }
  return parts.join(' · ')
}
