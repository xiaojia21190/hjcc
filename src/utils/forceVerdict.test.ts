import { describe, expect, test } from 'bun:test'
import {
  DISCLAIMER,
  judgeHuijinForce,
  TIER_LABEL,
  type ForceEtfInput,
  type ForceMarketInput,
} from './forceVerdict'

function etf(
  partial: Partial<ForceEtfInput> & { categoryName: string },
): ForceEtfInput {
  return {
    hasHuijinDisclosure: true,
    shareTrend: 'flat',
    consecutiveDays: 1,
    shareChangePct5d: 0,
    shareDate: '2026-08-14',
    priceChangePct5d: 0,
    lowResolution: false,
    ...partial,
  }
}

const strongInflow: ForceEtfInput[] = [
  etf({ categoryName: '沪深300', shareTrend: 'inflow', consecutiveDays: 4, shareChangePct5d: 2.1, priceChangePct5d: -1.2 }),
  etf({ categoryName: '上证50', shareTrend: 'inflow', consecutiveDays: 3, shareChangePct5d: 1.4, priceChangePct5d: -0.8 }),
  etf({ categoryName: '中证500', shareTrend: 'inflow', consecutiveDays: 3, shareChangePct5d: 0.9, priceChangePct5d: -0.5 }),
  etf({ categoryName: '中证1000', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 0.4, priceChangePct5d: -0.3 }),
  etf({ categoryName: '创业板', shareTrend: 'flat', consecutiveDays: 1, shareChangePct5d: 0.1, priceChangePct5d: 0.2 }),
]

const strongMarket: ForceMarketInput = { activeCapYi: 120, referenceMaYi: 100 }

describe('judgeHuijinForce', () => {
  test('empty input is uncertain because object gate fails', () => {
    const r = judgeHuijinForce([])
    expect(r.tier).toBe('uncertain')
    expect(r.label).toBe(TIER_LABEL.uncertain)
    expect(r.gates.object.status).toBe('fail')
    expect(r.intent).toBeNull()
    expect(r.disclaimer).toBe(DISCLAIMER)
  })

  test('no huijin disclosure cannot be upgraded even if flows are strong', () => {
    const r = judgeHuijinForce(
      strongInflow.map((row) => ({ ...row, hasHuijinDisclosure: false })),
    )
    expect(r.tier).toBe('uncertain')
    expect(r.gates.object.status).toBe('fail')
    expect(r.gates.object.reason).toContain('披露')
    expect(r.gates.structure.status).toBe('strong')
  })

  test('disclosure without daily share trend fails object gate', () => {
    const r = judgeHuijinForce([
      etf({ categoryName: '沪深300', shareTrend: null, consecutiveDays: 0, shareChangePct5d: null }),
    ])
    expect(r.tier).toBe('uncertain')
    expect(r.gates.object.status).toBe('fail')
    expect(r.gates.object.reason).toContain('份额')
  })

  test('majority inflow for 3+ days with agreeing 5d is credible', () => {
    const r = judgeHuijinForce(strongInflow, strongMarket)
    expect(r.tier).toBe('credible')
    expect(r.tone).toBe('inflow')
    expect(r.gates.object.status).toBe('pass')
    expect(r.gates.structure.status).toBe('strong')
    expect(r.gates.alternative.status).toBe('pass')
    expect(r.intent).toBe('更像托底/接飞刀')
  })

  test('majority inflow with rising price and strong 0AMV is add-on intent', () => {
    const rows = strongInflow.map((row) => ({ ...row, priceChangePct5d: 1.5 }))
    const r = judgeHuijinForce(rows, strongMarket)
    expect(r.tier).toBe('credible')
    expect(r.intent).toBe('更像加仓或抬流动性')
  })

  test('majority inflow lasting only one day is weak', () => {
    const rows = strongInflow.map((row) =>
      row.shareTrend === 'inflow'
        ? { ...row, consecutiveDays: 1 }
        : row,
    )
    const r = judgeHuijinForce(rows)
    expect(r.tier).toBe('weak')
    expect(r.gates.structure.status).toBe('weak')
    expect(r.gates.structure.reason).toContain('连续')
  })

  test('single-leg persistent flow is weak not credible', () => {
    const r = judgeHuijinForce([
      etf({ categoryName: '沪深300', shareTrend: 'inflow', consecutiveDays: 5, shareChangePct5d: 3.2 }),
      etf({ categoryName: '上证50', shareTrend: 'flat' }),
      etf({ categoryName: '中证500', shareTrend: 'flat' }),
      etf({ categoryName: '中证1000', shareTrend: 'flat' }),
      etf({ categoryName: '创业板', shareTrend: 'flat' }),
    ])
    expect(r.tier).toBe('weak')
    expect(r.tone).toBe('inflow')
    expect(r.gates.structure.status).toBe('weak')
    expect(r.detail).toContain('单腿')
  })

  test('longest streak against the majority stays weak', () => {
    const r = judgeHuijinForce([
      etf({ categoryName: '沪深300', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 0.4 }),
      etf({ categoryName: '上证50', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 0.3 }),
      etf({ categoryName: '中证500', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 0.2 }),
      etf({ categoryName: '中证1000', shareTrend: 'outflow', consecutiveDays: 5, shareChangePct5d: -1.8 }),
      etf({ categoryName: '创业板', shareTrend: 'flat' }),
    ])
    expect(r.tier).toBe('weak')
    expect(r.gates.structure.status).toBe('weak')
    expect(r.cautions.some((line) => line.includes('连续') || line.includes('多数'))).toBe(true)
  })

  test('largest 5d share change against majority stays weak', () => {
    const r = judgeHuijinForce([
      etf({ categoryName: '沪深300', shareTrend: 'inflow', consecutiveDays: 4, shareChangePct5d: 0.4 }),
      etf({ categoryName: '上证50', shareTrend: 'inflow', consecutiveDays: 3, shareChangePct5d: 0.3 }),
      etf({ categoryName: '中证500', shareTrend: 'inflow', consecutiveDays: 3, shareChangePct5d: 0.2 }),
      etf({ categoryName: '中证1000', shareTrend: 'inflow', consecutiveDays: 3, shareChangePct5d: -8.4 }),
      etf({ categoryName: '创业板', shareTrend: 'flat' }),
    ])
    expect(r.tier).toBe('weak')
    expect(r.gates.structure.reason).toContain('5日')
  })

  test('mixed flow without opposing 5d is uncertain', () => {
    const r = judgeHuijinForce([
      etf({ categoryName: '沪深300', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 0.5 }),
      etf({ categoryName: '上证50', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 0.3 }),
      etf({ categoryName: '中证500', shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: -0.4 }),
      etf({ categoryName: '中证1000', shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: -0.2 }),
      etf({ categoryName: '创业板', shareTrend: 'flat' }),
    ])
    expect(r.tier).toBe('uncertain')
    expect(r.gates.structure.status).toBe('fail')
    expect(r.gates.alternative.status).toBe('unresolved')
    expect(r.intent).toBeNull()
  })

  test('mixed flow with opposite large 5d moves is other capital', () => {
    const r = judgeHuijinForce([
      etf({ categoryName: '沪深300', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 8.1 }),
      etf({ categoryName: '上证50', shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 1.0 }),
      etf({ categoryName: '中证500', shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: -7.4 }),
      etf({ categoryName: '中证1000', shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: -1.1 }),
      etf({ categoryName: '创业板', shareTrend: 'flat' }),
    ])
    expect(r.tier).toBe('other')
    expect(r.gates.alternative.status).toBe('other')
    expect(r.intent).toBe('更像风格再平衡，不输出单一意图')
  })

  test('mixed flow with both sides lasting 2+ days is other capital', () => {
    const r = judgeHuijinForce([
      etf({ categoryName: '沪深300', shareTrend: 'inflow', consecutiveDays: 3, shareChangePct5d: 0.6 }),
      etf({ categoryName: '上证50', shareTrend: 'inflow', consecutiveDays: 2, shareChangePct5d: 0.4 }),
      etf({ categoryName: '中证500', shareTrend: 'outflow', consecutiveDays: 2, shareChangePct5d: -0.5 }),
      etf({ categoryName: '中证1000', shareTrend: 'outflow', consecutiveDays: 2, shareChangePct5d: -0.3 }),
      etf({ categoryName: '创业板', shareTrend: 'flat' }),
    ])
    expect(r.tier).toBe('other')
    expect(r.gates.alternative.reason).toContain('两侧')
  })

  test('object-gate failure beats an other-capital pattern', () => {
    const r = judgeHuijinForce([
      etf({ categoryName: '沪深300', hasHuijinDisclosure: false, shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 8.1 }),
      etf({ categoryName: '上证50', hasHuijinDisclosure: false, shareTrend: 'inflow', consecutiveDays: 1, shareChangePct5d: 1.0 }),
      etf({ categoryName: '中证500', hasHuijinDisclosure: false, shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: -7.4 }),
      etf({ categoryName: '中证1000', hasHuijinDisclosure: false, shareTrend: 'outflow', consecutiveDays: 1, shareChangePct5d: -1.1 }),
    ])
    expect(r.tier).toBe('uncertain')
    expect(r.gates.object.status).toBe('fail')
  })

  test('low resolution adds a caution but does not downgrade a strong structure', () => {
    const rows = strongInflow.map((row, index) =>
      index === 0 ? { ...row, lowResolution: true } : row,
    )
    const r = judgeHuijinForce(rows, strongMarket)
    expect(r.tier).toBe('credible')
    expect(r.cautions.some((line) => line.includes('低分辨'))).toBe(true)
  })

  test('share-date lag adds a caution', () => {
    const rows = strongInflow.map((row, index) =>
      index === 0 ? { ...row, shareDate: '2026-08-13' } : row,
    )
    const r = judgeHuijinForce(rows)
    expect(r.cautions.some((line) => line.includes('日期'))).toBe(true)
  })

  test('outflow with rising price is selling into strength', () => {
    const rows = [
      etf({ categoryName: '沪深300', shareTrend: 'outflow', consecutiveDays: 4, shareChangePct5d: -2.1, priceChangePct5d: 1.4 }),
      etf({ categoryName: '上证50', shareTrend: 'outflow', consecutiveDays: 3, shareChangePct5d: -1.5, priceChangePct5d: 1.1 }),
      etf({ categoryName: '中证500', shareTrend: 'outflow', consecutiveDays: 3, shareChangePct5d: -1.2, priceChangePct5d: 0.8 }),
      etf({ categoryName: '中证1000', shareTrend: 'flat' }),
    ]
    const r = judgeHuijinForce(rows)
    expect(r.tier).toBe('credible')
    expect(r.tone).toBe('outflow')
    expect(r.intent).toBe('更像逢高减磅')
  })

  test('outflow with falling price and weak 0AMV is withdrawal', () => {
    const rows = [
      etf({ categoryName: '沪深300', shareTrend: 'outflow', consecutiveDays: 4, shareChangePct5d: -2.1, priceChangePct5d: -1.4 }),
      etf({ categoryName: '上证50', shareTrend: 'outflow', consecutiveDays: 3, shareChangePct5d: -1.5, priceChangePct5d: -1.1 }),
      etf({ categoryName: '中证500', shareTrend: 'outflow', consecutiveDays: 3, shareChangePct5d: -1.2, priceChangePct5d: -0.8 }),
      etf({ categoryName: '中证1000', shareTrend: 'flat' }),
    ]
    const r = judgeHuijinForce(rows, { activeCapYi: 80, referenceMaYi: 100 })
    expect(r.intent).toBe('更像撤离')
  })

  test('inflow with rising price but weak 0AMV is add-on with unconfirmed env', () => {
    const rows = strongInflow.map((row) => ({ ...row, priceChangePct5d: 1.5 }))
    const r = judgeHuijinForce(rows, { activeCapYi: 80, referenceMaYi: 100 })
    expect(r.tier).toBe('credible')
    expect(r.intent).toBe('更像加仓，环境未确认')
  })

  test('outflow with falling price but unknown 0AMV is reduction with unconfirmed env', () => {
    const rows = [
      etf({ categoryName: '沪深300', shareTrend: 'outflow', consecutiveDays: 4, shareChangePct5d: -2.1, priceChangePct5d: -1.4 }),
      etf({ categoryName: '上证50', shareTrend: 'outflow', consecutiveDays: 3, shareChangePct5d: -1.5, priceChangePct5d: -1.1 }),
      etf({ categoryName: '中证500', shareTrend: 'outflow', consecutiveDays: 3, shareChangePct5d: -1.2, priceChangePct5d: -0.8 }),
      etf({ categoryName: '中证1000', shareTrend: 'flat' }),
    ]
    const r = judgeHuijinForce(rows)
    expect(r.tier).toBe('credible')
    expect(r.intent).toBe('更像减仓，环境未确认')
  })

  test('missing price keeps intent empty', () => {
    const rows = strongInflow.map((row) => ({ ...row, priceChangePct5d: null }))
    const r = judgeHuijinForce(rows, strongMarket)
    expect(r.tier).toBe('credible')
    expect(r.intent).toBeNull()
  })
})
