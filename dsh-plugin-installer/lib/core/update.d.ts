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
import { readFile } from 'node:fs/promises';
import type { ResolvedConfig } from './config.js';
import type { AttemptOutcome, Diagnosis } from './types.js';
/** 单个已安装插件的版本对比结果。 */
export interface PluginUpdateEntry {
    /** 包名 */
    name: string;
    /** profile 里的原始依赖声明（如 ^1.2.0 / link:... / file:...） */
    declared: string;
    /** 当前安装版本；读不到为 undefined */
    installedVersion?: string;
    /** registry 最新版本；非 registry 来源为 undefined */
    latestVersion?: string;
    /** 是否有可用更新 */
    updateAvailable: boolean;
    /** 来源类别说明（registry / link / 本地路径） */
    sourceKind: 'registry' | 'link' | 'local';
    /** 中文说明（为什么不能更新 / 为什么建议更新） */
    note: string;
}
/** 扫描结果。 */
export interface UpdateScanResult {
    /** 全部已解析依赖条目 */
    entries: PluginUpdateEntry[];
    /** 可更新条目数 */
    updatable: number;
    /** 无法从 registry 获取版本的条目数（link/本地/内部包） */
    skipped: number;
    /** 扫描过程中的中文警告（registry 不可达等） */
    warnings: string[];
}
/** 版本对比结果。 */
export interface UpdateRunResult {
    name: string;
    ok: boolean;
    /** 更新前版本 */
    previousVersion?: string;
    /** 更新后版本 */
    newVersion?: string;
    /** 是否触发了回滚（更新失败后恢复旧版） */
    rolledBack: boolean;
    /** 回滚是否成功 */
    rollbackOk?: boolean;
    /** 逐步尝试明细 */
    attempts: AttemptOutcome[];
    /** 最终中文诊断 */
    diagnoses: Diagnosis[];
    /** 自检结果摘要 */
    selfCheckSummary?: string;
    /** 总耗时 */
    durationMs: number;
}
/**
 * 扫描 profile 中的全部依赖，对比 registry 最新版。
 *
 * @param profileDir DSH profile 根目录
 * @param config 插件配置（registry / 超时）
 */
export declare function scanUpdates(profileDir: string, config: ResolvedConfig): Promise<UpdateScanResult>;
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
export declare function updatePlugin(options: {
    packageName: string;
    profileDir: string;
    config: ResolvedConfig;
    version?: string;
    signal?: AbortSignal;
}): Promise<UpdateRunResult>;
/** 校验目标包在 profile 的 node_modules 里真实存在（供卸载前确认）。 */
export declare function isPackagePresent(profileDir: string, packageName: string): boolean;
/** 读取已装包的版本（薄封装，便于工具层调用）。 */
export declare function installedVersionOf(profileDir: string, packageName: string): Promise<string | undefined>;
/** 读取 profile 中某依赖的原始声明。 */
export declare function declaredSpec(profileDir: string, packageName: string): string | undefined;
/** 卸载插件：pnpm remove + 清理 bundles 条目 + 校验结果。 */
export declare function uninstallPlugin(options: {
    packageName: string;
    profileDir: string;
    config: ResolvedConfig;
    /** 是否同时从 dsh.profile.bundles 移除（默认 true） */
    removeFromBundles?: boolean;
    signal?: AbortSignal;
}): Promise<{
    name: string;
    ok: boolean;
    removedDependency: boolean;
    removedBundleEntry: boolean;
    diagnoses: Diagnosis[];
    durationMs: number;
}>;
/** 供测试引用：读取已装版本。 */
export { readFile };
//# sourceMappingURL=update.d.ts.map