/**
 * 内置 HTTP 网络能力。
 *
 * 插件只访问 npm registry 的公开只读接口（packument / 版本 meta），
 * 并且带 host 白名单、大小上限、超时控制。
 */

import type { HttpResult } from './types.js'
import type { ResolvedConfig } from './config.js'

/** HTTP 失败时统一抛出的错误类型，附带机器可读 code。 */
export class HttpError extends Error {
  readonly code: string
  readonly status?: number
  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    this.status = status
  }
}

/** registry host 白名单：默认只允许官方 npm 源与国内镜像。 */
export const DEFAULT_ALLOWED_HOSTS = ['registry.npmjs.org', 'registry.npmmirror.com', 'replicate.npmjs.com']

function normalizeHosts(config: ResolvedConfig): string[] {
  const extra = config.allowedRegistryHosts
  if (extra.length > 0) return [...extra, ...DEFAULT_ALLOWED_HOSTS]
  return DEFAULT_ALLOWED_HOSTS
}

/** 校验目标 URL 是否在允许的 host 列表内，否则抛 HttpError。 */
export function assertAllowedUrl(rawUrl: string, config: ResolvedConfig): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new HttpError(`非法的 URL：${rawUrl}`, 'E_HTTP_BAD_URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpError(`仅支持 http/https 协议，收到 ${url.protocol}`, 'E_HTTP_BAD_PROTOCOL')
  }
  const hosts = normalizeHosts(config)
  if (!hosts.includes(url.hostname.toLowerCase())) {
    throw new HttpError(
      `目标主机 ${url.hostname} 不在允许的 registry 白名单内（${hosts.join(', ')}）`,
      'E_HTTP_HOST_BLOCKED'
    )
  }
  return url
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

/** 通用 GET：带 host 白名单、超时、大小上限。失败抛 HttpError（错误消息为中文）。 */
export async function httpGet(
  rawUrl: string,
  config: ResolvedConfig,
  options: { timeoutMs?: number; maxBodyChars?: number; signal?: AbortSignal } = {}
): Promise<HttpResult> {
  const url = assertAllowedUrl(rawUrl, config)
  const timeoutMs = options.timeoutMs ?? config.httpTimeoutMs
  const maxBodyChars = options.maxBodyChars ?? config.httpMaxBodyChars

  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = performance.now()

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.npm.install-v1+json, application/json;q=0.9, */*;q=0.5',
        'user-agent': 'dsh-plugin-installer/0.1.0 (+https://github.com/deepseek-ai/deepseek-harness)'
      },
      signal: controller.signal,
      redirect: 'follow'
    })
  } catch (error) {
    if (options.signal) options.signal.removeEventListener('abort', onOuterAbort)
    clearTimeout(timer)
    if (options.signal?.aborted) throw new HttpError('HTTP 请求已被取消', 'E_HTTP_ABORTED')
    if (controller.signal.aborted) {
      throw new HttpError(`HTTP 请求超时（超过 ${timeoutMs}ms）`, 'E_HTTP_TIMEOUT')
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new HttpError(`HTTP 请求失败：${message}`, 'E_HTTP_NETWORK')
  } finally {
    clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', onOuterAbort)
  }

  let body = ''
  let truncated = false
  let sizeBytes = 0
  if (response.body) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const chunks: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        sizeBytes += value.byteLength
        chunks.push(decoder.decode(value, { stream: true }))
      }
    }
    chunks.push(decoder.decode())
    const limited = truncate(chunks.join(''), maxBodyChars)
    body = limited.text
    truncated = limited.truncated
  }

  if (!response.ok) {
    throw new HttpError(
      `registry 返回 ${response.status} ${response.statusText}`,
      response.status === 404 ? 'E_HTTP_NOT_FOUND' : 'E_HTTP_UPSTREAM',
      response.status
    )
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    durationMs: Math.round(performance.now() - startedAt),
    body,
    truncated,
    url: response.url,
    sizeBytes
  }
}

/** GET 并解析 JSON；失败时错误消息为中文。 */
export async function httpGetJson<T>(rawUrl: string, config: ResolvedConfig, signal?: AbortSignal): Promise<T> {
  const result = await httpGet(rawUrl, config, { signal })
  try {
    return JSON.parse(result.body) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new HttpError(`解析 registry JSON 响应失败：${message}`, 'E_HTTP_BAD_JSON')
  }
}

/** 移除结尾斜杠，便于拼接 registry 路径。 */
export function normalizeRegistryBase(registry: string): string {
  return registry.replace(/\/+$/, '')
}