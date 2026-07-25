# 汇金持仓估算改为占比区间口径 — 设计说明

**日期：** 2026-07-25
**状态：** 待用户审阅
**关联：** [2026-07-24 份额锚定估算设计](./2026-07-24-huijin-share-anchor-estimate-design.md)、[2026-07-25 份额精确化 + 趋势信号设计](./2026-07-25-share-precision-huijin-trend-design.md)

## 背景

份额锚定法以最近一期汇金披露日（当前 2025-12-31）的汇金份额为单一锚点，假设"汇金不主动赎回"，估算份额 = `min(披露份额, 当日总份额)`。2026 年以来市场出现大规模宽基 ETF 赎回，5/6 宽基 ETF 总份额持续低于 2025-12-31 披露的汇金份额，**全量触发 clamp**，估算值退化为"当日总份额上限"，估算占比一律收尾到 100%，失去信息量。

实测快照（2026-07-25 抓取）：6 只 ETF anchored 估算点共 803 个，clamp 点 685 个（85%）；末日估算占比 5/6 为 100%。份额锚定口径已无法表达"汇金占比随市场赎回变化"的现实。

用户领域判断（关键前提）：

> 这类宽基 ETF 的大规模份额变动（尤其大额赎回/申购），基本都是汇金的操作，其他持有人不会做这种级别的操作。

含义：当总份额大幅下降时，更可能是汇金在主动赎回，而非其余持有人等比例稀释汇金份额。份额锚定法隐含的"汇金份额不变、变动全来自其他持有人"假设，与该判断相反。

## 本次目标

把估算口径从单一"份额锚定（假设份额不变）"改为**占比区间**口径：

- 下界（悲观侧）：份额变动全归因汇金——从最近披露汇金份额起，逐日累加交易所总份额净变化（`netSubscriptionYi`），即"总份额怎么变，汇金就怎么变"。符合"大额变动主要是汇金"先验。
- 上界（乐观侧）：占比锚定——假设汇金占比不变，估算 = 当日总份额 × 披露占比%。即"汇金被动随市场等比例稀释"，份额不变口径的等价占比表达。
- 实际汇金份额落在区间内；结合"大额变动主要是汇金"的先验，区间偏向下界侧（在口径声明与前端标注中点明）。

占比本身就是一个估算范围，本设计把这条不确定性显式表达，而非用 clamp 掩盖。

## 第 1 节：估算逻辑重写（`buildHuijinEstimate`）

### 锚点

仍以最近一期汇金披露（`huijinReports` 末尾）为唯一锚点，不回填历史多期持有人（用户确认本范围不做）。

### 口径计算

对每个 `scaleHistory` 点 `s`：

1. **披露日上及其以前**（`s.date <= latestAnchor.reportDate` 或 `s` 命中披露日）：`estimateMethod: 'disclosed'`，`huijinShares/Pct` 取正式披露值。保持不变。

2. **披露日之后的 daily 点**（`s.date > latestAnchor.reportDate && s.frequency === 'daily'`）：`estimateMethod: 'anchored'`，计算两档：

   - **下界 `huijinSharesFloor`**：从披露日汇金份额起，沿 daily 序列逐日累加 `netSubscriptionYi`（已在 `mergeScaleHistory` 计算为"当日 - 上一交易日"）。即
     `floor_i = floor_{i-1} + s_i.netSubscriptionYi`，初值 `floor_0 = latestAnchor.huijinShares`。
     含义：份额变动全归因汇金。
     下界不得为负（汇金份额物理下界），亦不得超过当日总份额：`huijinSharesFloor = clamp(累加值, 0, totalShares)`。

   - **上界 `huijinSharesCeil`**：`totalShares × latestAnchor.huijinPercent / 100`。
     含义：汇金占比不变，份额随市场等比例稀释（汇金份额 = 总份额 × 披露占比%）。
     上界不得超过当日总份额（占比 ≤100% 时天然成立）。
     注：占比锚定与原"份额锚定"非等价——份额锚定在非 clamp 区间占比 = 披露份额/总份额（随总份额上升而下降），占比锚定占比恒 = 披露占比。上界取占比锚定为"被动稀释"最乐观假设。

   - **取定值与占比**：实际不可识别，区间本身即结论。对外仍需一个展示值，结合"大额变动主要是汇金"的先验偏向下界侧，取 **下界 2/3 + 上界 1/3** 的加权。  
     `huijinShares = round(weighted)`，`huijinPct = huijinShares / totalShares × 100`。

   - **`huijinValueYi`**：`huijinShares × nav / 1e8`，沿用既有净值匹配逻辑。

3. **非 daily 点或无锚点**：`estimateMethod: 'unavailable'`，`huijinShares/Pct/ValueYi` 为 null，`unavailableReason` 给出原因。保持不变。

### 趋势信号层

`shareTrend / consecutiveDays / shareChangePct5d` **完整保留**——基于总份额流向，判断"份额流向、连续同向、5 日变化率"，与口径无关。

**移除 clamp 相关字段与逻辑**（`clampTriggered`、`clampReliability`）：占比区间口径下没有 clamp 退化。`SignalInput.clampTriggered`、`SignalOutput.clampReliability` 及 `estimate-signals.ts` 的 clamp 分支删除。

### netSubscriptionYi 透出

`buildHuijinEstimate` 内部需用 `netSubscriptionYi` 做累加。当前实现把 `netSubscriptionYi` 作为临时字段在函数内传递、最终移除。本次保留这一内部传递方式；新增字段为 `huijinSharesFloor` / `huijinSharesCeil`，写入落盘的 `HuijinEstimatePoint`。

## 第 2 节：类型变更（`shared/types.ts`）

`HuijinEstimatePoint`：

- **删除**：`clampTriggered?: boolean`、`clampReliability?: ...`。
- **新增**：
  ```ts
  /** 占比区间下界（份额变动全归因汇金，悲观侧），亿份。仅 anchored 点。 */
  huijinSharesFloor?: number | null
  /** 占比区间上界（汇金占比不变，被动稀释，乐观侧），亿份。仅 anchored 点。 */
  huijinSharesCeil?: number | null
  ```
- **保留**：`huijinShares`（展示值，区间加权）、`huijinPct`、`huijinValueYi`、`shareTrend`、`consecutiveDays`、`shareChangePct5d`。

`SignalInput` / `SignalOutput`（`shared/estimate-signals.ts`）：删除 `clampTriggered`、`clampReliability`。

## 第 3 节：前端展示（`src/components/`）

### HuijinTrendChart.vue

- tooltip 估算点新增：展示区间，如"汇金估算 64~74 亿份（下界 64 / 上界 74）"，并保留"连续 N 日净流入/出"、"5 日 ±X%"。
- 删除"⚠ clamp"、"份额触底回升"文案。
- chart-note 更新为：实点为正式披露；虚线为占比区间估算，下界假设份额变动全归因汇金，上界假设汇金占比不变，实际值落在区间内，结合大额变动主要来自汇金的判断，偏向下界侧。
- `metric: 'percent'` 维度：估算占比随区间展示值变化（不再是直线），因下界占比会随赎回下降而上界占比维持披露占比，曲线在中段呈下降趋势——这恰好反映"汇金占比可能被稀释或主动下降"的不确定区间。

### EtfTable.vue

- "份额趋势"列保留（近 5 日流向箭头 + 连续天数）。
- 删除 ⚠ clamp 标记。
- 估算汇金份额列改为展示区间"下界~上界"或展示值 + tooltip 区间（择一，实现时定）。

## 第 4 节：审计（`scripts/data-audit.ts`）

- 删除 anchored 的 `clampTriggered` / `clampReliability` 校验。
- 新增 anchored 校验：
  - `huijinSharesFloor` 与 `huijinSharesCeil` 均为非负有限数，且 `floor <= ceil`，且 `ceil <= totalShares`（容差 +1 份）。
  - `huijinShares` 落在 `[floor, ceil]` 区间内（容差）。
  - `huijinPct` 由展示值与总份额反推一致（容差 0.02%）。
  - `huijinSharesCeil ≈ round(totalShares × latestAnchor.huijinPercent / 100)`（容差）。
  - 抽样校验 `floor_i = floor_{i-1} + netSubscription_i`（从披露点累加，跨 anchored 序列一致）。
- 保留：`shareTrend/consecutiveDays/shareChangePct5d` 类型与同向链一致校验、`shareFetchGaps` warning。

## 第 5 节：可配置项

区间加权权重（下界/上界）作为常量集中在 `fetch-data.ts` 顶部，默认下界 2/3、上界 1/3（偏向下界侧，对齐"大额变动主要是汇金"先验），便于后续调整而不致在变更口径时干扰审计。

## 第 6 节：口径声明（README + source.huijinEstimate）

更新为：

> 汇金持仓估算改为**占比区间**口径。下界：从最近披露汇金份额起逐日累加交易所总份额净变化（份额变动全归因汇金，假设大额赎回/申购主要由汇金进行）。上界：维持最近披露的汇金占比不变（汇金被动等比例稀释）。实际汇金份额落在区间内。结合"宽基 ETF 大额变动主要来自汇金"的判断，区间偏向下界侧。趋势信号（份额流向、连续天数、5 日变化率）供方向参考。估算不代表汇金实际持仓，仅供研究。

## 第 7 节：数据获取

实测（2026-07-25）确认：SSE 日份额查询 140 个交易日失败 0 日，SZSE 创业板 250 条失败 0 段，`shareFetchGaps` 全空。**抓取已完整，本次不改抓取代码**。回填窗口动态化、SSE/SZSE 容错、`fetchText` 重试在上一轮已落地，本次保持。

## 不做的事

- 不回填历史多期持有人（用户确认；仍只 1 期披露锚点）。
- 不并列份额锚定旧口径（区间已含上界=占比锚定等价，不重复）。
- 不做估算值的置信区间或统计误差带（区间本身就是不确定性表达，不加概率解释）。
- 不估算科创50（无锚点，保持 `unavailable`）。
- 不改数据抓取代码（实测完整）。

## 影响文件

- `scripts/fetch-data.ts`：`buildHuijinEstimate` 重写为占比区间累加，移除 clamp 分支，新增区间加权常量。
- `shared/types.ts`：`HuijinEstimatePoint` 删 clamp 字段、增 floor/ceil；`SignalInput/SignalOutput` 删 clamp 字段。
- `shared/estimate-signals.ts`：删 clamp 分支。
- `scripts/data-audit.ts`：删 clamp 校验、增区间校验。
- `src/components/HuijinTrendChart.vue`、`src/components/EtfTable.vue`：区间展示、移除 clamp 文案/标记。
- `README.md`：口径声明更新。
