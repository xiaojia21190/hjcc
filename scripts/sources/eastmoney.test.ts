import { afterEach, describe, expect, test } from 'bun:test'
import { fetchMarketBars, mergeQuoteWithPrevious } from './eastmoney'

/**
 * 东财 kline 响应字段序：date,open,close,high,low,成交量,成交额,换手率。
 * parseKlines 取第 0 列 date、第 2 列 close、第 6 列 amount，故这里构造时把
 * amount 放第 6 列（0-indexed）。
 */
function klineResponse(rows: Array<[string, number, number]>): string {
  const klines = rows.map(
    ([d, close, amount]) => `${d},1,${close},2,0,999,${amount},0`,
  )
  return JSON.stringify({ data: { code: 'mock', name: 'mock', klines } })
}

/** 构造一个能被 fetchJson 当作标准 Response 处理的最小假响应。 */
function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('盘前无效报价沿用上次有效值', () => {
  const result = mergeQuoteWithPrevious(
    {
      code: '510050', name: 'ETF', price: 0, changePct: 0,
      marketCap: 1, floatCap: 1, market: 'SH',
    },
    {
      code: '510050', name: 'ETF', price: 3.12, changePct: 1.2,
      marketCap: 2, floatCap: 2, market: 'SH',
    },
  )
  expect(result.price).toBe(3.12)
  expect(result.changePct).toBe(1.2)
})

test('无效报价且无历史值时归一化为 null', () => {
  const result = mergeQuoteWithPrevious({
    code: '510050', name: 'ETF', price: 0, changePct: 0,
    marketCap: 1, floatCap: 1, market: 'SH',
  })
  expect(result.price).toBeNull()
  expect(result.changePct).toBeNull()
})

/**
 * fetchMarketBars 内部按 KLINE_HOSTS 顺序探测，每条请求都打全局 fetch。
 * 测试通过计数调用次数来断言重试是否发生；注入 retryDelayMs: 0 跳过真实 sleep。
 */
describe('fetchMarketBars 间歇封禁容错', () => {
  test('首轮成功直接返回，不进入重试轮', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return jsonResponse(
        klineResponse([
          ['2024-01-02', 100, 1_000_000],
          ['2024-01-03', 101, 1_100_000],
        ]),
      )
    }) as unknown as typeof fetch

    const bars = await fetchMarketBars('1.000985', 'https://quote.eastmoney.com/', {
      retryDelayMs: 0,
    })
    expect(calls).toBe(1)
    expect(bars.length).toBe(2)
    expect(bars[1].close).toBe(101)
    expect(bars[1].amount).toBe(1_100_000)
  })

  test('空 klines 后延迟重试一轮，第二轮恢复即成功', async () => {
    // 关键：验证间歇抖动恢复。首轮三域名全空 → 抛「空 klines」→ 重试。
    // 第二轮首个域名返回有效数据即命中。
    let round = 0
    globalThis.fetch = (async () => {
      round += 1
      // 第 1~3 次调用（首轮三域名）全空；第 4 次（重试首个域名）命中
      if (round <= 3) return jsonResponse(klineResponse([]))
      return jsonResponse(
        klineResponse([
          ['2024-01-02', 100, 1_000_000],
          ['2024-01-03', 101, 1_100_000],
        ]),
      )
    }) as unknown as typeof fetch

    const bars = await fetchMarketBars('1.000985', 'https://quote.eastmoney.com/', {
      retryDelayMs: 0,
    })
    expect(round).toBe(4) // 首轮 3 + 重试第 1 个域名即中
    expect(bars.length).toBe(2)
  })

  test('持续空响应：重试用尽后抛「空 klines」', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return jsonResponse(klineResponse([]))
    }) as unknown as typeof fetch

    await expect(
      fetchMarketBars('1.000985', 'https://quote.eastmoney.com/', {
        retryDelayMs: 0,
        retryRounds: 1,
      }),
    ).rejects.toThrow(/返回空 klines/)
    // 首轮 3 + 重试轮 3 = 6
    expect(calls).toBe(6)
  })
})
