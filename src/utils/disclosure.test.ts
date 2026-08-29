import { describe, expect, test } from 'bun:test'
import { daysUntil, disclosureCountdown, nextDisclosureWindow } from './disclosure'

describe('nextDisclosureWindow', () => {
  test('1-4 月等待上一年年报', () => {
    const w = nextDisclosureWindow('2026-03-15')
    expect(w).toEqual({ reportDate: '2025-12-31', deadline: '2026-04-30', kind: '年报' })
  })
  test('4 月最后一天仍属年报窗口', () => {
    const w = nextDisclosureWindow('2026-04-30')
    expect(w.deadline).toBe('2026-04-30')
  })
  test('5-8 月等待当年半年报', () => {
    const w = nextDisclosureWindow('2026-07-01')
    expect(w).toEqual({ reportDate: '2026-06-30', deadline: '2026-08-31', kind: '半年报' })
  })
  test('9-12 月等待当年年报（次年 4 月底截止）', () => {
    const w = nextDisclosureWindow('2026-11-11')
    expect(w).toEqual({ reportDate: '2026-12-31', deadline: '2027-04-30', kind: '年报' })
  })
})

describe('daysUntil', () => {
  test('跨月正确', () => {
    expect(daysUntil('2026-04-01', '2026-04-30')).toBe(29)
  })
  test('已过期返回 0', () => {
    expect(daysUntil('2026-05-01', '2026-04-30')).toBe(0)
  })
  test('非法日期返回 0', () => {
    expect(daysUntil('bad', '2026-04-30')).toBe(0)
  })
})

describe('disclosureCountdown', () => {
  test('临近 30 天内标记 imminent', () => {
    const c = disclosureCountdown('2026-04-15', '2025-06-30')
    expect(c.imminent).toBe(true)
    expect(c.daysLeft).toBe(15)
  })
  test('远离截止日不标记', () => {
    const c = disclosureCountdown('2026-06-01', '2025-12-31')
    expect(c.imminent).toBe(false)
    expect(c.daysLeft).toBe(91)
  })
})
