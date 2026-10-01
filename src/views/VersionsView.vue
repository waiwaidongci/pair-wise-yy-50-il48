<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useToast } from 'primevue/usetoast'
import ImpositionCanvas from '../components/ImpositionCanvas.vue'
import { useImpositionStore } from '../stores/imposition'

const store = useImpositionStore()
const toast = useToast()
const accepted = ref<string[]>([])

const changes = [
  { id: 'CH-01', title: 'P7 右移 18mm 并增加 2mm 出血', before: 'x 34 / bleed 1mm', after: 'x 52 / bleed 3mm', risk: '低' },
  { id: 'CH-02', title: 'P1 封面旋转 180° 以匹配骑马订折手', before: 'rotation 0°', after: 'rotation 180°', risk: '中' },
  { id: 'CH-03', title: 'P4 与 P5 跨页间距缩短 4mm', before: 'gutter 10mm', after: 'gutter 6mm', risk: '中' },
  { id: 'CH-04', title: 'P2 版权页采用低出血文件', before: 'bleed 2mm', after: 'bleed 1mm', risk: '高' },
]

const currentVersion = computed(() => store.versions.find((version) => version.id === store.currentVersionId) ?? null)
const baseline = computed(() => {
  const locked = store.versions.filter((version) => version.status === 'locked')
  return locked[locked.length - 1] ?? store.versions[0] ?? null
})
const approvedProofs = computed(() => (currentVersion.value ? currentVersion.value.proofs.filter((proof) => proof.decision === '通过') : []))

function lockNow() {
  store.lockBaseline()
  toast.add({ severity: 'success', summary: '版本已锁定', detail: '版位与打样结论已留存，可作为交付依据', life: 3500 })
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">VERSION COMPARE / 版本对比</p><h1>拼版版本并排审阅</h1><p class="muted">锁定后留存当时的版位与打样结论；版位改动或打样退回时，旧版本进入历史，导出任务回到待生成。</p></div>
      <div class="actions"><Button label="导出对比报告" icon="pi pi-file-export" outlined /><Button label="接受变更并锁定" icon="pi pi-lock" :disabled="accepted.length === 0" @click="lockNow" /></div>
    </div>

    <Message v-if="!currentVersion" severity="warn" :closable="false" class="mb-3">
      当前为未锁定草稿：没有可作为交付依据的锁定版本。旧稿已归入未锁定历史，不能作为交付依据。
    </Message>

    <div class="compare-grid">
      <section class="panel">
        <div class="panel-head"><h3>基线 {{ baseline?.label ?? '—' }}</h3><Tag value="只读快照" /></div>
        <div class="canvas-box"><ImpositionCanvas :positions="baseline?.positions ?? []" side="front" :zoom="38" :selected="null" :validations="store.validations" @update="() => {}" @select="() => {}" /></div>
      </section>
      <section class="panel candidate">
        <div class="panel-head"><h3>当前草稿</h3><Tag :value="currentVersion ? `已锁定 ${currentVersion.label}` : '未锁定'" :severity="currentVersion ? 'success' : 'warn'" /></div>
        <div class="canvas-box"><ImpositionCanvas :positions="store.positions" side="front" :zoom="38" :selected="null" :validations="store.validations" @update="() => {}" @select="() => {}" /></div>
      </section>
    </div>

    <section v-if="currentVersion" class="panel approved-panel">
      <div class="panel-head"><h3>{{ currentVersion.label }} 已通过的打样结论</h3><Tag :value="`${approvedProofs.length} 项通过`" severity="success" /></div>
      <div v-if="approvedProofs.length" class="proof-list">
        <div v-for="proof in approvedProofs" :key="proof.id" class="proof-line">
          <Tag value="通过" severity="success" />
          <span>第 {{ proof.round }} 轮 · {{ proof.sample }} · ΔE {{ proof.deltaE }} · {{ proof.owner }} · {{ proof.date }}</span>
        </div>
      </div>
      <div v-else class="empty">本版本暂无通过的打样结论，锁定版本留存当时的全部打样记录。</div>
    </section>

    <section class="panel history-panel">
      <div class="panel-head"><h3>版本历史</h3><Tag :value="`${store.versions.length} 版`" /></div>
      <div class="version-list">
        <article v-for="version in store.versions.slice().reverse()" :key="version.id ?? 'legacy'">
          <div>
            <strong>
              {{ version.label }}
              <Tag v-if="version.id === store.currentVersionId" value="当前基线" severity="success" />
              <Tag v-else-if="version.unlocked" value="未锁定历史" severity="warn" />
              <Tag v-else value="历史版本" severity="info" />
            </strong>
            <small>{{ version.lockedAt }} · {{ version.positions.length }} 个版位 · {{ version.pages.length }} 页 · {{ version.proofs.length }} 轮打样 · {{ version.approvedProofIds.length }} 项通过结论</small>
            <small v-if="version.unlocked" class="legacy-note">旧稿没有版本号，升级后归入未锁定历史，不能作为交付依据。</small>
          </div>
          <Tag :value="version.id === store.currentVersionId ? '可交付' : '仅查看'" :severity="version.id === store.currentVersionId ? 'success' : 'secondary'" />
        </article>
      </div>
    </section>

    <section class="panel change-panel">
      <div class="panel-head"><h3>版式变更差异</h3><span class="muted">接受 {{ accepted.length }}/{{ changes.length }} 项</span></div>
      <div class="change-list">
        <article v-for="change in changes" :key="change.id">
          <Checkbox v-model="accepted" :inputId="change.id" :value="change.id" />
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
.approved-panel { margin-bottom: 14px; }
.proof-list { padding: 6px 16px 14px; }
.proof-line { display: flex; align-items: center; gap: 8px; padding: 8px 0; color: #4d5f65; font-size: 11px; }
.empty { padding: 18px 16px; color: #8a979c; font-size: 11px; }
.history-panel { margin-bottom: 14px; }
.version-list { padding: 6px 16px 14px; }
.version-list article { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #edf1f1; }
.version-list strong, .version-list small { display: block; }
.version-list small { margin-top: 4px; color: #7a878d; font-size: 10px; }
.legacy-note { color: #b07a2c !important; }
.change-panel { overflow: hidden; }
.change-list article { display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; align-items: center; padding: 14px 16px; border-bottom: 1px solid #edf1f1; }
.change-list strong { font-size: 12px; }
.diff { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-family: monospace; font-size: 10px; }
.diff span { padding: 4px 6px; border-radius: 4px; }
.before { color: #9f4c38; background: #fff0ec; }
.after { color: #2d735b; background: #e9f5ef; }
@media (max-width: 1000px) { .compare-grid { grid-template-columns: 1fr; } }
</style>
