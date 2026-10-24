/**
 * 安装来源识别。
 *
 * 插件的核心能力是「自动装插件」，因此必须能吃下 Agent 传来的各种形态：
 *  - npm 包名：dsh-plugin / @scope/name / name@1.2.3 / registry URL
 *  - git 仓库：git+https://github.com/x/y.git / github:owner/repo
 *  - 本地目录：D:\dev\my-plugin / ./my-plugin / file:../my-plugin
 *  - 本地压缩包：D:\downloads\plugin.zip / plugin.tgz
 *  - 远程压缩包：https://example.com/plugin.zip / .../plugin.tgz
 *
 * 识别顺序刻意把 git 特征放在 http(s) 之前——git+https:// 本身也含
 * https://，顺序反了会被误判成远程压缩包/registry URL。
 */
/** 来源类别。 */
export type SourceKind = 'npm' | 'git' | 'local-dir' | 'local-archive' | 'remote-archive';
/** 识别结果：交给安装编排器的归一化描述。 */
export interface IdentifiedSource {
    kind: SourceKind;
    /**
     * 可直接交给 pnpm 的安装标识：
     *  - npm          → name 或 name@version
     *  - git          → git+https://... （保留原始形态）
     *  - local-dir    → file: 绝对路径
     *  - local-archive→ file: 绝对路径（tgz 直装）或物化后的目录
     *  - remote-archive → https URL（tgz 直装）或物化后的目录
     */
    spec: string;
    /** npm 包名（仅 kind=npm 时有值） */
    packageName?: string;
    /** npm 版本约束（仅 kind=npm 时可能有值） */
    version?: string;
    /** 本地压缩包 / 目录的绝对路径 */
    localPath?: string;
    /** 远程压缩包 URL（仅 kind=remote-archive） */
    url?: string;
    /** git 仓库地址（仅 kind=git） */
    gitUrl?: string;
    /** 归档是否是 zip（需要先解压；tgz 可直接被 pnpm 消费或解压） */
    isZip?: boolean;
    /** 识别失败时的中文原因 */
    reason?: string;
}
/**
 * 识别安装来源。
 *
 * @param raw Agent 传入的原始字符串
 * @param options.cwd 相对路径的解析基准（默认 process.cwd()）
 */
export declare function identifySource(raw: unknown, options?: {
    cwd?: string;
}): IdentifiedSource;
/** 来源类别的中文名（用于诊断消息）。 */
export declare const SOURCE_KIND_LABELS: Record<SourceKind, string>;
//# sourceMappingURL=source.d.ts.map