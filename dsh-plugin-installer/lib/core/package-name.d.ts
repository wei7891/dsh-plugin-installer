/**
 * 插件包名的解析、规范化与合法性校验。
 *
 * 这是「全自动识别」的第一道关卡：Agent 传入的可能是
 * "dsh-http-tools"、"@scope/name@1.2.3"、"name@latest"、"npm i name" 等，
 * 这里统一归一化为标准 spec，并在不合法时给出中文失败原因。
 */
import type { ParsedPackageName } from './types.js';
/**
 * 解析并校验一个插件包名 / 安装规格。
 *
 * @param raw Agent 传入的原始字符串
 */
export declare function parsePackageName(raw: unknown): ParsedPackageName;
/**
 * 判断一个包是否属于 DSH 插件生态。
 * 判定依据：包名位于官方命名空间下。
 */
export declare function isDshPackageName(name: string): boolean;
/**
 * 构造用于 `pnpm add` / `npm install` 的标准 spec。
 * 无版本约束时省略 @version，交由包管理器解析 latest。
 */
export declare function buildInstallSpec(name: string, version?: string): string;
/** 规范化版本字符串 → semver 主版本数字。失败返回 null。 */
export declare function parseMajorVersion(version: string): number | null;
/**
 * 判断传入的字符串是否指向「本地路径 / git / tarball」等非官方源。
 * 本插件只支持从官方插件源安装，遇到本地来源要给出中文拒绝理由。
 *
 * @param raw 原始输入（未做包名校验）
 * @returns 命中的原始关键词；未命中返回 undefined
 */
export declare function detectNonRegistrySource(raw: string): string | undefined;
/** 把 detectNonRegistrySource 命中的关键词转成中文来源说明。 */
export declare function describeNonRegistrySource(hint: string): string;
/** DSH 命名空间常量集中导出，便于测试引用。 */
export declare const DSH_PLUGIN_SCOPES: readonly ["@deepseek-ai/", "dsh-"];
//# sourceMappingURL=package-name.d.ts.map