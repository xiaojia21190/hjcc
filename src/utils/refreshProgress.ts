/** 计时进度：前 80% 线性逼近 0.8，后段减速趋向 0.95，永不撞 1。 */
export function timedProgress(elapsedMs: number, referenceMs: number): number {
  const reference = Math.max(referenceMs, 1)
  const elapsed = Math.max(elapsedMs, 0)
  if (elapsed < 0.8 * reference) return (elapsed / reference) * 0.8
  const k = 1 / (0.2 * reference)
  return 0.8 + 0.15 * (1 - 1 / (1 + k * (elapsed - 0.8 * reference)))
}
