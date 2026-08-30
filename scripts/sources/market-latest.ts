import type { MarketActiveCapPoint } from '../../shared/types'
import type { MarketBar } from './eastmoney'
import { fetchJson, sleep } from './http'

interface MarketQuoteData {
  f43?: number
  f48?: number
  f59?: number
  f86?: number
}

interface MarketQuoteResponse {
  data?: MarketQuoteData | null
}

const QUOTE_HOSTS = [
  'https://push2.eastmoney.com',
  // push2delay 排最后：CDN 节点在 ARM Linux 上会挂起
  'https://push2delay.eastmoney.com',
]

const QUOTE_SPECS = [
  { secid: '1.000985', referer: 'https://quote.eastmoney.com/zs000985.html' },
  { secid: '1.000001', referer: 'https://quote.eastmoney.com/zs000001.html' },
  { secid: '0.399001', referer: 'https://quote.eastmoney.com/sz399001.html' },
] as const

export function parseLatestMarketBar(data: MarketQuoteData): MarketBar | null {
  const precision = Number.isInteger(data.f59) ? data.f59 as number : 2
  const close = Number(data.f43) / 10 ** precision
  const amount = Number(data.f48)
  const timestamp = Number(data.f86)
  if (
    !Number.isFinite(close) ||
    close <= 0 ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    return null
  }
  const date = new Date((timestamp + 8 * 60 * 60) * 1000)
    .toISOString()
    .slice(0, 10)
  return { date, close, amount }
}

export function appendLatestMarketActiveCapHistory(
  previous: MarketActiveCapPoint[],
  bars: MarketBar[],
): MarketActiveCapPoint[] {
  const [price, sh, sz] = bars
  if (!price || !sh || !sz || previous.length < 5) {
    throw new Error('最新指数快照缺少计算 0AMV 所需的数据')
  }
  if (price.date !== sh.date || price.date !== sz.date) {
    throw new Error('最新指数快照交易日不一致')
  }
  if (price.date <= (previous.at(-1)?.date ?? '')) return previous

  let smoothAmountYi = 0
  for (const [index, point] of previous.entries()) {
    smoothAmountYi =
      index === 0
        ? point.marketAmountYi
        : (point.marketAmountYi + 9 * smoothAmountYi) / 10
  }
  const marketAmountYi = (sh.amount + sz.amount) / 1e8
  smoothAmountYi = (marketAmountYi + 9 * smoothAmountYi) / 10
  const priorFiveClose =
    previous
      .slice(-5)
      .reduce((sum, point) => sum + point.marketIndex, 0) / 5
  const activeCapYi = Number(
    ((smoothAmountYi * price.close) / priorFiveClose).toFixed(2),
  )
  const referenceMaYi = Number(
    (
      [...previous.slice(-4).map((point) => point.activeCapYi), activeCapYi]
        .reduce((sum, value) => sum + value, 0) / 5
    ).toFixed(2),
  )
  return [
    ...previous,
    {
      date: price.date,
      activeCapYi,
      marketIndex: Number(price.close.toFixed(2)),
      marketAmountYi: Number(marketAmountYi.toFixed(2)),
      referenceMaYi,
    },
  ]
}

async function fetchLatestBar(
  spec: (typeof QUOTE_SPECS)[number],
): Promise<MarketBar> {
  let lastError: unknown
  for (const host of QUOTE_HOSTS) {
    try {
      const url =
        `${host}/api/qt/stock/get?secid=${spec.secid}` +
        '&fields=f43,f48,f57,f58,f59,f86'
      const response = await fetchJson<MarketQuoteResponse>(url, spec.referer)
      const bar = response.data ? parseLatestMarketBar(response.data) : null
      if (bar) return bar
      lastError = new Error(`${host} 最新指数快照无有效数据`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`最新指数快照抓取失败 ${spec.secid}`)
}

export async function fetchLatestMarketActiveCapHistory(
  previous: MarketActiveCapPoint[],
): Promise<MarketActiveCapPoint[]> {
  const bars: MarketBar[] = []
  for (const spec of QUOTE_SPECS) {
    if (bars.length > 0) await sleep(120)
    bars.push(await fetchLatestBar(spec))
  }
  return appendLatestMarketActiveCapHistory(previous, bars)
}
