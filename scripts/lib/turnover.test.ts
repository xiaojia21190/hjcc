import { describe, expect, test } from 'bun:test'
import type { TurnoverPoint } from '../../shared/types'
import { mergeTurnoverHistory } from './turnover'

describe('mergeTurnoverHistory', () => {
  test('append 新日期并保留旧历史', () => {
    const previous: TurnoverPoint[] = [
      { date: '2026-08-12', turnoverPct: 3.1, amountYuan: 3.9e9 },
    ]
    const current: TurnoverPoint[] = [
      { date: '2026-08-14', turnoverPct: 3.46, amountYuan: 3.98e9 },
    ]
    expect(mergeTurnoverHistory(previous, current)).toEqual([
      { date: '2026-08-12', turnoverPct: 3.1, amountYuan: 3.9e9 },
      { date: '2026-08-14', turnoverPct: 3.46, amountYuan: 3.98e9 },
    ])
  })

  test('同日重抓取最新覆盖旧值', () => {
    const previous: TurnoverPoint[] = [
      { date: '2026-08-14', turnoverPct: 2.0, amountYuan: 2e9 },
    ]
    const current: TurnoverPoint[] = [
      { date: '2026-08-14', turnoverPct: 3.46, amountYuan: 3.98e9 },
    ]
    expect(mergeTurnoverHistory(previous, current)).toEqual([
      { date: '2026-08-14', turnoverPct: 3.46, amountYuan: 3.98e9 },
    ])
  })

  test('current 为空时保留 previous（接口失败不丢历史）', () => {
    const previous: TurnoverPoint[] = [
      { date: '2026-08-12', turnoverPct: 3.1, amountYuan: 3.9e9 },
    ]
    expect(mergeTurnoverHistory(previous, [])).toEqual(previous)
  })

  test('previous 为空时直接返回 current 副本', () => {
    const current: TurnoverPoint[] = [
      { date: '2026-08-14', turnoverPct: 3.46, amountYuan: 3.98e9 },
    ]
    expect(mergeTurnoverHistory([], current)).toEqual(current)
  })

  test('乱序输入按日期升序输出', () => {
    const previous: TurnoverPoint[] = [
      { date: '2026-08-15', turnoverPct: 1, amountYuan: 1e9 },
    ]
    const current: TurnoverPoint[] = [
      { date: '2026-08-14', turnoverPct: 2, amountYuan: 2e9 },
    ]
    const merged = mergeTurnoverHistory(previous, current)
    expect(merged.map((p) => p.date)).toEqual(['2026-08-14', '2026-08-15'])
  })
})
