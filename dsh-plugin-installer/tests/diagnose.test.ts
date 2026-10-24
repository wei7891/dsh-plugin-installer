import { describe, expect, it } from 'vitest'
import {
  diagnoseCommandOutput,
  summarizeAttempt,
  successDiagnosis,
  manualInterventionDiagnosis,
  diagnosisRuleCount
} from '../src/core/diagnose.js'
import type { AttemptOutcome } from '../src/core/types.js'

describe('诊断规则覆盖度', () => {
  it('规则库覆盖常见安装故障（至少 20 条规则）', () => {
    expect(diagnosisRuleCount()).toBeGreaterThanOrEqual(20)
  })
})

describe('网络类诊断', () => {
  it('识别网络下载超时', () => {
    const list = diagnoseCommandOutput('Error: request to https://registry.npmjs.org/dsh-x timed out after 15000ms')
    const hit = list.find((d) => d.code === 'E_NETWORK_TIMEOUT')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('error')
    expect(hit?.title).toContain('超时')
    expect(hit?.suggestion.length).toBeGreaterThan(0)
  })

  it('识别连接被重置', () => {
    const list = diagnoseCommandOutput('FetchError: request to https://registry.npmjs.org/x failed, reason: ECONNRESET')
    expect(list.some((d) => d.code === 'E_NETWORK_ECONNRESET')).toBe(true)
  })

  it('识别 DNS 解析失败', () => {
    const list = diagnoseCommandOutput('Error: getaddrinfo ENOTFOUND registry.npmjs.org')
    expect(list.some((d) => d.code === 'E_NETWORK_ENOTFOUND')).toBe(true)
  })

  it('识别代理问题并标记为警告', () => {
    const list = diagnoseCommandOutput('Error: connect EPROXY 127.0.0.1:7890 tunneling socket failed')
    const hit = list.find((d) => d.code === 'E_NETWORK_EPROXY')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('warn')
  })

  it('识别 503 服务暂不可用（警告）', () => {
    const list = diagnoseCommandOutput('npm ERR! code E503\nnpm ERR! 503 Service Unavailable - GET https://registry.npmjs.org/x')
    expect(list.some((d) => d.code === 'E_HTTP_503')).toBe(true)
  })

  it('识别 429 限流（警告）', () => {
    const list = diagnoseCommandOutput('npm ERR! 429 Too Many Requests - GET https://registry.npmjs.org/x')
    expect(list.some((d) => d.code === 'E_HTTP_429')).toBe(true)
  })

  it('识别 registry 认证失败', () => {
    const list = diagnoseCommandOutput('npm ERR! 401 Unauthorized - PUT https://registry.npmjs.org/-/user/auth')
    expect(list.some((d) => d.code === 'E_HTTP_401')).toBe(true)
  })
})

describe('依赖冲突与 DSH 内部包诊断', () => {
  it('pnpm 的 FETCH_404 必须判为「DSH 内部包未发布」而不是「包不存在」（规则排序）', () => {
    // 真实 pnpm 输出：peer 依赖无法解析时同时打印 ERR_PNPM_FETCH_404 与 404 文案。
    // 若先命中 404 规则，会把「内部包不对外发布」误判成「用户要的插件不存在」。
    const raw = [
      'ERR_PNPM_FETCH_404  FETCH_ERRORGET https://registry.npmjs.org/@deepseek-ai%2fdsh-type-meta: Not Found - 404 - GET https://registry.npmjs.org/@deepseek-ai%2fdsh-type-meta',
      '',
      '@deepseek-ai/dsh-type-meta is not in the npm registry, or you have no permission to fetch it.'
    ].join('\n')
    const list = diagnoseCommandOutput(raw)
    expect(list[0]?.code).toBe('E_PEER_NOT_PUBLISHED')
    expect(list[0]?.title).toContain('内部包')
  })

  it('纯 404 判为「插件包不存在」并提取包名', () => {
    const list = diagnoseCommandOutput('npm ERR! 404 Not Found - GET https://registry.npmjs.org/dsh-not-exist-xyz')
    const hit = list.find((d) => d.code === 'E_TARGET_NOT_FOUND')
    expect(hit).toBeDefined()
    expect(hit?.detail).toContain('dsh-not-exist-xyz')
  })

  it('识别 ERESOLVE 依赖冲突并建议放宽 peer 校验', () => {
    const list = diagnoseCommandOutput('npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree')
    const hit = list.find((d) => d.code === 'E_ERESOLVE_PEER')
    expect(hit).toBeDefined()
    expect(hit?.suggestion).toContain('legacy-peer-deps')
  })

  it('识别 DSH runtime 不兼容', () => {
    const list = diagnoseCommandOutput('Unsupported peer @deepseek-ai/cordis@^4; dsh-plugin requires cordis but 3.0 is incompatible')
    expect(list.some((d) => d.code === 'E_INCOMPATIBLE_PEER')).toBe(true)
  })

  it('识别安装脚本失败', () => {
    const list = diagnoseCommandOutput('npm ERR! code ELIFECYCLE\nnpm ERR! errno 1\nnpm ERR! dsh-x@1.0.0 postinstall: `node-gyp rebuild`')
    expect(list.some((d) => d.code === 'E_BUILD_SCRIPT_FAILED')).toBe(true)
  })
})

describe('包名 / 版本 / 工作区类诊断', () => {
  it('识别版本号非法', () => {
    const list = diagnoseCommandOutput('npm ERR! Invalid version: "not-a-version"')
    expect(list.some((d) => d.code === 'E_INVALID_VERSION')).toBe(true)
  })

  it('识别废弃版本（警告）', () => {
    const list = diagnoseCommandOutput('npm WARN deprecated dsh-x@0.0.1: 该实现已重构，请升级')
    const hit = list.find((d) => d.code === 'E_DEPRECATED_PACKAGE')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('warn')
  })

  it('识别锁文件过期（警告）', () => {
    const list = diagnoseCommandOutput('ERR_PNPM_OUTDATED_LOCKFILE  The lockfile is out of date')
    expect(list.some((d) => d.code === 'E_LOCKFILE_CONFLICT')).toBe(true)
  })

  it('识别插件已安装（提示）', () => {
    const list = diagnoseCommandOutput('Already installed: dsh-http-tools@0.1.5')
    const hit = list.find((d) => d.code === 'E_ALREADY_INSTALLED')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('info')
  })

  it('识别缺少 profile 工作区清单', () => {
    const list = diagnoseCommandOutput('ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND No project manifest found')
    expect(list.some((d) => d.code === 'E_WORKSPACE_NOT_FOUND')).toBe(true)
  })
})

describe('权限 / 磁盘 / 平台类诊断', () => {
  it('识别权限不足', () => {
    const list = diagnoseCommandOutput("Error: EPERM: operation not permitted, open 'C:\\profile\\node_modules\\x'")
    expect(list.some((d) => d.code === 'E_EPERM')).toBe(true)
  })

  it('识别磁盘空间不足', () => {
    const list = diagnoseCommandOutput('Error: ENOSPC: no space left on device, write')
    expect(list.some((d) => d.code === 'E_ENOSPC')).toBe(true)
  })

  it('识别完整性校验失败', () => {
    const list = diagnoseCommandOutput('npm ERR! code EINTEGRITY\nnpm ERR! integrity checksum failed when using sha512')
    expect(list.some((d) => d.code === 'E_INTEGRITY')).toBe(true)
  })

  it('识别平台不匹配', () => {
    const list = diagnoseCommandOutput('npm ERR! code EBADPLATFORM\nnpm ERR! Unsupported platform for dsh-x@1.0.0: wanted win32-x64 but current is darwin-arm64')
    expect(list.some((d) => d.code === 'E_EBADPLATFORM')).toBe(true)
  })
})

describe('包管理器类诊断', () => {
  it('识别包管理器可执行文件缺失（EINVAL / ENOENT）', () => {
    const list = diagnoseCommandOutput("Error: spawn npm.cmd EINVAL\nError: spawn ENOENT")
    expect(list.some((d) => d.code === 'E_MANAGER_NOT_FOUND')).toBe(true)
  })

  it('识别缺少 packageManager 声明', () => {
    const list = diagnoseCommandOutput('ERR_PNPM_NO_PKG_MANIFEST packageManager field is missing')
    expect(list.some((d) => d.code === 'E_PNPM_CONFIG_MISSING')).toBe(true)
  })
})

describe('兜底与结构化输出', () => {
  it('未识别的输出给出中文兜底诊断并保留原始证据', () => {
    const list = diagnoseCommandOutput('Oops something broke in a way we have never seen before')
    expect(list).toHaveLength(1)
    expect(list[0]?.code).toBe('E_UNKNOWN')
    expect(list[0]?.detail).toContain('Oops something broke')
    expect(list[0]?.suggestion.length).toBeGreaterThan(0)
  })

  it('error 严重度排在 warn 之前', () => {
    const list = diagnoseCommandOutput('Error: ETIMEDOUT after 30s ... then HTTP 503 Service Unavailable')
    expect(list[0]?.severity).toBe('error')
    expect(list.some((d) => d.code === 'E_HTTP_503' && d.severity === 'warn')).toBe(true)
  })

  it('把目标插件名附进中文建议', () => {
    const list = diagnoseCommandOutput('npm ERR! 404 Not Found - GET https://registry.npmjs.org/dsh-foo', {
      packageName: 'dsh-foo'
    })
    expect(list[0]?.suggestion).toContain('dsh-foo')
  })

  it('summarizeAttempt 汇总诊断并去重修复动作', () => {
    const { diagnoses, repairs } = summarizeAttempt('npm ERR! 503 Service Unavailable ... npm ERR! 429 Too Many Requests')
    expect(diagnoses.length).toBeGreaterThanOrEqual(2)
    const kinds = repairs.map((r) => r.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(kinds).toContain('retry')
  })

  it('successDiagnosis 构造成功结论', () => {
    const d = successDiagnosis('安装成功')
    expect(d.code).toBe('OK')
    expect(d.severity).toBe('info')
    expect(d.title).toContain('成功')
  })

  it('manualInterventionDiagnosis 附带尝试记录', () => {
    const attempts: AttemptOutcome[] = [
      {
        index: 1,
        command: 'node pnpm.mjs add dsh-x',
        ok: false,
        exitCode: 1,
        timedOut: false,
        diagnoses: [],
        repairs: [],
        durationMs: 10,
        outputTail: 'stderr'
      }
    ]
    const d = manualInterventionDiagnosis('已达尝试上限', attempts)
    expect(d.code).toBe('E_MANUAL_INTERVENTION_REQUIRED')
    expect(d.detail).toContain('第 1 次')
    expect(d.detail).toContain('node pnpm.mjs add dsh-x')
  })
})
