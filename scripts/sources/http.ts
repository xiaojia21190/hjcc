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
 * 带超时的 fetch。AbortSignal.timeout 在 Bun 的某些场景下不能正确中断
 * 已建立但无数据流动的 TCP 连接（实测 ARM Linux 上 push2delay 挂起）。
 * 这里额外用一个手动 AbortController + setTimeout 做双保险。
 */
async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // 同时用 AbortSignal.timeout 作为第二层保护
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
  try {
    return await fetch(url, { headers, signal })
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
