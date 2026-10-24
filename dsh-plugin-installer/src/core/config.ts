/**
 * 插件配置解析与默认值。
 * 所有字段在 cordis.patch.yml 的 `config` 节点中可选，未提供时使用安全默认值。
 */

/** 插件对外可配置项。 */
export interface PluginInstallerConfig {
  /** 允许使用的包管理器。默认 ['pnpm','npm']，pnpm 优先。 */
  packageManager?: 'pnpm' | 'npm'
  /** 安装时使用的 npm registry 地址 */
  registry?: string
  /** 额外 registry（用于主源不可达时按顺序回退） */
  fallbackRegistries?: string[]
  /** 单条命令执行的硬超时（毫秒） */
  installTimeoutMs?: number
  /** 全流程（含自动修复重试）的总超时（毫秒） */
  totalBudgetMs?: number
  /** 单次安装允许的最大自动修复尝试轮数 */
  maxRepairAttempts?: number
  /** HTTP 请求（拉取元数据 / registry 探测）超时 */
  httpTimeoutMs?: number
  /** 拉取 HTTP 响应体最大字符数 */
  httpMaxBodyChars?: number
  /** 允许的 registry host 白名单；为空表示仅用默认白名单 */
  allowedRegistryHosts?: string[]
  /** 是否在安装后自动执行可用性自检 */
  autoVerify?: boolean
}

/** 解析后的完整配置。 */
export interface ResolvedConfig {
  packageManager: 'pnpm' | 'npm'
  registry: string
  fallbackRegistries: string[]
  installTimeoutMs: number
  totalBudgetMs: number
  maxRepairAttempts: number
  httpTimeoutMs: number
  httpMaxBodyChars: number
  allowedRegistryHosts: string[]
  autoVerify: boolean
}

/** DSH 官方 npm registry —— 插件安装的强制性数据源。 */
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org'

/** 官方 registry 主机名，用于 host 白名单校验。 */
export const OFFICIAL_REGISTRY_HOST = 'registry.npmjs.org'

/** 中国区常用镜像 registry（主源超时时的国内回退源）。 */
export const CN_MIRROR_REGISTRY = 'https://registry.npmmirror.com'

/** 需要校验为正整数的字段。 */
const POSITIVE_INTEGER_FIELDS = [
  'installTimeoutMs',
  'totalBudgetMs',
  'maxRepairAttempts',
  'httpTimeoutMs',
  'httpMaxBodyChars'
] as const

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * 读取原始配置并补全默认值，对非法值抛出带中文原因的 Error。
 * 调用方（插件 apply 阶段）会把它转成中文诊断。
 */
export function resolveConfig(config?: PluginInstallerConfig): ResolvedConfig {
  if (config !== undefined && (typeof config !== 'object' || config === null)) {
    throw new Error('dsh-plugin-installer: config 必须是对象')
  }

  for (const field of POSITIVE_INTEGER_FIELDS) {
    const value = config?.[field]
    if (value !== undefined && !isPositiveInteger(value)) {
      throw new Error(`dsh-plugin-installer: ${field} 必须是正整数`)
    }
  }

  if (config?.packageManager !== undefined && config.packageManager !== 'pnpm' && config.packageManager !== 'npm') {
    throw new Error('dsh-plugin-installer: packageManager 只能是 "pnpm" 或 "npm"')
  }

  const registry = config?.registry ?? OFFICIAL_REGISTRY
  if (!isHttpUrl(registry)) {
    throw new Error(`dsh-plugin-installer: registry 必须是合法的 http(s) 地址，收到 "${String(registry)}"`)
  }

  const fallbackRegistries = (config?.fallbackRegistries ?? []).map((item) => {
    if (!isHttpUrl(item)) {
      throw new Error(`dsh-plugin-installer: fallbackRegistries 中的 "${String(item)}" 不是合法的 http(s) 地址`)
    }
    return item
  })

  const allowedRegistryHosts = (config?.allowedRegistryHosts ?? []).map((host) => {
    if (typeof host !== 'string' || host.length === 0) {
      throw new Error('dsh-plugin-installer: allowedRegistryHosts 只能包含非空字符串')
    }
    return host.toLowerCase()
  })

  return {
    packageManager: config?.packageManager ?? 'pnpm',
    registry,
    fallbackRegistries,
    installTimeoutMs: config?.installTimeoutMs ?? 10 * 60 * 1000,
    totalBudgetMs: config?.totalBudgetMs ?? 15 * 60 * 1000,
    maxRepairAttempts: config?.maxRepairAttempts ?? 3,
    httpTimeoutMs: config?.httpTimeoutMs ?? 15_000,
    httpMaxBodyChars: config?.httpMaxBodyChars ?? 256 * 1024,
    allowedRegistryHosts,
    autoVerify: config?.autoVerify ?? true
  }
}