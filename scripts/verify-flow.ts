// 端到端逻辑验证：用内存版 localStorage/sessionStorage/window 驱动模拟服务端，
// 覆盖：锁定快照 -> 建任务 -> 分片续传 -> 失败重试 -> 版本不符拦截 -> 双标签接管 -> 失效联动 -> 旧稿
import './test-shim'
import { errorCode, exportApi, getClientId } from '../src/api/exportApi'

const pass: string[] = []
const fail: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) pass.push(name)
  else fail.push(`${name} ${detail}`)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const snap1 = {
  versionId: 'V-0001', revision: 1, fingerprint: 'fp-v1', lockedAt: '10-01 10:00',
  positions: [{ id: 'P-01', pageNo: 1, x: 1, y: 1, rotation: 0, front: true }],
  approvedProofs: [{ id: 'PRF-02', round: 2, date: '2026-09-25', sample: '数字样张 v2', deltaE: 1.9, feedback: '', correction: '', owner: '林青', decision: '通过' as const }],
}

async function main() {
  // 0. 初始：只有旧稿任务，不可续传
  let list = (await exportApi.list()).data
  check('初始有 2 条旧稿任务', list.length === 2)
  check('旧稿任务均 legacy=true', list.every((t) => t.legacy))
  check('旧稿任务 versionId=null', list.every((t) => t.versionId === null))

  // 1. 无锁定版本不能建任务
  let createError: string | undefined
  try { await exportApi.create(undefined as never, '测试包') } catch (e) { createError = errorCode(e) }
  check('无快照创建被拒 NO_ACTIVE_SNAPSHOT', createError === 'NO_ACTIVE_SNAPSHOT', String(createError))

  // 2. 旧稿任务不能续传
  let legacyError: string | undefined
  try { await exportApi.resume('EXP-0925-01', 'V-0001', 'fp-x', '标签页 A') } catch (e) { legacyError = errorCode(e) }
  check('旧稿续传被拒 LEGACY_NOT_DELIVERABLE', legacyError === 'LEGACY_NOT_DELIVERABLE', String(legacyError))

  // 3. 锁定 V-0001，创建任务
  const task1 = (await exportApi.create(snap1, '交付包 V1')).data
  check('新任务绑定 V-0001', task1.versionId === 'V-0001' && task1.snapshot!.fingerprint === 'fp-v1')
  check('新任务 4 个分片、全部待生成', task1.shards.length === 4 && task1.shards.every((s) => s.status === '待生成'))
  check('新任务非 legacy 且 deliverable', !task1.legacy && task1.deliverable)
  check('创建后即由创建方持有租约', task1.lease?.clientId === getClientId())

  // 等待真实 setInterval 里的 tick 推进分片
  await new Promise((r) => setTimeout(r, 1300))
  let running1 = (await exportApi.list()).data.find((t) => t.id === task1.id)!
  check('分片自动推进（>0% 且有已完成分片）', running1.progress > 0 && running1.shards.some((s) => s.status === '已完成'), `progress=${running1.progress}`)

  // 4. 注入分片失败
  await exportApi.simulateFail(task1.id)
  let t1 = (await exportApi.list()).data.find((t) => t.id === task1.id)!
  const failedShard = t1.shards.find((s) => s.status === '失败')!
  check('注入失败后任务中断', t1.status === '已中断' && !!failedShard)
  check('已完成分片保留', t1.shards.some((s) => s.status === '已完成'))
  const doneCount = t1.shards.filter((s) => s.status === '已完成').length

  // 5. 续传：从失败分片继续，已完成分片复用
  const resumed = (await exportApi.resume(task1.id, 'V-0001', 'fp-v1', '标签页 A')).data as typeof t1 & { resumedFromShard?: string }
  check('续传从失败分片开始', resumed.resumedFromShard === failedShard.id, String(resumed.resumedFromShard))
  check('失败分片被重置为待生成', resumed.shards.find((s) => s.id === failedShard.id)!.status === '待生成')
  check('已完成分片数不减少', resumed.shards.filter((s) => s.status === '已完成').length === doneCount)

  await new Promise((r) => setTimeout(r, 1600))
  t1 = (await exportApi.list()).data.find((t) => t.id === task1.id)!
  check('续传后跑完且产物已生成', t1.status === '已完成' && t1.progress === 100 && !!t1.artifact, `status=${t1.status} progress=${t1.progress}`)

  // 6. 第二个任务，版本不符拦截
  const snap2 = { ...snap1, versionId: 'V-0002', revision: 2, fingerprint: 'fp-v2' }
  const task2 = (await exportApi.create(snap2, '交付包 V2')).data
  await new Promise((r) => setTimeout(r, 300))
  await exportApi.simulateFail(task2.id)

  let wrongVersionError: string | undefined
  try { await exportApi.resume(task2.id, 'V-0003', 'fp-v3', '标签页 B') } catch (e) { wrongVersionError = errorCode(e) }
  check('版本号不符续传被拒 VERSION_CHANGED', wrongVersionError === 'VERSION_CHANGED', String(wrongVersionError))

  let wrongFpError: string | undefined
  try { await exportApi.resume(task2.id, 'V-0002', 'fp-changed', '标签页 B') } catch (e) { wrongFpError = errorCode(e) }
  check('指纹不符续传被拒 VERSION_CHANGED', wrongFpError === 'VERSION_CHANGED', String(wrongFpError))

  // 7. 双标签租约：A 先续传，B 普通续传被拒；B 强制接管
  sessionStorage.setItem('print-imposition-client-id', 'client-aaaaaa')
  await exportApi.resume(task2.id, 'V-0002', 'fp-v2', '标签页 A')
  sessionStorage.setItem('print-imposition-client-id', 'client-bbbbbb')
  let leaseError: string | undefined
  try { await exportApi.resume(task2.id, 'V-0002', 'fp-v2', '标签页 B') } catch (e) { leaseError = errorCode(e) }
  check('租约被占时 B 普通续传被拒 LEASE_HELD', leaseError === 'LEASE_HELD', String(leaseError))
  const taken = (await exportApi.resume(task2.id, 'V-0002', 'fp-v2', '标签页 B', true)).data
  check('B 强制接管成功，租约归属 B', taken.lease!.clientId === 'client-bbbbbb')
  sessionStorage.setItem('print-imposition-client-id', 'client-aaaaaa')
  let takenOverError: string | undefined
  try { await exportApi.heartbeat(task2.id, 'V-0002') } catch (e) { takenOverError = errorCode(e) }
  check('原持有方 A 心跳收到 TAKEN_OVER', takenOverError === 'TAKEN_OVER', String(takenOverError))

  // 8. 失效联动：版位改动 -> 生成中任务立即失效
  await exportApi.invalidateSnapshot('V-0002', 'positions')
  const invalidated = (await exportApi.list()).data.find((t) => t.id === task2.id)!
  check('V-0002 任务立即失效（不可续传、不可交付）', invalidated.status === '已失效' && !invalidated.resumable && !invalidated.deliverable)
  check('失效原因=版位改动', invalidated.invalidReasonText!.includes('版位'))
  const v1Done = (await exportApi.list()).data.find((t) => t.id === task1.id)!
  check('其他版本任务不受影响，V1 产物保留', v1Done.status === '已完成' && !!v1Done.artifact)
  let resumeInvalidError: string | undefined
  try { await exportApi.resume(task2.id, 'V-0002', 'fp-v2', 'B') } catch (e) { resumeInvalidError = errorCode(e) }
  check('失效任务不能续传 TASK_INVALIDATED', resumeInvalidError === 'TASK_INVALIDATED', String(resumeInvalidError))

  // 9. 打样退回：已完成任务转历史，产物保留（全新任务 4 分片，每 500ms 完成 1 片，需 ~2s）
  const task3 = (await exportApi.create({ ...snap2, versionId: 'V-0003', revision: 3, fingerprint: 'fp-v3' }, '交付包 V3')).data
  await new Promise((r) => setTimeout(r, 2300))
  let t3 = (await exportApi.list()).data.find((t) => t.id === task3.id)!
  check('V3 任务跑完已完成', t3.status === '已完成' && !!t3.artifact)
  await exportApi.invalidateSnapshot('V-0003', 'proofs')
  t3 = (await exportApi.list()).data.find((t) => t.id === task3.id)!
  check('打样退回：已完成产物转历史但保留', t3.status === '已失效' && !!t3.artifact && !t3.deliverable && t3.invalidReasonText!.includes('打样'))

  // 10. 旧稿不被失效联动波及
  list = (await exportApi.list()).data
  check('旧稿任务仍为 2 条且保持 legacy', list.filter((t) => t.legacy).length === 2)

  console.log(`\n${pass.length} passed, ${fail.length} failed`)
  if (fail.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
