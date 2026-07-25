# 份额数据精确化 + 汇金估算趋势信号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把每只 ETF 的日频总份额回填窗口锚定到最近汇金披露日（2025-12-31）以保证锚点精度、加固抓取容错不丢交易日、在份额锚定估算点上叠加趋势信号层，让"跟随汇金"可判方向。

**Architecture:** 三层改动——① 抓取层（`scripts/fetch-data.ts`）动态回填窗口 + SSE/SZSE/net fetch 容错 + 缺口记录；② 估算层（`buildHuijinEstimate`）保持份额锚定口径，新增 `shareTrend`/`consecutiveDays`/`shareChangePct5d`/`clampReliability` 趋势信号；③ 展示层（`HuijinTrendChart.vue`/`EtfTable.vue`）与审计（`data-audit.ts`）同步。可测纯函数（趋势信号计算、回填窗口计算）提取到 `shared/` 用 `bun test` 单测，网络层用真实抓取 + audit 做集成验证。

**Tech Stack:** TypeScript, Bun, Vue 3 + ECharts, 无现有测试框架（本次引入 `bun test`）。

---

## 文件结构

- **新建 `shared/estimate-signals.ts`**：纯函数，从已算好的估算点序列计算趋势信号（`shareTrend`/`consecutiveDays`/`shareChangePct5d`/`clampReliability`）。无网络依赖，可单测。
- **新建 `shared/backfill-window.ts`**：纯函数，根据最近汇金披露日与已有数据计算官方份额回填日期窗口。可单测。
- **新建 `scripts/estimate-signals.test.ts`**：`bun test` 单测覆盖趋势信号计算。
- **新建 `scripts/backfill-window.test.ts`**：`bun test` 单测覆盖回填窗口计算。
- **修改 `shared/types.ts`**：`HuijinEstimatePoint` 新增趋势信号字段；`EtfSnapshot.source` 新增 `shareFetchGaps`。
- **修改 `scripts/fetch-data.ts`**：回填窗口动态化、`fetchText`/`fetchNavHistory` 重试加固、SSE/SZSE 容错不丢段、`buildHuijinEstimate` 调用信号计算、`source.shareFetchGaps` 落盘。
- **修改 `scripts/data-audit.ts`**：新字段校验 + 缺口 warning。
- **修改 `src/components/HuijinTrendChart.vue`**：叠加份额变化率次轴曲线 + clamp 背景带 + tooltip 趋势文案。
- **修改 `src/components/EtfTable.vue`**：新增"份额趋势"列。
- **修改 `README.md`**：口径声明更新。

---

## Task 1: 类型定义扩展

**Files:**
- Modify: `shared/types.ts`

- [ ] **Step 1: 扩展 `HuijinEstimatePoint` 与 `EtfSnapshot.source`**

在 `shared/types.ts` 的 `HuijinEstimatePoint` 接口中，在 `unavailableReason?: string` 之后追加：

```ts
  /** 当日总份额相对前一交易日的方向（仅 anchored 估算点填充） */
  shareTrend?: 'inflow' | 'outflow' | 'flat'
  /** 连续同向天数（含当日，仅 anchored 估算点填充） */
  consecutiveDays?: number
  /** 近 5 个交易日总份额变化率 %；5 日内有缺失则为 null */
  shareChangePct5d?: number | null
  /** clamp 可靠性细分（仅 clampTriggered 时填充） */
  clampReliability?: 'just_triggered' | 'persistent' | 'persistent_recovering'
```

在 `EtfSnapshot['source']` 接口中，在 `holdersHistoryDeduplicated?: boolean` 之后追加：

```ts
    /** 交易所日频份额抓取缺口（重试用尽仍失败的日期/区间），非空表示有数据缺口 */
    shareFetchGaps?: {
      sseFailedDates?: string[]
      szseFailedRanges?: string[]
    }
```

- [ ] **Step 2: 类型检查**

Run: `bunx vue-tsc -b --noEmit 2>&1 | head -20` （或 `bun run build` 检查类型，预期仅因新字段未使用产生可能的告警，无 error）
Expected: 无类型错误（新增字段均为可选）。

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat(types): add huijin trend signal and share fetch gap fields"
```

---

## Task 2: 回填窗口纯函数 + 单测

**Files:**
- Create: `shared/backfill-window.ts`
- Create: `scripts/backfill-window.test.ts`

- [ ] **Step 1: 写失败测试 `scripts/backfill-window.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { computeOfficialFetchDates } from '../shared/backfill-window'

const OVERLAP = 5

test('首次回填：无已有数据，窗口从披露日向前 overlap 起到最新交易日', () => {
  const marketDates = Array.from({ length: 10 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`)
  // marketDates: 2026-01-01 .. 2026-01-10
  const result = computeOfficialFetchDates({
    existing: [],
    marketDates,
    latestHuijinReportDate: '2025-12-31',
    overlap: OVERLAP,
  })
  // 起点 = max(披露日, 最新日 - 全窗口) 但披露日早于 marketDates，故起点取 marketDates[0] 前 overlap
  // 首次回填应覆盖全部 marketDates（披露日 2025-12-31 在 marketDates 之前，整段都要抓）
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
  // 末尾 2026-01-03，overlap 5 → 从 marketDates 中 > 01-03 的前 5 个起
  // marketDates[3]=2026-01-04，anchor 到 index 3，slice(max(0,3-5))=slice(0)
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
  // 必须包含披露日 2026-06-01
  expect(result).toContain('2026-06-01')
  expect(result.at(-1)).toBe('2026-06-05')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test scripts/backfill-window.test.ts`
Expected: FAIL — `Cannot find module '../shared/backfill-window'`

- [ ] **Step 3: 实现 `shared/backfill-window.ts`**

```ts
/**
 * 计算交易所日频总份额的回填/增量抓取日期窗口。
 * 窗口下界 = max(最近汇金披露日, 已有末尾日 - overlap)，确保披露日落在日频区间内。
 */
export interface OfficialDailySharePointLite {
  date: string
  totalSharesYi: number
  shareSource: 'sse' | 'szse'
}

export interface ComputeFetchDatesArgs {
  existing: OfficialDailySharePointLite[]
  marketDates: string[]
  /** 最近一期汇金披露日（如 '2025-12-31'）；无披露时传 null */
  latestHuijinReportDate: string | null
  overlap: number
}

export function computeOfficialFetchDates({
  existing,
  marketDates,
  latestHuijinReportDate,
  overlap,
}: ComputeFetchDatesArgs): string[] {
  const dates = marketDates.length ? [...marketDates].sort() : []
  if (!dates.length) return []

  const latestExisting = existing.at(-1)?.date
  // 窗口下界候选：已有末尾 - overlap
  let lowerBound: string | null = null
  if (latestExisting) {
    const nextIndex = dates.findIndex((d) => d > latestExisting)
    const anchor = nextIndex >= 0 ? nextIndex : dates.length - 1
    const startIdx = Math.max(0, anchor - overlap)
    lowerBound = dates[startIdx]!
  }

  // 披露日约束：窗口必须覆盖披露日（若披露日在 marketDates 范围内或之前）
  if (latestHuijinReportDate) {
    if (!lowerBound || latestHuijinReportDate < lowerBound) {
      // 披露日早于下界 → 找到 marketDates 中 >= 披露日 的最早位置，向前 overlap
      const idx = dates.findIndex((d) => d >= latestHuijinReportDate)
      if (idx >= 0) {
        lowerBound = dates[Math.max(0, idx - overlap)]!
      } else {
        // 披露日晚于所有 marketDates，回填整段（罕见）
        lowerBound = dates[0]!
      }
    }
  }

  if (!lowerBound) {
    // 首次回填且无披露约束 → 全部
    return dates
  }
  const startIdx = dates.findIndex((d) => d >= lowerBound)
  return dates.slice(startIdx >= 0 ? startIdx : 0)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test scripts/backfill-window.test.ts`
Expected: PASS（3 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add shared/backfill-window.ts scripts/backfill-window.test.ts
git commit -m "feat: backfill window anchored to latest huijin disclosure date"
```

---

## Task 3: 趋势信号纯函数 + 单测

**Files:**
- Create: `shared/estimate-signals.ts`
- Create: `scripts/estimate-signals.test.ts`

- [ ] **Step 1: 写失败测试 `scripts/estimate-signals.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { computeTrendSignals, type SignalInput } from '../shared/estimate-signals'

function point(date: string, total: number, netSub: number | null, clamp = false): SignalInput {
  return { date, totalSharesYi: total, netSubscriptionYi: netSub, clampTriggered: clamp }
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
  // 6 个点：第 6 个相对第 1 个 (105-100)/100*100 = 5
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
  // 前 4 个点不足 5 日窗口 → null
  expect(out[0].shareChangePct5d).toBeNull()
})

test('clampReliability：刚触发 just_triggered，持续且下降 persistent，持续且回升 persistent_recovering', () => {
  const pts = [
    point('2026-01-05', 100, -1, false), // 未 clamp
    point('2026-01-06', 99, -1, true),   // 刚 clamp → just_triggered
    point('2026-01-07', 98, -1, true),   // 持续 clamp 且份额仍降 → persistent
    point('2026-01-08', 99, 1, true),    // 持续 clamp 但份额回升 → persistent_recovering
  ]
  const out = computeTrendSignals(pts)
  expect(out[1].clampReliability).toBe('just_triggered')
  expect(out[2].clampReliability).toBe('persistent')
  expect(out[3].clampReliability).toBe('persistent_recovering')
})

test('未 clamp 时 clampReliability 为 undefined', () => {
  const pts = [point('2026-01-05', 100, 1, false)]
  const out = computeTrendSignals(pts)
  expect(out[0].clampReliability).toBeUndefined()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test scripts/estimate-signals.test.ts`
Expected: FAIL — `Cannot find module '../shared/estimate-signals'`

- [ ] **Step 3: 实现 `shared/estimate-signals.ts`**

```ts
/** 趋势信号计算所需的输入点（来自 anchored 估算点序列，按日期升序） */
export interface SignalInput {
  date: string
  totalSharesYi: number
  /** 当日总份额相对前一交易日的净变化（亿份） */
  netSubscriptionYi: number | null
  clampTriggered?: boolean
}

export interface SignalOutput {
  shareTrend: 'inflow' | 'outflow' | 'flat'
  consecutiveDays: number
  shareChangePct5d: number | null
  clampReliability?: 'just_triggered' | 'persistent' | 'persistent_recovering'
}

/**
 * 从 anchored 估算点序列计算趋势信号。
 * 输入必须按日期升序、为同一 ETF 的连续交易日点。
 */
export function computeTrendSignals(points: SignalInput[]): SignalOutput[] {
  const out: SignalOutput[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const net = p.netSubscriptionYi
    const shareTrend: SignalOutput['shareTrend'] =
      net == null ? 'flat' : net > 0 ? 'inflow' : net < 0 ? 'outflow' : 'flat'

    // consecutiveDays：向前回溯同向
    let consecutiveDays = 1
    for (let j = i - 1; j >= 0; j--) {
      const prevNet = points[j]!.netSubscriptionYi
      const prevTrend: SignalOutput['shareTrend'] =
        prevNet == null ? 'flat' : prevNet > 0 ? 'inflow' : prevNet < 0 ? 'outflow' : 'flat'
      if (prevTrend === shareTrend && shareTrend !== 'flat') consecutiveDays++
      else break
    }

    // shareChangePct5d：第 i 个相对第 i-5 个
    let shareChangePct5d: number | null = null
    if (i - 5 >= 0) {
      const base = points[i - 5]!.totalSharesYi
      if (base > 0) {
        shareChangePct5d = Number((((p.totalSharesYi - base) / base) * 100).toFixed(2))
      }
    }

    // clampReliability
    let clampReliability: SignalOutput['clampReliability'] | undefined
    if (p.clampTriggered) {
      const prevClamp = i > 0 && points[i - 1]!.clampTriggered
      if (!prevClamp) {
        clampReliability = 'just_triggered'
      } else if (shareChangePct5d != null && shareChangePct5d > 0) {
        clampReliability = 'persistent_recovering'
      } else {
        clampReliability = 'persistent'
      }
    }

    out.push({ shareTrend, consecutiveDays, shareChangePct5d, clampReliability })
  }
  return out
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test scripts/estimate-signals.test.ts`
Expected: PASS（6 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add shared/estimate-signals.ts scripts/estimate-signals.test.ts
git commit -m "feat: huijin estimate trend signals (shareTrend/consecutiveDays/changePct5d/clampReliability)"
```

---

## Task 4: fetchText 与 fetchNavHistory 容错加固

**Files:**
- Modify: `scripts/fetch-data.ts:62-92`（`fetchText`）、`scripts/fetch-data.ts:832-872`（`fetchNavHistory`）

- [ ] **Step 1: 加固 `fetchText` 重试**

把 `fetchText` 的签名与重试改为 5 次指数退避、超时 30s。替换 `scripts/fetch-data.ts` 中 `async function fetchText(...)` 整个函数体为：

```ts
async function fetchText(
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
      // 指数退避 400 * 2^i
      await sleep(400 * 2 ** i)
    }
  }
  throw lastErr
}
```

- [ ] **Step 2: 加固 `fetchNavHistory` 失败 continue 重试**

把 `fetchNavHistory` 中 `for` 循环内的 `catch` 块从 `break` 改为 continue 重试。替换 `scripts/fetch-data.ts:838-869` 中循环体为：

```ts
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=50&startDate=&endDate=`
    let pageFailed = true
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const json = await fetchJson<{
          Data?: {
            LSJZList?: {
              FSRQ: string
              DWJZ: string
              LJJZ: string
              JZZZL: string
            }[]
          }
        }>(url, 'https://fundf10.eastmoney.com/')
        const list = json.Data?.LSJZList ?? []
        if (!list.length) {
          pageFailed = false
          break
        }
        for (const row of list) {
          points.push({
            date: row.FSRQ,
            nav: Number(row.DWJZ) || 0,
            accNav: Number(row.LJJZ) || Number(row.DWJZ) || 0,
            changePct:
              row.JZZZL === '' || row.JZZZL == null
                ? null
                : Number(row.JZZZL),
          })
        }
        pageFailed = false
        break
      } catch (e) {
        if (attempt === 2) console.warn(`  nav ${code} page ${page}`, e)
        await sleep(400 * 2 ** attempt)
      }
    }
    if (pageFailed) {
      // 单页彻底失败：记录但继续下一页，不丢整段净值
      console.warn(`  nav ${code} page ${page} 跳过（重试用尽）`)
      continue
    }
    await sleep(120)
  }
```

- [ ] **Step 3: 类型检查**

Run: `bunx vue-tsc -b --noEmit 2>&1 | head`
Expected: 无类型错误。

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-data.ts
git commit -m "fix: harden fetchText retries and nav history resilience"
```

---

## Task 5: SSE 份额抓取容错 + 缺口记录

**Files:**
- Modify: `scripts/fetch-data.ts:626-669`（`fetchSseDailyShares`）

- [ ] **Step 1: 改造 `fetchSseDailyShares` 记录失败日期不中断**

替换 `fetchSseDailyShares` 整个函数为（返回值增加 failedDates）：

```ts
async function fetchSseDailyShares(
  codes: string[],
  dates: string[],
): Promise<{ points: Map<string, OfficialDailySharePoint[]>; failedDates: string[] }> {
  const wanted = new Set(codes)
  const fetched = new Map(codes.map((code) => [code, [] as OfficialDailySharePoint[]]))
  const failedDates: string[] = []
  for (let start = 0; start < dates.length; start += 3) {
    const batch = dates.slice(start, start + 3)
    await Promise.all(
      batch.map(async (date) => {
        const params = new URLSearchParams({
          sqlId: 'COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L',
          isPagination: 'true',
          'pageHelp.pageSize': '10000',
          'pageHelp.pageNo': '1',
          'pageHelp.beginPage': '1',
          'pageHelp.endPage': '1',
          STAT_DATE: date,
        })
        let ok = false
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const json = await fetchJson<SseScaleResponse>(
              `https://query.sse.com.cn/commonQuery.do?${params}`,
              'https://www.sse.com.cn/assortment/fund/etf/list/scale/',
            )
            for (const row of json.result ?? []) {
              const code = String(row.SEC_CODE ?? '')
              if (!wanted.has(code)) continue
              const sharesWan = Number(String(row.TOT_VOL ?? '').replace(/,/g, ''))
              if (!Number.isFinite(sharesWan) || sharesWan < 0) continue
              fetched.get(code)?.push({
                date: String(row.STAT_DATE ?? date).slice(0, 10),
                totalSharesYi: Number((sharesWan / 10000).toFixed(6)),
                shareSource: 'sse',
              })
            }
            ok = true
            break
          } catch (error) {
            if (attempt === 4) console.warn(`  上交所 ETF 份额 ${date} 抓取失败`, error)
            await sleep(400 * 2 ** attempt)
          }
        }
        if (!ok) failedDates.push(date)
      }),
    )
    await sleep(80)
  }
  return { points: fetched, failedDates }
}
```

- [ ] **Step 2: 类型检查**

Run: `bunx vue-tsc -b --noEmit 2>&1 | head`
Expected: `fetchOfficialShareHistories` 中调用 `fetchSseDailyShares` 的地方会因返回值结构变化报错（下一步修复），暂记。

- [ ] **Step 3: Commit（标记 WIP，下一步修复调用方）**

```bash
git add scripts/fetch-data.ts
git commit -m "wip: sse share fetch returns failed dates"
```

---

## Task 6: SZSE 份额抓取容错 + 缺口记录，并修复调用方

**Files:**
- Modify: `scripts/fetch-data.ts:694-748`（`fetchSzseDailyShares`）、`750-802`（`fetchOfficialShareHistories`）

- [ ] **Step 1: 改造 `fetchSzseDailyShares` 返回 failedRanges**

替换 `fetchSzseDailyShares` 整个函数为：

```ts
async function fetchSzseDailyShares(
  code: string,
  startDate: string,
  endDate: string,
): Promise<{ points: OfficialDailySharePoint[]; failedRanges: string[] }> {
  const points: OfficialDailySharePoint[] = []
  const failedRanges: string[] = []
  for (const [rangeStart, rangeEnd] of splitDateRanges(startDate, endDate)) {
    let page = 1
    let pageCount = 1
    let rangeFullyFailed = false
    do {
      const params = new URLSearchParams({
        SHOWTYPE: 'JSON',
        CATALOGID: 'scsj_fund_jjgm',
        jjlb: 'ETF',
        txtDm: code,
        txtStart: rangeStart,
        txtEnd: rangeEnd,
        PAGENO: String(page),
      })
      let pageOk = false
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const response = await fetchJson<SzseScaleResponse | SzseScaleResponse[]>(
            `https://www.szse.cn/api/report/ShowReport/data?${params}`,
            'https://www.szse.cn/market/fund/volume/etf/index.html',
          )
          const json = Array.isArray(response) ? response[0] : response
          if (!json) throw new Error('深交所规模接口返回空数组')
          if (json.error) throw new Error(json.error)
          pageCount = Math.max(1, Number(json.metadata?.pagecount) || 1)
          for (const row of normalizeSzseRows(json.data)) {
            if (String(row.fund_code ?? '') !== code) continue
            const sharesWan = Number(
              String(row.current_size ?? '').replace(/,/g, ''),
            )
            if (!Number.isFinite(sharesWan) || sharesWan < 0 || !row.size_date) {
              continue
            }
            points.push({
              date: row.size_date.slice(0, 10),
              totalSharesYi: Number((sharesWan / 10000).toFixed(6)),
              shareSource: 'szse',
            })
          }
          pageOk = true
          break
        } catch (error) {
          if (attempt === 4)
            console.warn(
              `  深交所 ETF 份额 ${code} ${rangeStart}..${rangeEnd} 第 ${page} 页抓取失败`,
              error,
            )
          await sleep(400 * 2 ** attempt)
        }
      }
      if (!pageOk) {
        // 单页失败：记录区间，跳出该区间继续下一个区间，不丢整段
        failedRanges.push(`${rangeStart}..${rangeEnd} p${page}`)
        rangeFullyFailed = true
        break
      }
      page += 1
      await sleep(80)
    } while (page <= pageCount && !rangeFullyFailed)
  }
  return { points: mergeOfficialPoints([], points), failedRanges }
}
```

- [ ] **Step 2: 改造 `fetchOfficialShareHistories` 使用新返回值并落 `shareFetchGaps`**

替换 `fetchOfficialShareHistories` 整个函数为：

```ts
async function fetchOfficialShareHistories(
  picks: Array<{ quote: EtfQuote }>,
  previous: DashboardData | null,
  marketDates: string[],
): Promise<{
  histories: Map<string, OfficialDailySharePoint[]>
  gaps: Map<string, { sseFailedDates?: string[]; szseFailedRanges?: string[] }>
}> {
  const histories = new Map<string, OfficialDailySharePoint[]>()
  const gaps = new Map<string, { sseFailedDates?: string[]; szseFailedRanges?: string[] }>()
  const fetchDatesByCode = new Map<string, string[]>()

  // 最近汇金披露日（取所有 ETF 末尾披露日的最大值）
  const allReportDates = (previous?.etfs ?? [])
    .flatMap((etf) => etf.huijinHistory.map((h) => h.reportDate))
    .sort()
  const latestHuijinReportDate = allReportDates.at(-1) ?? null

  for (const { quote } of picks) {
    const prior = officialPointsFromSnapshot(
      previous?.etfs.find((etf) => etf.code === quote.code),
    )
    histories.set(quote.code, prior)
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
      }),
    )
  }

  const shCodes = picks
    .map(({ quote }) => quote)
    .filter((quote) => quote.market === 'SH')
    .map((quote) => quote.code)
  const shDates = [
    ...new Set(shCodes.flatMap((code) => fetchDatesByCode.get(code) ?? [])),
  ].sort()
  if (shCodes.length && shDates.length) {
    const { points: fetched, failedDates } = await fetchSseDailyShares(shCodes, shDates)
    for (const code of shCodes) {
      histories.set(
        code,
        mergeOfficialPoints(histories.get(code) ?? [], fetched.get(code) ?? []),
      )
    }
    if (failedDates.length) {
      for (const code of shCodes)
        gaps.set(code, { sseFailedDates: failedDates })
    }
    console.log(`上交所 ETF 日份额：${shCodes.length} 只，查询 ${shDates.length} 个交易日，失败 ${failedDates.length} 日`)
  }

  const szQuotes = picks
    .map(({ quote }) => quote)
    .filter((quote) => quote.market === 'SZ')
  for (const quote of szQuotes) {
    const dates = fetchDatesByCode.get(quote.code) ?? []
    if (!dates.length) continue
    const { points: fetched, failedRanges } = await fetchSzseDailyShares(
      quote.code,
      dates[0]!,
      dates[dates.length - 1]!,
    )
    histories.set(
      quote.code,
      mergeOfficialPoints(histories.get(quote.code) ?? [], fetched),
    )
    if (failedRanges.length)
      gaps.set(quote.code, { szseFailedRanges: failedRanges })
    console.log(`深交所 ETF 日份额：${quote.code} 共 ${histories.get(quote.code)?.length ?? 0} 条，失败 ${failedRanges.length} 段`)
  }

  return { histories, gaps }
}
```

- [ ] **Step 3: 修复 `main()` 中调用处**

在 `scripts/fetch-data.ts` 的 `main()` 中，原 `const officialShareHistories = await fetchOfficialShareHistories(picked, previous, ...)` 改为解构，并把 gaps 传给 `buildEtfSnapshot`：

```ts
  console.log('抓取交易所 ETF 每日总份额…')
  const { histories: officialShareHistories, gaps: shareFetchGaps } =
    await fetchOfficialShareHistories(
      picked,
      previous,
      marketActiveCapHistory.map((point) => point.date),
    )
```

并在 `buildEtfSnapshot` 调用处传入 gaps（见下一个 for 循环里）：

```ts
  const etfs: EtfSnapshot[] = []
  for (const p of picked) {
    try {
      const snap = await buildEtfSnapshot(
        p.category,
        p.quote,
        officialShareHistories.get(p.quote.code) ?? [],
        previous?.etfs.find((e) => e.code === p.quote.code),
        shareFetchGaps.get(p.quote.code),
      )
      etfs.push(snap)
      await sleep(300)
    } catch (e) {
      console.error(`失败 ${p.quote.code}`, e)
    }
  }
```

- [ ] **Step 4: 修改 `buildEtfSnapshot` 签名接收 gaps 并写入 source**

把 `buildEtfSnapshot` 签名改为增加 `shareFetchGaps` 参数，并在返回的 `source` 中写入。修改 `scripts/fetch-data.ts:1076` 函数签名：

```ts
async function buildEtfSnapshot(
  category: (typeof CATEGORIES)[number],
  quote: EtfQuote,
  officialDailyShares: OfficialDailySharePoint[],
  previous?: EtfSnapshot,
  shareFetchGaps?: { sseFailedDates?: string[]; szseFailedRanges?: string[] },
): Promise<EtfSnapshot> {
```

在返回对象的 `source` 字段中，`fetchedAt` 之前加入：

```ts
      shareFetchGaps:
        shareFetchGaps &&
        (shareFetchGaps.sseFailedDates?.length || shareFetchGaps.szseFailedRanges?.length)
          ? shareFetchGaps
          : undefined,
```

- [ ] **Step 5: 引入 backfill-window 与 estimate-signals 模块**

在 `scripts/fetch-data.ts` 顶部 import 区追加：

```ts
import { computeOfficialFetchDates } from '../shared/backfill-window'
import { computeTrendSignals } from '../shared/estimate-signals'
```

- [ ] **Step 6: 类型检查**

Run: `bunx vue-tsc -b --noEmit 2>&1 | head`
Expected: 无类型错误。

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch-data.ts
git commit -m "feat: dynamic backfill window + sse/szse gap tracking"
```

---

## Task 7: buildHuijinEstimate 接入趋势信号

**Files:**
- Modify: `scripts/fetch-data.ts:988-1074`（`buildHuijinEstimate`）

- [ ] **Step 1: 在 `buildHuijinEstimate` 末尾为 anchored 点附加趋势信号**

`buildHuijinEstimate` 当前返回 `scale.map(...)` 的数组。在 `return scale.map((s) => {...})` 之后、函数返回前，对结果中的 anchored 点计算信号。把整个 `buildHuijinEstimate` 函数末尾的 `return scale.map((s) => { ... })` 改为先收集到变量 `result`，再附加信号后返回：

将函数末尾替换为（保留原有 map 逻辑不变，只改返回结构）：

```ts
  const result = scale.map((s) => {
    const report = disclosedByDate.get(s.date)
    const nav =
      nearestNav(navs, s.date) ??
      (s.totalSharesYi > 0 ? s.netAssetYi / s.totalSharesYi : null)

    if (report) {
      const huijinValueYi =
        nav != null ? (report.huijinShares * nav) / 1e8 : null
      return {
        date: s.date,
        netAssetYi: s.netAssetYi,
        totalSharesYi: s.totalSharesYi,
        huijinShares: report.huijinShares,
        huijinValueYi:
          huijinValueYi != null ? Number(huijinValueYi.toFixed(4)) : null,
        huijinPct: report.huijinPercent,
        isEstimated: false,
        estimateMethod: 'disclosed',
        netSubscriptionYi: s.netSubscriptionYi,
      }
    }

    if (
      latestAnchor &&
      s.date > latestAnchor.reportDate &&
      s.frequency === 'daily' &&
      s.totalSharesYi > 0
    ) {
      const totalShares = s.totalSharesYi * 1e8
      const clampTriggered = totalShares < latestAnchor.huijinShares
      const estShares = Math.round(
        clampTriggered ? totalShares : latestAnchor.huijinShares,
      )
      const huijinValueYi =
        nav != null ? Number(((estShares * nav) / 1e8).toFixed(4)) : null
      return {
        date: s.date,
        netAssetYi: s.netAssetYi,
        totalSharesYi: s.totalSharesYi,
        huijinShares: estShares,
        huijinValueYi,
        huijinPct: clampTriggered
          ? 100
          : Number(
              ((latestAnchor.huijinShares / totalShares) * 100).toFixed(2),
            ),
        isEstimated: true,
        estimateMethod: 'anchored',
        clampTriggered,
        netSubscriptionYi: s.netSubscriptionYi,
      }
    }

    return {
      date: s.date,
      netAssetYi: s.netAssetYi,
      totalSharesYi: s.totalSharesYi,
      huijinShares: null,
      huijinValueYi: null,
      huijinPct: null,
      isEstimated: false,
      estimateMethod: 'unavailable',
      netSubscriptionYi: s.netSubscriptionYi,
      unavailableReason: !latestAnchor
        ? '暂无汇金持仓披露'
        : s.date <= latestAnchor.reportDate
          ? '最近披露日及之前，仅展示正式披露点'
          : '非日频份额数据点，不推算汇金持仓',
    }
  })

  // 仅对 anchored 点计算趋势信号；输入为 anchored 点序列（按日期升序，已由 scale 排序保证）
  const anchoredIndices = result
    .map((p, i) => (p.estimateMethod === 'anchored' ? i : -1))
    .filter((i) => i >= 0)
  if (anchoredIndices.length) {
    const signalInputs = anchoredIndices.map((i) => {
      const p = result[i]!
      return {
        date: p.date,
        totalSharesYi: p.totalSharesYi,
        netSubscriptionYi: p.netSubscriptionYi ?? null,
        clampTriggered: p.clampTriggered,
      }
    })
    const signals = computeTrendSignals(signalInputs)
    anchoredIndices.forEach((i, k) => {
      const sig = signals[k]!
      result[i] = {
        ...result[i]!,
        shareTrend: sig.shareTrend,
        consecutiveDays: sig.consecutiveDays,
        shareChangePct5d: sig.shareChangePct5d,
        clampReliability: sig.clampReliability,
      }
    })
  }

  // 移除临时 netSubscriptionYi（已用于信号计算，HuijinEstimatePoint 不含该字段）
  return result.map(({ netSubscriptionYi: _omit, ...rest }) => rest)
```

> 注意：`HuijinEstimatePoint` 本身没有 `netSubscriptionYi` 字段，上述在 result 中临时挂载用于信号计算，最后解构移除。如 TypeScript 报多余字段，改为 `as` 中间类型处理。

- [ ] **Step 2: 类型检查**

Run: `bunx vue-tsc -b --noEmit 2>&1 | head -30`
Expected: 无类型错误。若 `netSubscriptionYi` 临时字段类型报错，将 `result` 声明为 `Array<HuijinEstimate & { netSubscriptionYi?: number | null }>`，其中 `type HuijinEstimate = EtfSnapshot['huijinEstimateHistory'][number]`（文件顶部已有该别名）。

- [ ] **Step 3: Commit**

```bash
git add scripts/fetch-data.ts
git commit -m "feat: attach trend signals to anchored huijin estimate points"
```

---

## Task 8: 审计扩展

**Files:**
- Modify: `scripts/data-audit.ts:91-122`（估算点校验段）、末尾 summary 输出

- [ ] **Step 1: 在 anchored 点校验分支加入趋势信号校验**

在 `data-audit.ts` 的 `} else if (point.estimateMethod === 'anchored') {` 分支内，`if (point.huijinValueYi != null ...)` 之后追加：

```ts
      // 趋势信号校验
      if (point.shareTrend != null && !['inflow', 'outflow', 'flat'].includes(point.shareTrend)) {
        errors.push(`${etf.code} ${point.date}: invalid shareTrend`)
      }
      if (point.consecutiveDays != null && (!Number.isFinite(point.consecutiveDays) || point.consecutiveDays < 1)) {
        errors.push(`${etf.code} ${point.date}: invalid consecutiveDays`)
      }
      if (point.shareChangePct5d != null && !finite(point.shareChangePct5d)) {
        errors.push(`${etf.code} ${point.date}: invalid shareChangePct5d`)
      }
      if (point.clampReliability != null && !['just_triggered', 'persistent', 'persistent_recovering'].includes(point.clampReliability)) {
        errors.push(`${etf.code} ${point.date}: invalid clampReliability`)
      }
      if (point.clampReliability != null && !point.clampTriggered) {
        errors.push(`${etf.code} ${point.date}: clampReliability set without clampTriggered`)
      }
```

- [ ] **Step 2: disclosed/unavailable 点不应带趋势信号**

在同文件 disclosed 分支（`if (report) {` 块内）追加：

```ts
      if (point.shareTrend != null || point.consecutiveDays != null || point.clampReliability != null) {
        errors.push(`${etf.code} ${point.date}: disclosed point must not carry trend signals`)
      }
```

在 unavailable 分支（最后的 `else` 块内）追加：

```ts
      if (point.shareTrend != null || point.consecutiveDays != null || point.clampReliability != null) {
        errors.push(`${etf.code} ${point.date}: unavailable point must not carry trend signals`)
      }
```

- [ ] **Step 3: shareFetchGaps 降级 warning**

在 `data-audit.ts` 的 `for (const etf of data.etfs)` 循环末尾（`if (etf.holderReports.length === 0) ...` 之后）追加：

```ts
  if (etf.source.shareFetchGaps) {
    const g = etf.source.shareFetchGaps
    const parts: string[] = []
    if (g.sseFailedDates?.length) parts.push(`SSE 失败 ${g.sseFailedDates.length} 日`)
    if (g.szseFailedRanges?.length) parts.push(`SZSE 失败 ${g.szseFailedRanges.length} 段`)
    if (parts.length) warnings.push(`${etf.code}: 份额抓取缺口 — ${parts.join('，')}`)
  }
```

- [ ] **Step 4: 类型检查**

Run: `bunx vue-tsc -b --noEmit 2>&1 | head`
Expected: 无类型错误。

- [ ] **Step 5: Commit**

```bash
git add scripts/data-audit.ts
git commit -m "test: audit huijin trend signals and share fetch gaps"
```

---

## Task 9: HuijinTrendChart 展示趋势信号

**Files:**
- Modify: `src/components/HuijinTrendChart.vue`

- [ ] **Step 1: 扩展 SeriesItem 与 tooltip 展示趋势文案**

在 `HuijinTrendChart.vue` 的 `interface SeriesItem` 增加字段：

```ts
interface SeriesItem {
  value: [string, number]
  estimated?: boolean
  clampTriggered?: boolean
  shareTrend?: 'inflow' | 'outflow' | 'flat'
  consecutiveDays?: number
  shareChangePct5d?: number | null
  clampReliability?: 'just_triggered' | 'persistent' | 'persistent_recovering'
}
```

修改 anchored 点 map（约 76-86 行）把这些字段带上：

```ts
    const estData = anchored
      .map((p) => {
        const v = anchoredValue(p)
        if (v == null) return null
        return {
          value: [p.date, v],
          estimated: true,
          clampTriggered: p.clampTriggered ?? false,
          shareTrend: p.shareTrend,
          consecutiveDays: p.consecutiveDays,
          shareChangePct5d: p.shareChangePct5d ?? null,
          clampReliability: p.clampReliability,
        } satisfies SeriesItem
      })
      .filter(Boolean) as SeriesItem[]
```

修改 tooltip `formatter` 中的 suffix 构造（约 129-133 行），把估算点的趋势文案拼进去：

```ts
          let suffix = ''
          if (p.data?.estimated) {
            const d = p.data
            const parts: string[] = ['份额锚定估算']
            if (d.clampTriggered) parts.push('⚠ clamp')
            if (d.shareTrend && d.shareTrend !== 'flat' && d.consecutiveDays) {
              const dir = d.shareTrend === 'inflow' ? '净流入' : '净流出'
              parts.push(`连续${d.consecutiveDays}日${dir}`)
            }
            if (d.shareChangePct5d != null) {
              parts.push(`5日${d.shareChangePct5d > 0 ? '+' : ''}${d.shareChangePct5d}%`)
            }
            if (d.clampReliability === 'persistent_recovering') parts.push('份额触底回升')
            suffix = ' · ' + parts.join(' / ')
          }
```

- [ ] **Step 2: 添加份额变化率次轴曲线**

在 `option` computed 中，`series` 数组构建完成后、`return` 之前，为每只有 anchored 数据的 ETF 追加一条次轴曲线。在 `yAxis` 改为双轴（主轴 + 次轴），并在循环里 push 次轴 series：

把 `yAxis` 字段替换为数组：

```ts
    yAxis: [
      {
        type: 'value',
        name: yName,
        nameTextStyle: { color: '#6b7c90', fontSize: 11 },
        ...axisStyle,
      },
      {
        type: 'value',
        name: '5日份额变化率 %',
        nameTextStyle: { color: '#6b7c90', fontSize: 11 },
        ...axisStyle,
        splitLine: { show: false },
      },
    ],
```

并在 `props.etfs.forEach` 循环末尾（anchored series push 之后）追加次轴 series：

```ts
    // 份额 5 日变化率次轴曲线
    const changeData = anchored
      .map((p) =>
        p.shareChangePct5d != null
          ? { value: [p.date, p.shareChangePct5d], itemStyle: { color } }
          : null,
      )
      .filter(Boolean) as { value: [string, number]; itemStyle: { color: string } }[]
    if (changeData.length) {
      series.push({
        name: `${e.categoryName} 份额变化率`,
        type: 'line',
        yAxisIndex: 1,
        showSymbol: false,
        lineStyle: { width: 1, opacity: 0.5 },
        itemStyle: { color },
        data: changeData,
        tooltip: { show: false },
      } as Record<string, unknown>)
    }
```

- [ ] **Step 3: 更新底部说明文案**

把模板里 `chart-note`（约 161 行）文案改为：

```html
  <p v-if="hasVerifiedPoint" class="chart-note">
    实点为基金年报/半年报「十大持有人」正式披露；最近披露期之后的虚线为份额锚定估算（假设汇金不主动赎回，tooltip 中 ⚠ 表示总份额已低于披露汇金份额）。次轴细线为近 5 日总份额变化率，用于判断份额流向。
  </p>
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `bunx vue-tsc -b --noEmit 2>&1 | head` 然后 `bun run build 2>&1 | tail -10`
Expected: 类型与构建均通过。

- [ ] **Step 5: Commit**

```bash
git add src/components/HuijinTrendChart.vue
git commit -m "feat: show share change rate sub-axis and trend tooltips"
```

---

## Task 10: EtfTable 份额趋势列

**Files:**
- Modify: `src/components/EtfTable.vue`

- [ ] **Step 1: rows computed 增加趋势字段**

在 `EtfTable.vue` 的 `rows` computed 中，`estClamped` 之后追加（约 62 行后）：

```ts
      estShareTrend: latestAnchored?.shareTrend ?? null,
      estConsecutiveDays: latestAnchored?.consecutiveDays ?? null,
      estChangePct5d: latestAnchored?.shareChangePct5d ?? null,
      estClampReliability: latestAnchored?.clampReliability ?? null,
```

- [ ] **Step 2: 模板新增"份额趋势"列**

在 `<thead>` 中"估算持仓"列之后追加 `<th class="num">份额趋势</th>`（约 151 行后）。

在 `<tbody>` 行内对应位置（估算持仓 `<td>` 之后，约 201 行后）追加：

```html
          <td
            class="num mono"
            :title="
              r.estShareTrend === 'inflow'
                ? '连续净流入，汇金占比被动稀释减缓'
                : r.estShareTrend === 'outflow'
                  ? '连续净流出，汇金占比被动上升'
                  : r.estChangePct5d != null
                    ? '份额持平'
                    : '无估算趋势'
            "
          >
            <template v-if="r.estShareTrend === 'inflow'">↑</template>
            <template v-else-if="r.estShareTrend === 'outflow'">↓</template>
            <template v-else>→</template>
            <span v-if="r.estConsecutiveDays && r.estShareTrend !== 'flat'">{{ r.estConsecutiveDays }}</span>
            <span v-if="r.estChangePct5d != null" class="muted">{{ r.estChangePct5d > 0 ? '+' : '' }}{{ r.estChangePct5d }}%</span>
            <span v-if="r.estClampReliability === 'persistent_recovering'" class="estimate-tag">回升</span>
          </td>
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `bunx vue-tsc -b --noEmit 2>&1 | head` 然后 `bun run build 2>&1 | tail -10`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src/components/EtfTable.vue
git commit -m "feat: add share trend column to etf table"
```

---

## Task 11: README 口径更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新汇金估算口径段落**

在 `README.md` 中找到关于份额锚定估算的段落（"汇金持仓趋势展示两类数据点…"），在其后追加一段：

```markdown
- 估算保持份额锚定口径不变（估算份额 = min(披露份额, 当日总份额)）。clamp 区间（总份额低于披露汇金份额）估算值为总份额上限、绝对值可靠性低。每个估算点附加趋势信号：份额流向（流入/流出）、连续同向天数、近 5 日总份额变化率、clamp 可靠性细分（`persistent_recovering` 表示长期 clamp 但份额触底回升，是汇金可能重新占主导的偏多信号）。趋势信号供方向参考，用于判断汇金"被稀释 / 被反稀释"，不代表汇金实际操作。
- 交易所日频份额回填窗口锚定到最近汇金披露日，确保披露日当天为交易所真实日频份额而非定期规模兜底；抓取缺口（重试用尽仍失败的日期/区间）记录在 `source.shareFetchGaps` 并在审计中提示，不静默丢弃。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update huijin estimate calibration with trend signals"
```

---

## Task 12: 集成验证

**Files:** 无（运行现有命令）

- [ ] **Step 1: 运行单测**

Run: `bun test scripts/`
Expected: `backfill-window.test.ts` 与 `estimate-signals.test.ts` 全部 PASS。

- [ ] **Step 2: 运行抓取**

Run: `bun run fetch 2>&1 | tail -30`
Expected: 控制台显示每只 ETF 的 `daily=` 份数应覆盖 2025-12-31 之后到最新交易日；无致命错误；若个别日期失败会打印 `失败 N 日` 但不中断。

- [ ] **Step 3: 运行审计**

Run: `bun run audit 2>&1 | tail -40`
Expected: `errors` 为空数组；`warnings` 中可能有 `份额抓取缺口` 提示（可接受）。估算点 `shareTrend`/`consecutiveDays` 等字段校验通过。

- [ ] **Step 4: 抽查 dashboard.json 数据**

Run: `node -e "const d=require('./data/dashboard.json'); for(const e of d.etfs){const a=e.huijinEstimateHistory.filter(p=>p.estimateMethod==='anchored'); const s=a.at(-1); console.log(e.code, 'anchored=',a.length, 'lastTrend=',s?.shareTrend, 'cons=',s?.consecutiveDays, 'pct5d=',s?.shareChangePct5d, 'clampRel=',s?.clampReliability, 'gaps=',JSON.stringify(e.source.shareFetchGaps))}"`
Expected: 有锚点的 5 只 ETF 显示非空趋势字段；科创50 anchored=0；gaps 多为 undefined（无缺口）或少量失败记录。

- [ ] **Step 5: 前端构建**

Run: `bun run build 2>&1 | tail -10`
Expected: 构建成功，`dist/` 生成。

- [ ] **Step 6: 最终提交（若有遗留改动）**

```bash
git add -A
git commit -m "chore: integration verify share precision + trend signals" --allow-empty
```

---

## Self-Review

**Spec 覆盖：**
- 第 1 节（份额精确化）：Task 2（回填窗口）+ Task 4（fetchText/nav 容错）+ Task 5/6（SSE/SZSE 容错 + gaps）+ Task 6 Step 3（main 调用）。✓
- 第 2 节（估算趋势信号）：Task 3（纯函数）+ Task 7（接入 buildHuijinEstimate）。✓
- 第 3 节（前端）：Task 9（HuijinTrendChart）+ Task 10（EtfTable）。✓
- 第 4 节（审计）：Task 8。✓
- README：Task 11。✓
- 集成验证：Task 12。✓

**占位符扫描：** 无 TBD/TODO；每步含完整代码或确切命令。✓

**类型一致性：** `shareTrend`/`consecutiveDays`/`shareChangePct5d`/`clampReliability` 在 types（Task1）、signals（Task3）、fetch（Task7）、audit（Task8）、前端（Task9/10）中字段名与取值一致。`shareFetchGaps` 在 types（Task1）、fetch（Task6）、audit（Task8）一致。`computeOfficialFetchDates`/`computeTrendSignals` 签名在 Task2/3 定义、Task6/7 调用一致。✓
