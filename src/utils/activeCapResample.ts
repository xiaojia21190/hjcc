import type { MarketActiveCapPoint } from '../../shared/types'

export type Timeframe = 'daily' | 'weekly' | 'monthly'

/** ISO 周标签：yyyy-Www，跨年自动区分 */
/** ISO 周标签：yyyy-Www（1 月 4 日所在周恒为 W01），跨年自动区分 */
function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3) // 移到本周周四（ISO 周由周四定年）
  const year = d.getUTCFullYear()
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/**
 * 把日线序列聚合为周线 / 月线：
 * - 活筹（level 量）取周期末值，0AMV 本身已是一阶平滑量，末值即周期估计
 * - 成交额（流量）取周期合计
 * - 指数取周期末收盘
 * - 周期不完整（末周/末月尚未走完）时在标签上标注，避免与完整周期误读
 */
export function resampleActiveCap(
  history: MarketActiveCapPoint[],
  timeframe: Timeframe,
): MarketActiveCapPoint[] {
  if (timeframe === 'daily' || history.length === 0) return history
  const groupOf = (date: string) =>
    timeframe === 'weekly' ? isoWeekKey(date) : date.slice(0, 7)

  const out: MarketActiveCapPoint[] = []
  for (const point of history) {
    const key = groupOf(point.date)
    const last = out.at(-1)
    if (last != null && last.date === key) {
      last.activeCapYi = point.activeCapYi
      last.marketIndex = point.marketIndex
      last.marketAmountYi = Number((last.marketAmountYi + point.marketAmountYi).toFixed(2))
      last.referenceMaYi = point.referenceMaYi
    } else {
      out.push({ ...point, date: key })
    }
  }

  const completed = (key: string) =>
    timeframe === 'weekly'
      ? isoWeekKey(history.at(-1)!.date) !== key
      : key < history.at(-1)!.date.slice(0, 7)
  return out.map((point) =>
    completed(point.date) ? point : { ...point, date: `${point.date}（未走完）` },
  )
}
