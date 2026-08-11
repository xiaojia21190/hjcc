import { describe, expect, test } from 'bun:test'
import { isConnectionReset, retryDelayMs } from './http'

/** 构造带 code 属性的错误，模拟 Bun fetch 抛出的连接层错误。 */
function errWithCode(code: string, message = 'fetch failed'): Error {
  return Object.assign(new Error(message), { code })
}

describe('isConnectionReset', () => {
  test('识别 Bun fetch 的 ECONNRESET', () => {
    expect(isConnectionReset(errWithCode('ECONNRESET'))).toBe(true)
  })

  test('识别连接被拒与管道断开', () => {
    expect(isConnectionReset(errWithCode('ECONNREFUSED'))).toBe(true)
    expect(isConnectionReset(errWithCode('EPIPE'))).toBe(true)
  })

  test('无 code 属性时回退到消息匹配', () => {
    // Bun 实际抛出的文案，部分场景下不带 code
    const error = new Error('The socket connection was closed unexpectedly.')
    expect(isConnectionReset(error)).toBe(true)
  })

  test('HTTP 状态错误不算连接重置', () => {
    expect(isConnectionReset(new Error('HTTP 429 https://example.com'))).toBe(false)
    expect(isConnectionReset(new Error('HTTP 500 https://example.com'))).toBe(false)
  })

  test('超时不算连接重置——超时可能只是临时拥塞，值得正常重试', () => {
    expect(isConnectionReset(errWithCode('ETIMEDOUT'))).toBe(false)
    expect(isConnectionReset(new DOMException('timeout', 'TimeoutError'))).toBe(false)
  })

  test('非错误输入不误判', () => {
    expect(isConnectionReset(null)).toBe(false)
    expect(isConnectionReset(undefined)).toBe(false)
    expect(isConnectionReset('ECONNRESET')).toBe(false)
  })
})

describe('retryDelayMs', () => {
  test('常规错误按 400 * 2^i 指数退避', () => {
    expect(retryDelayMs(0, false)).toBe(400)
    expect(retryDelayMs(1, false)).toBe(800)
    expect(retryDelayMs(2, false)).toBe(1600)
  })

  test('连接重置退避更长，给对端封禁留冷却时间', () => {
    expect(retryDelayMs(0, true)).toBeGreaterThan(retryDelayMs(0, false))
    expect(retryDelayMs(1, true)).toBeGreaterThan(retryDelayMs(1, false))
  })
})
