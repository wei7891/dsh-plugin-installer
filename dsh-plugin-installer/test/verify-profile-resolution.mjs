/**
 * 验证 profile 能按 DSH Loader 的方式解析 bundle "dsh-plugin-installer"：
 *  1. profile/node_modules 中可解析到包目录（symlink 或实体）
 *  2. package.json 的 main 入口文件存在
 *  3. dsh.bundle.patch 指向的 cordis.patch.yml 存在且含 insert 节点
 *  4. 入口模块可被 import，且导出 name / inject / apply
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const profileDir = 'C:/Users/wei/.dsh/profiles/desktop'
const require = createRequire(join(profileDir, 'package.json'))

function fail(msg) { console.error('❌ ' + msg); process.exit(1) }

// 1. 解析包路径（与 Node/Loader 的 bare specifier 解析一致）
let pkgDir
try {
  pkgDir = require.resolve('dsh-plugin-installer/package.json')
} catch (e) {
  fail('无法从 profile 解析 dsh-plugin-installer：' + e.message)
}
pkgDir = pkgDir.replace(/\\/g, '/')
console.log('✅ 1. 包可解析：' + pkgDir)

// 2. main 入口
const manifest = JSON.parse(readFileSync(pkgDir, 'utf8'))
const mainPath = join(pkgDir.replace(/\/package\.json$/, ''), manifest.main ?? 'index.js')
if (!existsSync(mainPath)) fail('main 入口不存在：' + mainPath)
console.log('✅ 2. main 入口存在：' + manifest.main)

// 3. bundle patch
const patchRel = manifest.dsh?.bundle?.patch
if (typeof patchRel !== 'string') fail('package.json 缺少 dsh.bundle.patch')
const patchPath = join(pkgDir.replace(/\/package\.json$/, ''), patchRel)
if (!existsSync(patchPath)) fail('cordis.patch.yml 不存在：' + patchPath)
const patchText = readFileSync(patchPath, 'utf8')
if (!/insert/.test(patchText)) fail('cordis.patch.yml 未包含 insert 节点')
console.log('✅ 3. bundle patch 存在：' + patchRel)

// 4. 入口可加载并导出插件契约
const mod = await import(pathToFileURL(mainPath).href)
if (mod.name !== 'dsh-plugin-installer') fail('name 导出不符：' + String(mod.name))
if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) fail('inject 应包含 tools')
if (typeof mod.apply !== 'function') fail('apply 不是函数')
console.log('✅ 4. 入口加载成功：name=' + mod.name + ' inject=' + JSON.stringify(mod.inject))

console.log('🎉 profile desktop 已可解析 bundle "dsh-plugin-installer"（重启 DSH 后生效）。')
