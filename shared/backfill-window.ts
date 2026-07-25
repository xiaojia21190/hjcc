/**
 * 计算交易所日频总份额的回填/增量抓取日期窗口。
 * 窗口下界 = max(最近汇金披露日, 已有末尾日 - overlap)，确保披露日落在日频区间内。
 */
export interface OfficialDailySharePointLite {
  date: string
  totalSharesYi: number
  shareSource: 'sse' | 'szse'
}

export interface ComputeFetchDatesArgs {
  existing: OfficialDailySharePointLite[]
  marketDates: string[]
  /** 最近一期汇金披露日（如 '2025-12-31'）；无披露时传 null */
  latestHuijinReportDate: string | null
  overlap: number
  /** 回填起点（如 '2024-01-01'）；existing 最早日期晚于此值时触发全段回填 */
  backfillStart?: string
}

export function computeOfficialFetchDates({
  existing,
  marketDates,
  latestHuijinReportDate,
  overlap,
  backfillStart,
}: ComputeFetchDatesArgs): string[] {
  const dates = marketDates.length ? [...marketDates].sort() : []
  if (!dates.length) return []

  // 全段回填判断：existing 为空或最早日期晚于 backfillStart 之后的首个市场交易日
  const earliestExisting = existing[0]?.date
  if (backfillStart != null) {
    const firstExpectedIdx = dates.findIndex((d) => d >= backfillStart)
    const firstExpected = firstExpectedIdx >= 0 ? dates[firstExpectedIdx] : null
    if (
      existing.length === 0 ||
      (firstExpected != null && earliestExisting != null && earliestExisting > firstExpected)
    ) {
      return dates.slice(firstExpectedIdx >= 0 ? firstExpectedIdx : 0)
    }
  }

  const latestExisting = existing.at(-1)?.date
  // 窗口下界候选：已有末尾 - overlap
  let lowerBound: string | null = null
  if (latestExisting) {
    const nextIndex = dates.findIndex((d) => d > latestExisting)
    const anchor = nextIndex >= 0 ? nextIndex : dates.length - 1
    const startIdx = Math.max(0, anchor - overlap)
    lowerBound = dates[startIdx]!
  }

  // 披露日约束：窗口必须覆盖披露日（若披露日在 marketDates 范围内或之前）
  if (latestHuijinReportDate) {
    if (!lowerBound || latestHuijinReportDate < lowerBound) {
      // 披露日早于下界 → 找到 marketDates 中 >= 披露日 的最早位置，向前 overlap
      const idx = dates.findIndex((d) => d >= latestHuijinReportDate)
      if (idx >= 0) {
        lowerBound = dates[Math.max(0, idx - overlap)]!
      } else {
        // 披露日晚于所有 marketDates，回填整段（罕见）
        lowerBound = dates[0]!
      }
    }
  }

  if (!lowerBound) {
    // 首次回填且无披露约束 → 全部
    return dates
  }
  const startIdx = dates.findIndex((d) => d >= lowerBound)
  return dates.slice(startIdx >= 0 ? startIdx : 0)
}
