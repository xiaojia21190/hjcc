import { describe, expect, test } from 'bun:test'
import type { EtfSnapshot, HuijinEstimatePoint, ScalePoint } from '../../shared/types'
import {
  CHASE_PCT_5D,
  COLD_PERCENTILE,
  DISCLAIMER,
  HOT_PERCENTILE,
  judgeMood,
  judgeRetailSentiment,
  temperatureLabel,
  type MoodInput,
} from './retailSignals'

function scalePoint(date: string, totalYi: number, netSubYi: number | null): ScalePoint {
  return {
    date,
    totalSharesYi: totalYi,
    netAssetYi: totalYi * 3,
    purchaseYi: null,
    redeemYi: null,
    netSubscriptionYi: netSubYi,
    netAssetChangePct: null,
    frequency: 'daily' as const,
    shareSource: 'sse' as const,
    netAssetEstimated: true,
  }
}

/** 造一只 ETF：300 天日频序列，每日净申购率 ≈ dailyRatePct，末点带 shareTrend。 */
function makeEtf(partial: {
  name: string
  dailyRatePct?: number
  shareTrend?: 'inflow' | 'outflow' | 'flat' | null
  withDisclosure?: boolean
}): EtfSnapshot {
  const dailyRatePct = partial.dailyRatePct ?? 0
  const history: ScalePoint[] = []
  let total = 100
  history.push(scalePoint('2025-01-01', total, null))
  for (let i = 1; i < 300; i++) {
    const netSub = (total * dailyRatePct) / 100
    total = Number((total + netSub).toFixed(6))
    const month = String(Math.floor(i / 30) + 1).padStart(2, '0')
    const day = String((i % 30) + 1).padStart(2, '0')
    history.push(scalePoint(`2025-${month}-${day}`, total, netSub))
  }
  const hasDisclosure = partial.withDisclosure ?? true
  const estimate: HuijinEstimatePoint[] = hasDisclosure
    ? history.map((p, i) => ({
        date: p.date,
        netAssetYi: p.totalSharesYi * 3,
        totalSharesYi: p.totalSharesYi,
        huijinShares: p.totalSharesYi * 0.4e8,
        huijinValueYi: null,
        huijinPct: 40,
        isEstimated: true,
        estimateMethod: 'anchored' as const,
        huijinSharesFloor: p.totalSharesYi * 0.3,
        huijinSharesCeil: p.totalSharesYi * 0.5,
        shareTrend:
          i === history.length - 1 ? (partial.shareTrend ?? null) : null,
      }))
    : history.map((p) => ({
        date: p.date,
        netAssetYi: p.totalSharesYi * 3,
        totalSharesYi: p.totalSharesYi,
        huijinShares: null,
        huijinValueYi: null,
        huijinPct: null,
        isEstimated: true,
        estimateMethod: 'unavailable' as const,
      }))
  return {
    category: 'csi300',
    categoryName: partial.name,
    code: `00000${partial.name.length}`,
    name: partial.name,
    market: 'SH',
    quote: {
      code: 'x',
      name: partial.name,
      price: 1,
      changePct: 0,
      marketCap: 1,
      floatCap: 1,
      market: 'SH',
    },
    isLargest: true,
    scaleHistory: history,
    navHistory: [],
    holderReports: [],
    huijinHistory: [],
    latestHuijin: hasDisclosure
      ? {
          reportDate: '2025-12-31',
          shares: 40e8,
          percent: 40,
          marketValue: null,
          entities: [],
        }
      : null,
    huijinEstimateHistory: estimate,
    source: { scale: 'sse', nav: 'eastmoney', holders: 'sina' },
  } as unknown as EtfSnapshot
}

describe('judgeMood', () => {
  const base: MoodInput = { categoryName: '沪深300', netSub5dPct: 0 }
  test('边界值判定', () => {
    expect(judgeMood({ ...base, netSub5dPct: CHASE_PCT_5D })).toBe('chasing')
    expect(judgeMood({ ...base, netSub5dPct: CHASE_PCT_5D - 0.01 })).toBe('calm')
    expect(judgeMood({ ...base, netSub5dPct: -2 })).toBe('capitulating')
    expect(judgeMood({ ...base, netSub5dPct: -1.99 })).toBe('calm')
    expect(judgeMood({ ...base, netSub5dPct: null })).toBeNull()
  })
})

describe('temperatureLabel', () => {
  test('分位边界', () => {
    expect(temperatureLabel(HOT_PERCENTILE)).toBe('高热')
    expect(temperatureLabel(HOT_PERCENTILE + 1)).toBe('高热')
    expect(temperatureLabel(70)).toBe('偏热')
    expect(temperatureLabel(50)).toBe('中性')
    expect(temperatureLabel(30)).toBe('偏冷')
    expect(temperatureLabel(COLD_PERCENTILE)).toBe('冰点')
    expect(temperatureLabel(null)).toBe('样本不足')
  })
})

describe('judgeRetailSentiment', () => {
  test('空输入返回 unclear 与 disclaimer', () => {
    const r = judgeRetailSentiment([])
    expect(r.mood).toBe('calm')
    expect(r.quadrant).toBe('unclear')
    expect(r.disclaimer).toBe(DISCLAIMER)
    expect(r.temperatureLabel).toBe('样本不足')
  })

  test('散户杀跌 + 汇金流入 = contrarian-bull 经典底部组合', () => {
    const etfs = [
      makeEtf({ name: '沪深300', dailyRatePct: -1, shareTrend: 'inflow' }),
      makeEtf({ name: '上证50', dailyRatePct: -1, shareTrend: 'inflow' }),
      makeEtf({ name: '中证500', dailyRatePct: -1, shareTrend: 'inflow' }),
      makeEtf({ name: '中证1000', dailyRatePct: -1, shareTrend: 'inflow' }),
    ]
    const r = judgeRetailSentiment(etfs)
    expect(r.mood).toBe('capitulating')
    expect(r.quadrant).toBe('contrarian-bull')
    expect(r.quadrantLabel).toContain('底部')
  })

  test('散户追涨 + 汇金持平 = contrarian-warn 拥挤警戒', () => {
    const etfs = [
      makeEtf({ name: '沪深300', dailyRatePct: 1, shareTrend: 'flat' }),
      makeEtf({ name: '上证50', dailyRatePct: 1, shareTrend: 'flat' }),
      makeEtf({ name: '中证500', dailyRatePct: 1, shareTrend: 'flat' }),
      makeEtf({ name: '中证1000', dailyRatePct: 1, shareTrend: 'flat' }),
    ]
    const r = judgeRetailSentiment(etfs)
    expect(r.mood).toBe('chasing')
    expect(r.quadrant).toBe('contrarian-warn')
  })

  test('汇金流入 + 散户也追涨 = 矛盾 unclear', () => {
    const etfs = [
      makeEtf({ name: '沪深300', dailyRatePct: 1, shareTrend: 'inflow' }),
      makeEtf({ name: '上证50', dailyRatePct: 1, shareTrend: 'inflow' }),
      makeEtf({ name: '中证500', dailyRatePct: 1, shareTrend: 'inflow' }),
      makeEtf({ name: '中证1000', dailyRatePct: 1, shareTrend: 'inflow' }),
    ]
    const r = judgeRetailSentiment(etfs)
    expect(r.mood).toBe('chasing')
    expect(r.quadrant).toBe('unclear')
  })

  test('平静市场 = calm 且 unclear', () => {
    const etfs = [makeEtf({ name: '沪深300', dailyRatePct: 0 })]
    const r = judgeRetailSentiment(etfs)
    expect(r.mood).toBe('calm')
    expect(r.quadrant).toBe('unclear')
  })

  test('无披露 ETF 进入 caution 而不参与其他资金合计', () => {
    const etfs = [
      makeEtf({ name: '沪深300', dailyRatePct: 0, withDisclosure: true }),
      makeEtf({ name: '科创50', dailyRatePct: 0, withDisclosure: false }),
    ]
    const r = judgeRetailSentiment(etfs)
    expect(r.etfs).toHaveLength(2)
    expect(r.etfs.find((e) => e.categoryName === '科创50')!.otherYi).toBeNull()
    expect(r.cautions.some((c) => c.includes('科创50'))).toBe(true)
    expect(r.otherTotalYi).not.toBeNull()
  })

  test('恒定 1% 日率下净申购率分位应为 100（追涨高温）', () => {
    const etfs = [makeEtf({ name: '沪深300', dailyRatePct: 1 })]
    const r = judgeRetailSentiment(etfs)
    const row = r.etfs[0]!
    expect(row.netSub5dPct).toBeCloseTo(5, 4)
    expect(row.netSubPercentile).toBe(100)
  })
})
