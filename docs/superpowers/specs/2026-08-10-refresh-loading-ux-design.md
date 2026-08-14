---
date: 2026-08-10
topic: refresh-loading-ux
status: implemented
---

# 在线刷新 loading 体验打磨 设计

## 背景与目标

项目已具备 server 代理的在线刷新机制:`App.vue` 通过 `loadDashboard` / `refreshDashboard`,
读取后端 `server/index.ts` 暴露的 `/api/dashboard` 与 `/api/refresh`,
后者 `spawn` 跑 `scripts/fetch-data.ts` 抓全市场并回写 `dashboard.json`。

**痛点**:刷新期间前端是黑盒——

1. 点"刷新公开数据"后屏幕几乎无变化(仅按钮文案 `抓取中…`),
   用户不知道在抓第几步、是否还在动;
2. `onRefresh` 靠每 2s 盲轮询 `updatedAt`,最多 60 次(120s);
3. 超时静默回到原状,用户分不清"还在抓"还是"挂了";
4. 首次/重载态是 plain 文案,无 spinner;`reload` 整屏替换易闪屏、丢上下文。

**目标**:后端抓取逻辑 (`fetch-data.ts` / 现有端点契约) 完全不动,
只打磨 Vue 端 loading / 进度 / 状态反馈:计时驱动的视觉进度、
有明确上限的等待、统一 toast 反馈、避免屏闪与静默超时。

**范围边界(YAGNI)**

- 不做真实阶段进度(脚本不改)。
- 不做 SSE/WebSocket 流式(轮询只读状态端点足矣)。
- 不引新组件库,沿用现有 `.btn` / `.pill` / `.state` 风格。
- 不动任何 chart/table 组件,不改 `shared/types.ts`。
- 不在 loading 态做骨架屏(长任务用诚实计时进度条优于骨架)。

## 设计

### §1 数据流与后端契约

后端 `server/index.ts` 现有 `fetching` 布尔量升级为带时间戳的状态对象
(仅在内存,不落盘):

```
type FetchStatus = {
  state: 'fetching' | 'idle'
  startedAt: string | null   // ISO,runFetch 触发时写 new Date().toISOString()
  updatedAt: string | null   // ISO,与 startedAt 同步,预留
}
```

变更点:

1. **`fetching` 升级为 `fetchStatus`**;`/api/refresh` 触发时置 `{state:'fetching', startedAt, updatedAt}`(不等于之前 `<409 cron>`),抓取完成回调里改回 `{state:'idle', startedAt:null, updatedAt: completedAt}`。
2. **新增只读端点 `GET /api/refresh/status`**,返回上述对象 + 一个常量 `referenceDurationMs`(默认 `90_000`,即"通常 60-120 秒"区间里偏 90s 的参考值)。
3. **完全不改** `/api/refresh`、`/api/dashboard` 契约;**完全不碰** `fetch-data.ts`。

前端 `src/api/dashboard.ts` 新增:

- `fetchRefreshStatus(): Promise<{ state, startedAt, updatedAt, referenceDurationMs }>`
- 导出常量 `MAX_WAIT_MS = 150_000`(决定超时阈值,与后端 `referenceDurationMs` 解耦——前端用独立的、更宽裕的上限)。

进度条驱动模型(纯前端、基于计时):

- 参考时长 `R = referenceDurationMs`(来自状态端点,默认 90s)。
- 进度 `p(t)`(`t` 为已耗时 ms):
  - `t < 0.8·R`:`p = t / R * 0.8`(线性逼近到 0.8)。
  - `t >= 0.8·R`:`p = 0.8 + 0.15 * (1 - 1/(1 + k*(t-0.8R)))`,单调增、趋向 0.95、**永不撞 1**。
    其中 `k = 1/(0.2·R)`(在 `t = 1.5·R` 时 `p ≈ 0.92`,`t = 2·R` 时 `p ≈ 0.93`)。
  - 视觉上"前 80% 老实线性、后段减速停在 0.95",传达"在等你"。
- 诚实文案:`抓取中 · 已用时 N 秒`,不显示百分比。

### §2 UI 层(仅 App.vue + main.css)

**1. 顶栏按钮**

- idle:`刷新公开数据`
- refreshing:`【spinner 点】抓取中 · 已用时 {n} 秒`,`disabled`
- "重新加载"在 refreshing 时禁用,避免并发。

**2. 全局进度条(refreshing 时渲染,顶栏下方 / main 之前)**

- 高度 3-4px,`width: calc(var(--progress) * 100%)`,带 `transition: width 0.8s ease-out`。
- 下方一行 `.muted` 备注:"正在后台拉取公开数据,完成后自动刷新"。

**3. 首次/重载态**

- `data===null` 且 `loading`:`.state` 内放 spinner + "正在加载看板数据…"。
- 已有数据但 `loading=true`(reload 重试):**保留已有内容**,仅顶部细进度条 + 顶栏按钮态变化,避免整屏替换闪屏。

**4. toast(统一反馈,新增唯一 DOM)**

- 失败/超时/成功都用同一条 toast:页面底部细条,`v-if toast.show`,`setTimeout` 自动清(成功 4s,错误 6s)。
- 成功:`已更新至 {updatedAt 短时间}`,进度条收起从 0.95 直接落空。
- 超时(`MAX_WAIT_MS` 到,后端仍 `fetching`):`后台抓取超时,数据可能仍在生成,可稍后点击"重新加载"`;`refreshing=false`,进度条收起。
- 失败(后端 `state:idle` 但 `updatedAt` 没变):`抓取可能失败,详见服务器日志`。
- `App.vue` 用 `toast = ref<{show, tone, text}>()` 管理,`finally` 统一收口。

**5. 并发安全**

- 闪烁中重复点刷新按钮直接忽略(`if (refreshing.value) return`)。
- 进度收敛为**单个** `setInterval` ticker(~每 500ms 更新进度条与秒数文案)+ 一个**较长间隔**轮询(每 3s 拉一次 dashboard 比对 `updatedAt`,或拉一次 status 判失败),
  统一在 `finally` 里 `clearInterval`/`clearTimeout`;替换现有 `for` 循环 `setTimeout`。

### 改动文件清单

| 文件 | 改动 | 估算行数 |
|---|---|---|
| `server/index.ts` | `fetchStatus` 对象 + `/api/refresh/status` | ~30 |
| `src/api/dashboard.ts` | `fetchRefreshStatus()` + `MAX_WAIT_MS` | ~15 |
| `src/App.vue` | `onRefresh` ticker 模型 / 顶栏文案 / loading 分支 / toast | ~60 |
| `src/styles/main.css` | 进度条 / spinner / toast 样式块 | ~40 |

### 验证方式

1. **无 server 纯静态**(`VITE_STATIC_DEPLOY=true` 下 build 预览):`/api/refresh/status` 不应被请求;重载走 `public/dashboard.json` fallback;loading 态 spinner 正常。
2. **有 server**:`bun run server`,点"刷新公开数据"→ 进度条出现、秒数递增、按钮禁用;完成后 toast"已更新至…";超时(人为停掉后端接口模拟)显示超时 toast 且不崩。
3. 失败态:停止后端,点刷新 → 友好错误 toast,非 console only。
4. 重载不闪屏:已有数据时点"重新加载"保持画面、仅顶栏进度条动。
5. `bun run build` / `vue-tsc` 通过,无新增类型错误。
