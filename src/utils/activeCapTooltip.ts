export interface TooltipRow {
  seriesName?: string
  marker?: string
  value?: unknown
  axisValueLabel?: string
  axisValue?: string | number
}

const GROUPS = [
  { title: '主图', names: ['0AMV 活筹估算', '5 日参考线', '沪深两市成交额'] },
  { title: 'MACD', names: ['DIF', 'DEA', 'MACD 柱'] },
  { title: 'KDJ', names: ['K', 'D', 'J'] },
] as const

export const MAIN_LEGEND = GROUPS[0].names

export function formatChartNumber(value: unknown): string {
  if (value == null || value === '') return '—'
  const raw = Array.isArray(value) ? value[1] : value
  const nested =
    typeof raw === 'object' && raw != null && 'value' in raw
      ? (raw as { value: unknown }).value
      : raw
  if (nested == null || nested === '') return '—'
  const num = Number(nested)
  return Number.isFinite(num) ? num.toFixed(2) : '—'
}

function sectionHtml(title: string, rows: TooltipRow[]): string {
  if (rows.length === 0) return ''
  const lines = rows
    .map((row) => `${row.marker ?? ''}${row.seriesName} ${formatChartNumber(row.value)}`)
    .join('<br/>')
  return `<div style="margin-top:6px"><div style="color:#93a4b8;font-size:11px">${title}</div>${lines}</div>`
}

export function formatActiveCapTooltip(params: TooltipRow | TooltipRow[]): string {
  const rows = Array.isArray(params) ? params : [params]
  const date = String(rows[0]?.axisValueLabel ?? rows[0]?.axisValue ?? '')
  const sections = GROUPS.map((group) =>
    sectionHtml(
      group.title,
      rows.filter((row) => (group.names as readonly string[]).includes(String(row.seriesName))),
    ),
  )
  return `<div style="font-weight:600">${date}</div>${sections.join('')}`
}
