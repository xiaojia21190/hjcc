import { describe, expect, test } from 'bun:test'
import type { EtfSnapshot, HuijinEstimatePoint, MarketActiveCapPoint } from '../../shared/types'
import { collectForceInputs, navChangePct5d } from './forceVerdictCollect'

function point(partial: Partial<HuijinEstimatePoint> & { date: string }): HuijinEstimatePoint {
  return {
    netAssetYi: 100,
    totalSharesYi: 20,
    huijinShares: 8e8,
    huijinValueYi: 40,
    huijinPct: 40,
    isEstimated: true,
    estimateMethod: 'anchored',
    huijinSharesFloor: 6,
    huijinSharesCeil: 8,
    ...partial,
  }
}

function snapshot(partial: Partial<EtfSnapshot> & { categoryName: string }): EtfSnapshot {
  return {
    category: 'csi300',
    code: '510300',
    name: '测试ETF',
    market: 'SH',
    quote: null,
    isLargest: true,
    scaleHistory: [],
    navHistory: [],
    holderReports: [],
    huijinHistory: [],
    latestHuijin: {
      reportDate: '2025-12-31',
      shares: 8e8,
      percent: 40,
      marketValue: 4e9,
      entities: [],
    },
    huijinEstimateHistory: [],
    source: { holders: '', scale: '', quote: '', huijinEstimate: '', fetchedAt: '' },
    ...partial,
  }
}

describe('navChangePct5d', () => {
  test('returns null when history is shorter than 6 points', () => {
    expect(navChangePct5d([
      { date: 'd1', nav: 1, accNav: 1, changePct: 0 },
      { date: 'd2', nav: 1.01, accNav: 1.01, changePct: 1 },
    ])).toBeNull()
  })

  test('uses accumulated nav over five steps', () => {
    const navs = [1, 1.02, 1.03, 1.04, 1.05, 1.1].map((accNav, index) => ({
      date: `d${index}`,
      nav: accNav,
      accNav,
      changePct: 0,
    }))
    expect(navChangePct5d(navs)).toBe(10)
  })

  test('falls back to unit nav when accumulated nav is missing', () => {
    const navs = [1, 1, 1, 1, 1, 1.05].map((nav, index) => ({
      date: `d${index}`,
      nav,
      accNav: 0,
      changePct: 0,
    }))
    expect(navChangePct5d(navs)).toBe(5)
  })

  test('returns null when the latest nav is non-positive', () => {
    const navs = [1, 1, 1, 1, 1, 0].map((nav, index) => ({
      date: `d${index}`,
      nav,
      accNav: 0,
      changePct: 0,
    }))
    expect(navChangePct5d(navs)).toBeNull()
  })
})

describe('collectForceInputs', () => {
  test('takes the latest share-trend point and last 0AMV observation', () => {
    const etf = snapshot({
      categoryName: '沪深300',
      huijinEstimateHistory: [
        point({ date: '2026-08-12', shareTrend: 'outflow', consecutiveDays: 2, shareChangePct5d: -1 }),
        point({ date: '2026-08-14', shareTrend: 'inflow', consecutiveDays: 3, shareChangePct5d: 1.6 }),
      ],
      navHistory: [1, 1, 1, 1, 1, 1.02].map((accNav, index) => ({
        date: `d${index}`,
        nav: accNav,
        accNav,
        changePct: 0,
      })),
    })
    const market: MarketActiveCapPoint[] = [
      { date: '2026-08-13', activeCapYi: 90, marketIndex: 4000, marketAmountYi: 1, referenceMaYi: 100 },
      { date: '2026-08-14', activeCapYi: 110, marketIndex: 4010, marketAmountYi: 1, referenceMaYi: 100 },
    ]
    const collected = collectForceInputs([etf], market)
    expect(collected.etfs[0]).toMatchObject({
      categoryName: '沪深300',
      hasHuijinDisclosure: true,
      shareTrend: 'inflow',
      consecutiveDays: 3,
      shareChangePct5d: 1.6,
      shareDate: '2026-08-14',
      priceChangePct5d: 2,
      lowResolution: false,
    })
    expect(collected.market).toEqual({ activeCapYi: 110, referenceMaYi: 100 })
  })

  test('marks missing disclosure and wide estimate range', () => {
    const etf = snapshot({
      categoryName: '中证1000',
      latestHuijin: null,
      huijinEstimateHistory: [
        point({
          date: '2026-08-14',
          shareTrend: 'outflow',
          consecutiveDays: 4,
          shareChangePct5d: -3,
          huijinShares: 2e9,
          huijinSharesFloor: 1,
          huijinSharesCeil: 18,
          totalSharesYi: 20,
        }),
      ],
    })
    const row = collectForceInputs([etf], [])
    expect(row.etfs[0]?.hasHuijinDisclosure).toBe(false)
    expect(row.etfs[0]?.lowResolution).toBe(true)
    expect(row.market).toEqual({ activeCapYi: null, referenceMaYi: null })
  })
})
