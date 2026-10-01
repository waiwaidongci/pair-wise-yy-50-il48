import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  ExportTask,
  InvalidationReason,
  LockedSnapshot,
  Page,
  Position,
  Proof,
  ProofDecision,
  Validation,
} from '../types'
import { exportApi } from '../api/exportApi'

export type { ExportTask, InvalidationReason, LockedSnapshot, Page, Position, Proof, Validation }

const DRAFT_KEY = 'print-imposition-v2'
const LEGACY_V1_KEY = 'print-imposition-v1'
const LOCK_CHANNEL = 'print-imposition-locks'

export const sheetSpec = {
  width: 720,
  height: 1020,
  bleed: 3,
  safe: 5,
  gutter: 6,
  binding: '骑马订',
  grain: '纵向',
}

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

/* ------------------------- 旧稿迁移（无版本号） ------------------------- */

interface DraftStateV2 {
  pages: Page[]
  positions: Position[]
  proofs: Proof[]
  nextRevision: number
  legacyUnlocked: boolean
  legacyNote: string
  snapshots: LockedSnapshot[]
  locked: boolean
}

function migrate(): DraftStateV2 {
  const v2 = localStorage.getItem(DRAFT_KEY)
  if (v2) return JSON.parse(v2) as DraftStateV2
  const v1 = localStorage.getItem(LEGACY_V1_KEY)
  if (v1) {
    const old = JSON.parse(v1) as { pages?: Page[]; positions?: Position[]; proofs?: Proof[] }
    // 旧稿没有版本号：升级后归入未锁定历史，保留内容供查看，但不能作为交付依据
    const migrated: DraftStateV2 = {
      pages: old.pages ?? structuredClone(seedPages),
      positions: old.positions ?? structuredClone(seedPositions),
      proofs: old.proofs ?? structuredClone(seedProofs),
      nextRevision: 1,
      legacyUnlocked: true,
      legacyNote: '升级前的未编号旧稿，已归入未锁定历史，不能作为交付依据',
      snapshots: [],
      locked: false,
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(migrated))
    return migrated
  }
  // 全新环境：内置一套同样的“升级前旧稿”演示数据
  const fresh: DraftStateV2 = {
    pages: structuredClone(seedPages),
    positions: structuredClone(seedPositions),
    proofs: structuredClone(seedProofs),
    nextRevision: 1,
    legacyUnlocked: true,
    legacyNote: '升级前的未编号旧稿，已归入未锁定历史，不能作为交付依据',
    snapshots: [],
    locked: false,
  }
  localStorage.setItem(DRAFT_KEY, JSON.stringify(fresh))
  return fresh
}

/* ----------------------------- 指纹工具 ------------------------------- */

function clone<T>(value: T): T {
  // 不用 structuredClone：positions/proofs 是 Vue 深层响应式 Proxy，部分环境会拒绝克隆
  return JSON.parse(JSON.stringify(value)) as T
}

function stablePositions(positions: Position[]) {
  return positions
    .map((p) => ({ id: p.id, pageNo: p.pageNo, x: p.x, y: p.y, rotation: p.rotation, front: p.front }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function stableProofs(proofs: Proof[]) {
  return proofs
    .map((p) => ({ id: p.id, round: p.round, decision: p.decision, deltaE: p.deltaE, sample: p.sample, date: p.date }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function snapshotFingerprint(positions: Position[], approvedProofs: Proof[]) {
  const raw = JSON.stringify({ positions: stablePositions(positions), proofs: stableProofs(approvedProofs) })
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0
  }
  return `fp-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function nowText() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ------------------------------ 事件总线 ------------------------------ */

export type StoreNotice =
  | { type: 'invalidated'; reason: InvalidationReason; versionId: string; external: boolean }
  | { type: 'locked'; versionId: string; external: boolean }
  | { type: 'legacy'; message: string }

type NoticeListener = (notice: StoreNotice) => void

const lockChannel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(LOCK_CHANNEL) : null
// Node 测试环境下不阻止进程退出
;(lockChannel as unknown as { unref?: () => void } | null)?.unref?.()
const noticeListeners = new Set<NoticeListener>()

export function onStoreNotice(fn: NoticeListener) {
  noticeListeners.add(fn)
  return () => noticeListeners.delete(fn)
}

function emitNotice(notice: StoreNotice) {
  noticeListeners.forEach((fn) => fn(notice))
}

export const useImpositionStore = defineStore('imposition', () => {
  const initial = migrate()
  const pages = ref<Page[]>(initial.pages)
  const positions = ref<Position[]>(initial.positions)
  const proofs = ref<Proof[]>(initial.proofs)
  const nextRevision = ref(initial.nextRevision)
  const legacyUnlocked = ref(initial.legacyUnlocked)
  const legacyNote = ref(initial.legacyNote)
  const snapshots = ref<LockedSnapshot[]>(initial.snapshots)

  const tasks = ref<ExportTask[]>([])
  const side = ref<'front' | 'back'>('front')
  const zoom = ref(72)
  const locked = ref(initial.locked)
  const selectedPosition = ref<string | null>(null)
  const selectedProof = ref(initial.proofs.at(-1)?.id ?? 'PRF-02')

  const activeSnapshot = computed<LockedSnapshot | null>(() => snapshots.value.find((s) => s.status === 'active') ?? null)
  const lockedSnapshot = computed<LockedSnapshot | null>(() => (locked.value ? activeSnapshot.value : null))

  const versionLabel = computed(() => {
    if (legacyUnlocked.value && !activeSnapshot.value) return '旧稿 · 无版本号'
    if (activeSnapshot.value) return `V-${String(activeSnapshot.value.revision).padStart(4, '0')}`
    return '未锁定草稿'
  })

  const lastInvalidSnapshot = computed<LockedSnapshot | null>(
    () => snapshots.value.filter((s) => s.status === 'invalidated').slice(-1)[0] ?? null,
  )

  const deliveryState = computed(() => {
    const snap = activeSnapshot.value
    if (!snap) {
      if (lastInvalidSnapshot.value) {
        const what = lastInvalidSnapshot.value.invalidReason === 'positions' ? '版位改动' : '打样退回'
        return { tone: 'invalidated' as const, text: `版本 ${lastInvalidSnapshot.value.versionId} 已因${what}失效，旧任务仅作历史；重新锁定后交付包待生成` }
      }
      return legacyUnlocked.value
        ? { tone: 'legacy' as const, text: '旧稿无版本号，仅供历史查看，请修订后重新审批锁定' }
        : { tone: 'draft' as const, text: '当前为未锁定草稿，审批锁定后才能生成交付包' }
    }
    const active = tasks.value.find((t) => t.versionId === snap.versionId && t.deliverable)
    if (active?.status === '已完成') return { tone: 'delivered' as const, text: '交付包已生成并通过哈希校验' }
    if (active?.status === '生成中') return { tone: 'running' as const, text: `交付包生成中（${active.progress}%），中断后按锁定快照续传` }
    if (active?.status === '排队中') return { tone: 'running' as const, text: '交付包排队中' }
    if (active?.status === '已中断') return { tone: 'paused' as const, text: '导出中断，可从已完成分片续传' }
    return { tone: 'pending' as const, text: '版本已锁定，交付包待生成' }
  })

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

  watch(
    [pages, positions, proofs, nextRevision, legacyUnlocked, legacyNote, snapshots, locked],
    () => {
      const draft: DraftStateV2 = {
        pages: pages.value,
        positions: positions.value,
        proofs: proofs.value,
        nextRevision: nextRevision.value,
        legacyUnlocked: legacyUnlocked.value,
        legacyNote: legacyNote.value,
        snapshots: snapshots.value,
        locked: locked.value,
      }
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    },
    { deep: true },
  )

  /* ---------------------- 服务端任务镜像（仅展示用） ---------------------- */

  async function refreshTasks() {
    tasks.value = (await exportApi.list()).data
  }

  /* ------------------------- 锁定快照 / 失效联动 ------------------------- */

  /** 让 active 快照失效：旧导出任务立即回到“待生成”语义，已产出结果仅作历史 */
  function invalidateActive(reason: InvalidationReason, external = false) {
    const snap = activeSnapshot.value
    if (!snap) return
    snap.status = 'invalidated'
    snap.invalidReason = reason
    snap.invalidatedAt = nowText()
    locked.value = false
    // 通知“服务端”：所有绑定该版本的任务立即失效（含生成中、已中断、已完成的产物转历史）
    exportApi.invalidateSnapshot(snap.versionId, reason).catch(() => {})
    lockChannel?.postMessage({ type: 'invalidated', versionId: snap.versionId, reason })
    emitNotice({ type: 'invalidated', reason, versionId: snap.versionId, external })
    refreshTasks().catch(() => {})
  }

  function lockBaseline() {
    const approvedProofs = proofs.value.filter((p) => p.decision === '通过')
    const positionsCopy = clone(positions.value)
    const fingerprint = snapshotFingerprint(positionsCopy, approvedProofs)

    // 内容与当前 active 快照一致时直接重新进入锁定，不产生新版本
    if (activeSnapshot.value && activeSnapshot.value.fingerprint === fingerprint) {
      locked.value = true
      legacyUnlocked.value = false
      emitNotice({ type: 'locked', versionId: activeSnapshot.value.versionId, external: false })
      return
    }

    snapshots.value.forEach((s) => {
      if (s.status === 'active') s.status = 'superseded'
    })
    const revision = nextRevision.value
    nextRevision.value = revision + 1
    const snapshot: LockedSnapshot = {
      versionId: `V-${String(revision).padStart(4, '0')}`,
      revision,
      positions: positionsCopy,
      approvedProofs: clone(approvedProofs),
      approvedProofIds: approvedProofs.map((p) => p.id),
      fingerprint,
      lockedAt: nowText(),
      status: 'active',
    }
    snapshots.value.push(snapshot)
    legacyUnlocked.value = false
    locked.value = true
    lockChannel?.postMessage({ type: 'locked', versionId: snapshot.versionId, fingerprint })
    emitNotice({ type: 'locked', versionId: snapshot.versionId, external: false })
  }

  function unlock() {
    // 仅解除只读；不改版位，快照仍然有效
    locked.value = false
  }

  function updatePosition(id: string, patch: Partial<Position>) {
    if (locked.value) return
    const position = positions.value.find((item) => item.id === id)
    if (!position) return
    const before = JSON.stringify(stablePositions(positions.value))
    Object.assign(position, patch)
    const after = JSON.stringify(stablePositions(positions.value))
    if (before !== after && activeSnapshot.value) {
      invalidateActive('positions')
    }
  }

  function addPosition(pageNo: number) {
    if (locked.value || positions.value.some((item) => item.pageNo === pageNo && item.front === (side.value === 'front'))) return
    positions.value.push({ id: `P-${Date.now().toString().slice(-3)}`, pageNo, x: 34, y: 44, rotation: 0, front: side.value === 'front' })
    if (activeSnapshot.value) invalidateActive('positions')
  }

  function updateProof(id: string, patch: Partial<Proof>) {
    const proof = proofs.value.find((item) => item.id === id)
    if (!proof) return
    const wasApproved = proof.decision === '通过'
    Object.assign(proof, patch)
    // 打样结论被退回（或由通过改为其他）→ 锁定快照立即失效
    if (activeSnapshot.value && wasApproved && proof.decision !== '通过') {
      invalidateActive('proofs')
    }
  }

  function createProof() {
    proofs.value.push({
      id: `PRF-${String(proofs.value.length + 1).padStart(2, '0')}`,
      round: proofs.value.length + 1,
      date: new Date().toISOString().slice(0, 10),
      sample: `数字样张 v${proofs.value.length + 1}`,
      deltaE: 0,
      feedback: '',
      correction: '',
      owner: '当前用户',
      decision: '待决定',
    })
    selectedProof.value = proofs.value.at(-1)!.id
  }

  /* ----------------------- 跨标签页锁定/失效事件 ------------------------ */

  // 其他标签页写入 DRAFT_KEY 时合并最新草稿/快照（storage 事件不会在本页触发）
  window.addEventListener('storage', (event) => {
    if (event.key !== DRAFT_KEY || !event.newValue) return
    const next = JSON.parse(event.newValue) as DraftStateV2
    const prevActiveId = activeSnapshot.value?.versionId
    const prevActiveStatus = activeSnapshot.value?.status
    pages.value = next.pages
    positions.value = next.positions
    proofs.value = next.proofs
    nextRevision.value = next.nextRevision
    legacyUnlocked.value = next.legacyUnlocked
    legacyNote.value = next.legacyNote
    snapshots.value = next.snapshots
    locked.value = next.locked

    const nowSnap = activeSnapshot.value
    if (nowSnap && nowSnap.versionId !== prevActiveId) {
      // 另一个标签页锁定了新版本：本页即“版本已变化”的一方
      locked.value = false
      emitNotice({ type: 'locked', versionId: nowSnap.versionId, external: true })
    } else if (nowSnap && prevActiveStatus === 'active' && nowSnap.status !== 'active') {
      emitNotice({ type: 'invalidated', reason: nowSnap.invalidReason ?? 'positions', versionId: nowSnap.versionId, external: true })
    } else if (!nowSnap && prevActiveId) {
      locked.value = false
    }
    refreshTasks().catch(() => {})
  })

  lockChannel?.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; versionId?: string; reason?: InvalidationReason; fingerprint?: string }
    if (!data?.type) return
    if (data.type === 'invalidated' && data.versionId) {
      const snap = snapshots.value.find((s) => s.versionId === data.versionId && s.status === 'active')
      if (snap && data.reason) {
        snap.status = 'invalidated'
        snap.invalidReason = data.reason
        snap.invalidatedAt = nowText()
        locked.value = false
        emitNotice({ type: 'invalidated', reason: data.reason, versionId: data.versionId, external: true })
        refreshTasks().catch(() => {})
      }
    }
    if (data.type === 'locked' && data.versionId && !snapshots.value.some((s) => s.versionId === data.versionId)) {
      // 另一个标签页锁定了这里没有的版本：本页草稿视为过期，提示版本已变化，不允许把修改写进旧版本
      locked.value = false
      emitNotice({ type: 'locked', versionId: data.versionId, external: true })
    }
  })

  return {
    pages,
    positions,
    proofs,
    tasks,
    snapshots,
    side,
    zoom,
    locked,
    legacyUnlocked,
    legacyNote,
    selectedPosition,
    selectedProof,
    validations,
    activeSnapshot,
    lockedSnapshot,
    lastInvalidSnapshot,
    versionLabel,
    deliveryState,
    refreshTasks,
    updatePosition,
    addPosition,
    updateProof,
    createProof,
    lockBaseline,
    unlock,
  }
})

export type { ProofDecision }
