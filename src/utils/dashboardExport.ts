import type { DashboardData, EtfSnapshot } from '../../shared/types'
import { downloadCsv } from './csv'
import { computeKdj } from './kdj'
import { computeMacd } from './macd'
import { composeForceBriefing } from './forceBriefing'
import { collectBriefingInputs } from './forceBriefingCollect'
import { judgeCiticPositions } from './citicSignals'
import { judgeRetailSentiment } from './retailSignals'
import { activeCapPercentile } from './activeCapStats'

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

/** 一键导出 Markdown 简报：汇总主力简报、中信席位、散户情绪、0AMV 分位。 */
export function downloadBriefingMd(data: DashboardData) {
  const lines: string[] = []
  const date = snapshotDate(data.updatedAt)
  lines.push(`# 汇金持仓监控简报 · ${date}`)
  lines.push('')
  lines.push(`> 数据更新：${data.updatedAt}`)
  lines.push('')

  // 主力简报
  const collected = collectBriefingInputs(data.etfs, data.marketActiveCapHistory)
  const briefing = composeForceBriefing(collected.etfs, collected.market)
  lines.push('## 主力简报')
  lines.push('')
  lines.push(`**${briefing.headline}**`)
  lines.push('')
  lines.push(briefing.lead)
  lines.push('')
  if (briefing.intent) {
    lines.push(`**意图**：${briefing.intent}`)
    lines.push('')
  }
  lines.push(`**去向**：${briefing.path}`)
  lines.push('')
  if (briefing.bullets.length > 0) {
    for (const bullet of briefing.bullets) lines.push(`- ${bullet}`)
    lines.push('')
  }
  if (briefing.cautions.length > 0) {
    lines.push('**注意**')
    for (const caution of briefing.cautions) lines.push(`- ${caution}`)
    lines.push('')
  }
  lines.push(`_${briefing.disclaimer}_`)
  lines.push('')

  // 0AMV 分位
  const pct = activeCapPercentile(data.marketActiveCapHistory)
  if (pct) {
    lines.push('## 0AMV 活筹分位')
    lines.push('')
    lines.push(`- 当前：${pct.value.toFixed(0)} 亿元`)
    if (pct.oneYearPct != null) lines.push(`- 1 年分位：${pct.oneYearPct.toFixed(0)}%`)
    if (pct.threeYearPct != null) lines.push(`- 3 年分位：${pct.threeYearPct.toFixed(0)}%`)
    lines.push('')
  }

  // 中信席位
  if (data.citicPositionHistory && data.citicPositionHistory.length > 0) {
    const citic = judgeCiticPositions(data.citicPositionHistory)
    lines.push('## 中信期货席位多空')
    lines.push('')
    lines.push(`**综合**：${citic.status}${citic.date ? `（${citic.date}）` : ''}`)
    if (citic.medianNetRatioPct != null) {
      lines.push(`- 净占比中位：${citic.medianNetRatioPct >= 0 ? '+' : ''}${citic.medianNetRatioPct.toFixed(1)}%`)
    }
    if (citic.medianNetChange5d != null) {
      lines.push(`- 5 日净持仓中位变化：${citic.medianNetChange5d >= 0 ? '+' : ''}${citic.medianNetChange5d.toLocaleString()} 手`)
    }
    if (citic.medianShortTop5Pct != null) {
      lines.push(`- 空头前五集中度中位：${citic.medianShortTop5Pct.toFixed(1)}%`)
    }
    for (const row of citic.rows) {
      lines.push(
        `- ${row.product}：净 ${row.netHold >= 0 ? '+' : ''}${row.netHold.toLocaleString()} 手（${row.direction}）` +
        (row.shortTop5Pct != null ? `，空头 Top5 ${row.shortTop5Pct.toFixed(1)}%` : ''),
      )
    }
    lines.push('')
  }

  // 散户情绪
  const retail = judgeRetailSentiment(data.etfs, data.marginHistory ?? [], data.marketActiveCapHistory)
  if (retail.temperatureLabel) {
    lines.push('## 散户情绪')
    lines.push('')
    lines.push(`**温度**：${retail.temperatureLabel}${retail.temperaturePercentile != null ? `（${retail.temperaturePercentile.toFixed(0)} 分位）` : ''}`)
    if (retail.turnoverLabel) {
      lines.push(`- 换手：${retail.turnoverLabel}${retail.turnoverPercentile != null ? `（${retail.turnoverPercentile.toFixed(0)} 分位）` : ''}`)
    }
    if (retail.marginLabel) {
      lines.push(`- 两融：${retail.marginLabel}${retail.marginPercentile != null ? `（${retail.marginPercentile.toFixed(0)} 分位）` : ''}`)
    }
    lines.push('')
  }

  // 各 ETF 持仓摘要
  lines.push('## 各 ETF 汇金持仓摘要')
  lines.push('')
  lines.push('| 类别 | 代码 | 报告期 | 占比 | 份额 | 估算估值 |')
  lines.push('|------|------|--------|------|------|----------|')
  for (const etf of data.etfs) {
    const latest = etf.latestHuijin
    const anchored = etf.huijinEstimateHistory.filter((p) => p.estimateMethod === 'anchored').at(-1)
    lines.push(
      `| ${etf.categoryName} | ${etf.code} | ${latest?.reportDate ?? '—'} | ${latest ? latest.percent.toFixed(2) + '%' : '—'} | ${latest ? (latest.shares / 1e8).toFixed(2) + ' 亿份' : '—'} | ${anchored?.huijinValueYi != null ? anchored.huijinValueYi.toFixed(1) + ' 亿' : '—'} |`,
    )
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('_仅供研究展示，不构成投资建议。请以交易所与基金正式公告为准。_')

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `huijin-briefing-${date}.md`
  a.click()
  URL.revokeObjectURL(url)
}
