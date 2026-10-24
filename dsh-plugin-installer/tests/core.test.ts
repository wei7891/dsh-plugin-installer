import { describe, expect, it } from 'vitest'
import { resolveConfig, OFFICIAL_REGISTRY, CN_MIRROR_REGISTRY } from '../src/core/config.js'
import { assertAllowedUrl, normalizeRegistryBase, DEFAULT_ALLOWED_HOSTS, HttpError } from '../src/core/http.js'
import { detectDshSignals, packumentUrl, isPrereleaseVersion } from '../src/core/registry.js'
import type { NpmVersionRecord } from '../src/core/types.js'

describe('配置解析与默认值', () => {
  it('未提供配置时补全全部安全默认值', () => {
    const config = resolveConfig()
    expect(config.packageManager).toBe('pnpm')
    expect(config.registry).toBe(OFFICIAL_REGISTRY)
    expect(config.maxRepairAttempts).toBe(3)
    expect(config.autoVerify).toBe(true)
    expect(config.installTimeoutMs).toBeGreaterThan(0)
    expect(config.totalBudgetMs).toBeGreaterThan(0)
    expect(config.httpTimeoutMs).toBeGreaterThan(0)
  })

  it('拒绝非法 packageManager（中文报错）', () => {
    expect(() => resolveConfig({ packageManager: 'yarn' as 'pnpm' })).toThrow(/packageManager/)
  })

  it('拒绝非正整数的时间/次数字段', () => {
    expect(() => resolveConfig({ installTimeoutMs: -1 })).toThrow(/installTimeoutMs 必须是正整数/)
    expect(() => resolveConfig({ maxRepairAttempts: 0 })).toThrow(/maxRepairAttempts 必须是正整数/)
  })

  it('拒绝非法 registry 地址', () => {
    expect(() => resolveConfig({ registry: 'not a url' })).toThrow(/registry 必须是合法/)
  })

  it('校验 fallbackRegistries 中的每一项', () => {
    expect(() => resolveConfig({ fallbackRegistries: ['ftp://x'] })).toThrow(/fallbackRegistries/)
    const ok = resolveConfig({ fallbackRegistries: [CN_MIRROR_REGISTRY] })
    expect(ok.fallbackRegistries).toEqual([CN_MIRROR_REGISTRY])
  })

  it('allowedRegistryHosts 统一转小写', () => {
    const config = resolveConfig({ allowedRegistryHosts: ['MyMirror.Example.COM'] })
    expect(config.allowedRegistryHosts).toEqual(['mymirror.example.com'])
  })

  it('拒绝非对象配置', () => {
    expect(() => resolveConfig(null as unknown as undefined)).toThrow(/config 必须是对象/)
  })
})

describe('HTTP host 白名单', () => {
  const config = resolveConfig()

  it('放行官方源与国内镜像', () => {
    expect(assertAllowedUrl(`${OFFICIAL_REGISTRY}/dsh-x`, config).hostname).toBe('registry.npmjs.org')
    expect(assertAllowedUrl(`${CN_MIRROR_REGISTRY}/dsh-x`, config).hostname).toBe('registry.npmmirror.com')
  })

  it('拒绝白名单外的主机', () => {
    try {
      assertAllowedUrl('https://evil.example.com/pkg', config)
      expect.unreachable('应当拒绝白名单外主机')
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).code).toBe('E_HTTP_HOST_BLOCKED')
      expect((error as Error).message).toContain('白名单')
    }
  })

  it('拒绝非法 URL 与非 http(s) 协议', () => {
    expect(() => assertAllowedUrl('::::bad', config)).toThrow(/非法的 URL/)
    try {
      assertAllowedUrl('ftp://registry.npmjs.org/x', config)
      expect.unreachable('应当拒绝非 http(s) 协议')
    } catch (error) {
      expect((error as HttpError).code).toBe('E_HTTP_BAD_PROTOCOL')
    }
  })

  it('默认白名单包含官方源与镜像', () => {
    expect(DEFAULT_ALLOWED_HOSTS).toContain('registry.npmjs.org')
    expect(DEFAULT_ALLOWED_HOSTS).toContain('registry.npmmirror.com')
  })

  it('normalizeRegistryBase 去掉结尾斜杠', () => {
    expect(normalizeRegistryBase('https://registry.npmjs.org///')).toBe('https://registry.npmjs.org')
  })
})

describe('DSH 插件信号识别', () => {
  it('声明 dsh.bundle.patch 即判定为 DSH 插件', () => {
    const record: NpmVersionRecord = {
      name: 'dsh-x',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    }
    const signals = detectDshSignals(record)
    expect(signals.hasBundlePatch).toBe(true)
    expect(signals.isDshPlugin).toBe(true)
    expect(signals.reasons.some((r) => r.includes('dsh.bundle.patch'))).toBe(true)
  })

  it('依赖 @deepseek-ai/* peer 即判定为 DSH 插件', () => {
    const signals = detectDshSignals({
      name: 'dsh-x',
      version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0' }
    })
    expect(signals.dshPeers).toEqual(['@deepseek-ai/dsh-tools'])
    expect(signals.isDshPlugin).toBe(true)
  })

  it('声明 dsh.compatibility 即判定为 DSH 插件', () => {
    const signals = detectDshSignals({
      name: 'dsh-x',
      version: '1.0.0',
      dsh: { compatibility: { dsh: '>=0.1.0' } }
    })
    expect(signals.hasCompatibility).toBe(true)
    expect(signals.isDshPlugin).toBe(true)
  })

  it('仅有关键词不是强信号', () => {
    const signals = detectDshSignals({ name: 'x', version: '1.0.0', keywords: ['dsh'] })
    expect(signals.dshKeywords).toEqual(['dsh'])
    expect(signals.isDshPlugin).toBe(false)
    expect(signals.reasons).toHaveLength(1)
  })

  it('识别客户端注入声明（不单独构成强信号）', () => {
    const signals = detectDshSignals({
      name: 'x',
      version: '1.0.0',
      dsh: { client: { inject: ['client/index.js'] } }
    })
    expect(signals.hasClientInject).toBe(true)
    expect(signals.isDshPlugin).toBe(false)
  })

  it('空记录不会误判', () => {
    const signals = detectDshSignals({ name: 'x', version: '1.0.0' })
    expect(signals.isDshPlugin).toBe(false)
    expect(signals.reasons).toHaveLength(0)
  })
})

describe('packument URL 与预发布判定', () => {
  it('scope 包路径按 npm 约定编码斜杠', () => {
    expect(packumentUrl('https://registry.npmjs.org/', '@scope/name')).toBe(
      'https://registry.npmjs.org/@scope%2fname'
    )
  })

  it('普通包名直接拼接', () => {
    expect(packumentUrl(OFFICIAL_REGISTRY, 'dsh-x')).toBe('https://registry.npmjs.org/dsh-x')
  })

  it('识别预发布版本号', () => {
    expect(isPrereleaseVersion('1.0.0-rc.1')).toBe(true)
    expect(isPrereleaseVersion('1.0.0')).toBe(false)
  })
})
