<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import { useToast } from 'primevue/usetoast'
import { useImpositionStore } from '../stores/imposition'
import { currentClientLabel, errorCode, errorMessage, exportApi, getClientId, onLeaseTaken, onServerChange } from '../api/exportApi'
import type { ExportTask } from '../types'

const store = useImpositionStore()
const toast = useToast()
const queryClient = useQueryClient()
const clientId = getClientId()
const label = currentClientLabel()
const historyTask = ref<ExportTask | null>(null)
const historyVisible = ref(false)

function openHistory(task: ExportTask) {
  historyTask.value = task
  historyVisible.value = true
}

const { data: tasks } = useQuery({
  queryKey: ['export-tasks'],
  queryFn: async () => (await exportApi.list()).data,
  refetchInterval: (query) => {
    const list = query.state.data as ExportTask[] | undefined
    // 有任务在跑时由查询本身高频刷新，保证分片进度/接管状态实时可见
    return list?.some((t) => t.status === '生成中' || t.status === '排队中') ? 600 : 3000
  },
  initialData: store.tasks,
})

watch(tasks, (value) => { store.tasks = value ?? [] }, { deep: true })
onServerChange(() => queryClient.invalidateQueries({ queryKey: ['export-tasks'] }))

const activeSnapshot = computed(() => store.activeSnapshot)

const liveTasks = computed(() => (tasks.value ?? []).filter((t) => !t.legacy))
const legacyTasks = computed(() => (tasks.value ?? []).filter((t) => t.legacy))
const canCreate = computed(() => !!activeSnapshot.value)

function statusSeverity(status?: string) {
  return status === '已完成' ? 'success' : status === '已中断' ? 'danger' : status === '生成中' ? 'warn' : status === '已失效' ? 'secondary' : 'info'
}

function shardSeverity(status: string) {
  return status === '已完成' ? 'success' : status === '失败' ? 'danger' : 'secondary'
}

/* ------------------------------- 新建任务 ------------------------------ */

const createMutation = useMutation({
  mutationFn: async () => {
    const snap = activeSnapshot.value
    if (!snap) throw new Error('NO_SNAPSHOT')
    return (await exportApi.create({
      versionId: snap.versionId,
      revision: snap.revision,
      positions: snap.positions,
      approvedProofs: snap.approvedProofs,
      fingerprint: snap.fingerprint,
      lockedAt: snap.lockedAt,
    })).data
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    toast.add({ severity: 'success', summary: '导出任务已创建', detail: `按锁定快照 ${activeSnapshot.value?.versionId} 从第一个分片开始生成。` })
  },
  onError: (err) => toast.add({ severity: 'error', summary: '无法创建导出任务', detail: errorMessage(err), life: 4800 }),
})

/* --------------------------- 续传（带版本校验） -------------------------- */

function resume(task: ExportTask) {
  resumeMutation.mutate(task.id)
}

const resumeMutation = useMutation({
  mutationFn: async (id: string) => {
    // 续传必须携带当前锁定版本；服务端比对任务内嵌快照，版本不符直接 409
    const snap = activeSnapshot.value
    if (!snap) throw new Error('NO_ACTIVE_SNAPSHOT')
    return (await exportApi.resume(id, snap.versionId, snap.fingerprint, label)).data
  },
  onSuccess: (task) => {
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    const from = (task as ExportTask & { resumedFromShard?: string }).resumedFromShard
    toast.add({ severity: 'success', summary: `${label} 已接管 ${task.id}`, detail: `按快照 ${task.versionId} 从分片 ${from ?? '首个未完成'} 续传，已完成分片直接复用。`, life: 4200 })
  },
  onError: (err) => {
    const code = errorCode(err)
    const detail = errorMessage(err)
    if (code === 'VERSION_CHANGED') {
      toast.add({ severity: 'warn', summary: '版本已变化', detail: `${detail}。请刷新后对当前版本重新生成。`, life: 6000 })
    } else if (code === 'LEASE_HELD') {
      toast.add({ severity: 'warn', summary: '另一个标签页正在续传', detail: `${detail}；若原标签页已关闭，可等待租约过期后强制接管。`, life: 6000 })
    } else {
      toast.add({ severity: 'error', summary: '续传被拒绝', detail, life: 5000 })
    }
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
  },
})

/* ----------------------- 强制接管（租约过期/抢占） ----------------------- */

const takeOverMutation = useMutation({
  mutationFn: async (id: string) => (await exportApi.resume(id, activeSnapshot.value!.versionId, activeSnapshot.value!.fingerprint, label, true)).data,
  onSuccess: (task) => {
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    toast.add({ severity: 'success', summary: `${label} 已强制接管`, detail: `任务 ${task.id} 继续从最早未完成分片生成，原标签页会收到接管提示。` })
  },
  onError: (err) => toast.add({ severity: 'error', summary: '接管失败', detail: errorMessage(err), life: 5000 }),
})

/* ---------- 被其他标签页抢占时立即停止本页心跳（不能再写旧任务） ---------- */

onLeaseTaken(({ taskId, by }) => {
  clearHeartbeat(taskId)
  queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
  toast.add({ severity: 'warn', life: 12000, summary: `任务 ${taskId} 已被「${by}」接管`, detail: '本页停止续传，新分片只会写入接管方，不会混入旧任务。' })
})

/* ------------------------ 心跳：维持当前标签的租约 ------------------------ */

const heartbeats = new Map<string, number>()

function clearHeartbeat(id: string) {
  const handle = heartbeats.get(id)
  if (handle) {
    window.clearInterval(handle)
    heartbeats.delete(id)
  }
}

function startHeartbeat(task: ExportTask) {
  if (heartbeats.has(task.id)) return
  const handle = window.setInterval(async () => {
    try {
      await exportApi.heartbeat(task.id, task.versionId!)
      queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    } catch (err) {
      const code = errorCode(err)
      clearHeartbeat(task.id)
      queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
      if (code === 'TAKEN_OVER') {
        toast.add({ severity: 'warn', life: 12000, summary: `任务 ${task.id} 已被另一个标签页接管`, detail: `${errorMessage(err)}，本页停止写入，新分片不会进入旧任务。` })
      } else if (code === 'VERSION_CHANGED') {
        toast.add({ severity: 'warn', life: 12000, summary: `任务 ${task.id} 的锁定版本已变化`, detail: '本页停止续传，不能把新分片写进旧任务。' })
      } else if (code === 'TASK_INVALIDATED') {
        toast.add({ severity: 'error', summary: `任务 ${task.id} 已失效`, detail: errorMessage(err), life: 5000 })
      }
    }
  }, 1500)
  heartbeats.set(task.id, handle)
}

watch(
  tasks,
  (list) => {
    list?.forEach((task) => {
      const mine = task.status === '生成中' && task.lease?.clientId === clientId
      if (mine) startHeartbeat(task)
      else clearHeartbeat(task.id)
    })
  },
  { deep: true, immediate: true },
)

onUnmounted(() => heartbeats.forEach((h) => window.clearInterval(h)))

/* ---------------------------- 模拟分片失败 ----------------------------- */

const failMutation = useMutation({
  mutationFn: async (id: string) => (await exportApi.simulateFail(id)).data,
  onSuccess: (task) => {
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
    toast.add({ severity: 'error', summary: `分片失败：任务 ${task.id}`, detail: '任务已中断，续传时从第一个未完成分片重试，已完成分片保留。', life: 5000 })
  },
  onError: (err) => toast.add({ severity: 'error', summary: '操作失败', detail: errorMessage(err), life: 4000 }),
})

const deliveryTone: Record<string, { severity: 'success' | 'warn' | 'info' | 'error' | 'secondary'; icon: string }> = {
  delivered: { severity: 'success', icon: 'pi pi-check-circle' },
  running: { severity: 'info', icon: 'pi pi-spin pi-spinner' },
  paused: { severity: 'warn', icon: 'pi pi-pause-circle' },
  pending: { severity: 'warn', icon: 'pi pi-hourglass' },
  invalidated: { severity: 'error', icon: 'pi pi-ban' },
  draft: { severity: 'warn', icon: 'pi pi-pencil' },
  legacy: { severity: 'secondary', icon: 'pi pi-archive' },
}
const delivery = computed(() => deliveryTone[store.deliveryState.tone])
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">EXPORT JOBS / 导出任务</p><h1>交付包与断点恢复</h1><p class="muted">导出任务绑定审批锁定时的版位与打样快照；版位改动或打样退回，旧任务立即失效，只能对新版本重新生成。</p></div>
      <Button label="按锁定版本生成交付包" icon="pi pi-plus" :disabled="!canCreate" :loading="createMutation.isPending.value" @click="createMutation.mutate()" />
    </div>

    <Message :severity="delivery.severity" :closable="false" class="delivery-banner">
      <template #icon><i :class="delivery.icon" /></template>
      <strong v-if="activeSnapshot">锁定版本 {{ activeSnapshot.versionId }} · 含 {{ activeSnapshot.approvedProofs.length }} 份通过结论 · </strong>
      <strong v-else>无锁定版本 · </strong>{{ store.deliveryState.text }}
      <span v-if="!canCreate" class="banner-hint">（旧稿没有版本号，不能作为交付依据）</span>
    </Message>

    <div class="export-grid">
      <section class="panel">
        <div class="panel-head"><h3>当前版本导出队列</h3><span class="muted">分片 2 页/组 · 失败按片重试</span></div>
        <div class="task-list">
          <article v-for="task in liveTasks" :key="task.id" :class="{ invalid: task.status === '已失效' }">
            <div class="task-head">
              <div><strong>{{ task.name }}</strong><small>{{ task.id }} · {{ task.updatedAt }}</small></div>
              <div class="task-tags">
                <Tag :value="task.versionId ?? '无版本'" severity="info" />
                <Tag :value="task.status" :severity="statusSeverity(task.status)" />
              </div>
            </div>

            <div class="shards">
              <span v-for="shard in task.shards" :key="shard.id" class="shard" :class="shard.status">
                <i :class="shard.status === '已完成' ? 'pi pi-check' : shard.status === '失败' ? 'pi pi-times' : 'pi pi-minus'" />
                {{ shard.id }}<em>P{{ shard.pages[0] }}-{{ shard.pages[1] }}</em>
              </span>
            </div>

            <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '8px' }" />

            <div v-if="task.status === '已失效'" class="invalid-note">
              <i class="pi pi-info-circle" /> 已失效：{{ task.invalidReasonText ?? '绑定版本被修订' }}，结果仅作历史查看，交付需对新版本重新生成。
            </div>
            <div v-else-if="task.lease && task.status === '生成中'" class="lease-note" :class="{ mine: task.lease.clientId === clientId }">
              <i class="pi pi-server" /> {{ task.lease.clientId === clientId ? '本页持有续传租约' : `由「${task.lease.clientLabel}」续传` }}
            </div>

            <div class="task-foot">
              <span>
                {{ task.status === '已完成' ? '文件哈希已校验' : `${task.progress}% · 已完成分片复用` }}
                <template v-if="task.shards.some((s) => s.status === '失败')"> · 存在失败分片</template>
              </span>
              <div class="foot-actions">
                <Button v-if="task.status === '已中断' && task.resumable" label="从已完成分片续传" icon="pi pi-play" size="small" :loading="resumeMutation.isPending.value" @click="resume(task)" />
                <Button v-if="task.status === '已中断' && task.resumable" label="强制接管" icon="pi pi-sign-in" size="small" severity="warning" outlined @click="takeOverMutation.mutate(task.id)" />
                <Button v-if="task.status === '生成中'" label="模拟当前分片失败" icon="pi pi-bolt" size="small" severity="danger" outlined :loading="failMutation.isPending.value" @click="failMutation.mutate(task.id)" />
                <Button v-if="task.status === '生成中'" :label="task.lease?.clientId === clientId ? '本页续传中' : '等待他页完成'" icon="pi pi-spin pi-spinner" size="small" text disabled />
                <Button v-if="task.status === '已完成'" label="打开结果" icon="pi pi-external-link" size="small" @click="openHistory(task)" />
                <Button v-if="task.status === '已失效'" label="查看历史结果" icon="pi pi-history" size="small" text @click="openHistory(task)" />
              </div>
            </div>
          </article>
          <div v-if="liveTasks.length === 0" class="empty-line">尚无版本化导出任务，锁定版本后可生成。</div>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>交付包内容</h3><Tag :value="store.versionLabel" :severity="store.activeSnapshot ? 'success' : 'secondary'" /></div>
          <div class="package-list">
            <div><i class="pi pi-file-pdf" /><span>拼版 PDF/X-4</span>
              <strong :class="{ muted: !store.activeSnapshot }">{{ store.deliveryState.tone === 'delivered' ? '已生成' : '待生成' }}</strong>
            </div>
            <div><i class="pi pi-check-circle" /><span>预检报告 JSON</span><strong>{{ store.validations.length }} 项</strong></div>
            <div><i class="pi pi-check-circle" /><span>色彩控制条报告</span><strong>已包含</strong></div>
            <div><i class="pi pi-check-circle" /><span>打样审批记录</span>
              <strong>{{ store.activeSnapshot ? `${store.activeSnapshot.approvedProofs.length} 份通过（快照冻结）` : `${store.proofs.length} 轮` }}</strong>
            </div>
            <div><i class="pi pi-check-circle" /><span>纸张与折手规格</span><strong>已包含</strong></div>
            <div v-if="store.activeSnapshot"><i class="pi pi-lock" /><span>版位快照指纹</span><strong>{{ store.activeSnapshot.fingerprint }}</strong></div>
          </div>
          <p v-if="store.legacyUnlocked" class="legacy-note">{{ store.legacyNote }}。</p>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>未锁定历史（旧稿）</h3><Tag value="不可交付" severity="secondary" /></div>
          <div class="legacy-list">
            <button v-for="task in legacyTasks" :key="task.id" @click="openHistory(task)">
              <i class="pi pi-archive" />
              <div><strong>{{ task.name }}</strong><small>{{ task.id }} · {{ task.status }} · {{ task.progress }}%</small></div>
              <i class="pi pi-angle-right" />
            </button>
            <p v-if="legacyTasks.length === 0">无旧稿记录。</p>
          </div>
        </section>

        <section class="panel recovery">
          <div class="panel-head"><h3>续传与接管规则</h3></div>
          <p>任务内嵌锁定快照与分片清单。续传请求携带版本号，版本不符返回「版本已变化」，新分片不会写入旧任务。每个任务只有一个续传租约（约 4 秒心跳），两个标签页同时续传时只有一个接管；租约过期后可强制接管，从最早未完成分片重跑，已完成分片按哈希复用。</p>
        </section>
      </aside>
    </div>

    <Dialog v-model:visible="historyVisible" modal header="历史结果查看" :style="{ width: '560px' }">
      <template v-if="historyTask">
        <div class="history-dialog">
          <div class="dlg-row"><span>任务</span><strong>{{ historyTask.name }}</strong></div>
          <div class="dlg-row"><span>编号</span><strong>{{ historyTask.id }}</strong></div>
          <div class="dlg-row"><span>绑定版本</span><strong>{{ historyTask.versionId ?? '旧稿 · 无版本号' }}</strong></div>
          <div class="dlg-row"><span>状态</span><strong>{{ historyTask.status }}{{ historyTask.deliverable ? ' · 可交付' : ' · 仅历史' }}</strong></div>
          <div class="dlg-row"><span>快照指纹</span><strong>{{ historyTask.snapshot?.fingerprint ?? '—' }}</strong></div>
          <div v-if="historyTask.artifact" class="artifact-box">
            <i class="pi pi-file-pdf" />
            <div>
              <strong>{{ historyTask.artifact.url }}</strong>
              <small>SHA256 {{ historyTask.artifact.hash }} · {{ historyTask.artifact.pages }} 页 · {{ historyTask.artifact.sizeKb }} KB · {{ historyTask.artifact.generatedAt }}</small>
            </div>
          </div>
          <div v-else class="artifact-box muted"><i class="pi pi-inbox" /><div><strong>无成品文件</strong><small>任务未完成或已失效，仅保留已产出的分片记录。</small></div></div>
          <div class="dlg-shards">
            <Tag v-for="shard in historyTask.shards" :key="shard.id" :value="`${shard.id} ${shard.status}`" :severity="shardSeverity(shard.status)" />
          </div>
          <Message v-if="!historyTask.deliverable" severity="secondary" :closable="false">该结果不对应当前审批版本，不能作为交付依据。</Message>
        </div>
      </template>
    </Dialog>
  </section>
</template>

<style scoped>
.delivery-banner { margin-bottom: 14px; }
.banner-hint { color: #7c898f; }
.export-grid { display: grid; grid-template-columns: minmax(0,1fr) 350px; gap: 14px; align-items: start; }
.task-list { padding: 8px 16px 16px; }
.task-list article { padding: 15px 0; border-bottom: 1px solid #e9eeee; }
.task-list article.invalid { opacity: .92; }
.task-head, .task-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.task-head { margin-bottom: 11px; }
.task-tags { display: flex; gap: 6px; }
.task-head strong, .task-head small { display: block; }
.task-head small { margin-top: 4px; color: #7c898f; font-size: 10px; }
.shards { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 9px; }
.shard { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 20px; font-size: 10px; font-weight: 700; background: #eceff0; color: #718086; }
.shard em { font-style: normal; opacity: .7; }
.shard.已完成 { background: #e6f4ec; color: #2f7d58; }
.shard.失败 { background: #fdece8; color: #b64a31; }
.invalid-note { display: flex; gap: 7px; align-items: flex-start; margin-top: 8px; padding: 8px 10px; border-radius: 6px; color: #8a4a37; background: #fdf0ec; font-size: 11px; }
.lease-note { margin-top: 8px; color: #3a6f81; font-size: 10px; }
.lease-note.mine { color: #2f7d58; font-weight: 700; }
.task-foot { margin-top: 9px; }
.task-foot span { color: #68777e; font-size: 10px; }
.foot-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.empty-line { padding: 24px 0; color: #8a969c; font-size: 12px; text-align: center; }
aside { display: grid; gap: 14px; }
.package-list { padding: 8px 16px 4px; }
.package-list div { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid #edf1f1; font-size: 11px; }
.package-list i { color: #397d64; }
.package-list strong { color: #536b72; font-size: 10px; }
.package-list strong.muted { color: #9aa6ab; }
.legacy-note { padding: 10px 16px 14px; color: #7a6a4f; font-size: 10px; line-height: 1.6; }
.legacy-list { padding: 6px 10px 12px; }
.legacy-list button { display: grid; width: 100%; grid-template-columns: 22px 1fr 14px; align-items: center; gap: 8px; padding: 9px 6px; border: 0; background: transparent; text-align: left; cursor: pointer; border-radius: 6px; }
.legacy-list button:hover { background: #f4f6f6; }
.legacy-list i:first-child { color: #8a969c; }
.legacy-list strong, .legacy-list small { display: block; }
.legacy-list strong { font-size: 11px; }
.legacy-list small { margin-top: 3px; color: #8b989e; font-size: 9px; }
.legacy-list p { padding: 8px 6px; color: #9aa6ab; font-size: 10px; }
.recovery p { padding: 0 16px 16px; color: #67767d; font-size: 11px; line-height: 1.7; }
.history-dialog { display: grid; gap: 12px; }
.dlg-row { display: flex; justify-content: space-between; gap: 14px; font-size: 12px; }
.dlg-row span { color: #7c898f; }
.artifact-box { display: flex; gap: 10px; align-items: center; padding: 12px; border-radius: 8px; background: #f4f7f7; }
.artifact-box i { font-size: 22px; color: #b6542f; }
.artifact-box.muted i { color: #98a5ab; }
.artifact-box strong, .artifact-box small { display: block; word-break: break-all; }
.artifact-box small { margin-top: 5px; color: #7c898f; font-size: 10px; }
.dlg-shards { display: flex; flex-wrap: wrap; gap: 6px; }
@media (max-width: 1000px) { .export-grid { grid-template-columns: 1fr; } }
</style>
