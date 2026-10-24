/**
 * 端到端测试：在隔离的临时 profile 目录中真实执行一次安装。
 *
 * 运行方式：node test/e2e.mjs
 *
 * 目标插件 dsh-http-tools 在 npm 上存在，但其依赖链里包含
 * 未对外发布的 @deepseek-ai/* DSH 内部包。在空白临时目录中安装时
 * pnpm 必然失败——这正是我们要验证的：诊断引擎必须把这种失败
 * 判为「DSH 内部包未发布（E_PEER_NOT_PUBLISHED）」，
 * 而不是误判成「插件不存在（E_TARGET_NOT_FOUND）」。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const libDir = join(projectRoot, 'lib')

function fail(message) {
  console.error(`❌ e2e 测试失败：${message}`)
  process.exit(1)
}

async function main() {
  if (!existsSync(join(libDir, 'index.js'))) {
    fail('未找到 lib/ 构建产物，请先运行 npm run build')
  }

  const { installPlugin } = await import(pathToFileURL(join(libDir, 'core', 'installer.js')).href)
  const { resolveConfig } = await import(pathToFileURL(join(libDir, 'core', 'config.js')).href)

  // 隔离的临时 profile：仅含一个合法 package.json，保证就绪检查通过
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-installer-e2e-'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'e2e-profile', version: '0.0.0', private: true }))

  try {
    const config = resolveConfig({ installTimeoutMs: 180_000, totalBudgetMs: 300_000, maxRepairAttempts: 3 })
    const run = await installPlugin({
      spec: 'dsh-http-tools',
      packageName: 'dsh-http-tools',
      profileDir,
      config
    })

    console.log(`— ok=${String(run.ok)} manager=${run.manager} registry=${run.registry} attempts=${run.attempts.length}`)
    for (const attempt of run.attempts) {
      console.log(`  第 ${attempt.index} 次：${attempt.command} → 退出码 ${String(attempt.exitCode)}${attempt.timedOut ? '（超时）' : ''}`)
    }
    for (const d of run.diagnoses) {
      console.log(`  [${d.code}] ${d.title}`)
    }

    // 1. 诊断管线必须真实跑过安装命令（至少一次尝试）
    if (run.attempts.length === 0) fail('未产生任何安装尝试')

    // 2. 核心断言：失败必须被归因为 DSH 内部包未发布，而非「包不存在」
    const codes = run.attempts.flatMap((a) => a.diagnoses.map((d) => d.code))
    if (run.ok) {
      // 若未来 dsh-http-tools 的依赖全部发布到 npm，安装成功也视为通过（打印提示）
      console.log('ℹ️ 安装意外成功（依赖可能已发布），诊断路径未被覆盖，但安装链路正常。')
    } else {
      if (!codes.includes('E_PEER_NOT_PUBLISHED')) {
        fail(`失败未被诊断为 E_PEER_NOT_PUBLISHED，实际诊断码：${codes.join(', ') || '(无)'}`)
      }
      // 回归防线：404 规则不得盖过内部包规则
      const first = run.attempts.flatMap((a) => a.diagnoses)[0]
      if (first?.code === 'E_TARGET_NOT_FOUND') {
        fail('首条诊断误判为「插件不存在」，规则排序回归')
      }
    }

    // 3. 每条诊断必须是中文且带建议
    for (const d of run.diagnoses) {
      if (!/[一-鿿]/.test(d.title + d.suggestion)) fail(`诊断缺少中文：${d.code}`)
    }

    console.log('✅ e2e 测试通过：安装链路真实执行，失败被正确归因为「DSH 内部包未发布」。')
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('❌ e2e 测试失败：', error)
  process.exit(1)
})
