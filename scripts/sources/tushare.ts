import type { MarketBar } from './eastmoney'

interface TushareResponse {
  code?: number
  msg?: string
  data?: {
    fields?: string[]
    items?: unknown[][]
  } | null
}

const TUSHARE_URL = 'https://api.tushare.pro'

/** Tushare index_daily 的 amount 单位是千元，项目内部统一使用元。 */
export function parseTushareBars(response: TushareResponse): MarketBar[] {
  const fields = response.data?.fields ?? []
  const items = response.data?.items ?? []
  const dateIndex = fields.indexOf('trade_date')
  const closeIndex = fields.indexOf('close')
  const amountIndex = fields.indexOf('amount')
  if (dateIndex < 0 || closeIndex < 0 || amountIndex < 0) return []

  return items
    .map((item) => {
      const date = String(item[dateIndex] ?? '')
      const close = Number(item[closeIndex])
      const amountInThousand = Number(item[amountIndex])
      return {
        date: date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
        close,
        amount: amountInThousand * 1000,
      }
    })
    .filter(
      (bar) =>
        /^\d{4}-\d{2}-\d{2}$/.test(bar.date) &&
        Number.isFinite(bar.close) &&
        bar.close > 0 &&
        Number.isFinite(bar.amount) &&
        bar.amount > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
}

export async function fetchTushareMarketBars(
  tsCode: string,
  token: string,
  startDate = '20150101',
): Promise<MarketBar[]> {
  const res = await fetch(TUSHARE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({
      api_name: 'index_daily',
      token,
      params: { ts_code: tsCode, start_date: startDate, end_date: '20500101' },
      fields: 'ts_code,trade_date,close,amount',
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Tushare HTTP ${res.status}`)
  const response = (await res.json()) as TushareResponse
  if (response.code !== 0) {
    throw new Error(`Tushare index_daily failed: ${response.msg ?? 'unknown error'}`)
  }
  const bars = parseTushareBars(response)
  if (bars.length === 0) throw new Error(`Tushare index_daily returned no bars: ${tsCode}`)
  return bars
}

export async function fetchTushareMarketSeries(
  token: string,
  startDate = '20150101',
): Promise<MarketBar[][]> {
  const specs = ['000985.CSI', '000001.SH', '399001.SZ']
  const series: MarketBar[][] = []
  for (const code of specs) {
    series.push(await fetchTushareMarketBars(code, token, startDate))
  }
  return series
}
