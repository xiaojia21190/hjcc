import { test, expect } from 'bun:test'
import { computeOfficialFetchDates } from '../shared/backfill-window'

const OVERLAP = 5

test('首次回填：无已有数据，窗口从披露日向前 overlap 起到最新交易日', () => {
  const marketDates = Array.from({ length: 10 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`)
  const result = computeOfficialFetchDates({
    existing: [],
    marketDates,
    latestHuijinReportDate: '2025-12-31',
    overlap: OVERLAP,
  })
  expect(result[0]).toBe('2026-01-01')
  expect(result.at(-1)).toBe('2026-01-10')
})

test('增量：有已有数据，从末尾前 overlap 起抓到最新', () => {
  const marketDates = Array.from({ length: 10 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`)
  const existing = [
    { date: '2026-01-03', totalSharesYi: 100, shareSource: 'sse' as const },
  ]
  const result = computeOfficialFetchDates({
    existing,
    marketDates,
    latestHuijinReportDate: '2025-12-31',
    overlap: OVERLAP,
  })
  expect(result[0]).toBe('2026-01-01')
  expect(result.at(-1)).toBe('2026-01-10')
})

test('披露日晚于已有末尾时，窗口必须覆盖披露日', () => {
  const marketDates = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']
  const existing = [
    { date: '2026-05-20', totalSharesYi: 100, shareSource: 'sse' as const },
  ]
  const result = computeOfficialFetchDates({
    existing,
    marketDates,
    latestHuijinReportDate: '2026-06-01',
    overlap: OVERLAP,
  })
  expect(result).toContain('2026-06-01')
  expect(result.at(-1)).toBe('2026-06-05')
})

test('backfillStart：existing 为空时从 backfillStart 起全段回填', () => {
  const marketDates = ['2023-12-29', '2024-01-02', '2024-01-03', '2026-01-09', '2026-01-10']
  const result = computeOfficialFetchDates({
    existing: [],
    marketDates,
    latestHuijinReportDate: '2025-12-31',
    overlap: OVERLAP,
    backfillStart: '2024-01-01',
  })
  expect(result[0]).toBe('2024-01-02')
  expect(result).toContain('2026-01-10')
  expect(result).not.toContain('2023-12-29')
})

test('backfillStart：existing 最早日期晚于 backfillStart 时触发全段回填', () => {
  const marketDates = ['2024-01-02', '2024-01-03', '2025-07-14', '2025-07-15', '2026-01-10']
  const existing = [
    { date: '2025-07-14', totalSharesYi: 100, shareSource: 'sse' as const },
    { date: '2025-07-15', totalSharesYi: 101, shareSource: 'sse' as const },
  ]
  const result = computeOfficialFetchDates({
    existing,
    marketDates,
    latestHuijinReportDate: '2025-12-31',
    overlap: OVERLAP,
    backfillStart: '2024-01-01',
  })
  expect(result[0]).toBe('2024-01-02')
  expect(result.at(-1)).toBe('2026-01-10')
})

test('backfillStart：existing 已覆盖 backfillStart 时走增量逻辑', () => {
  const marketDates = Array.from({ length: 12 }, (_, i) => `2024-01-${String(i + 2).padStart(2, '0')}`)
  const existing = [
    { date: '2024-01-02', totalSharesYi: 100, shareSource: 'sse' as const },
    { date: '2024-01-10', totalSharesYi: 200, shareSource: 'sse' as const },
  ]
  const result = computeOfficialFetchDates({
    existing,
    marketDates,
    latestHuijinReportDate: null,
    overlap: OVERLAP,
    backfillStart: '2024-01-01',
  })
  // 增量模式：从 existing 末尾前 overlap 起，不是从 backfillStart 全段
  expect(result[0]).toBe('2024-01-06')
  expect(result.at(-1)).toBe('2024-01-13')
})

test('不传 backfillStart 时保持原有行为', () => {
  const marketDates = Array.from({ length: 10 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`)
  const result = computeOfficialFetchDates({
    existing: [],
    marketDates,
    latestHuijinReportDate: '2025-12-31',
    overlap: OVERLAP,
  })
  expect(result[0]).toBe('2026-01-01')
  expect(result.at(-1)).toBe('2026-01-10')
})
