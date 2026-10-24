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
import type { ResolvedConfig } from './config.js';
import type { AttemptOutcome } from './types.js';
import { execToErrorLike, type PackageManager } from './exec.js';
import { type SourceKind } from './source.js';
/** 一次完整安装流程的返回值。 */
export interface InstallRunResult {
    /** 目标包名（非 npm 来源在安装前能读到 manifest 时也有值） */
    packageName: string;
    /** 最终安装版本（若成功） */
    installedVersion?: string;
    /** 是否安装成功 */
    ok: boolean;
    /** 来源类别说明 */
    source: {
        kind: SourceKind;
        label: string;
        spec: string;
    };
    /** 实际使用的 registry（非 registry 来源为固定说明文本） */
    registry: string;
    /** 实际使用的包管理器 */
    manager: PackageManager;
    /** 逐次尝试明细 */
    attempts: AttemptOutcome[];
    /** 最终的中文诊断（多条，按严重度排序） */
    diagnoses: Array<{
        code: string;
        title: string;
        detail: string;
        severity: string;
        suggestion: string;
    }>;
    /** 自检结果 */
    selfCheck: SelfCheckReport;
    /** 总耗时毫秒 */
    durationMs: number;
}
/** 安装后的可用性自检报告。 */
export interface SelfCheckReport {
    ok: boolean;
    checks: SelfCheckEntry[];
    summary: string;
}
/** 单个自检查项。 */
export interface SelfCheckEntry {
    name: string;
    ok: boolean;
    detail: string;
}
/**
 * 判断 profile 目录是否具备可安装条件。
 * 返回缺失项的中文列表，空数组代表就绪。
 */
export declare function inspectProfileReadiness(profileDir: string): Promise<string[]>;
/** 自检：确认插件已落到 profile 的 node_modules 且元数据可读。 */
export declare function runSelfCheck(options: {
    packageName: string;
    profileDir: string;
    /** registry 探测到的版本（仅作参考信息，除非 requireExactVersion 为 true） */
    expectedVersion?: string;
    /** true 时要求安装版本与 expectedVersion 严格一致（用户显式钉版本的情形） */
    requireExactVersion?: boolean;
}): Promise<SelfCheckReport>;
/** 主入口：把一个来源（npm 包 / 本地目录 / 压缩包 / git）全自动装进 DSH profile。 */
export declare function installPlugin(options: {
    /** 原始输入：包名 / 路径 / URL / git 地址 */
    spec: string;
    /** 可选：已校验的规范包名（npm 来源可由上层预传，省去二次解析） */
    packageName?: string;
    /** profile 根目录 */
    profileDir: string;
    /** 插件配置 */
    config: ResolvedConfig;
    /** 显式版本约束（仅 npm 来源生效） */
    version?: string;
    signal?: AbortSignal;
}): Promise<InstallRunResult>;
/** 读取已安装插件的真实版本号。 */
export declare function readInstalledVersion(profileDir: string, packageName: string): Promise<string | undefined>;
/** 导出 execToErrorLike 以便测试。 */
export { execToErrorLike };
//# sourceMappingURL=installer.d.ts.map