const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function fetchText(
  url: string,
  referer = 'https://finance.sina.com.cn/',
  retries = 5,
): Promise<string> {
  let lastErr: unknown
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: referer,
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(30_000),
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
      // 指数退避 400 * 2^i
      await sleep(400 * 2 ** i)
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
