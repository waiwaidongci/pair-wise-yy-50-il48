// 一键运行端到端验证：esbuild 打包两个 TS 验证脚本后用 Node 执行
const path = require('node:path')
const esbuild = require('esbuild')

const entries = [
  ['scripts/verify-flow.ts', 'scripts/.verify-flow.cjs'],
  ['scripts/verify-store.ts', 'scripts/.verify-store.cjs'],
]

async function main() {
  for (const [entry, outfile] of entries) {
    await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'warning' })
  }
  const { spawnSync } = require('node:child_process')
  for (const file of entries.map(([, out]) => out)) {
    console.log(`\n=== ${file} ===`)
    const result = spawnSync(process.execPath, [path.join(process.cwd(), file)], { stdio: 'inherit' })
    if (result.status !== 0) process.exitCode = 1
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
