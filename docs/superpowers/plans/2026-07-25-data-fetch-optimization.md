# 数据获取优化 + 占比区间估算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拆分 fetch-data.ts 为独立模块，日频份额回填到 2024-01-01，实现占比区间估算口径，新增抓取完整性报告。

**Architecture:** 编排层 `fetch-data.ts` 只做流程控制；`sources/` 按数据源拆分（http/eastmoney/sse/szse/sina）；`lib/` 放纯逻辑（estimate/merge/report）。占比区间估算在 `lib/estimate.ts` 中实现，下界逐日累加净份额变化，上界占比不变，展示值取加权。

**Tech Stack:** Bun + TypeScript，bun:test 单元测试，无新依赖。

**Spec:** `docs/superpowers/specs/2026-07-25-data-fetch-optimization-design.md`

---

## Task 1: 提取 `scripts/sources/http.ts`

**Files:**
- Create: `scripts/sources/http.ts`
- Modify: `scripts/fetch-data.ts`（删除搬走的代码，改为 import）

- [ ] **Step 1: 创建 `scripts/sources/http.ts`**

```ts
/**
 * 共享 HTTP 基础设施：重试、编码检测、JSONP 剥离。
 */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function fetchText(
  url: string,
  referer = 'https://finance.sina.com.cn/',
  retries = 5,
): Promise<string> {
  let lastErr: unknown
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: referer,
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
      const buf = await res.arrayBuffer()
      const bytes = new Uint8Array(buf)
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return new TextDecoder('gbk').decode(bytes)
      }
    } catch (e) {
      lastErr = e
      await sleep(400 * 2 ** i)
    }
  }
  throw lastErr
}

export async function fetchJson<T = unknown>(
  url: string,
  referer?: string,
): Promise<T> {
  const text = await fetchText(url, referer)
  const m = text.match(/^[a-zA-Z_$][\w$]*\(([\s\S]*)\)\s*;?\s*$/)
  const body = m ? m[1] : text
  return JSON.parse(body) as T
}
```

- [ ] **Step 2: 修改 `scripts/fetch-data.ts` 头部**

删除第 28-106 行（`UA`、`sleep`、`fetchText`、`fetchJson` 定义），替换为：

```ts
import { UA, sleep, fetchText, fetchJson } from './sources/http'
```

保留 `ROOT`、`DATA_DIR`、`OUT_FILE` 常量（它们属于编排层）。

- [ ] **Step 3: 验证编译**

Run: `cd D:/code/hj && bun -e "import './scripts/sources/http.ts'; console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add scripts/sources/http.ts scripts/fetch-data.ts
git commit -m "refactor: extract sources/http.ts from fetch-data"
```

---

## Task 2: 提取 `scripts/sources/eastmoney.ts`

**Files:**
- Create: `scripts/sources/eastmoney.ts`
- Modify: `scripts/fetch-data.ts`

- [ ] **Step 1: 创建 `scripts/sources/eastmoney.ts`**

从 `fetch-data.ts` 搬移以下内容（原行号参考拆分前文件）：

- `PushDiff`、`PushPageResponse` 接口
- `ETF_PAGE_SIZE`、`ETF_QUOTE_HOSTS` 常量
- `fetchEtfUniversePage`、`fetchEtfUniverse`、`fetchQuotesByCandidates`、`pickLargestPerCategory`
- `MarketKlineResponse`、`MarketBar` 接口
- `fetchMarketBars`、`fetchMarketActiveCapHistory`
- `parseNumberYi`（仅 `fetchScaleHistory` 使用，留在本模块）
- `fetchScaleHistory`、`fetchNavHistory`

文件头部：

```ts
/**
 * 东方财富数据源：ETF 行情、定期规模、历史净值、0AMV 市场日线。
 */
import { fetchJson, fetchText, sleep } from './http'
import { CATEGORIES, matchCategory } from '../../shared/categories'
import type { EtfQuote, MarketActiveCapPoint, NavPoint, ScalePoint } from '../../shared/types'
```

所有函数加 `export`。`pickLargestPerCategory` 内部调用 `fetchScaleHistory`，两者在同一模块内，无需额外 import。

- [ ] **Step 2: 修改 `scripts/fetch-data.ts`**

删除搬走的代码，添加 import：

```ts
import {
  fetchEtfUniverse,
  fetchMarketActiveCapHistory,
  fetchNavHistory,
  fetchScaleHistory,
  pickLargestPerCategory,
} from './sources/eastmoney'
```

- [ ] **Step 3: 验证编译**

Run: `cd D:/code/hj && bun -e "import './scripts/sources/eastmoney.ts'; console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add scripts/sources/eastmoney.ts scripts/fetch-data.ts
git commit -m "refactor: extract sources/eastmoney.ts from fetch-data"
```

---

## Task 3: 提取 `scripts/sources/sse.ts` 和 `scripts/sources/szse.ts`

**Files:**
- Create: `scripts/sources/sse.ts`
- Create: `scripts/sources/szse.ts`
- Modify: `scripts/fetch-data.ts`

- [ ] **Step 1: 创建 `scripts/sources/sse.ts`**

从 `fetch-data.ts` 搬移：`SseScaleResponse` 接口、`fetchSseDailyShares` 函数。

```ts
/**
 * 上交所 ETF 日频总份额（逐日查询，3 日并发）。
 */
import { fetchJson, sleep } from './http'

export interface OfficialDailySharePoint {
  date: string
  totalSharesYi: number
  shareSource: 'sse' | 'szse'
}

interface SseScaleResponse {
  result?: Array<{
    STAT_DATE?: string
    SEC_CODE?: string
    TOT_VOL?: string | number
  }>
}

export async function fetchSseDailyShares(
  codes: string[],
  dates: string[],
): Promise<{ points: Map<string, OfficialDailySharePoint[]>; failedDates: string[] }> {
  // ... 原 fetch-data.ts 中 fetchSseDailyShares 的完整实现，逐字搬移
}
```

注意：`OfficialDailySharePoint` 接口在 sse.ts 中定义并从 sse.ts 导出（szse.ts 和 fetch-data.ts 都从 sse.ts import 它）。

- [ ] **Step 2: 创建 `scripts/sources/szse.ts`**

从 `fetch-data.ts` 搬移：`SzseScaleRow`、`SzseScaleResponse` 接口、`splitDateRanges`、`normalizeSzseRows`、`fetchSzseDailyShares`。

```ts
/**
 * 深交所 ETF 日频总份额（按区间 + 分页查询）。
 */
import { fetchJson, sleep } from './http'
import type { OfficialDailySharePoint } from './sse'

// ... 原 fetch-data.ts 中相关代码逐字搬移，所有函数加 export
```

- [ ] **Step 3: 修改 `scripts/fetch-data.ts`**

删除搬走的代码（`OfficialDailySharePoint` 接口、SSE/SZSE 相关接口和函数），添加：

```ts
import { fetchSseDailyShares, type OfficialDailySharePoint } from './sources/sse'
import { fetchSzseDailyShares } from './sources/szse'
```

- [ ] **Step 4: 验证编译**

Run: `cd D:/code/hj && bun -e "import './scripts/sources/sse.ts'; import './scripts/sources/szse.ts'; console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add scripts/sources/sse.ts scripts/sources/szse.ts scripts/fetch-data.ts
git commit -m "refactor: extract sources/sse.ts and sources/szse.ts from fetch-data"
```

---

## Task 4: 提取 `scripts/sources/sina.ts` 和 `scripts/lib/merge.ts`

**Files:**
- Create: `scripts/sources/sina.ts`
- Create: `scripts/lib/merge.ts`
- Modify: `scripts/fetch-data.ts`

- [ ] **Step 1: 创建 `scripts/sources/sina.ts`**

从 `fetch-data.ts` 搬移：`SinaHolder`、`SinaDate` 接口、`fetchHolderDates`、`fetchHoldersOnDate`、`fetchAllHolderReports`。

```ts
/**
 * 新浪财经十大持有人报告。
 */
import { fetchJson, sleep } from './http'
import { isHuijinHolder } from '../../shared/categories'
import type { HolderReport, HolderRow } from '../../shared/types'

// ... 原代码逐字搬移，所有函数加 export
```

- [ ] **Step 2: 创建 `scripts/lib/merge.ts`**

从 `fetch-data.ts` 搬移：`nearestNav`、`mergeScaleHistory`、`buildHuijinHistory`、`dedupeHolderReports`。

注意：`parseNumberYi` 只被 `eastmoney.ts` 的 `fetchScaleHistory` 使用，留在 `eastmoney.ts` 中，不放入 merge.ts。

```ts
/**
 * 纯数据合并逻辑：规模历史合并、汇金披露历史构建、持有人去重、净值匹配。
 */
import type { HolderReport, HuijinPosition, NavPoint, ScalePoint } from '../../shared/types'
import type { OfficialDailySharePoint } from '../sources/sse'

export function nearestNav(navs: NavPoint[], date: string): number | null { /* 原实现 */ }
export function mergeScaleHistory(periodic: ScalePoint[], official: OfficialDailySharePoint[], navs: NavPoint[]): ScalePoint[] { /* 原实现 */ }
export function buildHuijinHistory(reports: HolderReport[], navs: NavPoint[]): HuijinPosition[] { /* 原实现 */ }
export function dedupeHolderReports(reports: HolderReport[]): HolderReport[] { /* 原实现 */ }
```

- [ ] **Step 3: 修改 `scripts/fetch-data.ts`**

删除搬走的代码，添加：

```ts
import { fetchAllHolderReports } from './sources/sina'
import { buildHuijinHistory, dedupeHolderReports, mergeScaleHistory, nearestNav } from './lib/merge'
```

- [ ] **Step 4: 验证编译**

Run: `cd D:/code/hj && bun -e "import './scripts/sources/sina.ts'; import './scripts/lib/merge.ts'; console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add scripts/sources/sina.ts scripts/lib/merge.ts scripts/fetch-data.ts
git commit -m "refactor: extract sources/sina.ts and lib/merge.ts from fetch-data"
```

---

## Task 5: 提取 `scripts/lib/estimate.ts` + 瘦身编排层 + 验证

**Files:**
- Create: `scripts/lib/estimate.ts`
- Modify: `scripts/fetch-data.ts`（最终瘦身）

- [ ] **Step 1: 创建 `scripts/lib/estimate.ts`（原样搬移）**

将 `fetch-data.ts` 中的 `buildHuijinEstimate` 函数原样搬入（含 `HuijinEstimate` 类型别名、`computeTrendSignals` 调用）：

```ts
/**
 * 汇金持仓估算（当前为份额锚定法，Task 7 将重写为占比区间）。
 */
import type { EtfSnapshot, HolderReport, NavPoint, ScalePoint } from '../../shared/types'
import { computeTrendSignals } from '../../shared/estimate-signals'
import { nearestNav } from './merge'

type HuijinEstimate = EtfSnapshot['huijinEstimateHistory'][number]

export function buildHuijinEstimate(
  scale: ScalePoint[],
  reports: HolderReport[],
  navs: NavPoint[],
): HuijinEstimate[] {
  // ... 原 fetch-data.ts 中 buildHuijinEstimate 的完整实现，逐字搬移
}
```

- [ ] **Step 2: 瘦身 `scripts/fetch-data.ts`**

删除 `buildHuijinEstimate` 及 `type HuijinEstimate`，添加：

```ts
import { buildHuijinEstimate } from './lib/estimate'
```

此时 `fetch-data.ts` 应只剩：imports、`ROOT/DATA_DIR/OUT_FILE` 常量、`loadPreviousDashboard`、`officialPointsFromSnapshot`、`mergeOfficialPoints`、`fallbackWeekdays`、`fetchOfficialShareHistories`、`buildEtfSnapshot`、`main`。约 250-300 行。

- [ ] **Step 3: 验证现有测试通过**

Run: `cd D:/code/hj && bun test`
Expected: 所有测试 PASS（backfill-window.test.ts + estimate-signals.test.ts）

- [ ] **Step 4: 验证抓取行为不变**

Run: `cd D:/code/hj && bun run fetch`
Expected: 成功输出 `✓ 已写入`，无新增错误。

- [ ] **Step 5: 验证审计通过**

Run: `cd D:/code/hj && bun run audit`
Expected: `errors: []`（warnings 可接受）。

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/estimate.ts scripts/fetch-data.ts
git commit -m "refactor: extract lib/estimate.ts, fetch-data.ts is now orchestration-only"
```

---

## Task 6: 类型变更 — 删除 clamp、新增 floor/ceil

**Files:**
- Modify: `shared/types.ts:85-113`（`HuijinEstimatePoint`）
- Modify: `shared/estimate-signals.ts`（删 clamp 分支）
- Modify: `scripts/estimate-signals.test.ts`（删 clamp 用例）

- [ ] **Step 1: 修改 `shared/types.ts` 的 `HuijinEstimatePoint`**

删除：
```ts
  clampTriggered?: boolean
  clampReliability?: 'just_triggered' | 'persistent' | 'persistent_recovering'
```

新增（在 `unavailableReason` 之后、`shareTrend` 之前）：
```ts
  /** 占比区间下界（份额变动全归因汇金，悲观侧），亿份。仅 anchored 点。 */
  huijinSharesFloor?: number | null
  /** 占比区间上界（汇金占比不变，被动稀释，乐观侧），亿份。仅 anchored 点。 */
  huijinSharesCeil?: number | null
```

- [ ] **Step 2: 修改 `shared/estimate-signals.ts`**

`SignalInput` 删除 `clampTriggered?: boolean`。
`SignalOutput` 删除 `clampReliability?: ...`。
`computeTrendSignals` 函数体删除 clamp 相关分支（第 48-59 行的 `clampReliability` 计算），`out.push` 中删除 `clampReliability`。

修改后的 `SignalOutput`：
```ts
export interface SignalOutput {
  shareTrend: 'inflow' | 'outflow' | 'flat'
  consecutiveDays: number
  shareChangePct5d: number | null
}
```

修改后的 `computeTrendSignals` 末尾：
```ts
    out.push({ shareTrend, consecutiveDays, shareChangePct5d })
```

- [ ] **Step 3: 修改 `scripts/estimate-signals.test.ts`**

删除 `point` 辅助函数的 `clamp` 参数和 `clampTriggered` 字段：
```ts
function point(date: string, total: number, netSub: number | null): SignalInput {
  return { date, totalSharesYi: total, netSubscriptionYi: netSub }
}
```

删除最后两个 clamp 测试（`clampReliability：刚触发...` 和 `未 clamp 时...`）。

更新所有 `point(...)` 调用，去掉第四个参数。

- [ ] **Step 4: 运行测试验证**

Run: `cd D:/code/hj && bun test`
Expected: 所有测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts shared/estimate-signals.ts scripts/estimate-signals.test.ts
git commit -m "refactor: remove clamp fields, add floor/ceil to HuijinEstimatePoint"
```

---

## Task 7: 重写 `scripts/lib/estimate.ts` 为占比区间口径（TDD）

**Files:**
- Create: `scripts/lib/estimate.test.ts`
- Modify: `scripts/lib/estimate.ts`

- [ ] **Step 1: 编写失败测试 `scripts/lib/estimate.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { buildHuijinEstimate, FLOOR_WEIGHT, CEIL_WEIGHT } from './estimate'
import type { HolderReport, NavPoint, ScalePoint } from '../../shared/types'

function dailyPoint(date: string, totalSharesYi: number, netSub: number | null): ScalePoint {
  return {
    date, totalSharesYi,
    netAssetYi: totalSharesYi * 1.5,
    purchaseYi: null, redeemYi: null,
    netSubscriptionYi: netSub,
    netAssetChangePct: null,
    frequency: 'daily', shareSource: 'sse', netAssetEstimated: true,
  }
}

function navPt(date: string, value: number): NavPoint {
  return { date, nav: value, accNav: value, changePct: null }
}

function anchorReport(shares: number, percent: number): HolderReport {
  return {
    reportDate: '2025-12-31',
    holders: [{ name: '中央汇金投资有限责任公司', shares, percent, isHuijin: true }],
    huijinShares: shares,
    huijinPercent: percent,
  }
}

test('披露日标记 disclosed，不生成区间', () => {
  const scale = [dailyPoint('2025-12-31', 200, null)]
  const result = buildHuijinEstimate(scale, [anchorReport(100e8, 50)], [navPt('2025-12-31', 1.5)])
  expect(result[0]!.estimateMethod).toBe('disclosed')
  expect(result[0]!.huijinShares).toBe(100e8)
  expect(result[0]!.huijinSharesFloor).toBeUndefined()
})

test('anchored 点生成 floor/ceil 区间并累加', () => {
  const scale = [
    dailyPoint('2025-12-31', 200, null),
    dailyPoint('2026-01-02', 190, -10),
    dailyPoint('2026-01-03', 195, 5),
  ]
  const navs = [navPt('2025-12-31', 1.5), navPt('2026-01-02', 1.5), navPt('2026-01-03', 1.5)]
  const result = buildHuijinEstimate(scale, [anchorReport(100e8, 50)], navs)

  const p1 = result[1]!
  expect(p1.estimateMethod).toBe('anchored')
  expect(p1.isEstimated).toBe(true)
  // floor = clamp(100 + (-10), 0, 190) = 90
  expect(p1.huijinSharesFloor).toBeCloseTo(90, 4)
  // ceil = 190 × 50% = 95
  expect(p1.huijinSharesCeil).toBeCloseTo(95, 4)
  // 展示值 = 90*2/3 + 95*1/3 ≈ 91.667 亿份 → 份
  expect(p1.huijinShares).toBe(Math.round((90 * FLOOR_WEIGHT + 95 * CEIL_WEIGHT) * 1e8))
  // huijinValueYi = weightedYi × nav
  expect(p1.huijinValueYi).toBeCloseTo((90 * FLOOR_WEIGHT + 95 * CEIL_WEIGHT) * 1.5, 3)

  const p2 = result[2]!
  // floor = clamp(90 + 5, 0, 195) = 95
  expect(p2.huijinSharesFloor).toBeCloseTo(95, 4)
  // ceil = 195 × 50% = 97.5
  expect(p2.huijinSharesCeil).toBeCloseTo(97.5, 4)
})

test('floor 不为负', () => {
  const scale = [
    dailyPoint('2025-12-31', 100, null),
    dailyPoint('2026-01-02', 50, -60),
  ]
  const navs = [navPt('2025-12-31', 1), navPt('2026-01-02', 1)]
  const result = buildHuijinEstimate(scale, [anchorReport(10e8, 10)], navs)
  // floor = clamp(10 + (-60), 0, 50) = 0
  expect(result[1]!.huijinSharesFloor).toBe(0)
})

test('floor 不超过当日总份额', () => {
  const scale = [
    dailyPoint('2025-12-31', 100, null),
    dailyPoint('2026-01-02', 60, -10),
  ]
  const navs = [navPt('2025-12-31', 1), navPt('2026-01-02', 1)]
  const result = buildHuijinEstimate(scale, [anchorReport(80e8, 80)], navs)
  // floor = clamp(80 + (-10), 0, 60) = 60（被总份额截断）
  expect(result[1]!.huijinSharesFloor).toBeCloseTo(60, 4)
})

test('无锚点时全部 unavailable', () => {
  const reports: HolderReport[] = [{
    reportDate: '2025-12-31',
    holders: [{ name: '张三', shares: 100e8, percent: 50, isHuijin: false }],
    huijinShares: 0, huijinPercent: 0,
  }]
  const scale = [dailyPoint('2026-01-02', 100, 1)]
  const result = buildHuijinEstimate(scale, reports, [])
  expect(result[0]!.estimateMethod).toBe('unavailable')
  expect(result[0]!.huijinShares).toBeNull()
})

test('锚点日之前非披露点为 unavailable', () => {
  const scale = [
    dailyPoint('2025-06-30', 200, null),
    dailyPoint('2025-12-31', 200, 0),
  ]
  const result = buildHuijinEstimate(scale, [anchorReport(100e8, 50)], [navPt('2025-12-31', 1.5)])
  expect(result[0]!.estimateMethod).toBe('unavailable')
  expect(result[1]!.estimateMethod).toBe('disclosed')
})

test('anchored 点携带趋势信号', () => {
  const scale = [
    dailyPoint('2025-12-31', 200, null),
    dailyPoint('2026-01-02', 201, 1),
    dailyPoint('2026-01-03', 202, 1),
  ]
  const navs = [navPt('2025-12-31', 1), navPt('2026-01-02', 1), navPt('2026-01-03', 1)]
  const result = buildHuijinEstimate(scale, [anchorReport(100e8, 50)], navs)
  expect(result[1]!.shareTrend).toBe('inflow')
  expect(result[1]!.consecutiveDays).toBe(1)
  expect(result[2]!.consecutiveDays).toBe(2)
})

test('非 daily 点在锚点之后为 unavailable', () => {
  const periodic: ScalePoint = {
    date: '2026-03-31', totalSharesYi: 180, netAssetYi: 270,
    purchaseYi: null, redeemYi: null, netSubscriptionYi: null,
    netAssetChangePct: null, frequency: 'periodic', shareSource: 'eastmoney', netAssetEstimated: false,
  }
  const scale = [dailyPoint('2025-12-31', 200, null), periodic]
  const result = buildHuijinEstimate(scale, [anchorReport(100e8, 50)], [navPt('2025-12-31', 1.5)])
  expect(result[1]!.estimateMethod).toBe('unavailable')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd D:/code/hj && bun test scripts/lib/estimate.test.ts`
Expected: FAIL（`FLOOR_WEIGHT` / `CEIL_WEIGHT` 未导出，`huijinSharesFloor` 不存在）

- [ ] **Step 3: 重写 `scripts/lib/estimate.ts`**

```ts
/**
 * 汇金持仓估算 — 占比区间口径。
 * 下界：份额变动全归因汇金（逐日累加净份额变化）。
 * 上界：汇金占比不变（被动等比例稀释）。
 * 展示值：区间加权（偏向下界）。
 */
import type { EtfSnapshot, HolderReport, NavPoint, ScalePoint } from '../../shared/types'
import { computeTrendSignals } from '../../shared/estimate-signals'
import { nearestNav } from './merge'

type HuijinEstimate = EtfSnapshot['huijinEstimateHistory'][number]

/** 区间加权常量：偏向下界（对齐"大额变动主要是汇金"先验） */
export const FLOOR_WEIGHT = 2 / 3
export const CEIL_WEIGHT = 1 / 3

export function buildHuijinEstimate(
  scale: ScalePoint[],
  reports: HolderReport[],
  navs: NavPoint[],
): HuijinEstimate[] {
  const huijinReports = reports
    .filter((report) => report.huijinShares > 0)
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
  const disclosedByDate = new Map(
    huijinReports.map((report) => [report.reportDate, report]),
  )
  const latestAnchor =
    huijinReports.length > 0 ? huijinReports[huijinReports.length - 1] : null

  type EstimateWithNet = HuijinEstimate & { netSubscriptionYi: number | null }
  const raw: EstimateWithNet[] = []

  // floor 累加状态（亿份）；遇到披露日重置
  let floorYi: number | null = null

  for (const s of scale) {
    const report = disclosedByDate.get(s.date)
    const nav =
      nearestNav(navs, s.date) ??
      (s.totalSharesYi > 0 ? s.netAssetYi / s.totalSharesYi : null)

    if (report) {
      const huijinValueYi =
        nav != null ? (report.huijinShares * nav) / 1e8 : null
      raw.push({
        date: s.date,
        netAssetYi: s.netAssetYi,
        totalSharesYi: s.totalSharesYi,
        huijinShares: report.huijinShares,
        huijinValueYi:
          huijinValueYi != null ? Number(huijinValueYi.toFixed(4)) : null,
        huijinPct: report.huijinPercent,
        isEstimated: false,
        estimateMethod: 'disclosed' as const,
        netSubscriptionYi: s.netSubscriptionYi ?? null,
      })
      // 披露日重置 floor 为披露值
      floorYi = report.huijinShares / 1e8
      continue
    }

    if (
      latestAnchor &&
      s.date > latestAnchor.reportDate &&
      s.frequency === 'daily' &&
      s.totalSharesYi > 0
    ) {
      // 初始化 floor（首个 anchored 点之前若未经过披露日）
      if (floorYi == null) floorYi = latestAnchor.huijinShares / 1e8

      // 累加下界
      const netSub = s.netSubscriptionYi ?? 0
      floorYi = Math.max(0, Math.min(floorYi + netSub, s.totalSharesYi))

      // 上界：占比不变
      const ceilYi = (s.totalSharesYi * latestAnchor.huijinPercent) / 100

      // 展示值
      const weightedYi = floorYi * FLOOR_WEIGHT + ceilYi * CEIL_WEIGHT
      const huijinShares = Math.round(weightedYi * 1e8)
      const huijinValueYi =
        nav != null ? Number((weightedYi * nav).toFixed(4)) : null

      raw.push({
        date: s.date,
        netAssetYi: s.netAssetYi,
        totalSharesYi: s.totalSharesYi,
        huijinShares,
        huijinValueYi,
        huijinPct: Number(((weightedYi / s.totalSharesYi) * 100).toFixed(2)),
        huijinSharesFloor: Number(floorYi.toFixed(6)),
        huijinSharesCeil: Number(ceilYi.toFixed(6)),
        isEstimated: true,
        estimateMethod: 'anchored' as const,
        netSubscriptionYi: s.netSubscriptionYi ?? null,
      })
      continue
    }

    raw.push({
      date: s.date,
      netAssetYi: s.netAssetYi,
      totalSharesYi: s.totalSharesYi,
      huijinShares: null,
      huijinValueYi: null,
      huijinPct: null,
      isEstimated: false,
      estimateMethod: 'unavailable' as const,
      unavailableReason: !latestAnchor
        ? '暂无汇金持仓披露'
        : s.date <= latestAnchor.reportDate
          ? '最近披露日及之前，仅展示正式披露点'
          : '非日频份额数据点，不推算汇金持仓',
      netSubscriptionYi: s.netSubscriptionYi ?? null,
    })
  }

  // 趋势信号（基于总份额流向，与口径无关）
  const anchoredIdx = raw
    .map((p, i) => (p.estimateMethod === 'anchored' ? i : -1))
    .filter((i) => i >= 0)
  if (anchoredIdx.length) {
    const signals = computeTrendSignals(
      anchoredIdx.map((i) => ({
        date: raw[i]!.date,
        totalSharesYi: raw[i]!.totalSharesYi,
        netSubscriptionYi: raw[i]!.netSubscriptionYi ?? null,
      })),
    )
    anchoredIdx.forEach((i, k) => {
      const sig = signals[k]!
      raw[i] = {
        ...raw[i]!,
        shareTrend: sig.shareTrend,
        consecutiveDays: sig.consecutiveDays,
        shareChangePct5d: sig.shareChangePct5d,
      }
    })
  }

  return raw.map(({ netSubscriptionYi: _omit, ...rest }) => rest)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/code/hj && bun test scripts/lib/estimate.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 运行全部测试**

Run: `cd D:/code/hj && bun test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/estimate.ts scripts/lib/estimate.test.ts
git commit -m "feat: rewrite estimate to percentage-range (floor/ceil) method"
```

---

## Task 8: 回填窗口动态化（TDD）

**Files:**
- Modify: `shared/backfill-window.ts`
- Modify: `scripts/backfill-window.test.ts`

- [ ] **Step 1: 在 `scripts/backfill-window.test.ts` 末尾追加失败测试**

```ts
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
  // 应全段回填（从 2024-01-02 起）
  expect(result[0]).toBe('2024-01-02')
  expect(result.at(-1)).toBe('2026-01-10')
})

test('backfillStart：existing 已覆盖 backfillStart 时走增量逻辑', () => {
  const marketDates = ['2024-01-02', '2024-01-03', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10']
  const existing = [
    { date: '2024-01-02', totalSharesYi: 100, shareSource: 'sse' as const },
    { date: '2026-01-08', totalSharesYi: 200, shareSource: 'sse' as const },
  ]
  const result = computeOfficialFetchDates({
    existing,
    marketDates,
    latestHuijinReportDate: '2025-12-31',
    overlap: OVERLAP,
    backfillStart: '2024-01-01',
  })
  // 增量：从 existing 末尾前 overlap 起
  expect(result[0]).toBe('2026-01-05')
  expect(result.at(-1)).toBe('2026-01-10')
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
```

- [ ] **Step 2: 运行测试确认新用例失败**

Run: `cd D:/code/hj && bun test scripts/backfill-window.test.ts`
Expected: 新增 4 个测试 FAIL（`backfillStart` 参数不存在）

- [ ] **Step 3: 修改 `shared/backfill-window.ts`**

`ComputeFetchDatesArgs` 新增：
```ts
  /** 回填起点（如 '2024-01-01'）；existing 最早日期晚于此值时触发全段回填 */
  backfillStart?: string
```

`computeOfficialFetchDates` 函数体开头（`if (!dates.length) return []` 之后）插入：

```ts
  // 全段回填判断：existing 为空或最早日期晚于 backfillStart
  const earliestExisting = existing[0]?.date
  if (
    backfillStart != null &&
    (existing.length === 0 || (earliestExisting != null && earliestExisting > backfillStart))
  ) {
    const startIdx = dates.findIndex((d) => d >= backfillStart)
    return dates.slice(startIdx >= 0 ? startIdx : 0)
  }
```

函数签名解构中加入 `backfillStart`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/code/hj && bun test scripts/backfill-window.test.ts`
Expected: 全部 PASS（含原有用例）

- [ ] **Step 5: Commit**

```bash
git add shared/backfill-window.ts scripts/backfill-window.test.ts
git commit -m "feat: add backfillStart param to computeOfficialFetchDates"
```

---

## Task 9: 编排层接入回填窗口 + 缺口自动补抓

**Files:**
- Modify: `scripts/fetch-data.ts`（`fetchOfficialShareHistories` 及 `main`）

- [ ] **Step 1: 在 `scripts/fetch-data.ts` 顶部添加常量**

```ts
/** 日频份额回填起点 */
const SHARE_BACKFILL_START = '2024-01-01'
```

- [ ] **Step 2: 修改 `fetchOfficialShareHistories` 中 `computeOfficialFetchDates` 调用**

在调用处传入 `backfillStart: SHARE_BACKFILL_START`：

```ts
    fetchDatesByCode.set(
      quote.code,
      computeOfficialFetchDates({
        existing: prior.map((p) => ({
          date: p.date,
          totalSharesYi: p.totalSharesYi,
          shareSource: p.shareSource,
        })),
        marketDates,
        latestHuijinReportDate,
        overlap: OFFICIAL_SHARE_OVERLAP_TRADING_DAYS,
        backfillStart: SHARE_BACKFILL_START,
      }),
    )
```

- [ ] **Step 3: 在 `fetchOfficialShareHistories` 中合并上次缺口**

在计算 `fetchDatesByCode` 之后、实际抓取之前，对 SH 代码合并上次 SSE 缺口日期：

```ts
  // 合并上次缺口日期（优先补抓）
  for (const { quote } of picks) {
    const prevGaps = previous?.etfs.find((e) => e.code === quote.code)?.source.shareFetchGaps
    if (prevGaps?.sseFailedDates?.length && quote.market === 'SH') {
      const dates = fetchDatesByCode.get(quote.code) ?? []
      const merged = [...new Set([...prevGaps.sseFailedDates, ...dates])].sort()
      fetchDatesByCode.set(quote.code, merged)
    }
  }
```

对 SZ 代码，在 `fetchSzseDailyShares` 调用前，额外抓取上次失败区间：

```ts
    // 补抓上次 SZSE 失败区间
    const prevGaps = previous?.etfs.find((e) => e.code === quote.code)?.source.shareFetchGaps
    if (prevGaps?.szseFailedRanges?.length) {
      for (const range of prevGaps.szseFailedRanges) {
        const [start, end] = range.split('..').map((s) => s?.replace(/ p\d+$/, ''))
        if (start && end) {
          const { points: gapPoints } = await fetchSzseDailyShares(quote.code, start, end)
          histories.set(quote.code, mergeOfficialPoints(histories.get(quote.code) ?? [], gapPoints))
        }
      }
    }
```

- [ ] **Step 4: 删除 `fallbackWeekdays` 函数**

该函数不再被使用（回填窗口现在由 `computeOfficialFetchDates` + `marketDates` 驱动）。

- [ ] **Step 5: 验证编译通过**

Run: `cd D:/code/hj && bun -e "import './scripts/fetch-data.ts'" 2>&1 | head -5`
Expected: 开始执行抓取（有网络输出），无 import 错误。Ctrl+C 中断即可，或用下一步完整验证。

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-data.ts
git commit -m "feat: wire backfillStart + gap auto-recovery into fetch orchestration"
```

---

## Task 10: 抓取完整性报告 `scripts/lib/report.ts`

**Files:**
- Create: `scripts/lib/report.ts`
- Create: `scripts/lib/report.test.ts`
- Modify: `scripts/fetch-data.ts`（`main` 末尾调用）

- [ ] **Step 1: 编写测试 `scripts/lib/report.test.ts`**

```ts
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
        { date: '2024-01-03', totalSharesYi: 101, netAssetYi: 151, purchaseYi: null, redeemYi: null, netSubscriptionYi: 1, netAssetChangePct: null, frequency: 'daily', shareSource: 'sse', netAssetEstimated: true },
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
    date: '2024-01-04', totalSharesYi: 102, netAssetYi: 152,
    purchaseYi: null, redeemYi: null, netSubscriptionYi: 1,
    netAssetChangePct: null, frequency: 'daily', shareSource: 'sse', netAssetEstimated: true,
  })
  const report = formatCompletenessReport(d)
  expect(report).toContain('3/3')
  expect(report).not.toContain('⚠')
})

test('缺口列表展示', () => {
  const d = minimalDashboard()
  d.etfs[0]!.source.shareFetchGaps = { sseFailedDates: ['2024-01-04'] }
  const report = formatCompletenessReport(d)
  expect(report).toContain('2024-01-04')
  expect(report).toContain('缺口合计: 1 日 (SSE)')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd D:/code/hj && bun test scripts/lib/report.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `scripts/lib/report.ts`**

```ts
/**
 * 抓取完整性报告：覆盖率、缺口、数据量摘要。
 */
import type { DashboardData } from '../../shared/types'

export function formatCompletenessReport(data: DashboardData): string {
  const lines: string[] = ['═══ 抓取完整性报告 ═══']
  const marketDates = data.marketActiveCapHistory.map((p) => p.date)

  let totalSseGaps = 0
  let totalSzseGaps = 0

  for (const etf of data.etfs) {
    const daily = etf.scaleHistory.filter((p) => p.frequency === 'daily')
    const dailyDates = new Set(daily.map((p) => p.date))

    // 同期市场交易日（截取 ETF 日频范围内）
    const firstDaily = daily[0]?.date
    const lastDaily = daily.at(-1)?.date
    const expectedDates = marketDates.filter(
      (d) => (!firstDaily || d >= firstDaily) && (!lastDaily || d <= lastDaily),
    )
    const covered = expectedDates.filter((d) => dailyDates.has(d)).length
    const total = expectedDates.length
    const pct = total > 0 ? ((covered / total) * 100).toFixed(1) : '—'
    const warn = total > 0 && covered / total < 0.95 ? ' ⚠' : ''

    // 缺口
    const gaps = etf.source.shareFetchGaps
    const gapParts: string[] = []
    if (gaps?.sseFailedDates?.length) {
      totalSseGaps += gaps.sseFailedDates.length
      const shown = gaps.sseFailedDates.slice(0, 10)
      const extra = gaps.sseFailedDates.length - shown.length
      gapParts.push(...shown)
      if (extra > 0) gapParts.push(`…等 ${extra + shown.length} 个`)
    }
    if (gaps?.szseFailedRanges?.length) {
      totalSzseGaps += gaps.szseFailedRanges.length
      const shown = gaps.szseFailedRanges.slice(0, 10)
      const extra = gaps.szseFailedRanges.length - shown.length
      gapParts.push(...shown)
      if (extra > 0) gapParts.push(`…等 ${extra + shown.length} 个`)
    }

    const gapStr = gapParts.length ? gapParts.join(', ') : '无'
    lines.push(
      `${etf.categoryName.padEnd(5)} ${etf.code}  日频 ${covered}/${total} (${pct}%)${warn}  缺口: ${gapStr}`,
    )
  }

  // 持有人报告
  const reportCounts = data.etfs.map((e) => e.holderReports.length)
  const reportDates = [...new Set(data.etfs.flatMap((e) => e.holderReports.map((r) => r.reportDate)))]
  lines.push(
    `持有人报告: ${data.etfs.length}/${data.etfs.length} 只各 ${Math.min(...reportCounts)} 期 (${reportDates.join(', ')})`,
  )

  // 净值
  const navCounts = data.etfs.map((e) => e.navHistory.length)
  lines.push(`净值: ${data.etfs.length}/${data.etfs.length} 只 ≥${Math.min(...navCounts)} 条`)

  // 0AMV
  const mkt = data.marketActiveCapHistory
  lines.push(
    `0AMV: ${mkt.length} 条 (${mkt[0]?.date ?? '—'} → ${mkt.at(-1)?.date ?? '—'})`,
  )

  // 缺口合计
  lines.push(`缺口合计: ${totalSseGaps} 日 (SSE) / ${totalSzseGaps} 段 (SZSE)`)

  return lines.join('\n')
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/code/hj && bun test scripts/lib/report.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 在 `scripts/fetch-data.ts` 的 `main()` 末尾接入**

在 `console.log(\`\n✓ 已写入 ${OUT_FILE}\`)` 之后添加：

```ts
import { formatCompletenessReport } from './lib/report'
// ...（import 放文件顶部）

// main() 末尾：
  console.log('')
  console.log(formatCompletenessReport(dashboard))
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/report.ts scripts/lib/report.test.ts scripts/fetch-data.ts
git commit -m "feat: add fetch completeness report"
```

---

## Task 11: 审计更新 `scripts/data-audit.ts`

**Files:**
- Modify: `scripts/data-audit.ts:91-141`（anchored 校验区块）

- [ ] **Step 1: 替换 anchored 校验区块**

将 `data-audit.ts` 第 103-133 行（`} else if (point.estimateMethod === 'anchored') {` 分支）替换为：

```ts
    } else if (point.estimateMethod === 'anchored') {
      if (!point.isEstimated) errors.push(`${etf.code} ${point.date}: anchored point must be marked estimated`)
      if (!latestAnchorDate || point.date <= latestAnchorDate) errors.push(`${etf.code} ${point.date}: anchored point not after latest disclosure`)
      if (point.huijinShares == null || !finite(point.huijinShares) || point.huijinShares < 0) errors.push(`${etf.code} ${point.date}: anchored point has invalid shares`)
      // 区间校验
      if (point.huijinSharesFloor == null || !finite(point.huijinSharesFloor) || point.huijinSharesFloor < 0) {
        errors.push(`${etf.code} ${point.date}: anchored point missing valid huijinSharesFloor`)
      }
      if (point.huijinSharesCeil == null || !finite(point.huijinSharesCeil) || point.huijinSharesCeil < 0) {
        errors.push(`${etf.code} ${point.date}: anchored point missing valid huijinSharesCeil`)
      }
      if (point.huijinSharesFloor != null && point.huijinSharesCeil != null) {
        if (point.huijinSharesFloor > point.huijinSharesCeil + 0.000001) {
          errors.push(`${etf.code} ${point.date}: floor exceeds ceil`)
        }
        if (point.huijinSharesCeil > point.totalSharesYi + 0.000001) {
          errors.push(`${etf.code} ${point.date}: ceil exceeds total shares`)
        }
        // 展示值落在区间内（份 → 亿份转换后比较）
        if (point.huijinShares != null) {
          const sharesYi = point.huijinShares / 1e8
          if (sharesYi < point.huijinSharesFloor - 0.000002 || sharesYi > point.huijinSharesCeil + 0.000002) {
            errors.push(`${etf.code} ${point.date}: display shares outside [floor, ceil]`)
          }
        }
      }
      // huijinPct 反推一致性
      if (point.huijinShares != null && point.huijinPct != null && point.totalSharesYi > 0) {
        const expectedPct = (point.huijinShares / 1e8 / point.totalSharesYi) * 100
        if (Math.abs(expectedPct - point.huijinPct) > 0.02) {
          errors.push(`${etf.code} ${point.date}: huijinPct inconsistent with shares/total`)
        }
      }
      if (point.huijinValueYi != null && (!finite(point.huijinValueYi) || point.huijinValueYi < 0)) errors.push(`${etf.code} ${point.date}: invalid anchored value`)
      // 趋势信号校验
      if (point.shareTrend != null && !['inflow', 'outflow', 'flat'].includes(point.shareTrend)) {
        errors.push(`${etf.code} ${point.date}: invalid shareTrend`)
      }
      if (point.consecutiveDays != null && (!finite(point.consecutiveDays) || point.consecutiveDays < 1)) {
        errors.push(`${etf.code} ${point.date}: invalid consecutiveDays`)
      }
      if (point.shareChangePct5d != null && !finite(point.shareChangePct5d)) {
        errors.push(`${etf.code} ${point.date}: invalid shareChangePct5d`)
      }
      // clamp 字段不应存在
      if ('clampTriggered' in point || 'clampReliability' in point) {
        errors.push(`${etf.code} ${point.date}: legacy clamp field present on anchored point`)
      }
```

- [ ] **Step 2: 更新 disclosed 分支中的趋势信号校验**

第 100-102 行，将 `point.clampReliability != null` 改为检查新字段：

```ts
      if (point.shareTrend != null || point.consecutiveDays != null || point.huijinSharesFloor != null) {
        errors.push(`${etf.code} ${point.date}: disclosed point must not carry trend signals or range`)
      }
```

- [ ] **Step 3: 更新 unavailable 分支**

第 138 行同理：

```ts
      if (point.shareTrend != null || point.consecutiveDays != null || point.huijinSharesFloor != null) {
        errors.push(`${etf.code} ${point.date}: unavailable point must not carry trend signals or range`)
      }
```

- [ ] **Step 4: 新增 floor 累加一致性抽样校验**

在 anchored 循环之后（`for (const point of etf.huijinEstimateHistory)` 循环结束后），添加：

```ts
  // floor 累加一致性抽样校验
  const anchoredPoints = etf.huijinEstimateHistory.filter((p) => p.estimateMethod === 'anchored')
  if (anchoredPoints.length > 0 && latestAnchorShares != null) {
    let expectedFloor = latestAnchorShares / 1e8
    for (const point of anchoredPoints) {
      const dailyPoint = etf.scaleHistory.find((s) => s.date === point.date && s.frequency === 'daily')
      const netSub = dailyPoint?.netSubscriptionYi ?? 0
      expectedFloor = Math.max(0, Math.min(expectedFloor + netSub, point.totalSharesYi))
      if (point.huijinSharesFloor != null && Math.abs(point.huijinSharesFloor - expectedFloor) > 0.000002) {
        errors.push(`${etf.code} ${point.date}: floor accumulation mismatch (expected ${expectedFloor.toFixed(6)}, got ${point.huijinSharesFloor})`)
        break
      }
    }
  }
```

- [ ] **Step 5: 验证审计脚本语法**

Run: `cd D:/code/hj && bun -e "import './scripts/data-audit.ts'" 2>&1 | head -3`
Expected: 开始执行审计（输出 JSON），无语法错误。

- [ ] **Step 6: Commit**

```bash
git add scripts/data-audit.ts
git commit -m "feat: update audit for percentage-range estimate, remove clamp checks"
```

---

## Task 12: README + source 字符串更新 + 最终集成验证

**Files:**
- Modify: `README.md`
- Modify: `scripts/fetch-data.ts`（`source.huijinEstimate` 字符串）

- [ ] **Step 1: 更新 `scripts/fetch-data.ts` 中 `buildEtfSnapshot` 的 `source.huijinEstimate` 字符串**

将：
```ts
      huijinEstimate:
        '披露日展示正式披露份额与估值；最后披露期之后按份额锚定法估算（假设汇金不主动赎回，估算份额 = min(披露份额, 当日总份额)，总份额低于披露份额时触发 clamp 并标记可靠性下降）',
```

替换为：
```ts
      huijinEstimate:
        '占比区间口径：下界从最近披露汇金份额起逐日累加交易所总份额净变化（份额变动全归因汇金）；上界维持最近披露汇金占比不变（被动等比例稀释）；展示值取区间加权（下界 2/3 + 上界 1/3）。趋势信号（份额流向、连续天数、5 日变化率）供方向参考。估算不代表汇金实际持仓。',
```

- [ ] **Step 2: 更新 `README.md` 第 36 行附近的估算口径段落**

将"最近披露期之后按**份额锚定法**生成估算序列…"段落替换为：

```markdown
最近披露期之后按**占比区间**口径生成估算序列：下界从最近披露汇金份额起逐日累加交易所总份额净变化（份额变动全归因汇金，假设大额赎回/申购主要由汇金进行）；上界维持最近披露的汇金占比不变（汇金被动等比例稀释）；展示值取区间加权（下界 2/3 + 上界 1/3）。实际汇金份额落在区间内。估算不代表汇金实际持仓。
```

- [ ] **Step 3: 更新 `README.md` 第 97 行附近的口径声明**

将"汇金持仓趋势展示两类数据点…"段落替换为：

```markdown
- 汇金持仓趋势展示两类数据点：① 十大持有人报告期正式披露点（实线）；② 最后披露期之后的占比区间估算点（虚线，明确标注）。下界假设份额变动全归因汇金，上界假设汇金占比不变，展示值取区间加权（下界 2/3 + 上界 1/3）。趋势信号（份额流向、连续天数、5 日变化率）供方向参考，不代表汇金实际操作。
```

- [ ] **Step 4: 更新 `README.md` 第 62 行附近的回填描述**

将"首次回填约 250 个交易日"改为：

```markdown
- ETF 份额变化趋势使用 ECharts `time` 时间轴，优先绘制交易所官方日频总份额；首次回填至 2024-01-01（约 380 个交易日），之后增量更新并复查最近 5 个交易日
```

- [ ] **Step 5: 运行全部测试**

Run: `cd D:/code/hj && bun test`
Expected: 全部 PASS

- [ ] **Step 6: 运行完整抓取**

Run: `cd D:/code/hj && bun run fetch`
Expected: 成功输出 `✓ 已写入`，完整性报告显示日频覆盖率 ≥99%，缺口合计为 0。首次运行会回填 2024-01-01 起的全段数据（约 380 个交易日），耗时较平时长。

- [ ] **Step 7: 运行审计**

Run: `cd D:/code/hj && bun run audit`
Expected: `errors: []`。warnings 中可能有 `shareFetchGaps` 相关（如果有个别日期失败），可接受。

- [ ] **Step 8: Commit**

```bash
git add README.md scripts/fetch-data.ts
git commit -m "docs: update estimate methodology to percentage-range, backfill to 2024"
```

---

## 验证清单

完成所有 Task 后确认：

1. `bun test` — 全部 PASS
2. `bun run fetch` — 成功，完整性报告覆盖率 ≥99%
3. `bun run audit` — errors 为空
4. `scripts/fetch-data.ts` 行数 ≤300
5. `data/dashboard.json` 中 anchored 点含 `huijinSharesFloor` / `huijinSharesCeil`，无 `clampTriggered`
6. 日频份额范围：2024-01-02 → 最新交易日
