import { describe, expect, it } from 'vitest'
import {
  parsePackageName,
  buildInstallSpec,
  detectNonRegistrySource,
  describeNonRegistrySource,
  isDshPackageName,
  parseMajorVersion
} from '../src/core/package-name.js'

describe('包名解析与校验', () => {
  it('解析普通包名', () => {
    const parsed = parsePackageName('dsh-http-tools')
    expect(parsed.ok).toBe(true)
    expect(parsed.name).toBe('dsh-http-tools')
    expect(parsed.scope).toBeUndefined()
    expect(parsed.version).toBeUndefined()
  })

  it('解析带作用域的包名', () => {
    const parsed = parsePackageName('@deepseek-ai/dsh-tools')
    expect(parsed.ok).toBe(true)
    expect(parsed.name).toBe('@deepseek-ai/dsh-tools')
    expect(parsed.scope).toBe('@deepseek-ai')
    expect(parsed.bare).toBe('dsh-tools')
  })

  it('解析带版本的包名', () => {
    const parsed = parsePackageName('dsh-http-tools@0.1.5')
    expect(parsed.ok).toBe(true)
    expect(parsed.name).toBe('dsh-http-tools')
    expect(parsed.version).toBe('0.1.5')
  })

  it('解析带作用域且带版本的包名（scope 的 @ 不是版本分隔符）', () => {
    const parsed = parsePackageName('@anionex/dsh-vision-toolkit@0.1.46')
    expect(parsed.ok).toBe(true)
    expect(parsed.name).toBe('@anionex/dsh-vision-toolkit')
    expect(parsed.version).toBe('0.1.46')
  })

  it('剥掉命令式前缀', () => {
    expect(parsePackageName('npm i dsh-http-tools').name).toBe('dsh-http-tools')
    expect(parsePackageName('pnpm add @scope/name').name).toBe('@scope/name')
  })

  it('从 registry URL 中提取包名', () => {
    const parsed = parsePackageName('https://registry.npmjs.org/dsh-http-tools')
    expect(parsed.ok).toBe(true)
    expect(parsed.name).toBe('dsh-http-tools')
  })

  it('拒绝空输入与非字符串', () => {
    expect(parsePackageName('').ok).toBe(false)
    expect(parsePackageName('   ').ok).toBe(false)
    expect(parsePackageName(null).ok).toBe(false)
    expect(parsePackageName(42).ok).toBe(false)
  })

  it('拒绝含非法字符的包名', () => {
    expect(parsePackageName('dsh http tools').ok).toBe(false)
    expect(parsePackageName('dsh(http)').ok).toBe(false)
    expect(parsePackageName('dsh-http-tools; rm -rf').ok).toBe(false)
  })

  it('拒绝多个斜杠的包名', () => {
    const parsed = parsePackageName('a/b/c')
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toContain('/')
  })

  it('拒绝非法作用域', () => {
    expect(parsePackageName('@/name').ok).toBe(false)
    expect(parsePackageName('@bad scope/name').ok).toBe(false)
  })

  it('拒绝以 . 或 - 开头', () => {
    expect(parsePackageName('.hidden').ok).toBe(false)
    expect(parsePackageName('-prefix').ok).toBe(false)
  })
})

describe('非官方源识别', () => {
  it('识别本地路径与 git / tarball 来源', () => {
    expect(detectNonRegistrySource('file:../local/pkg')).toBe('file:')
    // git+https://... 命中更精确的 git+ 标识
    expect(detectNonRegistrySource('git+https://github.com/x/y.git')).toBe('git+')
    expect(detectNonRegistrySource('git://github.com/x/y.git')).toBe('git:')
    expect(detectNonRegistrySource('./pkg.tgz')).toBe('.tgz')
    expect(detectNonRegistrySource('C:\\dev\\pkg')).toBe('c:\\')
  })

  it('给出中文来源说明', () => {
    expect(describeNonRegistrySource('git+')).toBe('git 源')
    expect(describeNonRegistrySource('file:')).toBe('本地路径')
  })

  it('官方包名不含本地来源标识', () => {
    expect(detectNonRegistrySource('dsh-http-tools')).toBeUndefined()
  })
})

describe('DSH 包名判定', () => {
  it('识别 DSH 命名空间', () => {
    expect(isDshPackageName('@deepseek-ai/dsh-tools')).toBe(true)
    expect(isDshPackageName('dsh-http-tools')).toBe(true)
    expect(isDshPackageName('react')).toBe(false)
    expect(isDshPackageName('@anionex/dsh-vision-toolkit')).toBe(false)
  })
})

describe('安装 spec 构造与主版本号解析', () => {
  it('无版本时省略 @', () => {
    expect(buildInstallSpec('dsh-http-tools')).toBe('dsh-http-tools')
  })

  it('带版本时拼接', () => {
    expect(buildInstallSpec('dsh-http-tools', '0.1.5')).toBe('dsh-http-tools@0.1.5')
    expect(buildInstallSpec('dsh-http-tools', 'latest')).toBe('dsh-http-tools@latest')
  })

  it('解析主版本号', () => {
    expect(parseMajorVersion('0.1.5')).toBe(0)
    expect(parseMajorVersion('v1.2.3')).toBe(1)
    expect(parseMajorVersion('10.0.0')).toBe(10)
    expect(parseMajorVersion('abc')).toBeNull()
  })
})
