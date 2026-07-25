import { mergeOfficialPoints } from '../lib/merge'
import { fetchJson, sleep } from './http'
import type { OfficialDailySharePoint } from './sse'

interface SzseScaleRow {
  size_date?: string
  fund_code?: string
  current_size?: string | number
}

interface SzseScaleResponse {
  data?: SzseScaleRow | SzseScaleRow[] | null
  metadata?: {
    pagecount?: number
  }
  error?: string | null
}

export function splitDateRanges(start: string, end: string): Array<[string, string]> {
  const ranges: Array<[string, string]> = []
  let cursor = new Date(`${start}T00:00:00Z`)
  const final = new Date(`${end}T00:00:00Z`)
  while (cursor <= final) {
    const rangeEnd = new Date(cursor)
    rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 169)
    if (rangeEnd > final) rangeEnd.setTime(final.getTime())
    ranges.push([
      cursor.toISOString().slice(0, 10),
      rangeEnd.toISOString().slice(0, 10),
    ])
    cursor = new Date(rangeEnd)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return ranges
}

export function normalizeSzseRows(data: SzseScaleResponse['data']): SzseScaleRow[] {
  if (!data) return []
  return Array.isArray(data) ? data : [data]
}

export async function fetchSzseDailyShares(
  code: string,
  startDate: string,
  endDate: string,
): Promise<{ points: OfficialDailySharePoint[]; failedRanges: string[] }> {
  const points: OfficialDailySharePoint[] = []
  const failedRanges: string[] = []
  for (const [rangeStart, rangeEnd] of splitDateRanges(startDate, endDate)) {
    let page = 1
    let pageCount = 1
    let rangeFullyFailed = false
    do {
      const params = new URLSearchParams({
        SHOWTYPE: 'JSON',
        CATALOGID: 'scsj_fund_jjgm',
        jjlb: 'ETF',
        txtDm: code,
        txtStart: rangeStart,
        txtEnd: rangeEnd,
        PAGENO: String(page),
      })
      let pageOk = false
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const response = await fetchJson<SzseScaleResponse | SzseScaleResponse[]>(
            `https://www.szse.cn/api/report/ShowReport/data?${params}`,
            'https://www.szse.cn/market/fund/volume/etf/index.html',
          )
          const json = Array.isArray(response) ? response[0] : response
          if (!json) throw new Error('深交所规模接口返回空数组')
          if (json.error) throw new Error(json.error)
          pageCount = Math.max(1, Number(json.metadata?.pagecount) || 1)
          for (const row of normalizeSzseRows(json.data)) {
            if (String(row.fund_code ?? '') !== code) continue
            const sharesWan = Number(
              String(row.current_size ?? '').replace(/,/g, ''),
            )
            if (!Number.isFinite(sharesWan) || sharesWan < 0 || !row.size_date) {
              continue
            }
            points.push({
              date: row.size_date.slice(0, 10),
              totalSharesYi: Number((sharesWan / 10000).toFixed(6)),
              shareSource: 'szse',
            })
          }
          pageOk = true
          break
        } catch (error) {
          if (attempt === 4)
            console.warn(
              `  深交所 ETF 份额 ${code} ${rangeStart}..${rangeEnd} 第 ${page} 页抓取失败`,
              error,
            )
          await sleep(400 * 2 ** attempt)
        }
      }
      if (!pageOk) {
        // 单页失败：记录区间，跳出该区间继续下一个区间，不丢整段
        failedRanges.push(`${rangeStart}..${rangeEnd} p${page}`)
        rangeFullyFailed = true
        break
      }
      page += 1
      await sleep(80)
    } while (page <= pageCount && !rangeFullyFailed)
  }
  return { points: mergeOfficialPoints([], points), failedRanges }
}
