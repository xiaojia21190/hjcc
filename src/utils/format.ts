export function formatYi(
  value: number | null | undefined,
  digits = 2,
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e4) return `${(value / 1e4).toFixed(digits)} 万亿`
  return `${value.toFixed(digits)} 亿`
}

/** 元 → 亿元展示 */
export function yuanToYi(yuan: number | null | undefined, digits = 2): string {
  if (yuan == null || !Number.isFinite(yuan)) return '—'
  return formatYi(yuan / 1e8, digits)
}

export function formatShares(shares: number | null | undefined): string {
  if (shares == null || !Number.isFinite(shares)) return '—'
  if (Math.abs(shares) >= 1e8) return `${(shares / 1e8).toFixed(2)} 亿份`
  if (Math.abs(shares) >= 1e4) return `${(shares / 1e4).toFixed(2)} 万份`
  return `${shares.toFixed(0)} 份`
}

export function formatPct(pct: number | null | undefined, digits = 2): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  return `${pct.toFixed(digits)}%`
}

export function formatDate(d: string | null | undefined): string {
  if (!d) return '—'
  return d.slice(0, 10)
}

const BEIJING_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN-u-nu-latn', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export function formatDateTime(d: string | null | undefined): string {
  if (!d) return '—'
  const date = new Date(d)
  if (!Number.isFinite(date.getTime())) return '—'
  const parts = Object.fromEntries(
    BEIJING_DATE_TIME_FORMATTER.formatToParts(date).map(({ type, value }) => [
      type,
      value,
    ]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

export function shortName(name: string): string {
  return name
    .replace(/交易型开放式指数证券投资基金/g, 'ETF')
    .replace(/交易型开放式指数基金/g, 'ETF')
    .replace(/发起式/g, '')
}

export function changeClass(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct) || pct === 0) return ''
  return pct > 0 ? 'up' : 'down'
}
