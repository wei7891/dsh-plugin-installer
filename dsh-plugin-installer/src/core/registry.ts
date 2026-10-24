/**
 * 官方插件源（npm registry）元数据拉取与「是否 DSH 插件」识别。
 *
 * 这是「全自动识别」的第二道关卡：
 *  1. 拉 packument；
 *  2. 从 latest / 指定版本里提取 DSH 关键字段；
 *  3. 依据 dsh.bundle / dsh.compatibility / peerDependencies / keywords 判定是否 DSH 插件。
 */

import { httpGetJson, normalizeRegistryBase, HttpError } from './http.js'
import type { ResolvedConfig } from './config.js'
import type { NpmPackument, NpmVersionRecord } from './types.js'
import { parseMajorVersion } from './package-name.js'

/** 标识「这是一个 DSH 插件」的 peer 依赖前缀。 */
const DSH_PEER_PREFIXES = ['@deepseek-ai/']

/** 从 packument 的描述里识别出的 DSH 能力摘要。 */
export interface DshPluginSignals {
  /** 是否声明了 dsh.bundle.patch（DSH 官方插件规范的核心字段） */
  hasBundlePatch: boolean
  /** 是否声明了 dsh.compatibility */
  hasCompatibility: boolean
  /** 是否声明了 client 注入（带 Web GUI 侧能力的插件） */
  hasClientInject: boolean
  /** peerDependencies 中的 @deepseek-ai/* 清单 */
  dshPeers: string[]
  /** keyword 里的 dsh 相关标签 */
  dshKeywords: string[]
  /** 综合判定：是否是 DSH 插件 */
  isDshPlugin: boolean
  /** 判定依据的中文摘要（返回给 Agent） */
  reasons: string[]
}

/** 归一化后的「插件档案」。 */
export interface PluginDossier {
  /** 包名 */
  name: string
  /** 拉取到的版本 */
  version: string
  /** 是否为 latest（未指定版本时） */
  resolvedFromLatest: boolean
  description?: string
  keywords: string[]
  license?: string
  /** 解析出的包主入口 */
  main?: string
  /** exports 字段中的 "." 入口 */
  exportDefault?: string
  /** 版本文档中的原始 dsh 字段（原样透传，便于 Agent 细读） */
  dshField?: Record<string, unknown>
  dshSignals: DshPluginSignals
  /** 依赖概览 */
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  /** 引擎要求 */
  engines?: Record<string, string>
  /** registry 提供的 tarball 地址 */
  tarball?: string
  /** 拆包后体积 */
  unpackedSize?: number
  /** dist-tags 全量（latest / next 等） */
  distTags: Record<string, string>
  /** 全部可用版本（按主版本降序取最近若干条） */
  availableVersions: string[]
  /** 若该版本已废弃，registry 给出的废弃说明 */
  deprecated?: string
  /** 实际用于拉取的 registry base */
  registryBase: string
  /** 拉取耗时毫秒 */
  durationMs: number
}

/** registry 拉取失败的中文错误，附带 code 供上层转成修复动作。 */
export class RegistryError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}

/** 从 version record 里安全读取 dsh 字段。 */
function readDshField(record: NpmVersionRecord | undefined): Record<string, unknown> | undefined {
  const dsh = record?.dsh
  if (typeof dsh === 'object' && dsh !== null) return dsh as Record<string, unknown>
  return undefined
}

/** 收集 peer 依赖中属于 DSH 生态的条目。 */
function collectDshPeers(record: NpmVersionRecord | undefined): string[] {
  const peers = record?.peerDependencies ?? {}
  return Object.keys(peers).filter((key) => DSH_PEER_PREFIXES.some((prefix) => key.startsWith(prefix)))
}

/** 收集 keyword 里的 dsh 标签。 */
function collectDshKeywords(record: NpmVersionRecord | undefined): string[] {
  const keywords = record?.keywords ?? []
  return keywords.filter((k) => typeof k === 'string' && /^(dsh|deepseek|deepseek-harness)/i.test(k))
}

/**
 * 依据版本记录里的字段推断这是否一个 DSH 插件。
 * 判定强调「可证据化」——每个理由都会展现在返回给 Agent 的诊断里。
 */
export function detectDshSignals(record: NpmVersionRecord | undefined): DshPluginSignals {
  const dshField = readDshField(record)
  const bundle = (dshField?.bundle ?? {}) as Record<string, unknown>
  const hasBundlePatch = typeof bundle.patch === 'string' && bundle.patch.length > 0
  const hasCompatibility = dshField?.compatibility !== undefined
  const client = (dshField?.client ?? {}) as Record<string, unknown>
  const hasClientInject = Array.isArray(client.inject) && client.inject.length > 0
  const dshPeers = collectDshPeers(record)
  const dshKeywords = collectDshKeywords(record)

  const reasons: string[] = []
  if (hasBundlePatch) reasons.push('package.json 声明了 dsh.bundle.patch，符合 DSH 官方插件规范')
  if (hasCompatibility) reasons.push('package.json 声明了 dsh.compatibility，说明作者做了 DSH 版本适配')
  if (hasClientInject) reasons.push('package.json 声明了 dsh.client.inject，说明该插件带有 Web GUI 端能力')
  if (dshPeers.length > 0) reasons.push(`peerDependencies 依赖 ${dshPeers.length} 个 DSH 包：${dshPeers.join(', ')}`)
  if (dshKeywords.length > 0) reasons.push(`keywords 包含 DSH 标签：${dshKeywords.join(', ')}`)

  return {
    hasBundlePatch,
    hasCompatibility,
    hasClientInject,
    dshPeers,
    dshKeywords,
    // 只要命中任一强信号即视为 DSH 插件；bundle.patch 是最高优先级信号
    isDshPlugin: hasBundlePatch || hasCompatibility || dshPeers.length > 0,
    reasons
  }
}

/** 读取 version record 的 exports['.'] 字符串入口。 */
function readExportDefault(record: NpmVersionRecord | undefined): string | undefined {
  const exportsField = record?.exports
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const dot = (exportsField as Record<string, unknown>)['.']
  if (typeof dot === 'string') return dot
  if (typeof dot === 'object' && dot !== null) {
    const value = (dot as Record<string, unknown>).default
    if (typeof value === 'string') return value
  }
  return undefined
}

/** 取 packument 的最近若干版本，按 semver 主版本降序排列。 */
function listRecentVersions(packument: NpmPackument, limit = 12): string[] {
  const versions = Object.keys(packument.versions ?? {})
  return versions
    .slice()
    .sort((a, b) => {
      const ma = parseMajorVersion(a)
      const mb = parseMajorVersion(b)
      if (ma !== null && mb !== null && ma !== mb) return mb - ma
      return b.localeCompare(a)
    })
    .slice(0, limit)
}

/** 构造 packument URL。scope 包路径为 @scope/name。 */
export function packumentUrl(registryBase: string, name: string): string {
  const normalized = normalizeRegistryBase(registryBase)
  const encoded = name.replace(/\//g, '%2f')
  return `${normalized}/${encoded}`
}

/**
 * 拉取单个插件的完整档案。
 *
 * @param name            已校验的包名
 * @param versionOrLatest 可选的版本范围 / tag；空则解析 latest
 * @param config          插件配置（提供 registry 与超时/白名单）
 */
export async function fetchPluginDossier(
  name: string,
  versionOrLatest: string | undefined,
  config: ResolvedConfig
): Promise<PluginDossier> {
  const registryBases = [config.registry, ...config.fallbackRegistries]
  const startedAt = performance.now()
  let lastError: unknown

  for (const registry of registryBases) {
    const registryBase = normalizeRegistryBase(registry)
    try {
      const packument = await httpGetJson<NpmPackument>(packumentUrl(registryBase, name), config)
      if (!packument.versions || Object.keys(packument.versions).length === 0) {
        throw new RegistryError(`registry 中不存在包 ${name} 的任何版本`, 'E_REGISTRY_EMPTY')
      }

      const distTags = packument['dist-tags'] ?? {}
      const requested = versionOrLatest?.trim()
      let version: string
      if (requested === undefined || requested === '' || requested === 'latest') {
        version = distTags.latest ?? Object.keys(packument.versions).pop() ?? ''
      } else if (packument.versions[requested] !== undefined) {
        version = requested
      } else {
        // 容错：可能传进来的是 dist-tag（next / beta）
        const tag = distTags[requested]
        if (tag === undefined) {
          throw new RegistryError(
            `包 ${name} 在 registry 中不存在版本（或 tag）"${requested}"，可用 tag：${Object.keys(distTags).join(', ') || '(无)'}`,
            'E_REGISTRY_VERSION_MISSING'
          )
        }
        version = tag
      }

      if (version.length === 0) {
        throw new RegistryError(`包 ${name} 没有 latest 版本标签`, 'E_REGISTRY_NO_LATEST')
      }

      const record = packument.versions[version] ?? ({} as NpmVersionRecord)
      const dshSignals = detectDshSignals(record)

      return {
        name,
        version,
        resolvedFromLatest: requested === undefined || requested === '' || requested === 'latest',
        description: record.description ?? packument.description,
        keywords: (record.keywords ?? packument.keywords ?? []).filter((k): k is string => typeof k === 'string'),
        license: record.license ?? packument.license,
        main: record.main,
        exportDefault: readExportDefault(record),
        dshField: readDshField(record),
        dshSignals,
        dependencies: record.dependencies ?? {},
        peerDependencies: record.peerDependencies ?? {},
        engines: record.engines,
        tarball: record.dist?.tarball,
        unpackedSize: record.dist?.unpackedSize,
        distTags,
        availableVersions: listRecentVersions(packument),
        deprecated: record.deprecated,
        registryBase,
        durationMs: Math.round(performance.now() - startedAt)
      }
    } catch (error) {
      lastError = error
      // 404 / 包不存在这类确定性失败不要继续换源；网络类失败才回退
      if (error instanceof HttpError && (error.code === 'E_HTTP_NOT_FOUND' || error.code === 'E_HTTP_HOST_BLOCKED')) {
        throw error
      }
      if (error instanceof RegistryError) throw error
      // 继续尝试下一个 registry
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new RegistryError(`无法从任何 registry 拉取 ${name} 的元数据`, 'E_REGISTRY_UNREACHABLE')
}

/** 判断 version 是否预发布（含 `-` 标识，例如 1.0.0-rc.1）。 */
export function isPrereleaseVersion(version: string): boolean {
  return /-/.test(version)
}