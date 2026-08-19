# 通达信（tdx）数据源接入说明

本项目通过 [`node-tdx-market`](https://www.npmjs.com/package/node-tdx-market) **直连通达信行情服务器**（TCP 二进制协议），无需 Go 边车 / httpserver，作为 **0AMV 主数据源** 与 **ETF 换手率历史回填源**。东财 `push2his` 降为备用。

## 为什么接入

README 记录的痛点：

- 东财 `push2his` 的 `kline/get` 路径曾被按路径级封禁（返回 TCP RST 而非 HTTP 状态码），需要三域名回退链 + 重试。
- 0AMV 成交额依赖上证综指 + 深证成指日成交额；东财历史日线接口偶发返回空序列。
- Tushare 备用源免费额度受限（每小时一次），默认不自动启用。
- **场内换手率历史只能每日快照积累，无历史回填**，交投温度分位需 ≥30 日样本。

通达信协议直连行情服务器（TCP 7709/7727），自带成交额字段，不受 HTTP 路径封禁影响。

## 架构（直连版，零部署）

```
[通达信行情服务器 7709/7727]
        ↑ TCP 二进制协议（node-tdx-market）
[hj scripts/sources/tdx.ts]   ← 本项目数据源，同进程直连
        ↓
data/dashboard.json          ← 不变
``

- **主行情 7709**：`TdxClient`，取指数日 K（sh000001/sz399001）与 ETF 日 K（换手率回填）
- **扩展行情 7727**：`TdxExHqClient`，取中证全指 000985（0AMV 价格代理，market=62）
- 两个 client 为模块级单例懒加载，复用 TCP 长连接 + 心跳
- **无需任何额外进程**，`npm install` 后 `bun run fetch` 即用

## 接入状态

**已挂入 `fetch-data.ts` 主流程**，作为 0AMV 最优先源。容错链：

```
tdx (直连)  →  东财 push2his  →  东财最新快照  →  Tushare  →  缓存
```

- tdx 成功：`MarketActiveCapQuality.source = 'tdx'`，前端质量带显示「通达信历史日线」。
- tdx 不可用（连不上服务器）：静默降级东财，**不记入 warning**，沿用原有东财回退链，行为与改动前完全一致。
- 实现见 `scripts/fetch-data.ts` 的 `resolveMarketActiveCapHistory`。

`shared/types.ts` 的 `MarketActiveCapDataSource` 已预留 `'tdx'` 值。

## 安装

依赖已写入 `package.json`：

```json
"dependencies": { "node-tdx-market": "^0.2.1" }
```

`bun install` 后即可使用，无需启动任何服务。

## 验证

```bash
# 1. 连通性验证
bun run scripts/probe-tdx.ts

# 2. 与东财缓存对账（需联网，默认 skip，TDX_LIVE=1 触发）
TDX_LIVE=1 bun test --timeout 60000 scripts/tdx-vs-cache.test.ts
```

实测对账结果（2026-08）：
- 0AMV 成交额：693 个公共交易日，**匹配率 99.9%**（>1% 差异仅 0.14%）
- 中证全指收盘：>0.1% 差异仅 0.1%
- ETF 换手率：同日对比东财快照 f8 vs tdx 回算，6.090% vs 6.094%，几乎完全一致

## 历史深度

实测（2026-08）：翻页拉取（每页 800 条，终止于返回空）可覆盖到 **2013 年**，约 2793 个交易日，
与东财缓存的 2819 点（2015 起）等长甚至更早。对账 2517 个公共交易日，>1% 差异仅 0.04%。

早期实现误用「不足一页则终止」判断翻页结束，导致只拿到 700 点；已修复为「返回空才终止」+
MAX_PAGES=100 安全上限。

## 单位换算（关键）

node-tdx-market 与 injoyai/tdx 同源，单位口径一致。但**主行情与扩展行情单位不同**：

| 来源 | 字段 | 单位 | 转元 |
|------|------|------|------|
| 主行情 `KlineBar` | `close` | 厘（元×1000） | `÷1000` |
| 主行情 `KlineBar` | `amount` | 厘 | `÷1000` |
| 主行情 `KlineBar` | `volume`（股票/ETF） | 手 | 原值即手 |
| 主行情 `KlineBar` | `volume`（指数） | 手×100 | 不使用 |
| **扩展行情 `ExKline`** | `close` | **元（float32）** | 直接用 |
| **扩展行情 `ExKline`** | `amount` | **元（float32）** | 直接用 |
| `Time` / `datetime` | — | RFC3339 / `YYYY-MM-DD` | 取前 10 字符为交易日 |

关键：0AMV 的价格代理 000985 走**扩展行情**（close 已是元），成交额源 sh000001/sz399001 走**主行情**（amount 是厘需 ÷1000）。`scripts/sources/tdx.ts` 的 `fetchCsiIndexBars` 与 `parseTdxKline` 已分别处理这两套单位。

## 口径一致性验证

`scripts/sources/tdx.test.ts` 中：

```ts
// 用相同输入跑 eastmoney 与 tdx 的 0AMV 合成，断言逐点完全一致
const expected = buildMarketActiveCapHistory(series)
const out = buildTdxMarketActiveCapHistory(series)
expect(out).toEqual(expected)
```

`scripts/tdx-vs-cache.test.ts` 是集成对账（默认 skip，`TDX_LIVE=1` 触发真实联网）：

- 拉取 tdx 的 0AMV 三件套，与 `data/dashboard.json` 已缓存的 `marketActiveCapHistory` 逐日比对成交额与收盘。
- 容差：成交额 1%（口径差异，东财含北交所）、收盘 0.1%。
- tdx 直连失败时优雅 skip，不污染 CI / `bun run test`。

```bash
TDX_LIVE=1 bun test --timeout 60000 scripts/tdx-vs-cache.test.ts
```

## 降级链

tdx 失败（连不上服务器 / 连接超时）静默降级到东财，不影响 `bun run fetch` 主流程。`scripts/sources/tdx.ts` 的 `fetchTdxMarketActiveCapHistory` 内部抛错，`resolveMarketActiveCapHistory` 用 try/catch 捕获并降级。

## ETF 换手率历史回填（第二步接入）

`README.md` 原痛点：场内换手率历史「每日快照 append 积累，无历史回填」，`retailMetrics` 的交投温度分位需 ≥30 日样本、≥270 日才纳入标定。

现已用 tdx ETF 日 K 成交量回算换手率，一次性回填 `turnoverHistory`：

- 实现：`scripts/sources/tdx.ts` 的 `fetchTdxKlineBars`（`/kline/day/all`）+ `deriveTurnoverFromTdx`
- 口径与东财 f8 一致：`turnoverPct = 场内成交量(股) / 基金总份额(股) × 100`
  - tdx `Volume`（手）× 100 = 股
  - `scaleHistory.totalSharesYi`（亿份）× 1e8 = 股（份额按日期向前填充）
- 挂入点：`buildEtfSnapshot` 内部，`scaleHistory` 合并后调用，回填结果覆盖旧快照积累与当日快照（统一 tdx 口径，避免新旧换手率口径混用）
- tdx 不可用：`fetchTdxTurnoverBackfill` 返回空数组，退化为原「快照积累」行为，与改动前完全一致

回填后 `retailMetrics` 的交投温度分位将基于完整历史（2024-01-01 起的份额覆盖范围），不再受「样本不足」限制。

## 注意事项

1. **通达信服务器是公网 IP**（华为云/腾讯云），国内访问稳定，但属逆向协议，高频可能被限。本项目仅在 `bun run fetch` 抓取时用，不做实时轮询。
2. **北交所口径**：tdx 标准行情 7709 的 `GetIndexDayAll("sh000001")` 不含北交所成交额，而东财 `000001` 含。对账时成交额可能有系统性偏差，1% 容差已覆盖。若需完全对齐，可改用 `sh899050`（北证50）补齐。
3. **板块指数 ≠ 申万二级**：tdx 板块指数 880xxx（概念）/ 881xxx（行业）是通达信自有分类，与本项目题材主线用的申万二级（东财 BK04-BK10）不对应，**只能做交叉验证，不能直接替换**。
4. **合规**：通达信协议为逆向实现，研究/个人项目可用，生产环境慎用。
