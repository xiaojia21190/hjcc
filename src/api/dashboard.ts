import type { DashboardData } from '../../shared/types'

export const supportsServerRefresh =
  import.meta.env.VITE_STATIC_DEPLOY !== 'true'

/** 前端等待上限，与后端 referenceDurationMs 解耦。 */
export const MAX_WAIT_MS = 150_000
export const DEFAULT_REFERENCE_DURATION_MS = 90_000

export type RefreshStatus = {
  state: 'fetching' | 'idle'
  startedAt: string | null
  updatedAt: string | null
  referenceDurationMs: number
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
