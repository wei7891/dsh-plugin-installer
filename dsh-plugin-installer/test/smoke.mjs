/**
 * 冒烟测试：验证构建产物能被加载、apply 能注册 4 个中文工具。
 *
 * 运行方式：node test/smoke.mjs（需先 npm run build）
 *
 * 做法：把 lib/ 复制到临时目录，并在其 node_modules 里放一个
 * @deepseek-ai/dsh-tools 桩（真实包只在 DSH 运行时内存在），然后 import。
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const libDir = join(projectRoot, 'lib')

const EXPECTED_TOOLS = [
  'install_dsh_plugin',
  'dsh_plugin_inspect',
  'dsh_plugin_registry_check',
  'dsh_plugin_diagnose',
  'dsh_plugin_outdated',
  'update_dsh_plugin',
  'remove_dsh_plugin',
  'enable_dsh_plugin'
]

/** 断言助手：失败时打印中文并退出 1。 */
function assert(condition, message) {
  if (!condition) {
    console.error(`❌ 冒烟测试失败：${message}`)
    process.exit(1)
  }
}

async function main() {
  // 1. 构建产物必须存在
  let libExists = true
  try {
    cpSync(libDir, join(tmpdir(), '__probe__'), { recursive: true })
    rmSync(join(tmpdir(), '__probe__'), { recursive: true, force: true })
  } catch {
    libExists = false
  }
  assert(libExists, '未找到 lib/ 构建产物，请先运行 npm run build')

  // 2. 复制到临时目录并注入 dsh-tools 桩
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-installer-smoke-'))
  try {
    cpSync(libDir, join(tempRoot, 'lib'), { recursive: true })
    const stubDir = join(tempRoot, 'node_modules', '@deepseek-ai', 'dsh-tools')
    mkdirSync(stubDir, { recursive: true })
    cpSync(join(here, 'stubs', 'dsh-tools.mjs'), join(stubDir, 'index.js'))

    // 3. 加载插件入口
    const entryUrl = pathToFileURL(join(tempRoot, 'lib', 'index.js')).href
    const plugin = await import(entryUrl)

    assert(plugin.name === 'dsh-plugin-installer', `插件 name 应为 dsh-plugin-installer，实际 ${String(plugin.name)}`)
    assert(Array.isArray(plugin.inject) && plugin.inject.includes('tools'), 'inject 应包含 tools')
    assert(typeof plugin.apply === 'function', 'apply 应是函数')

    // 4. 用假 ctx 调用 apply，收集注册的工具
    const registered = []
    const ctx = { tools: { register: (tool) => registered.push(tool) } }
    plugin.apply(ctx, {})

    assert(registered.length === EXPECTED_TOOLS.length, `应注册 ${EXPECTED_TOOLS.length} 个工具，实际 ${registered.length}`)
    const names = registered.map((t) => t.name).sort()
    assert(JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()), `工具集不符：${names.join(', ')}`)

    // 5. 每个工具都必须有中文描述、execute 函数、合法 presentCall.kind
    const validKinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'])
    for (const tool of registered) {
      assert(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} 缺少描述`)
      assert(/[一-鿿]/.test(tool.description), `${tool.name} 描述应包含中文`)
      assert(typeof tool.execute === 'function', `${tool.name} 缺少 execute`)
      if (typeof tool.presentCall === 'function') {
        const kind = tool.presentCall({ package: 'dsh-x', output: 'x' })?.kind
        assert(validKinds.has(kind), `${tool.name} 的 presentCall.kind 非法：${String(kind)}`)
      }
    }

    // 6. 直接调用诊断工具的 execute，验证返回结构为 { ok, message }
    const diagnoseTool = registered.find((t) => t.name === 'dsh_plugin_diagnose')
    const diagResult = await diagnoseTool.execute({ output: 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree' })
    assert(diagResult.ok === false, 'ERESOLVE 诊断应返回 ok=false')
    assert(typeof diagResult.message === 'string' && diagResult.message.length > 0, '诊断结果应有中文 message')
    assert(/[一-鿿]/.test(diagResult.message), '诊断 message 应包含中文')

    console.log('✅ 冒烟测试通过：插件加载成功，8 个工具全部注册且描述为中文。')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('❌ 冒烟测试失败：', error)
  process.exit(1)
})
