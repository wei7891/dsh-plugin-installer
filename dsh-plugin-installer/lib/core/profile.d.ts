/**
 * profile 清单与 dsh.profile.bundles 条目的编辑能力。
 *
 * 这是裸命令做不到的「DSH 语义」操作：
 *  - 插件装进 node_modules 只是第一步，还必须在 profile 的
 *    dsh.profile.bundles 里声明才会被 Loader 加载；
 *  - 卸载时若不清理 bundles 条目，下次启动 Loader 会报
 *    「cannot resolve profile bundle」。
 * 本模块把这两个容易被 Agent 忘掉的步骤变成原子操作。
 */
/** profile 根 package.json 的相关结构。 */
export interface ProfileManifest {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    dsh?: {
        profile?: {
            bundles?: string[];
        };
    };
}
/** 读取并解析 profile 的 package.json。 */
export declare function readProfileManifest(profileDir: string): ProfileManifest;
/** 查询某个包在 dependencies / devDependencies 里的原始声明；未安装返回 undefined。 */
export declare function findDependencySpec(manifest: ProfileManifest, name: string): string | undefined;
/** 查询某个插件是否已在 bundles 中声明。 */
export declare function isBundled(manifest: ProfileManifest, name: string): boolean;
/**
 * 把插件加入 dsh.profile.bundles。
 *
 * @returns true 表示本次发生了变更；false 表示已存在（幂等）
 */
export declare function addBundleEntry(profileDir: string, name: string): boolean;
/**
 * 从 dsh.profile.bundles 移除插件条目。
 *
 * @returns true 表示本次发生了变更；false 表示原本就不在列表里
 */
export declare function removeBundleEntry(profileDir: string, name: string): boolean;
//# sourceMappingURL=profile.d.ts.map