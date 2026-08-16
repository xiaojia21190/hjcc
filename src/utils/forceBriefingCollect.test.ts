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
})
