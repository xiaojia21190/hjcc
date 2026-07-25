import type { DashboardData, HolderReport, HuijinPosition } from '../shared/types'

const paths = ['data/dashboard.json', 'public/dashboard.json', 'dist/dashboard.json']
const dashboards = await Promise.all(paths.map((path) => Bun.file(path).json() as Promise<DashboardData>))
const data = dashboards[0]
const errors: string[] = []
const warnings: string[] = []

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
    if (position.isEstimated) errors.push(`${code} ${position.reportDate}: estimated position leaked into disclosed history`)
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
    if (point.netSubscriptionYi != null && !finite(point.netSubscriptionYi)) errors.push(`${etf.code} ${point.date}: invalid net share change`)
    if (point.frequency === 'daily' && point.shareSource !== 'sse' && point.shareSource !== 'szse') errors.push(`${etf.code} ${point.date}: daily share point lacks official source`)
  }
  const dailyScale = etf.scaleHistory.filter((point) => point.frequency === 'daily')
  if (!dailyScale.length) warnings.push(`${etf.code}: no official daily share history`)
  for (let index = 1; index < dailyScale.length; index++) {
    const current = dailyScale[index]
    const prior = dailyScale[index - 1]
    if (!current || !prior) continue
    const expected = Number((current.totalSharesYi - prior.totalSharesYi).toFixed(6))
    if (current.netSubscriptionYi == null || Math.abs(current.netSubscriptionYi - expected) > 0.000001) {
      errors.push(`${etf.code} ${current.date}: daily net share change mismatch`)
      break
    }
  }
  const navDates = etf.navHistory.map((point) => point.date)
  if (!unique(navDates) || !sorted(navDates)) errors.push(`${etf.code}: invalid NAV date ordering`)
  if (etf.navHistory.some((point) => !finite(point.nav) || point.nav <= 0 || !finite(point.accNav) || point.accNav <= 0)) errors.push(`${etf.code}: invalid NAV values`)
  auditReports(etf.code, etf.holderReports)
  auditPositions(etf.code, etf.huijinHistory)
  const disclosedByDate = new Map(
    etf.holderReports
      .filter((report) => report.huijinShares > 0)
      .map((report) => [report.reportDate, report]),
  )
  const disclosedDates = [...disclosedByDate.keys()].sort()
  const trendDates = etf.huijinHistory.map((position) => position.reportDate)
  if (JSON.stringify(trendDates) !== JSON.stringify(disclosedDates)) errors.push(`${etf.code}: Huijin trend does not exactly match disclosure dates`)
  if ((etf.latestHuijin?.reportDate ?? null) !== (disclosedDates.at(-1) ?? null)) errors.push(`${etf.code}: latest Huijin disclosure mismatch`)
  const latestAnchorDate = disclosedDates.at(-1) ?? null
  const latestAnchorShares = latestAnchorDate
    ? disclosedByDate.get(latestAnchorDate)?.huijinShares ?? null
    : null
  for (const point of etf.huijinEstimateHistory) {
    if (point.totalSharesYi < 0 || point.netAssetYi < 0) errors.push(`${etf.code} ${point.date}: invalid estimate scale`)
    if (point.huijinPct != null && (point.huijinPct < 0 || point.huijinPct > 100)) errors.push(`${etf.code} ${point.date}: Huijin percentage outside 0-100`)
    const report = disclosedByDate.get(point.date)
    if (report) {
      if (point.estimateMethod !== 'disclosed') errors.push(`${etf.code} ${point.date}: disclosure date not marked disclosed`)
      if (point.isEstimated) errors.push(`${etf.code} ${point.date}: disclosed point must not be marked estimated`)
      if (point.huijinShares == null || Math.abs(point.huijinShares - report.huijinShares) > 1) errors.push(`${etf.code} ${point.date}: aligned disclosed shares mismatch`)
      if (point.huijinPct == null || Math.abs(point.huijinPct - report.huijinPercent) > 0.02) errors.push(`${etf.code} ${point.date}: aligned disclosed percentage mismatch`)
      if (point.shareTrend != null || point.consecutiveDays != null || point.huijinSharesFloor != null) {
        errors.push(`${etf.code} ${point.date}: disclosed point must not carry trend signals or range`)
      }
    } else if (point.estimateMethod === 'anchored') {
      if (!point.isEstimated) errors.push(`${etf.code} ${point.date}: anchored point must be marked estimated`)
      if (!latestAnchorDate || point.date <= latestAnchorDate) errors.push(`${etf.code} ${point.date}: anchored point not after latest disclosure`)
      if (point.huijinShares == null || !finite(point.huijinShares) || point.huijinShares < 0) errors.push(`${etf.code} ${point.date}: anchored point has invalid shares`)
      // 区间校验
      if (point.huijinSharesFloor == null || !finite(point.huijinSharesFloor) || point.huijinSharesFloor < 0) {
        errors.push(`${etf.code} ${point.date}: anchored point missing valid huijinSharesFloor`)
      }
      if (point.huijinSharesCeil == null || !finite(point.huijinSharesCeil) || point.huijinSharesCeil < 0) {
        errors.push(`${etf.code} ${point.date}: anchored point missing valid huijinSharesCeil`)
      }
      if (point.huijinSharesFloor != null && point.huijinSharesCeil != null) {
        if (point.huijinSharesFloor > point.huijinSharesCeil + 0.000001) {
          errors.push(`${etf.code} ${point.date}: floor exceeds ceil`)
        }
        if (point.huijinSharesCeil > point.totalSharesYi + 0.000001) {
          errors.push(`${etf.code} ${point.date}: ceil exceeds total shares`)
        }
        // 展示值落在区间内（份 → 亿份转换后比较）
        if (point.huijinShares != null) {
          const sharesYi = point.huijinShares / 1e8
          if (sharesYi < point.huijinSharesFloor - 0.000002 || sharesYi > point.huijinSharesCeil + 0.000002) {
            errors.push(`${etf.code} ${point.date}: display shares outside [floor, ceil]`)
          }
        }
      }
      // huijinPct 反推一致性
      if (point.huijinShares != null && point.huijinPct != null && point.totalSharesYi > 0) {
        const expectedPct = (point.huijinShares / 1e8 / point.totalSharesYi) * 100
        if (Math.abs(expectedPct - point.huijinPct) > 0.02) {
          errors.push(`${etf.code} ${point.date}: huijinPct inconsistent with shares/total`)
        }
      }
      if (point.huijinValueYi != null && (!finite(point.huijinValueYi) || point.huijinValueYi < 0)) errors.push(`${etf.code} ${point.date}: invalid anchored value`)
      // 趋势信号校验
      if (point.shareTrend != null && !['inflow', 'outflow', 'flat'].includes(point.shareTrend)) {
        errors.push(`${etf.code} ${point.date}: invalid shareTrend`)
      }
      if (point.consecutiveDays != null && (!finite(point.consecutiveDays) || point.consecutiveDays < 1)) {
        errors.push(`${etf.code} ${point.date}: invalid consecutiveDays`)
      }
      if (point.shareChangePct5d != null && !finite(point.shareChangePct5d)) {
        errors.push(`${etf.code} ${point.date}: invalid shareChangePct5d`)
      }
      // clamp 字段不应存在
      if ('clampTriggered' in point || 'clampReliability' in point) {
        errors.push(`${etf.code} ${point.date}: legacy clamp field present on anchored point`)
      }
    } else {
      if (point.estimateMethod !== 'unavailable') errors.push(`${etf.code} ${point.date}: unexpected estimate method`)
      if (point.isEstimated) errors.push(`${etf.code} ${point.date}: unavailable point must not be marked estimated`)
      if (point.huijinShares != null || point.huijinPct != null || point.huijinValueYi != null) errors.push(`${etf.code} ${point.date}: unavailable point contains Huijin holdings`)
      if (point.shareTrend != null || point.consecutiveDays != null || point.huijinSharesFloor != null) {
        errors.push(`${etf.code} ${point.date}: unavailable point must not carry trend signals or range`)
      }
    }
  }
  // floor 累加一致性抽样校验（亿份单位）
  const anchoredPoints = etf.huijinEstimateHistory.filter((point) => point.estimateMethod === 'anchored')
  if (anchoredPoints.length > 0 && latestAnchorShares != null) {
    const anchorPct = disclosedByDate.get(latestAnchorDate!)?.huijinPercent ?? 0
    let rawFloor = latestAnchorShares / 1e8
    for (const point of anchoredPoints) {
      const dailyPoint = etf.scaleHistory.find((scalePoint) => scalePoint.date === point.date && scalePoint.frequency === 'daily')
      const netSub = dailyPoint?.netSubscriptionYi ?? 0
      rawFloor = Math.max(0, Math.min(rawFloor + netSub, point.totalSharesYi))
      const ceil = (point.totalSharesYi * anchorPct) / 100
      // 存储时确保区间有序：floor = min(rawFloor, ceil)
      const expectedStoredFloor = Math.min(rawFloor, ceil)
      if (point.huijinSharesFloor != null && Math.abs(point.huijinSharesFloor - expectedStoredFloor) > 0.000002) {
        errors.push(`${etf.code} ${point.date}: floor accumulation mismatch (expected ${expectedStoredFloor.toFixed(6)}, got ${point.huijinSharesFloor})`)
        break
      }
    }
  }
  if (etf.holderReports.length === 0) warnings.push(`${etf.code}: no holder reports`)
  if (etf.source.shareFetchGaps) {
    const g = etf.source.shareFetchGaps
    const parts: string[] = []
    if (g.sseFailedDates?.length) parts.push(`SSE 失败 ${g.sseFailedDates.length} 日`)
    if (g.szseFailedRanges?.length) parts.push(`SZSE 失败 ${g.szseFailedRanges.length} 段`)
    if (parts.length) warnings.push(`${etf.code}: 份额抓取缺口 — ${parts.join('，')}`)
  }
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
if (data.summary.etfCount !== data.etfs.length) errors.push('summary ETF count mismatch')
if (data.summary.latestActiveCapDate !== market.at(-1)?.date) errors.push('summary latest market date mismatch')
if (data.summary.latestActiveCapYi !== market.at(-1)?.activeCapYi) errors.push('summary latest active cap mismatch')
const totalHuijinMarketValue = data.etfs.reduce(
  (sum, etf) => sum + (etf.latestHuijin?.marketValue ?? 0),
  0,
)
if (Math.abs(totalHuijinMarketValue - (data.summary.totalHuijinMarketValue ?? 0)) > 0.01) errors.push('summary Huijin market value mismatch')
const latestReportDate = data.etfs.map((etf) => etf.latestHuijin?.reportDate).filter((date): date is string => !!date).sort().at(-1) ?? null
if (latestReportDate !== data.summary.latestReportDate) errors.push('summary latest report date mismatch')
if (data.etfs.some((etf) => !etf.isLargest)) errors.push('selected ETF is not marked as category largest')

type ExternalKlineResponse = { data?: { klines?: string[] } | null }
async function externalBars(secid: string) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&beg=20150101&end=20500101&lmt=5000&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
  let lastError: unknown
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; huijin-etf-monitor audit)',
          Referer: 'https://quote.eastmoney.com/',
          Accept: 'application/json,*/*',
        },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json() as ExternalKlineResponse
      const klines = json.data?.klines ?? []
      if (!klines.length) throw new Error('empty kline response')
      return klines.map((line) => {
        const [date, , close, , , , amount] = line.split(',')
        return { date, close: Number(close), amount: Number(amount) }
      })
    } catch (error) {
      lastError = error
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 800))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

try {
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
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  warnings.push(`external market cross-check skipped: ${message}`)
}

console.log(JSON.stringify({
  updatedAt: data.updatedAt,
  etfs: data.etfs.map((etf) => ({
    category: etf.categoryName,
    code: etf.code,
    quote: etf.quote?.price ?? null,
    scales: etf.scaleHistory.length,
    dailyScales: etf.scaleHistory.filter((point) => point.frequency === 'daily').length,
    navs: etf.navHistory.length,
    reports: etf.holderReports.length,
    alignedScales: etf.huijinEstimateHistory.length,
  })),
  market: { points: market.length, first: market[0], latest: market.at(-1) },
  errors,
  warnings,
}, null, 2))
if (errors.length) process.exitCode = 1
