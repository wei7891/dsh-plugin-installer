/**
 * npm / pnpm 子进程执行封装。
 *
 * 设计要点（对应需求中的「自动执行 npm 相关命令」与「全局捕获执行报错」）：
 *  - 使用 node:child_process.spawn，参数按数组传递、绝不使用 shell，
 *    因此包名里的空格 / 引号 / 分号都无法越权成命令注入；
 *  - stdout / stderr 通过「临时文件重定向」采集，而不是默认的 pipe。
 *    这一点是 DSH 运行环境的硬约束：DSH 沙箱禁用了命名管道，
 *    spawn 使用 stdio: 'pipe' 会直接抛 EPERM。改为把子进程的
 *    fd 1 / fd 2 指到临时文件（stdio 数组形式），退出后再读回内容，
 *    既绕开了管道限制，又能把输出喂给中文诊断器；
 *  - Windows 下 pnpm / npm 往往不是独立可执行文件，需要显式解析（见下）；
 *  - 每次执行都记录完整命令行，供后续修复重放与日志审计。
 */

import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, closeSync, unlinkSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExecResult } from './types.js'

/** 包管理器可执行类型。 */
export type PackageManager = 'pnpm' | 'npm'

/** 执行一项 npm 命令所需的完整参数。 */
export interface NpmCommandSpec {
  /** 使用的包管理器 */
  manager: PackageManager
  /** 目标目录（profile 根目录），命令在此目录下执行 */
  cwd: string
  /** npm 参数，例如 ['add', 'dsh-http-tools'] */
  args: string[]
  /** registry 覆盖地址 */
  registry?: string
  /** 追加在末尾的自定义参数（例如 --legacy-peer-deps） */
  extraArgs?: string[]
  /** 需要注入的环境变量 */
  env?: Record<string, string>
}

/** 一条中文执行前/后日志（供上层汇总）。 */
export interface ExecLog {
  command: string
  cwd: string
  durationMs: number
  exitCode: number | null
  stdoutTail: string
  stderrTail: string
}

/**
 * 解析出的包管理器可执行项。
 *
 * Node 平台下 npm / pnpm 往往不是独立的可执行文件：
 *  - npm 在 Node 安装目录下是 npm.cmd（Windows）或 npm 壳脚本（POSIX）；
 *  - pnpm 在 DSH 运行时里是一个 .mjs 入口（bin/pnpm.mjs），必须交给
 *    node 加上该路径才能执行。
 * 因此这里用「可执行文件 + 前置参数」二元组表达，而不是单个可执行路径。
 */
export interface ManagerExecutable {
  /** 真正要被 spawn 的可执行文件（Windows 下为 node.exe / npm.cmd 等） */
  executable: string
  /** 放在 npm 参数之前的固定前置参数（例如 node 执行 pnpm.mjs 的路径） */
  preArgs: string[]
  /** 人类可读的命令标识，用于日志与回放 */
  display: string
}

/** Windows 下的包管理器候选文件名。 */
const WINDOWS_CANDIDATES: Record<PackageManager, string[]> = {
  pnpm: ['pnpm.cmd', 'pnpm.exe', 'pnpm'],
  npm: ['npm.cmd', 'npm.exe', 'npm']
}

/** POSIX 下的包管理器候选文件名。 */
const POSIX_CANDIDATES: Record<PackageManager, string[]> = {
  pnpm: ['pnpm'],
  npm: ['npm']
}

/** DSH 自带运行时的目录布局。 */
function dshRuntimeRoot(): string | undefined {
  const home = process.env.DSH_HOME
  if (home === undefined || home.length === 0) return undefined
  return join(home.replace(/[\\/]$/, ''), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies')
}

/** 在 PATH 的各个目录里按候选项查找第一个存在的可执行文件。 */
function findOnPath(candidates: string[]): string | undefined {
  const pathValue = process.env.PATH ?? ''
  const searchDirs = pathValue.split(delimiter).filter((dir) => dir.length > 0)
  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

/**
 * 解析包管理器的可执行项。
 *
 * 解析顺序（每步都可能命中）：
 *  1. 优先使用 DSH 自带运行时（本进程就在其中运行，版本确定可靠）：
 *     - pnpm：runtime/pnpm/bin/pnpm.mjs，由 node 执行；
 *     - npm：runtime/node 下的 npm-cli.js，由 node 执行；
 *  2. PATH 中查找原生可执行文件（Windows 下 pnpm.cmd / npm.cmd）；
 *  3. 兜底：返回裸名字符串，交给 PATH 行为决定能否执行（失败时给出中文诊断）。
 *
 * 为什么把 DSH 运行时放在 PATH 之前：在 DSH 沙箱内 spawn 一个 .cmd 会
 * 触发 EINVAL（需要 cmd.exe 上下文），而「node 执行 .mjs / .js」始终可用。
 * 同时 DSH 自带运行时与当前 DSH 版本严格配套，避免用户 PATH 里的旧版
 * pnpm / npm 造成行为差异。
 *
 * 注意：DSH 分发的 Node 运行时不包含 npm，只带 pnpm。因此 npm 会从前两步
 * 逐一降级，最终落到「用 node 执行 npm-cli.js」；若运行时里确实没有 npm，
 * 则由安装编排器在诊断出 E_MANAGER_NOT_FOUND 后切换到 pnpm 完成安装。
 *
 * 注释约定：本文件注释中不写块注释终止符与星号斜杠的组合，避免提前闭合。
 */
export function resolveManagerExecutable(manager: PackageManager): ManagerExecutable {
  const isWindows = process.platform === 'win32'
  const candidates = isWindows ? WINDOWS_CANDIDATES[manager] : POSIX_CANDIDATES[manager]
  const nodeExeName = isWindows ? 'node.exe' : 'node'

  // 1) DSH 自带运行时（优先）
  const runtimeRoot = dshRuntimeRoot()
  if (runtimeRoot !== undefined) {
    const runtimeNodeBin = join(runtimeRoot, 'node', 'bin')
    const runtimeNodeExe = join(runtimeNodeBin, nodeExeName)
    const nodeRunner = existsSync(runtimeNodeExe) ? runtimeNodeExe : findOnPath([nodeExeName])

    if (manager === 'pnpm') {
      const pnpmMjs = join(runtimeRoot, 'pnpm', 'bin', 'pnpm.mjs')
      if (existsSync(pnpmMjs) && nodeRunner !== undefined) {
        return { executable: nodeRunner, preArgs: [pnpmMjs], display: `node ${pnpmMjs}` }
      }
    } else if (nodeRunner !== undefined) {
      // npm：在 DSH Node 运行时里逐级查找 npm-cli.js（不同发行版布局不一致）
      const npmCliCandidates = [
        join(runtimeNodeBin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(runtimeRoot, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(runtimeRoot, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      ]
      const npmCli = npmCliCandidates.find((path) => existsSync(path))
      if (npmCli !== undefined) {
        return { executable: nodeRunner, preArgs: [npmCli], display: `node ${npmCli}` }
      }
    }
  }

  // 2) PATH 中的原生可执行文件
  const onPath = findOnPath(candidates)
  if (onPath !== undefined) {
    return { executable: onPath, preArgs: [], display: onPath }
  }

  // 3) 兜底：裸名（失败时由诊断规则给出中文说明）
  const fallback = candidates[0] ?? manager
  return { executable: fallback, preArgs: [], display: fallback }
}

/**
 * 把可执行项与参数拼成可读命令串（用于日志与回放）。
 *
 * @param entry 解析出的包管理器可执行项（含可能的前置参数）
 * @param args  npm/pnpm 自身的参数
 */
export function formatCommand(entry: ManagerExecutable, args: string[]): string {
  return [entry.display, ...args].join(' ')
}

/** 实际交给 spawn 的完整参数数组（前置参数 + npm 参数）。 */
export function spawnArgsOf(entry: ManagerExecutable, args: string[]): string[] {
  return [...entry.preArgs, ...args]
}

/** 截取输出尾部，保留最有诊断价值的若干行。 */
export function tailLines(text: string, maxLines = 40, maxChars = 4000): string {
  // 去掉 ANSI 颜色码，避免中文输出里混入不可见字符
  const stripped = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  const lines = stripped.split(/\r?\n/)
  const slice = lines.slice(-maxLines).join('\n')
  if (slice.length <= maxChars) return slice
  return slice.slice(-maxChars)
}

/** 合并环境变量。 */
function mergeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  if (extra === undefined) return process.env
  return { ...process.env, ...extra }
}

/** 生成一个临时文件路径（不创建文件本身，交由 openSync 创建）。 */
function tempOutputPath(tag: string): string {
  const unique = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  return join(tmpdir(), `dsh-installer-${tag}-${unique}.log`)
}

/** 安全读取临时文件内容；文件不存在或读取失败都返回空串。 */
function readTempFile(path: string): string {
  try {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 尽力删除临时文件，失败不影响主流程。 */
function removeTempFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // 忽略：临时文件残留不会影响安装语义
  }
}

/**
 * 执行一条 npm/pnpm 命令。
 *
 * 输出采集方式：把子进程的 stdout / stderr 重定向到两个临时文件
 * （stdio 数组形式 ['ignore', fdOut, fdErr]），进程退出后再读回文件内容。
 * 这样绕开了 DSH 沙箱禁用命名管道导致的 stdio 管道 EPERM。
 *
 * @param spec    命令规格
 * @param options 超时（毫秒）；超时后 kill 子进程并标记 timedOut
 */
export async function runNpmCommand(
  spec: NpmCommandSpec,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const managerEntry = resolveManagerExecutable(spec.manager)
  const npmArgs = [...spec.args, ...(spec.extraArgs ?? [])]
  if (spec.registry !== undefined && spec.registry.length > 0) {
    // pnpm 与 npm 都支持 --registry=<url>
    npmArgs.push(`--registry=${spec.registry}`)
  }
  // spawn 的真实参数 = 前置参数（如 node 执行 pnpm.mjs 的路径）+ npm 自身参数
  const args = spawnArgsOf(managerEntry, npmArgs)
  const command = formatCommand(managerEntry, npmArgs)

  const startedAt = performance.now()
  const stdoutPath = tempOutputPath('stdout')
  const stderrPath = tempOutputPath('stderr')
  let stdoutFd: number | undefined
  let stderrFd: number | undefined

  try {
    stdoutFd = openSync(stdoutPath, 'w')
    stderrFd = openSync(stderrPath, 'w')
  } catch (error) {
    if (stdoutFd !== undefined) closeSync(stdoutFd)
    if (stderrFd !== undefined) closeSync(stderrFd)
    removeTempFile(stdoutPath)
    removeTempFile(stderrPath)
    throw error instanceof Error ? error : new Error(String(error))
  }

  let timedOut = false
  let timedOutKilled = false

  const result = await new Promise<ExecResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined

    const timer = setTimeout(() => {
      timedOut = true
      if (child !== undefined && child.exitCode === null) {
        timedOutKilled = true
        child.kill('SIGKILL')
      }
    }, timeoutMs)

    const finish = (outcome: ExecResult) => {
      clearTimeout(timer)
      resolve(outcome)
    }

    try {
      // 关键点 1：不经过 shell，参数按数组传递，因此包名里的空格 / 引号 / 分号
      // 都无法被解释为命令。可执行文件是解析出的真实路径，不作为字符串交给 shell。
      // 关键点 2：stdio 用文件重定向而非 pipe，绕开 DSH 沙箱的命名管道限制。
      child = spawn(managerEntry.executable, args, {
        cwd: spec.cwd,
        env: mergeEnv(spec.env),
        windowsHide: true,
        stdio: ['ignore', stdoutFd as number, stderrFd as number]
      })
    } catch (error) {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    if (child === undefined) {
      clearTimeout(timer)
      reject(new Error('子进程创建失败'))
      return
    }

    const current = child
    current.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    current.on('close', (code, signal) => {
      clearTimeout(timer)
      finish({
        code,
        signal,
        stdout: readTempFile(stdoutPath),
        stderr: readTempFile(stderrPath),
        command,
        durationMs: Math.round(performance.now() - startedAt),
        timedOut: timedOut || timedOutKilled
      })
    })
  })

  // 关闭文件描述符并清理临时文件（无论成功失败都要做）
  try {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  } catch {
    // 子进程可能已让 fd 失效；忽略
  }
  removeTempFile(stdoutPath)
  removeTempFile(stderrPath)

  return result
}

/** 把 ExecResult 转成 Node 风格的 error 字段形式（便于诊断器统一处理）。 */
export function execToErrorLike(result: ExecResult): {
  code: number | null
  signal: string | null
  timedOut: boolean
  message: string
  stdout: string
  stderr: string
} {
  return {
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    message: [result.stderr, result.stdout].filter((s) => s.length > 0).join('\n').slice(-4000),
    stdout: result.stdout,
    stderr: result.stderr
  }
}
