export type Page = { pageNo: number; name: string; width: number; height: number; bleed: number; content: string }
export type Position = { id: string; pageNo: number; x: number; y: number; rotation: number; front: boolean }
export type Validation = { id: string; severity: '错误' | '警告'; pageNo?: number; title: string; detail: string }
export type ProofDecision = '待决定' | '通过' | '退回'
export type Proof = { id: string; round: number; date: string; sample: string; deltaE: number; feedback: string; correction: string; owner: string; decision: ProofDecision }

export type InvalidationReason = 'positions' | 'proofs'
export type SnapshotStatus = 'active' | 'invalidated' | 'superseded'

/** 审批锁定时冻结下来的交付依据：当时的版位 + 已通过的打样结论 */
export interface LockedSnapshot {
  versionId: string
  revision: number
  positions: Position[]
  approvedProofs: Proof[]
  approvedProofIds: string[]
  fingerprint: string
  lockedAt: string
  status: SnapshotStatus
  invalidReason?: InvalidationReason
  invalidatedAt?: string
}

export type ShardStatus = '待生成' | '已完成' | '失败'
export interface ExportShard {
  id: string
  pages: number[]
  status: ShardStatus
  hash?: string
  updatedAt?: string
}

export type ExportStatus = '排队中' | '生成中' | '已完成' | '已中断' | '已失效'
export interface Lease {
  clientId: string
  clientLabel: string
  expiresAt: number
}
export interface ExportArtifact {
  hash: string
  url: string
  generatedAt: string
  pages: number
  sizeKb: number
}

export interface ExportSnapshotPayload {
  versionId: string
  revision: number
  positions: Position[]
  approvedProofs: Proof[]
  fingerprint: string
  lockedAt: string
}

export interface ExportTask {
  id: string
  name: string
  progress: number
  status: ExportStatus
  updatedAt: string
  resumable: boolean
  /** 任务绑定的锁定版本；旧稿任务为 null */
  versionId: string | null
  revision: number | null
  snapshot: ExportSnapshotPayload | null
  shards: ExportShard[]
  lease: Lease | null
  artifact: ExportArtifact | null
  /** 只有当前 active 快照的任务可作为交付依据；失效 / 旧稿 / 被取代版本均为 false */
  deliverable: boolean
  /** 升级前的无版本号旧稿，只能历史查看 */
  legacy: boolean
  invalidReasonText?: string
}

export type ApiErrorCode =
  | 'TASK_NOT_FOUND'
  | 'LEGACY_NOT_DELIVERABLE'
  | 'TASK_INVALIDATED'
  | 'VERSION_CHANGED'
  | 'LEASE_HELD'
  | 'TAKEN_OVER'
  | 'NO_ACTIVE_SNAPSHOT'
  | 'NO_RUNNING_SHARD'

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; owner?: string; task?: ExportTask }
}
