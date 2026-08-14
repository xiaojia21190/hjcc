import { describe, expect, test } from 'bun:test'
import { timedProgress } from './refreshProgress'

const R = 90_000

describe('timedProgress', () => {
  test('starts at 0 and stays below 1', () => {
    expect(timedProgress(0, R)).toBe(0)
    expect(timedProgress(R * 3, R)).toBeLessThan(1)
  })

  test('linear until 0.8R', () => {
    expect(timedProgress(0.4 * R, R)).toBeCloseTo(0.32, 6)
    expect(timedProgress(0.8 * R, R)).toBeCloseTo(0.8, 6)
  })

  test('decelerates after 0.8R toward 0.95', () => {
    const atR = timedProgress(R, R)
    const at1_5R = timedProgress(1.5 * R, R)
    expect(atR).toBeGreaterThan(0.8)
    expect(atR).toBeLessThan(at1_5R)
    expect(at1_5R).toBeCloseTo(0.92, 2)
    expect(timedProgress(2 * R, R)).toBeCloseTo(0.93, 2)
    expect(at1_5R).toBeLessThan(0.95)
  })
})
