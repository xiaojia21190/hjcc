// ---------- 十大持有人（新浪）----------
import { isHuijinHolder } from '../../shared/categories'
import type { HolderReport, HolderRow } from '../../shared/types'
import { fetchJson, sleep } from './http'

interface SinaHolder {
  cyrmc: string
  cyfe: string
  zfeb: string
}
interface SinaDate {
  PUBLISHDATE: string
}

export async function fetchHolderDates(code: string): Promise<string[]> {
  const url = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FundPageInfoService.tabsdcyr?symbol=${code}`
  const json = await fetchJson<{
    result?: { data?: { dates?: SinaDate[]; info?: SinaHolder[] } | null }
  }>(url)
  const dates = json.result?.data?.dates ?? []
  return dates.map((d) => d.PUBLISHDATE).filter(Boolean)
}

export async function fetchHoldersOnDate(
  code: string,
  date: string,
): Promise<HolderRow[]> {
  const url = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FundPageInfoService.tabsdcyr?symbol=${code}&date=${date}`
  const json = await fetchJson<{
    result?: { data?: { info?: SinaHolder[] } | null }
  }>(url)
  const info = json.result?.data?.info ?? []
  return info.map((row) => {
    const name = row.cyrmc ?? ''
    const shares = Number(String(row.cyfe).replace(/,/g, '')) || 0
    const percent = Number(String(row.zfeb).replace(/%/g, '')) || 0
    return {
      name,
      shares,
      percent,
      isHuijin: isHuijinHolder(name),
    }
  })
}

export async function fetchAllHolderReports(
  code: string,
  maxReports = 12,
): Promise<HolderReport[]> {
  // 先不带 date 拿最新一期 + 日期列表
  const url = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FundPageInfoService.tabsdcyr?symbol=${code}`
  const json = await fetchJson<{
    result?: { data?: { dates?: SinaDate[]; info?: SinaHolder[] } | null }
  }>(url)
  const data = json.result?.data
  if (!data) return []

  const dates = (data.dates ?? [])
    .map((d) => d.PUBLISHDATE)
    .filter(Boolean)
    .slice(0, maxReports)

  const reports: HolderReport[] = []

  // 第一期用已返回的 info
  if (dates[0] && data.info?.length) {
    const holders = data.info.map((row) => {
      const name = row.cyrmc ?? ''
      return {
        name,
        shares: Number(String(row.cyfe).replace(/,/g, '')) || 0,
        percent: Number(String(row.zfeb).replace(/%/g, '')) || 0,
        isHuijin: isHuijinHolder(name),
      } satisfies HolderRow
    })
    const hj = holders.filter((h) => h.isHuijin)
    reports.push({
      reportDate: dates[0],
      holders,
      huijinShares: hj.reduce((s, h) => s + h.shares, 0),
      huijinPercent: Number(
        hj.reduce((s, h) => s + h.percent, 0).toFixed(4),
      ),
    })
  }

  for (const date of dates.slice(reports.length ? 1 : 0)) {
    await sleep(200)
    try {
      const holders = await fetchHoldersOnDate(code, date)
      if (!holders.length) continue
      const hj = holders.filter((h) => h.isHuijin)
      reports.push({
        reportDate: date,
        holders,
        huijinShares: hj.reduce((s, h) => s + h.shares, 0),
        huijinPercent: Number(
          hj.reduce((s, h) => s + h.percent, 0).toFixed(4),
        ),
      })
    } catch (e) {
      console.warn(`  holders ${code} ${date} failed:`, e)
    }
  }

  // 按日期降序
  reports.sort((a, b) => b.reportDate.localeCompare(a.reportDate))
  return reports
}
