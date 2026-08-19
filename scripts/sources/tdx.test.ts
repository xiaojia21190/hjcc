import { expect, test } from 'bun:test'
import {
  buildTdxMarketActiveCapHistory,
  parseTdxKline,
  buildShareLookup,
  deriveTurnoverFromTdx,
  __setMainClientFactory,
  __setExClientFactory,
  __disconnectTdx,
} from './tdx'
import { buildMarketActiveCapHistory } from './eastmoney'
import type { MarketBar } from './eastmoney'

/** 构造一条 tdx 主行情日 K（Price 单位=厘） */
function k(closeLi: number, amountLi: number, date: string): {
  Close: number
  Amount: number
  Time: string
} {
  return { Close: closeLi, Amount: amountLi, Time: `${date}T15:00:00+08:00` }
}

/** 带成交量的 tdx 日 K（volume 单位=手） */
function kv(closeLi: number, amountLi: number, volume: number, date: string) {
  return { close: closeLi, amount: amountLi, volume, time: new Date(`${date}T15:00:00+08:00`) }
}

// ---------- 纯函数（不依赖网络）----------

test('parseTdxKline: 厘→元单位换算', () => {
  const bar = parseTdxKline(k(400000, 888_000_000_000, '2024-08-16'))!
  expect(bar.close).toBe(400) // 400000 厘 = 400 元
  expect(bar.amount).toBe(888_000_000_000 / 1000) // = 888 亿元（元）
  expect(bar.date).toBe('2024-08-16')
})

test('parseTdxKline: 拒绝无效值', () => {
  expect(parseTdxKline(k(0, 1000, '2024-08-16'))).toBeNull() // close<=0
  expect(parseTdxKline(k(100, 0, '2024-08-16'))).toBeNull() // amount<=0
  expect(parseTdxKline(k(100, 1000, 'bad-date'))).toBeNull()
})

test('buildTdxMarketActiveCapHistory: 与 eastmoney 同口径', () => {
  const series = makeSeries(12)
  // 用相同输入跑 eastmoney 的实现，断言两者逐点完全一致——这才是"同口径"的真正验证
  const expected = buildMarketActiveCapHistory(series)
  const out = buildTdxMarketActiveCapHistory(series)
  expect(out.length).toBe(expected.length)
  expect(out).toEqual(expected)
  expect(out.length).toBe(7)
  expect(out[0].date).toBe('2024-01-06')
  expect(out[0].referenceMaYi).toBeNull()
  expect(out[4].referenceMaYi).not.toBeNull()
})

test('buildShareLookup: 向前填充（日期<=当日的最近一条）', () => {
  const lookup = buildShareLookup([
    { date: '2024-01-02', totalSharesYi: 100 },
    { date: '2024-01-08', totalSharesYi: 120 },
  ])
  expect(lookup('2024-01-01')).toBeNull()
  expect(lookup('2024-01-02')).toBe(100)
  expect(lookup('2024-01-05')).toBe(100) // 向前填充
  expect(lookup('2024-01-08')).toBe(120)
  expect(lookup('2024-01-10')).toBe(120) // 晚于末条沿用
})

test('deriveTurnoverFromTdx: 换手率口径 = 成交量(股)/总份额(股)×100', () => {
  // volume=500万手=5亿股，总份额=100亿份 → 5%
  const klines = [
    { date: '2024-01-02', close: 1, amount: 1e10, volume: 5_000_000 },
  ]
  const shares = [{ date: '2024-01-02', totalSharesYi: 100 }]
  const out = deriveTurnoverFromTdx(klines, shares)
  expect(out.length).toBe(1)
  expect(out[0].date).toBe('2024-01-02')
  expect(out[0].turnoverPct).toBe(5)
  expect(out[0].amountYuan).toBe(1e10)
})

test('deriveTurnoverFromTdx: 份额未覆盖的早期跳过', () => {
  const klines = [
    { date: '2023-12-29', close: 1, amount: 1e10, volume: 1_000_000 },
    { date: '2024-01-02', close: 1, amount: 1e10, volume: 1_000_000 },
  ]
  const shares = [{ date: '2024-01-02', totalSharesYi: 100 }]
  const out = deriveTurnoverFromTdx(klines, shares)
  expect(out.length).toBe(1)
  expect(out[0].date).toBe('2024-01-02')
})

test('deriveTurnoverFromTdx: 空输入返回空', () => {
  expect(deriveTurnoverFromTdx([], [])).toEqual([])
  expect(
    deriveTurnoverFromTdx(
      [{ date: '2024-01-02', close: 1, amount: 1, volume: 1 }],
      [],
    ),
  ).toEqual([])
})

// ---------- IO 测试（mock client 工厂，不联网）----------

/** 造一个 fake TdxClient，只实现 getKline */
function fakeMainClient(getKlineImpl: (req: { code: string }) => { bars: any[]; count: number }) {
  return {
    isConnected: true,
    on: () => {},
    connect: async () => 'fake-host:7709',
    disconnect: () => {},
    getKline: async (req: { code: string }) => getKlineImpl(req),
  } as unknown as import('node-tdx-market').TdxClient
}

test('fetchTdxIndexBars / fetchTdxKlineBars: 解析 + 升序 + volume', async () => {
  const bars = [
    kv(300000, 1_000_000_000_000, 5_000_000, '2024-08-17'), // 故意倒序
    kv(299000, 900_000_000_000, 4_500_000, '2024-08-16'),
  ]
  __setMainClientFactory(() => fakeMainClient(() => ({ bars, count: bars.length })))
  const { fetchTdxIndexBars, fetchTdxKlineBars } = await import('./tdx')

  const idx = await fetchTdxIndexBars('sh000001')
  expect(idx.map((b) => b.date)).toEqual(['2024-08-16', '2024-08-17'])
  expect(idx[0].close).toBe(299)

  const kl = await fetchTdxKlineBars('510050')
  expect(kl[0].volume).toBe(4_500_000)
  expect(kl[1].amount).toBe(1_000_000_000) // 厘→元
  await __disconnectTdx()
  __setMainClientFactory(null)
})

test('fetchTdxKlineBars: volume<=0 的点被拒', async () => {
  const bars = [
    kv(300000, 1_000_000_000_000, 0, '2024-08-16'), // volume=0 拒
    kv(301000, 1_100_000_000_000, 100, '2024-08-19'),
  ]
  __setMainClientFactory(() => fakeMainClient(() => ({ bars, count: bars.length })))
  const { fetchTdxKlineBars } = await import('./tdx')
  const out = await fetchTdxKlineBars('510050')
  expect(out.length).toBe(1)
  expect(out[0].date).toBe('2024-08-19')
  await __disconnectTdx()
  __setMainClientFactory(null)
})

test('fetchTdxIndexBars: 空序列抛出', async () => {
  __setMainClientFactory(() => fakeMainClient(() => ({ bars: [], count: 0 })))
  const { fetchTdxIndexBars } = await import('./tdx')
  expect(async () => {
    await fetchTdxIndexBars('sh000001')
  }).toThrow(/为空/)
  await __disconnectTdx()
  __setMainClientFactory(null)
})

// ---------- 辅助 ----------

/** 构造 N 日三指数序列（close 与 amount 均为元），用于 0AMV 合成 */
function makeSeries(days: number): MarketBar[][] {
  const price: MarketBar[] = []
  const sh: MarketBar[] = []
  const sz: MarketBar[] = []
  for (let i = 0; i < days; i++) {
    const d = `2024-01-${String(i + 1).padStart(2, '0')}`
    price.push({ date: d, close: 1000 + i, amount: 0 })
    sh.push({ date: d, close: 0, amount: 100e8 + i * 1e8 })
    sz.push({ date: d, close: 0, amount: 50e8 + i * 1e8 })
  }
  return [price, sh, sz]
}
