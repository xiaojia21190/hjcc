<script setup lang="ts">
import { computed } from 'vue'
import type { EtfSnapshot, MarketActiveCapPoint } from '../../shared/types'
import { composeForceBriefing } from '../utils/forceBriefing'
import { collectBriefingInputs } from '../utils/forceBriefingCollect'

const props = withDefaults(
  defineProps<{
    etfs?: EtfSnapshot[]
    marketHistory?: MarketActiveCapPoint[]
  }>(),
  { etfs: () => [], marketHistory: () => [] },
)

const briefing = computed(() => {
  const collected = collectBriefingInputs(props.etfs, props.marketHistory)
  return composeForceBriefing(collected.etfs, collected.market)
})
</script>

<template>
  <section class="card panel force-briefing" aria-labelledby="force-briefing-title">
    <div class="panel-head">
      <div>
        <h2 id="force-briefing-title">主力简报</h2>
        <p class="muted">由份额结构规则生成 · 不是模型推理 · 大额宽基申赎才打开汇金先验</p>
      </div>
      <span class="pill">规则简报</span>
    </div>

    <div
      class="force-briefing-hero"
      :data-tier="briefing.tier"
      :data-tone="briefing.tone"
      role="status"
    >
      <div class="insight-label">综合</div>
      <div class="insight-value">{{ briefing.headline }}</div>
      <p class="force-briefing-lead">{{ briefing.lead }}</p>
    </div>

    <div class="force-briefing-grid">
      <div>
        <div class="insight-label">去向</div>
        <p class="force-briefing-copy">{{ briefing.path }}</p>
      </div>
      <div v-if="briefing.intent">
        <div class="insight-label">意图</div>
        <p class="force-briefing-copy">{{ briefing.intent }}</p>
      </div>
    </div>

    <ul v-if="briefing.bullets.length" class="force-briefing-list">
      <li v-for="line in briefing.bullets" :key="line">{{ line }}</li>
    </ul>

    <p
      v-for="line in briefing.cautions"
      :key="line"
      class="insight-detail caution"
    >
      {{ line }}
    </p>
    <p class="muted insight-disclaimer">{{ briefing.disclaimer }}</p>
  </section>
</template>
