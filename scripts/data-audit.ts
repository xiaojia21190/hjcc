import type { DashboardData, HolderReport, HuijinPosition } from '../shared/types'

const paths = ['data/dashboard.json', 'public/dashboard.json', 'dist/dashboard.json']
const dashboards = await Promise.all(paths.map((path) => Bun.file(path).json() as Promise<DashboardData>))
const data = dashboards[0]
const errors: string[] = []
const warnings: string[] = []
let unavailableEstimateCount = 0

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const unique = <T>(values: T[]) => new Set(values).size === values.length
const sorted = (values: string[]) => values.every((value, index) => index === 0 || values[index - 1] < value)

if (JSON.stringify(dashboards[0]) !== JSON.stringify(dashboards[1]) || JSON.stringify(dashboards[0]) !== JSON.stringify(dashboards[2])) {
  errors.push('dashboard JSON copies differ')
}
if (!unique(data.etfs.map((etf) => etf.category))) errors.push('duplicate ETF categories')
if (!unique(data.etfs.map((etf) => etf.code))) errors.push('duplicate ETF codes')
if (data.etfs.length !== data.categories.length) errors.push('ETF/category count mismatch')

function auditReports(code: string, reports: HolderReport[]) {
  const dates = reports.map((report) => report.reportDate)
  if (!unique(dates)) errors.push(`${code}: duplicate holder report dates`)
  if (!sorted(dates)) errors.push(`${code}: holder report dates not strictly sorted`)
  for (const report of reports) {
    if (!report.holders.every((holder) => finite(holder.shares) && holder.shares >= 0 && finite(holder.percent) && holder.percent >= 0)) {
      errors.push(`${code} ${report.reportDate}: invalid holder row`)
    }
    const shares = report.holders.filter((holder) => holder.isHuijin).reduce((sum, holder) => sum + holder.shares, 0)
    const percent = report.holders.filter((holder) => holder.isHuijin).reduce((sum, holder) => sum + holder.percent, 0)
    if (Math.abs(shares - report.huijinShares) > 1) errors.push(`${code} ${report.reportDate}: Huijin share sum mismatch`)
    if (Math.abs(percent - report.huijinPercent) > 0.02) errors.push(`${code} ${report.reportDate}: Huijin percent sum mismatch`)
  }
}

function auditPositions(code: string, positions: HuijinPosition[]) {
  const dates = positions.map((position) => position.reportDate)
  if (!unique(dates)) errors.push(`${code}: duplicate Huijin history dates`)
  if (!sorted(dates)) errors.push(`${code}: Huijin history dates not strictly sorted`)
  for (const position of positions) {
    const shares = position.entities.reduce((sum, entity) => sum + entity.shares, 0)
    const percent = position.entities.reduce((sum, entity) => sum + entity.percent, 0)
    if (Math.abs(shares - position.shares) > 1) errors.push(`${code} ${position.reportDate}: position share sum mismatch`)
    if (Math.abs(percent - position.percent) > 0.02) errors.push(`${code} ${position.reportDate}: position percent sum mismatch`)
    if (position.marketValue != null && (!finite(position.marketValue) || position.marketValue < 0)) errors.push(`${code} ${position.reportDate}: invalid market value`)
  }
}

for (const etf of data.etfs) {
  if (etf.quote?.code !== etf.code) errors.push(`${etf.code}: quote code mismatch`)
  if (etf.quote?.price != null && (!finite(etf.quote.price) || etf.quote.price <= 0)) errors.push(`${etf.code}: invalid quote price`)
  const scaleDates = etf.scaleHistory.map((point) => point.date)
  if (!unique(scaleDates) || !sorted(scaleDates)) errors.push(`${etf.code}: invalid scale date ordering`)
  for (const point of etf.scaleHistory) {
    if (![point.totalSharesYi, point.netAssetYi].every((value) => finite(value) && value >= 0)) errors.push(`${etf.code} ${point.date}: invalid scale value`)
    if (point.purchaseYi != null && (!finite(point.purchaseYi) || point.purchaseYi < 0)) errors.push(`${etf.code} ${point.date}: invalid purchase value`)
    if (point.redeemYi != null && (!finite(point.redeemYi) || point.redeemYi < 0)) errors.push(`${etf.code} ${point.date}: invalid redeem value`)
  }
  const navDates = etf.navHistory.map((point) => point.date)
  if (!unique(navDates) || !sorted(navDates)) errors.push(`${etf.code}: invalid NAV date ordering`)
  if (etf.navHistory.some((point) => !finite(point.nav) || point.nav <= 0 || !finite(point.accNav) || point.accNav <= 0)) errors.push(`${etf.code}: invalid NAV values`)
  auditReports(etf.code, etf.holderReports)
  auditPositions(etf.code, etf.huijinHistory)
  for (const point of etf.huijinEstimateHistory) {
    if (point.totalSharesYi < 0 || point.netAssetYi < 0) errors.push(`${etf.code} ${point.date}: invalid estimate scale`)
    if (point.huijinShares != null && point.huijinShares > point.totalSharesYi * 1e8 + 1) {
      if (point.unavailableReason) unavailableEstimateCount += 1
      else errors.push(`${etf.code} ${point.date}: Huijin shares exceed total shares without unavailable reason`)
    }
    if (point.huijinPct != null && (point.huijinPct < 0 || point.huijinPct > 100)) errors.push(`${etf.code} ${point.date}: Huijin percentage outside 0-100`)
  }
  if (etf.holderReports.length === 0) warnings.push(`${etf.code}: no holder reports`)
}

const market = data.marketActiveCapHistory
const marketDates = market.map((point) => point.date)
if (!unique(marketDates) || !sorted(marketDates)) errors.push('market dates not strictly sorted and unique')
for (const point of market) {
  if (![point.activeCapYi, point.marketIndex, point.marketAmountYi].every((value) => finite(value) && value > 0)) errors.push(`${point.date}: invalid market value`)
  if (point.referenceMaYi != null && (!finite(point.referenceMaYi) || point.referenceMaYi <= 0)) errors.push(`${point.date}: invalid reference MA`)
}
for (let index = 4; index < market.length; index++) {
  const expected = market.slice(index - 4, index + 1).reduce((sum, point) => sum + point.activeCapYi, 0) / 5
  if (Math.abs(expected - (market[index].referenceMaYi ?? NaN)) > 0.011) errors.push(`${market[index].date}: reference MA mismatch`)
}
const suspiciousAmounts = market.filter((point) => point.marketAmountYi === 10000)
if (suspiciousAmounts.length) warnings.push(`${suspiciousAmounts.length} market amount values equal exactly 10000`)
if (unavailableEstimateCount) warnings.push(`${unavailableEstimateCount} estimate points intentionally unavailable because disclosed shares exceed total shares`)
if (data.summary.etfCount !== data.etfs.length) errors.push('summary ETF count mismatch')
if (data.summary.latestActiveCapDate !== market.at(-1)?.date) errors.push('summary latest market date mismatch')
if (data.summary.latestActiveCapYi !== market.at(-1)?.activeCapYi) errors.push('summary latest active cap mismatch')
const totalHuijinMarketValue = data.etfs.reduce(
  (sum, etf) => sum + (etf.huijinEstimateHistory.at(-1)?.huijinValueYi ?? 0) * 1e8,
  0,
)
if (Math.abs(totalHuijinMarketValue - (data.summary.totalHuijinMarketValue ?? 0)) > 0.01) errors.push('summary Huijin market value mismatch')
const latestReportDate = data.etfs.map((etf) => etf.latestHuijin?.reportDate).filter((date): date is string => !!date).sort().at(-1) ?? null
if (latestReportDate !== data.summary.latestReportDate) errors.push('summary latest report date mismatch')
if (data.etfs.some((etf) => !etf.isLargest)) errors.push('selected ETF is not marked as category largest')

type ExternalKlineResponse = { data?: { klines?: string[] } | null }
async function externalBars(secid: string) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&beg=20150101&end=20500101&lmt=5000&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
  const json = await fetch(url).then((response) => response.json()) as ExternalKlineResponse
  return (json.data?.klines ?? []).map((line) => {
    const [date, , close, , , , amount] = line.split(',')
    return { date, close: Number(close), amount: Number(amount) }
  })
}
const [externalPrice, externalSh, externalSz] = await Promise.all([
  externalBars('1.000985'),
  externalBars('1.000001'),
  externalBars('0.399001'),
])
const externalShByDate = new Map(externalSh.map((point) => [point.date, point.amount]))
const externalSzByDate = new Map(externalSz.map((point) => [point.date, point.amount]))
const alignedExternal = externalPrice
  .map((point) => {
    const sh = externalShByDate.get(point.date)
    const sz = externalSzByDate.get(point.date)
    return sh != null && sz != null ? { ...point, amount: sh + sz } : null
  })
  .filter((point): point is NonNullable<typeof point> => point != null)
let smoothAmount = 0
const externalCalculated: Array<{ date: string; activeCapYi: number; marketIndex: number; marketAmountYi: number }> = []
for (let index = 0; index < alignedExternal.length; index++) {
  const point = alignedExternal[index]
  smoothAmount = index === 0 ? point.amount : (point.amount + 9 * smoothAmount) / 10
  if (index < 5) continue
  const priorFiveClose = alignedExternal.slice(index - 5, index).reduce((sum, item) => sum + item.close, 0) / 5
  externalCalculated.push({
    date: point.date,
    activeCapYi: Number(((smoothAmount * point.close) / priorFiveClose / 1e8).toFixed(2)),
    marketIndex: Number(point.close.toFixed(2)),
    marketAmountYi: Number((point.amount / 1e8).toFixed(2)),
  })
}
if (externalCalculated.length !== market.length) errors.push('external market history length mismatch')
for (let index = 0; index < Math.min(externalCalculated.length, market.length); index++) {
  const external = externalCalculated[index]
  const cached = market[index]
  if (external.date !== cached.date || external.activeCapYi !== cached.activeCapYi || external.marketIndex !== cached.marketIndex || external.marketAmountYi !== cached.marketAmountYi) {
    errors.push(`${cached.date}: market history differs from external source/formula`)
    break
  }
}

console.log(JSON.stringify({
  updatedAt: data.updatedAt,
  etfs: data.etfs.map((etf) => ({
    category: etf.categoryName,
    code: etf.code,
    quote: etf.quote?.price ?? null,
    scales: etf.scaleHistory.length,
    navs: etf.navHistory.length,
    reports: etf.holderReports.length,
    estimates: etf.huijinEstimateHistory.length,
  })),
  market: { points: market.length, first: market[0], latest: market.at(-1) },
  errors,
  warnings,
}, null, 2))
if (errors.length) process.exitCode = 1
