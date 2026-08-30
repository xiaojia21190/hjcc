const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 连接层错误码：对端在 TCP 层拒绝或重置，重试价值远低于 HTTP 层错误。 */
const RESET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE'])
/** 常规错误的重试次数。 */
const DEFAULT_RETRIES = 5
/**
 * 连接重置的重试次数。压到 2 次是有意的——对端按路径封禁时返回的是 TCP RST
 * 而非 HTTP 状态码，继续重试既救不回来，又会延长封禁。留 2 次是为了容忍偶发抖动。
 */
const RESET_RETRIES = 2
/**
 * 单次请求超时（毫秒）。
 * 20s 对正常东财/新浪接口绰绰有余（实测 <3s），
 * 但能在 ARM Linux 上东财 push2delay 挂起时快速触发超时，
 * 避免整个 fetch 流程卡死 14 小时。
 */
const FETCH_TIMEOUT_MS = 20_000

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 是否为连接层重置类错误。
 * 超时不计入——超时可能只是临时拥塞，按常规退避重试仍有意义。
 */
export function isConnectionReset(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && RESET_CODES.has(code)) return true
  // Bun 部分场景不带 code，只能回退到文案匹配
  return error.message.includes('socket connection was closed')
}

/** 第 attempt 次失败后的等待毫秒数；连接重置退避更长，给对端冷却留时间。 */
export function retryDelayMs(attempt: number, reset: boolean): number {
  return (reset ? 1500 : 400) * 2 ** attempt
}

/**
 * 带超时的 fetch。
 * Bun 的 AbortController.abort() 在 ARM Linux 上不能强制关闭已建立但无数据
 * 流动的 TCP 连接（实测 push2delay 旧 CDN IP 101.42.164.241:7709 挂起 14h）。
 * 用 Promise.race + 超时 promise 做硬超时：超时后直接抛错，不再等 fetch 返回。
 * 注意：不能在 finally 里 abort controller，否则成功响应也会被中断。
 * 只在超时路径 abort，让残留 fetch 停止占用资源。
 */
async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  let done = false
  const timer = setTimeout(() => {
    if (!done) {
      done = true
      controller.abort()
    }
  }, timeoutMs)
  try {
    const result = await Promise.race([
      fetch(url, { headers, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          if (!done) {
            done = true
            controller.abort()
            reject(new Error(`fetch timeout after ${timeoutMs}ms: ${url}`))
          }
        }, timeoutMs)
      }),
    ])
    done = true
    return result
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchText(
  url: string,
  referer = 'https://finance.sina.com.cn/',
  retries = DEFAULT_RETRIES,
): Promise<string> {
  let lastErr: unknown
  let limit = retries
  for (let i = 0; i < limit; i++) {
    try {
      const res = await fetchWithTimeout(url, {
        'User-Agent': UA,
        Referer: referer,
        Accept: '*/*',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
      const buf = await res.arrayBuffer()
      const bytes = new Uint8Array(buf)
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return new TextDecoder('gbk').decode(bytes)
      }
    } catch (e) {
      lastErr = e
      const reset = isConnectionReset(e)
      // 连接重置时收紧重试上限，避免在封禁态下持续撞墙
      if (reset) limit = Math.min(limit, RESET_RETRIES)
      if (i + 1 >= limit) break
      await sleep(retryDelayMs(i, reset))
    }
  }
  throw lastErr
}

export async function fetchJson<T = unknown>(
  url: string,
  referer?: string,
): Promise<T> {
  const text = await fetchText(url, referer)
  // strip jsonp
  const m = text.match(/^[a-zA-Z_$][\w$]*\(([\s\S]*)\)\s*;?\s*$/)
  const body = m ? m[1] : text
  return JSON.parse(body) as T
}
