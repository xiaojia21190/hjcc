import { describe, expect, test } from 'bun:test'
import { composeForceBriefing, type BriefingEtfInput } from './forceBriefing'
import type { ForceMarketInput } from './forceVerdict'

function etf(
  partial: Partial<BriefingEtfInput> & { categoryName: string },
): BriefingEtfInput {
  return {
    hasHuijinDisclosure: true,
    shareTrend: 'flat',
    consecutiveDays: 1,
    shareChangePct5d: 0,
    shareDate: '2026-08-13',
    priceChangePct5d: 0,
    lowResolution: false,
    lastSharesYi: 100,
    sharesYi5dAgo: 100,
    quotePrice: 3,
    ...partial,
  }
}

const outflowBasket: BriefingEtfInput[] = [
  etf({
    categoryName: '上证50',
    shareTrend: 'outflow',
    consecutiveDays: 2,
    shareChangePct5d: -1.99,
    priceChangePct5d: 0.22,
    lastSharesYi: 69.67,
    sharesYi5dAgo: 71.08,
    quotePrice: 3.023,
  }),
  etf({
    categoryName: '沪深300',
    shareTrend: 'outflow',
    consecutiveDays: 8,
    shareChangePct5d: -7.88,
    priceChangePct5d: 0.28,
    lastSharesYi: 236.79,
    sharesYi5dAgo: 257.05,
    quotePrice: 4.719,
  }),
  etf({
    categoryName: '中证500',
    shareTrend: 'outflow',
    consecutiveDays: 8,
    shareChangePct5d: -10.1,
    priceChangePct5d: 1.74,
    lastSharesYi: 51.53,
    sharesYi5dAgo: 57.32,
    quotePrice: 7.965,
  }),
  etf({
    categoryName: '中证1000',
    shareTrend: 'outflow',
    consecutiveDays: 7,
    shareChangePct5d: -34.76,
    priceChangePct5d: 2.41,
    lastSharesYi: 68.87,
    sharesYi5dAgo: 105.57,
    quotePrice: 3.132,
  }),
  etf({
    categoryName: '创业板',
    shareTrend: 'outflow',
    consecutiveDays: 3,
    shareChangePct5d: -5.9,
    priceChangePct5d: 1.89,
    lastSharesYi: 176.6,
    sharesYi5dAgo: 187.68,
    quotePrice: 3.626,
  }),
  etf({
    categoryName: '科创50',
    hasHuijinDisclosure: false,
    shareTrend: 'outflow',
    consecutiveDays: 3,
    shareChangePct5d: -3.89,
    priceChangePct5d: 1,
    lastSharesYi: 483.33,
    sharesYi5dAgo: 502.89,
    quotePrice: 1.803,
  }),
]

const strongMarket: ForceMarketInput = { activeCapYi: 23474, referenceMaYi: 24785 }

function allText(briefing: ReturnType<typeof composeForceBriefing>): string {
  return [
    briefing.headline,
    briefing.lead,
    briefing.path,
    briefing.intent,
    ...briefing.bullets,
    ...briefing.cautions,
    briefing.disclaimer,
  ].join('\n')
}

describe('composeForceBriefing', () => {
  test('empty input stays uncertain and never names a holder trade', () => {
    const briefing = composeForceBriefing([])
    expect(briefing.tier).toBe('uncertain')
    expect(briefing.headline).toBe('无法判断')
    expect(briefing.intent).toBeNull()
    expect(allText(briefing)).not.toMatch(/汇金(买入|卖出)/)
  })

  test('credible outflow with rising prices writes selling-into-strength briefing', () => {
    const briefing = composeForceBriefing(outflowBasket, strongMarket)
    expect(briefing.tier).toBe('credible')
    expect(briefing.tone).toBe('outflow')
    expect(briefing.headline).toBe('可采信 · 更像逢高减磅')
    expect(briefing.lead).toContain('6/6 只净流出')
    expect(briefing.path).toContain('主出口')
    expect(briefing.path).toContain('中证1000')
    expect(briefing.path).toContain('沪深300')
    expect(briefing.path).toContain('上证50几乎没动')
    expect(briefing.path).toContain('篮子外去向未知')
    expect(briefing.intent).toContain('更像逢高减磅')
    expect(briefing.intent).toContain('价升份额缩')
    expect(briefing.cautions.some((line) => line.includes('科创50'))).toBe(true)
    expect(allText(briefing)).not.toMatch(/汇金(买入|卖出)/)
  })

  test('credible inflow with falling prices writes a catch-knife briefing', () => {
    const rows = outflowBasket.map((row) => ({
      ...row,
      shareTrend: 'inflow' as const,
      shareChangePct5d: row.shareChangePct5d == null ? null : Math.abs(row.shareChangePct5d),
      priceChangePct5d: -1.2,
    }))
    const briefing = composeForceBriefing(rows, strongMarket)
    expect(briefing.headline).toBe('可采信 · 更像托底/接飞刀')
    expect(briefing.lead).toContain('净流入')
    expect(briefing.path).toContain('主入口')
    expect(briefing.intent).toContain('价跌份额增')
  })

  test('other-capital mix does not invent a single destination', () => {
    const briefing = composeForceBriefing([
      etf({ categoryName: '沪深300', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 8.1 }),
      etf({ categoryName: '上证50', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 1.0 }),
      etf({ categoryName: '中证500', shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: -7.4 }),
      etf({ categoryName: '中证1000', shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: -1.1 }),
      etf({ categoryName: '创业板', shareTrend: 'flat' }),
    ])
    expect(briefing.tier).toBe('other')
    expect(briefing.headline).toContain('更像其他资金')
    expect(briefing.path).toContain('风格再平衡')
    expect(briefing.path).not.toContain('主出口')
    expect(briefing.intent).toContain('不输出单一意图')
  })

  test('mixed unresolved flow withholds destination and intent', () => {
    const briefing = composeForceBriefing([
      etf({ categoryName: '沪深300', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 0.5 }),
      etf({ categoryName: '上证50', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 0.3 }),
      etf({ categoryName: '中证500', shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: -0.4 }),
      etf({ categoryName: '中证1000', shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: -0.2 }),
      etf({ categoryName: '创业板', shareTrend: 'flat' }),
    ])
    expect(briefing.tier).toBe('uncertain')
    expect(briefing.headline).toBe('无法判断')
    expect(briefing.path).toContain('不输出单一去向')
    expect(briefing.intent).toBeNull()
  })
})
