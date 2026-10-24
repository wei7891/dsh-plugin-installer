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

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** profile 根 package.json 的相关结构。 */
export interface ProfileManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** 读取并解析 profile 的 package.json。 */
export function readProfileManifest(profileDir: string): ProfileManifest {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as ProfileManifest
}

/** 查询某个包在 dependencies / devDependencies 里的原始声明；未安装返回 undefined。 */
export function findDependencySpec(manifest: ProfileManifest, name: string): string | undefined {
  return manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
}

/** 查询某个插件是否已在 bundles 中声明。 */
export function isBundled(manifest: ProfileManifest, name: string): boolean {
  return (manifest.dsh?.profile?.bundles ?? []).includes(name)
}

/** 原子写回 profile 的 package.json（2 空格缩进 + 结尾换行）。 */
function writeManifest(profileDir: string, manifest: ProfileManifest): void {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * 把插件加入 dsh.profile.bundles。
 *
 * @returns true 表示本次发生了变更；false 表示已存在（幂等）
 */
export function addBundleEntry(profileDir: string, name: string): boolean {
  const manifest = readProfileManifest(profileDir)
  const dsh = (manifest.dsh ??= {})
  const profile = (dsh.profile ??= {})
  const bundles = (profile.bundles ??= [])
  if (bundles.includes(name)) return false
  bundles.push(name)
  writeManifest(profileDir, manifest)
  return true
}

/**
 * 从 dsh.profile.bundles 移除插件条目。
 *
 * @returns true 表示本次发生了变更；false 表示原本就不在列表里
 */
export function removeBundleEntry(profileDir: string, name: string): boolean {
  const manifest = readProfileManifest(profileDir)
  const bundles = manifest.dsh?.profile?.bundles
  if (bundles === undefined || !bundles.includes(name)) return false
  manifest.dsh!.profile!.bundles = bundles.filter((entry) => entry !== name)
  writeManifest(profileDir, manifest)
  return true
}
