import type { CiticPositionPoint } from '../../shared/types'

const PRODUCTS = ['IF', 'IH', 'IC', 'IM'] as const
const NET_RATIO_THRESHOLD = 5

type Product = (typeof PRODUCTS)[number]

export interface CiticProductSignal {
  product: Product
  date: string
  longHold: number
  shortHold: number
  netHold: number
  netRatioPct: number
  netChange5d: number | null
  direction: '净多' | '净空' | '中性'
}

export interface CiticVerdict {
  status: '净多倾向' | '净空倾向' | '中性/混合' | '暂无数据'
  tone: 'up' | 'down' | 'neutral' | 'none'
  date: string | null
  productCount: number
  medianNetRatioPct: number | null
  medianNetChange5d: number | null
  rows: CiticProductSignal[]
  detail: string
  cautions: string[]
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function latestByProduct(history: CiticPositionPoint[]): Map<Product, CiticPositionPoint> {
  const latest = new Map<Product, CiticPositionPoint>()
  for (const point of [...history].sort((a, b) => a.date.localeCompare(b.date))) {
    latest.set(point.product, point)
  }
  return latest
}

function fiveDayChange(
  history: CiticPositionPoint[],
  point: CiticPositionPoint,
): number | null {
  const points = history
    .filter((candidate) => candidate.product === point.product)
    .sort((a, b) => a.date.localeCompare(b.date))
  const index = points.findIndex((candidate) => candidate.date === point.date)
  const base = index >= 5 ? points[index - 5] : null
  return base ? point.netHold - base.netHold : null
}

export function judgeCiticPositions(history: CiticPositionPoint[]): CiticVerdict {
  const latest = latestByProduct(history)
  const rows = [...latest.entries()]
    .sort(([a], [b]) => PRODUCTS.indexOf(a) - PRODUCTS.indexOf(b))
    .map(([product, point]) => {
      const total = point.longHold + point.shortHold
      const netRatioPct = total > 0 ? (point.netHold / total) * 100 : 0
      return {
        product,
        date: point.date,
        longHold: point.longHold,
        shortHold: point.shortHold,
        netHold: point.netHold,
        netRatioPct,
        netChange5d: fiveDayChange(history, point),
        direction:
          netRatioPct >= NET_RATIO_THRESHOLD
            ? '净多'
            : netRatioPct <= -NET_RATIO_THRESHOLD
              ? '净空'
              : '中性',
      } satisfies CiticProductSignal
    })
  if (rows.length === 0) {
    return {
      status: '暂无数据',
      tone: 'none',
      date: null,
      productCount: 0,
      medianNetRatioPct: null,
      medianNetChange5d: null,
      rows: [],
      detail: '未接入中信期货会员持仓数据',
      cautions: [],
    }
  }

  const medianNetRatioPct = median(rows.map((row) => row.netRatioPct))
  const changes = rows
    .map((row) => row.netChange5d)
    .filter((value): value is number => value != null)
  const medianNetChange5d = median(changes)
  const status =
    medianNetRatioPct != null && medianNetRatioPct >= NET_RATIO_THRESHOLD
      ? '净多倾向'
      : medianNetRatioPct != null && medianNetRatioPct <= -NET_RATIO_THRESHOLD
        ? '净空倾向'
        : '中性/混合'
  const tone = status === '净多倾向' ? 'up' : status === '净空倾向' ? 'down' : 'neutral'
  const date = rows.map((row) => row.date).sort().at(-1) ?? null
  const cautions: string[] = []
  if (rows.length < PRODUCTS.length) cautions.push(`仅覆盖 ${rows.length}/${PRODUCTS.length} 个品种`)
  if (new Set(rows.map((row) => row.date)).size > 1) cautions.push('品种最新日期不一致')
  if (changes.length < rows.length) cautions.push('部分品种不足 6 个交易日，暂无 5 日变化')

  return {
    status,
    tone,
    date,
    productCount: rows.length,
    medianNetRatioPct,
    medianNetChange5d,
    rows,
    detail:
      medianNetChange5d == null
        ? '按各品种多空持仓标准化后取中位数'
        : `净持仓 5 日中位变化 ${medianNetChange5d >= 0 ? '+' : ''}${medianNetChange5d.toLocaleString()} 手`,
    cautions,
  }
}
