import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type Page = { pageNo: number; name: string; width: number; height: number; bleed: number; content: string }
export type Position = { id: string; pageNo: number; x: number; y: number; rotation: number; front: boolean }
export type Validation = { id: string; severity: '错误' | '警告'; pageNo?: number; title: string; detail: string }
export type Proof = { id: string; round: number; date: string; sample: string; deltaE: number; feedback: string; correction: string; owner: string; decision: '待决定' | '通过' | '退回' }
export type TaskStatus = '排队中' | '生成中' | '已完成' | '已中断' | '待生成'
export type TaskHistoryEntry = { versionId: string | null; versionLabel: string; progress: number; status: string; completedAt: string }
export type ExportTask = {
  id: string
  name: string
  progress: number
  status: TaskStatus
  updatedAt: string
  resumable: boolean
  versionId: string | null
  versionLabel: string
  segments: number
  completedSegments: number[]
  snapshot: { positions: Position[]; proofs: Proof[] } | null
  history: TaskHistoryEntry[]
  invalidReason?: string
  lease?: { tabId: string; at: number }
}
export type VersionSnapshot = {
  id: string | null
  label: string
  status: 'locked' | 'history'
  unlocked?: boolean
  lockedAt: string
  positions: Position[]
  proofs: Proof[]
  pages: Page[]
  sheetSpec: { width: number; height: number; bleed: number; safe: number; gutter: number; binding: string; grain: string }
  approvedProofIds: string[]
}
export type Notice = { type: 'success' | 'warn' | 'error' | 'info'; text: string }

export const sheetSpec = {
  width: 720,
  height: 1020,
  bleed: 3,
  safe: 5,
  gutter: 6,
  binding: '骑马订',
  grain: '纵向',
}

const STORAGE_KEY = 'print-imposition-v2'
const LEGACY_KEY = 'print-imposition-v1'
const LEASE_TTL = 20_000
const SEGMENT_TOTAL = 10

const seedPages: Page[] = [
  { pageNo: 1, name: '封面', width: 210, height: 297, bleed: 3, content: '潮汐来信 / 节目册' },
  { pageNo: 2, name: '版权页', width: 210, height: 297, bleed: 2, content: '版权与演职人员' },
  { pageNo: 3, name: '序言', width: 210, height: 297, bleed: 3, content: '导演手记' },
  { pageNo: 4, name: '剧照跨页左', width: 210, height: 297, bleed: 3, content: '第一幕剧照' },
  { pageNo: 5, name: '剧照跨页右', width: 210, height: 297, bleed: 3, content: '第一幕剧照延伸' },
  { pageNo: 6, name: '曲目表', width: 210, height: 297, bleed: 3, content: '曲目与时长' },
  { pageNo: 7, name: '创作团队', width: 210, height: 297, bleed: 1, content: '主创与制作团队' },
  { pageNo: 8, name: '封底', width: 210, height: 297, bleed: 3, content: '巡演信息' },
]

const seedPositions: Position[] = [
  { id: 'P-01', pageNo: 8, x: 34, y: 44, rotation: 0, front: true },
  { id: 'P-02', pageNo: 1, x: 372, y: 44, rotation: 180, front: true },
  { id: 'P-03', pageNo: 6, x: 34, y: 548, rotation: 180, front: true },
  { id: 'P-04', pageNo: 3, x: 372, y: 548, rotation: 0, front: true },
  { id: 'P-05', pageNo: 2, x: 34, y: 44, rotation: 0, front: false },
  { id: 'P-06', pageNo: 7, x: 372, y: 44, rotation: 180, front: false },
  { id: 'P-07', pageNo: 4, x: 34, y: 548, rotation: 0, front: false },
  { id: 'P-08', pageNo: 5, x: 372, y: 548, rotation: 180, front: false },
]

const seedProofs: Proof[] = [
  { id: 'PRF-01', round: 1, date: '2026-09-18', sample: '数字样张 v1', deltaE: 3.8, feedback: '封面夜空蓝偏紫，剧照暗部层次压缩。', correction: '调整 CMYK 曲线，黑色通道减少 4%。', owner: '周默 / 色彩管理', decision: '退回' },
  { id: 'PRF-02', round: 2, date: '2026-09-25', sample: '数字样张 v2', deltaE: 1.9, feedback: '整体色差改善，P7 出血仍不足。', correction: '重排 P7 版位并增加 2mm 出血。', owner: '林青 / 拼版', decision: '待决定' },
]

const seedVersions: VersionSnapshot[] = [
  {
    id: 'R6',
    label: 'R6',
    status: 'locked',
    lockedAt: '2026-09-25 16:00',
    positions: cloneDeep(seedPositions),
    proofs: cloneDeep(seedProofs),
    pages: cloneDeep(seedPages),
    sheetSpec: { ...sheetSpec },
    approvedProofIds: seedProofs.filter((proof) => proof.decision === '通过').map((proof) => proof.id),
  },
]

const seedTasks: ExportTask[] = [
  {
    id: 'EXP-0925-01',
    name: '印刷交付包 · PDF/X-4',
    progress: 70,
    status: '已中断',
    updatedAt: '09-25 16:42',
    resumable: true,
    versionId: 'R6',
    versionLabel: 'R6',
    segments: SEGMENT_TOTAL,
    completedSegments: [1, 2, 3, 4, 5, 6, 7],
    snapshot: { positions: cloneDeep(seedPositions), proofs: cloneDeep(seedProofs) },
    history: [],
  },
  {
    id: 'EXP-0925-02',
    name: '数字样张低分辨率预览',
    progress: 100,
    status: '已完成',
    updatedAt: '09-25 15:18',
    resumable: false,
    versionId: 'R6',
    versionLabel: 'R6',
    segments: SEGMENT_TOTAL,
    completedSegments: Array.from({ length: SEGMENT_TOTAL }, (_, index) => index + 1),
    snapshot: { positions: cloneDeep(seedPositions), proofs: cloneDeep(seedProofs) },
    history: [],
  },
]

function cloneDeep<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function getTabId(): string {
  let id = sessionStorage.getItem('print-tab-id')
  if (!id) {
    id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    sessionStorage.setItem('print-tab-id', id)
  }
  return id
}

function nowLabel(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function buildLegacyVersions(old: any): VersionSnapshot[] {
  return [
    {
      id: null,
      label: '未锁定草稿（升级前）',
      status: 'history',
      unlocked: true,
      lockedAt: '升级前',
      positions: old.positions ?? cloneDeep(seedPositions),
      proofs: old.proofs ?? cloneDeep(seedProofs),
      pages: old.pages ?? cloneDeep(seedPages),
      sheetSpec: { ...sheetSpec },
      approvedProofIds: [],
    },
  ]
}

function buildLegacyTasks(old: any): ExportTask[] {
  return (old.tasks ?? []).map((task: any) => ({
    id: task.id,
    name: task.name,
    progress: 0,
    status: '待生成' as TaskStatus,
    updatedAt: task.updatedAt,
    resumable: false,
    versionId: null,
    versionLabel: '未锁定草稿（升级前）',
    segments: SEGMENT_TOTAL,
    completedSegments: [],
    snapshot: null,
    history: [
      { versionId: null, versionLabel: '未锁定草稿（升级前）', progress: task.progress, status: task.status, completedAt: task.updatedAt },
    ],
    invalidReason: '旧稿无版本号，不能作为交付依据',
  }))
}

export const useImpositionStore = defineStore('imposition', () => {
  const restoredRaw = localStorage.getItem(STORAGE_KEY)
  const legacyRaw = restoredRaw ? null : localStorage.getItem(LEGACY_KEY)
  const restored = restoredRaw ? JSON.parse(restoredRaw) : null
  const legacy = legacyRaw ? JSON.parse(legacyRaw) : null

  const pages = ref<Page[]>(restored?.pages ?? legacy?.pages ?? cloneDeep(seedPages))
  const positions = ref<Position[]>(restored?.positions ?? legacy?.positions ?? cloneDeep(seedPositions))
  const proofs = ref<Proof[]>(restored?.proofs ?? legacy?.proofs ?? cloneDeep(seedProofs))
  const side = ref<'front' | 'back'>('front')
  const zoom = ref(72)
  const selectedPosition = ref<string | null>(null)
  const selectedProof = ref('PRF-02')

  const versions = ref<VersionSnapshot[]>(
    restored?.versions ?? (legacy ? buildLegacyVersions(legacy) : cloneDeep(seedVersions)),
  )
  const currentVersionId = ref<string | null>(restored?.currentVersionId ?? (legacy ? null : 'R6'))
  const revision = ref(restored?.revision ?? (legacy ? '未锁定' : 'R6'))
  const locked = ref(restored?.locked ?? !legacy)
  const tasks = ref<ExportTask[]>(
    restored?.tasks ?? (legacy ? buildLegacyTasks(legacy) : cloneDeep(seedTasks)),
  )

  const notice = ref<Notice | null>(null)

  const tabId = getTabId()
  const timers = new Map<string, ReturnType<typeof setInterval>>()
  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel('print-imposition')
  } catch {
    channel = null
  }

  const validations = computed<Validation[]>(() => {
    const issues: Validation[] = []
    const placedPages = positions.value.map((position) => position.pageNo)
    pages.value.forEach((page) => {
      if (!placedPages.includes(page.pageNo)) issues.push({ id: `missing-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 尚未拼版`, detail: `${page.name} 未出现在正反版位中。` })
      if (page.bleed < sheetSpec.bleed) issues.push({ id: `bleed-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 出血不足`, detail: `页面出血 ${page.bleed}mm，低于印刷要求 ${sheetSpec.bleed}mm。` })
    })
    for (let index = 0; index < positions.value.length; index += 1) {
      for (let next = index + 1; next < positions.value.length; next += 1) {
        const a = positions.value[index]
        const b = positions.value[next]
        if (a.front === b.front && Math.abs(a.x - b.x) < 320 && Math.abs(a.y - b.y) < 430) {
          issues.push({ id: `overlap-${a.id}-${b.id}`, severity: '错误', pageNo: a.pageNo, title: `${a.id} 与 ${b.id} 版位重叠`, detail: '当前纸张尺寸下页面之间不足安全间隙。' })
        }
      }
    }
    const frontOrder = positions.value.filter((item) => item.front).sort((a, b) => a.x - b.x || a.y - b.y).map((item) => item.pageNo)
    if (frontOrder[0] !== 1) issues.push({ id: 'binding-order', severity: '警告', pageNo: 1, title: '骑马订正版页序需要复核', detail: `当前首位为 P${frontOrder[0]}，装订方向规则期望封面位于首版位。` })
    return issues
  })

  watch([pages, positions, proofs, tasks, versions, currentVersionId, revision, locked], () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        pages: pages.value,
        positions: positions.value,
        proofs: proofs.value,
        tasks: tasks.value,
        versions: versions.value,
        currentVersionId: currentVersionId.value,
        revision: revision.value,
        locked: locked.value,
      }),
    )
  }, { deep: true })

  function pushNotice(type: Notice['type'], text: string) {
    notice.value = { type, text }
  }

  function nextRevision(): string {
    let next = 7
    versions.value.forEach((version) => {
      if (version.id) {
        const number = Number(version.id.slice(1))
        if (Number.isFinite(number) && number >= next) next = number + 1
      }
    })
    return `R${next}`
  }

  function markHistory(versionId: string) {
    versions.value.forEach((version) => {
      if (version.id === versionId && version.status === 'locked') version.status = 'history'
    })
  }

  function stopTimer(taskId: string) {
    const timer = timers.get(taskId)
    if (timer) {
      clearInterval(timer)
      timers.delete(taskId)
    }
  }

  function invalidateTasksForVersion(versionId: string, reason: string) {
    tasks.value.forEach((task) => {
      if (task.versionId === versionId && task.status !== '待生成') {
        if (task.progress > 0 || task.status === '已完成') {
          task.history.push({
            versionId: task.versionId,
            versionLabel: task.versionLabel,
            progress: task.progress,
            status: task.status === '生成中' ? '已中断' : task.status,
            completedAt: task.updatedAt,
          })
        }
        task.status = '待生成'
        task.progress = 0
        task.completedSegments = []
        task.resumable = false
        task.lease = undefined
        task.invalidReason = reason
        stopTimer(task.id)
      }
    })
  }

  function retireCurrentVersion(reason: string) {
    if (!currentVersionId.value) return
    const retiredId = currentVersionId.value
    markHistory(retiredId)
    invalidateTasksForVersion(retiredId, reason)
    currentVersionId.value = null
    locked.value = false
    revision.value = '未锁定'
    channel?.postMessage({ type: 'version-changed' })
  }

  function lockBaseline() {
    const id = nextRevision()
    retireCurrentVersion(`版本已更新为 ${id}，旧任务回到待生成`)
    const snapshot: VersionSnapshot = {
      id,
      label: id,
      status: 'locked',
      lockedAt: nowLabel(),
      positions: cloneDeep(positions.value),
      proofs: cloneDeep(proofs.value),
      pages: cloneDeep(pages.value),
      sheetSpec: { ...sheetSpec },
      approvedProofIds: proofs.value.filter((proof) => proof.decision === '通过').map((proof) => proof.id),
    }
    versions.value.push(snapshot)
    currentVersionId.value = id
    revision.value = id
    locked.value = true
    channel?.postMessage({ type: 'version-changed' })
    pushNotice('success', `已锁定拼版版本 ${id}：版位与打样结论已留存，可作为交付依据`)
  }

  function unlock() {
    if (!currentVersionId.value) return
    retireCurrentVersion('版本已解锁修订，旧任务回到待生成')
    pushNotice('warn', '版本已解锁修订：导出任务回到待生成，重新锁定后按新版本生成')
  }

  function updatePosition(id: string, patch: Partial<Position>) {
    if (locked.value) return
    const position = positions.value.find((item) => item.id === id)
    if (position) Object.assign(position, patch)
  }

  function addPosition(pageNo: number) {
    if (locked.value || positions.value.some((item) => item.pageNo === pageNo && item.front === (side.value === 'front'))) return
    positions.value.push({ id: `P-${Date.now().toString().slice(-3)}`, pageNo, x: 34, y: 44, rotation: 0, front: side.value === 'front' })
  }

  function updateProof(id: string, patch: Partial<Proof>) {
    const proof = proofs.value.find((item) => item.id === id)
    if (!proof) return
    const wasRejected = proof.decision === '退回'
    Object.assign(proof, patch)
    if (!wasRejected && proof.decision === '退回' && currentVersionId.value) {
      retireCurrentVersion('打样退回，锁定版本失效')
      pushNotice('warn', '打样退回：锁定版本失效，导出任务回到待生成')
    }
  }

  function createProof() {
    proofs.value.push({ id: `PRF-${String(proofs.value.length + 1).padStart(2, '0')}`, round: proofs.value.length + 1, date: new Date().toISOString().slice(0, 10), sample: `数字样张 v${proofs.value.length + 1}`, deltaE: 0, feedback: '', correction: '', owner: '当前用户', decision: '待决定' })
  }

  function abortTask(task: ExportTask, reason: string) {
    stopTimer(task.id)
    const target = tasks.value.find((item) => item.id === task.id) ?? task
    if (target.lease && target.lease.tabId !== tabId && Date.now() - target.lease.at < LEASE_TTL) {
      pushNotice('warn', `任务 ${task.id} 已由其他标签页接管，本标签页停止写入分片`)
      return
    }
    target.lease = undefined
    if (target.versionId !== currentVersionId.value) {
      if (target.status !== '待生成' && target.progress > 0) {
        target.history.push({ versionId: target.versionId, versionLabel: target.versionLabel, progress: target.progress, status: '已中断', completedAt: target.updatedAt })
      }
      target.status = '待生成'
      target.progress = 0
      target.completedSegments = []
      target.resumable = false
      target.invalidReason = '版本已变化，请在锁定新版本后重新生成'
    } else {
      target.status = '已中断'
      target.resumable = true
    }
    pushNotice('warn', `任务 ${task.id} 已停止：${reason}`)
  }

  function startSimulation(task: ExportTask, silent = false) {
    stopTimer(task.id)
    task.lease = { tabId, at: Date.now() }
    task.status = '生成中'
    task.updatedAt = nowLabel()
    if (!silent) pushNotice('info', `任务 ${task.id} 按锁定快照续传，已完成 ${task.completedSegments.length}/${task.segments} 分片`)
    channel?.postMessage({ type: 'lease-acquired', taskId: task.id, tabId, versionId: task.versionId })
    const timer = setInterval(() => {
      if (!tasks.value.includes(task) || !timers.has(task.id)) {
        clearInterval(timer)
        return
      }
      if (task.versionId !== currentVersionId.value) {
        abortTask(task, '版本已变化，不能把新分片写入旧任务')
        return
      }
      if (task.lease?.tabId !== tabId) {
        abortTask(task, '任务已被其他标签页接管')
        return
      }
      const nextIndex = task.completedSegments.length
      task.completedSegments.push(nextIndex + 1)
      task.progress = Math.round((task.completedSegments.length / task.segments) * 100)
      task.updatedAt = nowLabel()
      if (task.completedSegments.length >= task.segments) {
        stopTimer(task.id)
        task.status = '已完成'
        task.progress = 100
        task.lease = undefined
        pushNotice('success', `任务 ${task.id} 已完成，交付结果可查看`)
      }
    }, 750)
    timers.set(task.id, timer)
  }

  function resumeTask(id: string): { ok: boolean; error?: string } {
    const task = tasks.value.find((item) => item.id === id)
    if (!task) return { ok: false, error: '任务不存在' }
    if (task.status === '已完成') return { ok: false, error: '任务已完成' }
    if (!task.versionId) return { ok: false, error: '旧稿无版本号，不能作为交付依据' }
    if (task.versionId !== currentVersionId.value) {
      invalidateTasksForVersion(task.versionId, '版本已变化，请在锁定新版本后重新生成')
      return { ok: false, error: '版本已变化，任务回到待生成' }
    }
    if (task.lease && task.lease.tabId !== tabId && Date.now() - task.lease.at < LEASE_TTL) {
      return { ok: false, error: '任务已被其他标签页接管' }
    }
    if (task.status === '生成中' && (!task.lease || task.lease.tabId === tabId)) {
      return { ok: false, error: '任务正在生成中' }
    }
    startSimulation(task)
    return { ok: true }
  }

  function createTask(): { ok: boolean; error?: string } {
    if (!currentVersionId.value) return { ok: false, error: '请先锁定拼版版本，再创建交付包' }
    const version = versions.value.find((item) => item.id === currentVersionId.value)
    if (!version || !version.id) return { ok: false, error: '锁定版本不存在' }
    const task: ExportTask = {
      id: `EXP-${Date.now().toString().slice(-6)}`,
      name: '印刷交付包 · PDF/X-4',
      progress: 0,
      status: '排队中',
      updatedAt: nowLabel(),
      resumable: true,
      versionId: version.id,
      versionLabel: version.label,
      segments: SEGMENT_TOTAL,
      completedSegments: [],
      snapshot: { positions: cloneDeep(version.positions), proofs: cloneDeep(version.proofs) },
      history: [],
    }
    tasks.value.push(task)
    pushNotice('success', `已按版本 ${version.label} 创建交付任务 ${task.id}`)
    return { ok: true }
  }

  function syncFromStorage() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const data = JSON.parse(raw)
    if (Array.isArray(data.pages)) pages.value = data.pages
    if (Array.isArray(data.positions)) positions.value = data.positions
    if (Array.isArray(data.proofs)) proofs.value = data.proofs
    if (Array.isArray(data.tasks)) tasks.value = data.tasks
    if (Array.isArray(data.versions)) versions.value = data.versions
    if (typeof data.currentVersionId !== 'undefined') currentVersionId.value = data.currentVersionId
    if (typeof data.revision === 'string') revision.value = data.revision
    if (typeof data.locked === 'boolean') locked.value = data.locked
  }

  function abortRunning(reason: string) {
    Array.from(timers.keys()).forEach((id) => {
      const task = tasks.value.find((item) => item.id === id)
      if (task) abortTask(task, reason)
    })
  }

  channel?.addEventListener('message', (event) => {
    const data = event.data
    if (data?.type === 'version-changed') {
      syncFromStorage()
      abortRunning('版本已变化，不能把新分片写入旧任务')
    } else if (data?.type === 'lease-acquired') {
      syncFromStorage()
      Array.from(timers.keys()).forEach((id) => {
        const task = tasks.value.find((item) => item.id === id)
        if (task && task.lease?.tabId !== tabId) abortTask(task, '任务已被其他标签页接管')
      })
    }
  })

  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return
    syncFromStorage()
    Array.from(timers.keys()).forEach((id) => {
      const task = tasks.value.find((item) => item.id === id)
      if (!task) {
        stopTimer(id)
        return
      }
      if (task.versionId !== currentVersionId.value) abortTask(task, '版本已变化，不能把新分片写入旧任务')
      else if (task.lease?.tabId !== tabId) abortTask(task, '任务已被其他标签页接管')
    })
  })

  tasks.value.forEach((task) => {
    if (task.status === '生成中' && task.lease?.tabId === tabId) startSimulation(task, true)
  })

  return {
    pages, positions, proofs, tasks, versions, side, zoom, revision, locked,
    selectedPosition, selectedProof, currentVersionId, notice, validations,
    updatePosition, addPosition, updateProof, createProof,
    lockBaseline, unlock, resumeTask, createTask,
  }
})
