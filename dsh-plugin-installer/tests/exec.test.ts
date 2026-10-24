import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  resolveManagerExecutable,
  formatCommand,
  spawnArgsOf,
  tailLines,
  runNpmCommand,
  execToErrorLike,
  type ManagerExecutable
} from '../src/core/exec.js'

/** DSH 自带运行时的 pnpm 入口是否存在（决定若干用例是否可跑）。 */
function dshRuntimePnpmExists(): boolean {
  const home = process.env.DSH_HOME
  if (home === undefined || home.length === 0) return false
  return existsSync(join(home.replace(/[\\/]$/, ''), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
}

const runtimeAvailable = dshRuntimePnpmExists()

describe('包管理器可执行项解析', () => {
  it.runIf(runtimeAvailable)('pnpm 优先解析为「node 执行 DSH 运行时的 pnpm.mjs」', () => {
    const entry = resolveManagerExecutable('pnpm')
    expect(entry.executable.toLowerCase()).toContain('node')
    expect(entry.preArgs).toHaveLength(1)
    expect(entry.preArgs[0]?.replace(/\\/g, '/')).toMatch(/pnpm\/bin\/pnpm\.mjs$/)
    expect(entry.display).toContain('pnpm.mjs')
  })

  it('npm 解析结果绝不能指向 pnpm.mjs（回归：曾在 pnpm 目录里复用 npm 候选）', () => {
    const entry = resolveManagerExecutable('npm')
    for (const arg of entry.preArgs) {
      expect(arg).not.toMatch(/pnpm\.mjs$/)
    }
    expect(entry.display.toLowerCase()).toContain('npm')
  })

  it('解析结果是可直接 spawn 的结构', () => {
    for (const manager of ['pnpm', 'npm'] as const) {
      const entry = resolveManagerExecutable(manager)
      expect(entry.executable.length).toBeGreaterThan(0)
      expect(typeof entry.display).toBe('string')
    }
  })
})

describe('命令格式化与输出截取', () => {
  it('formatCommand 拼接显示串', () => {
    const entry: ManagerExecutable = { executable: 'node', preArgs: ['pnpm.mjs'], display: 'node pnpm.mjs' }
    expect(formatCommand(entry, ['add', 'dsh-x'])).toBe('node pnpm.mjs add dsh-x')
  })

  it('spawnArgsOf 把前置参数放在最前', () => {
    const entry: ManagerExecutable = { executable: 'node', preArgs: ['pnpm.mjs'], display: 'node pnpm.mjs' }
    expect(spawnArgsOf(entry, ['--version'])).toEqual(['pnpm.mjs', '--version'])
  })

  it('tailLines 去除 ANSI 颜色码', () => {
    const out = tailLines('\u001b[31merror: boom\u001b[0m')
    expect(out).toBe('error: boom')
    expect(out).not.toContain('[31m')
  })

  it('tailLines 只保留末尾若干行', () => {
    const out = tailLines(['a', 'b', 'c', 'd'].join('\n'), 2)
    expect(out).toBe('c\nd')
  })

  it('tailLines 按字符上限截断', () => {
    const out = tailLines('x'.repeat(500), 40, 100)
    expect(out.length).toBeLessThanOrEqual(100)
  })
})

describe('真实子进程执行（pnpm --version）', () => {
  it.runIf(runtimeAvailable)('成功执行并采集 stdout', async () => {
    const result = await runNpmCommand(
      { manager: 'pnpm', cwd: tmpdir(), args: ['--version'] },
      { timeoutMs: 60_000 }
    )
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect(result.command).toContain('pnpm')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it.runIf(runtimeAvailable)('超时后 kill 子进程并标记 timedOut', async () => {
    const result = await runNpmCommand(
      { manager: 'pnpm', cwd: tmpdir(), args: ['--version'] },
      { timeoutMs: 1 }
    )
    expect(result.timedOut).toBe(true)
  }, 30_000)

  it('execToErrorLike 归一化为 error 风格结构', async () => {
    const result = await runNpmCommand({ manager: 'pnpm', cwd: tmpdir(), args: ['--version'] }, { timeoutMs: 60_000 })
    const errorLike = execToErrorLike(result)
    expect(errorLike.code).toBe(result.code)
    expect(errorLike.timedOut).toBe(result.timedOut)
    expect(typeof errorLike.message).toBe('string')
    expect(errorLike.stdout).toBe(result.stdout)
  })
})
