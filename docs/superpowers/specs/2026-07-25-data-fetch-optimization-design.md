# 数据获取优化 + 占比区间估算实现 — 设计说明

**日期：** 2026-07-25
**状态：** 待用户审阅
**关联：** [2026-07-25 占比区间口径设计](./2026-07-25-huijin-percentage-range-estimate-design.md)、[2026-07-25 份额精确化 + 趋势信号设计](./2026-07-25-share-precision-huijin-trend-design.md)

## 背景

当前 `scripts/fetch-data.ts` 单文件 1357 行，职责混杂（HTTP 基础设施、四个数据源抓取、估算逻辑、快照组装、落盘）。日频份额只回填 250 个交易日（2025-07-14 起），但上交所/深交所接口实测可回溯到 2024 年甚至更早。份额锚定估算在 2026 年全量触发 clamp，退化为"总份额上限"，失去信息量。

已有一份占比区间口径设计（`2026-07-25-huijin-percentage-range-estimate-design.md`）处于待实现状态，其下界（份额变动全归因汇金）与用户"根据 ETF 份额变化估算汇金持仓"的需求完全吻合。

本次目标：

1. 将 `fetch-data.ts` 按职责拆分为独立模块（纯搬移，不改逻辑）
2. 日频份额回填起点从固定 250 天改为 2024-01-01，支持缺口自动补抓
3. 实现占比区间估算口径（落地已有设计）
4. 新增抓取完整性报告

用户确认：持有人报告仍只抓 1 期（不恢复多期）；前端组件本次不改。

## 第 1 节：模块拆分

将 `scripts/fetch-data.ts` 拆为以下结构。拆分阶段为纯代码搬移，不改变任何逻辑；拆分完成后用 `bun run audit` + 对比拆分前后 `dashboard.json` 输出验证行为不变。

```
scripts/
  fetch-data.ts              ← 编排层（~250 行）
  sources/
    http.ts                  ← fetchText / fetchJson / sleep / UA 常量
    eastmoney.ts             ← fetchEtfUniverse, fetchQuotesByCandidates,
                                fetchScaleHistory, fetchNavHistory,
                                fetchMarketActiveCapHistory, fetchMarketBars
    sse.ts                   ← fetchSseDailyShares（含重试/缺口记录）
    szse.ts                  ← fetchSzseDailyShares（含重试/缺口记录）
    sina.ts                  ← fetchAllHolderReports, fetchHolderDates,
                                fetchHoldersOnDate
  lib/
    estimate.ts              ← buildHuijinEstimate（占比区间口径）
    merge.ts                 ← mergeScaleHistory, buildHuijinHistory,
                                dedupeHolderReports, nearestNav, parseNumberYi
    report.ts                ← 抓取完整性报告
shared/                      ← 不变（backfill-window.ts / estimate-signals.ts / types.ts）
```

### 编排层 `fetch-data.ts` 职责

`main()` 流程控制：加载上次快照 → 抓行情/0AMV → 选 ETF → 算回填窗口（含缺口合并）→ 抓交易所份额 → 逐只组装快照（调 `lib/`）→ 落盘 → 打印完整性报告。

### 模块接口约定

- 每个 source 模块：入参为纯数据（代码列表、日期范围），出参为类型化结果 + 失败记录（`failedDates` / `failedRanges`）。
- source 模块之间无依赖，只依赖 `sources/http.ts` 和 `shared/types.ts`。
- `lib/` 模块为纯函数（除 `report.ts` 打印外无副作用），可独立单元测试。

### 搬移映射

| 原 fetch-data.ts 函数 | 目标模块 |
|---|---|
| `sleep`, `fetchText`, `fetchJson`, `UA` | `sources/http.ts` |
| `fetchEtfUniverse`, `fetchEtfUniversePage`, `fetchQuotesByCandidates`, `pickLargestPerCategory` | `sources/eastmoney.ts` |
| `fetchMarketBars`, `fetchMarketActiveCapHistory` | `sources/eastmoney.ts` |
| `fetchScaleHistory`, `fetchNavHistory` | `sources/eastmoney.ts` |
| `fetchSseDailyShares` | `sources/sse.ts` |
| `fetchSzseDailyShares`, `splitDateRanges`, `normalizeSzseRows` | `sources/szse.ts` |
| `fetchHolderDates`, `fetchHoldersOnDate`, `fetchAllHolderReports` | `sources/sina.ts` |
| `mergeScaleHistory`, `buildHuijinHistory`, `dedupeHolderReports`, `nearestNav`, `parseNumberYi` | `lib/merge.ts` |
| `buildHuijinEstimate` | `lib/estimate.ts` |
| `officialPointsFromSnapshot`, `mergeOfficialPoints`, `fetchOfficialShareHistories` | `fetch-data.ts`（编排层，涉及多 source 协调） |
| `loadPreviousDashboard`, `buildEtfSnapshot`, `main` | `fetch-data.ts` |

## 第 2 节：回填窗口动态化 + 缺口自动补抓

### 回填窗口

`shared/backfill-window.ts` 扩展：

- 新增常量 `SHARE_BACKFILL_START = '2024-01-01'`（置于 `fetch-data.ts` 顶部，传入 `computeOfficialFetchDates`）。
- `computeOfficialFetchDates` 逻辑调整：
  - **首次抓取或历史不足**（existing 为空，或 existing 最早日期晚于 `backfillStart`）：窗口 = marketDates 中 ≥ `2024-01-01` 的全部交易日（约 380 个）。这同时处理了从旧250 天缓存过渡的情况——过渡期一次性重抓全段，`mergeOfficialPoints` 按日期去重，已有数据不受影响。
  - **增量更新**（existing 非空且最早日期 ≤ `backfillStart`）：窗口 = existing 末尾 - overlap（5 个交易日）至最新交易日。
  - 汇金披露日约束保留（窗口必须覆盖披露日），但 2024-01-01 早于 2025-12-31，首次抓取自然覆盖。
- 接口签名新增可选参数 `backfillStart?: string`，不传时保持现有行为（向后兼容测试）。

### 缺口自动补抓

每次抓取时：

1. 读取上次快照各 ETF 的 `source.shareFetchGaps`。
2. SSE 的 `sseFailedDates` 合并进本轮抓取日期列表（去重后一起抓）。
3. SZSE 的 `szseFailedRanges` 解析为 `[start, end]` 区间，作为独立区间重新抓取。
4. 补抓成功 → 从缺口列表移除；仍失败 → 保留并计入完整性报告。
5. 缺口不阻塞主流程；审计继续降级为 warning。

### SSE/SZSE 抓取参数

保持不变：SSE 逐日查询、3 日并发；SZSE 按 170 天区间 + 分页；重试 5 次指数退避（400 × 2^i）。这些在上一轮已落地，本次只做搬移。

## 第 3 节：占比区间估算逻辑

落地 `2026-07-25-huijin-percentage-range-estimate-design.md` 的口径，实现于 `scripts/lib/estimate.ts`。

### 锚点

最近一期 `huijinShares > 0` 的披露报告（当前 2025-12-31），单锚点不变。

### 口径计算

对每个 `scaleHistory` 点 `s`：

1. **披露日命中**：`estimateMethod: 'disclosed'`，填正式披露值。不变。

2. **锚点日之后的 daily 点**（`s.date > anchor.reportDate && s.frequency === 'daily'`）：`estimateMethod: 'anchored'`。内部累加统一以**亿份**为单位（`netSubscriptionYi`、`totalSharesYi` 天然为亿份；`anchor.huijinShares` 为份，需 `/ 1e8` 转换）：

   - **下界 `huijinSharesFloor`**（亿份）：从披露汇金份额起，沿 daily 序列逐日累加 `netSubscriptionYi`。
     初值 `floor_0 = anchor.huijinShares / 1e8`；
     `floor_i = clamp(floor_{i-1} + netSubscriptionYi_i, 0, totalSharesYi_i)`。
     含义：份额变动全归因汇金（大额赎回/申购主要由汇金进行）。

   - **上界 `huijinSharesCeil`**（亿份）：`totalSharesYi_i × anchor.huijinPercent / 100`。
     含义：汇金占比不变，被动等比例稀释。

   - **展示值**：`weightedYi = floor × FLOOR_WEIGHT + ceil × CEIL_WEIGHT`，常量 `FLOOR_WEIGHT = 2/3`、`CEIL_WEIGHT = 1/3`（偏向下界，对齐"大额变动主要是汇金"先验）。置于 `lib/estimate.ts` 顶部。
     `huijinShares = round(weightedYi × 1e8)`（**份**，保持现有字段语义），`huijinPct = weightedYi / totalSharesYi_i × 100`。

   - **`huijinValueYi`**：`weightedYi × nav`（亿元），沿用 `nearestNav` 匹配；nav 缺失时为 null。

   - **落盘字段单位**：`huijinSharesFloor` / `huijinSharesCeil` 以**亿份**存储（与类型注释一致），`huijinShares` 以**份**存储（与现有披露点语义一致）。

3. **锚点日及之前 / 非 daily / 无锚点**：`disclosed`（披露日）或 `unavailable`（其余），不变。2024-01-01 至 2025-12-31 之间只有总份额趋势，不生成汇金估算。

### 趋势信号

`shareTrend`、`consecutiveDays`、`shareChangePct5d` 完整保留——基于总份额流向，与口径无关。

### 移除 clamp

删除 `clampTriggered`、`clampReliability` 及相关逻辑。占比区间口径下无 clamp 退化。

### 类型变更（`shared/types.ts`）

`HuijinEstimatePoint`：

- **删除**：`clampTriggered?: boolean`、`clampReliability?: 'just_triggered' | 'persistent' | 'persistent_recovering'`
- **新增**：
  ```ts
  /** 占比区间下界（份额变动全归因汇金，悲观侧），亿份。仅 anchored 点。 */
  huijinSharesFloor?: number | null
  /** 占比区间上界（汇金占比不变，被动稀释，乐观侧），亿份。仅 anchored 点。 */
  huijinSharesCeil?: number | null
  ```
- **保留**：`huijinShares`（展示值，区间加权）、`huijinPct`、`huijinValueYi`、`shareTrend`、`consecutiveDays`、`shareChangePct5d`。

`SignalInput` / `SignalOutput`（`shared/estimate-signals.ts`）：删除 `clampTriggered`、`clampReliability` 及 clamp 分支。

## 第 4 节：抓取完整性报告

`scripts/lib/report.ts`，纯函数接收 `DashboardData` + 抓取元数据，返回格式化字符串；`main()` 落盘后打印。

```
═══ 抓取完整性报告 ═══
上证50  510050  日频 380/382 (99.5%)  缺口: 2024-03-15, 2024-03-16
沪深300 510300  日频 382/382 (100%)   缺口: 无
中证500 510500  日频 382/382 (100%)   缺口: 无
中证1000 512100 日频 382/382 (100%)   缺口: 无
创业板  159915  日频 381/382 (99.7%)  缺口: 2024-05-20
科创50  588000  日频 382/382 (100%)   缺口: 无
持有人报告: 6/6 只各 1 期 (2025-12-31)
净值: 6/6 只 ≥1390 条
0AMV: 2738 条 (2015-01-05 → 2026-07-24)
缺口合计: 3 日 (SSE) / 0 段 (SZSE)
```

- 日频覆盖率 = 已获取交易日数 / 同期市场交易日总数（以 `marketActiveCapHistory` 的日期序列为基准，截取 ETF 日频范围）。
- 覆盖率 < 95% 时输出 `⚠` 标记。
- 缺口列表超过 10 个则截断：前 10 个 + `…等 N 个`。

## 第 5 节：审计变更（`scripts/data-audit.ts`）

- **删除**：anchored 的 `clampTriggered` / `clampReliability` 校验。
- **新增**：
  - `huijinSharesFloor` 与 `huijinSharesCeil` 均为非负有限数，且 `floor ≤ ceil`，且 `ceil ≤ totalShares`（容差 +1 份）。
  - `huijinShares` 落在 `[floor, ceil]` 区间内（容差 ±1 份，round 误差）。
  - `huijinPct` 由展示值与总份额反推一致（容差 0.02%）。
  - 抽样校验 `floor_i = clamp(floor_{i-1} + netSubscriptionYi_i, 0, totalSharesYi_i)` 累加一致性（亿份单位，从首个 anchored 点起，初值 = anchor.huijinShares / 1e8）。
  - `shareFetchGaps` 非空 → warning（不阻塞），列出缺口日期/区间。
- **保留**：`shareTrend` / `consecutiveDays` / `shareChangePct5d` 类型与同向链校验、日频/定期频率一致性校验。

## 第 6 节：口径声明（README + source.huijinEstimate）

更新为：

> 汇金持仓估算采用**占比区间**口径。下界：从最近披露汇金份额起逐日累加交易所总份额净变化（份额变动全归因汇金，假设大额赎回/申购主要由汇金进行）。上界：维持最近披露的汇金占比不变（汇金被动等比例稀释）。展示值取区间加权（下界 2/3 + 上界 1/3）。实际汇金份额落在区间内。趋势信号（份额流向、连续天数、5 日变化率）供方向参考。估算不代表汇金实际持仓，仅供研究。

## 不做的事

- 不恢复多期持有人报告（用户确认仍只要 1 期）。
- 不回填份额到 2024-01-01 之前。
- 不做估算值的置信区间或统计误差带。
- 不估算科创50（无锚点，保持 `unavailable`）。
- 不改前端组件（本次只做数据层；前端展示区间为后续任务）。
- 不改 0AMV 计算逻辑。

## 影响文件

- `scripts/fetch-data.ts`：拆分为编排层，保留 `main`、`loadPreviousDashboard`、`buildEtfSnapshot`、`fetchOfficialShareHistories`、`officialPointsFromSnapshot`、`mergeOfficialPoints`。
- `scripts/sources/http.ts`：新建，HTTP 基础设施。
- `scripts/sources/eastmoney.ts`：新建，东财行情/净值/规模/0AMV。
- `scripts/sources/sse.ts`：新建，上交所日频份额。
- `scripts/sources/szse.ts`：新建，深交所日频份额。
- `scripts/sources/sina.ts`：新建，新浪十大持有人。
- `scripts/lib/estimate.ts`：新建，占比区间估算。
- `scripts/lib/merge.ts`：新建，规模合并/披露历史/去重/净值匹配。
- `scripts/lib/report.ts`：新建，抓取完整性报告。
- `shared/types.ts`：`HuijinEstimatePoint` 删 clamp 字段、增 floor/ceil。
- `shared/estimate-signals.ts`：删 clamp 分支。
- `shared/backfill-window.ts`：新增 `backfillStart` 参数。
- `scripts/data-audit.ts`：删 clamp 校验、增区间校验、缺口 warning。
- `scripts/backfill-window.test.ts`：扩展 2024 起点用例。
- `scripts/estimate-signals.test.ts`：删除 clamp 用例。
- `README.md`：口径声明更新。
