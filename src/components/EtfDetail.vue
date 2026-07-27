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
const latestAnchored = computed(() => {
  const pts =
    props.etf?.huijinEstimateHistory.filter(
      (p) => p.estimateMethod === "anchored",
    ) ?? [];
  return pts.length > 0 ? pts[pts.length - 1] : null;
});

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
          汇金展示口径：{{ etf.source.huijinEstimate || "仅展示持有人报告期披露" }}
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
        <h4>最新 ETF 份额</h4>
        <span class="muted mono">{{ latestScale.frequency === "daily" ? "交易日" : "规模期" }} {{ latestScale.date }}</span>
      </div>
      <div class="kpi-row">
        <div class="kpi">
          <div class="k">期末总份额</div>
          <div class="v mono">{{ formatShares(latestScale.totalSharesYi * 1e8) }}</div>
        </div>
        <div class="kpi">
          <div class="k">{{ latestScale.netAssetEstimated ? "估算基金规模" : "期末净资产" }}</div>
          <div class="v mono">{{ latestScale.netAssetEstimated ? "≈ " : "" }}{{ formatYi(latestScale.netAssetYi) }}</div>
        </div>
        <div class="kpi">
          <div class="k">{{ latestScale.frequency === "daily" ? "当日净份额变化" : "期间净申赎" }}</div>
          <div class="v mono">
            {{ latestScale.netSubscriptionYi != null ? `${latestScale.netSubscriptionYi.toFixed(2)} 亿份` : latestScale.purchaseYi != null && latestScale.redeemYi != null ? `${(latestScale.purchaseYi - latestScale.redeemYi).toFixed(2)} 亿份` : "—" }}
          </div>
        </div>
        <div class="kpi">
          <div class="k">估算持仓（参考）</div>
          <div class="v mono">
            <template v-if="latestAnchored">
              ≈ {{ formatYi(latestAnchored.huijinValueYi) }}
            </template>
            <template v-else>待新披露</template>
          </div>
        </div>
        <div class="kpi">
          <div class="k">估算占比（参考）</div>
          <div class="v mono huijin">
            {{ latestAnchored ? `≈ ${formatPct(latestAnchored.huijinPct)}` : "待新披露" }}
          </div>
        </div>
        <div class="estimate-note">
          {{
            latestAnchored
              ? `占比区间估算（${latestAnchored.date}）：下界假设份额变动全归因汇金，上界假设汇金占比不变，展示值取区间加权（下界 2/3 + 上界 1/3）`
              : "ETF 总份额变化不能识别持有人，无汇金披露锚点时不推算持仓"
          }}
        </div>
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
