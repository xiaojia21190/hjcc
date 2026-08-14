import type { DashboardData, EtfSnapshot } from '../../shared/types'
import { downloadCsv } from './csv'
import { computeKdj } from './kdj'
import { computeMacd } from './macd'

function snapshotDate(updatedAt?: string): string {
  return updatedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10)
}

export function downloadEtfCsv(etfs: EtfSnapshot[], updatedAt?: string) {
  const rows = etfs.map((etf) => {
    const scale = etf.scaleHistory.at(-1)
    const latestAnchored =
      etf.huijinEstimateHistory.filter((p) => p.estimateMethod === 'anchored').at(-1) ??
      null
    return [
      etf.categoryName,
      etf.code,
      etf.name,
      etf.quote?.price,
      etf.quote?.changePct,
      scale?.date,
      scale?.totalSharesYi,
      scale?.netSubscriptionYi ??
      (scale?.purchaseYi != null && scale.redeemYi != null
        ? scale.purchaseYi - scale.redeemYi
        : null),
      scale?.netAssetYi,
      etf.latestHuijin?.reportDate,
      etf.latestHuijin?.shares,
      etf.latestHuijin?.percent,
      etf.latestHuijin?.marketValue != null
        ? etf.latestHuijin.marketValue / 1e8
        : null,
      latestAnchored?.date ?? null,
      latestAnchored?.huijinShares != null ? latestAnchored.huijinShares / 1e8 : null,
      latestAnchored?.huijinValueYi ?? null,
      latestAnchored ? '估算' : '无锚点',
    ]
  })
  downloadCsv(
    `huijin-etf-snapshot-${snapshotDate(updatedAt)}.csv`,
    [
      '类别',
      '代码',
      '名称',
      '现价',
      '涨跌幅%',
      '份额日期',
      '总份额_亿份',
      '净份额变化_亿份',
      '净资产_亿元',
      '汇金报告期',
      '汇金份额',
      '汇金占比%',
      '最近披露汇金估值_亿元',
      '估算日期',
      '估算汇金份额_亿份',
      '估算汇金估值_亿元',
      '持仓状态',
    ],
    rows,
  )
}

export function downloadMarketCsv(data: DashboardData | null) {
  const history = data?.marketActiveCapHistory ?? []
  const values = history.map((point) => point.activeCapYi)
  const macdPoints = computeMacd(values)
  const kdjPoints = computeKdj(values)
  downloadCsv(
    `market-0amv-${snapshotDate(data?.updatedAt)}.csv`,
    [
      '日期',
      '0AMV估算_亿元',
      '中证全指收盘',
      '沪深两市成交额_亿元',
      '5日参考线_亿元',
      'DIF',
      'DEA',
      'MACD',
      'K',
      'D',
      'J',
    ],
    history.map((point, index) => [
      point.date,
      point.activeCapYi,
      point.marketIndex,
      point.marketAmountYi,
      point.referenceMaYi,
      macdPoints[index]?.dif ?? '',
      macdPoints[index]?.dea ?? '',
      macdPoints[index]?.macd ?? '',
      kdjPoints[index]?.k ?? '',
      kdjPoints[index]?.d ?? '',
      kdjPoints[index]?.j ?? '',
    ]),
  )
}
