/**
 * 多窗口综合与展示旁证：主窗选取、综合判定、辅窗分歧、跨窗领先一致性。
 * 不替代单窗三闸门（decideVerdict），也不改阈值。
 */
import {
  PRIMARY_WINDOW,
  UNKNOWN_ALIGNMENT,
  VERDICT_LABEL,
  type LeaderAlignment,
  type MainlineVerdict,
  type MainlineWindowResult,
} from './mainlineTypes'

/** 由弱到强，用于比较主辅窗分歧方向（不参与综合降级）。 */
const VERDICT_STRENGTH: MainlineVerdict[] = [
  'none',
  'rotation',
  'weak',
  'mainline',
]

function verdictStrength(verdict: MainlineVerdict): number {
  const index = VERDICT_STRENGTH.indexOf(verdict)
  return index < 0 ? -1 : index
}

/**
 * 选取主观察窗：优先 20 日（与标定、面板龙头一致）；
 * 自定义 windows 若不含 20，则退回中位档。
 */
export function pickPrimaryWindow(
  windows: MainlineWindowResult[],
): MainlineWindowResult | undefined {
  return (
    windows.find((w) => w.window === PRIMARY_WINDOW) ??
    windows[Math.floor(windows.length / 2)] ??
    windows[0]
  )
}

/**
 * 分窗表展示顺序：主观察窗置顶，其余按窗口从长到短（60 → 5），
 * 让扫读先落在综合口径，高噪声短窗沉底。不改 evaluate 计算顺序。
 */
export function sortWindowsForDisplay(
  windows: MainlineWindowResult[],
): MainlineWindowResult[] {
  const primaryWindow = pickPrimaryWindow(windows)?.window
  return [...windows].sort((a, b) => {
    const aPrimary = a.window === primaryWindow ? 0 : 1
    const bPrimary = b.window === primaryWindow ? 0 : 1
    if (aPrimary !== bPrimary) return aPrimary - bPrimary
    return b.window - a.window
  })
}

/**
 * 综合结论取主观察窗判定。
 * 不再对 5/20/60 取最弱：短窗 Spearman 噪声大，取 min 会把综合 mainline
 * 触发率压到近 0，且与 calibrate 的 20 日口径错位。5/60 仅作分窗对照。
 * 主窗 insufficient 时回退到其他可判定窗口，避免整段无结论。
 */
export function combineVerdicts(windows: MainlineWindowResult[]): MainlineVerdict {
  const primary = pickPrimaryWindow(windows)
  if (primary && primary.verdict !== 'insufficient') return primary.verdict
  const fallback = windows.find((w) => w.verdict !== 'insufficient')
  return fallback?.verdict ?? 'insufficient'
}

/**
 * 窗口收益第一的展示称谓。
 * 下跌市里「龙头」易被读成绝对上涨；收益为负时改称「相对最强」。
 */
export function leaderRoleLabel(returnPct: number | null | undefined): string {
  if (returnPct == null) return '龙头'
  return returnPct < 0 ? '相对最强' : '龙头'
}

export function formatLeader(primary: MainlineWindowResult | undefined): string {
  if (!primary?.leader) return ''
  const { categoryName, returnPct } = primary.leader
  const sign = returnPct >= 0 ? '+' : ''
  const role = leaderRoleLabel(returnPct)
  return `，${primary.window}日${role} ${categoryName} ${sign}${returnPct.toFixed(1)}%`
}

function formatWindowLabel(window: MainlineWindowResult): string {
  return `${window.window}日${VERDICT_LABEL[window.verdict]}`
}

/**
 * 主辅窗分歧提示。综合仍以主窗为准；此处只提示更弱的中长期反证，
 * 以及更强但未计入综合的短窗噪声，避免只读 headline 漏掉分窗信息。
 */
export function formatAuxCaution(
  windows: MainlineWindowResult[],
  primary: MainlineWindowResult | undefined,
): string | null {
  if (!primary || primary.verdict === 'insufficient') return null
  const primaryLevel = verdictStrength(primary.verdict)
  if (primaryLevel < 0) return null

  const aux = windows.filter(
    (w) => w !== primary && w.verdict !== 'insufficient' && w.window !== primary.window,
  )
  const weaker = aux.filter((w) => verdictStrength(w.verdict) < primaryLevel)
  const stronger = aux.filter((w) => verdictStrength(w.verdict) > primaryLevel)
  if (weaker.length === 0 && stronger.length === 0) return null

  const parts: string[] = []
  if (weaker.length > 0) {
    parts.push(`${weaker.map(formatWindowLabel).join('、')}，弱于主窗`)
  }
  if (stronger.length > 0) {
    parts.push(`${stronger.map(formatWindowLabel).join('、')}，未计入综合`)
  }
  return parts.join('；')
}

function windowLeaderName(window: MainlineWindowResult): string {
  return window.leader?.categoryName ?? window.leader?.category ?? '—'
}

/**
 * 跨窗领先板块一致性。
 * 优先看 20 vs 60（中长期是否同方向）；5 日仅作旁注。
 * 不替代单窗 Spearman，也不改综合 verdict。
 */
export function summarizeLeaderAlignment(
  windows: MainlineWindowResult[],
  primary: MainlineWindowResult | undefined,
): LeaderAlignment {
  if (!primary?.leader) return UNKNOWN_ALIGNMENT

  const primaryId = primary.leader.category
  const primaryName = windowLeaderName(primary)
  const long = windows.find(
    (w) => w.window > primary.window && w.leader && w.verdict !== 'insufficient',
  )
  const short = windows.find(
    (w) => w.window < primary.window && w.leader && w.verdict !== 'insufficient',
  )

  if (long?.leader) {
    if (long.leader.category === primaryId) {
      const base = `${primary.window}/${long.window} 同为 ${primaryName}`
      if (short?.leader && short.leader.category !== primaryId) {
        return {
          status: 'aligned',
          summary: `${base}；${short.window} 日为 ${windowLeaderName(short)}`,
        }
      }
      return { status: 'aligned', summary: base }
    }
    return {
      status: 'split',
      summary:
        `${primary.window} 日 ${primaryName}` +
        ` · ${long.window} 日 ${windowLeaderName(long)}`,
    }
  }

  if (short?.leader) {
    if (short.leader.category === primaryId) {
      return {
        status: 'partial',
        summary: `${short.window}/${primary.window} 同为 ${primaryName}`,
      }
    }
    return {
      status: 'partial',
      summary:
        `${primary.window} 日 ${primaryName}` +
        ` · ${short.window} 日 ${windowLeaderName(short)}`,
    }
  }

  return UNKNOWN_ALIGNMENT
}
