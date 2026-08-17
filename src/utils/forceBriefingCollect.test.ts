import { describe, expect, test } from 'bun:test'
import type { EtfSnapshot, HuijinEstimatePoint, MarketActiveCapPoint } from '../../shared/types'
import { collectBriefingInputs } from './forceBriefingCollect'

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
    quote: {
      code: '510300',
      name: '测试ETF',
      price: 4.72,
      changePct: -0.2,
      marketCap: 1,
      floatCap: 1,
      market: 'SH',
    },
    isLargest: true,
    scaleHistory: [],
    navHistory: [],
    turnoverHistory: [],
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

describe('collectBriefingInputs', () => {
  test('pairs last trend point shares with the point five sessions earlier', () => {
    const history = [14, 15, 16, 17, 18, 20].map((totalSharesYi, index) =>
      point({
        date: `2026-08-0${index + 1}`,
        totalSharesYi,
        shareTrend: index === 5 ? 'outflow' : 'inflow',
        consecutiveDays: 1,
        shareChangePct5d: 1,
      }),
    )
    const collected = collectBriefingInputs(
      [snapshot({ categoryName: '沪深300', huijinEstimateHistory: history })],
      [],
    )
    expect(collected.etfs[0]).toMatchObject({
      categoryName: '沪深300',
      lastSharesYi: 20,
      sharesYi5dAgo: 14,
      quotePrice: 4.72,
    })
  })

  test('keeps quote and share window empty when history is too short', () => {
    const collected = collectBriefingInputs(
      [
        snapshot({
          categoryName: '科创50',
          latestHuijin: null,
          quote: null,
          huijinEstimateHistory: [
            point({ date: '2026-08-13', shareTrend: 'outflow', consecutiveDays: 2, totalSharesYi: 10 }),
          ],
        }),
      ],
      [{ date: '2026-08-14', activeCapYi: 1, marketIndex: 1, marketAmountYi: 1, referenceMaYi: 2 }],
    )
    expect(collected.etfs[0]).toMatchObject({
      lastSharesYi: 10,
      sharesYi5dAgo: null,
      quotePrice: null,
      hasHuijinDisclosure: false,
    })
    expect(collected.market).toEqual({ activeCapYi: 1, referenceMaYi: 2 })
  })

  test('share window skips non-daily points, matching shareChangePct5d basis', () => {
    const history = [
      // 日频点：份额 14 → 20，5 日变化 ≈ +42.86%
      point({ date: '2026-08-01', totalSharesYi: 14, shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: null }),
      point({ date: '2026-08-11', totalSharesYi: 15, shareTrend: 'inflow', consecutiveDays: 2, shareChangePct5d: null }),
      point({ date: '2026-08-12', totalSharesYi: 16, shareTrend: 'inflow', consecutiveDays: 3, shareChangePct5d: null }),
      point({ date: '2026-08-13', totalSharesYi: 17, shareTrend: 'inflow', consecutiveDays: 4, shareChangePct5d: null }),
      point({ date: '2026-08-14', totalSharesYi: 18, shareTrend: 'inflow', consecutiveDays: 5, shareChangePct5d: null }),
      // 夹在中间的非日频点（无 shareTrend）：份额 99，不应成为基点
      point({ date: '2026-08-15', totalSharesYi: 99, estimateMethod: 'unavailable' }),
      point({ date: '2026-08-16', totalSharesYi: 20, shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: 42.86 }),
    ]
    const collected = collectBriefingInputs(
      [snapshot({ categoryName: '沪深300', huijinEstimateHistory: history })],
      [],
    )
    expect(collected.etfs[0]).toMatchObject({
      lastSharesYi: 20,
      // 日频子序列第 -6 个是 14，而非全量数组的 15
      sharesYi5dAgo: 14,
    })
  })
})
