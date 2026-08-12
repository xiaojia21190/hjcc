import { afterEach, expect, test } from 'bun:test'
import { fetchTushareMarketBars, parseTushareBars } from './tushare'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('解析 Tushare index_daily 并把千元成交额转换为元', () => {
  const bars = parseTushareBars({
    data: {
      fields: ['ts_code', 'trade_date', 'close', 'amount'],
      items: [['000001.SH', '20260811', 3934.0929, 1066737091.8231]],
    },
  })

  expect(bars).toEqual([
    {
      date: '2026-08-11',
      close: 3934.0929,
      amount: 1066737091823.1,
    },
  ])
})

test('Tushare 请求按 ts_code 返回历史行情', async () => {
  let request: Record<string, unknown> | null = null
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          fields: ['ts_code', 'trade_date', 'close', 'amount'],
          items: [['000001.SH', '20260811', 3934.0929, 1066737091.8231]],
        },
      }),
    )
  }) as unknown as typeof fetch

  const bars = await fetchTushareMarketBars('000001.SH', 'token', '20260801')
  expect(request).toMatchObject({
    api_name: 'index_daily',
    token: 'token',
    params: { ts_code: '000001.SH', start_date: '20260801' },
  })
  expect(bars[0].date).toBe('2026-08-11')
})
