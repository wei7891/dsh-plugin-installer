/**
 * 压缩包物化：下载 / 解压，把「本地或远程压缩包」变成可安装的本地目录。
 *
 * 设计要点：
 *  - 解压统一走系统自带的 bsdtar（Windows System32\tar.exe，POSIX tar），
 *    它同时支持 zip 与 tgz，无需第三方依赖；
 *  - 子进程同样走「临时文件重定向」采集输出，绕开 DSH 沙箱的管道限制；
 *  - 远程下载用内置 fetch 流式写入临时文件，仅允许 https，且有大小上限，
 *    防止 Agent 被诱导下载超大文件耗尽磁盘；
 *  - zip 解压后自动识别「顶层单目录」布局（GitHub 下载的 zip 都是这种），
 *    返回真正含 package.json 的目录。
 */
/** 远程压缩包大小上限：100 MB（DSH 插件远小于此值）。 */
export declare const MAX_ARCHIVE_BYTES: number;
/** 物化失败的中文错误。 */
export declare class MaterializeError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * 解压本地压缩包，返回含 package.json 的目录。
 *
 * @param archivePath 压缩包绝对路径
 */
export declare function extractLocalArchive(archivePath: string): Promise<string>;
/**
 * 下载远程压缩包到临时文件（仅 https，流式写入，带大小上限）。
 *
 * @returns 临时文件绝对路径
 */
export declare function downloadArchive(url: string, timeoutMs?: number): Promise<string>;
/** 下载并解压远程压缩包，返回含 package.json 的目录。 */
export declare function materializeRemoteArchive(url: string, timeoutMs?: number): Promise<string>;
//# sourceMappingURL=archive.d.ts.map