import type { DashboardData } from '../../shared/types'

export const supportsServerRefresh =
  import.meta.env.VITE_STATIC_DEPLOY !== 'true'

/** 前端等待上限，与后端 referenceDurationMs 解耦。 */
// 实测一轮全量抓取 160–300s，板块补抓失败时逼近 5 分钟；预留余量到 7 分钟。
export const MAX_WAIT_MS = 420_000
export const DEFAULT_REFERENCE_DURATION_MS = 240_000

export type RefreshStatus = {
  state: 'fetching' | 'idle'
  startedAt: string | null
  updatedAt: string | null
  referenceDurationMs: number
  /** 最近一次 fetch 的结果；null 表示从未跑过或正在首次运行 */
  lastRun?: {
    exitCode: number | null
    startedAt: string
    finishedAt: string
    durationMs: number
    dataUpdatedAt: string | null
  } | null
}

export async function loadDashboard(): Promise<DashboardData> {
  // 优先 API，失败则读静态 public
  if (supportsServerRefresh) {
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' })
      if (res.ok) {
        return (await res.json()) as DashboardData
      }
    } catch {
      /* fallthrough */
    }
  }
  const res = await fetch(`${import.meta.env.BASE_URL}dashboard.json`, {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error('无法加载数据，请先运行 bun run fetch')
  return (await res.json()) as DashboardData
}

export async function refreshDashboard(): Promise<{ ok: boolean; message: string }> {
  if (!supportsServerRefresh) {
    return { ok: false, message: 'GitHub Pages 数据由 GitHub Actions 定时更新' }
  }
  const res = await fetch('/api/refresh', { method: 'POST' })
  return (await res.json()) as { ok: boolean; message: string }
}

export async function fetchRefreshStatus(): Promise<RefreshStatus | null> {
  if (!supportsServerRefresh) return null
  try {
    const res = await fetch('/api/refresh/status', { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as RefreshStatus
  } catch {
    return null
  }
}
