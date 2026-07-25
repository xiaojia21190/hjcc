# 份额数据精确化 + 汇金估算趋势信号 — 设计说明

**日期：** 2026-07-25
**状态：** 已批准，待实现
**关联：** [2026-07-24 份额锚定估算设计](./2026-07-24-huijin-share-anchor-estimate-design.md)

## 背景

当前抓取与估算存在四个问题，导致"跟随汇金"目标难以实现：

1. **日频份额只回填 250 天**（`OFFICIAL_SHARE_BACKFILL_TRADING_DAYS = 250`），首日为 2025-07-14，但汇金披露日是 2025-12-31。披露日当天的总份额来自东财定期规模（periodic），而非交易所日频，锚点份额精度不足。
2. **抓取不稳定丢交易日**：`fetchText` 仅重试 3 次退避 400ms；SZSE 失败即 `break` 丢整段（创业板实测 249/250）；单页失败影响整批。
3. **估算 clamp 区间失效**：份额锚定法以最近一期（2025-12-31）为唯一锚点，2026 年以来 5/5 ETF 全部触发 clamp，估算值退化为"总份额上限"，失去信息量。
4. 历史持有人报告只抓 1 期（用户已确认本次**放弃历史持有人**，不在范围）。

本次目标：拿到 2025-12-31 之后完整准确的日频总份额，**保持份额锚定口径不变**，在估算点上附加趋势信号层，让用户能从估算序列读出汇金"被稀释 / 被反稀释"的方向。

## 第 1 节：份额数据精确化

### 范围

每只 ETF 份额历史回填窗口以**最近汇金披露日（当前 2025-12-31）为起点**，覆盖至最新交易日。不回填到 2019 年——用户只需 2025 年底之后的区间。

### 改动

**回填锚点动态化**（`scripts/fetch-data.ts`）：

- `OFFICIAL_SHARE_BACKFILL_TRADING_DAYS` 不再用固定 250。
- `officialFetchDates` 改为：若 `existing` 为空，回填起点 = `max(最近汇金披露日, 最近交易日 - N)`，确保披露日当天落在交易所日频区间内，锚点份额为交易所真实值。
- 实现上：传入 `latestHuijinReportDate`（从 `previous.huijinHistory` 末尾取，或首次抓取后从 holderReports 取），回填窗口下界 = 该披露日向前 overlap 5 个交易日。

**SSE 上交所**（`fetchSseDailyShares`）：

- 维持按 `STAT_DATE` 逐日查询（接口无可靠区间批量）。
- 失败重试 5 次指数退避（400/800/1600/3200/6400ms），单日仍失败则记入 `failedDates`，**不中断后续日期**。
- `failedDates` 落盘到 `source.shareFetchGaps`，下次抓取优先补抓。

**SZSE 深交所**（`fetchSzseDailyShares`）：

- 失败 `break` 改为**跳过坏页续抓**：单页失败重试 5 次，仍失败则记 `failedRanges`，继续下一页/区间。
- 不再因一页失败丢失整段历史。

**抓取健壮性**（`fetchText` / 批量层）：

- 重试 3 → 5 次，退避改为指数（400 × 2^i）。
- 批量并发 4 → 3，超时 20s → 30s。
- 批量内单点失败不影响其他点（已是此行为，强化日志）。

**净值历史**（`fetchNavHistory`）：

- 单页失败 `break` 改为 continue 重试 5 次，保证净值序列连续（估值依赖）。

### 数据缺口记录

`EtfSnapshot.source` 新增可选字段：

```ts
shareFetchGaps?: {
  sseFailedDates?: string[]   // 上交所单日抓取失败日期
  szseFailedRanges?: string[] // 深交所失败区间 "start..end"
}
```

非空时审计降级为 warning，提示数据缺口，不阻塞。

## 第 2 节：估算逻辑 — 保持口径，加趋势信号

### 口径不变

份额锚定法（`min(披露份额, 当日总份额)`），clamp 诚实标注。不改为占比锚定，不引入双口径并列。

### 新增趋势信号

`HuijinEstimatePoint`（`shared/types.ts`）新增可选字段，仅在 `estimateMethod: 'anchored'` 估算点填充，不改现有字段语义：

```ts
/** 当日总份额相对前交易日的方向 */
shareTrend?: 'inflow' | 'outflow' | 'flat'
/** 连续同向天数（含当日） */
consecutiveDays?: number
/** 近 5 个交易日总份额变化率 % */
shareChangePct5d?: number | null
/** clamp 可靠性细分：just_triggered=刚触发; persistent_recovering=长期clamp但份额回升; persistent=长期clamp无回升 */
clampReliability?: 'just_triggered' | 'persistent' | 'persistent_recovering'
```

### 计算逻辑（`buildHuijinEstimate`，`scripts/fetch-data.ts`）

对每个 `anchored` 估算点 `s`：

1. **`shareTrend`**：基于 `s.netSubscriptionYi`（已在 `mergeScaleHistory` 计算为"当日 - 上一交易日"）：
   - `> 0` → `inflow`；`< 0` → `outflow`；`= 0` 或 null → `flat`
2. **`consecutiveDays`**：向前回溯 `huijinEstimateHistory` 已算点，统计与当日 `shareTrend` 同向的连续天数（含当日）。
3. **`shareChangePct5d`**：`(当日 totalSharesYi - 5 交易日前 totalSharesYi) / 5 交易日前 × 100`，5 日内任一点缺失则为 `null`。
4. **`clampReliability`**（仅 clamp 触发时）：
   - `just_triggered`：当日刚进入 clamp（前一日未 clamp）
   - `persistent`：连续 clamp 且 `shareChangePct5d ≤ 0`（份额仍下降或持平）
   - `persistent_recovering`：连续 clamp 且 `shareChangePct5d > 0`（份额触底回升，汇金可能重新占主导，信号偏多）

### 信号语义（对"跟随汇金"的含义）

- **连续 inflow**：份额净流入，若未 clamp 则汇金占比被动稀释减缓；若 clamp 中则总份额回升，可能带动汇金重新占主导。
- **连续 outflow**：份额净流出，汇金占比被动上升（稀释加剧），但总规模下降。
- **`persistent_recovering`**：clamp 区间 + 份额触底回升，是"跟随汇金"最值得关注的偏多信号——汇金可能在重新成为主导持有人。
- 信号供方向参考，不代表汇金实际操作。

## 第 3 节：前端展示与口径

### HuijinTrendChart

- 估算虚线基础上，叠加一条"总份额变化率 `shareChangePct5d`"次轴曲线（浅色细线）。
- clamp 区间用浅色背景带标注（区分 just_triggered / persistent / persistent_recovering 三档透明度）。
- 估算点 tooltip 增加趋势信号文案：
  - "连续 3 日净流入"
  - "份额触底回升（clamp 恢复中）"
  - "近 5 日份额 +2.1%"

### EtfTable

- 新增"份额趋势"列：近 5 日流向箭头（↑/↓/→）+ 连续天数，clamp 行保留 ⚠。
- tooltip 展示 `clampReliability` 文案。

### 口径声明（README / 前端）

更新为：

> 汇金持仓估算保持份额锚定口径（估算份额 = min(披露份额, 当日总份额)）。clamp 区间（总份额低于披露汇金份额）估算值为总份额上限、绝对值可靠性低。趋势信号（份额流向、连续天数、5 日变化率、clamp 可靠性细分）供方向参考，用于判断汇金"被稀释 / 被反稀释"，不代表汇金实际操作。

## 第 4 节：审计（scripts/data-audit.ts）

新增校验：

- `anchored` 估算点的 `shareTrend` / `consecutiveDays` / `shareChangePct5d` / `clampReliability` 字段类型合法。
- `consecutiveDays ≥ 1` 且与 `shareTrend` 同向链一致（抽样校验：连续同向段内 `consecutiveDays` 单调递增）。
- `clampReliability` 仅在 `clampTriggered: true` 时出现。
- `source.shareFetchGaps` 非空 → warning（不阻塞），列出缺口日期/区间。

## 不做的事

- 不回填份额到 2019 年（只覆盖 2025-12-31 之后）。
- 不改份额锚定口径为占比锚定，不并列双口径。
- 不恢复历史持有人报告（用户已确认放弃）。
- 不做估算值的置信区间或误差带。
- 不估算科创50（无锚点，保持 `unavailable`）。

## 影响文件

- `scripts/fetch-data.ts`：回填窗口动态化、SSE/SZSE 容错、`fetchText`/`fetchNavHistory` 重试、`buildHuijinEstimate` 趋势信号、`source.shareFetchGaps`。
- `shared/types.ts`：`HuijinEstimatePoint` 新增趋势信号字段、`EtfSnapshot.source` 新增 `shareFetchGaps`。
- `scripts/data-audit.ts`：新字段校验 + 缺口 warning。
- `src/`（HuijinTrendChart / EtfTable 组件）：趋势信号展示。
- `README.md`：口径声明更新。
