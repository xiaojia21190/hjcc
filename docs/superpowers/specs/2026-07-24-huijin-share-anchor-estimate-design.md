# 汇金持仓份额锚定估算 — 设计说明

**日期：** 2026-07-24
**状态：** 已批准，待实现

## 背景

汇金持仓仅在基金年报/半年报「十大持有人」中披露（当前最新为 2025-12-31），披露间隔长达半年。项目已具备每只 ETF 的日频总份额序列（交易所官方接口）和单位净值序列，可以用份额锚定法在披露间隔期生成**明确标注的估算序列**。

## 估算口径：份额锚定法

**核心假设：** 汇金作为"稳定器"不主动赎回，披露后的净赎回来自其他持有人。

```
估算份额(t) = min(锚定汇金份额, 当日ETF总份额(t))
估算估值(t) = 估算份额(t) × 最近单位净值(t)
```

- **锚点**：最近一期 `huijinShares > 0` 的持有人披露报告（当前为 2025-12-31）
- **估算区间**：锚点日之后每个有日频份额的交易日
- **clamp 触发**：总份额 < 锚定汇金份额时，估算份额 = 总份额，标记 `clampTriggered: true`（可靠性下降，含义为"最多全是汇金的"）
- **无锚点 ETF**（如科创50，汇金份额=0）：`estimateMethod: 'unavailable'`，不生成估算点
- **披露日本身**：保持 `disclosed`，不用估算值覆盖
- **锚点日之前**：保持现有逻辑（仅披露日有值，其余 null），不做历史回填

### 试算验证（2026-07-22）

| ETF | 披露汇金(亿份) | 当前总份额(亿份) | 估算份额 | clamp |
|-----|-----------|-----------|--------|-------|
| 上证50ETF华夏 | 487.6 | 74.8 | 74.8 | ✅ |
| 沪深300ETF华泰柏瑞 | 735.1 | 240.4 | 240.4 | ✅ |
| 中证500ETF南方 | 144.1 | 57.9 | 57.9 | ✅ |
| 中证1000ETF南方 | 221.7 | 86.7 | 86.7 | ✅ |
| 创业板ETF易方达 | 170.2 | 166.3 | 166.3 | ✅ |
| 科创50ETF华夏 | 0 | — | 无锚点 | — |

合计估算 ≈ 2680 亿元（披露日 2025-12-31 合计 7327 亿元）。当前 5/5 有锚点的 ETF 均触发 clamp，说明 2026 年以来赎回规模极大，估算值实际为"总份额上限"，可靠性整体偏低——前端必须显著提示。

## 数据结构变更（shared/types.ts）

`HuijinEstimatePoint` 扩展：

```ts
/** 新增 'anchored'：份额锚定估算点 */
estimateMethod?: 'disclosed' | 'anchored' | 'unavailable'
/** clamp 触发：总份额已低于披露汇金份额，估算值 = 总份额，可靠性下降 */
clampTriggered?: boolean
```

`isEstimated` 在锚定估算点设为 `true`（当前恒为 `false`）。`huijinShares` / `huijinValueYi` / `huijinPct` 复用现有字段填入估算值；clamp 时 `huijinPct` 设为 100。

## 后端逻辑（scripts/fetch-data.ts）

`buildHuijinEstimate` 改造：

1. 从 `reports` 中找最近一期 `huijinShares > 0` 的报告作为锚点
2. 无锚点：全部标记 `unavailable`（现有行为）
3. 锚点日及之前：保持现有逻辑（披露日填披露值，其余 null）
4. 锚点日之后、有日频份额的每个点：
   - `estShares = min(anchorShares, totalSharesYi × 1e8)`
   - `clampTriggered = totalSharesYi × 1e8 < anchorShares`
   - `huijinShares = estShares`
   - `huijinValueYi = estShares × nearestNav / 1e8`
   - `huijinPct = clampTriggered ? 100 : anchorShares / (totalSharesYi × 1e8) × 100`
   - `isEstimated = true`，`estimateMethod = 'anchored'`
5. 锚点日之后但无日频份额（仅 periodic）的点：不生成估算（`unavailable`）

`source.huijinEstimate` 口径说明更新为份额锚定法描述。

## 前端展示

### HuijinTrendChart

- 新增"估算持仓"序列：虚线，与披露点实线视觉区分
- 估算点 tooltip 标注"份额锚定估算"；clamp 触发的点额外标注"⚠ 总份额已低于披露汇金份额"
- 披露点与首个估算点之间用虚线连接，表示估算区间起点

### SummaryCards

- 新增"估算合计估值"卡片：所有 ETF 最新估算值之和，标注估算日期
- 与现有"披露合计估值"并列展示

### EtfTable

- 新增"估算持仓(亿)"列：最新估算估值（亿元），clamp 触发的行显示 ⚠ 标记

### EtfDetail

- 口径说明更新为份额锚定法描述

## 口径声明更新

README 和设计文档中的"不估算"声明改为：

> 汇金持仓趋势展示两类数据点：① 十大持有人报告期正式披露点（实线）；② 最后披露期之后的份额锚定估算点（虚线，明确标注）。估算假设汇金不主动赎回，每日估算份额 = min(披露份额, 当日总份额)；当总份额低于披露份额时触发 clamp 并标记可靠性下降。估算不代表汇金实际持仓，仅供研究参考。

## 审计（scripts/data-audit.ts）

新增校验：
-锚定估算点的 `huijinShares ≤ totalSharesYi × 1e8`（clamp 约束）
- `estimateMethod: 'anchored'` 的点必须有 `isEstimated: true`
- 披露点（`disclosed`）必须 `isEstimated: false`

## 不做的事

- 不做历史回填（锚点日之前不估算）
- 不做比例锚定或边际归属的平行序列（已选定份额锚定为唯一口径）
- 不估算科创50（无锚点）
- 不做估算值的置信区间或误差带
