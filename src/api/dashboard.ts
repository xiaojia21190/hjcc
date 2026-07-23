import type { DashboardData } from '../../shared/types'

export const supportsServerRefresh =
  import.meta.env.VITE_STATIC_DEPLOY !== 'true'

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
