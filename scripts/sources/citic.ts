import { spawnSync } from 'node:child_process'
import path from 'node:path'
import type {
  CiticPositionPoint,
  CiticPositionQuality,
} from '../../shared/types'

const TUSHARE_URL = 'https://api.tushare.pro'
const PRODUCTS = ['IF', 'IH', 'IC', 'IM'] as const
const START_DATE = '20240101'

type Product = (typeof PRODUCTS)[number]

interface RawCiticRow {
  trade_date?: string
  symbol?: string
  broker?: string
  long_hld?: number | string | null
  short_hld?: number | string | null
}

interface TushareResponse {
  code?: number
  msg?: string
  data?: { fields?: string[]; items?: unknown[][] } | null
}

function asNumber(value: unknown): number | null {
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : null
}

function asDate(value: unknown): string | null {
  const raw = String(value ?? '')
  if (!/^\d{8}$/.test(raw)) return null
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
}

/** 将 Tushare 的列式响应转换为中信会员的逐品种持仓日线。 */
export function normalizeCiticRows(
  rows: RawCiticRow[],
  product: Product,
): Array<{ date: string; product: Product; longHold: number; shortHold: number }> {
  return rows
    .filter((row) => String(row.broker ?? '').includes('中信'))
    .map((row) => ({
      date: asDate(row.trade_date) ?? '',
      product,
      longHold: asNumber(row.long_hld),
      shortHold: asNumber(row.short_hld),
    }))
    .filter(
      (row): row is typeof row & { longHold: number; shortHold: number } =>
        row.date !== '' && row.longHold != null && row.shortHold != null,
    )
}

function rowsFromResponse(response: TushareResponse, product: Product): RawCiticRow[] {
  const fields = response.data?.fields ?? []
  return (response.data?.items ?? []).map((item) => {
    const row = Object.fromEntries(fields.map((field, index) => [field, item[index]]))
    return { ...row, symbol: row.symbol ?? product } as RawCiticRow
  })
}

async function fetchProduct(token: string, product: Product): Promise<RawCiticRow[]> {
  const response = await fetch(TUSHARE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_name: 'fut_holding',
      token,
      params: { exchange: 'CFX', symbol: product, start_date: START_DATE },
      fields: 'trade_date,symbol,broker,long_hld,short_hld',
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Tushare fut_holding HTTP ${response.status}`)
  const json = (await response.json()) as TushareResponse
  if (json.code !== 0) throw new Error(json.msg || 'Tushare fut_holding 返回错误')
  return rowsFromResponse(json, product)
}

export function buildCiticPositionHistory(
  rows: Array<{ date: string; product: Product; longHold: number; shortHold: number }>,
): CiticPositionPoint[] {
  const sorted = [...rows].sort((a, b) =>
    a.date.localeCompare(b.date) || a.product.localeCompare(b.product),
  )
  const previous = new Map<Product, { longHold: number; shortHold: number }>()
  const output: CiticPositionPoint[] = []
  for (const row of sorted) {
    const prior = previous.get(row.product)
    const netHold = row.longHold - row.shortHold
    output.push({
      date: row.date,
      product: row.product,
      longHold: row.longHold,
      shortHold: row.shortHold,
      netHold,
      longChange: prior ? row.longHold - prior.longHold : null,
      shortChange: prior ? row.shortHold - prior.shortHold : null,
      netChange: prior ? netHold - (prior.longHold - prior.shortHold) : null,
    })
    previous.set(row.product, row)
  }
  return output
}

export async function fetchCiticPositionHistory(
  token: string,
): Promise<CiticPositionPoint[]> {
  const rows = (await Promise.all(PRODUCTS.map((product) => fetchProduct(token, product))))
    .flatMap((productRows, index) =>
      normalizeCiticRows(productRows, PRODUCTS[index]!),
    )
  const history = buildCiticPositionHistory(rows)
  if (history.length === 0) throw new Error('Tushare 未返回中信期货持仓')
  return history
}

/**
 * 从本机 Python(akshare) 抓取中金所官网会员持仓排名, 得到中信系 IF/IH/IC/IM 多空持仓。
 * 无需 Tushare 授权, 作为 TUSHARE_TOKEN 缺失/权限不足时的主用数据源。
 *
 * 增量策略：existing 有缓存时只从「缓存最后日期的下一天」开始抓, 抓到的新日
 * 追加到 existing 后整体重算增减；无缓存时从 2024-01-01 全量回填。
 * 多往前抓 1 个自然日作冗余, 容忍交易所 T 日结算数据晚发布/当日未抓到。
 */
export function fetchCiticPositionHistoryCffex(
  existing: CiticPositionPoint[] = [],
  fullStartDate = '20240101',
): CiticPositionPoint[] {
  const baseRows = existing.map((point) => ({
    date: point.date,
    product: point.product,
    longHold: point.longHold,
    shortHold: point.shortHold,
  }))
  const latestDate = existing.map((p) => p.date).sort().at(-1)
  const startDate = latestDate ? nextDateYyyyMmDd(latestDate) : fullStartDate
  const python = process.env.CITIC_PYTHON?.trim() || 'python'
  // Bun 在 Windows 上用默认 spawn 不一定能解析 "python"(WindowsApps shim),
  // 但 shell 能。这里拼成命令字符串交给 shell 解析, 跨平台通用。
  const scriptPath = path.join(import.meta.dir, 'cffex_citic.py')
  const command = `${python} ${scriptPath} --start ${startDate}`
  const proc = spawnSync(command, {
    encoding: 'utf8',
    shell: true,
    timeout: 20 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (proc.error) {
    const err = proc.error as Error & { code?: unknown }
    if (err.code === 'ENOENT') throw new Error('未找到 python, 无法调用中金所抓取脚本')
    throw err
  }
  if (proc.status !== 0) {
    const stderr = proc.stderr.trim()
    throw new Error(`cffex_citic.py 退出码 ${proc.status}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`)
  }
  let parsed: Array<{ date: string; product: Product; longHold: number; shortHold: number }>
  try {
    parsed = JSON.parse(proc.stdout) as typeof parsed
  } catch {
    throw new Error('cffex_citic.py 输出不是合法 JSON')
  }
  const fresh = parsed
    .filter(
      (row) =>
        PRODUCTS.includes(row.product as Product) &&
        Number.isFinite(row.longHold) &&
        Number.isFinite(row.shortHold),
    )
    .map((row) => ({
      date: row.date,
      product: row.product as Product,
      longHold: row.longHold,
      shortHold: row.shortHold,
    }))
  // 去重合并：同一 (date, product) 以新抓到的为准（缓存可能是残缺快照）。
  const merged = mergeCiticRows(baseRows, fresh)
  const history = buildCiticPositionHistory(merged)
  if (history.length === 0) throw new Error('中金所未返回中信会员持仓')
  return history
}

/**
 * 合并中金所新旧持仓行: 同一 (date, product) 以新抓到的为准（缓存可能是残缺快照）,
 * 其余保留旧值。纯函数, 便于单测增量逻辑。
 */
export function mergeCiticRows(
  base: Array<{ date: string; product: Product; longHold: number; shortHold: number }>,
  fresh: Array<{ date: string; product: Product; longHold: number; shortHold: number }>,
): Array<{ date: string; product: Product; longHold: number; shortHold: number }> {
  const seen = new Set(fresh.map((row) => `${row.date}|${row.product}`))
  const merged = [...fresh]
  for (const row of base) {
    if (!seen.has(`${row.date}|${row.product}`)) merged.push(row)
  }
  return merged
}

/** 给定 YYYY-MM-DD, 返回下一个自然日的 YYYYMMDD。 */
export function nextDateYyyyMmDd(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 1))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`
}

export function unavailableCiticQuality(warning: string): CiticPositionQuality {
  return { source: 'unavailable', asOf: null, warning }
}
