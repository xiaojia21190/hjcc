# 换手率入库与历史积累 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为六大宽基 ETF 增加场内**换手率与成交额**的每日快照入库与历史积累，作为散户交投情绪代理；在看板「散户情绪反向」面板中新增「交投温度」格与明细列。

**Architecture:** 抓取端在 ETF 行情快照链路上新增一次 `ulist.np` 批量请求（6 只一包，已实测可用），把 `f8`（换手率 %，fltt=2 下已是真实值）与 `f6`（成交额，元）写入 `EtfQuote` 新字段；历史积累复用现有「上次快照合并」模式——`EtfSnapshot` 新增 `turnoverHistory`，每次抓取 append 当日点、按日期去重。前端 `retailSignals.ts` 扩展交投温度（换手率 250 日分位中位数）。**不新增数据源域名**（push2delay 已在用），kline 路径封禁不影响本方案。

**Tech Stack:** 同现有栈。接口已实测：`push2delay.eastmoney.com/api/qt/ulist.np/get?secids=...&fltt=2&fields=f12,f14,f2,f3,f6,f8`，f8=3.46 已除以 100（用 510300 份额 236.8 亿份 × 价格 4.726 交叉验证：39.86 亿 / 4.726 / 236.8 ≈ 3.56% ≈ f8，吻合）。

**口径决策：**

1. **换手率**：f8 = 当日场内成交量 / 基金总份额。ETF 的场内换手反映二级市场交投热度（散户交投为主），与申赎（一级市场）互补——申赎是「进出场」，换手是「倒手频率」。
2. **历史从今天开始积累**：ulist.np 只有实时快照，无历史。历史分位在积累不足 30 日前显示「样本不足」，与现有 honest 口径一致。
3. **跨快照去重**：同一天多次抓取只保留最后一次（当日盘中重跑 fetch 以最新为准）。
4. **换手率缺失不阻塞**：单只失败置 null，面板显示「—」。

---

### Task 1: 类型层——EtfQuote 扩展 + TurnoverPoint + EtfSnapshot 字段

**Files:**
- Modify: `shared/types.ts:20-30`（EtfQuote）与 `shared/types.ts:170-`（EtfSnapshot）

- [ ] **Step 1: 扩展 EtfQuote**

在 `EtfQuote` 的 `floatCap` 之后加：

```ts
  /** 当日场内换手率（%），fltt=2 下为真实值；缺失为 null */
  turnoverPct?: number | null
  /** 当日场内成交额（元）；缺失为 null */
  amountYuan?: number | null
```

- [ ] **Step 2: 新增 TurnoverPoint 与 EtfSnapshot 字段**

在 `EtfQuote` 定义之后加：

```ts
/** 场内换手率历史点；由每日快照 append 积累，无回填。 */
export interface TurnoverPoint {
  date: string
  /** 场内换手率（%），f8 口径 */
  turnoverPct: number | null
  /** 场内成交额（元） */
  amountYuan: number | null
}
```

在 `EtfSnapshot` 的 `navHistory` 之后加：

```ts
  /** 场内换手率历史（每日快照积累，无历史回填） */
  turnoverHistory: TurnoverPoint[]
```

- [ ] **Step 3: 类型检查**

Run: `bun run build 2>&1 | head -20`
Expected: 报错——所有构造 `EtfQuote`/`EtfSnapshot` 的地方缺新字段或类型不匹配（TS 允许可选字段缺失，故 EtfQuote 的 `turnoverPct?` 不会报；`EtfSnapshot.turnoverHistory` 非可选，会报）。记录报错文件清单，供 Task 2 修复。

- [ ] **Step 4: Commit**

```bash
git add shared/types.ts
git commit -m "feat(turnover): 扩展快照类型支持场内换手率"
```

---

### Task 2: 抓取端——ulist 批量换手快照 + 历史合并

**Files:**
- Modify: `scripts/sources/eastmoney.ts`（新增 fetchTurnoverSnapshot）
- Create: `scripts/lib/turnover.ts` + `scripts/lib/turnover.test.ts`（合并纯函数）
- Modify: `scripts/fetch-data.ts`（fetch 主流程接线 + buildEtfSnapshot 传递）

- [ ] **Step 1: 写合并纯函数的失败测试**

`scripts/lib/turnover.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test scripts/lib/turnover.test.ts`
Expected: FAIL，`Cannot find module './turnover'`

- [ ] **Step 3: 实现合并函数**

`scripts/lib/turnover.ts`：

```ts
/** 场内换手率历史合并：previous 为上次快照积累，current 为本次抓取点。 */
import type { TurnoverPoint } from '../../shared/types'

export function mergeTurnoverHistory(
  previous: TurnoverPoint[],
  current: TurnoverPoint[],
): TurnoverPoint[] {
  const byDate = new Map(previous.map((point) => [point.date, point]))
  for (const point of current) byDate.set(point.date, point)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}
```

Run: `bun test scripts/lib/turnover.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 4: eastmoney.ts 新增批量换手快照**

在 `fetchQuotesByCandidates` 函数之后加：

```ts
// ---------- 场内换手率快照（push2delay ulist.np 批量）----------

interface UlistResponse {
  data?: {
    diff?: {
      f12: string
      f14: string
      f2: number | string
      f3: number | string
      f6: number | string
      f8: number | string
    }[]
  } | null
}

const TURNOVER_HOSTS = [
  'https://push2delay.eastmoney.com',
  'https://push2.eastmoney.com',
]

/**
 * 批量拉取指定代码的实时换手率与成交额。
 * f8 在 fltt=2 下已是真实百分数（如 3.46 = 3.46%），无需再除以 100；
 * 已用 510300 份额/价格交叉验证口径（场内成交量 / 基金总份额）。
 * 返回 code → {turnoverPct, amountYuan}；失败的代码不出现在结果里。
 */
export async function fetchTurnoverSnapshot(
  codes: string[],
  asOfDate: string,
): Promise<Map<string, { date: string; turnoverPct: number | null; amountYuan: number | null }>> {
  const out = new Map<string, { date: string; turnoverPct: number | null; amountYuan: number | null }>()
  if (codes.length === 0) return out
  const secids = codes
    .map((code) => `${code.startsWith('15') || code.startsWith('16') ? '0' : '1'}.${code}`)
    .join(',')
  let lastError: unknown = null
  for (const host of TURNOVER_HOSTS) {
    try {
      const url = `${host}/api/qt/ulist.np/get?secids=${secids}&fltt=2&fields=f12,f14,f2,f3,f6,f8`
      const json = await fetchJson<UlistResponse>(url, 'https://quote.eastmoney.com/')
      const rows = json.data?.diff ?? []
      if (rows.length === 0) throw new Error(`${host} ulist 返回空 diff`)
      for (const row of rows) {
        const num = (v: number | string | undefined) =>
          v === '-' || v == null || v === '' ? null : Number(v)
        out.set(String(row.f12), {
          date: asOfDate,
          turnoverPct: num(row.f8),
          amountYuan: num(row.f6),
        })
      }
      return out
    } catch (error) {
      lastError = error
    }
  }
  console.warn('换手率快照两域名均失败', lastError)
  return out
}
```

- [ ] **Step 5: fetch-data.ts 接线**

5a. import 区加：

```ts
import { fetchTurnoverSnapshot } from './sources/eastmoney'
import { mergeTurnoverHistory } from './lib/turnover'
import type { TurnoverPoint } from '../shared/types'
```

5b. 在 `const picked = await pickLargestPerCategory(universe)`（约 413 行）之后、`console.log('抓取交易所 ETF 每日总份额…')` 之前插入：

```ts
  // 场内换手率快照：6 只一包，一次 ulist 请求；失败不阻塞主流程
  const turnoverAsOf = marketActiveCapHistory.at(-1)?.date ?? null
  const turnoverSnapshot = turnoverAsOf
    ? await fetchTurnoverSnapshot(
        picked.map((p) => p.quote.code),
        turnoverAsOf,
      )
    : new Map<string, { date: string; turnoverPct: number | null; amountYuan: number | null }>()
  console.log(
    `场内换手率快照 ${turnoverSnapshot.size}/${picked.length} 只（asOf=${turnoverAsOf ?? '无交易日'}）`,
  )
```

5c. `buildEtfSnapshot` 签名（约 209 行）加参数：

```ts
  turnoverHistoryMerged: TurnoverPoint[],
```

5d. `buildEtfSnapshot` 返回对象（`huijinEstimateHistory` 之后）加：

```ts
    turnoverHistory: turnoverHistoryMerged,
```

5e. 调用处（约 434 行）改为：

```ts
      const snap = await buildEtfSnapshot(
        p.category,
        p.quote,
        officialShareHistories.get(p.quote.code) ?? [],
        previous?.etfs.find((e) => e.code === p.quote.code),
        shareFetchGaps.get(p.quote.code),
        mergeTurnoverHistory(
          previous?.etfs.find((e) => e.code === p.quote.code)?.turnoverHistory ?? [],
          turnoverSnapshot.has(p.quote.code) ? [turnoverSnapshot.get(p.quote.code)!] : [],
        ),
      )
```

同时给 `EtfQuote` 的 quote 数据带上换手（在 `universe = universeFetched.map(...)` 之后，picked 选出后，把 snapshot 回填 quote）——在 5b 的 console.log 之后再插入：

```ts
  for (const p of picked) {
    const t = turnoverSnapshot.get(p.quote.code)
    if (t) {
      p.quote.turnoverPct = t.turnoverPct
      p.quote.amountYuan = t.amountYuan
    }
  }
```

- [ ] **Step 6: 全量测试 + 构建**

Run: `bun test && bun run build`
Expected: 测试全 PASS；构建成功（Task 1 的类型缺口已在 5d 补齐）

注意：`scripts/lib/payload.test.ts` 等既有测试若构造 EtfSnapshot 时缺 `turnoverHistory` 字段导致类型报错，在对应 fixture 里补 `turnoverHistory: []`。

- [ ] **Step 7: 真实抓取验证**

Run: `bun run fetch`
Expected:
- 控制台出现「场内换手率快照 6/6 只」
- `data/dashboard.json` 中每只 ETF 有 `turnoverHistory` 数组（首日 1 点）
- 抓取总时长无明显回退（多了一次 ulist 请求，<1s）

检查命令：

```bash
bun -e "const d = await Bun.file('data/dashboard.json').json(); for (const e of d.etfs) console.log(e.categoryName, JSON.stringify(e.turnoverHistory)); console.log('quote 换手:', d.etfs.map(e => e.code + '=' + e.quote.turnoverPct).join(', '))"
```

- [ ] **Step 8: Commit**

```bash
git add scripts/sources/eastmoney.ts scripts/lib/turnover.ts scripts/lib/turnover.test.ts scripts/fetch-data.ts
git commit -m "feat(turnover): 抓取端入库场内换手率快照与历史合并"
```

---

### Task 3: 判定层扩展——交投温度 + 面板列

**Files:**
- Modify: `src/utils/retailSignals.ts` + `src/utils/retailSignals.test.ts`
- Modify: `src/components/RetailPanel.vue`
- Modify: `src/styles/main.css`（如需）

- [ ] **Step 1: 写失败测试**

在 `retailSignals.test.ts` 追加（文件顶部 import 处加 `turnoverLabel`；`makeEtf` 的返回对象在 `navHistory: []` 之后补 `turnoverHistory: partial.turnover ?? []`，参数类型加 `turnover?: { date: string; turnoverPct: number | null; amountYuan: number | null }[]`）：

```ts
describe('turnoverLabel', () => {
  test('交投温度边界', () => {
    expect(turnoverLabel(null)).toBe('样本不足')
    expect(turnoverLabel(90)).toBe('亢奋')
    expect(turnoverLabel(85)).toBe('亢奋')
    expect(turnoverLabel(70)).toBe('活跃')
    expect(turnoverLabel(50)).toBe('常态')
    expect(turnoverLabel(15)).toBe('低迷')
    expect(turnoverLabel(10)).toBe('低迷')
  })
})

describe('judgeRetailSentiment 交投温度', () => {
  test('换手历史不足 30 日为样本不足', () => {
    const etf = makeEtf({
      name: '沪深300',
      turnover: Array.from({ length: 10 }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        turnoverPct: 3,
        amountYuan: 4e9,
      })),
    })
    const r = judgeRetailSentiment([etf])
    expect(r.turnoverLabel).toBe('样本不足')
    expect(r.turnoverPercentile).toBeNull()
  })

  test('40 日恒定 3% 换手 + 末日 12% → 亢奋 100 分位', () => {
    const turnover = Array.from({ length: 40 }, (_, i) => ({
      date: `2026-${String(Math.floor(i / 28) + 6).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      turnoverPct: i === 39 ? 12 : 3,
      amountYuan: 4e9,
    }))
    const r = judgeRetailSentiment([makeEtf({ name: '沪深300', turnover })])
    expect(r.turnoverPercentile).toBe(100)
    expect(r.turnoverLabel).toBe('亢奋')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test src/utils/retailSignals.test.ts`
Expected: FAIL，`turnoverLabel` 未导出

- [ ] **Step 3: 实现**

`retailSignals.ts`：

3a. 常量区加：

```ts
/** 换手率分位回看窗口（交易日）。 */
export const TURNOVER_LOOKBACK = 250
/** 换手历史少于此天数不做分位（历史从接入日起积累）。 */
export const TURNOVER_MIN_HISTORY = 30
/** 换手分位 ≥ 此值视为亢奋。 */
export const TURNOVER_HOT = 85
/** 换手分位 ≤ 此值视为低迷。 */
export const TURNOVER_COLD = 15
```

3b. `turnoverLabel` 函数（`temperatureLabel` 之后）：

```ts
/** 交投温度标签（场内换手率分位）；null 表示样本不足。 */
export function turnoverLabel(percentile: number | null): string {
  if (percentile == null) return '样本不足'
  if (percentile >= TURNOVER_HOT) return '亢奋'
  if (percentile >= 65) return '活跃'
  if (percentile <= TURNOVER_COLD) return '低迷'
  if (percentile <= 35) return '清淡'
  return '常态'
}
```

3c. `RetailVerdict` 接口加字段：

```ts
  /** 场内换手率分位中位数对应的交投温度。 */
  turnoverLabel: string
  /** 换手分位中位数（0-100）。 */
  turnoverPercentile: number | null
```

3d. `RetailEtfRow` 加字段：

```ts
  /** 最新场内换手率（%）。 */
  turnoverPct: number | null
  /** 换手率 250 日分位；历史不足为 null。 */
  turnoverPercentile: number | null
```

3e. `buildRow` 内（`netSubPercentile` 计算后）加：

```ts
  const turnoverHistory = etf.turnoverHistory ?? []
  const lastTurnover = turnoverHistory.at(-1)
  const turnoverHistoryRates = turnoverHistory
    .slice(-(TURNOVER_LOOKBACK + 1), -1)
    .map((p) => p.turnoverPct)
    .filter((v): v is number => v != null)
  const turnoverPercentile =
    lastTurnover?.turnoverPct != null &&
    turnoverHistoryRates.length >= TURNOVER_MIN_HISTORY
      ? percentileRank(lastTurnover.turnoverPct, turnoverHistoryRates)
      : null
```

row 对象加 `turnoverPct: lastTurnover?.turnoverPct ?? null, turnoverPercentile`。

3f. 主函数汇总（`tempPercentile` 计算后）加：

```ts
  const turnoverPct = median(
    rows.map((r) => r.turnoverPercentile).filter((v): v is number => v != null),
  )
```

返回对象加 `turnoverLabel: turnoverLabel(turnoverPct), turnoverPercentile: turnoverPct`。

（注意命名冲突：模块级函数 `turnoverLabel` 与接口字段同名——返回对象里 `turnoverLabel: turnoverLabel(turnoverPct)` 合法，但为清晰起见实现时主函数内局部变量命名为 `turnoverTempLabel`，避免阅读混淆。）

3g. cautions 追加一条（主函数 cautions.push 处）：

```ts
  cautions.push('换手率历史自接入日起积累，分位在积累不足 30 日时不可用')
```

- [ ] **Step 4: 面板展示**

`RetailPanel.vue`：

4a. 现有第四格「其他资金存量」之后新增第五格（grid 列改为 5 列——样式见 4c）：

```html
      <div class="force-verdict-gate" :data-hot="verdict.turnoverLabel">
        <div class="insight-label">交投温度</div>
        <div class="insight-value">{{ turnoverText }}</div>
        <div class="insight-detail muted">场内换手率中位分位（250 日回看）</div>
      </div>
```

4b. script 区 `temperatureText` 之后加：

```ts
const turnoverText = computed(() => {
  const v = verdict.value
  return v.turnoverPercentile == null
    ? v.turnoverLabel
    : `${v.turnoverLabel} · ${v.turnoverPercentile.toFixed(0)} 分位`
})
```

明细表加一列（thead 加 `<th>换手%</th>`，tbody 对应位置加）：

```html
          <td>{{ row.turnoverText }}</td>
```

rows computed 里每行加：

```ts
    turnoverText:
      row.turnoverPct == null
        ? '—'
        : `${row.turnoverPct.toFixed(2)}%`,
```

4c. `main.css` 的 `.retail-grid` 处（force-verdict-grid 是 1.2fr + 3 列，5 格会溢出）加覆盖：

```css
.retail-grid {
  grid-template-columns: 1.2fr repeat(4, minmax(0, 1fr));
}
```

以及交投温度着色（追加到既有 retail 样式块）：

```css
.retail-grid .force-verdict-gate[data-hot='亢奋'] .insight-value,
.retail-grid .force-verdict-gate[data-hot='活跃'] .insight-value {
  color: var(--up);
}

.retail-grid .force-verdict-gate[data-hot='低迷'] .insight-value,
.retail-grid .force-verdict-gate[data-hot='清淡'] .insight-value {
  color: var(--accent-2);
}
```

- [ ] **Step 5: 全量验证**

Run: `bun test && bun run build`
Expected: 全 PASS

- [ ] **Step 6: 浏览器手动验证**

Run: `bun run dev:vite`，打开看板确认：
- 「散户情绪反向」面板出现第五格「交投温度」，当前显示「样本不足」（历史刚开始积累，符合预期）
- 明细表新增「换手%」列，六只 ETF 显示今日换手值（如 3.46）
- 无控制台报错

- [ ] **Step 7: Commit**

```bash
git add src/utils/retailSignals.ts src/utils/retailSignals.test.ts src/components/RetailPanel.vue src/styles/main.css
git commit -m "feat(retail): 面板新增交投温度与换手率明细列"
```

---

### Task 4: README 更新 + 数据回填首点验证

**Files:**
- Modify: `README.md`（散户情绪反向章节 + 数据来源表）

- [ ] **Step 1: README 数据来源表加一行**

在「ETF 市值/行情」行之后：

```markdown
| ETF 场内换手率/成交额 | 东方财富 `push2delay` `ulist.np` 实时快照（每日抓取积累，无历史回填） |
```

- [ ] **Step 2: 散户情绪反向章节补交投温度说明**

在「申赎温度」条目后加：

```markdown
- **交投温度**：场内换手率（当日成交量/基金总份额）在 250 日回看内的分位取中位数，≥ 85 亢奋、≤ 15 低迷。换手反映二级市场「倒手频率」，与申赎（一级市场进出场）互补。历史自接入日起积累，不足 30 日显示「样本不足」。
```

- [ ] **Step 3: 全量验证**

Run: `bun test && bun run build`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(turnover): 补充场内换手率口径说明"
```

---

## Self-Review 结论

1. **覆盖检查**：优先级 2「换手率入库」全覆盖（类型→抓取→判定→文档）。优先级 3 两融数据源未含（YAGNI，等换手历史积累后再评估增量价值）。
2. **占位符扫描**：无 TBD；所有代码步骤含完整代码。
3. **类型一致性**：`TurnoverPoint` Task 1 定义、Task 2/3 消费；`fetchTurnoverSnapshot` 返回类型与 5b/5e 使用一致；`turnoverLabel` 函数与字段同名冲突已在 3f 注明规避方式。
4. **风险预判**：`EtfSnapshot.turnoverHistory` 设为必填会让旧 dashboard.json 反序列化缺字段——前端已用 `etf.turnoverHistory ?? []` 防御；`slimEtfSnapshot` 用展开运算符自动携带新字段，无需改。
