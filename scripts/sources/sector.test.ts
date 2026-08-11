import { describe, expect, test } from 'bun:test'
import { alignSectors, collectSectorBars, type RawSector } from './sector'
import type { MarketBar } from './eastmoney'

/** 按日期序号造收盘序列，close 用 100 + 序号，便于断言取值。 */
function mkSector(code: string, dayIndexes: number[]): RawSector {
  return {
    code,
    name: `板块${code}`,
    bars: dayIndexes.map((day) => ({
      date: `2024-01-${String(day).padStart(2, '0')}`,
      close: 100 + day,
      amount: 1_000_000,
    })),
  }
}

const fullDays = Array.from({ length: 40 }, (_, i) => i + 1)

describe('alignSectors', () => {
  test('全部板块日期一致时保留完整时间轴', () => {
    const result = alignSectors([
      mkSector('BK0001', fullDays),
      mkSector('BK0002', fullDays),
      mkSector('BK0003', fullDays),
    ])
    expect(result.dates.length).toBe(40)
    expect(result.sectors.length).toBe(3)
    expect(result.sectors[0].closes.length).toBe(40)
    expect(result.sectors[0].closes[0]).toBe(101)
  })

  test('次新板块被剔除，时间轴不被其削短', () => {
    // 这是本函数的核心约束：若先取交集再剔除，时间轴会被压到 5 天
    const result = alignSectors([
      mkSector('BK0001', fullDays),
      mkSector('BK0002', fullDays),
      mkSector('BK0003', fullDays),
      mkSector('BK9999', [36, 37, 38, 39, 40]),
    ])
    expect(result.dates.length).toBe(40)
    expect(result.sectors.map((s) => s.code)).not.toContain('BK9999')
    expect(result.sectors.length).toBe(3)
  })

  test('覆盖率接近中位数的板块保留，并按交集收缩时间轴', () => {
    // 39/40 = 97.5% ≥ 95% 阈值，保留；缺失的那天从公共轴移除
    const result = alignSectors([
      mkSector('BK0001', fullDays),
      mkSector('BK0002', fullDays),
      mkSector('BK0003', fullDays.filter((d) => d !== 20)),
    ])
    expect(result.sectors.length).toBe(3)
    expect(result.dates.length).toBe(39)
    expect(result.dates).not.toContain('2024-01-20')
  })

  test('各板块收盘按公共日期轴对齐', () => {
    const result = alignSectors([
      mkSector('BK0001', fullDays),
      mkSector('BK0002', fullDays),
      mkSector('BK0003', fullDays.filter((d) => d !== 20)),
    ])
    const at = result.dates.indexOf('2024-01-21')
    for (const sector of result.sectors) {
      expect(sector.closes[at]).toBe(121)
    }
  })

  test('空输入与全空 bars 返回空结果', () => {
    expect(alignSectors([]).dates).toEqual([])
    expect(alignSectors([mkSector('BK0001', [])]).sectors).toEqual([])
  })
})

/** 无间隔配置，让测试不受节流耗时影响。 */
const NO_WAIT = { intervalMs: 0, retryIntervalMs: 0 }
const oneBar: MarketBar[] = [{ date: '2024-01-01', close: 100, amount: 1 }]

describe('collectSectorBars', () => {
  const list = [
    { code: 'BK0001', name: '板块一' },
    { code: 'BK0002', name: '板块二' },
  ]

  test('全部成功时按原顺序返回', async () => {
    const result = await collectSectorBars(list, async () => oneBar, NO_WAIT)
    expect(result.map((sector) => sector.code)).toEqual(['BK0001', 'BK0002'])
    expect(result.every((sector) => sector.bars.length === 1)).toBe(true)
  })

  test('首轮失败的板块会被补抓', async () => {
    const attempts = new Map<string, number>()
    const result = await collectSectorBars(
      list,
      async (meta) => {
        const n = (attempts.get(meta.code) ?? 0) + 1
        attempts.set(meta.code, n)
        // BK0002 首轮失败、补抓成功
        if (meta.code === 'BK0002' && n === 1) throw new Error('ECONNRESET')
        return oneBar
      },
      NO_WAIT,
    )
    expect(attempts.get('BK0002')).toBe(2)
    expect(result.find((sector) => sector.code === 'BK0002')?.bars.length).toBe(1)
  })

  test('补抓仍失败时返回空 bars，不抛错', async () => {
    const result = await collectSectorBars(
      list,
      async (meta) => {
        if (meta.code === 'BK0002') throw new Error('ECONNRESET')
        return oneBar
      },
      NO_WAIT,
    )
    expect(result.find((sector) => sector.code === 'BK0002')?.bars).toEqual([])
    expect(result.find((sector) => sector.code === 'BK0001')?.bars.length).toBe(1)
  })

  test('返回空数组视同失败并触发补抓', async () => {
    let calls = 0
    await collectSectorBars(
      [list[0]],
      async () => {
        calls += 1
        return []
      },
      NO_WAIT,
    )
    expect(calls).toBe(2)
  })

  test('成功的板块不会被重复抓取', async () => {
    let calls = 0
    await collectSectorBars(
      list,
      async () => {
        calls += 1
        return oneBar
      },
      NO_WAIT,
    )
    expect(calls).toBe(2)
  })

  test('连续失败达到上限即熔断，不再抓取剩余板块', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      code: `BK${i}`,
      name: `板块${i}`,
    }))
    let calls = 0
    const result = await collectSectorBars(
      many,
      async () => {
        calls += 1
        return []
      },
      { ...NO_WAIT, failureStreakLimit: 5 },
    )
    // 熔断后不进补抓轮，总调用次数就等于阈值
    expect(calls).toBe(5)
    expect(result.length).toBe(50)
    expect(result.every((sector) => sector.bars.length === 0)).toBe(true)
  })

  test('零星失败不触发熔断——成功会重置连续计数', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      code: `BK${i}`,
      name: `板块${i}`,
    }))
    let firstRound = 0
    const result = await collectSectorBars(
      many,
      async (meta) => {
        firstRound += 1
        // 每隔一个失败一次，连续失败数永远是 1
        return Number(meta.code.slice(2)) % 2 === 0 ? oneBar : []
      },
      { ...NO_WAIT, failureStreakLimit: 3 },
    )
    // 12 只全部抓完（未熔断），另有 6 只进入补抓轮
    expect(firstRound).toBe(12 + 6)
    expect(result.length).toBe(12)
  })
})
