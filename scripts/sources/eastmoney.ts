// ---------- 行情 / 规模（东财 push2）----------
import { CATEGORIES, matchCategory } from '../../shared/categories'
import type {
  EtfQuote,
  MarketActiveCapPoint,
  NavPoint,
  ScalePoint,
} from '../../shared/types'
import { fetchJson, fetchText, isConnectionReset, sleep } from './http'

interface PushDiff {
  f12: string
  f13: number
  f14: string
  f2: number | string
  f3: number | string
  f20: number | string
  f21: number | string
}

interface PushPageResponse {
  data?: {
    total?: number
    diff?: PushDiff[]
  } | null
}

const ETF_PAGE_SIZE = 100
const ETF_QUOTE_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
]

async function fetchEtfUniversePage(
  page: number,
  host: string,
): Promise<PushPageResponse> {
  const url =
    `${host}/api/qt/clist/get?pn=${page}&pz=${ETF_PAGE_SIZE}` +
    // 分页按代码稳定排序，避免实时市值变化导致翻页期间出现重复或遗漏；选取时仍按 f20 排序。
    '&po=1&np=1&fltt=2&invt=2&fid=f12' +
    '&fs=b:MK0021,b:MK0022,b:MK0023,b:MK0024' +
    '&fields=f12,f13,f14,f2,f3,f20,f21'
  return fetchJson<PushPageResponse>(url, 'https://quote.eastmoney.com/')
}

export async function fetchEtfUniverse(): Promise<EtfQuote[]> {
  try {
    // 完整分页扫描场内 ETF，接口单页最多返回 100 条。
    let first: PushPageResponse | null = null
    let quoteHost = ETF_QUOTE_HOSTS[0]
    for (const host of ETF_QUOTE_HOSTS) {
      try {
        first = await fetchEtfUniversePage(1, host)
        quoteHost = host
        break
      } catch (error) {
        console.warn(`ETF 行情域名不可用 ${host}`, error)
      }
    }
    if (!first) throw new Error('ETF 行情主域名与备用域名均不可用')
    const total = first.data?.total ?? 0
    const totalPages = Math.max(1, Math.ceil(total / ETF_PAGE_SIZE))
    const diff = [...(first.data?.diff ?? [])]
    let failedPages = 0
    for (let start = 2; start <= totalPages; start += 4) {
      const pages = Array.from(
        { length: Math.min(4, totalPages - start + 1) },
        (_, index) => start + index,
      )
      const batch = await Promise.all(
        pages.map(async (page) => {
          try {
            return (await fetchEtfUniversePage(page, quoteHost)).data?.diff ?? []
          } catch (error) {
            failedPages += 1
            console.warn(`push2 ETF 行情第 ${page} 页失败`, error)
            return []
          }
        }),
      )
      diff.push(...batch.flat())
      await sleep(80)
    }

    const quotes = diff.map((d) => {
      const num = (v: number | string | null | undefined) =>
        v === '-' || v === null || v === undefined || v === ''
          ? null
          : Number(v)
      return {
        code: String(d.f12),
        name: String(d.f14),
        price: num(d.f2),
        changePct: num(d.f3),
        marketCap: num(d.f20),
        floatCap: num(d.f21),
        market: d.f13 === 0 ? 'SZ' : 'SH',
      } satisfies EtfQuote
    })
    const byCode = new Map(quotes.map((quote) => [quote.code, quote]))
    if (failedPages > 0) {
      for (const quote of await fetchQuotesByCandidates()) {
        byCode.set(quote.code, quote)
      }
    } else {
      // 分页列表里某些 ETF 的 f2 可能返回 "-"（null），用单票接口补查
      const candidateCodes = new Set(CATEGORIES.flatMap((c) => c.candidates))
      const missingPrice = [...byCode.values()].filter(
        (q) => candidateCodes.has(q.code) && q.price == null,
      )
      if (missingPrice.length > 0) {
        console.log(`  补查 ${missingPrice.length} 只候选行情: ${missingPrice.map((q) => q.code).join(', ')}`)
        for (const quote of await fetchQuotesByCandidates()) {
          if (quote.price != null) byCode.set(quote.code, quote)
        }
      }
    }
    const universe = [...byCode.values()]
    if (!universe.length) throw new Error('ETF 行情列表为空')
    console.log(
      `ETF 行情分页 ${totalPages - failedPages}/${totalPages}，去重后 ${universe.length}/${total || universe.length} 只`,
    )
    return universe
  } catch (e) {
    console.warn('push2 行情列表失败，改用候选代码逐个查询', e)
    return fetchQuotesByCandidates()
  }
}

// ---------- 沪深市场 0AMV 活筹指数（公开公式估算）----------
interface MarketKlineResponse {
  data?: {
    code?: string
    name?: string
    klines?: string[]
  } | null
}

interface MarketBar {
  date: string
  close: number
  amount: number
}

export type { MarketBar }
export {
  appendLatestMarketActiveCapHistory,
  fetchLatestMarketActiveCapHistory,
  parseLatestMarketBar,
} from './market-latest'

/** 盘前行情可能返回 0；无效实时值沿用上次有效报价，避免污染页面快照。 */
export function mergeQuoteWithPrevious(
  current: EtfQuote,
  previous?: EtfQuote | null,
): EtfQuote {
  const validPrice =
    current.price != null && Number.isFinite(current.price) && current.price > 0
  const previousPrice =
    previous?.price != null &&
    Number.isFinite(previous.price) &&
    previous.price > 0
      ? previous.price
      : null
  const previousChange = previousPrice == null ? null : previous?.changePct ?? null
  return {
    ...current,
    price: validPrice ? current.price : previousPrice,
    changePct: validPrice ? current.changePct : previousChange,
  }
}

/**
 * 日线域名回退链。push2his 是主力，但该路径曾被东财按 `kline/get` 整体封禁
 * （返回 TCP RST 而非 HTTP 状态码），故备下同构域名。
 * 注意 push2delay 会以 HTTP 200 返回空 klines，因此回退判据必须是「有数据」
 * 而不是「响应成功」，否则会静默拿到空序列。
 */
const KLINE_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://push2.eastmoney.com',
  // push2delay 排最后：它本就是延迟行情，且其 CDN 节点（如 101.42.164.241）
  // 在 ARM Linux 上会 TCP 连接成功但 HTTP 永远不响应，不应作为主力源。
  'https://push2delay.eastmoney.com',
]
/** 记住上一次真正返回数据的域名，避免每个请求都从已封禁的域名重试一遍。 */
let preferredKlineHost: string | null = null
/** 大响应日线之间的间隔，避免密集打满同一域名。 */
const MARKET_BAR_INTERVAL_MS = 800
/**
 * 三域名全部空响应后，再给东财冷却重试一轮的延迟。
 * 取值与 sector.ts 的补抓间隔一致——属已验证的「给对端冷却」经验值。
 */
const RETRY_DELAY_MS = 2000
/**
 * 三域名全空后的重试轮数（不含首次）。封禁多为间歇抖动，一轮延迟通常即可恢复；
 * 再多属持续封禁，重试无益，反而延长封禁态。
 */
const RETRY_ROUNDS = 1

function parseKlines(json: MarketKlineResponse): MarketBar[] {
  return (json.data?.klines ?? [])
    .map((line) => {
      const [date, , close, , , , amount] = line.split(',')
      return { date, close: Number(close), amount: Number(amount) }
    })
    .filter(
      (bar) =>
        /^\d{4}-\d{2}-\d{2}$/.test(bar.date) &&
        Number.isFinite(bar.close) &&
        bar.close > 0 &&
        Number.isFinite(bar.amount) &&
        bar.amount > 0,
    )
}

/** 将三条指数日线按公共日期合并并计算 0AMV 近似序列。 */
export function buildMarketActiveCapHistory(
  series: MarketBar[][],
): MarketActiveCapPoint[] {
  const [priceBars, shBars, szBars] = series
  if (!priceBars || !shBars || !szBars) return []
  const shByDate = new Map(shBars.map((bar) => [bar.date, bar]))
  const szByDate = new Map(szBars.map((bar) => [bar.date, bar]))
  const bars = priceBars
    .map((priceBar) => {
      const sh = shByDate.get(priceBar.date)
      const sz = szByDate.get(priceBar.date)
      if (!sh || !sz) return null
      return {
        date: priceBar.date,
        close: priceBar.close,
        amount: sh.amount + sz.amount,
      }
    })
    .filter((bar): bar is MarketBar => bar != null && bar.amount > 0)

  let smoothAmount = 0
  const raw: Omit<MarketActiveCapPoint, 'referenceMaYi'>[] = []
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    smoothAmount = i === 0 ? bar.amount : (bar.amount + 9 * smoothAmount) / 10
    if (i < 5) continue
    const priorFiveClose = bars
      .slice(i - 5, i)
      .reduce((sum, item) => sum + item.close, 0) / 5
    if (!Number.isFinite(priorFiveClose) || priorFiveClose <= 0) continue
    raw.push({
      date: bar.date,
      activeCapYi: Number(
        ((smoothAmount * bar.close) / priorFiveClose / 1e8).toFixed(2),
      ),
      marketIndex: Number(bar.close.toFixed(2)),
      marketAmountYi: Number((bar.amount / 1e8).toFixed(2)),
    })
  }

  return raw.map((point, index) => {
    if (index < 4) return { ...point, referenceMaYi: null }
    const referenceMaYi =
      raw
        .slice(index - 4, index + 1)
        .reduce((sum, item) => sum + item.activeCapYi, 0) / 5
    return {
      ...point,
      referenceMaYi: Number(referenceMaYi.toFixed(2)),
    }
  })
}

export async function fetchMarketBars(
  secid: string,
  referer: string,
  range: {
    beg?: string
    lmt?: number
    /** 测试注入用：覆盖轮间延迟，避免真实 sleep 拖慢用例。生产不传。 */
    retryDelayMs?: number
    /** 测试注入用：覆盖重试轮数。生产不传，用 RETRY_ROUNDS。 */
    retryRounds?: number
  } = {},
): Promise<MarketBar[]> {
  const beg = range.beg ?? '20150101'
  const lmt = range.lmt ?? 5000
  const retryDelayMs = range.retryDelayMs ?? RETRY_DELAY_MS
  const retryRounds = range.retryRounds ?? RETRY_ROUNDS
  const path =
    `/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&beg=${beg}&end=20500101&lmt=${lmt}` +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58'

  /**
   * 单轮：按优先序遍历三域名，命中即返回。
   * 全部空响应抛 `Error('… 返回空 klines')`，其余异常原样上抛，
   * 由外层据此判断是否值得延迟重试一轮。
   */
  const tryHosts = async (): Promise<MarketBar[]> => {
    // 优先用已知可用域名，其余按顺序兜底
    const hosts = preferredKlineHost
      ? [preferredKlineHost, ...KLINE_HOSTS.filter((host) => host !== preferredKlineHost)]
      : KLINE_HOSTS
    let lastError: unknown
    for (const host of hosts) {
      try {
        const bars = parseKlines(await fetchJson<MarketKlineResponse>(host + path, referer))
        if (bars.length > 0) {
          preferredKlineHost = host
          return bars
        }
        lastError = new Error(`${host} 返回空 klines`)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error(`日线抓取失败 secid=${secid}`)
  }

  // 首轮直接试；失败后仅在「空 klines」或「连接重置」这类间歇性、且冷却后
  // 大概率恢复的情况才延迟重试。HTTP 层硬错误（4xx/5xx）重试价值低，直接抛。
  for (let round = 0; round <= retryRounds; round++) {
    try {
      return await tryHosts()
    } catch (error) {
      const recoverable =
        error instanceof Error &&
        (error.message.includes('返回空 klines') || isConnectionReset(error))
      if (!recoverable || round === retryRounds) throw error
      // 间歇抖动给东财留检索·DNS·冷却窗口，再试一轮
      await sleep(retryDelayMs)
    }
  }
  // 不可达：循环必经 throw 或 return，此句仅为类型闭环
  throw new Error(`日线抓取失败 secid=${secid}`)
}

/**
 * 指南针原版 0AMV 算法未公开。这里采用公开流传的近似公式：
 * SMA(AMOUNT, 10, 1) * CLOSE / MA(REF(CLOSE, 1), 5)。
 * 中证全指 000985 提供市场价格代理；成交额为上证综指与深证成指成交额之和。
 */
export async function fetchMarketActiveCapHistory(): Promise<MarketActiveCapPoint[]> {
  // 三条都是 lmt=5000 的大响应，并发打出去正是触发日线接口封禁的主因，故串行 + 间隔。
  const specs: [string, string][] = [
    ['1.000985', 'https://quote.eastmoney.com/zs000985.html'],
    ['1.000001', 'https://quote.eastmoney.com/zs000001.html'],
    ['0.399001', 'https://quote.eastmoney.com/sz399001.html'],
  ]
  const series: MarketBar[][] = []
  for (const [secid, referer] of specs) {
    if (series.length > 0) await sleep(MARKET_BAR_INTERVAL_MS)
    series.push(await fetchMarketBars(secid, referer))
  }
  const history = buildMarketActiveCapHistory(series)
  if (history.length === 0) {
    throw new Error('三条指数日线没有公共交易日，0AMV 序列为空')
  }
  return history
}

/** 候选代码单票行情（secid: 1=SH, 0=SZ） */
export async function fetchQuotesByCandidates(): Promise<EtfQuote[]> {
  const codes = [...new Set(CATEGORIES.flatMap((c) => c.candidates))]
  const out: EtfQuote[] = []
  for (const code of codes) {
    const market = code.startsWith('15') || code.startsWith('16') ? 0 : 1
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${market}.${code}&fields=f57,f58,f43,f170,f116,f117`
    try {
      const json = await fetchJson<{
        data?: {
          f57?: string
          f58?: string
          f43?: number
          f170?: number
          f116?: number
          f117?: number
        } | null
      }>(url, 'https://quote.eastmoney.com/')
      const d = json.data
      if (!d) continue
      // f43 价格可能是 *1000
      const rawPrice = d.f43
      const price =
        rawPrice == null
          ? null
          : rawPrice > 1000
            ? rawPrice / 1000
            : rawPrice / 1000
      out.push({
        code: String(d.f57 ?? code),
        name: String(d.f58 ?? code),
        price,
        changePct: d.f170 != null ? d.f170 / 100 : null,
        marketCap: d.f116 ?? null,
        floatCap: d.f117 ?? null,
        market: market === 0 ? 'SZ' : 'SH',
      })
      await sleep(120)
    } catch (err) {
      console.warn(`  quote ${code} fail`, err)
    }
  }
  // 也用规模历史净资产作为排序兜底权重
  return out
}

// ---------- 场内换手率快照（push2delay ulist.np 批量）----------

interface UlistResponse {
  data?: {
    diff?: {
      f12: string
      f14: string
      f2: number | string
      f3: number | string
      f6: number | string
      f8: number | string
    }[]
  } | null
}

const TURNOVER_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
]

/**
 * 批量拉取指定代码的实时换手率与成交额。
 * f8 在 fltt=2 下已是真实百分数（如 3.46 = 3.46%），无需再除以 100；
 * 已用 510300 份额/价格交叉验证口径（场内成交量 / 基金总份额）。
 * 返回 code → {date, turnoverPct, amountYuan}；两域名均失败返回空 Map，不抛出。
 */
export async function fetchTurnoverSnapshot(
  codes: string[],
  asOfDate: string,
): Promise<
  Map<string, { date: string; turnoverPct: number | null; amountYuan: number | null }>
> {
  const out = new Map<
    string,
    { date: string; turnoverPct: number | null; amountYuan: number | null }
  >()
  if (codes.length === 0) return out
  const secids = codes
    .map(
      (code) =>
        `${code.startsWith('15') || code.startsWith('16') ? '0' : '1'}.${code}`,
    )
    .join(',')
  let lastError: unknown = null
  for (const host of TURNOVER_HOSTS) {
    try {
      const url = `${host}/api/qt/ulist.np/get?secids=${secids}&fltt=2&fields=f12,f14,f2,f3,f6,f8`
      const json = await fetchJson<UlistResponse>(url, 'https://quote.eastmoney.com/')
      const rows = json.data?.diff ?? []
      if (rows.length === 0) throw new Error(`${host} ulist 返回空 diff`)
      for (const row of rows) {
        const num = (v: number | string | undefined) =>
          v === '-' || v == null || v === '' ? null : Number(v)
        out.set(String(row.f12), {
          date: asOfDate,
          turnoverPct: num(row.f8),
          amountYuan: num(row.f6),
        })
      }
      return out
    } catch (error) {
      lastError = error
    }
  }
  console.warn('换手率快照两域名均失败', lastError)
  return out
}

/** 每类别选出规模最大的宽基 ETF */
export async function pickLargestPerCategory(universe: EtfQuote[]) {
  const picked: {
    category: (typeof CATEGORIES)[number]
    quote: EtfQuote
  }[] = []

  for (const cat of CATEGORIES) {
    // 候选池：全市场名称匹配 + 配置候选代码
    const byName = universe.filter((q) => matchCategory(q.name, cat))
    const byCode = cat.candidates
      .map((code) => universe.find((q) => q.code === code))
      .filter((q): q is EtfQuote => !!q)

    const map = new Map<string, EtfQuote>()
    for (const q of [...byName, ...byCode]) map.set(q.code, q)
    // 补全候选里 universe 没有的
    for (const code of cat.candidates) {
      if (!map.has(code)) {
        map.set(code, {
          code,
          name: `${cat.name}ETF`,
          price: null,
          changePct: null,
          marketCap: null,
          floatCap: null,
          market: code.startsWith('15') || code.startsWith('16') ? 'SZ' : 'SH',
        })
      }
    }

    const candidates = [...map.values()]

    // 用市值排序；缺失市值的用规模接口净资产补强
    for (const q of candidates) {
      if (q.marketCap == null || q.marketCap <= 0) {
        try {
          await sleep(100)
          const scale = await fetchScaleHistory(q.code)
          const last = scale[scale.length - 1]
          if (last?.netAssetYi) {
            // 亿元 → 元，便于与 f20 比较
            q.marketCap = last.netAssetYi * 1e8
            if (!q.name || q.name.endsWith('ETF')) {
              // 名称保持
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    candidates.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
    const best = candidates[0] ?? {
      code: cat.candidates[0],
      name: `${cat.name}ETF`,
      price: null,
      changePct: null,
      marketCap: null,
      floatCap: null,
      market: cat.candidates[0].startsWith('15') ? 'SZ' : 'SH',
    }

    picked.push({ category: cat, quote: best })
  }
  return picked
}

// ---------- 规模变动（东财 HTML 表）----------
function parseNumberYi(text: string): number | null {
  const t = text.replace(/,/g, '').replace(/%/g, '').trim()
  if (!t || t === '-' || t === '--') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export async function fetchScaleHistory(code: string): Promise<ScalePoint[]> {
  const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd&code=${code}&mode=0&rt=${Math.random()}`
  const text = await fetchText(url, 'https://fundf10.eastmoney.com/')
  // content 在 var gmbd_apidata={ content:"..."}
  const m = text.match(/content:"([\s\S]*?)",\s*summary/)
  const html = m ? m[1].replace(/\\"/g, '"').replace(/\\\//g, '/') : text
  const rowRe =
    /<tr>\s*<td>(\d{4}-\d{2}-\d{2})<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g
  const points: ScalePoint[] = []
  let match: RegExpExecArray | null
  while ((match = rowRe.exec(html))) {
    points.push({
      date: match[1],
      purchaseYi: parseNumberYi(match[2]),
      redeemYi: parseNumberYi(match[3]),
      totalSharesYi: parseNumberYi(match[4]) ?? 0,
      netAssetYi: parseNumberYi(match[5]) ?? 0,
      netAssetChangePct: parseNumberYi(match[6]),
      frequency: 'periodic',
      shareSource: 'eastmoney',
      netAssetEstimated: false,
    })
  }
  points.sort((a, b) => a.date.localeCompare(b.date))
  return points
}

// ---------- 历史净值 ----------
export async function fetchNavHistory(
  code: string,
  // 十大持有人最多覆盖近六年；抓足历史净值，避免旧报告套用最新净值。
  pages = 80,
): Promise<NavPoint[]> {
  const points: NavPoint[] = []
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=50&startDate=&endDate=`
    let pageFailed = true
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const json = await fetchJson<{
          Data?: {
            LSJZList?: {
              FSRQ: string
              DWJZ: string
              LJJZ: string
              JZZZL: string
            }[]
          }
        }>(url, 'https://fundf10.eastmoney.com/')
        const list = json.Data?.LSJZList ?? []
        if (!list.length) {
          pageFailed = false
          break
        }
        for (const row of list) {
          points.push({
            date: row.FSRQ,
            nav: Number(row.DWJZ) || 0,
            accNav: Number(row.LJJZ) || Number(row.DWJZ) || 0,
            changePct:
              row.JZZZL === '' || row.JZZZL == null
                ? null
                : Number(row.JZZZL),
          })
        }
        pageFailed = false
        break
      } catch (e) {
        if (attempt === 2) console.warn(`  nav ${code} page ${page}`, e)
        await sleep(400 * 2 ** attempt)
      }
    }
    if (pageFailed) {
      // 单页彻底失败：记录但继续下一页，不丢整段净值
      console.warn(`  nav ${code} page ${page} 跳过（重试用尽）`)
      continue
    }
    await sleep(120)
  }
  points.sort((a, b) => a.date.localeCompare(b.date))
  return points
}
