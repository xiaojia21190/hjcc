import type { DashboardData } from '../../shared/types'
import { timedProgress } from './refreshProgress'

export const REFRESH_TICK_MS = 500
export const REFRESH_POLL_MS = 3000
/**
 * 状态查询连续失败多少次后判 failed。
 * 抓取本身可以很慢（3–10 分钟），时间不是放弃理由；
 * 但 server 挂了 / 网络断到连状态都查不到时，不能无限死等。
 */
export const MAX_STATUS_FAILS = 10

export type RefreshWaitResult =
  | { kind: 'updated'; dashboard: DashboardData }
  | { kind: 'failed' }

export type RefreshStatusLite = { state: 'fetching' | 'idle' } | null

export interface RefreshWaitOptions {
  previousUpdatedAt?: string | null
  /** 进度参考耗时，仅用于进度条逼近曲线，不再作为放弃时间上限 */
  referenceMs: number
  loadDashboard: () => Promise<DashboardData>
  fetchStatus: () => Promise<RefreshStatusLite>
  onTick: (elapsedMs: number, progress: number) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

function isUpdated(
  dashboard: DashboardData,
  previousUpdatedAt?: string | null,
): boolean {
  return Boolean(dashboard.updatedAt && dashboard.updatedAt !== previousUpdatedAt)
}

async function checkDashboard(
  opts: RefreshWaitOptions,
): Promise<RefreshWaitResult | null> {
  try {
    const dashboard = await opts.loadDashboard()
    return isUpdated(dashboard, opts.previousUpdatedAt)
      ? { kind: 'updated', dashboard }
      : null
  } catch {
    return null
  }
}

/**
 * 500ms 心跳更新进度，3s 轮询 dashboard/status，直到更新或失败。
 *
 * 放弃条件：**只看 server 状态，不看时间**。抓取全量可能 3–10 分钟，
 * 只要 server 说还在 fetching 就一直 loading，不让用户以为“没作用”。
 * 唯一的 failed 路径：
 *   1. server 转为 idle 后数据仍未变 → 抓取失败/未写入；
 *   2. 状态查询连续失败 MAX_STATUS_FAILS 次 → server 不可达。
 * 数据随时更新随时返回 updated，不等下一个轮询窗口。
 */
export async function waitForRefresh(
  opts: RefreshWaitOptions,
): Promise<RefreshWaitResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)))
  const started = now()
  let lastPoll = -REFRESH_POLL_MS
  let statusFails = 0
  let firstPollDone = false

  while (true) {
    const elapsed = now() - started
    opts.onTick(elapsed, timedProgress(elapsed, opts.referenceMs))

    // dashboard 优先：数据已更新就立刻返回，不用等轮询窗口
    const updated = await checkDashboard(opts)
    if (updated) return updated

    // 首个轮询窗口完成前不查状态：刚触发刷新时 server 状态可能尚未更新，
    // 避免立即读到 idle 误判失败。lastPoll 初始为 -REFRESH_POLL_MS，
    // 故首次满足 elapsed - lastPoll >= REFRESH_POLL_MS 时 elapsed≈0，
    // 用 elapsed >= REFRESH_POLL_MS 显式卡住首个窗口。
    if (elapsed >= REFRESH_POLL_MS && elapsed - lastPoll >= REFRESH_POLL_MS) {
      lastPoll = elapsed
      firstPollDone = true
      try {
        const status = await opts.fetchStatus()
        statusFails = 0
        // server 已转 idle 且数据未变 → 抓取完成但没成功写入，判失败
        if (status?.state === 'idle') return { kind: 'failed' }
      } catch {
        statusFails += 1
        // 连续多次查不到 server 状态（server 挂/网络断），避免无限死等
        if (statusFails >= MAX_STATUS_FAILS) return { kind: 'failed' }
      }
    }
    await sleep(REFRESH_TICK_MS)
    // 防御性：若调用方注入的 now 没推进（测试失误），避免死循环
    if (firstPollDone && now() === started && elapsed >= REFRESH_POLL_MS * 2) {
      return { kind: 'failed' }
    }
  }
}
