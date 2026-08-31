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

/** 中金所原始行（cffex 链路输出）；top5 字段为 null/缺失时表示数据源未提供。 */
interface CffexRow {
  date: string
  product: Product
  longHold: number
  shortHold: number
  longTop5Pct?: number | null
  shortTop5Pct?: number | null
}

/** 合并后的行：top5 字段可能缺失（旧缓存无该字段）。 */
type MergedRow = {
  date: string
  product: Product
  longHold: number
  shortHold: number
  longTop5Pct?: number | null
  shortTop5Pct?: number | null
}

function asTop5Pct(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 && num <= 100 ? num : null
}

export function buildCiticPositionHistory(rows: MergedRow[]): CiticPositionPoint[] {
  const sorted = [...rows].sort((a, b) =>
    a.date.localeCompare(b.date) || a.product.localeCompare(b.product),
  )
  const previous = new Map<Product, { longHold: number; shortHold: number }>()
  const output: CiticPositionPoint[] = []
  for (const row of sorted) {
    const prior = previous.get(row.product)
    const netHold = row.longHold - row.shortHold
    const longTop5 = asTop5Pct(row.longTop5Pct)
    const shortTop5 = asTop5Pct(row.shortTop5Pct)
    output.push({
      date: row.date,
      product: row.product,
      longHold: row.longHold,
      shortHold: row.shortHold,
      netHold,
      longChange: prior ? row.longHold - prior.longHold : null,
      shortChange: prior ? row.shortHold - prior.shortHold : null,
      netChange: prior ? netHold - (prior.longHold - prior.shortHold) : null,
      // 旧缓存无 top5 字段时不写键，前端按 null 处理
      ...(longTop5 != null ? { longTop5Pct: longTop5 } : {}),
      ...(shortTop5 != null ? { shortTop5Pct: shortTop5 } : {}),
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
 *
 * 为什么必须异步：spawnSync 会阻塞整个 event loop，fetch-data 主流程
 * （0AMV/两融/板块/份额等所有 await）全部停摆，板卡上无缓存全量回填
 * 644 天 × akshare 逐日请求可达 20+ 分钟，父进程 15min 硬超时直接杀进程。
 * 改用 spawn + Promise，其他数据源可并行推进；py 子进程自身另有 20min 上限。
 */
import { spawn } from 'node:child_process'

const CITIC_PY_TIMEOUT_MS = 20 * 60 * 1000

function runCiticPython(
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  const timeoutMs = opts.timeoutMs ?? CITIC_PY_TIMEOUT_MS
  return new Promise((resolve) => {
    const proc: ReturnType<typeof spawn> = spawn(command, { shell: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const startedAt = Date.now()
    // 心跳：python 回填可能长达几十分钟且不产生 stdout；
    // 定期把进度打到 console，既喂 fetch-data 的 12min 看门狗，也让日志可见
    const beat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      const tail = stderr.trim().split('\n').at(-1)?.slice(0, 60) ?? ''
      console.warn(`[citic-python] 运行中 ${elapsed}s${tail ? ` · ${tail}` : ''}`)
    }, 60_000)
    const settle = (result: { status: number | null; stdout: string; stderr: string; error?: Error }) => {
      if (settled) return
      settled = true
      clearInterval(beat)
      resolve(result)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      settle({ status: null, stdout, stderr, error: new Error(`cffex_citic.py 超时 ${Math.round(timeoutMs / 60000)} 分钟`) })
    }, timeoutMs)
    proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    proc.on('error', (error: Error) => {
      clearTimeout(timer)
      settle({ status: null, stdout, stderr, error })
    })
    proc.on('close', (status: number | null) => {
      clearTimeout(timer)
      settle({ status, stdout, stderr })
    })
  })
}

/**
 * 无缓存时的回填起点：默认只回源近 CITIC_BACKFILL_DAYS 天（45 天）。
 * 之前默认从 20240101 全量回填，板卡上要 1 小时以上，必然撞看门狗/超时；
 * 深度可 CITIC_BACKFILL_START=20240101 手动指定，或之后每日增量自然累积。
 */
export function defaultBackfillStart(): string {
  const envStart = process.env.CITIC_BACKFILL_START?.trim()
  if (envStart) return envStart
  const days = Number(process.env.CITIC_BACKFILL_DAYS ?? 45)
  const d = new Date(Date.now() - Math.max(1, days) * 86400000)
  return d.toISOString().slice(0, 10).replaceAll('-', '')
}

export async function fetchCiticPositionHistoryCffex(
  existing: CiticPositionPoint[] = [],
  opts: { fullStartDate?: string; timeoutMs?: number } = {},
): Promise<CiticPositionPoint[]> {
  const baseRows = existing.map((point) => ({
    date: point.date,
    product: point.product,
    longHold: point.longHold,
    shortHold: point.shortHold,
    longTop5Pct: point.longTop5Pct,
    shortTop5Pct: point.shortTop5Pct,
  }))
  const latestDate = existing.map((p) => p.date).sort().at(-1)
  const startDate = latestDate
    ? nextDateYyyyMmDd(latestDate)
    : opts.fullStartDate ?? defaultBackfillStart()
  const python = process.env.CITIC_PYTHON?.trim() || 'python'
  // Bun 在 Windows 上用默认 spawn 不一定能解析 "python"(WindowsApps shim),
  // 但 shell 能。这里拼成命令字符串交给 shell 解析, 跨平台通用。
  const scriptPath = path.join(import.meta.dir, 'cffex_citic.py')
  const command = `${python} ${scriptPath} --start ${startDate}`
  const proc = await runCiticPython(command, { timeoutMs: opts.timeoutMs })
  if (proc.error) {
    const err = proc.error as Error & { code?: unknown }
    if (err.code === 'ENOENT') throw new Error('未找到 python, 无法调用中金所抓取脚本')
    throw err
  }
  if (proc.status !== 0) {
    const stderr = proc.stderr.trim()
    throw new Error(`cffex_citic.py 退出码 ${proc.status}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`)
  }
  let parsed: CffexRow[]
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
      longTop5Pct: asTop5Pct(row.longTop5Pct),
      shortTop5Pct: asTop5Pct(row.shortTop5Pct),
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
  base: MergedRow[],
  fresh: MergedRow[],
): MergedRow[] {
  const seen = new Set(fresh.map((row) => `${row.date}|${row.product}`))
  const merged: MergedRow[] = [...fresh]
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
