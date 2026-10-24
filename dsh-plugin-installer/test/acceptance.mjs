/**
 * 验收测试：把一个真实 DSH 插件从官方源全自动装进临时 profile，并做可用性自检。
 *
 * 运行方式：node test/acceptance.mjs [包名]（默认 dsh-plugin）
 *
 * 与 e2e 不同，这里要求全链路成功：registry 探测 → pnpm 安装 → 自检通过。
 * 需要网络；安装目标是系统临时目录，不触碰真实 profile。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const libDir = join(projectRoot, 'lib')

const targetPackage = process.argv[2] ?? 'dsh-plugin'

function fail(message) {
  console.error(`❌ 验收测试失败：${message}`)
  process.exit(1)
}

async function main() {
  if (!existsSync(join(libDir, 'index.js'))) {
    fail('未找到 lib/ 构建产物，请先运行 npm run build')
  }

  const { installPlugin, readInstalledVersion } = await import(pathToFileURL(join(libDir, 'core', 'installer.js')).href)
  const { resolveConfig } = await import(pathToFileURL(join(libDir, 'core', 'config.js')).href)

  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-installer-acceptance-'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'acceptance-profile', version: '0.0.0', private: true }))

  try {
    const config = resolveConfig()
    const run = await installPlugin({
      spec: targetPackage,
      packageName: targetPackage,
      profileDir,
      config
    })

    console.log(
      `— ok=${String(run.ok)} manager=${run.manager} registry=${run.registry} attempts=${run.attempts.length} version=${String(run.installedVersion)}`
    )

    if (!run.ok) {
      for (const d of run.diagnoses) console.error(`  [${d.code}] ${d.title}：${d.detail}`)
      fail(`安装 ${targetPackage} 未成功`)
    }
    if (run.attempts.length === 0) fail('未产生任何安装尝试')
    if (run.installedVersion === undefined) fail('未能读到已安装版本')
    if (!run.selfCheck.ok) fail(`可用性自检未通过：${run.selfCheck.summary}`)
    if (!existsSync(join(profileDir, 'node_modules', ...targetPackage.split('/'), 'package.json'))) {
      fail('node_modules 中未找到已安装插件')
    }
    const diskVersion = await readInstalledVersion(profileDir, targetPackage)
    if (diskVersion !== run.installedVersion) fail(`版本读取不一致：${diskVersion} vs ${run.installedVersion}`)

    const passed = run.selfCheck.checks.filter((c) => c.ok).length
    console.log(`✅ 验收测试通过：${targetPackage}@${run.installedVersion} 全自动安装成功，自检 ${passed}/${run.selfCheck.checks.length}。`)
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('❌ 验收测试失败：', error)
  process.exit(1)
})
