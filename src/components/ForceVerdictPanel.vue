<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot, MarketActiveCapPoint } from '../../shared/types'
import { collectForceInputs } from '../utils/forceVerdictCollect'
import { judgeHuijinForce } from '../utils/forceVerdict'

const props = withDefaults(
  defineProps<{
    etfs?: EtfSnapshot[]
    marketHistory?: MarketActiveCapPoint[]
  }>(),
  { etfs: () => [], marketHistory: () => [] },
)

const verdict = computed(() => {
  const collected = collectForceInputs(props.etfs, props.marketHistory)
  return judgeHuijinForce(collected.etfs, collected.market)
})

const gates = computed(() => {
  const current = verdict.value
  return [
    { title: '对象', ...current.gates.object },
    { title: '结构', ...current.gates.structure },
    { title: '替代解释', ...current.gates.alternative },
  ]
})
</script>

<template>
  <section class="card panel force-verdict" aria-labelledby="force-verdict-title">
    <div class="panel-head">
      <div>
        <h2 id="force-verdict-title">主力判决</h2>
        <p class="muted">三闸门假设检验 · 大额宽基申赎才打开汇金先验</p>
      </div>
      <span class="pill">描述性结论</span>
    </div>

    <div class="force-verdict-grid">
      <div
        class="force-verdict-primary"
        :data-tier="verdict.tier"
        :data-tone="verdict.tone"
        role="status"
      >
        <div class="insight-label">综合</div>
        <div class="insight-value">{{ verdict.label }}</div>
        <div class="insight-detail muted">{{ verdict.detail }}</div>
      </div>
      <div
        v-for="gate in gates"
        :key="gate.title"
        class="force-verdict-gate"
        :data-status="gate.status"
      >
        <div class="insight-label">{{ gate.title }}</div>
        <div class="insight-value">{{ gate.label }}</div>
        <div class="insight-detail muted">{{ gate.reason }}</div>
      </div>
    </div>

    <p v-if="verdict.intent" class="force-verdict-intent">{{ verdict.intent }}</p>
    <p
      v-for="line in verdict.cautions"
      :key="line"
      class="insight-detail caution"
    >
      {{ line }}
    </p>
    <p class="muted insight-disclaimer">{{ verdict.disclaimer }}</p>
  </section>
</template>
