# 散户情绪反向面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在看板新增「散户情绪反向」面板：用六大宽基 ETF 的总份额净申购率（全体非汇金资金申赎代理）与「其他资金份额 = 总份额 − 汇金估算」两个已有数据口径，生成追涨/杀跌情绪判定、滚动分位温度，并与汇金方向交叉得出反向象限。

**Architecture:** 仿照 forceVerdict 的「度量层 / 判定层 / 面板」三层：`retailMetrics.ts` 做纯序列变换（其他资金份额、净申购率），`retailSignals.ts` 做阈值判定（mood、分位温度、汇金交叉象限），`RetailPanel.vue` 复用现有闸格布局展示。数据全部来自 `data/dashboard.json` 已有字段，零新增抓取。

**Tech Stack:** Vue 3 + TypeScript + Bun test，复用 `stats.ts` 的 `percentileRank` 与 `estimateDisplay.ts` 的 `estimateRangeYi`。

**口径决策（写死在常量与文案里，不许静默漂移）：**

1. **主指标——总份额净申购率**：日频 `netSubscriptionYi / 前一日 totalSharesYi`，5 日累计，250 日滚动分位。对所有 6 只 ETF 可用（633 个日频点）。这是「边际申赎者（以非汇金资金为主）」的最诚实观测，不假装能拆出散户。
2. **副指标——其他资金份额存量**：`totalSharesYi − huijinShares/1e8`（亿份，仅 anchored/disclosed 点）。仅 5 只有披露的 ETF 可用（148 个 anchored 点，样本太短，**不做分位**，只做水平与 5 日变化）。科创50 无披露，面板标注。
3. **反向象限**：汇金多数 tone（复用 `collectForceInputs` 提取的 `shareTrend`）× 散户 mood 交叉。

---

### Task 1: retailMetrics.ts 度量层

**Files:**
- Create: `src/utils/retailMetrics.ts`
- Test: `src/utils/retailMetrics.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'bun:test'
import type { EtfSnapshot, HuijinEstimatePoint, ScalePoint } from '../../shared/types'
import {
  cumulativeNetSubRatePct,
  netSubscriptionRateSeries,
  otherCapitalSeries,
} from './retailMetrics'

function scalePoint(date: string, totalYi: number, netSubYi: number | null): ScalePoint {
  return {
    date,
    totalSharesYi: totalYi,
    netAssetYi: totalYi * 3,
    purchaseYi: null,
    redeemYi: null,
    netSubscriptionYi: netSubYi,
    netAssetChangePct: null,
    frequency: 'daily',
    shareSource: 'sse',
    netAssetEstimated: true,
  }
}

function anchoredPoint(
  date: string,
  totalYi: number,
  shares: number,
  floorYi: number,
  ceilYi: number,
): HuijinEstimatePoint {
  return {
    date,
    netAssetYi: totalYi * 3,
    totalSharesYi: totalYi,
    huijinShares: shares,
    huijinValueYi: null,
    huijinPct: (shares / 1e8 / totalYi) * 100,
    isEstimated: true,
    estimateMethod: 'anchored',
    huijinSharesFloor: floorYi,
    huijinSharesCeil: ceilYi,
  }
}

describe('otherCapitalSeries', () => {
  test('anchored 点产出其他份额与反向区间', () => {
    const etf = {
      huijinEstimateHistory: [
        anchoredPoint('2026-01-05', 100, 40e8, 35, 45),
      ],
    } as Pick<EtfSnapshot, 'huijinEstimateHistory'>
    const series = otherCapitalSeries(etf)
    expect(series).toHaveLength(1)
    const p = series[0]!
    expect(p.otherYi).toBeCloseTo(60, 6)
    // 其他下界 = 总 − 汇金上界；其他上界 = 总 − 汇金下界
    expect(p.floorYi).toBeCloseTo(55, 6)
    expect(p.ceilYi).toBeCloseTo(65, 6)
    expect(p.totalYi).toBe(100)
    expect(p.date).toBe('2026-01-05')
  })

  test('unavailable 点 otherYi 为 null 且区间为 null', () => {
    const etf = {
      huijinEstimateHistory: [
        {
          date: '2026-01-05',
          netAssetYi: 300,
          totalSharesYi: 100,
          huijinShares: null,
          huijinValueYi: null,
          huijinPct: null,
          isEstimated: true,
          estimateMethod: 'unavailable',
        },
      ],
    } as Pick<EtfSnapshot, 'huijinEstimateHistory'>
    const series = otherCapitalSeries(etf)
    expect(series[0]!.otherYi).toBeNull()
    expect(series[0]!.floorYi).toBeNull()
    expect(series[0]!.totalYi).toBe(100)
  })

  test('disclosed 点有 otherYi 无区间', () => {
    const etf = {
      huijinEstimateHistory: [
        {
          date: '2025-12-31',
          netAssetYi: 300,
          totalSharesYi: 100,
          huijinShares: 86.05e8,
          huijinValueYi: 260,
          huijinPct: 86.05,
          isEstimated: false,
          estimateMethod: 'disclosed',
        },
      ],
    } as Pick<EtfSnapshot, 'huijinEstimateHistory'>
    const p = otherCapitalSeries(etf)[0]!
    expect(p.otherYi).toBeCloseTo(13.95, 6)
    expect(p.floorYi).toBeNull()
    expect(p.ceilYi).toBeNull()
  })
})

describe('netSubscriptionRateSeries', () => {
  test('净申购率 = 净变化 / 前一日总份额，首日与缺失为 null', () => {
    const history = [
      scalePoint('2026-01-02', 100, null),
      scalePoint('2026-01-03', 102, 2),
      scalePoint('2026-01-06', 101.5, -0.5),
    ]
    const rates = netSubscriptionRateSeries(history)
    expect(rates[0]!.ratePct).toBeNull()
    expect(rates[1]!.ratePct).toBeCloseTo(2, 6)
    expect(rates[2]!.ratePct).toBeCloseTo((-0.5 / 102) * 100, 6)
    expect(rates.map((r) => r.date)).toEqual(['2026-01-02', '2026-01-03', '2026-01-06'])
  })

  test('非 daily 点被剔除', () => {
    const history = [
      scalePoint('2026-01-02', 100, null),
      { ...scalePoint('2026-06-30', 200, 50), frequency: 'periodic' as const },
      scalePoint('2026-01-03', 102, 2),
    ]
    const rates = netSubscriptionRateSeries(history)
    expect(rates).toHaveLength(2)
    expect(rates[1]!.ratePct).toBeCloseTo(2, 6)
  })

  test('净变化缺失的交易日产出 null 而非中断', () => {
    const history = [
      scalePoint('2026-01-02', 100, null),
      scalePoint('2026-01-03', 102, null),
    ]
    const rates = netSubscriptionRateSeries(history)
    expect(rates[1]!.ratePct).toBeNull()
  })
})

describe('cumulativeNetSubRatePct', () => {
  test('末 N 日加总；日率量级小，加总与复利差异可忽略', () => {
    const rates = [
      { date: 'd1', ratePct: 1 },
      { date: 'd2', ratePct: 1 },
      { date: 'd3', ratePct: 1 },
      { date: 'd4', ratePct: 1 },
      { date: 'd5', ratePct: 1 },
    ]
    expect(cumulativeNetSubRatePct(rates, 5)).toBeCloseTo(5, 6)
  })

  test('窗口内 null 视为 0，不中断累计', () => {
    const rates = [
      { date: 'd1', ratePct: null },
      { date: 'd2', ratePct: 2 },
      { date: 'd3', ratePct: null },
      { date: 'd4', ratePct: null },
      { date: 'd5', ratePct: null },
    ]
    expect(cumulativeNetSubRatePct(rates, 5)).toBeCloseTo(2, 6)
  })

  test('样本不足返回 null', () => {
    expect(cumulativeNetSubRatePct([], 5)).toBeNull()
    expect(
      cumulativeNetSubRatePct([{ date: 'd1', ratePct: 1 }], 5),
    ).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/retailMetrics.test.ts`
Expected: FAIL，报错 `Cannot find module './retailMetrics'`

- [ ] **Step 3: 写实现**

```ts
/**
 * 散户情绪反向的度量层：其他资金份额序列与总份额净申购率。
 * 只产出数字，不做任何阈值判定——判定逻辑见 retailSignals.ts。
 * 「其他资金」= 非汇金全体（散户、机构、游资），散户只是主要成分之一。
 */
import type { EtfSnapshot, HuijinEstimatePoint, ScalePoint } from '../../shared/types'

/** 其他资金份额点，单位亿份；仅 anchored/disclosed 点有拆分值。 */
export interface OtherCapitalPoint {
  date: string
  /** 总份额 − 汇金点估计；无拆分口径时为 null。 */
  otherYi: number | null
  /** 其他下界 = 总份额 − 汇金上界；无区间时为 null。 */
  floorYi: number | null
  /** 其他上界 = 总份额 − 汇金下界；无区间时为 null。 */
  ceilYi: number | null
  /** 当日总份额（亿份），始终有值。 */
  totalYi: number
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

/** 从估算序列构造其他资金份额序列；unavailable 点产出 null 拆分。 */
export function otherCapitalSeries(
  etf: Pick<EtfSnapshot, 'huijinEstimateHistory'>,
): OtherCapitalPoint[] {
  return etf.huijinEstimateHistory.map((point: HuijinEstimatePoint) => {
    const total = point.totalSharesYi
    const sharesYi =
      point.huijinShares != null && Number.isFinite(point.huijinShares)
        ? point.huijinShares / 1e8
        : null
    return {
      date: point.date,
      otherYi: sharesYi != null && total > 0 ? round6(total - sharesYi) : null,
      floorYi:
        point.huijinSharesCeil != null && total > 0
          ? round6(total - point.huijinSharesCeil)
          : null,
      ceilYi:
        point.huijinSharesFloor != null && total > 0
          ? round6(total - point.huijinSharesFloor)
          : null,
      totalYi: total,
    }
  })
}

/** 日净申购率点（%），ratePct = 净变化 / 前一日总份额 × 100。 */
export interface NetSubRatePoint {
  date: string
  ratePct: number | null
}

/**
 * 构造日频净申购率序列：仅取 frequency === 'daily' 的点，
 * 净变化缺失或前一日总份额非正时 ratePct 为 null。
 */
export function netSubscriptionRateSeries(history: ScalePoint[]): NetSubRatePoint[] {
  const daily = history.filter((p) => p.frequency === 'daily')
  const out: NetSubRatePoint[] = []
  for (let i = 0; i < daily.length; i++) {
    const point = daily[i]!
    const ratePct =
      i > 0 &&
      point.netSubscriptionYi != null &&
      daily[i - 1]!.totalSharesYi > 0
        ? round6((point.netSubscriptionYi / daily[i - 1]!.totalSharesYi) * 100)
        : null
    out.push({ date: point.date, ratePct })
  }
  return out
}

/**
 * 最近 N 个交易日净申购率加总（%）。
 * 日率量级通常 < 1%，加总与复利合成差异 < 0.01pp，取更可解释的加总。
 * 样本不足 N 或序列为空时返回 null；窗口内 null 视为 0（缺数据≠零申赎，
 * 但中断累计会把缺失日之后的所有窗口永久作废，取舍后按 0 处理）。
 */
export function cumulativeNetSubRatePct(
  rates: NetSubRatePoint[],
  days: number,
): number | null {
  if (rates.length < days) return null
  return round6(
    rates.slice(-days).reduce((sum, r) => sum + (r.ratePct ?? 0), 0),
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/retailMetrics.test.ts`
Expected: PASS，全部用例绿

- [ ] **Step 5: Commit**

```bash
git add src/utils/retailMetrics.ts src/utils/retailMetrics.test.ts
git commit -m "feat(retail): 新增其他资金份额与净申购率度量层"
```

---

### Task 2: retailSignals.ts 判定层

**Files:**
- Create: `src/utils/retailSignals.ts`
- Test: `src/utils/retailSignals.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'bun:test'
import type { EtfSnapshot, HuijinEstimatePoint, ScalePoint } from '../../shared/types'
import {
  CHASE_PCT_5D,
  COLD_PERCENTILE,
  DISCLAIMER,
  HOT_PERCENTILE,
  judgeRetailSentiment,
  judgeMood,
  temperatureLabel,
  type MoodInput,
} from './retailSignals'

function scalePoint(date: string, totalYi: number, netSubYi: number | null): ScalePoint {
  return {
    date,
    totalSharesYi: totalYi,
    netAssetYi: totalYi * 3,
    purchaseYi: null,
    redeemYi: null,
    netSubscriptionYi: netSubYi,
    netAssetChangePct: null,
    frequency: 'daily' as const,
    shareSource: 'sse' as const,
    netAssetEstimated: true,
  }
}

/** 造一只 ETF：days 天日频序列，每日净申购率 ≈ dailyRatePct，末尾 shareTrend。 */
function makeEtf(partial: {
  name: string
  dailyRatePct?: number
  shareTrend?: 'inflow' | 'outflow' | 'flat' | null
  withDisclosure?: boolean
  historyOverride?: ScalePoint[]
}): EtfSnapshot {
  const dailyRatePct = partial.dailyRatePct ?? 0
  const history: ScalePoint[] = partial.historyOverride ?? []
  if (history.length === 0) {
    // 300 天：总份额按 dailyRatePct 复利演化，保证净申购率恒定
    let total = 100
    history.push(scalePoint('2025-01-01', total, null))
    for (let i = 1; i < 300; i++) {
      const netSub = (total * dailyRatePct) / 100
      total = Number((total + netSub).toFixed(6))
      history.push(scalePoint(`2025-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`, total, netSub))
    }
  }
  const hasDisclosure = partial.withDisclosure ?? true
  const estimate: HuijinEstimatePoint[] = hasDisclosure
    ? history.slice(-260).map((p, i) => ({
        date: p.date,
        netAssetYi: p.totalSharesYi * 3,
        totalSharesYi: p.totalSharesYi,
        huijinShares: p.totalSharesYi * 0.4e8,
        huijinValueYi: null,
        huijinPct: 40,
        isEstimated: true,
        estimateMethod: 'anchored' as const,
        huijinSharesFloor: p.totalSharesYi * 0.3,
        huijinSharesCeil: p.totalSharesYi * 0.5,
        shareTrend: i === history.slice(-260).length - 1 ? partial.shareTrend ?? null : null,
      }))
    : history.map((p) => ({
        date: p.date,
        netAssetYi: p.totalSharesYi * 3,
        totalSharesYi: p.totalSharesYi,
        huijinShares: null,
        huijinValueYi: null,
        huijinPct: null,
        isEstimated: true,
        estimateMethod: 'unavailable' as const,
      }))
  return {
    category: 'csi300',
    categoryName: partial.name,
    code: `00000${partial.name.length}`,
    name: partial.name,
    market: 'SH',
    quote: { code: 'x', name: partial.name, price: 1, changePct: 0, marketCap: 1, floatCap: 1, market: 'SH' },
    isLargest: true,
    scaleHistory: history,
    navHistory: [],
    holderReports: [],
    huijinHistory: [],
    latestHuijin: hasDisclosure
      ? { reportDate: '2025-12-31', shares: 40e8, percent: 40, marketValue: null, entities: [] }
      : null,
    huijinEstimateHistory: estimate,
    source: { scale: 'sse', nav: 'eastmoney', holders: 'sina' },
  } as unknown as EtfSnapshot
}

describe('judgeMood', () => {
  const base: MoodInput = { categoryName: '沪深300', netSub5dPct: 0 }
  test('边界值判定', () => {
    expect(judgeMood({ ...base, netSub5dPct: CHASE_PCT_5D })).toBe('chasing')
    expect(judgeMood({ ...base, netSub5dPct: CHASE_PCT_5D - 0.01 })).toBe('calm')
    expect(judgeMood({ ...base, netSub5dPct: -2 })).toBe('capitulating')
    expect(judgeMood({ ...base, netSub5dPct: -1.99 })).toBe('calm')
    expect(judgeMood({ ...base, netSub5dPct: null })).toBeNull()
  })
})

describe('temperatureLabel', () => {
  test('分位边界', () => {
    expect(temperatureLabel(HOT_PERCENTILE)).toBe('高热')
    expect(temperatureLabel(HOT_PERCENTILE + 1)).toBe('高热')
    expect(temperatureLabel(70)).toBe('偏热')
    expect(temperatureLabel(50)).toBe('中性')
    expect(temperatureLabel(30)).toBe('偏冷')
    expect(temperatureLabel(COLD_PERCENTILE)).toBe('冰点')
    expect(temperatureLabel(null)).toBe('样本不足')
  })
})

describe('judgeRetailSentiment', () => {
  test('空输入返回 unclear 与 disclaimer', () => {
    const r = judgeRetailSentiment([])
    expect(r.mood).toBe('calm')
    expect(r.quadrant).toBe('unclear')
    expect(r.disclaimer).toBe(DISCLAIMER)
    expect(r.temperatureLabel).toBe('样本不足')
  })

  test('散户杀跌 + 汇金流入 = contrarian-bull 经典底部组合', () => {
    const etfs = [
      makeEtf({ name: '沪深300', dailyRatePct: -1, shareTrend: 'inflow' }),
      makeEtf({ name: '上证50', dailyRatePct: -1, shareTrend: 'inflow' }),
      makeEtf({ name: '中证500', dailyRatePct: -1, shareTrend: 'inflow' }),
      makeEtf({ name: '中证1000', dailyRatePct: -1, shareTrend: 'inflow' }),
    ]
    const r = judgeRetailSentiment(etfs)
    expect(r.mood).toBe('capitulating')
    expect(r.quadrant).toBe('contrarian-bull')
    expect(r.quadrantLabel).toContain('底部')
  })

  test('散户追涨 + 汇金持平 = contrarian-warn 拥挤警戒', () => {
    const etfs = [
      makeEtf({ name: '沪深300', dailyRatePct: 1, shareTrend: 'flat' }),
      makeEtf({ name: '上证50', dailyRatePct: 1, shareTrend: 'flat' }),
      makeEtf({ name: '中证500', dailyRatePct: 1, shareTrend: 'flat' }),
      makeEtf({ name: '中证1000', dailyRatePct: 1, shareTrend: 'flat' }),
    ]
    const r = judgeRetailSentiment(etfs)
    expect(r.mood).toBe('chasing')
    expect(r.quadrant).toBe('contrarian-warn')
  })

  test('汇金流入 + 散户也追涨 = 矛盾 unclear', () => {
    const etfs = [
      makeEtf({ name: '沪深300', dailyRatePct: 1, shareTrend: 'inflow' }),
      makeEtf({ name: '上证50', dailyRatePct: 1, shareTrend: 'inflow' }),
      makeEtf({ name: '中证500', dailyRatePct: 1, shareTrend: 'inflow' }),
      makeEtf({ name: '中证1000', dailyRatePct: 1, shareTrend: 'inflow' }),
    ]
    const r = judgeRetailSentiment(etfs)
    expect(r.mood).toBe('chasing')
    expect(r.quadrant).toBe('unclear')
  })

  test('平静市场 = calm 且 unclear', () => {
    const etfs = [makeEtf({ name: '沪深300', dailyRatePct: 0 })]
    const r = judgeRetailSentiment(etfs)
    expect(r.mood).toBe('calm')
    expect(r.quadrant).toBe('unclear')
  })

  test('无披露 ETF 进入 caution 而不参与其他资金合计', () => {
    const etfs = [
      makeEtf({ name: '沪深300', dailyRatePct: 0, withDisclosure: true }),
      makeEtf({ name: '科创50', dailyRatePct: 0, withDisclosure: false }),
    ]
    const r = judgeRetailSentiment(etfs)
    expect(r.etfs).toHaveLength(2)
    expect(r.etfs.find((e) => e.categoryName === '科创50')!.otherYi).toBeNull()
    expect(r.cautions.some((c) => c.includes('科创50'))).toBe(true)
    expect(r.otherTotalYi).not.toBeNull()
  })

  test('恒定 1% 日率下净申购率分位应为 100（追涨高温）', () => {
    const etfs = [makeEtf({ name: '沪深300', dailyRatePct: 1 })]
    const r = judgeRetailSentiment(etfs)
    const row = r.etfs[0]!
    expect(row.netSub5dPct).toBeCloseTo(5, 4)
    expect(row.netSubPercentile).toBe(100)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/utils/retailSignals.test.ts`
Expected: FAIL，报错 `Cannot find module './retailSignals'`

- [ ] **Step 3: 写实现**

```ts
/**
 * 散户情绪反向判定：净申购率 mood + 滚动分位温度 + 汇金方向交叉象限。
 * 纯函数，不识别持有人，反向解读只是假设检验叙事，不构成投资建议。
 */
import type { EtfSnapshot } from '../../shared/types'
import { collectForceInputs } from './forceVerdictCollect'
import { estimateRangeYi } from './estimateDisplay'
import { percentileRank } from './stats'
import {
  cumulativeNetSubRatePct,
  netSubscriptionRateSeries,
  otherCapitalSeries,
} from './retailMetrics'

/** 5 日累计净申购率 ≥ 此值（%）判定追涨量级；与 forceVerdict 的 5 日 2% 口径一致。 */
export const CHASE_PCT_5D = 2
/** 5 日累计净申购率 ≤ 负此值（%）判定杀跌量级。 */
export const CAPITULATE_PCT_5D = -2
/** 净申购率分位回看窗口（交易日）。 */
export const PERCENTILE_LOOKBACK = 250
/** 分位 ≥ 此值视为高热。 */
export const HOT_PERCENTILE = 85
/** 分位 ≤ 此值视为冰点。 */
export const COLD_PERCENTILE = 15

export const DISCLAIMER =
  '不能识别持有人 · 只描述申赎行为 · 反向解读仅是假设 · 不构成投资建议'

export type RetailMood = 'chasing' | 'capitulating' | 'calm'
export type CrossQuadrant =
  | 'contrarian-bull'
  | 'contrarian-warn'
  | 'aligned'
  | 'unclear'

export const MOOD_LABEL: Record<RetailMood, string> = {
  chasing: '追涨申购',
  capitulating: '杀跌赎回',
  calm: '平静',
}

export const QUADRANT_LABEL: Record<CrossQuadrant, string> = {
  'contrarian-bull': '对手盘吸纳 · 经典底部组合',
  'contrarian-warn': '拥挤追涨 · 警惕派发',
  aligned: '同向而行 · 无反向信息',
  unclear: '无法判断',
}

export interface MoodInput {
  categoryName: string
  netSub5dPct: number | null
}

/** 单只 mood：±2% 边界；null（样本不足）返回 null。 */
export function judgeMood(input: MoodInput): RetailMood | null {
  if (input.netSub5dPct == null) return null
  if (input.netSub5dPct >= CHASE_PCT_5D) return 'chasing'
  if (input.netSub5dPct <= CAPITULATE_PCT_5D) return 'capitulating'
  return 'calm'
}

/** 分位温度标签；null 表示样本不足。 */
export function temperatureLabel(percentile: number | null): string {
  if (percentile == null) return '样本不足'
  if (percentile >= HOT_PERCENTILE) return '高热'
  if (percentile >= 65) return '偏热'
  if (percentile <= COLD_PERCENTILE) return '冰点'
  if (percentile <= 35) return '偏冷'
  return '中性'
}

export interface RetailEtfRow {
  categoryName: string
  code: string
  hasHuijinDisclosure: boolean
  /** 5 日累计净申购率（%）。 */
  netSub5dPct: number | null
  /** 该 ETF 净申购率在 250 日回看内的分位（0-100）。 */
  netSubPercentile: number | null
  mood: RetailMood | null
  /** 最新其他资金份额（亿份）；无披露 ETF 为 null。 */
  otherYi: number | null
  /** 其他资金份额 5 日变化率（%）；anchored 段不足 6 点为 null。 */
  otherChangePct5d: number | null
}

export interface RetailVerdict {
  mood: RetailMood
  moodLabel: string
  /** 全体净申购率分位的中位数对应的温度标签。 */
  temperatureLabel: string
  /** 中位分位（0-100），供展示。 */
  temperaturePercentile: number | null
  quadrant: CrossQuadrant
  quadrantLabel: string
  detail: string
  etfs: RetailEtfRow[]
  /** 有披露 ETF 的其他资金份额合计（亿份）；全部无披露为 null。 */
  otherTotalYi: number | null
  /** 合计口径 5 日变化率（%）。 */
  otherTotalChangePct5d: number | null
  cautions: string[]
  disclaimer: string
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}

/** 汇金多数 tone：多数方向须严格大于其他两类。 */
function majorityHuijinTone(
  etfs: { shareTrend: 'inflow' | 'outflow' | 'flat' | null }[],
): 'inflow' | 'outflow' | 'flat' | null {
  let inflow = 0
  let outflow = 0
  let flat = 0
  for (const row of etfs) {
    if (row.shareTrend === 'inflow') inflow += 1
    else if (row.shareTrend === 'outflow') outflow += 1
    else if (row.shareTrend === 'flat') flat += 1
  }
  if (inflow > outflow && inflow > flat) return 'inflow'
  if (outflow > inflow && outflow > flat) return 'outflow'
  if (flat > inflow && flat > outflow) return 'flat'
  return null
}

/** mood 多数投票：chasing 与 capitulating 互斥，须严格过半。 */
function majorityMood(moods: (RetailMood | null)[]): RetailMood {
  const valid = moods.filter((m): m is RetailMood => m != null)
  if (valid.length === 0) return 'calm'
  const chasing = valid.filter((m) => m === 'chasing').length
  const capitulating = valid.filter((m) => m === 'capitulating').length
  if (chasing > valid.length / 2) return 'chasing'
  if (capitulating > valid.length / 2) return 'capitulating'
  return 'calm'
}

function crossQuadrant(
  mood: RetailMood,
  huijinTone: 'inflow' | 'outflow' | 'flat' | null,
  temperature: string,
): CrossQuadrant {
  if (mood === 'calm') return 'unclear'
  if (huijinTone === 'inflow') {
    if (mood === 'capitulating') return 'contrarian-bull'
    return 'unclear' // 汇金增持 + 散户也追涨：矛盾，无反向结论
  }
  if (huijinTone === 'outflow') {
    return mood === 'capitulating' ? 'aligned' : 'unclear'
  }
  // 汇金无方向（flat 或无多数）：散户情绪独立定案
  if (mood === 'chasing' && (temperature === '高热' || temperature === '偏热')) {
    return 'contrarian-warn'
  }
  if (mood === 'capitulating' && (temperature === '冰点' || temperature === '偏冷')) {
    return 'contrarian-bull'
  }
  return 'unclear'
}

function quadrantDetail(
  quadrant: CrossQuadrant,
  mood: RetailMood,
  huijinTone: 'inflow' | 'outflow' | 'flat' | null,
  temperature: string,
): string {
  const toneText =
    huijinTone === 'inflow' ? '汇金估算份额流入' : huijinTone === 'outflow' ? '汇金估算份额流出' : '汇金估算份额无多数方向'
  const moodText =
    mood === 'chasing' ? '宽基 ETF 边际资金持续净申购' : mood === 'capitulating' ? '宽基 ETF 边际资金持续净赎回' : '边际资金申赎平衡'
  const base = `${moodText}（温度${temperature}），${toneText}`
  switch (quadrant) {
    case 'contrarian-bull':
      return `${base}；反向解读：耐心钱在接情绪钱交出的筹码，历史底部常见组合。`
    case 'contrarian-warn':
      return `${base}；反向解读：增量以情绪钱为主，高位放量需警惕派发。`
    case 'aligned':
      return `${base}；两边同向，不提供对手盘信息。`
    default:
      return `${base}；信号互相矛盾或量级不足，不下反向结论。`
  }
}

/** 主入口：从看板快照生成散户情绪反向判决。 */
export function judgeRetailSentiment(etfs: EtfSnapshot[]): RetailVerdict {
  const cautions: string[] = []
  const rows: RetailEtfRow[] = []
  const disclosedOthers: { name: string; last: number | null; base: number | null }[] = []

  for (const etf of etfs) {
    const rates = netSubscriptionRateSeries(etf.scaleHistory)
    const netSub5dPct = cumulativeNetSubRatePct(rates, 5)
    const currentRate = rates.at(-1)?.ratePct
    const history = rates
      .slice(-(PERCENTILE_LOOKBACK + 1), -1)
      .map((r) => r.ratePct)
      .filter((v): v is number => v != null)
    const netSubPercentile =
      currentRate != null && history.length > 0
        ? percentileRank(currentRate, history)
        : null

    const others = otherCapitalSeries(etf)
    const lastOther = [...others].reverse().find((p) => p.otherYi != null)
    let otherChangePct5d: number | null = null
    if (lastOther) {
      const idx = others.findIndex((p) => p.date === lastOther.date)
      const basePoint = idx >= 5 ? others[idx - 5] : null
      if (basePoint?.otherYi != null && basePoint.otherYi > 0) {
        otherChangePct5d = Number(
          (((lastOther.otherYi! / basePoint.otherYi) - 1) * 100).toFixed(2),
        )
      }
    }

    const hasDisclosure = etf.latestHuijin != null
    if (!hasDisclosure) {
      cautions.push(`${etf.categoryName} 无汇金披露，仅总份额口径参与申赎判定，无法拆分其他资金`)
    }
    const lastAnchored = [...etf.huijinEstimateHistory]
      .reverse()
      .find((p) => p.estimateMethod === 'anchored')
    if (estimateRangeYi(lastAnchored)?.lowResolution) {
      cautions.push(`${etf.categoryName} 估算区间过宽，其他资金份额点估计不可依赖`)
    }

    disclosedOthers.push({
      name: etf.categoryName,
      last: lastOther?.otherYi ?? null,
      base: null,
    })

    rows.push({
      categoryName: etf.categoryName,
      code: etf.code,
      hasHuijinDisclosure: hasDisclosure,
      netSub5dPct,
      netSubPercentile,
      mood: judgeMood({ categoryName: etf.categoryName, netSub5dPct }),
      otherYi: lastOther?.otherYi ?? null,
      otherChangePct5d,
    })
  }

  // 其他资金合计：用有披露 ETF 的最近公共口径求和（各自的最新值日期可能不同，
  // 合计仅作规模量级展示，5 日变化按合计前推 5 个有值点计算）
  const sumRows = rows.filter((r) => r.otherYi != null)
  const otherTotalYi =
    sumRows.length > 0
      ? Number(sumRows.reduce((s, r) => s + r.otherYi!, 0).toFixed(2))
      : null
  let otherTotalChangePct5d: number | null = null
  if (sumRows.length > 0 && rows.every((r) => r.otherChangePct5d != null || !r.otherYi)) {
    const changes = sumRows.map((r) => r.otherChangePct5d!)
    if (changes.length === sumRows.length && changes.length > 0) {
      // 合计变化率 ≈ 各成分变化率的份额加权平均
      const weightSum = sumRows.reduce((s, r) => s + r.otherYi!, 0)
      otherTotalChangePct5d = Number(
        (
          (sumRows.reduce((s, r) => s + r.otherYi! * r.otherChangePct5d!, 0) /
            weightSum) as number
        ).toFixed(2),
      )
    }
  }

  const mood = majorityMood(rows.map((r) => r.mood))
  const tempPercentile = median(
    rows.map((r) => r.netSubPercentile).filter((v): v is number => v != null),
  )
  const temperature = temperatureLabel(tempPercentile)
  const huijinTone = majorityHuijinTone(
    collectForceInputs(etfs, []).etfs.map((e) => e.shareTrend),
  )
  const quadrant = crossQuadrant(mood, huijinTone, temperature)
  cautions.push('非汇金资金含机构、游资与散户，散户只是主要成分之一，不是全部')

  return {
    mood,
    moodLabel: MOOD_LABEL[mood],
    temperatureLabel: temperature,
    temperaturePercentile: tempPercentile,
    quadrant,
    quadrantLabel: QUADRANT_LABEL[quadrant],
    detail: quadrantDetail(quadrant, mood, huijinTone, temperature),
    etfs: rows,
    otherTotalYi,
    otherTotalChangePct5d,
    cautions,
    disclaimer: DISCLAIMER,
  }
}
```

注意：`collectForceInputs(etfs, [])` 第二参数传空市场序列即可——`toForceEtf` 只读 ETF 自身字段，market 部分不影响 shareTrend 提取。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/utils/retailSignals.test.ts`
Expected: PASS

若 `makeEtf` 构造的 snapshot 因类型不符编译失败，优先修 test fixture 的类型断言，不改 shared/types.ts。

- [ ] **Step 5: 跑全量测试防回归**

Run: `bun test`
Expected: 全部 PASS（含现有 forceVerdict / forceBriefing 等）

- [ ] **Step 6: Commit**

```bash
git add src/utils/retailSignals.ts src/utils/retailSignals.test.ts
git commit -m "feat(retail): 新增情绪判定与汇金交叉象限"
```

---

### Task 3: RetailPanel.vue 面板 + 挂载

**Files:**
- Create: `src/components/RetailPanel.vue`
- Modify: `src/App.vue`（约 220-224 行 ForceVerdictPanel 之后）
- Modify: `src/styles/main.css`（文件末尾追加）

- [ ] **Step 1: 写 RetailPanel.vue**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot } from '../../shared/types'
import { judgeRetailSentiment } from '../utils/retailSignals'

const props = withDefaults(
  defineProps<{
    etfs?: EtfSnapshot[]
  }>(),
  { etfs: () => [] },
)

const verdict = computed(() => judgeRetailSentiment(props.etfs))

const temperatureText = computed(() => {
  const v = verdict.value
  return v.temperaturePercentile == null
    ? v.temperatureLabel
    : `${v.temperatureLabel} · ${v.temperaturePercentile.toFixed(0)} 分位`
})

const otherTotalText = computed(() => {
  const v = verdict.value
  if (v.otherTotalYi == null) return '—'
  const change =
    v.otherTotalChangePct5d == null
      ? ''
      : `（5 日 ${v.otherTotalChangePct5d > 0 ? '+' : ''}${v.otherTotalChangePct5d.toFixed(2)}%）`
  return `${v.otherTotalYi.toFixed(1)} 亿份${change}`
})

/** 逐只明细行：mood 着色数据属性。 */
const rows = computed(() =>
  verdict.value.etfs.map((row) => ({
    ...row,
    netSub5dText: row.netSub5dPct == null ? '—' : `${row.netSub5dPct > 0 ? '+' : ''}${row.netSub5dPct.toFixed(2)}%`,
    percentileText: row.netSubPercentile == null ? '—' : row.netSubPercentile.toFixed(0),
    otherText: row.otherYi == null ? '无披露' : `${row.otherYi.toFixed(1)} 亿份`,
  })),
)
</script>

<template>
  <section class="card panel retail" aria-labelledby="retail-title">
    <div class="panel-head">
      <div>
        <h2 id="retail-title">散户情绪反向</h2>
        <p class="muted">
          宽基 ETF 边际申赎作非汇金资金情绪代理；净申购率 5 日累计与 250 日分位，再与汇金方向交叉
        </p>
      </div>
      <span class="pill">描述性结论</span>
    </div>

    <div class="force-verdict-grid retail-grid">
      <div class="force-verdict-primary" :data-quadrant="verdict.quadrant" role="status">
        <div class="insight-label">反向象限</div>
        <div class="insight-value">{{ verdict.quadrantLabel }}</div>
        <div class="insight-detail muted">{{ verdict.detail }}</div>
      </div>
      <div class="force-verdict-gate" :data-mood="verdict.mood">
        <div class="insight-label">情绪方向</div>
        <div class="insight-value">{{ verdict.moodLabel }}</div>
        <div class="insight-detail muted">六只宽基 5 日净申购率多数投票</div>
      </div>
      <div class="force-verdict-gate" :data-hot="verdict.temperatureLabel">
        <div class="insight-label">申赎温度</div>
        <div class="insight-value">{{ temperatureText }}</div>
        <div class="insight-detail muted">净申购率中位分位（250 日回看）</div>
      </div>
      <div class="force-verdict-gate">
        <div class="insight-label">其他资金存量</div>
        <div class="insight-value">{{ otherTotalText }}</div>
        <div class="insight-detail muted">总份额 − 汇金估算，有披露的 ETF 合计</div>
      </div>
    </div>

    <table class="retail-table">
      <thead>
        <tr>
          <th>类别</th>
          <th>5 日净申购率</th>
          <th>分位</th>
          <th>情绪</th>
          <th>其他资金份额</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.code">
          <td>{{ row.categoryName }}</td>
          <td>{{ row.netSub5dText }}</td>
          <td>{{ row.percentileText }}</td>
          <td :data-mood="row.mood">{{ row.mood ?? '—' }}</td>
          <td>{{ row.otherText }}</td>
        </tr>
      </tbody>
    </table>

    <p v-for="line in verdict.cautions" :key="line" class="insight-detail caution">
      {{ line }}
    </p>
    <p class="muted insight-disclaimer">{{ verdict.disclaimer }}</p>
  </section>
</template>
```

- [ ] **Step 2: 追加样式到 `src/styles/main.css` 末尾**

```css
/* 散户情绪反向面板：闸格复用 force-verdict 布局，仅加状态色 */
.retail-grid .force-verdict-primary[data-quadrant='contrarian-bull'] .insight-value {
  color: var(--accent-2);
}

.retail-grid .force-verdict-primary[data-quadrant='contrarian-warn'] .insight-value {
  color: var(--tier-other);
}

.retail-grid .force-verdict-gate[data-mood='chasing'] .insight-value {
  color: var(--up);
}

.retail-grid .force-verdict-gate[data-mood='capitulating'] .insight-value {
  color: var(--accent-2);
}

.retail-grid .force-verdict-gate[data-hot='高热'] .insight-value,
.retail-grid .force-verdict-gate[data-hot='偏热'] .insight-value {
  color: var(--up);
}

.retail-grid .force-verdict-gate[data-hot='冰点'] .insight-value,
.retail-grid .force-verdict-gate[data-hot='偏冷'] .insight-value {
  color: var(--accent-2);
}

.retail-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin: 4px 0 10px;
}

.retail-table th,
.retail-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  text-align: right;
}

.retail-table th:first-child,
.retail-table td:first-child {
  text-align: left;
}

.retail-table td[data-mood='chasing'] {
  color: var(--up);
}

.retail-table td[data-mood='capitulating'] {
  color: var(--accent-2);
}
```

注意：着色变量先核对 `src/styles/main.css` 顶部 `:root` 中 `--up` / `--accent-2` / `--tier-other` 是否存在（force-verdict 已用同名变量，应当存在；若缺则复用 force-verdict 用到的现值）。

- [ ] **Step 3: App.vue 挂载**

在 `src/App.vue` 中：

3a. import 区（ForceVerdictPanel 之后）加：

```ts
import RetailPanel from './components/RetailPanel.vue'
```

3b. 模板中 `<ForceVerdictPanel ... />`（约 220-224 行）之后加：

```html
        <RetailPanel v-if="data" :etfs="etfs" />
```

- [ ] **Step 4: 类型检查与构建**

Run: `bun run build`
Expected: vue-tsc 与 vite build 成功，无类型错误

- [ ] **Step 5: 手动验证**

Run: `bun run dev`（或 `bun run dev:vite` 复用已有 data）
打开看板，确认：
- ForceVerdictPanel 下方出现「散户情绪反向」面板
- 四格与明细表渲染六只 ETF
- 科创50 行「其他资金份额」列显示「无披露」，cautions 含对应提示
- 控制台无报错

- [ ] **Step 6: Commit**

```bash
git add src/components/RetailPanel.vue src/App.vue src/styles/main.css
git commit -m "feat(retail): 看板新增散户情绪反向面板"
```

---

### Task 4: 真实快照 smoke + README 更新

**Files:**
- Modify: `README.md`（监控范围/面板说明处）

- [ ] **Step 1: 用真实 dashboard.json 跑 smoke**

```bash
bun -e "
const { judgeRetailSentiment } = await import('./src/utils/retailSignals.ts');
const d = await Bun.file('data/dashboard.json').json();
const r = judgeRetailSentiment(d.etfs);
console.log('mood:', r.mood, '| temp:', r.temperatureLabel, r.temperaturePercentile);
console.log('quadrant:', r.quadrant, '|', r.quadrantLabel);
console.log('otherTotal:', r.otherTotalYi, '亿份');
for (const row of r.etfs) {
  console.log(row.categoryName.padEnd(6), '5日', row.netSub5dPct, '分位', row.netSubPercentile, 'mood', row.mood, 'other', row.otherYi);
}
console.log('cautions:', r.cautions.length);
"
```

Expected: 六行明细全部打印；科创50 `other` 为 null；无异常抛出。检查输出合理性：
- 分位值在 0-100
- mood 与最近行情方向直觉不矛盾（如近期份额缩则多为负值）

若抛错（如字段名不符），回到对应 Task 修类型，不带病推进。

- [ ] **Step 2: README 更新**

在 `README.md` 的面板/功能描述段落（「监控范围」表之后或快速开始之前的适当位置）加：

```markdown
## 散户情绪反向面板

用六大宽基 ETF 的**总份额净申购率**（交易所日频净变化 / 前一日总份额）作为非汇金资金的申赎情绪代理：

- **情绪方向**：各 ETF 5 日累计净申购率 ±2% 多数投票（追涨 / 杀跌 / 平静）
- **申赎温度**：最新日净申购率在 250 日回看内的分位中位数（≥85 高热、≤15 冰点）
- **其他资金存量**：总份额 − 汇金估算点估计，仅对有披露的 ETF 展示
- **反向象限**：情绪方向 × 汇金估算份额多数方向交叉（对手盘吸纳 / 拥挤追涨 / 同向 / 无法判断）

> 「非汇金资金」含机构、游资与散户，散户只是主要成分之一。反向解读是描述性叙事，
> 不是因果预测，不构成投资建议。科创50 无汇金披露，仅参与总份额口径。
```

- [ ] **Step 3: 全量验证**

Run: `bun test && bun run build`
Expected: 全部测试 PASS，构建成功

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(retail): 补充散户情绪反向面板口径说明"
```

---

## Self-Review 结论

1. **覆盖检查**：上一轮方案的优先级 1（份额差分面板）→ Task 1（其他资金份额）+ Task 2（净申购率判定与交叉）+ Task 3（UI）。换手率入库、两融数据源属优先级 2/3，本计划不含（YAGNI，另开计划）。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
3. **类型一致性**：`OtherCapitalPoint`/`NetSubRatePoint` 在 Task 1 定义、Task 2 消费；`judgeMood` 签名 Task 2 内自洽；`collectForceInputs(etfs, [])` 第二参为空数组时 `toForceEtf` 不受影响（已核实其实现只读 ETF 字段）。
