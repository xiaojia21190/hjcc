/**
 * 抓取完整性报告：覆盖率、缺口、数据量摘要。
 */
import type { DashboardData } from '../../shared/types'

export function formatCompletenessReport(data: DashboardData): string {
  const lines: string[] = ['═══ 抓取完整性报告 ═══']
  const marketDates = data.marketActiveCapHistory.map((p) => p.date)

  let totalSseGaps = 0
  let totalSzseGaps = 0

  const marketLastDate = marketDates.length ? marketDates[marketDates.length - 1] : null
  for (const etf of data.etfs) {
    const daily = etf.scaleHistory.filter((p) => p.frequency === 'daily')
    const dailyDates = new Set(daily.map((p) => p.date))

    // 同期市场交易日（截取 ETF 日频范围内，按日期排序取首尾）
    const sortedDates = [...dailyDates].sort()
    const firstDaily = sortedDates[0]
    const lastDaily = sortedDates.at(-1)
    const expectedDates = marketDates.filter(
      (d) => (!firstDaily || d >= firstDaily) && (!lastDaily || d <= lastDaily),
    )
    const covered = expectedDates.filter((d) => dailyDates.has(d)).length
    const total = expectedDates.length
    const pct = total > 0 ? ((covered / total) * 100).toFixed(1) : '—'
    // 分母按 [首日, 最后一个daily日] 截断会漏掉交易日轴末尾尚未发布的日期，
    // 造成“该漏的当天不算漏、显示 100%”。把市场交易日轴末尾纳入分母，
    // 真实暴露 ETF 份额落后于行情末尾日的滞后。
    const tailMissing =
      marketLastDate != null && lastDaily != null && lastDaily < marketLastDate
        ? marketDates.filter((d) => d > lastDaily).length
        : 0
    const warn = (total > 0 && covered / total < 0.95) || tailMissing > 0 ? ' ⚠' : ''

    // 缺口
    const gaps = etf.source.shareFetchGaps
    const gapParts: string[] = []
    if (gaps?.sseFailedDates?.length) {
      totalSseGaps += gaps.sseFailedDates.length
      const shown = gaps.sseFailedDates.slice(0, 10)
      const extra = gaps.sseFailedDates.length - shown.length
      gapParts.push(...shown)
      if (extra > 0) gapParts.push(`…等 ${extra + shown.length} 个`)
    }
    if (gaps?.sseEmptyDates?.length) {
      totalSseGaps += gaps.sseEmptyDates.length
      gapParts.push(`未发布 ${gaps.sseEmptyDates.join(',')}`)
    }
    if (gaps?.szseFailedRanges?.length) {
      totalSzseGaps += gaps.szseFailedRanges.length
      const shown = gaps.szseFailedRanges.slice(0, 10)
      const extra = gaps.szseFailedRanges.length - shown.length
      gapParts.push(...shown)
      if (extra > 0) gapParts.push(`…等 ${extra + shown.length} 个`)
    }
    if (gaps?.szseEmptyDates?.length) {
      totalSzseGaps += gaps.szseEmptyDates.length
      gapParts.push(`未发布 ${gaps.szseEmptyDates.join(',')}`)
    }

    const gapStr = gapParts.length ? gapParts.join(', ') : '无'
    const tailStr = tailMissing > 0 ? ` · 末尾缺 ${tailMissing} 日 (${lastDaily} → ${marketLastDate})` : ''
    lines.push(
      `${etf.categoryName.padEnd(5)} ${etf.code}  日频 ${covered}/${total} (${pct}%)${warn}  缺口: ${gapStr}${tailStr}`,
    )
  }

  // 持有人报告
  const reportCounts = data.etfs.map((e) => e.holderReports.length)
  const reportDates = [...new Set(data.etfs.flatMap((e) => e.holderReports.map((r) => r.reportDate)))]
  lines.push(
    `持有人报告: ${data.etfs.length}/${data.etfs.length} 只各 ${Math.min(...reportCounts)} 期 (${reportDates.join(', ')})`,
  )

  // 净值
  const navCounts = data.etfs.map((e) => e.navHistory.length)
  lines.push(`净值: ${data.etfs.length}/${data.etfs.length} 只 ≥${Math.min(...navCounts)} 条`)

  // 0AMV
  const mkt = data.marketActiveCapHistory
  lines.push(
    `0AMV: ${mkt.length} 条 (${mkt[0]?.date ?? '—'} → ${mkt.at(-1)?.date ?? '—'})`,
  )

  // 行业板块：抓取失败会沿用上次快照，这里要能看出数据是否陈旧
  const sector = data.sectorTrend
  lines.push(
    sector
      ? `行业板块: ${sector.sectors.length} 只 × ${sector.dates.length} 个交易日 ` +
        `(${sector.dates[0] ?? '—'} → ${sector.dates.at(-1) ?? '—'})`
      : '行业板块: 无数据 ⚠ 题材主线判定不可用',
  )

  // 缺口合计
  lines.push(`缺口合计: ${totalSseGaps} 日 (SSE) / ${totalSzseGaps} 段 (SZSE)`)

  return lines.join('\n')
}
