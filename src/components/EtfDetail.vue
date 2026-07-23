<script setup lang="ts">
import { computed } from "vue";
import type { EtfSnapshot } from "../../shared/types";
import BaseChart from "./BaseChart.vue";
import { formatPct, formatShares, formatYi, shortName, yuanToYi } from "../utils/format";
import type { EChartsCoreOption } from "echarts/core";

const props = defineProps<{
  etf: EtfSnapshot | null;
}>();

const latestReport = computed(() => props.etf?.holderReports[0] ?? null);
const latestScale = computed(() => {
  const history = props.etf?.scaleHistory ?? [];
  return history[history.length - 1] ?? null;
});
const latestEstimate = computed(() => props.etf?.huijinEstimateHistory.at(-1) ?? null);

const pieOption = computed<EChartsCoreOption>(() => {
  const holders = latestReport.value?.holders ?? [];
  const data = holders.map((h) => ({
    name: h.isHuijin ? `★ ${h.name}` : h.name,
    value: h.percent,
    itemStyle: h.isHuijin ? { color: "#f0b429" } : undefined,
  }));
  const sum = holders.reduce((s, h) => s + h.percent, 0);
  if (sum < 99.5) {
    data.push({
      name: "其他持有人",
      value: Number((100 - sum).toFixed(2)),
      itemStyle: { color: "#334155" },
    });
  }
  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: "rgba(18,24,32,0.95)",
      borderColor: "rgba(148,163,184,0.2)",
      textStyle: { color: "#e8eef7", fontSize: 12 },
      formatter: "{b}<br/>占比 {c}%",
    },
    series: [
      {
        type: "pie",
        radius: ["42%", "68%"],
        center: ["50%", "52%"],
        label: {
          color: "#93a4b8",
          fontSize: 11,
          formatter: (p: { name: string; value: number }) => {
            const n = p.name.length > 14 ? p.name.slice(0, 14) + "…" : p.name;
            return `${n}\n${p.value}%`;
          },
        },
        labelLine: { lineStyle: { color: "rgba(148,163,184,0.35)" } },
        data,
      },
    ],
  };
});
</script>

<template>
  <div v-if="!etf" class="empty muted">选择上方表格中的一只 ETF 查看明细</div>
  <div v-else class="detail">
    <header class="detail-head">
      <div>
        <h3>
          {{ shortName(etf.name) }}
          <span class="mono code">{{ etf.code }}</span>
        </h3>
        <p class="muted source">
          持有人来源：{{ etf.source.holders }}
          <br />
          汇金估算口径：{{ etf.source.huijinEstimate || "份额 × 对应规模期附近单位净值" }}
          <span v-if="etf.source.holdersFromCache" class="cache-note">· 持有人接口限流，本次沿用 {{ etf.source.holdersFetchedAt?.slice(0, 10) || "上次" }} 成功快照</span>
          <span v-if="etf.source.holdersHistoryDeduplicated" class="cache-note">· 历史日期响应重复，已仅保留一份已验证快照</span>
        </p>
      </div>
      <div v-if="etf.latestHuijin" class="kpi-row">
        <div class="kpi">
          <div class="k">汇金占比</div>
          <div class="v mono huijin">
            {{ formatPct(etf.latestHuijin.percent) }}
          </div>
        </div>
        <div class="kpi">
          <div class="k">汇金份额</div>
          <div class="v mono">
            {{ formatShares(etf.latestHuijin.shares) }}
          </div>
        </div>
        <div class="kpi">
          <div class="k">报告期估值</div>
          <div class="v mono">
            {{ yuanToYi(etf.latestHuijin.marketValue) }}
          </div>
        </div>
        <div class="kpi">
          <div class="k">报告期</div>
          <div class="v mono">{{ etf.latestHuijin.reportDate }}</div>
        </div>
      </div>
    </header>

    <section v-if="latestScale" class="detail-scale">
      <div class="detail-scale-head">
        <h4>最新规模与汇金估算</h4>
        <span class="muted mono">规模期 {{ latestScale.date }}</span>
      </div>
      <div class="kpi-row">
        <div class="kpi">
          <div class="k">期末总份额</div>
          <div class="v mono">{{ formatShares(latestScale.totalSharesYi * 1e8) }}</div>
        </div>
        <div class="kpi">
          <div class="k">期末净资产</div>
          <div class="v mono">{{ formatYi(latestScale.netAssetYi) }}</div>
        </div>
        <div class="kpi">
          <div class="k">期间净申赎</div>
          <div class="v mono">
            {{ latestScale.purchaseYi != null && latestScale.redeemYi != null ? `${(latestScale.purchaseYi - latestScale.redeemYi).toFixed(2)} 亿份` : "—" }}
          </div>
        </div>
        <div class="kpi">
          <div class="k">汇金估算市值</div>
          <div class="v mono">{{ latestEstimate?.huijinValueYi != null ? formatYi(latestEstimate.huijinValueYi) : "待新披露" }}</div>
        </div>
        <div class="kpi">
          <div class="k">汇金估算占比</div>
          <div class="v mono huijin">{{ formatPct(latestEstimate?.huijinPct) }}</div>
        </div>
        <div v-if="latestEstimate?.unavailableReason" class="estimate-note">
          {{ latestEstimate.unavailableReason }}
        </div>
        <div v-else-if="latestEstimate?.estimateMethod === 'ratio-anchored'" class="estimate-note">按最近披露汇金占比锚定本期总份额，再乘规模期单位净值估算；不代表实时持仓</div>
        <div v-else-if="latestEstimate?.estimateMethod === 'interpolated'" class="estimate-note">按相邻持有人披露期的汇金份额线性插值，并乘规模期单位净值估算</div>
        <div v-else-if="latestEstimate?.isEstimated" class="estimate-note">份额沿用最近一期汇金披露，汇金市值按规模期单位净值估算</div>
      </div>
    </section>

    <div class="detail-grid">
      <div class="card panel">
        <h4>十大持有人结构</h4>
        <BaseChart :option="pieOption" height="300px" />
      </div>
      <div class="card panel">
        <h4>汇金系明细（{{ latestReport?.reportDate || "—" }}）</h4>
        <table v-if="latestReport" class="data-table compact">
          <thead>
            <tr>
              <th>#</th>
              <th>持有人</th>
              <th class="num">份额</th>
              <th class="num">占比</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(h, i) in latestReport.holders" :key="h.name + i" :class="{ 'huijin-row': h.isHuijin }">
              <td class="mono">{{ i + 1 }}</td>
              <td class="clapline">{{ h.name }}</td>
              <td class="num mono">{{ formatShares(h.shares) }}</td>
              <td class="num mono">{{ formatPct(h.percent) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">暂无十大持有人数据（部分 ETF 可能未披露）</p>
      </div>
    </div>
  </div>
</template>
