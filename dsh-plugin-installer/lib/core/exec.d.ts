/**
 * npm / pnpm 子进程执行封装。
 *
 * 设计要点（对应需求中的「自动执行 npm 相关命令」与「全局捕获执行报错」）：
 *  - 使用 node:child_process.spawn，参数按数组传递、绝不使用 shell，
 *    因此包名里的空格 / 引号 / 分号都无法越权成命令注入；
 *  - stdout / stderr 通过「临时文件重定向」采集，而不是默认的 pipe。
 *    这一点是 DSH 运行环境的硬约束：DSH 沙箱禁用了命名管道，
 *    spawn 使用 stdio: 'pipe' 会直接抛 EPERM。改为把子进程的
 *    fd 1 / fd 2 指到临时文件（stdio 数组形式），退出后再读回内容，
 *    既绕开了管道限制，又能把输出喂给中文诊断器；
 *  - Windows 下 pnpm / npm 往往不是独立可执行文件，需要显式解析（见下）；
 *  - 每次执行都记录完整命令行，供后续修复重放与日志审计。
 */
import type { ExecResult } from './types.js';
/** 包管理器可执行类型。 */
export type PackageManager = 'pnpm' | 'npm';
/** 执行一项 npm 命令所需的完整参数。 */
export interface NpmCommandSpec {
    /** 使用的包管理器 */
    manager: PackageManager;
    /** 目标目录（profile 根目录），命令在此目录下执行 */
    cwd: string;
    /** npm 参数，例如 ['add', 'dsh-http-tools'] */
    args: string[];
    /** registry 覆盖地址 */
    registry?: string;
    /** 追加在末尾的自定义参数（例如 --legacy-peer-deps） */
    extraArgs?: string[];
    /** 需要注入的环境变量 */
    env?: Record<string, string>;
}
/** 一条中文执行前/后日志（供上层汇总）。 */
export interface ExecLog {
    command: string;
    cwd: string;
    durationMs: number;
    exitCode: number | null;
    stdoutTail: string;
    stderrTail: string;
}
/**
 * 解析出的包管理器可执行项。
 *
 * Node 平台下 npm / pnpm 往往不是独立的可执行文件：
 *  - npm 在 Node 安装目录下是 npm.cmd（Windows）或 npm 壳脚本（POSIX）；
 *  - pnpm 在 DSH 运行时里是一个 .mjs 入口（bin/pnpm.mjs），必须交给
 *    node 加上该路径才能执行。
 * 因此这里用「可执行文件 + 前置参数」二元组表达，而不是单个可执行路径。
 */
export interface ManagerExecutable {
    /** 真正要被 spawn 的可执行文件（Windows 下为 node.exe / npm.cmd 等） */
    executable: string;
    /** 放在 npm 参数之前的固定前置参数（例如 node 执行 pnpm.mjs 的路径） */
    preArgs: string[];
    /** 人类可读的命令标识，用于日志与回放 */
    display: string;
}
/**
 * 解析包管理器的可执行项。
 *
 * 解析顺序（每步都可能命中）：
 *  1. 优先使用 DSH 自带运行时（本进程就在其中运行，版本确定可靠）：
 *     - pnpm：runtime/pnpm/bin/pnpm.mjs，由 node 执行；
 *     - npm：runtime/node 下的 npm-cli.js，由 node 执行；
 *  2. PATH 中查找原生可执行文件（Windows 下 pnpm.cmd / npm.cmd）；
 *  3. 兜底：返回裸名字符串，交给 PATH 行为决定能否执行（失败时给出中文诊断）。
 *
 * 为什么把 DSH 运行时放在 PATH 之前：在 DSH 沙箱内 spawn 一个 .cmd 会
 * 触发 EINVAL（需要 cmd.exe 上下文），而「node 执行 .mjs / .js」始终可用。
 * 同时 DSH 自带运行时与当前 DSH 版本严格配套，避免用户 PATH 里的旧版
 * pnpm / npm 造成行为差异。
 *
 * 注意：DSH 分发的 Node 运行时不包含 npm，只带 pnpm。因此 npm 会从前两步
 * 逐一降级，最终落到「用 node 执行 npm-cli.js」；若运行时里确实没有 npm，
 * 则由安装编排器在诊断出 E_MANAGER_NOT_FOUND 后切换到 pnpm 完成安装。
 *
 * 注释约定：本文件注释中不写块注释终止符与星号斜杠的组合，避免提前闭合。
 */
export declare function resolveManagerExecutable(manager: PackageManager): ManagerExecutable;
/**
 * 把可执行项与参数拼成可读命令串（用于日志与回放）。
 *
 * @param entry 解析出的包管理器可执行项（含可能的前置参数）
 * @param args  npm/pnpm 自身的参数
 */
export declare function formatCommand(entry: ManagerExecutable, args: string[]): string;
/** 实际交给 spawn 的完整参数数组（前置参数 + npm 参数）。 */
export declare function spawnArgsOf(entry: ManagerExecutable, args: string[]): string[];
/** 截取输出尾部，保留最有诊断价值的若干行。 */
export declare function tailLines(text: string, maxLines?: number, maxChars?: number): string;
/**
 * 执行一条 npm/pnpm 命令。
 *
 * 输出采集方式：把子进程的 stdout / stderr 重定向到两个临时文件
 * （stdio 数组形式 ['ignore', fdOut, fdErr]），进程退出后再读回文件内容。
 * 这样绕开了 DSH 沙箱禁用命名管道导致的 stdio 管道 EPERM。
 *
 * @param spec    命令规格
 * @param options 超时（毫秒）；超时后 kill 子进程并标记 timedOut
 */
export declare function runNpmCommand(spec: NpmCommandSpec, options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<ExecResult>;
/** 把 ExecResult 转成 Node 风格的 error 字段形式（便于诊断器统一处理）。 */
export declare function execToErrorLike(result: ExecResult): {
    code: number | null;
    signal: string | null;
    timedOut: boolean;
    message: string;
    stdout: string;
    stderr: string;
};
//# sourceMappingURL=exec.d.ts.map