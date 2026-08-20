import { fetchJson, sleep } from './http'

export interface OfficialDailySharePoint {
  date: string
  totalSharesYi: number
  shareSource: 'sse' | 'szse'
}

interface SseScaleResponse {
  result?: Array<{
    STAT_DATE?: string
    SEC_CODE?: string
    TOT_VOL?: string | number
  }>
}

export async function fetchSseDailyShares(
  codes: string[],
  dates: string[],
): Promise<{ points: Map<string, OfficialDailySharePoint[]>; failedDates: string[]; emptyDates: string[] }> {
  const wanted = new Set(codes)
  const fetched = new Map(codes.map((code) => [code, [] as OfficialDailySharePoint[]]))
  const failedDates: string[] = []
  // 交易所返回 HTTP 200 但当日 result 为空（份额尚未发布）的日期；
  // 与 HTTP 失败的 failedDates 区分，便于下一次抓取窗口识别并重试。
  const emptyDates: string[] = []
  for (let start = 0; start < dates.length; start += 3) {
    const batch = dates.slice(start, start + 3)
    await Promise.all(
      batch.map(async (date) => {
        const params = new URLSearchParams({
          sqlId: 'COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L',
          isPagination: 'true',
          'pageHelp.pageSize': '10000',
          'pageHelp.pageNo': '1',
          'pageHelp.beginPage': '1',
          'pageHelp.endPage': '1',
          STAT_DATE: date,
        })
        let ok = false
        let returnedRows = 0
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const json = await fetchJson<SseScaleResponse>(
              `https://query.sse.com.cn/commonQuery.do?${params}`,
              'https://www.sse.com.cn/assortment/fund/etf/list/scale/',
            )
            const rows = json.result ?? []
            returnedRows = rows.length
            for (const row of rows) {
              const code = String(row.SEC_CODE ?? '')
              if (!wanted.has(code)) continue
              const sharesWan = Number(String(row.TOT_VOL ?? '').replace(/,/g, ''))
              if (!Number.isFinite(sharesWan) || sharesWan < 0) continue
              fetched.get(code)?.push({
                date: String(row.STAT_DATE ?? date).slice(0, 10),
                totalSharesYi: Number((sharesWan / 10000).toFixed(6)),
                shareSource: 'sse',
              })
            }
            ok = true
            break
          } catch (error) {
            if (attempt === 4) console.warn(`  上交所 ETF 份额 ${date} 抓取失败`, error)
            await sleep(400 * 2 ** attempt)
          }
        }
        if (!ok) failedDates.push(date)
        else if (returnedRows === 0) emptyDates.push(date)
      }),
    )
    await sleep(80)
  }
  return { points: fetched, failedDates, emptyDates }
}
