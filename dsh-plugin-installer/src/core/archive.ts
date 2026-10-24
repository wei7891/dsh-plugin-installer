/**
 * 压缩包物化：下载 / 解压，把「本地或远程压缩包」变成可安装的本地目录。
 *
 * 设计要点：
 *  - 解压统一走系统自带的 bsdtar（Windows System32\tar.exe，POSIX tar），
 *    它同时支持 zip 与 tgz，无需第三方依赖；
 *  - 子进程同样走「临时文件重定向」采集输出，绕开 DSH 沙箱的管道限制；
 *  - 远程下载用内置 fetch 流式写入临时文件，仅允许 https，且有大小上限，
 *    防止 Agent 被诱导下载超大文件耗尽磁盘；
 *  - zip 解压后自动识别「顶层单目录」布局（GitHub 下载的 zip 都是这种），
 *    返回真正含 package.json 的目录。
 */

import { spawn } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 远程压缩包大小上限：100 MB（DSH 插件远小于此值）。 */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024

/** 物化失败的中文错误。 */
export class MaterializeError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'MaterializeError'
    this.code = code
  }
}

/** 在常见系统位置里找 tar 可执行文件。 */
function resolveTarExecutable(): string {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const systemTar = join(systemRoot, 'System32', 'tar.exe')
    if (existsSync(systemTar)) return systemTar
    return 'tar.exe'
  }
  return 'tar'
}

/** 运行 tar 并在失败时抛出中文错误（输出走临时文件采集，绕开管道限制）。 */
async function runTar(args: string[], cwd: string): Promise<void> {
  const tarExe = resolveTarExecutable()
  const stdoutPath = join(tmpdir(), `dsh-installer-tar-${process.pid}-${Math.random().toString(36).slice(2)}.log`)
  const stderrPath = `${stdoutPath}.err`
  const outFd = openSync(stdoutPath, 'w')
  const errFd = openSync(stderrPath, 'w')
  try {
    const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
      let child: ReturnType<typeof spawn> | undefined
      try {
        child = spawn(tarExe, args, { cwd, windowsHide: true, stdio: ['ignore', outFd, errFd] })
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
        return
      }
      child.on('error', (error: Error) => rejectPromise(error))
      child.on('close', (exitCode) => resolvePromise(exitCode))
    })
    if (code !== 0) {
      let detail = ''
      try {
        detail = readFileSync(stderrPath, 'utf8').trim().slice(-500)
      } catch {
        // 读不到就用空摘要
      }
      throw new MaterializeError(`解压失败（tar 退出码 ${code}）：${detail || '无错误输出'}`, 'E_ARCHIVE_EXTRACT_FAILED')
    }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
    for (const path of [stdoutPath, stderrPath]) {
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch {
        // 清理失败不影响主流程
      }
    }
  }
}

/**
 * 找到解压结果中真正含 package.json 的目录。
 * 兼容两种布局：根目录直接有 package.json / 顶层包裹一层目录（GitHub zip）。
 */
function findPackageRoot(dir: string): string | undefined {
  if (existsSync(join(dir, 'package.json'))) return dir
  const entries = readdirSync(dir, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory())
  if (dirs.length === 1 && dirs[0] !== undefined) {
    const single = join(dir, dirs[0].name)
    if (existsSync(join(single, 'package.json'))) return single
  }
  // 多个顶层目录时逐个找第一层
  for (const entry of dirs) {
    const candidate = join(dir, entry.name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** 创建临时工作目录。 */
function makeWorkDir(tag: string): string {
  const dir = join(tmpdir(), `dsh-installer-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 解压本地压缩包，返回含 package.json 的目录。
 *
 * @param archivePath 压缩包绝对路径
 */
export async function extractLocalArchive(archivePath: string): Promise<string> {
  if (!existsSync(archivePath)) {
    throw new MaterializeError(`压缩包不存在：${archivePath}`, 'E_ARCHIVE_MISSING')
  }
  const size = statSync(archivePath).size
  if (size > MAX_ARCHIVE_BYTES) {
    throw new MaterializeError(
      `压缩包体积 ${Math.round(size / 1024 / 1024)}MB 超过上限 ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)}MB`,
      'E_ARCHIVE_TOO_LARGE'
    )
  }
  const workDir = makeWorkDir('extract')
  await runTar(['-xf', archivePath, '-C', workDir], workDir)
  const root = findPackageRoot(workDir)
  if (root === undefined) {
    throw new MaterializeError(
      `压缩包 ${archivePath} 解压后未找到 package.json，不是一个有效的插件包。`,
      'E_ARCHIVE_NO_MANIFEST'
    )
  }
  return root
}

/**
 * 下载远程压缩包到临时文件（仅 https，流式写入，带大小上限）。
 *
 * @returns 临时文件绝对路径
 */
export async function downloadArchive(url: string, timeoutMs = 120_000): Promise<string> {
  if (!/^https:\/\//i.test(url)) {
    throw new MaterializeError(`远程压缩包只允许 https 地址：${url}`, 'E_DOWNLOAD_INSECURE')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const tempPath = join(makeWorkDir('download'), 'archive.bin')
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'user-agent': 'dsh-plugin-installer/0.1.0 (+https://github.com/deepseek-ai/deepseek-harness)' },
        signal: controller.signal,
        redirect: 'follow'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (controller.signal.aborted) {
        throw new MaterializeError(`下载超时（超过 ${timeoutMs}ms）：${url}`, 'E_DOWNLOAD_TIMEOUT')
      }
      throw new MaterializeError(`下载失败：${message}`, 'E_DOWNLOAD_FAILED')
    }
    if (!response.ok) {
      throw new MaterializeError(`下载失败：HTTP ${response.status} ${response.statusText}`, 'E_DOWNLOAD_HTTP')
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
      throw new MaterializeError(
        `远程文件体积超过上限 ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)}MB，拒绝下载`,
        'E_ARCHIVE_TOO_LARGE'
      )
    }
    if (response.body === null) {
      throw new MaterializeError('下载失败：响应体为空', 'E_DOWNLOAD_EMPTY')
    }
    // 流式写入并累计大小：即使 Content-Length 缺失或造假也能兜底
    let received = 0
    const fileStream = createWriteStream(tempPath)
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          received += value.byteLength
          if (received > MAX_ARCHIVE_BYTES) {
            throw new MaterializeError(
              `下载内容超过大小上限 ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)}MB，已中止`,
              'E_ARCHIVE_TOO_LARGE'
            )
          }
          if (!fileStream.write(Buffer.from(value))) {
            await new Promise<void>((resolveDrain) => fileStream.once('drain', () => resolveDrain()))
          }
        }
      }
    } finally {
      await new Promise<void>((resolveFinish, rejectFinish) => {
        fileStream.end((error?: Error | null) => (error ? rejectFinish(error) : resolveFinish()))
      })
    }
    return tempPath
  } catch (error) {
    if (error instanceof MaterializeError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      throw new MaterializeError(`下载超时（超过 ${timeoutMs}ms）：${url}`, 'E_DOWNLOAD_TIMEOUT')
    }
    throw new MaterializeError(`下载失败：${message}`, 'E_DOWNLOAD_FAILED')
  } finally {
    clearTimeout(timer)
  }
}

/** 下载并解压远程压缩包，返回含 package.json 的目录。 */
export async function materializeRemoteArchive(url: string, timeoutMs = 120_000): Promise<string> {
  const archivePath = await downloadArchive(url, timeoutMs)
  return extractLocalArchive(archivePath)
}
