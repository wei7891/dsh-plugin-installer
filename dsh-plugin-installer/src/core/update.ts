/**
 * 插件更新编排：扫描可更新项 + 单插件更新（失败自动回滚）。
 *
 * 为什么这能力值得做成工具而不是让 Agent 裸跑 pnpm update：
 *  - Agent 裸跑 `pnpm update` 不知道哪些依赖是 DSH 插件、哪些是
 *    link:/本地包（它们没有 registry 版本，更新会报错或被误删）；
 *  - 更新失败时裸命令不会把 profile 恢复到更新前状态，可能留下
 *    半升级的 node_modules；
 *  - 本模块把「对比版本 → 摘除旧版 → 装新版 → 自检 → 失败回滚」
 *    做成一步到位的原子操作，并全程中文反馈。
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ResolvedConfig } from './config.js'
import type { AttemptOutcome, Diagnosis } from './types.js'
import { runNpmCommand } from './exec.js'
import { diagnoseCommandOutput, successDiagnosis } from './diagnose.js'
import { fetchPluginDossier, RegistryError } from './registry.js'
import { installPlugin, runSelfCheck, readInstalledVersion } from './installer.js'
import { findDependencySpec, readProfileManifest } from './profile.js'

/** 单个已安装插件的版本对比结果。 */
export interface PluginUpdateEntry {
  /** 包名 */
  name: string
  /** profile 里的原始依赖声明（如 ^1.2.0 / link:... / file:...） */
  declared: string
  /** 当前安装版本；读不到为 undefined */
  installedVersion?: string
  /** registry 最新版本；非 registry 来源为 undefined */
  latestVersion?: string
  /** 是否有可用更新 */
  updateAvailable: boolean
  /** 来源类别说明（registry / link / 本地路径） */
  sourceKind: 'registry' | 'link' | 'local'
  /** 中文说明（为什么不能更新 / 为什么建议更新） */
  note: string
}

/** 扫描结果。 */
export interface UpdateScanResult {
  /** 全部已解析依赖条目 */
  entries: PluginUpdateEntry[]
  /** 可更新条目数 */
  updatable: number
  /** 无法从 registry 获取版本的条目数（link/本地/内部包） */
  skipped: number
  /** 扫描过程中的中文警告（registry 不可达等） */
  warnings: string[]
}

/** 版本对比结果。 */
export interface UpdateRunResult {
  name: string
  ok: boolean
  /** 更新前版本 */
  previousVersion?: string
 /** 更新后版本 */
  newVersion?: string
  /** 是否触发了回滚（更新失败后恢复旧版） */
  rolledBack: boolean
  /** 回滚是否成功 */
  rollbackOk?: boolean
  /** 逐步尝试明细 */
  attempts: AttemptOutcome[]
  /** 最终中文诊断 */
  diagnoses: Diagnosis[]
  /** 自检结果摘要 */
  selfCheckSummary?: string
  /** 总耗时 */
  durationMs: number
}

/** 从 profile 的依赖声明推断来源类别。 */
function classifyDeclared(declared: string): { kind: PluginUpdateEntry['sourceKind']; note: string } {
  if (declared.startsWith('link:')) {
    return { kind: 'link', note: 'link: 本地开发依赖，没有 registry 版本；改代码即时生效，无需更新' }
  }
  if (declared.startsWith('file:')) {
    return { kind: 'local', note: 'file: 本地路径依赖，没有 registry 版本；替换本地文件夹内容即完成「更新」' }
  }
  return { kind: 'registry', note: '' }
}

/**
 * 扫描 profile 中的全部依赖，对比 registry 最新版。
 *
 * @param profileDir DSH profile 根目录
 * @param config 插件配置（registry / 超时）
 */
export async function scanUpdates(profileDir: string, config: ResolvedConfig): Promise<UpdateScanResult> {
  const manifest = readProfileManifest(profileDir)
  const declaredMap: Record<string, string> = { ...manifest.devDependencies, ...manifest.dependencies }
  const entries: PluginUpdateEntry[] = []
  const warnings: string[] = []

  for (const [name, declared] of Object.entries(declaredMap)) {
    const { kind, note } = classifyDeclared(declared)
    const installedVersion = await readInstalledVersion(profileDir, name)

    if (kind !== 'registry') {
      entries.push({ name, declared, installedVersion, updateAvailable: false, sourceKind: kind, note })
      continue
    }

    // registry 来源：拉取最新版本做对比
    try {
      const dossier = await fetchPluginDossier(name, undefined, config)
      const latest = dossier.version
      const updateAvailable = installedVersion !== undefined && installedVersion !== latest
      entries.push({
        name,
        declared,
        installedVersion,
        latestVersion: latest,
        updateAvailable,
        sourceKind: 'registry',
        note:
          installedVersion === undefined
            ? '依赖已声明但 node_modules 中未找到包目录，重装即可'
            : updateAvailable
              ? `可更新：${installedVersion} → ${latest}`
              : '已是最新版'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // @deepseek-ai/* 内部包在公开源查不到属于正常现象，不算告警
      const isInternal = error instanceof RegistryError && error.code === 'E_HTTP_NOT_FOUND' && name.startsWith('@deepseek-ai/')
      if (!isInternal) warnings.push(`无法获取 ${name} 的 registry 版本：${message}`)
      entries.push({
        name,
        declared,
        installedVersion,
        updateAvailable: false,
        sourceKind: 'registry',
        note: isInternal
          ? 'DSH 内部包（不对外发布版本），随 DSH 运行时一起更新'
          : `registry 元数据不可用，跳过对比：${message.slice(0, 120)}`
      })
    }
  }

  return {
    entries,
    updatable: entries.filter((e) => e.updateAvailable).length,
    skipped: entries.filter((e) => e.sourceKind !== 'registry').length,
    warnings
  }
}

/** 读取 profile 里某个已装依赖的原始声明；不存在返回 undefined。 */
function declaredSpecOf(profileDir: string, name: string): string | undefined {
  try {
    return findDependencySpec(readProfileManifest(profileDir), name)
  } catch {
    return undefined
  }
}

/**
 * 更新单个插件到最新（或指定）版本，失败自动回滚到更新前版本。
 *
 * 流程：
 *  1. 记录更新前版本与依赖声明；
 *  2. 用 installPlugin 安装目标版本（复用全套自动修复 + 自检）；
 *  3. 失败时用 installPlugin 装回旧版本（回滚），并如实报告。
 *
 * @param options.packageName 要更新的包名
 * @param options.version 目标版本；省略则用 registry latest
 */
export async function updatePlugin(options: {
  packageName: string
  profileDir: string
  config: ResolvedConfig
  version?: string
  signal?: AbortSignal
}): Promise<UpdateRunResult> {
  const startedAt = performance.now()
  const { packageName, profileDir, config } = options
  const attempts: AttemptOutcome[] = []

  // ---- 前置校验：必须是已声明的 registry 依赖 ----
  const declared = declaredSpecOf(profileDir, packageName)
  if (declared === undefined) {
    return {
      name: packageName,
      ok: false,
      rolledBack: false,
      attempts,
      diagnoses: [
        {
          code: 'E_NOT_INSTALLED',
          title: '该插件不在 profile 依赖中',
          detail: `${packageName} 未出现在 ${profileDir} 的 package.json 依赖里，没有可更新的安装。`,
          severity: 'error',
          suggestion: '先用 install_dsh_plugin 安装该插件；link:/file: 本地依赖请直接修改本地文件夹内容。'
        }
      ],
      durationMs: Math.round(performance.now() - startedAt)
    }
  }
  if (declared.startsWith('link:') || declared.startsWith('file:')) {
    return {
      name: packageName,
      ok: false,
      rolledBack: false,
      attempts,
      diagnoses: [
        {
          code: 'E_LOCAL_DEPENDENCY',
          title: '本地依赖无需更新',
          detail: `${packageName} 是 ${declared.split(':')[0]}: 本地依赖，没有 registry 版本概念。`,
          severity: 'info',
          suggestion: '直接更新本地文件夹里的源码即可；若是 link: 开发中的插件，改完代码重启 DSH 生效。'
        }
      ],
      durationMs: Math.round(performance.now() - startedAt)
    }
  }

  const previousVersion = await readInstalledVersion(profileDir, packageName)

  // ---- 解析目标版本 ----
  let targetVersion = options.version
  if (targetVersion === undefined) {
    try {
      const dossier = await fetchPluginDossier(packageName, undefined, config)
      targetVersion = dossier.version
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        name: packageName,
        ok: false,
        previousVersion,
        rolledBack: false,
        attempts,
        diagnoses: [
          {
            code: 'E_REGISTRY_UNREACHABLE',
            title: '无法获取最新版本号',
            detail: message,
            severity: 'error',
            suggestion: '用 dsh_plugin_registry_check 探测连通性后重试；网络恢复后再次调用更新即可。'
          }
        ],
        durationMs: Math.round(performance.now() - startedAt)
      }
    }
  }

  // 已是目标版本：幂等返回
  if (previousVersion !== undefined && previousVersion === targetVersion) {
    return {
      name: packageName,
      ok: true,
      previousVersion,
      newVersion: targetVersion,
      rolledBack: false,
      attempts,
      diagnoses: [successDiagnosis(`${packageName} 已经是目标版本 ${targetVersion}，无需更新。`)],
      selfCheckSummary: '未执行安装，跳过自检',
      durationMs: Math.round(performance.now() - startedAt)
    }
  }

  // ---- 执行更新（复用安装编排：自动修复 + 自检）----
  const updateRun = await installPlugin({
    spec: packageName,
    packageName,
    version: targetVersion,
    profileDir,
    config,
    signal: options.signal
  })
  attempts.push(...updateRun.attempts)

  if (updateRun.ok) {
    const newVersion = updateRun.installedVersion ?? targetVersion
    return {
      name: packageName,
      ok: true,
      previousVersion,
      newVersion,
      rolledBack: false,
      attempts,
      diagnoses: [
        successDiagnosis(
          `更新成功：${packageName} ${previousVersion ?? '(未安装)'} → ${newVersion}。${updateRun.selfCheck.summary}`
        )
      ],
      selfCheckSummary: updateRun.selfCheck.summary,
      durationMs: Math.round(performance.now() - startedAt)
    }
  }

  // ---- 更新失败：尝试回滚到更新前版本 ----
  if (previousVersion === undefined) {
    // 之前就没装上，无从回滚；如实报告更新失败
    return {
      name: packageName,
      ok: false,
      previousVersion,
      rolledBack: false,
      attempts,
      diagnoses: updateRun.diagnoses.map((d) => ({ ...d })) as Diagnosis[],
      selfCheckSummary: updateRun.selfCheck.summary,
      durationMs: Math.round(performance.now() - startedAt)
    }
  }

  const rollbackRun = await installPlugin({
    spec: packageName,
    packageName,
    version: previousVersion,
    profileDir,
    config,
    signal: options.signal
  })
  attempts.push(...rollbackRun.attempts)

  const currentVersion = await readInstalledVersion(profileDir, packageName)
  const rollbackOk = rollbackRun.ok && currentVersion === previousVersion

  const failureDiagnoses: Diagnosis[] = [
    {
      code: 'E_UPDATE_FAILED',
      title: '更新失败',
      detail: `目标版本 ${targetVersion} 安装未成功（详见尝试记录）。`,
      severity: 'error',
      suggestion: '查看下方诊断逐条排查；也可以指定一个中间版本更新（如先升小版本再升大版本）。'
    },
    ...(rollbackOk
      ? [
          {
            code: 'E_UPDATE_ROLLED_BACK',
            title: '已自动回滚到更新前版本',
            detail: `profile 已恢复为 ${packageName}@${previousVersion}，可以继续正常使用。`,
            severity: 'info',
            suggestion: '修复下方问题后再尝试更新。'
          } satisfies Diagnosis
        ]
      : [
          {
            code: 'E_UPDATE_ROLLBACK_FAILED',
            title: '更新失败且自动回滚未成功',
            detail: `当前安装版本为 ${currentVersion ?? '(未安装)'}，期望恢复到 ${previousVersion}。`,
            severity: 'error',
            suggestion:
              '立即用 install_dsh_plugin 传入版本号装回旧版（如 ' +
              `${packageName}@${previousVersion}），避免影响正在使用该插件的会话。`
          } satisfies Diagnosis
        ]),
    ...rollbackRun.diagnoses.slice(0, 2).map((d) => ({ ...d, severity: d.severity as Diagnosis['severity'] }))
  ]

  return {
    name: packageName,
    ok: false,
    previousVersion,
    newVersion: currentVersion,
    rolledBack: true,
    rollbackOk,
    attempts,
    diagnoses: failureDiagnoses,
    selfCheckSummary: rollbackOk ? `已回滚：${rollbackRun.selfCheck.summary}` : rollbackRun.selfCheck.summary,
    durationMs: Math.round(performance.now() - startedAt)
  }
}

/** 校验目标包在 profile 的 node_modules 里真实存在（供卸载前确认）。 */
export function isPackagePresent(profileDir: string, packageName: string): boolean {
  return existsSync(join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json'))
}

/** 读取已装包的版本（薄封装，便于工具层调用）。 */
export async function installedVersionOf(profileDir: string, packageName: string): Promise<string | undefined> {
  return readInstalledVersion(profileDir, packageName)
}

/** 读取 profile 中某依赖的原始声明。 */
export function declaredSpec(profileDir: string, packageName: string): string | undefined {
  return declaredSpecOf(profileDir, packageName)
}

/** 卸载插件：pnpm remove + 清理 bundles 条目 + 校验结果。 */
export async function uninstallPlugin(options: {
  packageName: string
  profileDir: string
  config: ResolvedConfig
  /** 是否同时从 dsh.profile.bundles 移除（默认 true） */
  removeFromBundles?: boolean
  signal?: AbortSignal
}): Promise<{
  name: string
  ok: boolean
  removedDependency: boolean
  removedBundleEntry: boolean
  diagnoses: Diagnosis[]
  durationMs: number
}> {
  const startedAt = performance.now()
  const { packageName, profileDir, config } = options
  const diagnoses: Diagnosis[] = []

  const declared = declaredSpecOf(profileDir, packageName)
  if (declared === undefined) {
    return {
      name: packageName,
      ok: false,
      removedDependency: false,
      removedBundleEntry: false,
      diagnoses: [
        {
          code: 'E_NOT_INSTALLED',
          title: '该插件不在 profile 依赖中',
          detail: `${packageName} 未声明为依赖，无需卸载。`,
          severity: 'info',
          suggestion: '用 dsh_plugin_outdated / 扫描确认当前已安装的插件列表。'
        }
      ],
      durationMs: Math.round(performance.now() - startedAt)
    }
  }

  // ---- 1. pnpm remove 摘除依赖 ----
  const result = await runNpmCommand(
    { manager: config.packageManager, cwd: profileDir, args: ['remove', packageName] },
    { timeoutMs: config.installTimeoutMs, signal: options.signal }
  )
  const succeeded = result.code === 0 && !result.timedOut
  if (!succeeded) {
    const combined = [result.stderr, result.stdout].filter((s) => s.length > 0).join('\n')
    diagnoses.push(...diagnoseCommandOutput(combined, { packageName }))
  }

  // ---- 2. 清理 bundles 条目（pnpm 成功与否都要尝试，避免留下孤儿条目）----
  let removedBundleEntry = false
  if (options.removeFromBundles !== false) {
    try {
      const { isBundled, removeBundleEntry } = await import('./profile.js')
      if (isBundled(readProfileManifest(profileDir), packageName)) {
        removedBundleEntry = removeBundleEntry(profileDir, packageName)
      }
    } catch (error) {
      diagnoses.push({
        code: 'E_BUNDLE_CLEANUP_FAILED',
        title: 'bundles 条目清理失败',
        detail: error instanceof Error ? error.message : String(error),
        severity: 'warn',
        suggestion: '请手动从 profile 的 package.json → dsh.profile.bundles 中删除该条目，否则下次启动会报 cannot resolve profile bundle。'
      })
    }
  }

  // ---- 3. 校验 ----
  const stillPresent = isPackagePresent(profileDir, packageName)
  const ok = succeeded && !stillPresent
  if (ok) {
    diagnoses.unshift(
      successDiagnosis(
        `已卸载 ${packageName}${removedBundleEntry ? '，并从 dsh.profile.bundles 移除' : ''}。重启 DSH 后生效。`
      )
    )
  } else if (succeeded && stillPresent) {
    diagnoses.push({
      code: 'E_REMOVE_INCOMPLETE',
      title: '依赖声明已移除但包目录仍存在',
      detail: `node_modules 中仍能找到 ${packageName}，可能是其他插件把它作为依赖保留。`,
      severity: 'warn',
      suggestion: '检查是否有其他插件依赖它；必要时删除 node_modules 后执行 dsh plugin install 重建。'
    })
  }

  return {
    name: packageName,
    ok,
    removedDependency: succeeded,
    removedBundleEntry,
    diagnoses,
    durationMs: Math.round(performance.now() - startedAt)
  }
}

/** 供测试引用：读取已装版本。 */
export { readFile }
