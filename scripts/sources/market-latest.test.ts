import { afterEach, describe, expect, test } from 'bun:test'
import type { MarketActiveCapPoint } from '../../shared/types'
import * as eastmoney from './eastmoney'

type MarketBar = { date: string; close: number; amount: number }
type QuoteData = { f43?: number; f48?: number; f59?: number; f86?: number }

function requireFunction<T>(name: string): T {
  const fn = (eastmoney as Record<string, unknown>)[name]
  expect(typeof fn).toBe('function')
  return fn as T
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function previousHistory(): MarketActiveCapPoint[] {
  const dates = [
    '2026-08-03',
    '2026-08-04',
    '2026-08-05',
    '2026-08-06',
    '2026-08-07',
    '2026-08-10',
  ]
  return dates.map((date, index) => ({
    date,
    activeCapYi: 20_000 + index,
    marketIndex: 5900 + index,
    marketAmountYi: 21_000 + index,
    referenceMaYi: index < 4 ? null : 20_000 + index - 2,
  }))
}

describe('最新指数快照 fallback', () => {
  test('解析价格精度、成交额和北京时间交易日', () => {
    const parseLatestMarketBar = requireFunction<
      (data: QuoteData) => MarketBar | null
    >('parseLatestMarketBar')
    expect(
      parseLatestMarketBar({
        f43: 596659,
        f48: 2250454136597,
        f59: 2,
        f86: 1786435918,
      }),
    ).toEqual({
      date: '2026-08-11',
      close: 5966.59,
      amount: 2250454136597,
    })
    expect(
      parseLatestMarketBar({ f43: 0, f48: 0, f59: 2, f86: 1786492893 }),
    ).toBeNull()
  })

  test('在旧序列末尾追加新交易日并重算指标', () => {
    const appendLatestMarketActiveCapHistory = requireFunction<
      (previous: MarketActiveCapPoint[], bars: MarketBar[]) => MarketActiveCapPoint[]
    >('appendLatestMarketActiveCapHistory')
    const previous = previousHistory()
    const result = appendLatestMarketActiveCapHistory(previous, [
      { date: '2026-08-11', close: 5966.59, amount: 2_250_454_136_597 },
      { date: '2026-08-11', close: 3934.09, amount: 1_066_737_091_823.1 },
      { date: '2026-08-11', close: 14259.44, amount: 1_254_248_825_404.6785 },
    ])
    expect(result).toHaveLength(previous.length + 1)
    expect(result.at(-1)?.date).toBe('2026-08-11')
    expect(result.at(-1)?.marketIndex).toBe(5966.59)
    expect(result.at(-1)?.marketAmountYi).toBeCloseTo(23_209.86, 2)
    expect(result.at(-1)?.referenceMaYi).not.toBeNull()
  })

  test('从 stock/get 拉取三指数并追加最新点', async () => {
    const dataBySecid: Record<string, QuoteData> = {
      '1.000985': { f43: 596659, f48: 2250454136597, f59: 2, f86: 1786435918 },
      '1.000001': { f43: 393409, f48: 1066737091823.1, f59: 2, f86: 1786435921 },
      '0.399001': { f43: 1425944, f48: 1254248825404.6785, f59: 2, f86: 1786435884 },
    }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const data = dataBySecid[url.searchParams.get('secid') ?? '']
      return new Response(JSON.stringify({ data }), { status: 200 })
    }) as unknown as typeof fetch
    const fetchLatestMarketActiveCapHistory = requireFunction<
      (previous: MarketActiveCapPoint[]) => Promise<MarketActiveCapPoint[]>
    >('fetchLatestMarketActiveCapHistory')
    const result = await fetchLatestMarketActiveCapHistory(previousHistory())
    expect(result.at(-1)?.date).toBe('2026-08-11')
    expect(result.at(-1)?.marketAmountYi).toBeCloseTo(23_209.86, 2)
  })
})
