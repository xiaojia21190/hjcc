/**
 * 散户情绪反向的度量层：其他资金份额序列与总份额净申购率。
 * 只产出数字，不做任何阈值判定——判定逻辑见 retailSignals.ts。
 * 「其他资金」= 非汇金全体（散户、机构、游资），散户只是主要成分之一。
 */
import type { EtfSnapshot, HuijinEstimatePoint, ScalePoint } from '../../shared/types'

/** 其他资金份额点，单位亿份；仅 anchored/disclosed 点有拆分值。 */
export interface OtherCapitalPoint {
  date: string
  /** 总份额 − 汇金点估计；无拆分口径时为 null。 */
  otherYi: number | null
  /** 其他下界 = 总份额 − 汇金上界；无区间时为 null。 */
  floorYi: number | null
  /** 其他上界 = 总份额 − 汇金下界；无区间时为 null。 */
  ceilYi: number | null
  /** 当日总份额（亿份），始终有值。 */
  totalYi: number
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

/** 从估算序列构造其他资金份额序列；unavailable 点产出 null 拆分。 */
export function otherCapitalSeries(
  etf: Pick<EtfSnapshot, 'huijinEstimateHistory'>,
): OtherCapitalPoint[] {
  return etf.huijinEstimateHistory.map((point: HuijinEstimatePoint) => {
    const total = point.totalSharesYi
    const sharesYi =
      point.huijinShares != null && Number.isFinite(point.huijinShares)
        ? point.huijinShares / 1e8
        : null
    return {
      date: point.date,
      otherYi: sharesYi != null && total > 0 ? round6(total - sharesYi) : null,
      floorYi:
        point.huijinSharesCeil != null && total > 0
          ? round6(total - point.huijinSharesCeil)
          : null,
      ceilYi:
        point.huijinSharesFloor != null && total > 0
          ? round6(total - point.huijinSharesFloor)
          : null,
      totalYi: total,
    }
  })
}

/** 日净申购率点（%），ratePct = 净变化 / 前一日总份额 × 100。 */
export interface NetSubRatePoint {
  date: string
  ratePct: number | null
}

/**
 * 构造日频净申购率序列：仅取 frequency === 'daily' 的点，
 * 净变化缺失或前一日总份额非正时 ratePct 为 null。
 */
export function netSubscriptionRateSeries(history: ScalePoint[]): NetSubRatePoint[] {
  const daily = history.filter((p) => p.frequency === 'daily')
  const out: NetSubRatePoint[] = []
  for (let i = 0; i < daily.length; i++) {
    const point = daily[i]!
    const ratePct =
      i > 0 &&
      point.netSubscriptionYi != null &&
      daily[i - 1]!.totalSharesYi > 0
        ? round6((point.netSubscriptionYi / daily[i - 1]!.totalSharesYi) * 100)
        : null
    out.push({ date: point.date, ratePct })
  }
  return out
}

/**
 * 最近 N 个交易日净申购率加总（%）。
 * 日率量级通常 < 1%，加总与复利合成差异 < 0.01pp，取更可解释的加总。
 * 样本不足 N 或序列为空时返回 null；窗口内 null 视为 0（缺数据≠零申赎，
 * 但中断累计会把缺失日之后的所有窗口永久作废，取舍后按 0 处理）。
 */
export function cumulativeNetSubRatePct(
  rates: NetSubRatePoint[],
  days: number,
): number | null {
  if (rates.length < days) return null
  return round6(
    rates.slice(-days).reduce((sum, r) => sum + (r.ratePct ?? 0), 0),
  )
}
