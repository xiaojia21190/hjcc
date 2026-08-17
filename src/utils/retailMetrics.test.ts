import { describe, expect, test } from 'bun:test'
import type { EtfSnapshot, HuijinEstimatePoint, ScalePoint } from '../../shared/types'
import {
  cumulativeNetSubRatePct,
  netSubscriptionRateSeries,
  otherCapitalSeries,
} from './retailMetrics'

function scalePoint(date: string, totalYi: number, netSubYi: number | null): ScalePoint {
  return {
    date,
    totalSharesYi: totalYi,
    netAssetYi: totalYi * 3,
    purchaseYi: null,
    redeemYi: null,
    netSubscriptionYi: netSubYi,
    netAssetChangePct: null,
    frequency: 'daily',
    shareSource: 'sse',
    netAssetEstimated: true,
  }
}

function anchoredPoint(
  date: string,
  totalYi: number,
  shares: number,
  floorYi: number,
  ceilYi: number,
): HuijinEstimatePoint {
  return {
    date,
    netAssetYi: totalYi * 3,
    totalSharesYi: totalYi,
    huijinShares: shares,
    huijinValueYi: null,
    huijinPct: (shares / 1e8 / totalYi) * 100,
    isEstimated: true,
    estimateMethod: 'anchored',
    huijinSharesFloor: floorYi,
    huijinSharesCeil: ceilYi,
  }
}

describe('otherCapitalSeries', () => {
  test('anchored 点产出其他份额与反向区间', () => {
    const etf = {
      huijinEstimateHistory: [
        anchoredPoint('2026-01-05', 100, 40e8, 35, 45),
      ],
    } as Pick<EtfSnapshot, 'huijinEstimateHistory'>
    const series = otherCapitalSeries(etf)
    expect(series).toHaveLength(1)
    const p = series[0]!
    expect(p.otherYi).toBeCloseTo(60, 6)
    // 其他下界 = 总 − 汇金上界；其他上界 = 总 − 汇金下界
    expect(p.floorYi).toBeCloseTo(55, 6)
    expect(p.ceilYi).toBeCloseTo(65, 6)
    expect(p.totalYi).toBe(100)
    expect(p.date).toBe('2026-01-05')
  })

  test('unavailable 点 otherYi 为 null 且区间为 null', () => {
    const etf = {
      huijinEstimateHistory: [
        {
          date: '2026-01-05',
          netAssetYi: 300,
          totalSharesYi: 100,
          huijinShares: null,
          huijinValueYi: null,
          huijinPct: null,
          isEstimated: true,
          estimateMethod: 'unavailable',
        },
      ],
    } as Pick<EtfSnapshot, 'huijinEstimateHistory'>
    const series = otherCapitalSeries(etf)
    expect(series[0]!.otherYi).toBeNull()
    expect(series[0]!.floorYi).toBeNull()
    expect(series[0]!.totalYi).toBe(100)
  })

  test('disclosed 点有 otherYi 无区间', () => {
    const etf = {
      huijinEstimateHistory: [
        {
          date: '2025-12-31',
          netAssetYi: 300,
          totalSharesYi: 100,
          huijinShares: 86.05e8,
          huijinValueYi: 260,
          huijinPct: 86.05,
          isEstimated: false,
          estimateMethod: 'disclosed',
        },
      ],
    } as Pick<EtfSnapshot, 'huijinEstimateHistory'>
    const p = otherCapitalSeries(etf)[0]!
    expect(p.otherYi).toBeCloseTo(13.95, 6)
    expect(p.floorYi).toBeNull()
    expect(p.ceilYi).toBeNull()
  })
})

describe('netSubscriptionRateSeries', () => {
  test('净申购率 = 净变化 / 前一日总份额，首日与缺失为 null', () => {
    const history = [
      scalePoint('2026-01-02', 100, null),
      scalePoint('2026-01-03', 102, 2),
      scalePoint('2026-01-06', 101.5, -0.5),
    ]
    const rates = netSubscriptionRateSeries(history)
    expect(rates[0]!.ratePct).toBeNull()
    expect(rates[1]!.ratePct).toBeCloseTo(2, 6)
    expect(rates[2]!.ratePct).toBeCloseTo((-0.5 / 102) * 100, 6)
    expect(rates.map((r) => r.date)).toEqual(['2026-01-02', '2026-01-03', '2026-01-06'])
  })

  test('非 daily 点被剔除', () => {
    const history = [
      scalePoint('2026-01-02', 100, null),
      { ...scalePoint('2026-06-30', 200, 50), frequency: 'periodic' as const },
      scalePoint('2026-01-03', 102, 2),
    ]
    const rates = netSubscriptionRateSeries(history)
    expect(rates).toHaveLength(2)
    expect(rates[1]!.ratePct).toBeCloseTo(2, 6)
  })

  test('净变化缺失的交易日产出 null 而非中断', () => {
    const history = [
      scalePoint('2026-01-02', 100, null),
      scalePoint('2026-01-03', 102, null),
    ]
    const rates = netSubscriptionRateSeries(history)
    expect(rates[1]!.ratePct).toBeNull()
  })
})

describe('cumulativeNetSubRatePct', () => {
  test('末 N 日加总；日率量级小，加总与复利差异可忽略', () => {
    const rates = [
      { date: 'd1', ratePct: 1 },
      { date: 'd2', ratePct: 1 },
      { date: 'd3', ratePct: 1 },
      { date: 'd4', ratePct: 1 },
      { date: 'd5', ratePct: 1 },
    ]
    expect(cumulativeNetSubRatePct(rates, 5)).toBeCloseTo(5, 6)
  })

  test('窗口内 null 视为 0，不中断累计', () => {
    const rates = [
      { date: 'd1', ratePct: null },
      { date: 'd2', ratePct: 2 },
      { date: 'd3', ratePct: null },
      { date: 'd4', ratePct: null },
      { date: 'd5', ratePct: null },
    ]
    expect(cumulativeNetSubRatePct(rates, 5)).toBeCloseTo(2, 6)
  })

  test('样本不足返回 null', () => {
    expect(cumulativeNetSubRatePct([], 5)).toBeNull()
    expect(
      cumulativeNetSubRatePct([{ date: 'd1', ratePct: 1 }], 5),
    ).toBeNull()
  })
})
