// ---------- 行情 / 规模（东财 push2）----------
import { CATEGORIES, matchCategory } from '../../shared/categories'
import type {
  EtfQuote,
  MarketActiveCapPoint,
  NavPoint,
  ScalePoint,
} from '../../shared/types'
import { fetchJson, fetchText, sleep } from './http'

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

export async function fetchMarketBars(
  secid: string,
  referer: string,
): Promise<MarketBar[]> {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&beg=20150101&end=20500101&lmt=5000` +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58'
  const json = await fetchJson<MarketKlineResponse>(url, referer)
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

/**
 * 指南针原版 0AMV 算法未公开。这里采用公开流传的近似公式：
 * SMA(AMOUNT, 10, 1) * CLOSE / MA(REF(CLOSE, 1), 5)。
 * 中证全指 000985 提供市场价格代理；成交额为上证综指与深证成指成交额之和。
 */
export async function fetchMarketActiveCapHistory(): Promise<MarketActiveCapPoint[]> {
  const [priceBars, shBars, szBars] = await Promise.all([
    fetchMarketBars('1.000985', 'https://quote.eastmoney.com/zs000985.html'),
    fetchMarketBars('1.000001', 'https://quote.eastmoney.com/zs000001.html'),
    fetchMarketBars('0.399001', 'https://quote.eastmoney.com/sz399001.html'),
  ])
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
    // 通达信 SMA(X, 10, 1)：Y = (X + 9 * Y') / 10。
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
