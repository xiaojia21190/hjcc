import { describe, expect, test } from 'bun:test'
import type { DashboardData } from '../../shared/types'
import { MAX_STATUS_FAILS, REFRESH_POLL_MS, waitForRefresh } from './refreshWait'

function dashboard(updatedAt: string): DashboardData {
  return { updatedAt } as DashboardData
}

describe('waitForRefresh', () => {
  test('数据时间戳一变就返回 updated，不等轮询窗口', async () => {
    let now = 0
    const result = await waitForRefresh({
      previousUpdatedAt: 'old',
      referenceMs: 90_000,
      loadDashboard: async () => dashboard('new'),
      fetchStatus: async () => ({ state: 'fetching' }),
      onTick: () => undefined,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })
    expect(result.kind).toBe('updated')
    if (result.kind === 'updated') expect(result.dashboard.updatedAt).toBe('new')
  })

  test('server 转为 idle 且数据未变 → failed', async () => {
    let now = 0
    const result = await waitForRefresh({
      previousUpdatedAt: 'old',
      referenceMs: 90_000,
      loadDashboard: async () => dashboard('old'),
      fetchStatus: async () => ({ state: 'idle' }),
      onTick: () => undefined,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })
    expect(result.kind).toBe('failed')
    expect(now).toBeGreaterThanOrEqual(REFRESH_POLL_MS)
  })

  test('server 一直 fetching → 不因时间到放弃，持续等待直到数据更新', async () => {
    let now = 0
    let polls = 0
    // 模拟：前 5 次轮询 server 仍 fetching，第 6 次时数据终于更新
    const result = await waitForRefresh({
      previousUpdatedAt: 'old',
      referenceMs: 90_000,
      loadDashboard: async () => {
        // 经过足够多轮询后数据才变（now 已远超曾经的 maxWait）
        return now > REFRESH_POLL_MS * 6 ? dashboard('new') : dashboard('old')
      },
      fetchStatus: async () => {
        polls += 1
        return { state: 'fetching' }
      },
      onTick: () => undefined,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })
    expect(result.kind).toBe('updated')
    // 验证：确实等了很多轮，没有在某个时间点放弃
    expect(polls).toBeGreaterThan(3)
  })

  test('状态查询连续失败 MAX_STATUS_FAILS 次 → failed（server 不可达兜底）', async () => {
    let now = 0
    let fails = 0
    const result = await waitForRefresh({
      previousUpdatedAt: 'old',
      referenceMs: 90_000,
      loadDashboard: async () => dashboard('old'),
      fetchStatus: async () => {
        fails += 1
        throw new Error('server down')
      },
      onTick: () => undefined,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })
    expect(result.kind).toBe('failed')
    expect(fails).toBeGreaterThanOrEqual(MAX_STATUS_FAILS)
  })
})
