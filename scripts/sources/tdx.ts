/**
 * 通达信行情数据源（node-tdx-market 直连版）
 *
 * 直连通达信行情服务器 TCP 协议，无需 Go 边车 / httpserver，npm 依赖即可。
 *  - 主行情 7709：`TdxClient`，取指数日 K（sh000001/sz399001）与 ETF 日 K（换手率回填）
 *  - 扩展行情 7727：`TdxExHqClient`，取中证全指 000985（0AMV 价格代理，market=62）
 *
 * 单位口径（来自 node-tdx-market，与 injoyai/tdx 完全一致）：
 *  - 主行情 KlineBar：close/amount 单位=厘（元×1000），priceToYuan()/1000 得元
 *    amount = decodeVolume()×1000；volume 指数×100、股票原值即手
 *  - 扩展行情 ExKline：close/amount 单位=元（float32），直接使用
 *  - 0AMV 只用 000985 的 close（元）+ 000001/399001 的 amount（厘→元）
 *
 * 失败行为：连接或拉取失败抛错，由 fetch-data.ts 的 try/catch 降级到东财。
 * 连接为模块级单例懒加载，复用 TCP 长连接 + 心跳；进程结束前应 disconnect。
 */
import { TdxClient, TdxExHqClient, priceToYuan } from 'node-tdx-market'
import type { MarketActiveCapPoint, TurnoverPoint } from '../../shared/types'
import type { MarketBar } from './eastmoney'
import { sleep } from './http'

/** node-tdx-market 的 KlineCategory/ExhqCommandType 是 const enum，isolatedModules 下
 *  跨模块不可直接引用成员，用数值常量（见 node-tdx-market/protocol/constants）。 */
const KLINE_DAY = 9 as const
/** 扩展行情 K 线命令字，category 也用日 K（与主行情 Day 同值，见 ExKline 时间编码） */
const EX_KLINE_DAY = 9 as const
/** 中证指数在扩展行情的市场编号（getMarkets 返回 market=62 name="中证指数"） */
const MARKET_CSI = 62 as const
/** 单次拉取上限（通达信协议 K 线请求 count ≤ 800） */
const KLINE_PAGE_SIZE = 800
/** 默认回填起点：拉到该日期为止，与 dashboard 原史长度匹配（2015 起） */
const DEFAULT_SINCE = '2015-01-01'

/** 主行情 client 单例（懒加载，复用长连接）。 */
let mainClient: TdxClient | null = null
/** 扩展行情 client 单例（懒加载）。 */
let exClient: TdxExHqClient | null = null
/** 测试注入用：覆盖主行情 client 工厂。 */
let mainClientFactory: (() => TdxClient) | null = null
/** 测试注入用：覆盖扩展行情 client 工厂。 */
let exClientFactory: (() => TdxExHqClient) | null = null

/** 测试注入：覆盖主行情 client 工厂。生产代码勿调。 */
export function __setMainClientFactory(f: (() => TdxClient) | null) {
  mainClientFactory = f
  mainClient = null
}
/** 测试注入：覆盖扩展行情 client 工厂。 */
export function __setExClientFactory(f: (() => TdxExHqClient) | null) {
  exClientFactory = f
  exClient = null
}

async function getMainClient(): Promise<TdxClient> {
  if (mainClient && mainClient.isConnected) return mainClient
  const client = mainClientFactory
    ? mainClientFactory()
    : new TdxClient({ autoReconnect: false })
  client.on('error', (err) => {
    // socket 异常若不监听会让进程崩溃；这里只记录，降级由调用方 try/catch 处理
    console.log('tdx 主行情 socket 异常:', err instanceof Error ? err.message : err)
  })
  await client.connect()
  mainClient = client
  return client
}

async function getExClient(): Promise<TdxExHqClient> {
  if (exClient && (exClient as unknown as { isConnected?: boolean }).isConnected) {
    return exClient
  }
  const client = exClientFactory ? exClientFactory() : new TdxExHqClient({ autoReconnect: false })
  client.on('error', (err) => {
    console.log('tdx 扩展行情 socket 异常:', err instanceof Error ? err.message : err)
  })
  await client.connect()
  exClient = client
  return client
}

/** 关闭并释放连接（测试 / 进程退出前调用）。 */
export async function __disconnectTdx() {
  try {
    mainClient?.disconnect()
  } catch {
    /* ignore */
  }
  try {
    exClient?.disconnect()
  } catch {
    /* ignore */
  }
  mainClient = null
  exClient = null
}

// ─── 纯函数（单位换算 / 口径，已单测覆盖，保持不变）──────────────────────────

/** tdx 主行情 K 线条目（已转成 MarketBar，close/amount 均为元，升序）。 */
interface TdxKline {
  Close: number
  Amount: number
  Time: string
}

/** Price = 厘 → 元 */
function yuan(li: number): number {
  return li / 1000
}

/** RFC3339 / ISO → 'YYYY-MM-DD' */
function toDate(iso: string): string {
  return iso.slice(0, 10)
}

/** 把主行情 KlineBar（厘）转成 MarketBar（元）。供 fetch 层与测试共用。 */
export function parseTdxKline(k: TdxKline): MarketBar | null {
  const date = toDate(k.Time)
  const close = yuan(k.Close)
  const amount = yuan(k.Amount)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  if (!Number.isFinite(close) || close <= 0) return null
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { date, close, amount }
}

// ─── 主行情拉取 ──────────────────────────────────────────────────────────────

/** 带 1 带成交量的日 K 点（ETF 换手率回填用）。 */
export interface MarketBarWithVolume extends MarketBar {
  /** 成交量，单位=手（ETF/股票日 K 口径，指数会 ×100） */
  volume: number
}

/**
 * 拉取单只指数/股票/ETF 的日 K（主行情 7709），翻页拉到 since 日期为止。
 * 通达信 start 语义：0=最新，递增往前倒推。每页最多 800 条。
 */
export async function fetchTdxIndexBars(
  code: string,
  opts: { since?: string } = {},
): Promise<MarketBar[]> {
  const since = opts.since ?? DEFAULT_SINCE
  const client = await getMainClient()
  const merged: Map<string, MarketBar> = new Map()
  // 翻页终止：返回空表示已到最早。不能按「不足一页」判断——服务器中间页可能返回不满 800 但仍有更老数据。
  // MAX_PAGES 防止异常时无限循环（2800 页 × 800 ≈ 224 万条，远超任何指数历史）。
  const MAX_PAGES = 100
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * KLINE_PAGE_SIZE
    const resp = await client.getKline({ code, category: KLINE_DAY, start, count: KLINE_PAGE_SIZE })
    if (resp.bars.length === 0) break
    let reachedSince = false
    for (const b of resp.bars) {
      const bar = parseTdxKline({
        Close: b.close,
        Amount: b.amount,
        Time: b.time.toISOString(),
      })
      if (!bar) continue
      merged.set(bar.date, bar)
      if (bar.date <= since) reachedSince = true
    }
    if (reachedSince) break
  }
  const bars = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date))
  if (bars.length === 0) throw new Error(`tdx 日线为空 (${code})`)
  return bars
}

/** 拉取单只 ETF/股票的日 K，含成交量（手），翻页拉到 since 日期为止。 */
export async function fetchTdxKlineBars(
  code: string,
  opts: { since?: string } = {},
): Promise<MarketBarWithVolume[]> {
  const since = opts.since ?? DEFAULT_SINCE
  const client = await getMainClient()
  const merged: Map<string, MarketBarWithVolume> = new Map()
  const MAX_PAGES = 100
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * KLINE_PAGE_SIZE
    const resp = await client.getKline({ code, category: KLINE_DAY, start, count: KLINE_PAGE_SIZE })
    if (resp.bars.length === 0) break
    let reachedSince = false
    for (const b of resp.bars) {
      const base = parseTdxKline({
        Close: b.close,
        Amount: b.amount,
        Time: b.time.toISOString(),
      })
      if (!base) continue
      if (!Number.isFinite(b.volume) || b.volume <= 0) continue
      merged.set(base.date, { ...base, volume: b.volume })
      if (base.date <= since) reachedSince = true
    }
    if (reachedSince) break
  }
  const bars = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date))
  if (bars.length === 0) throw new Error(`tdx 日线为空 (${code})`)
  return bars
}

/** 拉取中证全指 000985 日 K（扩展行情 market=62，close 为元），翻页到 since。 */
async function fetchCsiIndexBars(code: string, since = DEFAULT_SINCE): Promise<MarketBar[]> {
  const client = await getExClient()
  const merged: Map<string, MarketBar> = new Map()
  const MAX_PAGES = 100
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * KLINE_PAGE_SIZE
    const bars = await client.getBars({
      market: MARKET_CSI,
      code,
      category: EX_KLINE_DAY,
      start,
      count: KLINE_PAGE_SIZE,
    })
    if (bars.length === 0) break
    let reachedSince = false
    for (const b of bars) {
      const date = b.datetime.slice(0, 10)
      const close = b.close
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      if (!Number.isFinite(close) || close <= 0) continue
      // 000985 作价格代理，amount 不参与 0AMV，给占位 1
      merged.set(date, { date, close: Number(close.toFixed(2)), amount: 1 })
      if (date <= since) reachedSince = true
    }
    if (reachedSince) break
  }
  const out = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date))
  if (out.length === 0) throw new Error(`tdx 扩展行情日线为空 (${code})`)
  return out
}

// ─── 0AMV 合成 ────────────────────────────────────────────────────────────────

/**
 * 拉取 0AMV 三件套（中证全指 000985 扩展行情 + 上证综指 000001 + 深证成指 399001 主行情）
 * 并用与 eastmoney.buildMarketActiveCapHistory 完全相同的口径合成 0AMV 序列。
 *
 * 三只指数跨两个连接：000985 走 ExHq(7727/market=62)，000001/399001 走主行情(7709)。
 * 串行 + 间隔，避免压垮连接。
 */
export async function fetchTdxMarketActiveCapHistory(
  opts: { intervalMs?: number; since?: string } = {},
): Promise<MarketActiveCapPoint[]> {
  const interval = opts.intervalMs ?? 300
  const since = opts.since ?? DEFAULT_SINCE
  // 000985 走扩展行情（主行情不收录）
  const priceBars = await fetchCsiIndexBars('000985', since)
  await sleep(interval)
  // 成交额源走主行情
  const shBars = await fetchTdxIndexBars('sh000001', { since })
  await sleep(interval)
  const szBars = await fetchTdxIndexBars('sz399001', { since })
  return buildTdxMarketActiveCapHistory([priceBars, shBars, szBars])
}

/**
 * 与 eastmoney.buildMarketActiveCapHistory 同口径：
 * SMA(沪深成交额,10,1) × 中证全指收盘 / MA(前5日中证全指收盘)。
 * 不复用 eastmoney 导出函数，避免未来 eastmoney 口径变化时连带漂移。
 */
export function buildTdxMarketActiveCapHistory(
  series: MarketBar[][],
): MarketActiveCapPoint[] {
  const [priceBars, shBars, szBars] = series
  if (!priceBars || !shBars || !szBars) return []
  const shByDate = new Map(shBars.map((b) => [b.date, b]))
  const szByDate = new Map(szBars.map((b) => [b.date, b]))
  const bars = priceBars
    .map((p) => {
      const sh = shByDate.get(p.date)
      const sz = szByDate.get(p.date)
      if (!sh || !sz) return null
      return { date: p.date, close: p.close, amount: sh.amount + sz.amount }
    })
    .filter((b): b is MarketBar => b != null && b.amount > 0)

  let smooth = 0
  const raw: Omit<MarketActiveCapPoint, 'referenceMaYi'>[] = []
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    smooth = i === 0 ? bar.amount : (bar.amount + 9 * smooth) / 10
    if (i < 5) continue
    const prior5 = bars.slice(i - 5, i).reduce((s, x) => s + x.close, 0) / 5
    if (!Number.isFinite(prior5) || prior5 <= 0) continue
    raw.push({
      date: bar.date,
      activeCapYi: Number(((smooth * bar.close) / prior5 / 1e8).toFixed(2)),
      marketIndex: Number(bar.close.toFixed(2)),
      marketAmountYi: Number((bar.amount / 1e8).toFixed(2)),
    })
  }
  return raw.map((p, i) => {
    if (i < 4) return { ...p, referenceMaYi: null }
    const ma = raw.slice(i - 4, i + 1).reduce((s, x) => s + x.activeCapYi, 0) / 5
    return { ...p, referenceMaYi: Number(ma.toFixed(2)) }
  })
}

// ─── ETF 换手率回填 ───────────────────────────────────────────────────────────

/**
 * 份额查找：按日期向前填充。scaleHistory 中不晚于当日的最近一条 totalSharesYi。
 * 日频份额有缺口时沿用上一有效披露值（与官方份额口径一致），定期披露区间同理。
 */
export function buildShareLookup(
  shares: { date: string; totalSharesYi: number }[],
): (date: string) => number | null {
  const sorted = [...shares].sort((a, b) => a.date.localeCompare(b.date))
  return (date: string): number | null => {
    // 二分找最后一个 <= date
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sorted[mid].date <= date) lo = mid + 1
      else hi = mid
    }
    return lo > 0 ? sorted[lo - 1].totalSharesYi : null
  }
}

/**
 * 用 tdx ETF 日 K 回算场内换手率历史。
 * 口径与东财 f8 一致：turnoverPct = 场内成交量(股) / 基金总份额(股) × 100。
 *
 * - tdx Volume 单位=手（股÷100），×100 得股。
 * - totalSharesYi 单位=亿份，×1e8 得股。
 * - 仅对 (tdx 日 K 日期 ∩ 有份额披露日期) 产出点；份额未覆盖的早期跳过。
 *
 * 用于一次性回填 turnoverHistory，解决「只能接入日起积累、无历史」痛点。
 */
export function deriveTurnoverFromTdx(
  klines: MarketBarWithVolume[],
  shares: { date: string; totalSharesYi: number }[],
): TurnoverPoint[] {
  if (klines.length === 0 || shares.length === 0) return []
  const lookup = buildShareLookup(shares)
  const out: TurnoverPoint[] = []
  for (const k of klines) {
    const totalSharesYi = lookup(k.date)
    if (totalSharesYi == null || totalSharesYi <= 0) continue
    // 成交量(股) = volume(手) × 100；总份额(股) = totalSharesYi(亿份) × 1e8
    const turnoverPct = Number(
      ((k.volume * 100) / (totalSharesYi * 1e8) * 100).toFixed(4),
    )
    if (!Number.isFinite(turnoverPct) || turnoverPct < 0) continue
    out.push({
      date: k.date,
      turnoverPct,
      amountYuan: Number(k.amount.toFixed(2)),
    })
  }
  return out
}

/**
 * 拉取单只 ETF 的 tdx 日 K 并回算换手率历史。tdx 不可用 → 返回空数组（不拖垮主流程）。
 */
export async function fetchTdxTurnoverBackfill(
  code: string,
  shares: { date: string; totalSharesYi: number }[],
  opts: { since?: string } = {},
): Promise<TurnoverPoint[]> {
  try {
    // ETF 份额回填起点 2024-01-01，tdx 拉到该日期即可
    const since = opts.since ?? '2024-01-01'
    const klines = await fetchTdxKlineBars(code, { since })
    return deriveTurnoverFromTdx(klines, shares)
  } catch (error) {
    console.log(
      `tdx 换手率回填不可用 (${code}):`,
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

// 导出 priceToYuan 便于测试 / 调试
export { priceToYuan }
