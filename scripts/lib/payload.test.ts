import { describe, expect, test } from 'bun:test'
import type { HolderReport, HuijinEstimatePoint, NavPoint, ScalePoint } from '../../shared/types'
import {
  compactEstimateHistory,
  navKeepFromDate,
  trimNavHistory,
} from './payload'

function nav(date: string): NavPoint {
  return { date, nav: 1, accNav: 1, changePct: null }
}

function daily(date: string): ScalePoint {
  return {
    date,
    totalSharesYi: 1,
    netAssetYi: 1,
    purchaseYi: null,
    redeemYi: null,
    netSubscriptionYi: null,
    netAssetChangePct: null,
    frequency: 'daily',
    shareSource: 'sse',
    netAssetEstimated: true,
  }
}

function report(date: string): HolderReport {
  return {
    reportDate: date,
    holders: [],
    huijinShares: 1,
    huijinPercent: 1,
  }
}

describe('trimNavHistory', () => {
  const navs = ['2022-01-04', '2023-06-01', '2024-01-02', '2024-06-03', '2025-12-31'].map(nav)

  test('keeps from first daily share date', () => {
    const kept = trimNavHistory(navs, {
      scale: [daily('2024-01-02')],
      reports: [report('2025-12-31')],
    })
    expect(kept.map((point) => point.date)).toEqual([
      '2024-01-02',
      '2024-06-03',
      '2025-12-31',
    ])
  })

  test('keeps nearest nav for an older disclosure', () => {
    const kept = trimNavHistory(navs, {
      scale: [daily('2024-01-02')],
      reports: [report('2023-06-15')],
    })
    expect(kept.map((point) => point.date)).toContain('2023-06-01')
    expect(kept.map((point) => point.date)).not.toContain('2022-01-04')
  })

  test('navKeepFromDate uses first daily when history is shorter than keep window', () => {
    expect(
      navKeepFromDate({
        navs,
        scale: [daily('2024-01-02')],
      }),
    ).toBe('2024-01-02')
  })

  test('navKeepFromDate backs up to last 600 when it starts before daily shares', () => {
    const longNavs = Array.from({ length: 620 }, (_, index) => {
      const date = new Date(Date.UTC(2023, 0, 1 + index))
      return nav(date.toISOString().slice(0, 10))
    })
    const keepFrom = navKeepFromDate({
      navs: longNavs,
      scale: [daily('2025-01-02')],
    })
    expect(keepFrom).toBe(longNavs[20]?.date)
  })
})

describe('compactEstimateHistory', () => {
  test('drops unavailable points without shareTrend', () => {
    const points = [
      { date: '2024-01-02', estimateMethod: 'unavailable' },
      { date: '2024-01-03', estimateMethod: 'unavailable', shareTrend: 'inflow' },
      { date: '2025-12-31', estimateMethod: 'disclosed' },
      { date: '2026-01-05', estimateMethod: 'anchored' },
    ] as HuijinEstimatePoint[]
    expect(compactEstimateHistory(points).map((point) => point.date)).toEqual([
      '2024-01-03',
      '2025-12-31',
      '2026-01-05',
    ])
  })
})
