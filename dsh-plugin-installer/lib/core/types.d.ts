/**
 * 公共类型定义。
 * 所有对外返回给 Agent 的结构统一为「可 JSON 序列化 + 含中文诊断字段」。
 */
/** 一个 npm 包名的合法性要求：支持 scope，例如 @scope/name。 */
export interface ParsedPackageName {
    /** 是否通过了包名校验 */
    ok: boolean;
    /** 规范化后的完整包名（如 @deepseek-ai/dsh-tools） */
    name?: string;
    /** 作用域（scope），无作用域包为 undefined */
    scope?: string;
    /** 去掉 scope 后的裸包名 */
    bare?: string;
    /** 版本范围（tag / semver range），无则 undefined */
    version?: string;
    /** 校验失败时的中文原因 */
    reason?: string;
}
/** npm registry 的 packument（包元数据）中的单条版本记录。 */
export interface NpmVersionRecord {
    name: string;
    version: string;
    description?: string;
    keywords?: string[];
    license?: string;
    /** 主入口（CommonJS main） */
    main?: string;
    /** exports 字段原文 */
    exports?: unknown;
    /** 依赖（生产依赖） */
    dependencies?: Record<string, string>;
    /** 对等依赖 —— DSH 生态的核心信号 */
    peerDependencies?: Record<string, string>;
    /** 对等依赖元信息（标记可选对等依赖） */
    peerDependenciesMeta?: Record<string, {
        optional?: boolean;
    }>;
    dist?: {
        tarball?: string;
        shasum?: string;
        integrity?: string;
        unpackedSize?: number;
        fileCount?: number;
    };
    engines?: Record<string, string>;
    /** 该版本是否已被作者标记废弃，registry 给出废弃说明 */
    deprecated?: string;
    /** DSH 插件规范字段原文，保留原样便于 Agent 细读 */
    dsh?: unknown;
}
/** npm registry 的 packument。 */
export interface NpmPackument {
    _id?: string;
    name?: string;
    'dist-tags'?: Record<string, string>;
    versions?: Record<string, NpmVersionRecord>;
    time?: Record<string, string>;
    license?: string;
    keywords?: string[];
    description?: string;
    homepage?: string;
    maintainers?: Array<{
        name: string;
        email?: string;
    }>;
    repository?: {
        type?: string;
        url?: string;
    } | string;
}
/** 一次 HTTP 请求的归一化结果。 */
export interface HttpResult {
    ok: boolean;
    status: number;
    statusText: string;
    durationMs: number;
    /** 响应体文本（可能被截断） */
    body: string;
    /** 响应体是否被 maxBodyChars 截断 */
    truncated: boolean;
    /** 发起请求时使用的最终 URL（跟随重定向后） */
    url: string;
    /** 原始字节大小 */
    sizeBytes: number;
}
/** 一条子进程执行结果。 */
export interface ExecResult {
    /** 退出码；被信号终止时为 null */
    code: number | null;
    /** 触发终止的信号名，正常退出为 null */
    signal: string | null;
    /** 合并后的标准输出 */
    stdout: string;
    /** 合并后的标准错误 */
    stderr: string;
    /** 实际执行的命令（便于回放与诊断） */
    command: string;
    /** 耗时毫秒 */
    durationMs: number;
    /** 是否超时被杀 */
    timedOut: boolean;
}
/** 故障严重级别。 */
export type Severity = 'info' | 'warn' | 'error';
/** 一条中文诊断结论。 */
export interface Diagnosis {
    /** 稳定分类标识，如 E_NETWORK_TIMEOUT */
    code: string;
    /** 中文标题，例如「网络下载超时」 */
    title: string;
    /** 中文详细说明 */
    detail: string;
    severity: Severity;
    /** 给 Agent 的中文处理建议（可执行动作） */
    suggestion: string;
    /** 本条诊断命中的原始证据片段 */
    evidence?: string;
}
/** 一条修复动作记录。 */
export interface RepairAction {
    /** 动作类型 */
    kind: 'switch-package-manager' | 'add-registry' | 'clear-cache' | 'retry' | 'strip-lockfile' | 'prune-node-modules' | 'legacy-peer-deps' | 'normalize-spec' | 'exact-pin' | 'use-official-registry' | 'reinstall';
    /** 中文说明，展示给 Agent */
    label: string;
    /** 动作附带的可选参数 */
    payload?: Record<string, string>;
}
/** 一次安装尝试的结果。 */
export interface AttemptOutcome {
    /** 第几次尝试（从 1 开始） */
    index: number;
    /** 本次执行的命令 */
    command: string;
    ok: boolean;
    /** 退出码 */
    exitCode: number | null;
    /** 是否因超时被终止 */
    timedOut: boolean;
    /** 本步全部诊断 */
    diagnoses: Diagnosis[];
    /** 本步触发的修复动作（下一步据此调整命令） */
    repairs: RepairAction[];
    /** 耗时毫秒 */
    durationMs: number;
    /** stdout / stderr 摘要（截断后的最后若干行） */
    outputTail: string;
}
//# sourceMappingURL=types.d.ts.map