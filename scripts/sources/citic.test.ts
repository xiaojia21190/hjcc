import { describe, expect, test } from 'bun:test'
import {
  buildCiticPositionHistory,
  defaultBackfillStart,
  fetchCiticPositionHistoryCffex,
  mergeCiticRows,
  nextDateYyyyMmDd,
} from './citic'

type Row = { date: string; product: 'IF' | 'IH' | 'IC' | 'IM'; longHold: number; shortHold: number }

describe('nextDateYyyyMmDd', () => {
  test('普通日期 +1 天', () => {
    expect(nextDateYyyyMmDd('2026-08-25')).toBe('20260826')
  })
  test('跨月', () => {
    expect(nextDateYyyyMmDd('2026-08-31')).toBe('20260901')
  })
  test('跨年', () => {
    expect(nextDateYyyyMmDd('2025-12-31')).toBe('20260101')
  })
  test('闰年 2 月', () => {
    expect(nextDateYyyyMmDd('2024-02-28')).toBe('20240229')
  })
})

describe('mergeCiticRows', () => {
  test('空缓存 → 仅新数据', () => {
    const fresh: Row[] = [{ date: '2026-08-25', product: 'IF', longHold: 1, shortHold: 2 }]
    expect(mergeCiticRows([], fresh)).toEqual(fresh)
  })

  test('新数据覆盖同 (date,product) 的旧值', () => {
    const base: Row[] = [{ date: '2026-08-24', product: 'IF', longHold: 10, shortHold: 20 }]
    const fresh: Row[] = [{ date: '2026-08-24', product: 'IF', longHold: 11, shortHold: 22 }]
    const merged = mergeCiticRows(base, fresh)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual(fresh[0])
  })

  test('保留无重叠的旧数据, 追加新日期', () => {
    const base: Row[] = [
      { date: '2026-08-23', product: 'IF', longHold: 5, shortHold: 6 },
      { date: '2026-08-24', product: 'IF', longHold: 7, shortHold: 8 },
    ]
    const fresh: Row[] = [{ date: '2026-08-25', product: 'IF', longHold: 9, shortHold: 10 }]
    const merged = mergeCiticRows(base, fresh)
    expect(merged).toHaveLength(3)
    const dates = merged.map((r) => r.date).sort()
    expect(dates).toEqual(['2026-08-23', '2026-08-24', '2026-08-25'])
  })

  test('不同品种互不干扰', () => {
    const base: Row[] = [{ date: '2026-08-24', product: 'IH', longHold: 1, shortHold: 1 }]
    const fresh: Row[] = [{ date: '2026-08-24', product: 'IF', longHold: 2, shortHold: 2 }]
    const merged = mergeCiticRows(base, fresh)
    expect(merged).toHaveLength(2)
  })
})

describe('buildCiticPositionHistory (增量重算)', () => {
  test('合并缓存+新日后续算 netChange 正确', () => {
    const base: Row[] = [
      { date: '2026-08-18', product: 'IF', longHold: 33375, shortHold: 52344 },
      { date: '2026-08-19', product: 'IF', longHold: 36915, shortHold: 56057 },
    ]
    const fresh: Row[] = [{ date: '2026-08-20', product: 'IF', longHold: 37000, shortHold: 56000 }]
    const merged = mergeCiticRows(base, fresh)
    const history = buildCiticPositionHistory(merged)
    const last = history[history.length - 1]!
    expect(last.date).toBe('2026-08-20')
    expect(last.netHold).toBe(37000 - 56000)
    expect(last.netChange).toBe(37000 - 56000 - (36915 - 56057))
  })
})

describe('defaultBackfillStart (回填窗口收窄)', () => {
  test('无缓存时默认从今天 - 45 天开始，不再全量回填 20240101', () => {
    const saved = process.env.CITIC_BACKFILL_START
    const savedDays = process.env.CITIC_BACKFILL_DAYS
    delete process.env.CITIC_BACKFILL_START
    delete process.env.CITIC_BACKFILL_DAYS
    try {
      const start = defaultBackfillStart()
      const expected = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10).replaceAll('-', '')
      expect(start).toBe(expected)
      // 与全量回填的 20240101 保持足够距离
      expect(Number(start)).toBeGreaterThan(Number('20250101'))
    } finally {
      if (saved != null) process.env.CITIC_BACKFILL_START = saved
      if (savedDays != null) process.env.CITIC_BACKFILL_DAYS = savedDays
    }
  })

  test('CITIC_BACKFILL_START 环境变量优先', () => {
    const saved = process.env.CITIC_BACKFILL_START
    process.env.CITIC_BACKFILL_START = '20240101'
    try {
      expect(defaultBackfillStart()).toBe('20240101')
    } finally {
      if (saved != null) process.env.CITIC_BACKFILL_START = saved
      else delete process.env.CITIC_BACKFILL_START
    }
  })
})

describe('runCiticPython 超时（经 fetchCiticPositionHistoryCffex）', () => {
  test('python 卡死时按预算超时并报错，而不是永久挂起', async () => {
    // sleep 60 模拟卡死；预算 1s → ~1s 内返回超时错误
    const started = Date.now()
    let caught: unknown = null
    await fetchCiticPositionHistoryCffex([], {
      fullStartDate: '20260101',
      timeoutMs: 1_000,
    }).catch((e) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('超时')
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)
})
