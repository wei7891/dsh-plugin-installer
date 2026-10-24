/**
 * 官方插件源（npm registry）元数据拉取与「是否 DSH 插件」识别。
 *
 * 这是「全自动识别」的第二道关卡：
 *  1. 拉 packument；
 *  2. 从 latest / 指定版本里提取 DSH 关键字段；
 *  3. 依据 dsh.bundle / dsh.compatibility / peerDependencies / keywords 判定是否 DSH 插件。
 */
import type { ResolvedConfig } from './config.js';
import type { NpmVersionRecord } from './types.js';
/** 从 packument 的描述里识别出的 DSH 能力摘要。 */
export interface DshPluginSignals {
    /** 是否声明了 dsh.bundle.patch（DSH 官方插件规范的核心字段） */
    hasBundlePatch: boolean;
    /** 是否声明了 dsh.compatibility */
    hasCompatibility: boolean;
    /** 是否声明了 client 注入（带 Web GUI 侧能力的插件） */
    hasClientInject: boolean;
    /** peerDependencies 中的 @deepseek-ai/* 清单 */
    dshPeers: string[];
    /** keyword 里的 dsh 相关标签 */
    dshKeywords: string[];
    /** 综合判定：是否是 DSH 插件 */
    isDshPlugin: boolean;
    /** 判定依据的中文摘要（返回给 Agent） */
    reasons: string[];
}
/** 归一化后的「插件档案」。 */
export interface PluginDossier {
    /** 包名 */
    name: string;
    /** 拉取到的版本 */
    version: string;
    /** 是否为 latest（未指定版本时） */
    resolvedFromLatest: boolean;
    description?: string;
    keywords: string[];
    license?: string;
    /** 解析出的包主入口 */
    main?: string;
    /** exports 字段中的 "." 入口 */
    exportDefault?: string;
    /** 版本文档中的原始 dsh 字段（原样透传，便于 Agent 细读） */
    dshField?: Record<string, unknown>;
    dshSignals: DshPluginSignals;
    /** 依赖概览 */
    dependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
    /** 引擎要求 */
    engines?: Record<string, string>;
    /** registry 提供的 tarball 地址 */
    tarball?: string;
    /** 拆包后体积 */
    unpackedSize?: number;
    /** dist-tags 全量（latest / next 等） */
    distTags: Record<string, string>;
    /** 全部可用版本（按主版本降序取最近若干条） */
    availableVersions: string[];
    /** 若该版本已废弃，registry 给出的废弃说明 */
    deprecated?: string;
    /** 实际用于拉取的 registry base */
    registryBase: string;
    /** 拉取耗时毫秒 */
    durationMs: number;
}
/** registry 拉取失败的中文错误，附带 code 供上层转成修复动作。 */
export declare class RegistryError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * 依据版本记录里的字段推断这是否一个 DSH 插件。
 * 判定强调「可证据化」——每个理由都会展现在返回给 Agent 的诊断里。
 */
export declare function detectDshSignals(record: NpmVersionRecord | undefined): DshPluginSignals;
/** 构造 packument URL。scope 包路径为 @scope/name。 */
export declare function packumentUrl(registryBase: string, name: string): string;
/**
 * 拉取单个插件的完整档案。
 *
 * @param name            已校验的包名
 * @param versionOrLatest 可选的版本范围 / tag；空则解析 latest
 * @param config          插件配置（提供 registry 与超时/白名单）
 */
export declare function fetchPluginDossier(name: string, versionOrLatest: string | undefined, config: ResolvedConfig): Promise<PluginDossier>;
/** 判断 version 是否预发布（含 `-` 标识，例如 1.0.0-rc.1）。 */
export declare function isPrereleaseVersion(version: string): boolean;
//# sourceMappingURL=registry.d.ts.map