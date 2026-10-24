/**
 * 用真实 @deepseek-ai/dsh-tools 的 value schema DSL 编译器校验 8 个工具的
 * output.schema，防止再次出现「additionalProperties 不被 DSL 支持」这类
 * 只在 DSH Loader 加载时才暴露的错误。
 *
 * 运行方式：node test/schema-check.mjs
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const libDir = join(projectRoot, 'lib')
const require = createRequire(import.meta.url)

function fail(message) {
  console.error(`❌ schema 校验失败：${message}`)
  process.exit(1)
}

async function main() {
  if (!existsSync(join(libDir, 'index.js'))) fail('未找到 lib/，请先 npm run build')

  // 1. 加载真实的 dsh-tools schema 编译器
  let valueSchemaSpecToJsonSchema
  try {
    ;({ valueSchemaSpecToJsonSchema } = require('@deepseek-ai/dsh-tools/lib/types/schema.js'))
  } catch {
    // 部分版本只导出入口；尝试从包主入口拿
    try {
      const pkg = require('@deepseek-ai/dsh-tools/package.json')
      const entry = require.resolve('@deepseek-ai/dsh-tools')
      console.log(`ℹ️ dsh-tools 版本 ${pkg.version}，入口 ${entry}`)
      const mod = await import(pathToFileURL(entry).href)
      valueSchemaSpecToJsonSchema = mod.valueSchemaSpecToJsonSchema
    } catch (error) {
      fail(`无法加载 dsh-tools 的 schema 编译器：${error.message}`)
    }
  }
  if (typeof valueSchemaSpecToJsonSchema !== 'function') {
    fail('dsh-tools 未导出 valueSchemaSpecToJsonSchema，无法离线校验；将依赖 Loader 实测')
    return
  }

  // 2. 用桩加载插件，收集 8 个工具定义
  const { cpSync, mkdirSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-schema-check-'))
  try {
    cpSync(libDir, join(tempRoot, 'lib'), { recursive: true })
    const stubDir = join(tempRoot, 'node_modules', '@deepseek-ai', 'dsh-tools')
    mkdirSync(stubDir, { recursive: true })
    cpSync(join(here, 'stubs', 'dsh-tools.mjs'), join(stubDir, 'index.js'))

    const plugin = await import(pathToFileURL(join(tempRoot, 'lib', 'index.js')).href)
    const registered = []
    plugin.apply({ tools: { register: (tool) => registered.push(tool) } }, {})

    // 3. 逐个编译 output.schema（任何 DSL 不支持的写法都会抛错）
    for (const tool of registered) {
      const schema = tool.output?.schema
      if (schema === undefined) fail(`${tool.name} 缺少 output.schema`)
      try {
        valueSchemaSpecToJsonSchema(schema)
      } catch (error) {
        fail(`${tool.name} 的 output.schema 被 DSL 拒绝：${error.message}`)
      }
      console.log(`✅ ${tool.name}  schema=${JSON.stringify(schema)}`)
    }
    console.log(`✅ schema 校验通过：${registered.length} 个工具的 output.schema 均被真实 DSL 编译器接受。`)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => fail(error.stack ?? String(error)))
