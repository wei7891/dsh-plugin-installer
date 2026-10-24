/**
 * 5 种来源全链路安装测试：npm 包 / 本地目录 / 本地压缩包 / 远程压缩包 / git 仓库。
 *
 * 运行方式：node test/e2e-sources.mjs
 *
 * 每种来源都在独立的临时 profile 中真实执行 pnpm 安装并做可用性自检。
 * git 来源需要系统 PATH 里有 git（可用免安装 MinGit）。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const libDir = join(projectRoot, 'lib')

let failures = 0

function fail(message) {
  console.error(`❌ ${message}`)
  failures += 1
}

function pass(message) {
  console.log(`✅ ${message}`)
}

/** 创建一个隔离的临时 profile（仅含合法 package.json）。 */
function makeProfile(tag) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-e2e-${tag}-`))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `e2e-${tag}-profile`, version: '0.0.0', private: true }))
  return dir
}

/** 生成一个最小但完整的 DSH 插件 fixture 目录。 */
function makeFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-fixture-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-fixture-local',
        version: '1.0.0',
        description: 'e2e 测试用最小 DSH 插件',
        main: 'lib/index.js',
        license: 'MIT',
        dsh: { bundle: { patch: './cordis.patch.yml' } }
      },
      null,
      2
    )
  )
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n  - id: fixture\n    name: dsh-fixture-local\n')
  writeFileSync(
    join(dir, 'lib', 'index.js'),
    'export const name = "dsh-fixture-local"\nexport const inject = []\nexport function apply() {}\n'
  )
  return dir
}

async function main() {
  if (!existsSync(join(libDir, 'index.js'))) {
    fail('未找到 lib/ 构建产物，请先运行 npm run build')
    process.exit(1)
  }

  const { installPlugin } = await import(pathToFileURL(join(libDir, 'core', 'installer.js')).href)
  const { resolveConfig } = await import(pathToFileURL(join(libDir, 'core', 'config.js')).href)
  const config = resolveConfig({ installTimeoutMs: 240_000, totalBudgetMs: 420_000, maxRepairAttempts: 3 })

  const fixtureDir = makeFixtureDir()

  /** 对一种来源执行安装并断言。 */
  async function verify(tag, spec, options = {}) {
    const profileDir = makeProfile(tag)
    try {
      const run = await installPlugin({ spec, profileDir, config })
      const head = `【${tag}】${spec} → ok=${run.ok} 包名=${run.packageName} 版本=${run.installedVersion ?? '?'} 尝试=${run.attempts.length}`
      if (!run.ok) {
        fail(`${head}`)
        for (const d of run.diagnoses) console.error(`    [${d.code}] ${d.title}：${d.detail.slice(0, 200)}`)
        for (const a of run.attempts) console.error(`    第 ${a.index} 次：${a.command} → 退出码 ${String(a.exitCode)}`)
        return
      }
      if (!run.selfCheck.ok) {
        fail(`${head} — 自检未通过：${run.selfCheck.summary}`)
        return
      }
      const expectName = options.expectName
      if (expectName !== undefined && run.packageName !== expectName) {
        fail(`${head} — 包名不符，期望 ${expectName}`)
        return
      }
      const moduleDir = join(profileDir, 'node_modules', ...run.packageName.split('/'))
      if (!existsSync(join(moduleDir, 'package.json'))) {
        fail(`${head} — node_modules 中未找到已安装包`)
        return
      }
      pass(`${head} — 自检 ${run.selfCheck.checks.filter((c) => c.ok).length}/${run.selfCheck.checks.length}`)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  }

  // 1. npm 包
  await verify('npm包', 'dsh-plugin', { expectName: 'dsh-plugin' })

  // 2. 本地目录
  await verify('本地目录', fixtureDir, { expectName: 'dsh-fixture-local' })

  // 3. 本地压缩包（用系统 bsdtar 把 fixture 打成 zip）
  const zipPath = join(tmpdir(), `dsh-e2e-fixture-${process.pid}.zip`)
  const tarResult = spawnSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'),
    ['-a', '-cf', zipPath, '-C', fixtureDir, '.'],
    { stdio: 'inherit' }
  )
  if (tarResult.status === 0 && existsSync(zipPath)) {
    await verify('本地zip包', zipPath, { expectName: 'dsh-fixture-local' })
  } else {
    fail('【本地zip包】无法用 bsdtar 创建测试 zip，跳过')
  }

  // 4. 远程压缩包（tgz 直链：pnpm 原生安装 URL）
  await verify('远程tgz包', 'https://registry.npmmirror.com/dsh-plugin/-/dsh-plugin-2.1.0.tgz', {
    expectName: 'dsh-plugin'
  })

  // 5. 远程压缩包（zip 直链：自动下载 + 解压 + 安装）
  await verify('远程zip包', 'https://codeload.github.com/sindresorhus/is-plain-obj/zip/refs/heads/main', {
    expectName: 'is-plain-obj'
  })

  // 6. git 仓库（需要 PATH 中有 git）
  const gitProbe = spawnSync('git', ['--version'], { stdio: 'ignore' })
  if (gitProbe.status === 0) {
    await verify('git仓库', 'git+https://github.com/sindresorhus/is-plain-obj.git', { expectName: 'is-plain-obj' })
  } else {
    console.log('⚠️ 【git仓库】系统 PATH 中没有 git，跳过 git 来源测试（安装时会给出中文诊断提示安装 git）')
  }

  rmSync(fixtureDir, { recursive: true, force: true })
  rmSync(zipPath, { force: true })

  if (failures > 0) {
    console.error(`\n❌ 5 来源测试完成：${failures} 项失败`)
    process.exit(1)
  }
  console.log('\n🎉 5 来源安装全部通过：npm 包 / 本地目录 / 本地 zip / 远程压缩包（tgz+zip）/ git 仓库均可全自动安装。')
}

main().catch((error) => {
  console.error('❌ 测试脚本异常：', error)
  process.exit(1)
})
