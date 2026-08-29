/** 基金定期报告披露窗口与下一次强制披露倒计时。纯函数，便于单测。 */

export interface DisclosureWindow {
  /** 报告期，如 2025-12-31（年报）或 2026-06-30（半年报） */
  reportDate: string
  /** 强制披露截止日（年报 4-30，半年报 8-31） */
  deadline: string
  kind: '年报' | '半年报'
}

/**
 * 给定"今天"，返回当前/下一次强制披露窗口。
 * 规则：
 * - 1/1 - 4/30：等待年报（上一年度 12-31 报告期），截止 4-30
 * - 5/1 - 8/31：等待半年报（当年 06-30 报告期），截止 8-31
 * - 9/1 - 12/31：等待下年度年报（当年 12-31 报告期），截止次年 4-30
 */
export function nextDisclosureWindow(todayIso: string): DisclosureWindow {
  const [y, m] = todayIso.slice(0, 7).split('-').map(Number)
  const month = m ?? 1
  if (month <= 4) {
    return {
      reportDate: `${y - 1}-12-31`,
      deadline: `${y}-04-30`,
      kind: '年报',
    }
  }
  if (month <= 8) {
    return {
      reportDate: `${y}-06-30`,
      deadline: `${y}-08-31`,
      kind: '半年报',
    }
  }
  return {
    reportDate: `${y}-12-31`,
    deadline: `${y + 1}-04-30`,
    kind: '年报',
  }
}

/** 从 today 到 deadline 的自然日数；已过期返回 0。 */
export function daysUntil(todayIso: string, deadline: string): number {
  const today = Date.parse(`${todayIso}T00:00:00Z`)
  const end = Date.parse(`${deadline}T00:00:00Z`)
  if (!Number.isFinite(today) || !Number.isFinite(end)) return 0
  return Math.max(0, Math.round((end - today) / 86400000))
}

export interface DisclosureCountdown {
  window: DisclosureWindow
  daysLeft: number
  /** 最近一次已披露的报告期（来自数据），用于对比 */
  latestReport: string | null
  /** 距下次窗口截止是否 ≤ 30 天（高亮提示） */
  imminent: boolean
}

export function disclosureCountdown(
  todayIso: string,
  latestReport: string | null,
): DisclosureCountdown {
  const window = nextDisclosureWindow(todayIso)
  const daysLeft = daysUntil(todayIso, window.deadline)
  return {
    window,
    daysLeft,
    latestReport,
    imminent: daysLeft <= 30,
  }
}
