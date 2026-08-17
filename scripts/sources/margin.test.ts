import { describe, expect, test } from 'bun:test'
import { normalizeMarginRows } from './margin'

describe('normalizeMarginRows', () => {
  test('日期截取到日、字段映射、按日期升序', () => {
    const rows = [
      {
        DIM_DATE: '2026-08-14 00:00:00',
        RZYE: 2647886013996,
        RZMRE: 200873951059,
        RZRQYE: 2673859306358,
        RZYEZB: 2.63132,
      },
      {
        DIM_DATE: '2026-08-13 00:00:00',
        RZYE: 2600000000000,
        RZMRE: 190000000000,
        RZRQYE: 2620000000000,
        RZYEZB: null,
      },
    ]
    const points = normalizeMarginRows(rows)
    expect(points).toHaveLength(2)
    expect(points[0]).toEqual({
      date: '2026-08-13',
      rzye: 2600000000000,
      rzmre: 190000000000,
      rzrqye: 2620000000000,
      rzyezb: null,
    })
    expect(points[1]!.date).toBe('2026-08-14')
    expect(points[1]!.rzyezb).toBe(2.63132)
  })

  test('RZYE 非正或缺失的行被剔除', () => {
    const rows = [
      { DIM_DATE: '2026-08-14 00:00:00', RZYE: 0, RZMRE: 1, RZRQYE: 1, RZYEZB: null },
      { DIM_DATE: 'bad-date', RZYE: 100, RZMRE: 1, RZRQYE: 1, RZYEZB: null },
    ]
    expect(normalizeMarginRows(rows)).toHaveLength(0)
  })

  test('空输入返回空数组', () => {
    expect(normalizeMarginRows([])).toEqual([])
  })
})
