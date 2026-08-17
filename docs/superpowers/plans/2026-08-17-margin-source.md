# 两融数据源接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入沪深两融日频数据（融资余额、融资买入额、两融余额、融资余额占流通市值比），作为散户杠杆情绪指标加入「散户情绪反向」面板，与申赎温度、交投温度并列第三维度「杠杆温度」。

**Architecture:** 新增 `scripts/sources/margin.ts` 抓取东财 datacenter `RPTA_RZRQ_LSHJ`（市场合计口径，已实测可用，单页 800 条、两页覆盖 6.6 年）；`DashboardData` 新增 `marginHistory` 市场级序列（与 `marketActiveCapHistory` 同模式，抓取失败沿用上次快照）；前端 `retailSignals.ts` 扩展杠杆温度（融资余额 5 日变化率的 250 日分位 + 融资买入额占比分位）。

**Tech Stack:** 同现有栈。接口已实测：

- URL：`https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&sortColumns=DIM_DATE&sortTypes=-1&pageNumber=N&pageSize=800`
- 字段：`DIM_DATE`（日期）、`RZYE`（融资余额，元）、`RZMRE`（融资买入额，元）、`RZRQYE`（两融余额，元）、`RZYEZB`（融资余额/流通市值，%）
- 量级已验证：最新 RZYE 2.648 万亿、单日融资买入 2009 亿，与公开报道吻合
- 历史 1600 个交易日（2020-01 → 2026-08），翻页正确

**口径决策：**

1. **市场合计口径**（非分板块）：两融是全市场情绪，不拆分到六只宽基。
2. **主指标——融资买入额占成交额比**（RZMRE / 沪深成交额）：现有 `marketActiveCapHistory.marketAmountYi` 已有日成交额（亿元），可直接复用算比率。该比率剔除市场规模增长趋势，比融资余额绝对值更适合分位化。比率历史从两序列公共日起算。
3. **副指标——融资余额 5 日变化率**：杠杆资金加减仓速度。
4. **温度分位**：与申赎温度同款 250 日回看、≥85 高热 / ≤15 冰点。
5. **数据存储只存 4 个字段**（date、rzye、rzmre、rzrqye、rzyezb——5 个），不存全部字段。

---

### Task 1: 类型层 + 抓取源

**Files:**
- Modify: `shared/types.ts`（MarginPoint + DashboardData.marginHistory）
- Create: `scripts/sources/margin.ts` + `scripts/sources/margin.test.ts`

- [ ] **Step 1: 类型定义**

`shared/types.ts` 在 `MarketReportEvent` 之前加：

```ts
/** 沪深两融市场合计日频点。 */
export interface MarginPoint {
  date: string
  /** 融资余额（元） */
  rzye: number
  /** 融资买入额（元） */
  rzmre: number
  /** 两融余额（元） */
  rzrqye: number
  /** 融资余额占流通市值比（%） */
  rzyezb: number | null
}
```

`DashboardData` 在 `marketActiveCapHistory` 之后加：

```ts
  /** 沪深两融市场合计历史；抓取失败时沿用上次快照 */
  marginHistory?: MarginPoint[]
```

（可选字段：旧快照反序列化不报错，前端防御 `?? []`。）

- [ ] **Step 2: 写解析函数失败测试**

`scripts/sources/margin.test.ts`：

```ts
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
```

- [ ] **Step 3: 运行确认失败**

Run: `bun test scripts/sources/margin.test.ts`
Expected: FAIL，`Cannot find module './margin'`

- [ ] **Step 4: 实现 margin.ts**

```ts
// ---------- 沪深两融市场合计（东财 datacenter RPTA_RZRQ_LSHJ）----------
import type { MarginPoint } from '../../shared/types'
import { fetchJson, sleep } from './http'

/** 单页最大返回 800 条（接口上限）。 */
const PAGE_SIZE = 800
/** 拉取页数：2 页约 1600 交易日 ≈ 6.6 年，覆盖 250 日分位绰绰有余。 */
const PAGES = 2
const REFERER = 'https://data.eastmoney.com/rzrq/'

interface RawMarginRow {
  DIM_DATE: string
  RZYE: number | null
  RZMRE: number | null
  RZRQYE: number | null
  RZYEZB: number | null
}

interface MarginResponse {
  result?: {
    data?: RawMarginRow[] | null
  } | null
  success?: boolean
}

/** 东财原始行 → MarginPoint；日期非法或 RZYE 非正的行剔除，输出升序。 */
export function normalizeMarginRows(rows: RawMarginRow[]): MarginPoint[] {
  return rows
    .map((row) => ({
      date: String(row.DIM_DATE ?? '').slice(0, 10),
      rzye: Number(row.RZYE),
      rzmre: Number(row.RZMRE),
      rzrqye: Number(row.RZRQYE),
      rzyezb: row.RZYEZB == null ? null : Number(row.RZYEZB),
    }))
    .filter(
      (p) =>
        /^\d{4}-\d{2}-\d{2}$/.test(p.date) &&
        Number.isFinite(p.rzye) &&
        p.rzye > 0 &&
        Number.isFinite(p.rzmre) &&
        p.rzmre >= 0 &&
        Number.isFinite(p.rzrqye) &&
        p.rzrqye > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 拉取两融市场合计历史（升序）。任一页失败抛出——两融是市场级序列，
 * 半截历史会让分位失真，失败由调用方沿用上次快照。
 */
export async function fetchMarginHistory(): Promise<MarginPoint[]> {
  const all: RawMarginRow[] = []
  for (let page = 1; page <= PAGES; page++) {
    if (page > 1) await sleep(500)
    const url =
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ` +
      `&columns=DIM_DATE,RZYE,RZMRE,RZRQYE,RZYEZB&sortColumns=DIM_DATE&sortTypes=-1` +
      `&pageNumber=${page}&pageSize=${PAGE_SIZE}`
    const json = await fetchJson<MarginResponse>(url, REFERER)
    const rows = json.result?.data ?? []
    if (rows.length === 0) {
      throw new Error(`两融数据第 ${page} 页返回空`)
    }
    all.push(...rows)
  }
  const points = normalizeMarginRows(all)
  // 两页边界可能重叠一日，去重
  const byDate = new Map(points.map((p) => [p.date, p]))
  const unique = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  if (unique.length < 250) {
    throw new Error(`两融历史仅 ${unique.length} 日，不足以做 250 日分位`)
  }
  return unique
}
```

- [ ] **Step 5: 测试通过 + 类型检查**

Run: `bun test scripts/sources/margin.test.ts && bun run build`
Expected: 3 用例 PASS；构建成功

- [ ] **Step 6: Commit**

```bash
git add shared/types.ts scripts/sources/margin.ts scripts/sources/margin.test.ts
git commit -m "feat(margin): 新增两融市场合计数据源"
```

---

### Task 2: fetch 接线 + 历史合并

**Files:**
- Modify: `scripts/fetch-data.ts`

- [ ] **Step 1: import 与抓取调用**

1a. import 区加：

```ts
import { fetchMarginHistory } from './sources/margin'
```

1b. 在 `console.log('抓取行业板块日线…')` 与 `fetchSectorTrend()` 之间（两融与板块不同域名，可紧邻）插入：

```ts
  console.log('抓取沪深两融市场合计…')
  let marginHistory = previous?.marginHistory ?? []
  try {
    const fetched = await fetchMarginHistory()
    marginHistory = fetched
    console.log(`两融历史 ${fetched.length} 日（${fetched[0]!.date} → ${fetched.at(-1)!.date}）`)
  } catch (error) {
    console.warn('两融抓取失败，沿用上次快照', error)
  }
```

1c. `dashboard` 对象在 `marketActiveCapQuality` 之后加：

```ts
    marginHistory,
```

- [ ] **Step 2: 全量测试 + 构建 + 真实抓取**

Run: `bun test && bun run build`
Expected: 全 PASS

Run: `bun run fetch`
Expected: 控制台出现「两融历史 ~1600 日（2020-01-08 → 2026-08-14）」；抓取失败时出现「沿用上次快照」且其余流程正常。

检查：

```bash
bun -e "const d = await Bun.file('data/dashboard.json').json(); const m = d.marginHistory ?? []; console.log('点数:', m.length, '| 末点:', JSON.stringify(m.at(-1)))"
```

Expected: 点数 ≥ 250，末点含 rzye/rzmre/rzrqye/rzyezb。

- [ ] **Step 3: Commit**

```bash
git add scripts/fetch-data.ts data/dashboard.json public/dashboard.json
git commit -m "feat(margin): 抓取管线接入两融历史"
```

---

### Task 3: 判定层——杠杆温度 + 面板

**Files:**
- Modify: `src/utils/retailSignals.ts` + `src/utils/retailSignals.test.ts`
- Modify: `src/components/RetailPanel.vue`
- Modify: `src/styles/main.css`
- Modify: `src/App.vue`（传 marginHistory prop）

- [ ] **Step 1: 写失败测试**

`retailSignals.test.ts` 追加（import 加 `marginTemperature`、`judgeRetailSentiment` 的 etfs 参数旁——注意主函数签名扩展为 `(etfs, marginHistory?)`；`makeEtf` 不变）：

```ts
import type { MarginPoint } from '../../shared/types'

function marginPoint(date: string, rzmre: number): MarginPoint {
  return { date, rzye: 2.5e12, rzmre, rzrqye: 2.55e12, rzyezb: 2.5 }
}

describe('marginTemperature', () => {
  test('买入占比分位边界', () => {
    expect(marginTemperature(null).label).toBe('样本不足')
    expect(marginTemperature(90).label).toBe('杠杆过热')
    expect(marginTemperature(85).label).toBe('杠杆过热')
    expect(marginTemperature(70).label).toBe('加杠杆')
    expect(marginTemperature(50).label).toBe('常态')
    expect(marginTemperature(15).label).toBe('降杠杆')
    expect(marginTemperature(10).label).toBe('降杠杆')
  })
})

describe('judgeRetailSentiment 两融维度', () => {
  test('空 marginHistory 不崩溃且为样本不足', () => {
    const r = judgeRetailSentiment([makeEtf({ name: '沪深300' })], [])
    expect(r.marginLabel).toBe('样本不足')
  })

  test('40 日融资买入占比末日冲高 → 杠杆过热', () => {
    const etf = makeEtf({ name: '沪深300' })
    const margin = Array.from({ length: 40 }, (_, i) =>
      marginPoint(`2026-${String(Math.floor(i / 28) + 6).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, i === 39 ? 4000e8 : 2000e8),
    )
    const r = judgeRetailSentiment([etf], margin)
    expect(r.marginPercentile).toBe(100)
    expect(r.marginLabel).toBe('杠杆过热')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test src/utils/retailSignals.test.ts`
Expected: FAIL，`marginTemperature` 未导出

- [ ] **Step 3: 实现**

3a. `retailSignals.ts` import 加 `MarginPoint` 类型与 `MarketActiveCapPoint`（计算买入占比需成交额序列）：

```ts
import type { EtfSnapshot, MarginPoint, MarketActiveCapPoint } from '../../shared/types'
```

3b. 常量加：

```ts
/** 杠杆分位 ≥ 此值视为过热。 */
export const MARGIN_HOT = 85
/** 杠杆分位 ≤ 此值视为降杠杆。 */
export const MARGIN_COLD = 15
```

3c. 函数（`turnoverLabel` 之后）：

```ts
export interface MarginTemperature {
  label: string
  /** 融资买入额占成交额比率的 250 日分位 */
  buyRatioPercentile: number | null
  /** 融资余额 5 日变化率（%），正=加仓负=去杠杆 */
  balanceChangePct5d: number | null
}

/** 杠杆温度：融资买入占比分位为主标签。 */
export function marginTemperature(percentile: number | null): { label: string } {
  if (percentile == null) return { label: '样本不足' }
  if (percentile >= MARGIN_HOT) return { label: '杠杆过热' }
  if (percentile >= 65) return { label: '加杠杆' }
  if (percentile <= MARGIN_COLD) return { label: '降杠杆' }
  if (percentile <= 35) return { label: '去杠杆' }
  return { label: '常态' }
}
```

3d. 主函数签名与计算（`judgeRetailSentiment(etfs, marginHistory: MarginPoint[] = [], marketHistory: MarketActiveCapPoint[] = [])`）：

```ts
  // 杠杆温度：融资买入额 / 沪深成交额（marketAmountYi 亿元）
  const amountByDate = new Map(
    marketHistory.map((p) => [p.date, p.marketAmountYi]),
  )
  const buyRatioSeries = marginHistory
    .map((p) => {
      const amountYuan = amountByDate.get(p.date)
      if (amountYuan == null || amountYuan <= 0) return null
      return { date: p.date, ratio: (p.rzmre / (amountYuan * 1e8)) * 100 }
    })
    .filter((x): x is { date: string; ratio: number } => x != null)
  const lastRatio = buyRatioSeries.at(-1)?.ratio ?? null
  const ratioHistory = buyRatioSeries
    .slice(-(TURNOVER_LOOKBACK + 1), -1)
    .map((x) => x.ratio)
  const marginPercentile =
    lastRatio != null && ratioHistory.length >= TURNOVER_MIN_HISTORY
      ? percentileRank(lastRatio, ratioHistory)
      : null
  const marginTemp = marginTemperature(marginPercentile)
  let marginBalanceChange5d: number | null = null
  if (marginHistory.length >= 6) {
    const last = marginHistory.at(-1)!
    const base = marginHistory.at(-6)!
    if (base.rzye > 0) {
      marginBalanceChange5d = Number((((last.rzye / base.rzye) - 1) * 100).toFixed(2))
    }
  }
```

`RetailVerdict` 加字段：`marginLabel: string`、`marginPercentile: number | null`、`marginBalanceChangePct5d: number | null`；返回对象带上。cautions 加 `'两融是全市场口径，无法拆分到宽基 ETF 成分'`。

3e. 面板：`RetailPanel.vue` props 加 `marginHistory?: MarginPoint[]`、`marketHistory?: MarketActiveCapPoint[]`；`judgeRetailSentiment(props.etfs, props.marginHistory ?? [], props.marketHistory ?? [])`；第六格：

```html
      <div class="force-verdict-gate" :data-hot="verdict.marginLabel">
        <div class="insight-label">杠杆温度</div>
        <div class="insight-value">{{ marginText }}</div>
        <div class="insight-detail muted">融资买入占成交额比分位（250 日）</div>
      </div>
```

`marginText` computed 同 temperatureText 模式。grid 列改 `repeat(5, ...)`。

3f. `App.vue` 传参：`<RetailPanel v-if="data" :etfs="etfs" :margin-history="data.marginHistory ?? []" :market-history="data.marketActiveCapHistory ?? []" />`

3g. 样式：杠杆过热/加杠杆 → `var(--up)`；降杠杆/去杠杆 → `var(--accent-2)`。

- [ ] **Step 4: 全量验证 + 浏览器手动验证**

Run: `bun test && bun run build`
Expected: 全 PASS

Run: `bun run dev:vite` + 浏览器检查第六格渲染「杠杆温度」实际分位（两融历史已 6.6 年，应立即有值而非样本不足）。

- [ ] **Step 5: Commit**

```bash
git add src/utils/retailSignals.ts src/utils/retailSignals.test.ts src/components/RetailPanel.vue src/styles/main.css src/App.vue
git commit -m "feat(retail): 面板新增两融杠杆温度"
```

---

### Task 4: README + 收尾

- [ ] **Step 1: README 数据来源表加行**

```markdown
| 沪深两融市场合计 | 东方财富 datacenter `RPTA_RZRQ_LSHJ`（融资余额/买入额/两融余额） |
```

散户情绪反向章节加：

```markdown
- **杠杆温度**：融资买入额占沪深成交额比率在 250 日回看内的分位，≥ 85 杠杆过热、≤ 15 降杠杆。两融以个人投资者为主，是散户杠杆情绪的直接读数；但为全市场口径，无法拆分到宽基成分。
```

- [ ] **Step 2: 全量验证 + Commit**

Run: `bun test && bun run build`
Expected: 全 PASS

```bash
git add README.md
git commit -m "docs(margin): 补充两融杠杆温度口径说明"
```

---

## Self-Review 结论

1. **覆盖检查**：优先级 3 两融全覆盖（类型→源→接线→判定→面板→文档）。三维度情绪体系（申赎/交投/杠杆）完整落地。
2. **占位符扫描**：无 TBD；代码完整。
3. **类型一致性**：`MarginPoint` Task 1 定义、Task 2/3 消费；`marginTemperature` 返回 `{label}` 与测试一致；`TURNOVER_LOOKBACK/TURNOVER_MIN_HISTORY` 复用既有常量（语义同为 250/30，命名耦合可接受——若嫌混淆可在 T3 提为 `PERCENTILE_LOOKBACK` 别名）。
4. **风险预判**：两融接口与 push2 不同域名（datacenter-web），无封禁联动风险；买入占比依赖 `marketAmountYi` 日期对齐——两融日期为交易所口径，与 0AMV 成交额日期可能差一日（T+1 披露），公共日交集天然过滤，未对齐日不入序列。
