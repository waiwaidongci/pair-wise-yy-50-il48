import axios, { AxiosError, type AxiosAdapter } from 'axios'
import type {
  ApiErrorBody,
  ApiErrorCode,
  ExportArtifact,
  ExportShard,
  ExportSnapshotPayload,
  ExportTask,
  InvalidationReason,
  Lease,
  LockedSnapshot,
} from '../types'

/* ------------------------------------------------------------------ */
/* 模拟服务端：localStorage 持久化 + BroadcastChannel 跨标签页          */
/* 单机原型里“服务端”和“浏览器”同处一个进程，                         */
/* localStorage/channel 即承担了跨标签页的共享存储与会话协调。          */
/* ------------------------------------------------------------------ */

const STORE_KEY = 'print-imposition-server-v1'
const CHANNEL = 'print-imposition-server'
const CLIENT_KEY = 'print-imposition-client-id'
const LEASE_MS = 4000
const TICK_MS = 500
const SHARD_PAGES = 2

export interface ServerState {
  tasks: ExportTask[]
  version: number
}

function nowText() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function getClientId(): string {
  let id = sessionStorage.getItem(CLIENT_KEY)
  if (!id) {
    id = `client-${Math.random().toString(36).slice(2, 8)}`
    sessionStorage.setItem(CLIENT_KEY, id)
  }
  return id
}

export function currentClientLabel(): string {
  return `标签页 ${getClientId().slice(-4).toUpperCase()}`
}

/* ----------------------- 初始旧稿种子（无版本号） ----------------------- */

function legacyShards(done: number, failed = false): ExportShard[] {
  const shards: ExportShard[] = []
  for (let i = 0; i < 4; i += 1) {
    const pages = [i * SHARD_PAGES + 1, i * SHARD_PAGES + 2]
    if (i < done) {
      shards.push({ id: `S${i + 1}`, pages, status: '已完成', hash: `h:legacy-${i + 1}`, updatedAt: '09-25 15:02' })
    } else if (failed && i === done) {
      shards.push({ id: `S${i + 1}`, pages, status: '失败', updatedAt: '09-25 16:42' })
    } else {
      shards.push({ id: `S${i + 1}`, pages, status: '待生成' })
    }
  }
  return shards
}

function seedState(): ServerState {
  return {
    version: 1,
    tasks: [
      {
        id: 'EXP-0925-01',
        name: '印刷交付包 · PDF/X-4（升级前旧稿）',
        progress: 75,
        status: '已中断',
        updatedAt: '09-25 16:42',
        resumable: false,
        versionId: null,
        revision: null,
        snapshot: null,
        shards: legacyShards(3, true),
        lease: null,
        artifact: null,
        deliverable: false,
        legacy: true,
      },
      {
        id: 'EXP-0925-02',
        name: '数字样张低分辨率预览（升级前旧稿）',
        progress: 100,
        status: '已完成',
        updatedAt: '09-25 15:18',
        resumable: false,
        versionId: null,
        revision: null,
        snapshot: null,
        shards: legacyShards(4),
        lease: null,
        artifact: { hash: 'sha256:legacy-9f31', url: 'mock://deliveries/legacy-preview.zip', generatedAt: '09-25 15:18', pages: 8, sizeKb: 2480 },
        deliverable: false,
        legacy: true,
      },
    ],
  }
}

function loadState(): ServerState {
  const raw = localStorage.getItem(STORE_KEY)
  if (raw) {
    try {
      return JSON.parse(raw) as ServerState
    } catch {
      // 落到重新播种
    }
  }
  const seeded = seedState()
  localStorage.setItem(STORE_KEY, JSON.stringify(seeded))
  return seeded
}

let state = loadState()

function saveState() {
  state.version += 1
  localStorage.setItem(STORE_KEY, JSON.stringify(state))
  channel.postMessage({ type: 'state', version: state.version, clientId: getClientId() })
}

const channel: { postMessage: (m: unknown) => void; addEventListener: (t: 'message', h: (e: MessageEvent) => void) => void; unref?: () => void } =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CHANNEL)
    : { postMessage: () => {}, addEventListener: () => {} }
// Node 下避免测试进程被频道保活；浏览器无 unref
channel.unref?.()

channel.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; version?: number; clientId?: string; taskId?: string; by?: string }
  if (data?.type === 'state' && typeof data.version === 'number') {
    // 总是以存储中的最新数据为准（单一事实来源），然后由查询层重新拉取
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const next = JSON.parse(raw) as ServerState
      if (next.version >= state.version) state = next
      notifyListeners()
    }
  }
  if (data?.type === 'lease-taken' && data.taskId) {
    takeoverListeners.forEach((fn) => fn({ taskId: data.taskId!, by: data.by ?? '另一个标签页' }))
  }
})

window.addEventListener('storage', (event) => {
  if (event.key === STORE_KEY && event.newValue) {
    state = JSON.parse(event.newValue) as ServerState
    notifyListeners()
  }
})

const listeners = new Set<() => void>()
function notifyListeners() {
  listeners.forEach((fn) => fn())
}
export function onServerChange(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export interface LeaseTakenEvent { taskId: string; by: string }
const takeoverListeners = new Set<(event: LeaseTakenEvent) => void>()
export function onLeaseTaken(fn: (event: LeaseTakenEvent) => void) {
  takeoverListeners.add(fn)
  return () => takeoverListeners.delete(fn)
}

/* ------------------------------- 工具 -------------------------------- */

function buildShards(): ExportShard[] {
  const count = Math.ceil(8 / SHARD_PAGES)
  return Array.from({ length: count }, (_, i) => ({
    id: `S${i + 1}`,
    pages: [i * SHARD_PAGES + 1, Math.min((i + 1) * SHARD_PAGES, 8)],
    status: '待生成' as const,
  }))
}

function recalcProgress(task: ExportTask) {
  const done = task.shards.filter((s) => s.status === '已完成').length
  task.progress = Math.round((done / task.shards.length) * 100)
}

function leaseActive(task: ExportTask): boolean {
  return !!task.lease && task.lease.expiresAt > Date.now()
}

function releaseIfExpired(task: ExportTask) {
  if (task.status === '生成中' && task.lease && task.lease.expiresAt <= Date.now()) {
    task.lease = null
    task.status = '已中断'
    task.resumable = true
    task.updatedAt = nowText()
  }
}

function apiError(code: ApiErrorCode, message: string, task?: ExportTask, owner?: string): AxiosError {
  const body: ApiErrorBody = { error: { code, message, task: task ? structuredClone(task) : undefined, owner } }
  return new AxiosError(message, code, undefined, null, {
    data: body,
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: {} as never,
  } as never)
}

function ok(data: unknown) {
  return { data, status: 200, statusText: 'OK', headers: {}, config: {} as never }
}

function findTask(id: string | undefined): ExportTask | undefined {
  state.tasks.forEach(releaseIfExpired)
  return state.tasks.find((t) => t.id === id)
}

function invalidateById(versionId: string, reason: InvalidationReason) {
  const reasonText = reason === 'positions' ? '锁定后版位发生改动' : '已通过的打样被退回'
  let changed = false
  for (const task of state.tasks) {
    if (task.versionId === versionId && task.status !== '已失效') {
      // 进行中/排队/中断立即失效；已完成的产物保留（artifact、分片不动），仅转为历史查看
      task.status = '已失效'
      task.resumable = false
      task.deliverable = false
      task.lease = null
      task.invalidReasonText = task.artifact ? `${reasonText}，成品仅作历史查看` : reasonText
      task.updatedAt = nowText()
      changed = true
    }
  }
  if (changed) saveState()
}

/* --------------------------- 分片生成循环 ---------------------------- */

function tick() {
  let changed = false
  for (const task of state.tasks) {
    if (task.status === '生成中' && task.lease && task.lease.expiresAt <= Date.now()) {
      task.lease = null
      task.status = '已中断'
      task.resumable = true
      task.updatedAt = nowText()
      changed = true
      continue
    }
    if (task.status !== '生成中' || !leaseActive(task)) continue
    const target = task.shards.find((s) => s.status !== '已完成')
    if (!target) {
      task.status = '已完成'
      task.progress = 100
      task.resumable = false
      task.lease = null
      task.artifact = {
        hash: `sha256:${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`,
        url: `mock://deliveries/${task.id}.zip`,
        generatedAt: nowText(),
        pages: 8,
        sizeKb: 12_000 + Math.floor(Math.random() * 4000),
      }
      task.updatedAt = nowText()
      changed = true
      continue
    }
    if (target.status === '待生成') {
      // 模拟一个分片在本 tick 内跑完；失败分片不会自动重跑，等待 resume
      target.status = '已完成'
      target.hash = `h:${task.id}-${target.id}-${Math.random().toString(16).slice(2, 8)}`
      target.updatedAt = nowText()
      recalcProgress(task)
      task.updatedAt = nowText()
      changed = true
    }
  }
  if (changed) saveState()
}

if (typeof window !== 'undefined') {
  const timer = setInterval(tick, TICK_MS)
  // 不阻止 Node 测试进程退出；浏览器中无 unref 也无副作用
  ;(timer as { unref?: () => void }).unref?.()
}

/* ------------------------------- 路由 -------------------------------- */

const adapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => setTimeout(resolve, 90))
  const method = config.method
  const url = config.url ?? ''

  if (url === '/api/print/export-tasks' && method === 'get') {
    state.tasks.forEach(releaseIfExpired)
    return ok(structuredClone(state.tasks))
  }

  if (url === '/api/print/export-tasks' && method === 'post') {
    const payload = (config.data ? JSON.parse(config.data) : {}) as { snapshot: ExportSnapshotPayload; name?: string }
    const snap = payload.snapshot
    if (!snap?.versionId) throw apiError('NO_ACTIVE_SNAPSHOT', '当前没有已审批锁定的版本，无法生成交付包')
    const task: ExportTask = {
      id: `EXP-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 90 + 10)}`,
      name: payload.name ?? '印刷交付包 · PDF/X-4',
      progress: 0,
      status: '生成中',
      updatedAt: nowText(),
      resumable: true,
      versionId: snap.versionId,
      revision: snap.revision,
      snapshot: structuredClone(snap),
      shards: buildShards(),
      lease: { clientId: getClientId(), clientLabel: currentClientLabel(), expiresAt: Date.now() + LEASE_MS },
      artifact: null,
      deliverable: true,
      legacy: false,
    }
    state.tasks.unshift(task)
    saveState()
    return ok(structuredClone(task))
  }

  const resumeMatch = url.match(/^\/api\/print\/export-tasks\/([^/]+)\/resume$/)
  if (resumeMatch && method === 'post') {
    const id = resumeMatch[1]
    const body = (config.data ? JSON.parse(config.data) : {}) as { versionId?: string; fingerprint?: string; clientLabel?: string; force?: boolean }
    const task = findTask(id)
    if (!task) throw apiError('TASK_NOT_FOUND', '导出任务不存在或已被清理')
    if (task.legacy) throw apiError('LEGACY_NOT_DELIVERABLE', '升级前的旧稿没有版本号，不能续传，请对审批锁定的新版本重新生成', task)
    if (task.status === '已失效') throw apiError('TASK_INVALIDATED', task.invalidReasonText ?? '该任务已随旧版本失效', task)
    if (body.versionId !== task.versionId) {
      throw apiError('VERSION_CHANGED', `锁定版本已变化（任务绑定 ${task.snapshot?.versionId}），新分片不能写入旧任务，请对当前版本重新生成`, task)
    }
    if (body.fingerprint && task.snapshot && body.fingerprint !== task.snapshot.fingerprint) {
      throw apiError('VERSION_CHANGED', '锁定快照指纹与任务不一致（版位或通过结论已变），不能把新分片写进旧任务', task)
    }
    if (!body.force && leaseActive(task) && task.lease!.clientId !== getClientId()) {
      throw apiError('LEASE_HELD', `任务正由「${task.lease!.clientLabel}」续传，只有一个标签页可以接管`, task, task.lease!.clientLabel)
    }
    const previousOwner = leaseActive(task) && task.lease!.clientId !== getClientId() ? task.lease!.clientLabel : undefined
    // 接管或首次续传：从第一个未完成分片开始；失败分片重置后重跑，已完成分片直接复用
    const resumeFrom = task.shards.find((s) => s.status !== '已完成')
    task.shards.forEach((s) => {
      if (s.status === '失败') {
        s.status = '待生成'
        s.hash = undefined
        s.updatedAt = undefined
      }
    })
    task.status = '生成中'
    task.resumable = true
    task.updatedAt = nowText()
    task.lease = { clientId: getClientId(), clientLabel: body.clientLabel || currentClientLabel(), expiresAt: Date.now() + LEASE_MS }
    saveState()
    if (previousOwner) {
      // 抢占成功：立刻通过频道通知原持有方，它的下一次心跳也会收到 TAKEN_OVER
      channel.postMessage({ type: 'lease-taken', taskId: task.id, from: previousOwner, by: task.lease.clientLabel })
    }
    const refreshed = structuredClone(task)
    ;(refreshed as ExportTask & { resumedFromShard?: string }).resumedFromShard = resumeFrom?.id
    return ok(refreshed)
  }

  const heartbeatMatch = url.match(/^\/api\/print\/export-tasks\/([^/]+)\/heartbeat$/)
  if (heartbeatMatch && method === 'post') {
    const id = heartbeatMatch[1]
    const body = (config.data ? JSON.parse(config.data) : {}) as { versionId?: string }
    const task = findTask(id)
    if (!task) throw apiError('TASK_NOT_FOUND', '导出任务不存在')
    if (task.status === '已失效') throw apiError('TASK_INVALIDATED', task.invalidReasonText ?? '该任务已随旧版本失效', task)
    if (body.versionId !== task.versionId) throw apiError('VERSION_CHANGED', '锁定版本已变化，不能把新分片写进旧任务', task)
    if (task.lease && task.lease.clientId !== getClientId()) {
      throw apiError('TAKEN_OVER', `任务已被「${task.lease.clientLabel}」接管，本页停止续传`, task, task.lease.clientLabel)
    }
    if (task.status === '生成中' && task.lease) {
      task.lease.expiresAt = Date.now() + LEASE_MS
      saveState()
    }
    return ok(structuredClone(task))
  }

  const failMatch = url.match(/^\/api\/print\/export-tasks\/([^/]+)\/simulate-fail$/)
  if (failMatch && method === 'post') {
    const task = findTask(failMatch[1])
    if (!task) throw apiError('TASK_NOT_FOUND', '导出任务不存在')
    if (task.legacy) throw apiError('LEGACY_NOT_DELIVERABLE', '旧稿任务只作历史查看', task)
    if (task.status !== '生成中') throw apiError('NO_RUNNING_SHARD', '只有生成中的任务可以注入分片失败', task)
    const target = task.shards.find((s) => s.status !== '已完成')
    if (!target) throw apiError('NO_RUNNING_SHARD', '所有分片均已完成', task)
    target.status = '失败'
    target.updatedAt = nowText()
    task.status = '已中断'
    task.resumable = true
    task.lease = null
    task.updatedAt = nowText()
    saveState()
    return ok(structuredClone(task))
  }

  const invalidateMatch = url.match(/^\/api\/print\/snapshots\/([^/]+)\/invalidate$/)
  if (invalidateMatch && method === 'post') {
    const versionId = invalidateMatch[1]
    const body = (config.data ? JSON.parse(config.data) : {}) as { reason?: InvalidationReason }
    invalidateById(versionId, body.reason ?? 'positions')
    return ok({ versionId, invalidated: true })
  }

  return { data: null, status: 404, statusText: 'Not Found', headers: {}, config: {} as never }
}

const client = axios.create({ adapter })

export function errorCode(err: unknown): ApiErrorCode | undefined {
  return (err as AxiosError<ApiErrorBody>)?.response?.data?.error?.code
}
export function errorMessage(err: unknown): string {
  return (err as AxiosError<ApiErrorBody>)?.response?.data?.error?.message ?? '操作失败，请重试'
}
export function errorTask(err: unknown): ExportTask | undefined {
  return (err as AxiosError<ApiErrorBody>)?.response?.data?.error?.task
}
export { getClientId }

export const exportApi = {
  list: () => client.get<ExportTask[]>('/api/print/export-tasks'),
  create: (snapshot: ExportSnapshotPayload, name?: string) =>
    client.post<ExportTask>('/api/print/export-tasks', JSON.stringify({ snapshot, name })),
  resume: (id: string, versionId: string, fingerprint: string, label: string, force = false) =>
    client.post<ExportTask>(`/api/print/export-tasks/${id}/resume`, JSON.stringify({ versionId, fingerprint, clientLabel: label, force })),
  heartbeat: (id: string, versionId: string) =>
    client.post<ExportTask>(`/api/print/export-tasks/${id}/heartbeat`, JSON.stringify({ versionId })),
  simulateFail: (id: string) => client.post<ExportTask>(`/api/print/export-tasks/${id}/simulate-fail`),
  invalidateSnapshot: (versionId: string, reason: InvalidationReason) =>
    client.post(`/api/print/snapshots/${versionId}/invalidate`, JSON.stringify({ reason })),
}

export type { LockedSnapshot, Lease }
