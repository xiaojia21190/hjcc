/** 场内换手率历史合并：previous 为上次快照积累，current 为本次抓取点。 */
import type { TurnoverPoint } from '../../shared/types'

export function mergeTurnoverHistory(
  previous: TurnoverPoint[],
  current: TurnoverPoint[],
): TurnoverPoint[] {
  const byDate = new Map(previous.map((point) => [point.date, point]))
  for (const point of current) byDate.set(point.date, point)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}
