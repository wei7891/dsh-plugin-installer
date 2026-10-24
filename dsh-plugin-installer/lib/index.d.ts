/**
 * dsh-plugin-installer —— DSH 插件全生命周期管理助手。
 *
 * 目标：给 Agent 提供「装、查、更、卸、启」一条龙的标准化工具。
 * 装插件是核心能力（5 种来源全自动），诊断是辅助能力；更新/卸载/启用
 * 是裸命令做不好的「DSH 语义」操作（bundles 条目联动、失败回滚）。
 *
 * 对外暴露 8 个工具：
 *
 *  1. install_dsh_plugin      —— 核心。5 种来源全自动安装（npm/本地目录/本地压缩包/远程压缩包/git）
 *  2. dsh_plugin_inspect      —— 安装前核对：元数据 / DSH 兼容性 / 可用版本
 *  3. dsh_plugin_registry_check —— 官方源 / 镜像源连通性探测
 *  4. dsh_plugin_diagnose     —— 纯诊断：npm/pnpm 报错 → 中文根因 + 修复建议
 *  5. dsh_plugin_outdated     —— 扫描可更新插件（对比 registry 最新版，识别本地依赖）
 *  6. update_dsh_plugin       —— 更新单个插件，失败自动回滚到更新前版本
 *  7. remove_dsh_plugin       —— 卸载插件并同步清理 bundles 条目（防孤儿条目）
 *  8. enable_dsh_plugin       —— 把已装未启用的插件补进 bundles（启用加载）
 *
 * 安全边界（硬约束）：
 *  - npm 元数据只访问官方 registry（host 白名单）；远程压缩包仅 https；
 *  - 只执行「安装/更新/卸载/元数据查询」类子命令，不提供任意命令执行；
 *  - 所有子进程都不经过 shell，避免命令注入。
 */
import { type PluginInstallerConfig } from './core/config.js';
import { HttpError } from './core/http.js';
/** Cordis 插件名：出现在 Loader 诊断与日志中。 */
export declare const name = "dsh-plugin-installer";
/** 需要注入的服务：仅 tools。 */
export declare const inject: string[];
/** 定位 DSH profile 根目录。 */
export declare function resolveProfileDir(): string;
/**
 * 插件入口。
 * config 全部可选，未提供时每一项都有安全默认值（见 core/config.ts）。
 */
export declare function apply(ctx: any, config?: PluginInstallerConfig): void;
export { parsePackageName, detectNonRegistrySource, isDshPackageName } from './core/package-name.js';
export { diagnoseCommandOutput, diagnosisRuleCount } from './core/diagnose.js';
export { fetchPluginDossier, packumentUrl, detectDshSignals } from './core/registry.js';
export { identifySource, SOURCE_KIND_LABELS } from './core/source.js';
export { installPlugin, inspectProfileReadiness, runSelfCheck, readInstalledVersion } from './core/installer.js';
export { scanUpdates, updatePlugin, uninstallPlugin } from './core/update.js';
export { addBundleEntry, removeBundleEntry, isBundled, readProfileManifest } from './core/profile.js';
export { HttpError };
export type { PluginInstallerConfig, ResolvedConfig } from './core/config.js';
//# sourceMappingURL=index.d.ts.map