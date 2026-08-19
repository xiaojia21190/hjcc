/**
 * tdx vs 东财对账（集成验证，直连通达信，需联网）
 *
 * 跑法：
 *   TDX_LIVE=1 bun test scripts/tdx-vs-cache.test.ts
 *
 * 默认 skip（避免 CI / bun run test 时真实联网拖慢）。
 * TDX_LIVE=1 时才尝试直连通达信服务器，与 data/dashboard.json 已缓存 0AMV 对账。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fetchTdxMarketActiveCapHistory, __disconnectTdx } from './sources/tdx'

const DATA_FILE = join(import.meta.dir, '..', 'data', 'dashboard.json')
const LIVE = process.env.TDX_LIVE === '1'

/** 读出已缓存 0AMV 序列的「日期 → 沪深成交额(亿元)」映射 */
function loadCacheAmountYi(): Map<string, number> {
  const raw = readFileSync(DATA_FILE, 'utf-8')
  const d = JSON.parse(raw) as { marketActiveCapHistory?: { date: string; marketAmountYi: number }[] }
  const map = new Map<string, number>()
  for (const p of d.marketActiveCapHistory ?? []) {
    map.set(p.date, p.marketAmountYi)
  }
  return map
}

test('tdx 0AMV 成交额与东财缓存一致（直连对账）', async () => {
  if (!LIVE) {
    console.log('  ⏭  TDX_LIVE 未设为 1，跳过真实联网对账（默认行为，CI 安全）')
    return
  }
  const cache = loadCacheAmountYi()
  expect(cache.size).toBeGreaterThan(100)

  let tdx
  try {
    tdx = await fetchTdxMarketActiveCapHistory({ intervalMs: 300 })
  } catch (e) {
    console.log('  ⏭  tdx 直连失败，跳过:', e instanceof Error ? e.message : e)
    return
  } finally {
    await __disconnectTdx()
  }

  // 只比对 tdx 与缓存都有覆盖的公共日期
  const overlap = tdx.filter((p) => cache.has(p.date))
  expect(overlap.length).toBeGreaterThan(20)

  let maxDiff = 0
  let maxDiffDate = ''
  let overTolerance = 0
  const TOLERANCE_PCT = 0.01 // 1% 容差：口径差异（东财含北交所，tdx 可能不含）
  for (const p of overlap) {
    const cached = cache.get(p.date)!
    const diff = Math.abs(p.marketAmountYi - cached)
    const rel = diff / cached
    if (diff > maxDiff) {
      maxDiff = diff
      maxDiffDate = p.date
    }
    if (rel > TOLERANCE_PCT) overTolerance++
  }
  const matchRate = 1 - overTolerance / overlap.length
  console.log(
    `  对账: ${overlap.length} 个公共交易日，最大差异 ${maxDiff.toFixed(0)}亿 @ ${maxDiffDate}` +
    `，>1% 占比 ${(overTolerance / overlap.length * 100).toFixed(1)}%，匹配率 ${(matchRate * 100).toFixed(1)}%`,
  )
  expect(matchRate).toBeGreaterThan(0.8)
})

test('tdx 中证全指收盘与缓存市场指数一致（直连对账）', async () => {
  if (!LIVE) {
    return
  }
  const raw = readFileSync(DATA_FILE, 'utf-8')
  const d = JSON.parse(raw) as { marketActiveCapHistory?: { date: string; marketIndex: number }[] }
  const cache = new Map((d.marketActiveCapHistory ?? []).map((p) => [p.date, p.marketIndex]))
  if (cache.size < 100) {
    console.log('  ⏭  缓存数据不足，跳过')
    return
  }

  let tdx
  try {
    tdx = await fetchTdxMarketActiveCapHistory({ intervalMs: 300 })
  } catch (e) {
    console.log('  ⏭  tdx 直连失败，跳过:', e instanceof Error ? e.message : e)
    return
  } finally {
    await __disconnectTdx()
  }

  let over = 0
  let checked = 0
  for (const p of tdx) {
    const cached = cache.get(p.date)
    if (cached == null) continue
    checked++
    const rel = Math.abs(p.marketIndex - cached) / cached
    if (rel > 0.001) over++ // 0.1% 容差
  }
  if (checked === 0) {
    console.log('  ⏭  无公共日期')
    return
  }
  console.log(`  对账(收盘): ${checked} 日，>0.1% 差异 ${(over / checked * 100).toFixed(1)}%`)
  expect(over / checked).toBeLessThan(0.1)
})
