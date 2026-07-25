import { test, expect } from 'bun:test'
import { computeTrendSignals, type SignalInput } from '../shared/estimate-signals'

function point(date: string, total: number, netSub: number | null): SignalInput {
  return { date, totalSharesYi: total, netSubscriptionYi: netSub }
}

test('连续 inflow 时 consecutiveDays 递增', () => {
  const pts = [
    point('2026-01-05', 100, 1),
    point('2026-01-06', 101, 1),
    point('2026-01-07', 102, 1),
  ]
  const out = computeTrendSignals(pts)
  expect(out[0].shareTrend).toBe('inflow')
  expect(out[0].consecutiveDays).toBe(1)
  expect(out[1].consecutiveDays).toBe(2)
  expect(out[2].consecutiveDays).toBe(3)
})

test('方向反转时 consecutiveDays 重置为 1', () => {
  const pts = [
    point('2026-01-05', 100, 1),
    point('2026-01-06', 101, -1),
  ]
  const out = computeTrendSignals(pts)
  expect(out[1].shareTrend).toBe('outflow')
  expect(out[1].consecutiveDays).toBe(1)
})

test('netSubscriptionYi=null 时 shareTrend=flat', () => {
  const pts = [point('2026-01-05', 100, null)]
  const out = computeTrendSignals(pts)
  expect(out[0].shareTrend).toBe('flat')
})

test('shareChangePct5d 为近 5 日变化率', () => {
  const pts = [
    point('2026-01-05', 100, 1),
    point('2026-01-06', 101, 1),
    point('2026-01-07', 102, 1),
    point('2026-01-08', 103, 1),
    point('2026-01-09', 104, 1),
    point('2026-01-12', 105, 1),
  ]
  const out = computeTrendSignals(pts)
  expect(out[5].shareChangePct5d).toBeCloseTo(5, 2)
  expect(out[0].shareChangePct5d).toBeNull()
})

