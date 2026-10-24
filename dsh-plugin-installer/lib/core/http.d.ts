/**
 * 内置 HTTP 网络能力。
 *
 * 插件只访问 npm registry 的公开只读接口（packument / 版本 meta），
 * 并且带 host 白名单、大小上限、超时控制。
 */
import type { HttpResult } from './types.js';
import type { ResolvedConfig } from './config.js';
/** HTTP 失败时统一抛出的错误类型，附带机器可读 code。 */
export declare class HttpError extends Error {
    readonly code: string;
    readonly status?: number;
    constructor(message: string, code: string, status?: number);
}
/** registry host 白名单：默认只允许官方 npm 源与国内镜像。 */
export declare const DEFAULT_ALLOWED_HOSTS: string[];
/** 校验目标 URL 是否在允许的 host 列表内，否则抛 HttpError。 */
export declare function assertAllowedUrl(rawUrl: string, config: ResolvedConfig): URL;
/** 通用 GET：带 host 白名单、超时、大小上限。失败抛 HttpError（错误消息为中文）。 */
export declare function httpGet(rawUrl: string, config: ResolvedConfig, options?: {
    timeoutMs?: number;
    maxBodyChars?: number;
    signal?: AbortSignal;
}): Promise<HttpResult>;
/** GET 并解析 JSON；失败时错误消息为中文。 */
export declare function httpGetJson<T>(rawUrl: string, config: ResolvedConfig, signal?: AbortSignal): Promise<T>;
/** 移除结尾斜杠，便于拼接 registry 路径。 */
export declare function normalizeRegistryBase(registry: string): string;
//# sourceMappingURL=http.d.ts.map