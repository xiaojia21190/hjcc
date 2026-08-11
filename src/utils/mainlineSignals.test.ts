import { describe, expect, test } from 'bun:test'
import { evaluateMainline, type CategoryNavSeries } from './mainlineSignals'

const CATEGORIES = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']
const TOTAL_DAYS = 200
/** 窗口 20 时：endIndex=199、startIndex=179，前半窗覆盖 day 180-189，后半窗覆盖 day 190-199。 */
const WINDOW = 20

/** 用「按天给出各板块收益率」的函数构造净值序列。 */
function buildSeries(
  dailyReturn: (categoryIndex: number, day: number) => number,
  options: { days?: number; count?: number } = {},
): CategoryNavSeries[] {
  const days = options.days ?? TOTAL_DAYS
  const count = options.count ?? CATEGORIES.length
  return Array.from({ length: count }, (_, ci) => {
    let nav = 1
    const points = Array.from({ length: days }, (_, day) => {
      nav *= 1 + dailyReturn(ci, day)
      return { date: `d${String(day).padStart(4, '0')}`, nav }
    })
    return { category: CATEGORIES[ci], categoryName: `板块${ci}`, points }
  })
}

describe('evaluateMainline · 有主线', () => {
  // 前 130 天齐涨齐跌，之后 c0 每日稳定跑赢
  const series = buildSeries((ci, day) => {
    if (day < 130) return 0.001
    return ci === 0 ? 0.004 : 0.0005
  })
  const report = evaluateMainline(series, { windows: [WINDOW] })
  const result = report.windows[0]

  test('判定为 mainline', () => {
    expect(report.verdict).toBe('mainline')
  })

  test('龙头为持续跑赢的板块', () => {
    expect(result.leader?.category).toBe('c0')
    expect(result.leader!.returnPct).toBeGreaterThan(0)
  })

  test('分化度处于历史高分位', () => {
    // 恒定日收益下窗口分化度理论上不变，浮点抖动会让分位略低于 100
    expect(result.dispersionPercentile).toBeGreaterThan(90)
    expect(result.dispersion).toBeGreaterThan(0)
  })

  test('前后半窗排名完全一致', () => {
    expect(result.persistence).toBeCloseTo(1, 10)
  })

  test('龙头每个交易日都跑赢等权平均', () => {
    expect(result.leaderEdgeRatio).toBe(1)
  })

  test('headline 含龙头与涨幅', () => {
    expect(report.headline).toContain('有主线')
    expect(report.headline).toContain('板块0')
  })
})

describe('evaluateMainline · 轮动无主线', () => {
  // 累计收益仍高度分化，但前半窗与后半窗排名完全反转
  const series = buildSeries((ci, day) => {
    if (day < 180) return 0.001
    if (day < 190) {
      if (ci === 0) return 0.014
      if (ci === 1) return -0.008
      return 0
    }
    if (ci === 0) return -0.002
    if (ci === 1) return 0.003
    return 0
  })
  const report = evaluateMainline(series, { windows: [WINDOW] })
  const result = report.windows[0]

  test('判定为 rotation 而非 mainline', () => {
    expect(report.verdict).toBe('rotation')
  })

  test('分化度依然处于高分位——分化不等于主线', () => {
    expect(result.dispersionPercentile).toBeGreaterThanOrEqual(40)
  })

  test('前后半窗排名反转，持续性为负', () => {
    expect(result.persistence).toBeCloseTo(-1, 10)
  })

  test('reason 说明属高低切轮动', () => {
    expect(result.reason).toContain('轮动')
  })

  test('辅窗 insufficient 不影响主窗综合结论', () => {
    // 60 日窗口的前半窗全部同步，排名无方差 → insufficient；综合仍取 20 日
    const multi = evaluateMainline(series, { windows: [WINDOW, 60] })
    expect(multi.windows[1].verdict).toBe('insufficient')
    expect(multi.verdict).toBe('rotation')
  })
})

describe('evaluateMainline · 综合结论取主观察窗', () => {
  // 早期各板块收益阶梯拉开（给 60 日制造前后半窗排名翻转的素材）；
  // 130 日后 c0 稳定跑赢 → 20 日 mainline；
  // 最近 5 日全员同步 → 5 日 none。
  // 旧规则取最弱会把综合压成 none/rotation；新规则应锁定 20 日 mainline。
  const series = buildSeries((ci, day) => {
    if (day >= TOTAL_DAYS - 5) return 0.001
    if (day < 130) return 0.001 + ci * 0.0005
    return ci === 0 ? 0.004 : 0.0005
  })

  test('5 日 none 与 60 日 rotation 均不拖累 20 日 mainline', () => {
    const report = evaluateMainline(series, { windows: [5, WINDOW, 60] })
    expect(report.windows[0].verdict).toBe('none')
    expect(report.windows[1].verdict).toBe('mainline')
    expect(report.windows[2].verdict).toBe('rotation')
    expect(report.verdict).toBe('mainline')
  })

  test('综合结论与 20 日窗判定一致', () => {
    const report = evaluateMainline(series)
    const primary = report.windows.find((w) => w.window === 20)
    expect(primary).toBeDefined()
    expect(report.verdict).toBe(primary!.verdict)
  })

  test('自定义 windows 不含 20 时退回中位档', () => {
    const report = evaluateMainline(series, { windows: [5, 10, 15] })
    expect(report.verdict).toBe(report.windows[1].verdict)
  })
})

describe('evaluateMainline · 无主线', () => {
  // 前 300 天高度分化，最近窗口齐涨齐跌
  const series = buildSeries((ci, day) => (day < 300 ? (ci === 0 ? 0.005 : 0) : 0.001), {
    days: 340,
  })
  const report = evaluateMainline(series, { windows: [WINDOW] })
  const result = report.windows[0]

  test('判定为 none', () => {
    expect(report.verdict).toBe('none')
  })

  test('分化度落在历史低分位', () => {
    expect(result.dispersionPercentile).toBeLessThan(40)
    expect(result.dispersion).toBeCloseTo(0, 10)
  })

  test('reason 说明齐涨齐跌', () => {
    expect(result.reason).toContain('齐涨齐跌')
  })
})

describe('evaluateMainline · 弱主线', () => {
  // c0 前后半窗各靠一次暴涨维持领先，其余交易日均跑输
  const series = buildSeries((ci, day) => {
    if (day < 180 || ci !== 0) return 0.001
    return day === 185 || day === 195 ? 0.15 : -0.003
  })
  const report = evaluateMainline(series, { windows: [WINDOW] })
  const result = report.windows[0]

  test('判定为 weak——方向持续但涨幅集中于少数交易日', () => {
    expect(report.verdict).toBe('weak')
  })

  test('持续性达标但龙头日超额胜率极低', () => {
    expect(result.persistence).toBeCloseTo(1, 10)
    expect(result.leaderEdgeRatio).toBeCloseTo(0.1, 10)
  })

  test('reason 指出涨幅集中', () => {
    expect(result.reason).toContain('集中于少数交易日')
  })
})

describe('evaluateMainline · 资金确认', () => {
  const series = buildSeries((ci, day) => {
    if (day < 130) return 0.001
    return ci === 0 ? 0.004 : 0.0005
  })
  const evaluate = (flows?: Record<string, 'inflow' | 'outflow' | 'flat'>) =>
    evaluateMainline(series, { windows: [WINDOW], flows })

  test('龙头资金净流入时确认', () => {
    expect(evaluate({ c0: 'inflow', c1: 'outflow' }).flowConfirmed).toBe(true)
  })

  test('龙头资金净流出时不确认', () => {
    expect(evaluate({ c0: 'outflow' }).flowConfirmed).toBe(false)
  })

  test('龙头无资金数据时不确认', () => {
    expect(evaluate({ c1: 'inflow' }).flowConfirmed).toBe(false)
  })

  test('未提供资金数据时为 null', () => {
    expect(evaluate().flowConfirmed).toBeNull()
  })
})

describe('evaluateMainline · 数据不足', () => {
  test('可比板块少于 3 个时整体不可判定', () => {
    const report = evaluateMainline(buildSeries(() => 0.001, { count: 2 }))
    expect(report.verdict).toBe('insufficient')
    expect(report.categoryCount).toBe(0)
    expect(report.asOf).toBeNull()
    expect(report.headline).toBe('数据不足，无法判定主线')
  })

  test('交易日不足窗口长度时该窗口不可判定', () => {
    const report = evaluateMainline(buildSeries(() => 0.001, { days: 10 }), {
      windows: [WINDOW],
    })
    expect(report.windows[0].verdict).toBe('insufficient')
    expect(report.windows[0].reason).toContain('交易日不足')
  })

  test('空输入不抛异常', () => {
    expect(evaluateMainline([]).verdict).toBe('insufficient')
  })

  test('仅取各板块公共交易日', () => {
    const series = buildSeries((ci, day) => (day < 130 ? 0.001 : ci === 0 ? 0.004 : 0.0005))
    // 抹掉一个板块的最后 5 个交易日，公共交易日应随之收缩
    series[3].points = series[3].points.slice(0, TOTAL_DAYS - 5)
    const report = evaluateMainline(series, { windows: [WINDOW] })
    expect(report.asOf).toBe(`d${String(TOTAL_DAYS - 6).padStart(4, '0')}`)
    expect(report.categoryCount).toBe(CATEGORIES.length)
  })
})
