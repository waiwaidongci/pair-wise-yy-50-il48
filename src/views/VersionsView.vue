<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import ImpositionCanvas from '../components/ImpositionCanvas.vue'
import { useImpositionStore } from '../stores/imposition'

const store = useImpositionStore()
const accepted = ref(['CH-02', 'CH-03'])
const changes = [
  { id: 'CH-01', title: 'P7 右移 18mm 并增加 2mm 出血', before: 'x 34 / bleed 1mm', after: 'x 52 / bleed 3mm', risk: '低' },
  { id: 'CH-02', title: 'P1 封面旋转 180° 以匹配骑马订折手', before: 'rotation 0°', after: 'rotation 180°', risk: '中' },
  { id: 'CH-03', title: 'P4 与 P5 跨页间距缩短 4mm', before: 'gutter 10mm', after: 'gutter 6mm', risk: '中' },
  { id: 'CH-04', title: 'P2 版权页采用低出血文件', before: 'bleed 2mm', after: 'bleed 1mm', risk: '高' },
]

const baseline = computed(() => store.snapshots.filter((s) => s.status !== 'active').slice(-1)[0] ?? null)
const snapshotPositions = computed(() => store.activeSnapshot?.positions ?? store.positions)
const noApprovedProof = computed(() => store.proofs.every((p) => p.decision !== '通过'))
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">VERSION COMPARE / 版本对比</p>
        <h1>拼版版本并排审阅</h1>
        <p class="muted">锁定即冻结当时的版位与已通过打样结论；锁定后版位一改动或打样退回，该版本与其导出任务立即失效。</p>
      </div>
      <div class="actions">
        <Button label="导出对比报告" icon="pi pi-file-export" outlined />
        <Button
          :label="store.locked ? `已锁定 ${store.activeSnapshot?.versionId}` : '接受变更并锁定'"
          icon="pi pi-lock"
          :disabled="store.locked || accepted.length === 0"
          @click="store.lockBaseline"
        />
      </div>
    </div>

    <Message v-if="!store.locked && noApprovedProof" severity="warn" :closable="false" class="mb-3">
      当前还没有「通过」的打样轮次。锁定后快照将不含通过结论，建议先在打样审批页确认一轮再锁定。
    </Message>
    <Message v-if="store.legacyUnlocked && !store.activeSnapshot" severity="secondary" :closable="false" class="mb-3">
      {{ store.legacyNote }}。两侧均为旧稿草稿，修订并锁定后才会生成可交付版本。
    </Message>

    <div class="compare-grid">
      <section class="panel">
        <div class="panel-head">
          <h3>历史基线{{ baseline ? ` ${baseline.versionId}` : '（无）' }}</h3>
          <Tag v-if="baseline" :value="baseline.status === 'invalidated' ? '已失效' : '已被取代'" severity="secondary" />
          <Tag v-else value="升级前旧稿" severity="secondary" />
        </div>
        <div class="canvas-box">
          <ImpositionCanvas :positions="baseline?.positions ?? store.positions" side="front" :zoom="38" :selected="null" :validations="[]" @update="() => {}" @select="() => {}" />
        </div>
        <div v-if="baseline" class="snapshot-meta">
          <small>快照 {{ baseline.fingerprint }} · 锁定于 {{ baseline.lockedAt }}</small>
          <small>通过结论 {{ baseline.approvedProofs.length }} 份：{{ baseline.approvedProofs.map((p) => p.sample).join('、') || '无' }}</small>
        </div>
      </section>
      <section class="panel candidate">
        <div class="panel-head">
          <h3>{{ store.activeSnapshot ? `候选/锁定 ${store.activeSnapshot.versionId}` : '候选（未锁定草稿）' }}</h3>
          <Tag v-if="store.locked" value="已锁定 · 只读" severity="success" />
          <Tag v-else-if="store.activeSnapshot" :value="`${accepted.length} 项变更 · 已解锁`" severity="warn" />
          <Tag v-else :value="`${accepted.length} 项变更`" severity="warn" />
        </div>
        <div class="canvas-box">
          <ImpositionCanvas :positions="snapshotPositions" side="front" :zoom="38" :selected="null" :validations="store.locked ? [] : store.validations" @update="() => {}" @select="() => {}" />
        </div>
        <div v-if="store.activeSnapshot" class="snapshot-meta">
          <small>快照 {{ store.activeSnapshot.fingerprint }} · 锁定于 {{ store.activeSnapshot.lockedAt }}</small>
          <small>冻结通过结论 {{ store.activeSnapshot.approvedProofs.length }} 份：{{ store.activeSnapshot.approvedProofs.map((p) => p.sample).join('、') || '无' }}</small>
        </div>
      </section>
    </div>

    <section class="panel change-panel">
      <div class="panel-head"><h3>版式变更差异</h3><span class="muted">接受 {{ accepted.length }}/{{ changes.length }} 项</span></div>
      <div class="change-list">
        <article v-for="change in changes" :key="change.id">
          <Checkbox v-model="accepted" :inputId="change.id" :value="change.id" :disabled="store.locked" />
          <div><strong>{{ change.id }} · {{ change.title }}</strong><div class="diff"><span class="before">{{ change.before }}</span><i class="pi pi-arrow-right" /><span class="after">{{ change.after }}</span></div></div>
          <Tag :value="`${change.risk}风险`" :severity="change.risk === '高' ? 'danger' : change.risk === '中' ? 'warn' : 'success'" />
        </article>
      </div>
    </section>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.mb-3 { margin-bottom: 12px; }
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
.candidate { border-color: #5d9693; }
.canvas-box { height: 440px; overflow: auto; padding: 12px; background: #35474d; }
.snapshot-meta { display: grid; gap: 4px; padding: 10px 14px 12px; border-top: 1px solid #edf1f1; }
.snapshot-meta small { color: #718087; font-size: 10px; }
.change-panel { overflow: hidden; }
.change-list article { display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; align-items: center; padding: 14px 16px; border-bottom: 1px solid #edf1f1; }
.change-list strong { font-size: 12px; }
.diff { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-family: monospace; font-size: 10px; }
.diff span { padding: 4px 6px; border-radius: 4px; }
.before { color: #9f4c38; background: #fff0ec; }
.after { color: #2d735b; background: #e9f5ef; }
@media (max-width: 1000px) { .compare-grid { grid-template-columns: 1fr; } }
</style>
