import { test, expect } from 'bun:test'
import { formatCompletenessReport } from './report'
import type { DashboardData } from '../../shared/types'

function minimalDashboard(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    updatedAt: '2026-07-25T00:00:00Z',
    categories: [],
    etfs: [{
      category: 'sse50', categoryName: '上证50', code: '510050', name: '50ETF',
      market: 'SH', quote: null, isLargest: true,
      scaleHistory: [
        { date: '2024-01-02', totalSharesYi: 100, netAssetYi: 150, purchaseYi: null, redeemYi: null, netSubscriptionYi: null, netAssetChangePct: null, frequency: 'daily', shareSource: 'sse', netAssetEstimated: true },
        { date: '2024-01-04', totalSharesYi: 102, netAssetYi: 152, purchaseYi: null, redeemYi: null, netSubscriptionYi: 2, netAssetChangePct: null, frequency: 'daily', shareSource: 'sse', netAssetEstimated: true },
      ],
      navHistory: Array.from({ length: 1400 }, (_, i) => ({ date: `2020-01-${String(i % 28 + 1).padStart(2, '0')}`, nav: 1, accNav: 1, changePct: null })),
      holderReports: [{ reportDate: '2025-12-31', holders: [], huijinShares: 100, huijinPercent: 50 }],
      huijinHistory: [], latestHuijin: null, huijinEstimateHistory: [],
      source: { holders: '', scale: '', quote: '', huijinEstimate: '', fetchedAt: '' },
    }],
    marketActiveCapHistory: [
      { date: '2024-01-02', activeCapYi: 100, marketIndex: 3000, marketAmountYi: 5000, referenceMaYi: null },
      { date: '2024-01-03', activeCapYi: 101, marketIndex: 3010, marketAmountYi: 5100, referenceMaYi: null },
      { date: '2024-01-04', activeCapYi: 102, marketIndex: 3020, marketAmountYi: 5200, referenceMaYi: null },
    ],
    marketActiveCapSource: '',
    sectorTrend: null,
    summary: { totalHuijinMarketValue: null, latestActiveCapYi: null, latestActiveCapDate: null, etfCount: 1, latestReportDate: null },
    ...overrides,
  }
}

test('报告包含覆盖率百分比', () => {
  const report = formatCompletenessReport(minimalDashboard())
  expect(report).toContain('510050')
  expect(report).toContain('日频 2/3')
  expect(report).toContain('66.7%')
  expect(report).toContain('⚠') // < 95%
})

test('覆盖率 100% 时无 ⚠', () => {
  const d = minimalDashboard()
  d.etfs[0]!.scaleHistory.push({
    date: '2024-01-03', totalSharesYi: 101, netAssetYi: 151,
    purchaseYi: null, redeemYi: null, netSubscriptionYi: 1,
    netAssetChangePct: null, frequency: 'daily', shareSource: 'sse', netAssetEstimated: true,
  })
  const report = formatCompletenessReport(d)
  expect(report).toContain('3/3')
  // 只断言 ETF 行本身无警告：报告其他行（如行业板块缺失）有各自的 ⚠ 语义
  const etfLine = report.split('\n').find((line) => line.includes('510050'))
  expect(etfLine).not.toContain('⚠')
})

test('缺口列表展示', () => {
  const d = minimalDashboard()
  d.etfs[0]!.source.shareFetchGaps = { sseFailedDates: ['2024-01-04'] }
  const report = formatCompletenessReport(d)
  expect(report).toContain('2024-01-04')
  expect(report).toContain('缺口合计: 1 日 (SSE)')
})

test('报告包含行业板块状态', () => {
  const report = formatCompletenessReport(
    minimalDashboard({
      sectorTrend: {
        dates: ['2024-01-02', '2024-01-03'],
        sectors: [{ code: 'BK0475', name: '银行Ⅱ', closes: [100, 101] }],
        source: 'test',
        fetchedAt: '2026-08-04T00:00:00Z',
      },
    }),
  )
  expect(report).toContain('行业板块: 1 只 × 2 个交易日')
  expect(report).toContain('2024-01-02 → 2024-01-03')
})

test('无行业板块数据时报告给出警告', () => {
  const report = formatCompletenessReport(minimalDashboard({ sectorTrend: null }))
  expect(report).toContain('行业板块: 无数据')
  expect(report).toContain('题材主线判定不可用')
})
