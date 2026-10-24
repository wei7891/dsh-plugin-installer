import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { inspectProfileReadiness, runSelfCheck, readInstalledVersion, installPlugin } from '../src/core/installer.js'
import { resolveConfig } from '../src/core/config.js'

/** 所有临时目录集中登记，测试结束后统一清理。 */
const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-installer-test-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
  }
})

describe('profile 环境就绪检查', () => {
  it('目录不存在时报告缺少 package.json', async () => {
    const missing = await inspectProfileReadiness(join(tmpdir(), 'definitely-not-exists-dsh-x'))
    expect(missing.length).toBeGreaterThan(0)
    expect(missing[0]).toContain('package.json')
  })

  it('合法 package.json 视为就绪', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake-profile', private: true }))
    expect(await inspectProfileReadiness(dir)).toEqual([])
  })

  it('非法 JSON 报出中文原因', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'package.json'), '{ 这不是合法 JSON')
    const missing = await inspectProfileReadiness(dir)
    expect(missing.some((m) => m.includes('不是合法 JSON'))).toBe(true)
  })
})

describe('安装后可用性自检', () => {
  it('未安装时报出缺失的模块目录', async () => {
    const dir = makeTempDir()
    const report = await runSelfCheck({ packageName: 'dsh-not-installed', profileDir: dir })
    expect(report.ok).toBe(false)
    expect(report.checks.some((c) => c.name === '模块目录存在性' && !c.ok)).toBe(true)
  })

  it('伪造已安装模块全部检查通过', async () => {
    const dir = makeTempDir()
    const moduleDir = join(dir, 'node_modules', 'dsh-fake')
    mkdirSync(join(moduleDir, 'lib'), { recursive: true })
    writeFileSync(
      join(moduleDir, 'package.json'),
      JSON.stringify({ name: 'dsh-fake', version: '1.2.3', main: 'lib/index.js' })
    )
    writeFileSync(join(moduleDir, 'lib', 'index.js'), 'module.exports = {}\n')

    const report = await runSelfCheck({ packageName: 'dsh-fake', profileDir: dir })
    expect(report.ok).toBe(true)
    expect(report.summary).toContain('自检通过')
    expect(report.checks.every((c) => c.ok)).toBe(true)
  })

  it('用户显式钉版本时要求严格一致', async () => {
    const dir = makeTempDir()
    const moduleDir = join(dir, 'node_modules', 'dsh-fake')
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ name: 'dsh-fake', version: '1.2.3' }))

    const report = await runSelfCheck({
      packageName: 'dsh-fake',
      profileDir: dir,
      expectedVersion: '9.9.9',
      requireExactVersion: true
    })
    expect(report.ok).toBe(false)
    const versionCheck = report.checks.find((c) => c.name === '版本匹配')
    expect(versionCheck?.ok).toBe(false)
    expect(versionCheck?.detail).toContain('期望 9.9.9')
  })

  it('未钉版本时允许包管理器选择语义范围内的版本', async () => {
    const dir = makeTempDir()
    const moduleDir = join(dir, 'node_modules', 'dsh-fake')
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ name: 'dsh-fake', version: '1.2.3' }))

    // latest 标签是 1.6.5，但 pnpm 合理地装了稳定版 1.2.3 —— 不应判为失败
    const report = await runSelfCheck({
      packageName: 'dsh-fake',
      profileDir: dir,
      expectedVersion: '1.6.5',
      requireExactVersion: false
    })
    expect(report.ok).toBe(true)
    expect(report.checks.find((c) => c.name === '版本匹配')?.ok).toBe(true)
  })

  it('readInstalledVersion 读取真实版本 / 缺失时返回 undefined', async () => {
    const dir = makeTempDir()
    const moduleDir = join(dir, 'node_modules', 'dsh-fake')
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ name: 'dsh-fake', version: '2.0.1' }))

    expect(await readInstalledVersion(dir, 'dsh-fake')).toBe('2.0.1')
    expect(await readInstalledVersion(dir, 'dsh-missing')).toBeUndefined()
  })
})

describe('安装编排器入口校验', () => {
  it('profile 不具备条件时直接返回中文诊断且不发起安装', async () => {
    const dir = makeTempDir() // 空目录：没有 package.json
    const run = await installPlugin({
      spec: 'dsh-fake',
      packageName: 'dsh-fake',
      profileDir: dir,
      config: resolveConfig()
    })
    expect(run.ok).toBe(false)
    expect(run.attempts).toHaveLength(0)
    expect(run.diagnoses[0]?.code).toBe('E_PROFILE_UNREADY')
    expect(run.diagnoses[0]?.title).toContain('profile')
    expect(run.selfCheck.ok).toBe(false)
  })
})
