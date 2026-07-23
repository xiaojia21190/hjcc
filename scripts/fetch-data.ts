/**
 * 数据抓取：新浪财经十大持有人 + 东方财富规模/净值/行情
 * 仅使用公开网页接口，结果落盘 data/dashboard.json
 */
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  CATEGORIES,
  isHuijinHolder,
  matchCategory,
} from '../shared/categories'
import type {
  DashboardData,
  EtfQuote,
  EtfSnapshot,
  HolderReport,
  HolderRow,
  HuijinPosition,
  MarketActiveCapPoint,
  NavPoint,
  ScalePoint,
} from '../shared/types'

type HuijinEstimate = EtfSnapshot['huijinEstimateHistory'][number]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const ROOT = join(import.meta.dir, '..')
const DATA_DIR = join(ROOT, 'data')
const OUT_FILE = join(DATA_DIR, 'dashboard.json')

async function loadPreviousDashboard(): Promise<DashboardData | null> {
  const candidates = [
    OUT_FILE,
    join(ROOT, 'public', 'dashboard.json'),
    join(ROOT, 'dist', 'dashboard.json'),
  ]
  let best: DashboardData | null = null
  let bestReports = 0
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf-8')) as DashboardData
      const reports = parsed.etfs.reduce(
        (sum, etf) => sum + (etf.holderReports?.length ?? 0),
        0,
      )
      if (reports > bestReports) {
        best = parsed
        bestReports = reports
      }
    } catch {
      /* no previous snapshot at this path */
    }
  }
  return best
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchText(
  url: string,
  referer = 'https://finance.sina.com.cn/',
  retries = 3,
): Promise<string> {
  let lastErr: unknown
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: referer,
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
      const buf = await res.arrayBuffer()
      const bytes = new Uint8Array(buf)
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return new TextDecoder('gbk').decode(bytes)
      }
    } catch (e) {
      lastErr = e
      await sleep(400 * (i + 1))
    }
  }
  throw lastErr
}

async function fetchJson<T = unknown>(
  url: string,
  referer?: string,
): Promise<T> {
  const text = await fetchText(url, referer)
  // strip jsonp
  const m = text.match(/^[a-zA-Z_$][\w$]*\(([\s\S]*)\)\s*;?\s*$/)
  const body = m ? m[1] : text
  return JSON.parse(body) as T
}

// ---------- 行情 / 规模（东财 push2）----------
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

async function fetchEtfUniverse(): Promise<EtfQuote[]> {
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

async function fetchMarketBars(
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
async function fetchMarketActiveCapHistory(): Promise<MarketActiveCapPoint[]> {
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
async function fetchQuotesByCandidates(): Promise<EtfQuote[]> {
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
async function pickLargestPerCategory(universe: EtfQuote[]) {
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

// ---------- 十大持有人（新浪）----------
interface SinaHolder {
  cyrmc: string
  cyfe: string
  zfeb: string
}
interface SinaDate {
  PUBLISHDATE: string
}

async function fetchHolderDates(code: string): Promise<string[]> {
  const url = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FundPageInfoService.tabsdcyr?symbol=${code}`
  const json = await fetchJson<{
    result?: { data?: { dates?: SinaDate[]; info?: SinaHolder[] } | null }
  }>(url)
  const dates = json.result?.data?.dates ?? []
  return dates.map((d) => d.PUBLISHDATE).filter(Boolean)
}

async function fetchHoldersOnDate(
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

async function fetchAllHolderReports(
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

// ---------- 规模变动（东财 HTML 表）----------
function parseNumberYi(text: string): number | null {
  const t = text.replace(/,/g, '').replace(/%/g, '').trim()
  if (!t || t === '-' || t === '--') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

interface OfficialDailySharePoint {
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

const OFFICIAL_SHARE_BACKFILL_TRADING_DAYS = 250
const OFFICIAL_SHARE_OVERLAP_TRADING_DAYS = 5

function officialPointsFromSnapshot(
  snapshot?: EtfSnapshot,
): OfficialDailySharePoint[] {
  if (!snapshot) return []
  return snapshot.scaleHistory
    .filter(
      (point) =>
        point.frequency === 'daily' &&
        (point.shareSource === 'sse' || point.shareSource === 'szse'),
    )
    .map((point) => ({
      date: point.date,
      totalSharesYi: point.totalSharesYi,
      shareSource: point.shareSource as 'sse' | 'szse',
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function mergeOfficialPoints(
  previous: OfficialDailySharePoint[],
  fetched: OfficialDailySharePoint[],
): OfficialDailySharePoint[] {
  const byDate = new Map(previous.map((point) => [point.date, point]))
  for (const point of fetched) byDate.set(point.date, point)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function fallbackWeekdays(): string[] {
  const dates: string[] = []
  const cursor = new Date()
  for (let offset = 0; offset < 420; offset++) {
    const day = new Date(cursor)
    day.setUTCDate(day.getUTCDate() - offset)
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      dates.push(day.toISOString().slice(0, 10))
    }
  }
  return dates.reverse()
}

function officialFetchDates(
  existing: OfficialDailySharePoint[],
  marketDates: string[],
): string[] {
  const dates = marketDates.length ? marketDates : fallbackWeekdays()
  const latestExisting = existing.at(-1)?.date
  if (!latestExisting) {
    return dates.slice(-OFFICIAL_SHARE_BACKFILL_TRADING_DAYS)
  }
  const nextIndex = dates.findIndex((date) => date > latestExisting)
  const anchor = nextIndex >= 0 ? nextIndex : dates.length - 1
  return dates.slice(Math.max(0, anchor - OFFICIAL_SHARE_OVERLAP_TRADING_DAYS))
}

async function fetchSseDailyShares(
  codes: string[],
  dates: string[],
): Promise<Map<string, OfficialDailySharePoint[]>> {
  const wanted = new Set(codes)
  const fetched = new Map(codes.map((code) => [code, [] as OfficialDailySharePoint[]]))
  for (let start = 0; start < dates.length; start += 4) {
    const batch = dates.slice(start, start + 4)
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
        try {
          const json = await fetchJson<SseScaleResponse>(
            `https://query.sse.com.cn/commonQuery.do?${params}`,
            'https://www.sse.com.cn/assortment/fund/etf/list/scale/',
          )
          for (const row of json.result ?? []) {
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
        } catch (error) {
          console.warn(`  上交所 ETF 份额 ${date} 抓取失败`, error)
        }
      }),
    )
    await sleep(80)
  }
  return fetched
}

function splitDateRanges(start: string, end: string): Array<[string, string]> {
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

function normalizeSzseRows(data: SzseScaleResponse['data']): SzseScaleRow[] {
  if (!data) return []
  return Array.isArray(data) ? data : [data]
}

async function fetchSzseDailyShares(
  code: string,
  startDate: string,
  endDate: string,
): Promise<OfficialDailySharePoint[]> {
  const points: OfficialDailySharePoint[] = []
  for (const [rangeStart, rangeEnd] of splitDateRanges(startDate, endDate)) {
    let page = 1
    let pageCount = 1
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
      } catch (error) {
        console.warn(
          `  深交所 ETF 份额 ${code} ${rangeStart}..${rangeEnd} 第 ${page} 页抓取失败`,
          error,
        )
        break
      }
      page += 1
      await sleep(80)
    } while (page <= pageCount)
  }
  return mergeOfficialPoints([], points)
}

async function fetchOfficialShareHistories(
  picks: Array<{ quote: EtfQuote }>,
  previous: DashboardData | null,
  marketDates: string[],
): Promise<Map<string, OfficialDailySharePoint[]>> {
  const histories = new Map<string, OfficialDailySharePoint[]>()
  const fetchDatesByCode = new Map<string, string[]>()
  for (const { quote } of picks) {
    const prior = officialPointsFromSnapshot(
      previous?.etfs.find((etf) => etf.code === quote.code),
    )
    histories.set(quote.code, prior)
    fetchDatesByCode.set(quote.code, officialFetchDates(prior, marketDates))
  }

  const shCodes = picks
    .map(({ quote }) => quote)
    .filter((quote) => quote.market === 'SH')
    .map((quote) => quote.code)
  const shDates = [
    ...new Set(shCodes.flatMap((code) => fetchDatesByCode.get(code) ?? [])),
  ].sort()
  if (shCodes.length && shDates.length) {
    const fetched = await fetchSseDailyShares(shCodes, shDates)
    for (const code of shCodes) {
      histories.set(
        code,
        mergeOfficialPoints(histories.get(code) ?? [], fetched.get(code) ?? []),
      )
    }
    console.log(`上交所 ETF 日份额：${shCodes.length} 只，查询 ${shDates.length} 个交易日`)
  }

  const szQuotes = picks
    .map(({ quote }) => quote)
    .filter((quote) => quote.market === 'SZ')
  for (const quote of szQuotes) {
    const dates = fetchDatesByCode.get(quote.code) ?? []
    if (!dates.length) continue
    const fetched = await fetchSzseDailyShares(
      quote.code,
      dates[0],
      dates[dates.length - 1],
    )
    histories.set(
      quote.code,
      mergeOfficialPoints(histories.get(quote.code) ?? [], fetched),
    )
    console.log(`深交所 ETF 日份额：${quote.code} 共 ${histories.get(quote.code)?.length ?? 0} 条`)
  }

  return histories
}

async function fetchScaleHistory(code: string): Promise<ScalePoint[]> {
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
async function fetchNavHistory(
  code: string,
  // 十大持有人最多覆盖近六年；抓足历史净值，避免旧报告套用最新净值。
  pages = 80,
): Promise<NavPoint[]> {
  const points: NavPoint[] = []
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=50&startDate=&endDate=`
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
      if (!list.length) break
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
      await sleep(120)
    } catch (e) {
      console.warn(`  nav ${code} page ${page}`, e)
      break
    }
  }
  points.sort((a, b) => a.date.localeCompare(b.date))
  return points
}

function nearestNav(
  navs: NavPoint[],
  date: string,
): number | null {
  if (!navs.length) return null
  // 找 <= date 最近的
  let best: NavPoint | null = null
  for (const n of navs) {
    if (n.date <= date) best = n
    else break
  }
  if (best) return best.nav
  // 目标日期早于已抓到的最早净值时不能回退到最新净值，否则会产生数量级错误。
  return null
}

function mergeScaleHistory(
  periodic: ScalePoint[],
  official: OfficialDailySharePoint[],
  navs: NavPoint[],
): ScalePoint[] {
  if (!official.length) {
    return periodic
      .map((point) => ({
        ...point,
        frequency: point.frequency ?? 'periodic',
        shareSource: point.shareSource ?? 'eastmoney',
        netAssetEstimated: point.netAssetEstimated ?? false,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  const periodicByDate = new Map(periodic.map((point) => [point.date, point]))
  const daily: ScalePoint[] = []
  let prior: OfficialDailySharePoint | null = null
  for (const point of official) {
    const disclosed = periodicByDate.get(point.date)
    const nav = nearestNav(navs, point.date)
    const estimatedNetAsset =
      disclosed?.netAssetYi && disclosed.netAssetYi > 0
        ? disclosed.netAssetYi
        : nav != null
          ? Number((point.totalSharesYi * nav).toFixed(6))
          : 0
    const netSubscriptionYi = prior
      ? Number((point.totalSharesYi - prior.totalSharesYi).toFixed(6))
      : null
    daily.push({
      date: point.date,
      totalSharesYi: point.totalSharesYi,
      purchaseYi: disclosed?.purchaseYi ?? null,
      redeemYi: disclosed?.redeemYi ?? null,
      netSubscriptionYi,
      netAssetYi: estimatedNetAsset,
      netAssetChangePct: disclosed?.netAssetChangePct ?? null,
      frequency: 'daily',
      shareSource: point.shareSource,
      netAssetEstimated: !(disclosed?.netAssetYi && disclosed.netAssetYi > 0),
    })
    prior = point
  }

  const dailyDates = new Set(daily.map((point) => point.date))
  return [
    ...periodic.filter((point) => !dailyDates.has(point.date)),
    ...daily,
  ]
    .map((point) => ({
      ...point,
      frequency: point.frequency ?? 'periodic',
      shareSource: point.shareSource ?? 'eastmoney',
      netAssetEstimated: point.netAssetEstimated ?? false,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function buildHuijinHistory(
  reports: HolderReport[],
  navs: NavPoint[],
): HuijinPosition[] {
  return reports
    .filter((r) => r.huijinShares > 0)
    .map((r) => {
      const entities = r.holders
        .filter((h) => h.isHuijin)
        .map((h) => ({
          name: h.name,
          shares: h.shares,
          percent: h.percent,
        }))
      const nav = nearestNav(navs, r.reportDate)
      return {
        reportDate: r.reportDate,
        shares: r.huijinShares,
        percent: r.huijinPercent,
        marketValue: nav != null ? r.huijinShares * nav : null,
        entities,
      } satisfies HuijinPosition
    })
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
}

function dedupeHolderReports(reports: HolderReport[]): HolderReport[] {
  const seen = new Set<string>()
  return reports.filter((report) => {
    const fingerprint = JSON.stringify(
      report.holders.map((holder) => [holder.name, holder.shares, holder.percent]),
    )
    if (seen.has(fingerprint)) return false
    seen.add(fingerprint)
    return true
  })
}

function buildHuijinEstimate(
  scale: ScalePoint[],
  reports: HolderReport[],
  navs: NavPoint[],
): HuijinEstimate[] {
  const huijinReports = reports
    .filter((report) => report.huijinShares > 0)
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
  const disclosedByDate = new Map(
    huijinReports.map((report) => [report.reportDate, report]),
  )
  // 只取最近一期汇金披露作为份额锚点，不做历史区间回填
  const latestAnchor =
    huijinReports.length > 0
      ? huijinReports[huijinReports.length - 1]
      : null

  return scale.map((s) => {
    const report = disclosedByDate.get(s.date)
    const nav =
      nearestNav(navs, s.date) ??
      (s.totalSharesYi > 0 ? s.netAssetYi / s.totalSharesYi : null)

    if (report) {
      const huijinValueYi =
        nav != null ? (report.huijinShares * nav) / 1e8 : null
      return {
        date: s.date,
        netAssetYi: s.netAssetYi,
        totalSharesYi: s.totalSharesYi,
        huijinShares: report.huijinShares,
        huijinValueYi:
          huijinValueYi != null ? Number(huijinValueYi.toFixed(4)) : null,
        huijinPct: report.huijinPercent,
        isEstimated: false,
        estimateMethod: 'disclosed',
      }
    }

    // 份额锚定估算：仅在最近一期披露之后生成，假设汇金不主动赎回
    if (
      latestAnchor &&
      s.date > latestAnchor.reportDate &&
      s.frequency === 'daily' &&
      s.totalSharesYi > 0
    ) {
      const totalShares = s.totalSharesYi * 1e8
      const clampTriggered = totalShares < latestAnchor.huijinShares
      const estShares = Math.round(
        clampTriggered ? totalShares : latestAnchor.huijinShares,
      )
      const huijinValueYi =
        nav != null ? Number(((estShares * nav) / 1e8).toFixed(4)) : null
      return {
        date: s.date,
        netAssetYi: s.netAssetYi,
        totalSharesYi: s.totalSharesYi,
        huijinShares: estShares,
        huijinValueYi,
        huijinPct: clampTriggered
          ? 100
          : Number(
              ((latestAnchor.huijinShares / totalShares) * 100).toFixed(2),
            ),
        isEstimated: true,
        estimateMethod: 'anchored',
        clampTriggered,
      }
    }

    return {
      date: s.date,
      netAssetYi: s.netAssetYi,
      totalSharesYi: s.totalSharesYi,
      huijinShares: null,
      huijinValueYi: null,
      huijinPct: null,
      isEstimated: false,
      estimateMethod: 'unavailable',
      unavailableReason: !latestAnchor
        ? '暂无汇金持仓披露'
        : s.date <= latestAnchor.reportDate
          ? '最近披露日及之前，仅展示正式披露点'
          : '非日频份额数据点，不推算汇金持仓',
    }
  })
}

async function buildEtfSnapshot(
  category: (typeof CATEGORIES)[number],
  quote: EtfQuote,
  officialDailyShares: OfficialDailySharePoint[],
  previous?: EtfSnapshot,
): Promise<EtfSnapshot> {
  const code = quote.code
  console.log(`\n→ ${category.name} ${code} ${quote.name}`)

  const [holderReportsFetched, scaleHistoryFetched, navHistoryFetched] =
    await Promise.all([
      fetchAllHolderReports(code, 12),
      fetchScaleHistory(code),
      fetchNavHistory(code, 80),
    ])

  const holdersFromCache =
    holderReportsFetched.length === 0 && (previous?.holderReports.length ?? 0) > 0
  const rawHolderReports = holdersFromCache
    ? previous?.holderReports ?? []
    : holderReportsFetched
  const holderReports = dedupeHolderReports(rawHolderReports)
  const holdersHistoryDeduplicated =
    holderReports.length < rawHolderReports.length ||
    previous?.source.holdersHistoryDeduplicated === true
  const periodicScaleHistory =
    scaleHistoryFetched.length > 0
      ? scaleHistoryFetched
      : (previous?.scaleHistory ?? []).filter(
          (point) => point.frequency !== 'daily',
        )
  const navHistory =
    navHistoryFetched.length > 0
      ? navHistoryFetched
      : previous?.navHistory ?? []
  const scaleHistory = mergeScaleHistory(
    periodicScaleHistory,
    officialDailyShares,
    navHistory,
  )

  console.log(
    `  holders=${holderReports.length}${holdersFromCache ? ' (cache)' : ''} scale=${scaleHistory.length} daily=${officialDailyShares.length} nav=${navHistory.length}`,
  )

  const disclosedHuijinHistory = buildHuijinHistory(holderReports, navHistory)
  const huijinEstimateHistory = buildHuijinEstimate(
    scaleHistory,
    holderReports,
    navHistory,
  )
  const huijinHistory = disclosedHuijinHistory
  const latestHuijin =
    disclosedHuijinHistory.length > 0
      ? disclosedHuijinHistory[disclosedHuijinHistory.length - 1]
      : null

  return {
    category: category.id,
    categoryName: category.name,
    code,
    name: quote.name,
    market: quote.market,
    quote,
    isLargest: true,
    scaleHistory,
    navHistory,
    holderReports,
    huijinHistory,
    latestHuijin,
    huijinEstimateHistory,
    source: {
      holders:
        '新浪财经 FundPageInfoService.tabsdcyr（基金年报/半年报十大持有人）',
      scale:
        '上交所/深交所 ETF 规模（每日总份额）+ 天天基金 FundArchivesDatas type=gmbd（定期净资产）',
      quote: '东方财富 push2 / push2delay clist 完整分页（按 ETF 总市值选取）',
      huijinEstimate:
        '披露日展示正式披露份额与估值；最后披露期之后按份额锚定法估算（假设汇金不主动赎回，估算份额 = min(披露份额, 当日总份额)，总份额低于披露份额时触发 clamp 并标记可靠性下降）',
      holdersFromCache,
      holdersHistoryDeduplicated,
      holdersFetchedAt: holdersFromCache
        ? previous?.source.fetchedAt
        : new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    },
  }
}

async function main() {
  const previous = await loadPreviousDashboard()
  if (previous) {
    console.log(`发现上次快照 ${previous.updatedAt}，接口无有效报告时将保留该数据`)
  }
  console.log('抓取 ETF 全市场行情…')
  const [universe, marketActiveCapFetched] = await Promise.all([
    fetchEtfUniverse(),
    fetchMarketActiveCapHistory().catch((error) => {
      console.warn('中证全指 0AMV 数据抓取失败，将尝试沿用上次快照', error)
      return []
    }),
  ])
  const marketActiveCapHistory =
    marketActiveCapFetched.length > 0
      ? marketActiveCapFetched
      : previous?.marketActiveCapHistory ?? []
  console.log(`共 ${universe.length} 只 ETF`)
  console.log(`0AMV 市场日线 ${marketActiveCapHistory.length} 条`)

  const picked = await pickLargestPerCategory(universe)
  for (const p of picked) {
    console.log(
      `  选中 ${p.category.name}: ${p.quote.code} ${p.quote.name} 市值=${((p.quote.marketCap ?? 0) / 1e8).toFixed(2)} 亿`,
    )
  }

  console.log('抓取交易所 ETF 每日总份额…')
  const officialShareHistories = await fetchOfficialShareHistories(
    picked,
    previous,
    marketActiveCapHistory.map((point) => point.date),
  )

  const etfs: EtfSnapshot[] = []
  for (const p of picked) {
    try {
      const snap = await buildEtfSnapshot(
        p.category,
        p.quote,
        officialShareHistories.get(p.quote.code) ?? [],
        previous?.etfs.find((e) => e.code === p.quote.code),
      )
      etfs.push(snap)
      await sleep(300)
    } catch (e) {
      console.error(`失败 ${p.quote.code}`, e)
    }
  }

  let totalMv: number | null = 0
  let latestReport: string | null = null
  for (const e of etfs) {
    if (e.latestHuijin?.marketValue != null && totalMv != null) {
      totalMv += e.latestHuijin.marketValue
    }
    if (
      e.latestHuijin &&
      (!latestReport ||
        e.latestHuijin.reportDate > latestReport)
    ) {
      latestReport = e.latestHuijin.reportDate
    }
  }

  const latestActiveCap = marketActiveCapHistory.at(-1)

  const dashboard: DashboardData = {
    updatedAt: new Date().toISOString(),
    categories: CATEGORIES,
    etfs,
    marketActiveCapHistory,
    marketActiveCapSource:
      '指南针 0AMV（活筹指数）公开近似公式：SMA(沪深两市成交额,10,1) × 中证全指收盘 / 前5日中证全指均值；价格代理来自东方财富中证全指 000985，成交额为上证综指 000001 与深证成指 399001 日成交额之和。指南针原版算法未公开，本序列用于观察方向和趋势，不等同于 ETF 份额、基金净资产或官方 0AMV 绝对值。',
    summary: {
      totalHuijinMarketValue: totalMv,
      latestActiveCapYi: latestActiveCap?.activeCapYi ?? null,
      latestActiveCapDate: latestActiveCap?.date ?? null,
      etfCount: etfs.length,
      latestReportDate: latestReport,
    },
  }

  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(dashboard, null, 2), 'utf-8')
  // 同时写一份给前端 public
  await mkdir(join(ROOT, 'public'), { recursive: true })
  await writeFile(
    join(ROOT, 'public', 'dashboard.json'),
    JSON.stringify(dashboard, null, 2),
    'utf-8',
  )
  console.log(`\n✓ 已写入 ${OUT_FILE}`)
  console.log(
    `  最近披露汇金合计估值: ${totalMv != null ? (totalMv / 1e8).toFixed(2) + ' 亿元' : 'N/A'}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
