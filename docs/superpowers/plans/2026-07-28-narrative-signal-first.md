# 叙事重心调整：信号为主、估算值降级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把界面叙事从"估算持仓水平值"转向"份额方向信号"，估算值降为次要参考。

**Architecture:** 提取信号聚合逻辑为可测试的纯函数（`src/utils/signals.ts`），SummaryCards 消费该函数渲染新信号卡；EtfTable 列重排；EtfDetail 标签调整；App.vue 图表说明文案调整。纯前端展示层，不动后端。

**Tech Stack:** Vue 3 + TypeScript + Bun test

---

### Task 1: 信号聚合纯函数 + 测试

**Files:**
- Create: `src/utils/signals.ts`
- Create: `src/utils/signals.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/signals.test.ts
import { describe, expect, test } from 'bun:test'
import { aggregateShareSignals, type SignalSummary } from './signals'

describe('aggregateShareSignals', () => {
  const mkPoint = (trend: 'inflow' | 'outflow' | 'flat', days: number, pct5d: number | null, cat: string) => ({
    shareTrend: trend,
    consecutiveDays: days,
    shareChangePct5d: pct5d,
    categoryName: cat,
  })

  test('inflow majority', () => {
    const points = [
      mkPoint('inflow', 3, 1.2, '沪深300'),
      mkPoint('inflow', 1, -0.5, '上证50'),
      mkPoint('inflow', 1, 0.9, '中证500'),
      mkPoint('outflow', 2, -8.4, '中证1000'),
      mkPoint('flat', 1, 0, '创业板'),
    ]
    const r = aggregateShareSignals(points)
    expect(r.headline).toBe('3/5 只净流入')
    expect(r.highlightConsecutive).toBe('沪深300 连续3日净流入')
    expect(r.highlightChange).toBe('中证1000 5日 -8.4%')
    expect(r.tone).toBe('inflow')
  })

  test('outflow majority', () => {
    const points = [
      mkPoint('outflow', 5, -3.1, '上证50'),
      mkPoint('outflow', 2, -1.0, '沪深300'),
      mkPoint('outflow', 1, -0.2, '中证500'),
      mkPoint('inflow', 1, 0.5, '中证1000'),
      mkPoint('flat', 1, 0, '创业板'),
    ]
    const r = aggregateShareSignals(points)
    expect(r.headline).toBe('3/5 只净流出')
    expect(r.highlightConsecutive).toBe('上证50 连续5日净流出')
    expect(r.tone).toBe('outflow')
  })

  test('mixed (no majority)', () => {
    const points = [
      mkPoint('inflow', 1, 0.5, '上证50'),
      mkPoint('inflow', 1, 0.3, '沪深300'),
      mkPoint('outflow', 1, -0.5, '中证500'),
      mkPoint('outflow', 1, -0.3, '中证1000'),
      mkPoint('flat', 1, 0, '创业板'),
    ]
    const r = aggregateShareSignals(points)
    expect(r.headline).toBe('2入/2出/1平')
    expect(r.tone).toBe('mixed')
  })

  test('empty input', () => {
    const r = aggregateShareSignals([])
    expect(r.headline).toBe('—')
    expect(r.highlightConsecutive).toBeNull()
    expect(r.highlightChange).toBeNull()
    expect(r.tone).toBe('none')
  })

  test('highlightChange picks largest absolute pct', () => {
    const points = [
      mkPoint('inflow', 1, 11.61, '创业板'),
      mkPoint('inflow', 2, 0.9, '沪深300'),
      mkPoint('inflow', 1, -8.45, '上证50'),
    ]
    const r = aggregateShareSignals(points)
    expect(r.highlightChange).toBe('创业板 5日 +11.61%')
  })

  test('all flat → headline shows 平', () => {
    const points = [
      mkPoint('flat', 1, 0, '上证50'),
      mkPoint('flat', 1, 0, '沪深300'),
    ]
    const r = aggregateShareSignals(points)
    expect(r.headline).toBe('0入/0出/2平')
    expect(r.tone).toBe('mixed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/signals.test.ts`
Expected: FAIL — module `./signals` not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/utils/signals.ts

export interface SignalPoint {
  shareTrend: 'inflow' | 'outflow' | 'flat'
  consecutiveDays: number
  shareChangePct5d: number | null
  categoryName: string
}

export interface SignalSummary {
  /** 主数字，如 "4/5 只净流入" */
  headline: string
  /** 连续天数最长者，如 "沪深300 连续5日净流入"；无则 null */
  highlightConsecutive: string | null
  /** |5日变化率| 最大者，如 "中证500 5日 -8.4%"；无则 null */
  highlightChange: string | null
  /** 整体倾向：inflow 多数 / outflow 多数 / mixed / none(无数据) */
  tone: 'inflow' | 'outflow' | 'mixed' | 'none'
}

export function aggregateShareSignals(points: SignalPoint[]): SignalSummary {
  if (points.length === 0) {
    return { headline: '—', highlightConsecutive: null, highlightChange: null, tone: 'none' }
  }

  const total = points.length
  const inflowCount = points.filter((p) => p.shareTrend === 'inflow').length
  const outflowCount = points.filter((p) => p.shareTrend === 'outflow').length
  const flatCount = total - inflowCount - outflowCount

  // 主数字
  let headline: string
  let tone: SignalSummary['tone']
  if (inflowCount > outflowCount && inflowCount > flatCount) {
    headline = `${inflowCount}/${total} 只净流入`
    tone = 'inflow'
  } else if (outflowCount > inflowCount && outflowCount > flatCount) {
    headline = `${outflowCount}/${total} 只净流出`
    tone = 'outflow'
  } else {
    headline = `${inflowCount}入/${outflowCount}出/${flatCount}平`
    tone = 'mixed'
  }

  // 连续天数最长（排除 flat）
  const nonFlat = points.filter((p) => p.shareTrend !== 'flat')
  let highlightConsecutive: string | null = null
  if (nonFlat.length > 0) {
    const best = nonFlat.reduce((a, b) => (b.consecutiveDays > a.consecutiveDays ? b : a))
    const dir = best.shareTrend === 'inflow' ? '净流入' : '净流出'
    highlightConsecutive = `${best.categoryName} 连续${best.consecutiveDays}日${dir}`
  }

  // |5日变化率| 最大
  const withPct = points.filter((p) => p.shareChangePct5d != null)
  let highlightChange: string | null = null
  if (withPct.length > 0) {
    const best = withPct.reduce((a, b) =>
      Math.abs(b.shareChangePct5d!) > Math.abs(a.shareChangePct5d!) ? b : a,
    )
    const pct = best.shareChangePct5d!
    highlightChange = `${best.categoryName} 5日 ${pct > 0 ? '+' : ''}${pct}%`
  }

  return { headline, highlightConsecutive, highlightChange, tone }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils/signals.test.ts`
Expected: 6 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/utils/signals.ts src/utils/signals.test.ts
git commit -m "feat: add signal aggregation utility with tests"
```

---

### Task 2: SummaryCards 信号卡 + 估算卡降级

**Files:**
- Modify: `src/components/SummaryCards.vue`

- [ ] **Step 1: Add import and signal computation**

在 `<script setup>` 顶部添加 import：

```ts
import { aggregateShareSignals } from '../utils/signals'
```

在 `cards` computed 内，`latestAnchored` 计算之后、`estDates` 之前，添加信号聚合：

```ts
  const signalPoints = props.etfs
    .map((etf) => {
      const pts = etf.huijinEstimateHistory.filter((p) => p.estimateMethod === 'anchored')
      const last = pts.length > 0 ? pts[pts.length - 1] : null
      if (!last || last.shareTrend == null) return null
      return {
        shareTrend: last.shareTrend,
        consecutiveDays: last.consecutiveDays ?? 1,
        shareChangePct5d: last.shareChangePct5d ?? null,
        categoryName: etf.categoryName,
      }
    })
    .filter((p): p is NonNullable<typeof p> => p != null)
  const signal = aggregateShareSignals(signalPoints)
```

- [ ] **Step 2: Replace cards array**

把 `return [...]` 数组替换为（信号卡第 2 位，估算卡第 4 位）：

```ts
  return [
    {
      label: '汇金最近披露合计估值',
      value: yuanToYi(props.totalMv ?? null),
      sub: props.latestReport
        ? `最近报告期 ${props.latestReport} · 已披露 ${disclosures.length}/${props.etfs.length} 只`
        : '暂无汇金持仓披露',
      accent: 'gold',
    },
    {
      label: '份额信号（汇金方向参考）',
      value: signal.headline,
      sub: [signal.highlightConsecutive, signal.highlightChange]
        .filter(Boolean)
        .join(' · ') || '无汇金披露锚点，暂不生成信号',
      accent: signal.tone === 'inflow' ? 'teal' : signal.tone === 'outflow' ? 'red' : 'orange',
    },
    {
      label: '0AMV 活筹估算',
      value: formatYi(props.activeCapYi ?? null),
      sub: props.activeCapDate
        ? `交易日 ${props.activeCapDate} · 沪深成交额口径`
        : '暂无沪深市场 0AMV 数据',
      accent: 'blue',
    },
    {
      label: '汇金估算持仓（区间中值）',
      value: latestAnchored.length > 0 ? formatYi(estTotalYi) : '—',
      sub: estDateLabel
        ? `纳入 ${latestAnchored.length}/${props.etfs.length} 只 · 估算日 ${estDateLabel} · 仅供方向参考`
        : '无估算锚点',
      accent: 'orange',
    },
    {
      label: '汇金最近披露合计份额',
      value: formatShares(totalShares),
      sub: '各基金最新公开持有人报告合计',
      accent: 'teal',
    },
    {
      label: '监测 ETF / 平均占比',
      value: `${props.etfs.length} 只`,
      sub: `已披露 ${disclosures.length} 只 · 披露占比平均 ${formatPct(avgPct)}`,
      accent: 'purple',
    },
  ]
```

- [ ] **Step 3: Add 'red' accent support**

在 `src/styles/main.css` 中搜索 `[data-accent="orange"]` 附近，添加 red accent 变量（如果不存在）：

```css
[data-accent='red'] {
  --card-accent: #f07178;
}
```

- [ ] **Step 4: Run type check**

Run: `bun run build`
Expected: vue-tsc 通过，构建成功

- [ ] **Step 5: Commit**

```bash
git add src/components/SummaryCards.vue src/styles/main.css
git commit -m "feat: add aggregate signal card, demote estimate card"
```

---

### Task 3: EtfTable 列重排

**Files:**
- Modify: `src/components/EtfTable.vue`

- [ ] **Step 1: Reorder `<thead>` columns**

把 `<thead><tr>` 内的 `<th>` 顺序从：

```html
<th>类别</th>
<th>代码</th>
<th>名称</th>
<th class="num">现价</th>
<th class="num">涨跌</th>
<th>份额日期</th>
<th class="num">基金总份额</th>
<th class="num">净份额变化</th>
<th class="num">基金规模</th>
<th>报告期</th>
<th class="num">汇金份额</th>
<th class="num">汇金占比</th>
<th class="num">最近披露估值</th>
<th class="num">估算持仓</th>
<th class="num">份额趋势</th>
```

改为：

```html
<th>类别</th>
<th>代码</th>
<th>名称</th>
<th class="num">现价</th>
<th class="num">涨跌</th>
<th>份额日期</th>
<th class="num">基金总份额</th>
<th class="num">净份额变化</th>
<th class="num" title="基于交易所总份额流向，供判断汇金方向参考，不代表汇金实际操作">份额趋势</th>
<th class="num">基金规模</th>
<th>报告期</th>
<th class="num">汇金份额</th>
<th class="num">汇金占比</th>
<th class="num">最近披露估值</th>
<th class="num">估算持仓</th>
```

- [ ] **Step 2: Reorder `<tbody>` cells**

在 `<tr v-for="r in visibleRows">` 内，把"份额趋势"的 `<td>` 块（当前最后一个）移到"净份额变化" `<td>` 之后、"基金规模" `<td>` 之前。"估算持仓" `<td>` 移到最末（"最近披露估值"之后）。

具体：剪切当前第 15 个 `<td>`（份额趋势，含 template v-if 箭头逻辑），粘贴到第 8 个 `<td>`（净份额变化）之后。剪切当前第 14 个 `<td>`（估算持仓），粘贴到最末。

- [ ] **Step 3: Run type check**

Run: `bun run build`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add src/components/EtfTable.vue
git commit -m "feat: reorder table columns — signal after share change, estimate last"
```

---

### Task 4: EtfDetail 标签调整

**Files:**
- Modify: `src/components/EtfDetail.vue`

- [ ] **Step 1: Rename KPI labels**

在规模区 `.detail-scale` 内，找到：

```html
<div class="k">汇金当前持仓</div>
```

改为：

```html
<div class="k">估算持仓（参考）</div>
```

找到（上一轮已改为带 ≈）：

```html
<div class="k">汇金当前占比</div>
```

改为：

```html
<div class="k">估算占比（参考）</div>
```

- [ ] **Step 2: Run type check**

Run: `bun run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/components/EtfDetail.vue
git commit -m "feat: rename estimate KPI labels to 估算持仓/占比（参考）"
```

---

### Task 5: App.vue 趋势图说明文案

**Files:**
- Modify: `src/App.vue`

- [ ] **Step 1: Update panel-head muted text**

找到汇金持仓趋势 panel 的 muted 副标题（约 :242）：

```html
<p class="muted">
  实点为年报/半年报「十大持有人」披露；最近披露期之后的虚线为占比区间估算（下界假设份额变动全归因汇金，上界假设汇金占比不变）
</p>
```

改为：

```html
<p class="muted">
  虚线为占比区间估算（仅供方向参考）；次轴细线为份额 5 日变化率，是判断汇金方向的主要信号
</p>
```

- [ ] **Step 2: Run type check**

Run: `bun run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/App.vue
git commit -m "feat: update trend chart subtitle to signal-first narrative"
```

---

### Task 6: 全量验证

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: 28 pass (22 existing +6 new), 0 fail

- [ ] **Step 2: Run audit**

Run: `bun run audit`
Expected: errors: [], warnings: []

- [ ] **Step 3: Visual verification**

Run: `bun run dev`，打开浏览器核对：
- 第一屏第 2 张卡为"份额信号（汇金方向参考）"，主数字"X/5 只净流入/出"
- 估算卡在第 4 位，label 含"区间中值"，sub 含"仅供方向参考"
- 表格"份额趋势"列在"净份额变化"之后、"基金规模"之前
- 详情规模区标签为"估算持仓（参考）""估算占比（参考）"
- 趋势图 panel 副标题以信号为主角措辞

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: visual verification fixups"
```
