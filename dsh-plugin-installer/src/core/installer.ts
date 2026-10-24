/**
 * 安装编排器：识别 → 校验 → 安装 → 自检修复 的全自动闭环。
 *
 * 核心能力是「自动装插件」，支持 5 种来源：
 *  - npm 包名（含 @scope 与 @version）
 *  - 本地目录（含 package.json 的插件源码目录）
 *  - 本地压缩包（.zip / .tgz / .tar.gz，自动解压后安装）
 *  - 远程压缩包（https 直链，自动下载解压后安装；.tgz 也可由 pnpm 直装）
 *  - git 仓库（git+https:// 或 github:owner/repo 简写）
 *
 * 诊断是辅助能力：每个失败点都会产出中文根因 + 自动修复动作，
 * 修复上限内循环重试，超限后输出人工介入指引。
 */

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { ResolvedConfig } from './config.js'
import { CN_MIRROR_REGISTRY, OFFICIAL_REGISTRY } from './config.js'
import type { AttemptOutcome, Diagnosis, ExecResult, RepairAction } from './types.js'
import {
  execToErrorLike,
  formatCommand,
  runNpmCommand,
  resolveManagerExecutable,
  type PackageManager
} from './exec.js'
import { manualInterventionDiagnosis, summarizeAttempt, successDiagnosis } from './diagnose.js'
import { fetchPluginDossier, RegistryError } from './registry.js'
import { identifySource, SOURCE_KIND_LABELS, type IdentifiedSource, type SourceKind } from './source.js'
import { extractLocalArchive, materializeRemoteArchive, MaterializeError } from './archive.js'
import { parsePackageName } from './package-name.js'

/** 一次完整安装流程的返回值。 */
export interface InstallRunResult {
  /** 目标包名（非 npm 来源在安装前能读到 manifest 时也有值） */
  packageName: string
  /** 最终安装版本（若成功） */
  installedVersion?: string
  /** 是否安装成功 */
  ok: boolean
  /** 来源类别说明 */
  source: { kind: SourceKind; label: string; spec: string }
  /** 实际使用的 registry（非 registry 来源为固定说明文本） */
  registry: string
  /** 实际使用的包管理器 */
  manager: PackageManager
  /** 逐次尝试明细 */
  attempts: AttemptOutcome[]
  /** 最终的中文诊断（多条，按严重度排序） */
  diagnoses: Array<{ code: string; title: string; detail: string; severity: string; suggestion: string }>
  /** 自检结果 */
  selfCheck: SelfCheckReport
  /** 总耗时毫秒 */
  durationMs: number
}

/** 安装后的可用性自检报告。 */
export interface SelfCheckReport {
  ok: boolean
  checks: SelfCheckEntry[]
  summary: string
}

/** 单个自检查项。 */
export interface SelfCheckEntry {
  name: string
  ok: boolean
  detail: string
}

/** 当前焦点的修复状态（在尝试之间传递）。 */
interface RepairState {
  manager: PackageManager
  registry: string
  extraArgs: string[]
  allowLatestFallback: boolean
  tried: Set<string>
  pinnedVersion?: string
}

/** 非 registry 来源时 registry 字段的展示值。 */
const NO_REGISTRY_LABEL = '（非 registry 来源，不适用）'

/**
 * 判断 profile 目录是否具备可安装条件。
 * 返回缺失项的中文列表，空数组代表就绪。
 */
export async function inspectProfileReadiness(profileDir: string): Promise<string[]> {
  const missing: string[] = []
  const manifest = join(profileDir, 'package.json')
  if (!existsSync(manifest)) {
    missing.push(`缺少 ${manifest}（DSH profile 清单）`)
    return missing
  }
  let raw: string
  try {
    raw = await readFile(manifest, 'utf8')
  } catch (error) {
    missing.push(`无法读取 ${manifest}：${error instanceof Error ? error.message : String(error)}`)
    return missing
  }
  try {
    JSON.parse(raw)
  } catch (error) {
    missing.push(`${manifest} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  return missing
}

/** 读取一个目录下 package.json 的 name 字段；读不到返回 undefined。 */
function readManifestName(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : undefined
  } catch {
    return undefined
  }
}

/** 读取 profile package.json 的全部依赖键（dependencies + devDependencies）。 */
function readDependencyKeys(profileDir: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
  } catch {
    return []
  }
}

/** 自检：确认插件已落到 profile 的 node_modules 且元数据可读。 */
export async function runSelfCheck(options: {
  packageName: string
  profileDir: string
  /** registry 探测到的版本（仅作参考信息，除非 requireExactVersion 为 true） */
  expectedVersion?: string
  /** true 时要求安装版本与 expectedVersion 严格一致（用户显式钉版本的情形） */
  requireExactVersion?: boolean
}): Promise<SelfCheckReport> {
  const checks: SelfCheckEntry[] = []
  const moduleDir = join(options.profileDir, 'node_modules', ...options.packageName.split('/'))

  // 检查 1：模块目录存在
  const dirExists = existsSync(moduleDir)
  checks.push({
    name: '模块目录存在性',
    ok: dirExists,
    detail: dirExists ? `已安装到 ${moduleDir}` : `未找到 ${moduleDir}`
  })

  // 检查 2：package.json 可读
  let manifest: { name?: string; version?: string; main?: string; dsh?: unknown } | undefined
  if (dirExists) {
    const manifestPath = join(moduleDir, 'package.json')
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest
      checks.push({
        name: '包清单可读',
        ok: true,
        detail: `${manifest?.name ?? '?'}@${manifest?.version ?? '?'}`
      })
    } catch (error) {
      checks.push({
        name: '包清单可读',
        ok: false,
        detail: `${manifestPath} 读取或解析失败：${error instanceof Error ? error.message : String(error)}`
      })
    }
  } else {
    checks.push({ name: '包清单可读', ok: false, detail: '因模块目录缺失而跳过' })
  }

  // 检查 3：版本匹配
  // 语义区分很重要：
  //  - requireExactVersion = true（用户在参数里显式钉了版本）：必须严格相等；
  //  - requireExactVersion = false（按 latest 安装）：包管理器有权选择一个
  //    满足语义范围的真实版本（例如 pnpm 在已知预发布不稳定时会退到最近的稳定版）。
  if (manifest !== undefined) {
    if (options.requireExactVersion === true && options.expectedVersion !== undefined) {
      const match = manifest.version === options.expectedVersion
      checks.push({
        name: '版本匹配',
        ok: match,
        detail: match
          ? `已按指定版本 ${manifest.version} 安装`
          : `期望 ${options.expectedVersion}，实际 ${manifest.version ?? '(未读到)'}`
      })
    } else if (options.expectedVersion !== undefined) {
      checks.push({
        name: '版本匹配',
        ok: manifest.version !== undefined,
        detail:
          manifest.version === undefined
            ? '未能从 package.json 读到版本号'
            : `已安装 ${manifest.version}（未指定精确版本，允许包管理器在语义范围内选择）`
      })
    }
  }

  // 检查 4：存在可加载入口（对应 DSH 插件规范的 main / exports）
  if (manifest !== undefined) {
    const entry = manifest.main
    if (entry === undefined) {
      checks.push({ name: '插件入口文件', ok: true, detail: 'package.json 未声明 main，交由 DSH Loader 解析' })
    } else {
      const entryOk = existsSync(join(moduleDir, entry))
      checks.push({
        name: '插件入口文件',
        ok: entryOk,
        detail: entryOk ? `入口存在：${entry}` : `入口 ${entry} 不存在，包可能未完整解压`
      })
    }
  }

  // 检查 5：node_modules 内是否为真实文件而非空链接目录
  if (dirExists) {
    try {
      const info = await stat(moduleDir)
      checks.push({
        name: '目录可访问',
        ok: info.isDirectory(),
        detail: `目录存在（${info.isDirectory() ? 'directory' : '非目录'}）`
      })
    } catch (error) {
      checks.push({
        name: '目录可访问',
        ok: false,
        detail: `无法访问目录：${error instanceof Error ? error.message : String(error)}`
      })
    }
  }

  const ok = checks.every((check) => check.ok)
  const failed = checks.filter((check) => !check.ok)
  const summary = ok
    ? `自检通过：${checks.length}/${checks.length} 项全部正常，插件 ${options.packageName} 已在普通对话模式下可用`
    : `自检未通过：${failed.length}/${checks.length} 项异常（${failed.map((c) => c.name).join('、')}）`

  return { ok, checks, summary }
}

/** 依据诊断结论决定下一次命令的调整。 */
function applyRepairs(
  state: RepairState,
  repairs: RepairAction[],
  usesRegistry: boolean
): { changed: boolean; label?: string } {
  let changed = false
  let lastLabel: string | undefined

  for (const repair of repairs) {
    lastLabel = repair.label
    switch (repair.kind) {
      case 'switch-package-manager': {
        const next: PackageManager = state.manager === 'pnpm' ? 'npm' : 'pnpm'
        if (next !== state.manager) {
          state.manager = next
          changed = true
        }
        break
      }
      case 'use-official-registry': {
        if (!usesRegistry) break
        if (state.registry !== OFFICIAL_REGISTRY) {
          state.registry = OFFICIAL_REGISTRY
          changed = true
        }
        break
      }
      case 'add-registry': {
        if (!usesRegistry) break
        if (state.registry !== CN_MIRROR_REGISTRY) {
          state.registry = CN_MIRROR_REGISTRY
          changed = true
        }
        break
      }
      case 'legacy-peer-deps': {
        if (state.manager === 'npm' && !state.extraArgs.includes('--legacy-peer-deps')) {
          state.extraArgs.push('--legacy-peer-deps')
          changed = true
        } else if (state.manager === 'pnpm' && !state.extraArgs.includes('--strict-peer-dependencies=false')) {
          state.extraArgs.push('--strict-peer-dependencies=false')
          changed = true
        }
        break
      }
      case 'strip-lockfile': {
        if (state.manager === 'pnpm' && !state.extraArgs.includes('--no-frozen-lockfile')) {
          state.extraArgs.push('--no-frozen-lockfile')
          changed = true
        }
        break
      }
      case 'clear-cache': {
        changed = true
        break
      }
      case 'prune-node-modules': {
        changed = true
        break
      }
      case 'normalize-spec': {
        if (state.pinnedVersion !== undefined) {
          state.pinnedVersion = undefined
          state.allowLatestFallback = true
          changed = true
        }
        break
      }
      case 'exact-pin': {
        if (state.pinnedVersion === undefined) {
          state.allowLatestFallback = true
          changed = true
        }
        break
      }
      case 'retry':
      case 'reinstall': {
        changed = true
        break
      }
      default:
        break
    }
  }

  return { changed, label: lastLabel }
}

/** 构造一条命令的指纹，用于避免重复执行同一条命令。 */
function commandKey(spec: { manager: PackageManager; registry: string; extraArgs: string[]; spec: string }): string {
  return `${spec.manager}|${spec.registry}|${spec.spec}|${[...spec.extraArgs].sort().join(',')}`
}

/** 执行一次安装尝试。内部统一走 runNpmCommand，并立即给出中文诊断。 */
async function runInstallAttempt(options: {
  state: RepairState
  config: ResolvedConfig
  spec: string
  profileDir: string
  index: number
  usesRegistry: boolean
  signal?: AbortSignal
}): Promise<AttemptOutcome> {
  const { state, config, spec, profileDir, index, usesRegistry } = options
  const managerEntry = resolveManagerExecutable(state.manager)
  const args = ['add', spec]
  const registryPart = usesRegistry && state.registry ? `--registry=${state.registry}` : ''
  // 预览用的完整参数，与 runNpmCommand 内部拼装保持一致
  const preview = formatCommand(managerEntry, [...args, ...state.extraArgs, registryPart].filter((part) => part.length > 0))

  let result: ExecResult
  try {
    result = await runNpmCommand(
      {
        manager: state.manager,
        cwd: profileDir,
        args,
        registry: usesRegistry ? state.registry : undefined,
        extraArgs: state.extraArgs
      },
      { timeoutMs: config.installTimeoutMs, signal: options.signal }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const raw = `${preview}\n${message}`
    const { diagnoses } = summarizeAttempt(raw, { packageName: spec })
    return {
      index,
      command: preview,
      ok: false,
      exitCode: null,
      timedOut: /超时|timed out/i.test(message),
      diagnoses,
      repairs: [],
      durationMs: 0,
      outputTail: message.slice(-2000)
    }
  }

  const combined = [result.stderr, result.stdout].filter((s) => s.length > 0).join('\n')
  const succeeded = result.code === 0 && !result.timedOut

  // 关键分支：成功时不做故障诊断。否则 pnpm 的成功输出也会被 fallback 规则判成 E_UNKNOWN。
  const summary = succeeded
    ? { diagnoses: [successDiagnosis(`命令执行成功，退出码 0（耗时 ${result.durationMs}ms）。`)], repairs: [] }
    : summarizeAttempt(combined, { packageName: spec })

  return {
    index,
    command: preview,
    ok: succeeded,
    exitCode: result.code,
    timedOut: result.timedOut,
    diagnoses: summary.diagnoses,
    repairs: summary.repairs,
    durationMs: result.durationMs,
    outputTail: result.stderr.slice(-2000) || result.stdout.slice(-2000)
  }
}

/** 判断修复状态是否真的发生了变化（防止死循环）。 */
function hasEffectiveChange(before: RepairState, after: RepairState, beforeRegistry: string): boolean {
  if (before.manager !== after.manager) return true
  if (before.registry !== after.registry) return true
  if (before.registry !== beforeRegistry) return true
  if (before.extraArgs.length !== after.extraArgs.length) return true
  if (before.pinnedVersion !== after.pinnedVersion) return true
  return false
}

/** 来源识别 / 物化失败 → 中文诊断。 */
function sourceFailureDiagnosis(code: string, detail: string): Diagnosis {
  return {
    code,
    title: '安装来源不可用',
    detail,
    severity: 'error',
    suggestion:
      '请核对来源地址 / 路径是否正确。支持的来源：npm 包名、本地目录（含 package.json）、' +
      '本地压缩包（.zip/.tgz/.tar.gz）、远程压缩包（https 直链）、git 仓库（git+https:// 或 github:owner/repo）。'
  }
}

/** 把物化阶段的错误转成中文诊断。 */
function materializeDiagnosis(error: MaterializeError): Diagnosis {
  const titleByCode: Record<string, string> = {
    E_ARCHIVE_MISSING: '压缩包文件不存在',
    E_ARCHIVE_TOO_LARGE: '压缩包体积超过上限',
    E_ARCHIVE_EXTRACT_FAILED: '压缩包解压失败',
    E_ARCHIVE_NO_MANIFEST: '压缩包内缺少 package.json',
    E_DOWNLOAD_INSECURE: '远程下载地址不是 https',
    E_DOWNLOAD_FAILED: '远程压缩包下载失败',
    E_DOWNLOAD_HTTP: '远程服务器返回错误状态码',
    E_DOWNLOAD_EMPTY: '远程响应体为空',
    E_DOWNLOAD_TIMEOUT: '远程压缩包下载超时'
  }
  const suggestionByCode: Record<string, string> = {
    E_ARCHIVE_MISSING: '确认本地文件存在后重试。',
    E_ARCHIVE_TOO_LARGE: 'DSH 插件不应超过 100MB，请确认下载的是插件源码包而不是数据文件。',
    E_ARCHIVE_EXTRACT_FAILED: '重新下载压缩包；确认是标准 .zip / .tgz / .tar.gz 格式。',
    E_ARCHIVE_NO_MANIFEST: '确认压缩包顶层（或唯一子目录）内含 package.json。',
    E_DOWNLOAD_INSECURE: '把 http:// 改为 https:// 后重试。',
    E_DOWNLOAD_FAILED: '检查网络与代理设置；或先手动下载到本地，再按本地路径安装。',
    E_DOWNLOAD_HTTP: '确认 URL 正确且资源未下架（404）或需要认证（401/403）。',
    E_DOWNLOAD_EMPTY: '换一个下载源重试。',
    E_DOWNLOAD_TIMEOUT: '网络较慢时可先手动下载到本地，再按本地路径安装。'
  }
  return {
    code: error.code,
    title: titleByCode[error.code] ?? '安装来源准备失败',
    detail: error.message,
    severity: 'error',
    suggestion: suggestionByCode[error.code] ?? '核对来源地址后重试。'
  }
}

/** 主入口：把一个来源（npm 包 / 本地目录 / 压缩包 / git）全自动装进 DSH profile。 */
export async function installPlugin(options: {
  /** 原始输入：包名 / 路径 / URL / git 地址 */
  spec: string
  /** 可选：已校验的规范包名（npm 来源可由上层预传，省去二次解析） */
  packageName?: string
  /** profile 根目录 */
  profileDir: string
  /** 插件配置 */
  config: ResolvedConfig
  /** 显式版本约束（仅 npm 来源生效） */
  version?: string
  signal?: AbortSignal
}): Promise<InstallRunResult> {
  const startedAt = performance.now()
  const attempts: AttemptOutcome[] = []
  const config = options.config
  const overallDeadline = performance.now() + config.totalBudgetMs

  const state: RepairState = {
    manager: config.packageManager,
    registry: config.registry,
    extraArgs: [],
    allowLatestFallback: options.version === undefined,
    tried: new Set<string>(),
    pinnedVersion: options.version
  }

  // ---- 阶段 0：环境校验 ----
  const readinessIssues = await inspectProfileReadiness(options.profileDir)
  if (readinessIssues.length > 0) {
    const diagnoses = readinessIssues.map((issue) => ({
      code: 'E_PROFILE_UNREADY',
      title: 'DSH profile 环境不具备安装条件',
      detail: issue,
      severity: 'error',
      suggestion: '确认安装目录是 DSH profile 根目录且 package.json 合法，然后重试。'
    }))
    return {
      packageName: options.packageName ?? options.spec,
      ok: false,
      source: { kind: 'npm', label: SOURCE_KIND_LABELS.npm, spec: options.spec },
      registry: state.registry,
      manager: state.manager,
      attempts,
      diagnoses,
      selfCheck: await runSelfCheck({ packageName: options.packageName ?? options.spec, profileDir: options.profileDir }),
      durationMs: Math.round(performance.now() - startedAt)
    }
  }

  // ---- 阶段 0.4：来源识别 ----
  const source: IdentifiedSource = identifySource(options.spec, { cwd: options.profileDir })
  if (source.reason !== undefined) {
    return {
      packageName: options.packageName ?? options.spec,
      ok: false,
      source: { kind: source.kind, label: SOURCE_KIND_LABELS[source.kind], spec: source.spec },
      registry: NO_REGISTRY_LABEL,
      manager: state.manager,
      attempts,
      diagnoses: [sourceFailureDiagnosis('E_INVALID_SOURCE', source.reason)],
      selfCheck: await runSelfCheck({ packageName: options.packageName ?? options.spec, profileDir: options.profileDir }),
      durationMs: Math.round(performance.now() - startedAt)
    }
  }

  const usesRegistry = source.kind === 'npm'
  const sourceInfo = { kind: source.kind, label: SOURCE_KIND_LABELS[source.kind], spec: source.spec }

  // ---- 阶段 0.5：按来源准备可安装的 spec 与包名 ----
  let currentSpec = source.spec
  let resolvedName: string | undefined = options.packageName
  let dossierVersion: string | undefined
  // git / 远程 tgz 的包名要装完才知道：先记下依赖键快照，成功后做差集
  let dependencyKeysBefore: string[] | undefined

  if (source.kind === 'npm') {
    const parsed = parsePackageName(options.packageName ?? source.packageName ?? source.spec)
    if (!parsed.ok || parsed.name === undefined) {
      return {
        packageName: source.spec,
        ok: false,
        source: sourceInfo,
        registry: NO_REGISTRY_LABEL,
        manager: state.manager,
        attempts,
        diagnoses: [
          {
            code: 'E_INVALID_PACKAGE_NAME',
            title: '插件包名校验失败',
            detail: parsed.reason ?? '未知原因',
            severity: 'error',
            suggestion: '请传入纯包名，如 dsh-plugin 或 @scope/name，可带 @version。'
          }
        ],
        selfCheck: await runSelfCheck({ packageName: source.spec, profileDir: options.profileDir }),
        durationMs: Math.round(performance.now() - startedAt)
      }
    }
    resolvedName = parsed.name
    currentSpec = options.version === undefined ? parsed.name : `${parsed.name}@${options.version}`

    // registry 元数据探测（识别目标是否真实存在）；失败不阻断安装
    try {
      const dossier = await fetchPluginDossier(parsed.name, options.version, config)
      dossierVersion = dossier.version
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof RegistryError ? error.code : 'E_REGISTRY_UNREACHABLE'
      attempts.push({
        index: 0,
        command: `(registry 探测) GET packument ${parsed.name}`,
        ok: false,
        exitCode: null,
        timedOut: false,
        diagnoses: [
          {
            code,
            title: 'registry 元数据探测失败',
            detail: message,
            severity: code === 'E_HTTP_NOT_FOUND' || code === 'E_REGISTRY_VERSION_MISSING' ? 'error' : 'warn',
            suggestion:
              code === 'E_HTTP_NOT_FOUND'
                ? '请先核对包名拼写；也可以用 dsh_plugin_inspect 查看可用版本。'
                : '仍会尝试直接安装；若持续失败请用 dsh_plugin_registry_check 探测 registry。',
            evidence: message.slice(-200)
          }
        ],
        repairs: code === 'E_HTTP_NOT_FOUND' ? [{ kind: 'normalize-spec', label: '去掉版本约束后按 latest 重试' }] : [],
        durationMs: 0,
        outputTail: message.slice(-500)
      })

      if (code === 'E_HTTP_NOT_FOUND' || code === 'E_REGISTRY_VERSION_MISSING') {
        return {
          packageName: parsed.name,
          ok: false,
          source: sourceInfo,
          registry: currentRegistryLabel(state, usesRegistry),
          manager: state.manager,
          attempts,
          diagnoses: attempts[0]?.diagnoses ?? [],
          selfCheck: await runSelfCheck({ packageName: parsed.name, profileDir: options.profileDir }),
          durationMs: Math.round(performance.now() - startedAt)
        }
      }
    }
  } else if (source.kind === 'local-dir') {
    resolvedName = readManifestName(source.localPath ?? '')
    currentSpec = `file:${source.localPath}`
  } else if (source.kind === 'local-archive') {
    try {
      const dir = await extractLocalArchive(source.localPath ?? '')
      resolvedName = readManifestName(dir)
      currentSpec = `file:${dir}`
    } catch (error) {
      const diagnosis =
        error instanceof MaterializeError
          ? materializeDiagnosis(error)
          : sourceFailureDiagnosis('E_ARCHIVE_EXTRACT_FAILED', error instanceof Error ? error.message : String(error))
      return {
        packageName: options.spec,
        ok: false,
        source: sourceInfo,
        registry: NO_REGISTRY_LABEL,
        manager: state.manager,
        attempts,
        diagnoses: [diagnosis],
        selfCheck: await runSelfCheck({ packageName: options.spec, profileDir: options.profileDir }),
        durationMs: Math.round(performance.now() - startedAt)
      }
    }
  } else if (source.kind === 'remote-archive') {
    if (source.isZip === true) {
      try {
        const dir = await materializeRemoteArchive(source.url ?? '', config.installTimeoutMs)
        resolvedName = readManifestName(dir)
        currentSpec = `file:${dir}`
      } catch (error) {
        const diagnosis =
          error instanceof MaterializeError
            ? materializeDiagnosis(error)
            : sourceFailureDiagnosis('E_DOWNLOAD_FAILED', error instanceof Error ? error.message : String(error))
        return {
          packageName: options.spec,
          ok: false,
          source: sourceInfo,
          registry: NO_REGISTRY_LABEL,
          manager: state.manager,
          attempts,
          diagnoses: [diagnosis],
          selfCheck: await runSelfCheck({ packageName: options.spec, profileDir: options.profileDir }),
          durationMs: Math.round(performance.now() - startedAt)
        }
      }
    } else {
      // .tgz 直链交给 pnpm 直装（pnpm 原生支持 tarball URL）
      currentSpec = source.url ?? source.spec
      dependencyKeysBefore = readDependencyKeys(options.profileDir)
    }
  } else if (source.kind === 'git') {
    currentSpec = source.gitUrl ?? source.spec
    dependencyKeysBefore = readDependencyKeys(options.profileDir)
  }

  // ---- 阶段 1：安装 + 自动修复循环 ----
  // 必须用 performance.now() 做时间基准（单调毫秒），绝不能与 Date.now() 混用。
  const maxAttempts = Math.max(1, config.maxRepairAttempts)
  const deadline = Math.min(performance.now() + config.totalBudgetMs, overallDeadline)

  for (let index = 1; index <= maxAttempts; index += 1) {
    if (performance.now() > deadline) break

    const key = commandKey({
      manager: state.manager,
      registry: state.registry,
      extraArgs: state.extraArgs,
      spec: currentSpec
    })
    if (state.tried.has(key)) {
      if (usesRegistry) {
        // 同一命令已试过：强制切换 registry 以避免死循环
        state.registry = state.registry === OFFICIAL_REGISTRY ? CN_MIRROR_REGISTRY : OFFICIAL_REGISTRY
        state.extraArgs = []
      } else {
        // 非 registry 来源换源无意义：修复无变化就直接收敛，交人工介入
        break
      }
    }
    state.tried.add(key)

    const attempt = await runInstallAttempt({
      state,
      config,
      spec: currentSpec,
      profileDir: options.profileDir,
      index,
      usesRegistry,
      signal: options.signal
    })
    attempts.push(attempt)

    if (attempt.ok) {
      // git / 远程 tgz：从依赖键差集里解析真实包名
      if (resolvedName === undefined && dependencyKeysBefore !== undefined) {
        const after = readDependencyKeys(options.profileDir)
        resolvedName = after.find((key2) => !dependencyKeysBefore.includes(key2))
      }

      // ---- 阶段 2：安装后自检 ----
      if (resolvedName === undefined) {
        return {
          packageName: options.spec,
          ok: false,
          source: sourceInfo,
          registry: currentRegistryLabel(state, usesRegistry),
          manager: state.manager,
          attempts,
          diagnoses: [
            {
              code: 'E_NAME_UNRESOLVED',
              title: '安装成功但无法确定插件包名',
              detail: '未能从来源目录或 profile 依赖差集中解析出包名，无法执行可用性自检。',
              severity: 'error',
              suggestion: '请显式传入包名，或改用 npm 包名 / 本地目录方式安装。'
            }
          ],
          selfCheck: { ok: false, checks: [], summary: '因包名未知而跳过自检' },
          durationMs: Math.round(performance.now() - startedAt)
        }
      }

      const requireExact = usesRegistry && options.version !== undefined && options.version !== 'latest'
      const selfCheck = await runSelfCheck({
        packageName: resolvedName,
        profileDir: options.profileDir,
        expectedVersion: dossierVersion,
        requireExactVersion: requireExact
      })

      // 自检未通过时：自动执行一次修复重装
      if (!selfCheck.ok && config.autoVerify && index < maxAttempts) {
        const repairAttempt = await runInstallAttempt({
          state: { ...state, extraArgs: [...state.extraArgs, '--force'] },
          config,
          spec: currentSpec,
          profileDir: options.profileDir,
          index: index + 1,
          usesRegistry,
          signal: options.signal
        })
        attempts.push(repairAttempt)
        const reCheck = await runSelfCheck({
          packageName: resolvedName,
          profileDir: options.profileDir,
          expectedVersion: dossierVersion,
          requireExactVersion: requireExact
        })
        if (!reCheck.ok) {
          return {
            packageName: resolvedName,
            ok: false,
            source: sourceInfo,
            registry: currentRegistryLabel(state, usesRegistry),
            manager: state.manager,
            attempts,
            diagnoses: [
              {
                code: 'E_SELF_CHECK_FAILED',
                title: '安装命令成功但插件的可用性自检未通过',
                detail: reCheck.summary,
                severity: 'error',
                suggestion: '按下方自检明细逐项排查；常见原因是 node_modules 残留、入口文件缺失或磁盘写满。'
              }
            ],
            selfCheck: reCheck,
            durationMs: Math.round(performance.now() - startedAt)
          }
        }
        const installedVersion = await readInstalledVersion(options.profileDir, resolvedName)
        return {
          packageName: resolvedName,
          installedVersion,
          ok: true,
          source: sourceInfo,
          registry: currentRegistryLabel(state, usesRegistry),
          manager: state.manager,
          attempts,
          diagnoses: [
            successDiagnosis(
              `插件 ${resolvedName} 安装成功（版本 ${installedVersion ?? dossierVersion ?? '未知'}，来源 ${sourceInfo.label} ${currentSpec}，包管理器 ${state.manager}，共 ${attempts.length} 次尝试）。${reCheck.summary}`
            )
          ],
          selfCheck: reCheck,
          durationMs: Math.round(performance.now() - startedAt)
        }
      }

      const installedVersion = await readInstalledVersion(options.profileDir, resolvedName)
      return {
        packageName: resolvedName,
        installedVersion,
        ok: true,
        source: sourceInfo,
        registry: currentRegistryLabel(state, usesRegistry),
        manager: state.manager,
        attempts,
        diagnoses: [
          successDiagnosis(
            `插件 ${resolvedName} 安装成功（版本 ${installedVersion ?? dossierVersion ?? '未知'}，来源 ${sourceInfo.label} ${currentSpec}，包管理器 ${state.manager}）。${selfCheck.summary}`
          )
        ],
        selfCheck,
        durationMs: Math.round(performance.now() - startedAt)
      }
    }

    // ---- 失败：根据诊断应用修复策略 ----
    const beforeRepair: RepairState = {
      manager: state.manager,
      registry: state.registry,
      extraArgs: [...state.extraArgs],
      allowLatestFallback: state.allowLatestFallback,
      tried: new Set(state.tried),
      pinnedVersion: state.pinnedVersion
    }

    // 版本回退策略：显式版本装不上时去掉版本约束（仅 npm 来源有意义）
    if (usesRegistry && state.pinnedVersion !== undefined) {
      const pinFailure = attempt.diagnoses.some((d) =>
        ['E_INVALID_VERSION', 'E_TARGET_NOT_FOUND', 'E_INCOMPATIBLE_PEER'].includes(d.code)
      )
      if (pinFailure) {
        state.pinnedVersion = undefined
        currentSpec = source.kind === 'npm' ? (resolvedName ?? currentSpec) : currentSpec
      }
    }

    applyRepairs(state, attempt.repairs, usesRegistry)

    // 死循环保护：修复无变化时强制翻转 registry（仅 registry 来源；翻转顺序 registry 优先于 manager）
    if (!hasEffectiveChange(beforeRepair, state, beforeRepair.registry)) {
      if (!usesRegistry) break
      state.registry = beforeRepair.registry === OFFICIAL_REGISTRY ? CN_MIRROR_REGISTRY : OFFICIAL_REGISTRY
      // 换源后不再叠加额外参数，保证下一轮是干净的对比实验
      state.extraArgs = []
    }
  }

  // ---- 达到尝试上限 ----
  const finalName = resolvedName ?? options.spec
  const selfCheck =
    resolvedName === undefined
      ? { ok: false, checks: [], summary: '因包名未知而跳过自检' }
      : await runSelfCheck({ packageName: resolvedName, profileDir: options.profileDir })
  const finalDiagnosis = manualInterventionDiagnosis(
    `已用 ${attempts.length} 次尝试仍未能成功安装 ${finalName}（来源：${sourceInfo.label} ${sourceInfo.spec}）。`,
    attempts
  )
  const latestDiagnoses = attempts[attempts.length - 1]?.diagnoses ?? []
  return {
    packageName: finalName,
    ok: false,
    source: sourceInfo,
    registry: currentRegistryLabel(state, usesRegistry),
    manager: state.manager,
    attempts,
    diagnoses: [finalDiagnosis, ...latestDiagnoses],
    selfCheck,
    durationMs: Math.round(performance.now() - startedAt)
  }
}

/** registry 展示值：非 registry 来源给固定说明文本。 */
function currentRegistryLabel(state: RepairState, usesRegistry: boolean): string {
  return usesRegistry ? state.registry : NO_REGISTRY_LABEL
}

/** 读取已安装插件的真实版本号。 */
export async function readInstalledVersion(profileDir: string, packageName: string): Promise<string | undefined> {
  try {
    const manifestPath = join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: string }
    return manifest.version
  } catch {
    return undefined
  }
}

/** 导出 execToErrorLike 以便测试。 */
export { execToErrorLike }
