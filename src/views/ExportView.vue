<script setup lang="ts">
import { computed } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useToast } from 'primevue/usetoast'
import { useImpositionStore, type ExportTask } from '../stores/imposition'
import { exportApi } from '../api/exportApi'

const store = useImpositionStore()
const queryClient = useQueryClient()
const toast = useToast()

const { data: tasks } = useQuery({
  queryKey: ['export-tasks'],
  queryFn: async () => (await exportApi.list()).data,
  initialData: store.tasks,
  refetchInterval: (query) => {
    const list = query.state.data as ExportTask[] | undefined
    return list?.some((task) => task.status === '生成中') ? 800 : false
  },
})

const list = computed<ExportTask[]>(() => tasks.value ?? store.tasks)
const hasLockedVersion = computed(() => Boolean(store.currentVersionId))

const resumeMutation = useMutation({
  mutationFn: async (id: string) => (await exportApi.resume(id)).data,
  onSuccess: (result) => {
    if (result.ok) {
      toast.add({ severity: 'success', summary: '任务续传', detail: '已按锁定快照继续生成，已完成分片直接复用', life: 3000 })
    } else {
      toast.add({ severity: 'warn', summary: '无法续传', detail: result.error, life: 4500 })
    }
    queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
  },
})

function createTask() {
  const result = store.createTask()
  if (!result.ok) toast.add({ severity: 'error', summary: '无法创建交付包', detail: result.error, life: 4500 })
  else queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
}

function statusSeverity(status?: string) {
  return status === '已完成' ? 'success' : status === '已中断' ? 'danger' : status === '生成中' ? 'warn' : 'info'
}

function canResume(task: ExportTask) {
  return task.versionId === store.currentVersionId && task.status !== '已完成' && task.status !== '待生成'
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">EXPORT JOBS / 导出任务</p><h1>交付包与断点恢复</h1><p class="muted">中断任务按锁定快照续传，已完成分片直接复用；版位改动或打样退回后旧任务回到待生成，历史结果仅可查看。</p></div>
      <Button label="新建印刷交付包" icon="pi pi-plus" @click="createTask" />
    </div>

    <Message v-if="!hasLockedVersion" severity="error" :closable="false" class="mb-3">
      当前没有锁定的拼版版本：未锁定草稿与旧稿不能作为交付依据。请在拼版工作区锁定版本后再创建交付包。
    </Message>

    <div class="export-grid">
      <section class="panel">
        <div class="panel-head"><h3>导出队列</h3><span class="muted">Axios 模拟 REST · 按锁定快照续传</span></div>
        <div class="task-list">
          <article v-for="task in list" :key="task.id">
            <div class="task-head">
              <div>
                <strong>{{ task.name }}</strong>
                <small>{{ task.id }} · {{ task.updatedAt }} · 依据版本 {{ task.versionLabel }}</small>
              </div>
              <Tag :value="task.status" :severity="statusSeverity(task.status)" />
            </div>
            <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '8px' }" />
            <div class="task-foot">
              <span>{{ task.progress }}% · 已完成 {{ task.completedSegments.length }}/{{ task.segments }} 分片<template v-if="task.snapshot"> · 快照 {{ task.snapshot.positions.length }} 版位</template></span>
              <Button
                v-if="task.status === '生成中'"
                label="生成中"
                icon="pi pi-spin pi-spinner"
                size="small"
                disabled
              />
              <Button
                v-else-if="task.status === '已完成'"
                label="打开结果"
                icon="pi pi-external-link"
                size="small"
                text
              />
              <Button
                v-else-if="canResume(task)"
                :label="task.progress > 0 ? '恢复任务' : '开始生成'"
                icon="pi pi-play"
                size="small"
                :loading="resumeMutation.isPending.value"
                @click="resumeMutation.mutate(task.id)"
              />
              <Button
                v-else
                :label="task.status === '待生成' ? '版本已变化' : '不可续传'"
                icon="pi pi-lock"
                size="small"
                outlined
                disabled
              />
            </div>
            <Message v-if="task.status === '待生成'" severity="warn" :closable="false" class="invalid-note">
              {{ task.invalidReason ?? '版本已变化，任务回到待生成' }}
            </Message>
            <div v-if="task.history.length" class="history">
              <h4>历史结果（仅查看，不能作为交付依据）</h4>
              <div v-for="(entry, index) in task.history" :key="index" class="history-item">
                <Tag value="历史" severity="info" />
                <span>{{ entry.versionLabel }} · {{ entry.status }} · {{ entry.progress }}% · {{ entry.completedAt }}</span>
                <Button label="查看" text size="small" disabled />
              </div>
            </div>
          </article>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>交付包内容</h3><Tag :value="store.currentVersionId ?? '未锁定'" :severity="store.currentVersionId ? 'success' : 'danger'" /></div>
          <div class="package-list">
            <div><i class="pi pi-file-pdf" /><span>拼版 PDF/X-4</span><strong>{{ store.currentVersionId ? '按锁定快照生成' : '待生成' }}</strong></div>
            <div><i class="pi pi-check-circle" /><span>预检报告 JSON</span><strong>{{ store.validations.length }} 项</strong></div>
            <div><i class="pi pi-check-circle" /><span>色彩控制条报告</span><strong>已包含</strong></div>
            <div><i class="pi pi-check-circle" /><span>打样审批记录</span><strong>{{ store.proofs.filter((proof) => proof.decision === '通过').length }} 轮通过</strong></div>
            <div><i class="pi pi-check-circle" /><span>纸张与折手规格</span><strong>已包含</strong></div>
          </div>
        </section>
        <section class="panel recovery">
          <div class="panel-head"><h3>恢复说明</h3></div>
          <p>任务按锁定快照中的版位与打样结论生成，分片按 16 页一组写入临时目录。中断后从已完成分片续传；若版位改动、打样退回或其他标签页接管，旧任务立即回到待生成，已产出结果仅作历史查看。</p>
          <Button label="清理已完成任务" severity="secondary" outlined fluid />
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.export-grid { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 14px; align-items: start; }
.mb-3 { margin-bottom: 12px; }
.task-list { padding: 8px 16px 16px; }
.task-list article { padding: 15px 0; border-bottom: 1px solid #e9eeee; }
.task-head, .task-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.task-head { margin-bottom: 11px; }
.task-head strong, .task-head small { display: block; }
.task-head small { margin-top: 4px; color: #7c898f; font-size: 10px; }
.task-foot { margin-top: 9px; }
.task-foot span { color: #68777e; font-size: 10px; }
.invalid-note { margin-top: 10px; }
.history { margin-top: 10px; padding: 9px 11px; border: 1px dashed #c9d4d6; border-radius: 7px; background: #f7faf9; }
.history h4 { margin: 0 0 7px; color: #7c898f; font-size: 10px; font-weight: 700; }
.history-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; color: #68777e; font-size: 10px; }
.history-item span { flex: 1; }
aside { display: grid; gap: 14px; }
.package-list { padding: 8px 16px 16px; }
.package-list div { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid #edf1f1; font-size: 11px; }
.package-list i { color: #397d64; }
.package-list strong { color: #536b72; font-size: 10px; }
.recovery p { padding: 0 16px; color: #67767d; font-size: 11px; line-height: 1.6; }
.recovery :deep(.p-button) { width: calc(100% - 32px); margin: 0 16px 16px; }
@media (max-width: 1000px) { .export-grid { grid-template-columns: 1fr; } }
</style>
