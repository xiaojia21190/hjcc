// ---------- 沪深两融市场合计（东财 datacenter RPTA_RZRQ_LSHJ）----------
import type { MarginPoint } from '../../shared/types'
import { fetchJson, sleep } from './http'

/** 单页最大返回 800 条（接口上限）。 */
const PAGE_SIZE = 800
/** 拉取页数：2 页约 1600 交易日 ≈ 6.6 年，覆盖 250 日分位绰绰有余。 */
const PAGES = 2
const REFERER = 'https://data.eastmoney.com/rzrq/'

interface RawMarginRow {
  DIM_DATE: string
  RZYE: number | null
  RZMRE: number | null
  RZRQYE: number | null
  RZYEZB: number | null
}

interface MarginResponse {
  result?: {
    data?: RawMarginRow[] | null
  } | null
  success?: boolean
}

/** 东财原始行 → MarginPoint；日期非法或关键字段非正的行剔除，输出升序。 */
export function normalizeMarginRows(rows: RawMarginRow[]): MarginPoint[] {
  return rows
    .map((row) => ({
      date: String(row.DIM_DATE ?? '').slice(0, 10),
      rzye: Number(row.RZYE),
      rzmre: Number(row.RZMRE),
      rzrqye: Number(row.RZRQYE),
      rzyezb: row.RZYEZB == null ? null : Number(row.RZYEZB),
    }))
    .filter(
      (p) =>
        /^\d{4}-\d{2}-\d{2}$/.test(p.date) &&
        Number.isFinite(p.rzye) &&
        p.rzye > 0 &&
        Number.isFinite(p.rzmre) &&
        p.rzmre >= 0 &&
        Number.isFinite(p.rzrqye) &&
        p.rzrqye > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 拉取两融市场合计历史（升序）。任一页失败抛出——两融是市场级序列，
 * 半截历史会让分位失真，失败由调用方沿用上次快照。
 */
export async function fetchMarginHistory(): Promise<MarginPoint[]> {
  const all: RawMarginRow[] = []
  for (let page = 1; page <= PAGES; page++) {
    if (page > 1) await sleep(500)
    const url =
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ` +
      `&columns=DIM_DATE,RZYE,RZMRE,RZRQYE,RZYEZB&sortColumns=DIM_DATE&sortTypes=-1` +
      `&pageNumber=${page}&pageSize=${PAGE_SIZE}`
    const json = await fetchJson<MarginResponse>(url, REFERER)
    const rows = json.result?.data ?? []
    if (rows.length === 0) {
      throw new Error(`两融数据第 ${page} 页返回空`)
    }
    all.push(...rows)
  }
  const points = normalizeMarginRows(all)
  // 两页边界可能重叠一日，去重
  const byDate = new Map(points.map((p) => [p.date, p]))
  const unique = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  if (unique.length < 250) {
    throw new Error(`两融历史仅 ${unique.length} 日，不足以做 250 日分位`)
  }
  return unique
}
