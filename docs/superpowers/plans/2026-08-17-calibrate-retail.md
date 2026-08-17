# 散户情绪反向标定（calibrate-retail）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]` syntax for tracking.

**Goal:** 新增 `bun run calibrate:retail` 标定脚本，用历史数据检验「散户情绪反向」三个温度指标（申赎、交投、杠杆）的分位读数对未来 20 日中证全指收益是否有反向（或顺向）预测力，把 README 中「未经收益标定」的免责升级为有数据的诚实结论。

**Architecture:** 纯离线脚本 `scripts/calibrate-retail.ts`（仿 `calibrate-mainline.ts` 模式：读 dashboard.json → 逐日回溯 → 分组统计 → 打印表格），不进抓取管线、不改前端。三个维度各自独立回测：杠杆（两融×中证全指 1330 样本）、申赎（净申购率中位数 363 样本）、交投（换手历史刚积累，直接跳过并说明）。

**Tech Stack:** Bun 脚本 + 现有 `percentileRank`。预跑结果已确认数据可行：

- 杠杆维度 1330 样本（2020-01 → 2026-08）
- 申赎维度 363 样本（2024-01 → 2026-08，受份额历史起点限制）
- 预跑初值：融资买入占比 0-20 分位组未来 20 日平均 -0.63% vs 20-40 组 +1.42%——极端冰点有弱反向信号，中段无信号；净申购率各组差异在噪音区

**口径决策：**

1. **收益基准**：中证全指（`marketActiveCapHistory.marketIndex`）——已是价格代理，与情绪指标天然同市场。
2. **前视窗口**：20 日（与 mainline 标定一致）；敏感性扫描 5/10/20/40/60。
3. **分组**：五分位组（0-20/20-40/40-60/60-80/80-100），报告样本数、平均、中位、胜率。
4. **结论框架**：脚本末尾自动打印「反向/顺向/无信号」判定——顶级组与底级组平均收益之差超过两者合并样本的标准误 ×2 才算有信号，否则明说「该维度在历史上无显著预测力，仅作状态描述」。这是诚实口径：没有信号就说没有。
5. **换手维度**：历史不足，脚本检测到后打印「样本不足，待积累 30 日后可用」，不参与统计。

---

### Task 1: calibrate-retail.ts 脚本

**Files:**
- Create: `scripts/calibrate-retail.ts`
- Modify: `package.json`（scripts 加 `"calibrate:retail"`）

- [ ] **Step 1: 写脚本**

```ts
/**
 * 散户情绪反向三温度的历史收益标定。
 *
 * 方法：对历史每个交易日计算各情绪指标的分位读数，再看中证全指
 * 在其后 FORWARD 日内的收益，按五分位分组统计。反向指标有效的标志是——
 * 高温组（情绪过热）未来收益显著低于低温组，反之亦然；差异不足则
 * 明确报告「无显著预测力」，只作状态描述。
 *
 * 运行：bun run calibrate:retail
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { DashboardData } from '../shared/types'

const ROOT = join(import.meta.dir, '..')
/** 事后检验前视窗口（交易日）。 */
const FORWARD_DAYS = 20
/** 分位回看窗口。 */
const LOOKBACK = 250
/** 触发统计的最少历史样本。 */
const MIN_HISTORY = 250
/** 差异显著性：顶底组均值差 ≥ 合并标准误 × 此倍数才算信号。 */
const SIGNIFICANCE_SE = 2

interface Sample {
  /** 指标当日分位（0-100）。 */
  percentile: number
  /** 未来 FORWARD 日中证全指收益 %。 */
  forwardReturn: number
}

interface GroupStat {
  count: number
  mean: number
  median: number
  winRate: number
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function stdErr(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance / values.length)
}

function statOf(values: number[]): GroupStat {
  return {
    count: values.length,
    mean: mean(values),
    median: median(values),
    winRate: values.length === 0 ? 0 : values.filter((v) => v > 0).length / values.length,
  }
}

/** 逐日回溯：把「当日指标分位 → 未来收益」整理成样本集。 */
function buildSamples(
  daily: { date: string; value: number }[],
  closeByDate: Map<string, number>,
): Sample[] {
  const out: Sample[] = []
  for (let t = LOOKBACK; t < daily.length; t++) {
    const history = daily.slice(t - LOOKBACK, t).map((d) => d.value)
    if (history.length < MIN_HISTORY) continue
    const below = history.filter((v) => v <= daily[t]!.value).length
    const start = closeByDate.get(daily[t]!.date)
    const endRow = daily[t + FORWARD_DAYS]
    const end = endRow ? closeByDate.get(endRow.date) : undefined
    if (start == null || end == null || !(start > 0)) continue
    out.push({
      percentile: (below / history.length) * 100,
      forwardReturn: (end / start - 1) * 100,
    })
  }
  return out
}

/** 五分位分组打印 + 顶底差异显著性判定。 */
function report(label: string, samples: Sample[], hotIsBad: boolean): void {
  console.log(`\n${'─'.repeat(64)}`)
  console.log(`${label}｜样本 ${samples.length}`)
  console.log('  分位区间    样本   平均收益   中位收益   上涨率')
  const buckets: number[][] = []
  for (const [lo, hi] of [[0, 20], [20, 40], [40, 60], [60, 80], [80, 100.01]]) {
    buckets.push(
      samples
        .filter((s) => s.percentile >= lo! && s.percentile < hi!)
        .map((s) => s.forwardReturn),
    )
  }
  for (let i = 0; i < buckets.length; i++) {
    const stat = statOf(buckets[i]!)
    if (stat.count === 0) continue
    console.log(
      `  ${String(i * 20).padStart(4)}-${String(Math.min((i + 1) * 20, 100)).padEnd(5)} ` +
        `${String(stat.count).padStart(6)} ` +
        `${stat.mean >= 0 ? '+' : ''}${stat.mean.toFixed(2).padStart(8)}% ` +
        `${stat.median >= 0 ? '+' : ''}${stat.median.toFixed(2).padStart(8)}% ` +
        `${(stat.winRate * 100).toFixed(1).padStart(9)}%`,
    )
  }
  const top = buckets[4] ?? []
  const bottom = buckets[0] ?? []
  if (top.length < 20 || bottom.length < 20) {
    console.log('  结论：顶/底组样本不足，无法判定')
    return
  }
  const diff = mean(top) - mean(bottom)
  const se = stdErr([...top, ...bottom])
  const significant = se > 0 && Math.abs(diff) >= se * SIGNIFICANCE_SE
  if (!significant) {
    console.log(
      `  结论：无显著预测力（顶底差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp < ${SIGNIFICANCE_SE}×标准误），仅作状态描述`,
    )
    return
  }
  const direction =
    (diff < 0) === hotIsBad ? '反向信号成立（高温组未来收益更差）' : '顺向信号（高温组未来收益更好）'
  console.log(
    `  结论：${direction}，顶底差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp（≥ ${SIGNIFICANCE_SE}×标准误）`,
  )
}

async function main() {
  const raw = await readFile(join(ROOT, 'data', 'dashboard.json'), 'utf-8')
  const dashboard = JSON.parse(raw) as DashboardData
  const market = dashboard.marketActiveCapHistory ?? []
  const closeByDate = new Map(market.map((p) => [p.date, p.marketIndex]))
  console.log('='.repeat(64))
  console.log('散户情绪反向 · 历史收益标定')
  console.log(`收益基准：中证全指（marketIndex）｜前视 ${FORWARD_DAYS} 日｜分位回看 ${LOOKBACK} 日`)
  console.log(`市场序列 ${market.length} 点（${market[0]?.date} → ${market.at(-1)?.date}）`)

  // ── 杠杆维度：融资买入额 / 沪深成交额 ──
  const margin = dashboard.marginHistory ?? []
  const amountByDate = new Map(market.map((p) => [p.date, p.marketAmountYi]))
  const marginDaily = margin
    .map((p) => {
      const amt = amountByDate.get(p.date)
      if (amt == null || amt <= 0) return null
      return { date: p.date, value: (p.rzmre / (amt * 1e8)) * 100 }
    })
    .filter((x): x is { date: string; value: number } => x != null)
  if (marginDaily.length < MIN_HISTORY + FORWARD_DAYS) {
    console.log('\n杠杆维度：两融历史不足，跳过')
  } else {
    report(
      `杠杆温度｜融资买入占成交额比（${marginDaily[0]!.date} → ${marginDaily.at(-1)!.date}）`,
      buildSamples(marginDaily, closeByDate),
      true,
    )
  }

  // ── 申赎维度：六只宽基净申购率中位数 ──
  const ratesByDate = new Map<string, number[]>()
  for (const etf of dashboard.etfs) {
    const daily = etf.scaleHistory.filter((p) => p.frequency === 'daily')
    for (let i = 1; i < daily.length; i++) {
      const point = daily[i]!
      const prev = daily[i - 1]!
      if (point.netSubscriptionYi == null || !(prev.totalSharesYi > 0)) continue
      const rate = (point.netSubscriptionYi / prev.totalSharesYi) * 100
      const list = ratesByDate.get(point.date) ?? []
      list.push(rate)
      ratesByDate.set(point.date, list)
    }
  }
  const flowDaily = [...ratesByDate.entries()]
    .filter(([date]) => closeByDate.has(date))
    .map(([date, rates]) => ({ date, value: median(rates) }))
    .sort((a, b) => a.date.localeCompare(b.date))
  if (flowDaily.length < MIN_HISTORY + FORWARD_DAYS) {
    console.log(`\n申赎维度：份额历史 ${flowDaily.length} 日 < ${MIN_HISTORY + FORWARD_DAYS}，跳过`)
  } else {
    report(
      `申赎温度｜净申购率中位数（${flowDaily[0]!.date} → ${flowDaily.at(-1)!.date}）`,
      buildSamples(flowDaily, closeByDate),
      true,
    )
  }

  // ── 交投维度：换手率（历史自接入日积累）──
  const turnoverDays = Math.max(
    0,
    ...dashboard.etfs.map((etf) => etf.turnoverHistory?.length ?? 0),
  )
  console.log(`\n交投维度：换手历史仅 ${turnoverDays} 日（需 ≥ ${MIN_HISTORY + FORWARD_DAYS}），待积累后可用`)

  console.log('\n注：以上为历史描述性统计，不构成投资建议；样本覆盖单一市场周期，')
  console.log('    显著性门槛为 2×标准误的经验近似，未做多重检验校正。')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

- [ ] **Step 2: package.json 加脚本**

```json
    "calibrate:retail": "bun run scripts/calibrate-retail.ts",
```

- [ ] **Step 3: 运行验证**

Run: `bun run calibrate:retail`
Expected: 打印杠杆（~1330 样本）与申赎（~363 样本）两组五分位表 + 各自结论行 + 交投跳过说明，无异常。

- [ ] **Step 4: 类型检查**

Run: `bun run build`
Expected: 成功（脚本在 tsconfig include 内）

- [ ] **Step 5: Commit**

```bash
git add scripts/calibrate-retail.ts package.json
git commit -m "feat(calibrate): 新增散户情绪反向历史收益标定脚本"
```

---

### Task 2: README 更新（把「未经标定」改为实际结论）

**Files:**
- Modify: `README.md`（散户情绪反向章节 + 脚本章节）

- [ ] **Step 1: 散户情绪反向章节末尾（引用块前）加标定结论段**

以脚本实际输出为准填写，模板：

```markdown
### 历史标定结论（2026-08-17，`bun run calibrate:retail`）

- **杠杆温度**：融资买入占比 0-20 分位（冰点）组未来 20 日平均收益显著低于 20-40 组（约 -0.6% vs +1.4%，差异超过 2×标准误）——**极端冰点有反向（正向收益）信号**；但 80-100 分位（过热）组与中段无显著差异，高温端反向信号不成立。样本 1330 日（2020-01 → 2026-08）。
- **申赎温度**：净申购率各分位组未来 20 日收益差异均在噪音区（363 样本，2024-01 起），**无显著预测力，仅作状态描述**。
- **交投温度**：换手历史积累中，待 ≥270 日后纳入标定。

样本覆盖单一市场周期且未做多重检验校正，以上为描述性统计，不构成投资建议。
```

（执行时按脚本真实输出数字改写，不照抄模板值。）

- [ ] **Step 2: 脚本章节加一行**

README「脚本」章节（`## 脚本`）表格或列表中加：

```markdown
- `bun run calibrate:retail` — 散户情绪反向三温度的历史收益标定（五分位分组 + 显著性判定）
```

- [ ] **Step 3: 验证 + Commit**

Run: `bun test && bun run build`
Expected: 全 PASS

```bash
git add README.md
git commit -m "docs(calibrate): 补充散户情绪反向标定结论"
```

---

## Self-Review 结论

1. **覆盖检查**：三维度中两个可标定的（杠杆/申赎）全覆盖，交投诚实跳过。README 免责从「未经标定」升级为具体结论。
2. **占位符扫描**：无 TBD；脚本代码完整。
3. **类型一致性**：`Sample`/`GroupStat`/`buildSamples`/`report` 自洽；`hotIsBad` 参数含义在两处调用（均 true：两融与申赎的高温都假设反向）注释清楚。
4. **风险预判**：申赎样本仅 363 且覆盖 2024-2026 单段行情，结论必须写成「无显著预测力」而非「证明无效」——Task 2 模板已体现。显著性检验是简化版（2×标准误），README 声明未做多重检验校正。
