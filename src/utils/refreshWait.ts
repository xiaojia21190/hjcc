import type { DashboardData } from '../../shared/types'
import { timedProgress } from './refreshProgress'

export const REFRESH_TICK_MS = 500
export const REFRESH_POLL_MS = 3000

export type RefreshWaitResult =
  | { kind: 'updated'; dashboard: DashboardData }
  | { kind: 'timeout' }
  | { kind: 'failed' }

export type RefreshStatusLite = { state: 'fetching' | 'idle' } | null

export interface RefreshWaitOptions {
  previousUpdatedAt?: string | null
  maxWaitMs: number
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

async function pollOnce(
  opts: RefreshWaitOptions,
  elapsed: number,
): Promise<RefreshWaitResult | null> {
  const updated = await checkDashboard(opts)
  if (updated) return updated
  if (elapsed < REFRESH_POLL_MS) return null
  try {
    const status = await opts.fetchStatus()
    return status?.state === 'idle' ? { kind: 'failed' } : null
  } catch {
    return null
  }
}

/** 500ms 心跳更新进度，3s 轮询 dashboard/status，直到更新、失败或超时。 */
export async function waitForRefresh(
  opts: RefreshWaitOptions,
): Promise<RefreshWaitResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)))
  const started = now()
  let lastPoll = -REFRESH_POLL_MS

  while (true) {
    const elapsed = now() - started
    opts.onTick(elapsed, timedProgress(elapsed, opts.referenceMs))
    if (elapsed - lastPoll >= REFRESH_POLL_MS) {
      lastPoll = elapsed
      const result = await pollOnce(opts, elapsed)
      if (result) return result
    }
    if (elapsed >= opts.maxWaitMs) {
      const updated = await checkDashboard(opts)
      if (updated) return updated
      try {
        const status = await opts.fetchStatus()
        if (status?.state === 'idle') return { kind: 'failed' }
      } catch {
        /* 超时且状态不可达，按仍在抓取处理 */
      }
      return { kind: 'timeout' }
    }
    await sleep(REFRESH_TICK_MS)
  }
}
