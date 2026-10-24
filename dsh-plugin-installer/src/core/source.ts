/**
 * 安装来源识别。
 *
 * 插件的核心能力是「自动装插件」，因此必须能吃下 Agent 传来的各种形态：
 *  - npm 包名：dsh-plugin / @scope/name / name@1.2.3 / registry URL
 *  - git 仓库：git+https://github.com/x/y.git / github:owner/repo
 *  - 本地目录：D:\dev\my-plugin / ./my-plugin / file:../my-plugin
 *  - 本地压缩包：D:\downloads\plugin.zip / plugin.tgz
 *  - 远程压缩包：https://example.com/plugin.zip / .../plugin.tgz
 *
 * 识别顺序刻意把 git 特征放在 http(s) 之前——git+https:// 本身也含
 * https://，顺序反了会被误判成远程压缩包/registry URL。
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** 来源类别。 */
export type SourceKind = 'npm' | 'git' | 'local-dir' | 'local-archive' | 'remote-archive'

/** 识别结果：交给安装编排器的归一化描述。 */
export interface IdentifiedSource {
  kind: SourceKind
  /**
   * 可直接交给 pnpm 的安装标识：
   *  - npm          → name 或 name@version
   *  - git          → git+https://... （保留原始形态）
   *  - local-dir    → file: 绝对路径
   *  - local-archive→ file: 绝对路径（tgz 直装）或物化后的目录
   *  - remote-archive → https URL（tgz 直装）或物化后的目录
   */
  spec: string
  /** npm 包名（仅 kind=npm 时有值） */
  packageName?: string
  /** npm 版本约束（仅 kind=npm 时可能有值） */
  version?: string
  /** 本地压缩包 / 目录的绝对路径 */
  localPath?: string
  /** 远程压缩包 URL（仅 kind=remote-archive） */
  url?: string
  /** git 仓库地址（仅 kind=git） */
  gitUrl?: string
  /** 归档是否是 zip（需要先解压；tgz 可直接被 pnpm 消费或解压） */
  isZip?: boolean
  /** 识别失败时的中文原因 */
  reason?: string
}

/** 支持的压缩包扩展名（小写比较）。 */
const ARCHIVE_SUFFIXES = ['.zip', '.tgz', '.tar.gz', '.tar'] as const

/** git 来源的前缀简写（pnpm 原生支持这些形态）。 */
const GIT_SHORTHAND = ['github:', 'gitlab:', 'bitbucket:'] as const

/** 判断 URL 路径部分是否指向压缩包。 */
function urlLooksLikeArchive(url: string): { isArchive: boolean; isZip: boolean } {
  // 去掉 query / fragment 再看后缀
  const path = url.split(/[?#]/)[0] ?? ''
  const lowered = path.toLowerCase()
  if (lowered.endsWith('.zip')) return { isArchive: true, isZip: true }
  if (ARCHIVE_SUFFIXES.some((suffix) => lowered.endsWith(suffix))) return { isArchive: true, isZip: false }
  // GitHub codeload 直链没有文件后缀，但路径结构固定：
  //   https://codeload.github.com/<owner>/<repo>/zip/<ref>
  //   https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>
  if (/^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/zip\//i.test(url)) {
    return { isArchive: true, isZip: true }
  }
  if (/^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/tar\.gz\//i.test(url)) {
    return { isArchive: true, isZip: false }
  }
  return { isArchive: false, isZip: false }
}

/** 本地文件名是否是压缩包。 */
function localFileIsZip(name: string): boolean {
  return name.toLowerCase().endsWith('.zip')
}

/** git 特征检测（必须先于 http URL 检测调用）。 */
function detectGit(raw: string): string | undefined {
  const lowered = raw.toLowerCase()
  if (lowered.startsWith('git+') || lowered.startsWith('git://')) return raw
  if (GIT_SHORTHAND.some((prefix) => lowered.startsWith(prefix))) return raw
  // http(s) URL 以 .git 结尾也视为 git 仓库
  if (/^https?:\/\//i.test(raw) && /\.git(\/)?([?#].*)?$/i.test(raw)) return raw
  return undefined
}

/** 本地路径形态检测：返回 true 表示「这个字符串长得就像本地路径」。 */
function looksLikeLocalPath(raw: string): boolean {
  if (raw.startsWith('file:')) return true
  if (raw.includes('\\')) return true // 包名不可能含反斜杠
  if (raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('.\\') || raw.startsWith('..\\')) return true
  if (/^[A-Za-z]:[\\/]/.test(raw)) return true // Windows 盘符
  if (raw.startsWith('/') || raw.startsWith('~')) return true // POSIX 绝对路径 / 家目录
  return false
}

/** 把 file: 前缀或相对路径解析为绝对本地路径。 */
function toAbsoluteLocalPath(raw: string, cwd: string): string {
  let path = raw
  if (path.startsWith('file:')) path = path.slice('file:'.length)
  // file:///D:/x 形态
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  if (isAbsolute(path)) return path
  return resolve(cwd, path)
}

/**
 * 识别安装来源。
 *
 * @param raw Agent 传入的原始字符串
 * @param options.cwd 相对路径的解析基准（默认 process.cwd()）
 */
export function identifySource(raw: unknown, options: { cwd?: string } = {}): IdentifiedSource {
  if (typeof raw !== 'string') {
    return { kind: 'npm', spec: '', reason: '来源必须是字符串' }
  }
  const cwd = options.cwd ?? process.cwd()
  const input = raw.trim()
  if (input.length === 0) {
    return { kind: 'npm', spec: '', reason: '来源不能为空' }
  }

  // ---- 1. git 仓库（必须最先判断）----
  const gitUrl = detectGit(input)
  if (gitUrl !== undefined) {
    if (/^(git\+)?(ssh|git\+ssh):\/\//i.test(gitUrl)) {
      return {
        kind: 'git',
        spec: gitUrl,
        gitUrl,
        reason:
          '检测到 ssh 协议的 git 地址。SSH git 需要交互式认证，无法在全自动安装中完成。' +
          '请改用 https 形式的 git 地址（如 git+https://github.com/owner/repo.git）。'
      }
    }
    return { kind: 'git', spec: gitUrl, gitUrl }
  }

  // ---- 2. http(s) URL：远程压缩包 / registry 包名 ----
  if (/^https?:\/\//i.test(input)) {
    if (/^http:\/\//i.test(input)) {
      return {
        kind: 'remote-archive',
        spec: input,
        url: input,
        reason: '出于安全考虑，远程压缩包只允许 https 地址，请把 http:// 改为 https://。'
      }
    }
    const archive = urlLooksLikeArchive(input)
    if (archive.isArchive) {
      return { kind: 'remote-archive', spec: input, url: input, isZip: archive.isZip }
    }
    // 非压缩包 URL：尝试按 registry URL 提取包名（如 https://registry.npmjs.org/dsh-x）
    try {
      const url = new URL(input)
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (name.length > 0 && !name.includes('/')) {
        return { kind: 'npm', spec: name, packageName: name }
      }
      // scope 形态 @scope%2fname 或 @scope/name
      const unescaped = name.replace(/%2f/gi, '/')
      if (/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(unescaped)) {
        return { kind: 'npm', spec: unescaped, packageName: unescaped }
      }
    } catch {
      // 落到下面的统一错误
    }
    return {
      kind: 'npm',
      spec: input,
      reason:
        '这个 https 地址既不是压缩包（.zip/.tgz/.tar），也无法解析出 npm 包名。' +
        '请传入压缩包直链、registry 包 URL，或直接传包名。'
    }
  }

  // ---- 3. 本地路径 ----
  const isLocalByShape = looksLikeLocalPath(input)
  const absolute = toAbsoluteLocalPath(input, cwd)
  const exists = existsSync(absolute)
  if (isLocalByShape || exists) {
    if (!exists) {
      return {
        kind: 'local-dir',
        spec: `file:${absolute}`,
        localPath: absolute,
        reason: `本地路径不存在：${absolute}。请确认路径正确（支持绝对路径、./ 相对路径、file: 前缀）。`
      }
    }
    const stats = statSync(absolute)
    if (stats.isDirectory()) {
      if (!existsSync(resolve(absolute, 'package.json'))) {
        return {
          kind: 'local-dir',
          spec: `file:${absolute}`,
          localPath: absolute,
          reason: `本地目录 ${absolute} 里没有 package.json，不是一个可安装的插件包。`
        }
      }
      return { kind: 'local-dir', spec: `file:${absolute}`, localPath: absolute }
    }
    // 普通文件：必须是压缩包
    if (!ARCHIVE_SUFFIXES.some((suffix) => absolute.toLowerCase().endsWith(suffix))) {
      return {
        kind: 'local-archive',
        spec: `file:${absolute}`,
        localPath: absolute,
        reason: `本地文件 ${absolute} 不是受支持的压缩包（.zip / .tgz / .tar.gz / .tar）。`
      }
    }
    return { kind: 'local-archive', spec: `file:${absolute}`, localPath: absolute, isZip: localFileIsZip(absolute) }
  }

  // ---- 4. 其余交给 npm 包名解析（由调用方用 parsePackageName 做严格校验）----
  return { kind: 'npm', spec: input, packageName: input }
}

/** 来源类别的中文名（用于诊断消息）。 */
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  npm: 'npm 包',
  git: 'git 仓库',
  'local-dir': '本地目录',
  'local-archive': '本地压缩包',
  'remote-archive': '远程压缩包'
}
