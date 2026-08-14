import { describe, expect, test } from 'bun:test'
import type { DashboardData } from '../../shared/types'
import { REFRESH_POLL_MS, waitForRefresh } from './refreshWait'

function dashboard(updatedAt: string): DashboardData {
  return { updatedAt } as DashboardData
}

describe('waitForRefresh', () => {
  test('returns updated when dashboard timestamp changes', async () => {
    let now = 0
    const result = await waitForRefresh({
      previousUpdatedAt: 'old',
      maxWaitMs: 10_000,
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

  test('returns failed when status is idle after first poll window', async () => {
    let now = 0
    const result = await waitForRefresh({
      previousUpdatedAt: 'old',
      maxWaitMs: 20_000,
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

  test('returns timeout when still fetching at max wait', async () => {
    let now = 0
    const result = await waitForRefresh({
      previousUpdatedAt: 'old',
      maxWaitMs: 4_000,
      referenceMs: 90_000,
      loadDashboard: async () => dashboard('old'),
      fetchStatus: async () => ({ state: 'fetching' }),
      onTick: () => undefined,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })
    expect(result.kind).toBe('timeout')
  })
})
