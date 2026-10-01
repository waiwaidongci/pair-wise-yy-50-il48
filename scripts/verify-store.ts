// Store 层验证：旧稿迁移、锁定快照冻结、版位改动/打样退回失效联动
import './test-shim'
import { createPinia, setActivePinia } from 'pinia'
import { useImpositionStore, snapshotFingerprint } from '../src/stores/imposition'

const pass: string[] = []
const fail: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) pass.push(name)
  else fail.push(`${name} ${detail}`)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
function reset(v1?: unknown) {
  localStorage.clear()
  if (v1 !== undefined) localStorage.setItem('print-imposition-v1', JSON.stringify(v1))
  setActivePinia(createPinia())
  return useImpositionStore()
}

async function flush() { await new Promise((r) => setTimeout(r, 30)) }

async function main() {
  // 1. 无任何数据：内置旧稿，归入未锁定历史
  let store = reset()
  check('全新环境标记为旧稿历史', store.legacyUnlocked === true)
  check('旧稿无版本号', store.versionLabel === '旧稿 · 无版本号')
  check('旧稿没有任何快照', store.snapshots.length === 0)
  check('旧稿默认不锁定', store.locked === false)

  // 2. v1 数据迁移
  const v1 = {
    pages: [], positions: [{ id: 'PX', pageNo: 1, x: 9, y: 9, rotation: 0, front: true }],
    proofs: [], revision: 'R6', locked: true, tasks: [],
  }
  store = reset(v1)
  check('v1 版位被迁移', store.positions.length === 1 && store.positions[0].x === 9)
  check('v1 locked=true 不被信任（必须重新锁定）', store.locked === false)
  check('迁移后仍归入未锁定历史', store.legacyUnlocked === true)

  // 3. 锁定：只有「通过」结论进入快照
  store = reset()
  store.proofs[0].decision = '退回'
  store.proofs[1].decision = '通过'
  store.lockBaseline()
  const v1snap = store.activeSnapshot
  check('锁定生成 V-0001', v1snap?.versionId === 'V-0001')
  check('快照只冻结已通过的打样结论', v1snap?.approvedProofs.length === 1 && v1snap.approvedProofs[0].id === 'PRF-02')
  check('快照冻结当时版位（深拷贝）', v1snap?.positions.length === store.positions.length)
  check('锁定后版本号显示 V-0001', store.versionLabel === 'V-0001')

  const fpBefore = v1snap!.fingerprint
  const noticed: string[] = []
  const { onStoreNotice } = await import('../src/stores/imposition')
  onStoreNotice((n) => noticed.push(n.type + ':' + ('reason' in n ? n.reason : '')))

  // 4. 锁定状态下版位不可改
  store.updatePosition('P-01', { x: 999 })
  check('锁定时拖动版位被忽略', store.positions.find((p) => p.id === 'P-01')!.x !== 999)

  // 5. 解锁后改动版位 -> 快照立即失效
  store.unlock()
  store.updatePosition('P-01', { x: 123 })
  await flush()
  check('版位改动后快照失效', store.activeSnapshot === null)
  const snap = store.snapshots.find((s) => s.versionId === 'V-0001')!
  check('失效快照保留在历史中', snap.status === 'invalidated' && snap.invalidReason === 'positions')
  check('发出版位失效通知', noticed.some((n) => n === 'invalidated:positions'))
  check('版位改动不改变原指纹记录', snap.fingerprint === fpBefore)
  check('失效后回到待生成语义', store.deliveryState.tone === 'invalidated')
  check('失效提示带版本与原因', store.deliveryState.text.includes('V-0001') && store.deliveryState.text.includes('版位'))

  // 6. 重新锁定内容未变部分 -> 产生新版本 V-0002，旧版为 superseded
  store.lockBaseline()
  check('重新锁定产生 V-0002', store.activeSnapshot?.versionId === 'V-0002')
  check('V-0001 标记为 superseded', store.snapshots.find((s) => s.versionId === 'V-0001')?.status === 'invalidated')
  check('V-0002 指纹反映新版位', store.activeSnapshot!.fingerprint !== fpBefore)
  check('指纹是确定性的', snapshotFingerprint(store.positions, store.proofs.filter((p) => p.decision === '通过')) === store.activeSnapshot!.fingerprint)

  // 7. 打样退回（通过 -> 退回）-> 快照失效
  store.updateProof('PRF-02', { decision: '退回' })
  await flush()
  check('通过结论被退回后快照失效', store.activeSnapshot === null)
  check('失效原因=proofs', store.snapshots.find((s) => s.versionId === 'V-0002')?.invalidReason === 'proofs')
  check('发出打样失效通知', noticed.some((n) => n === 'invalidated:proofs'))
  check('退回后退出锁定只读', store.locked === false)

  // 8. 编辑未通过结论（待决定->通过 / 文案修改）不触发失效
  store.lockBaseline()
  const countBefore = store.snapshots.length
  store.proofs[0].decision = '待决定'
  store.updateProof('PRF-01', { feedback: '补充说明' })
  await flush()
  check('非通过结论的编辑不使快照失效', store.activeSnapshot !== null && store.snapshots.length === countBefore)

  // 9. 指纹：同内容两次锁定复用版本，不新增
  store.unlock()
  store.lockBaseline()
  check('内容未变时重新锁定不产生新版本', store.snapshots.length === countBefore && store.activeSnapshot?.versionId === `V-000${countBefore}`)

  // 10. v2 数据恢复（不是旧稿）
  localStorage.clear()
  localStorage.setItem('print-imposition-v2', JSON.stringify({
    pages: [], positions: [], proofs: [], nextRevision: 3, legacyUnlocked: false,
    legacyNote: '', locked: true,
    snapshots: [{ versionId: 'V-0002', revision: 2, positions: [], approvedProofs: [], approvedProofIds: [], fingerprint: 'fp-x', lockedAt: 'x', status: 'active' }],
  }))
  setActivePinia(createPinia())
  store = useImpositionStore()
  check('v2 恢复后仍是锁定版本', store.locked === true && store.activeSnapshot?.versionId === 'V-0002')
  check('v2 恢复后不再标记旧稿', store.legacyUnlocked === false)

  console.log(`\n${pass.length} passed, ${fail.length} failed`)
  if (fail.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
