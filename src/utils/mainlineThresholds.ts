/**
 * 主线判定阈值。独立成模块，因为两套取值的依据来自回测标定，
 * 说明本身比数值更重要——改动前请先读注释，并重跑 bun run calibrate。
 */

export interface MainlineThresholds {
  /** 分化度历史分位低于此值，视为齐涨齐跌，无主线可言。 */
  dispersionPercentileFloor: number
  /** 前后半窗排名相关性下限，低于此值视为轮动而非主线。 */
  persistenceFloor: number
  /** 龙头日超额为正的天数占比下限，低于此值说明涨幅集中于少数交易日。 */
  leaderEdgeFloor: number
}

/**
 * 宽基风格口径（N≈6）。样本极小，Spearman 噪音大，持续性门槛压低；
 * 等权平均只由 6 个成分决定、波动大，龙头日超额胜率门槛也相应放宽。
 *
 * 标定结论：该口径**没有已验证的预测力**。2020-09 以来逐日回溯，判为 mainline
 * 的样本其龙头此后 20 日平均跑输 0.72%，且前视越长跑输越多（120 日 -4.32%）；
 * 扫描三项门槛的全部取值，没有任何组合能转正。部分原因是 N=6 时 ρ=0.3 在统计上
 * 根本不显著（p≈0.56），持续性度量本身即噪音。阈值因此维持描述性取值。
 */
export const STYLE_THRESHOLDS: MainlineThresholds = {
  dispersionPercentileFloor: 40,
  persistenceFloor: 0.3,
  leaderEdgeFloor: 0.55,
}

/**
 * 行业题材口径（N≈72）。样本大，秩相关显著性高——ρ=0.3 在 N=72 时 p<0.01，
 * 与宽基口径同样的数值有完全不同的统计含义。
 *
 * 标定结论：该口径方向为正（mainline 组龙头此后 20 日平均约 +3.3%、跑赢率约 50%，
 * 而 rotation 组约 -3.8%、24%），且三项门槛越高收益越单调改善。
 * 但**刻意不上调阈值**：可用行情仅 600 个交易日，相邻观察点共享 19/20 的窗口，
 * 约 46 个 mainline 样本折算下来只有约 2 个独立事件；在这种样本上按收益调参
 * 几乎必然过拟合。前视窗口敏感性也不稳定（20 日 +3.3%、60 日 -4.3%、
 * 120 日约 +1.9%），不具备可依赖的形状。等历史积累更长后再重跑标定。
 */
export const SECTOR_THRESHOLDS: MainlineThresholds = {
  dispersionPercentileFloor: 40,
  persistenceFloor: 0.3,
  leaderEdgeFloor: 0.55,
}
