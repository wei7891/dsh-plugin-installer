import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { identifySource, SOURCE_KIND_LABELS } from '../src/core/source.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-source-test-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

describe('npm 包名来源', () => {
  it('普通包名', () => {
    const source = identifySource('dsh-plugin')
    expect(source.kind).toBe('npm')
    expect(source.packageName).toBe('dsh-plugin')
  })

  it('带版本的包名', () => {
    const source = identifySource('dsh-plugin@2.1.0')
    expect(source.kind).toBe('npm')
    expect(source.spec).toBe('dsh-plugin@2.1.0')
  })

  it('registry URL 提取包名', () => {
    const source = identifySource('https://registry.npmjs.org/dsh-plugin')
    expect(source.kind).toBe('npm')
    expect(source.packageName).toBe('dsh-plugin')
  })
})

describe('git 来源', () => {
  it('git+https 地址', () => {
    const source = identifySource('git+https://github.com/owner/repo.git')
    expect(source.kind).toBe('git')
    expect(source.gitUrl).toBe('git+https://github.com/owner/repo.git')
  })

  it('github: 简写', () => {
    const source = identifySource('github:owner/repo')
    expect(source.kind).toBe('git')
  })

  it('https .git 结尾', () => {
    const source = identifySource('https://github.com/owner/repo.git')
    expect(source.kind).toBe('git')
  })

  it('拒绝 ssh 协议（无法交互认证）', () => {
    const source = identifySource('git+ssh://git@github.com/owner/repo.git')
    expect(source.reason).toContain('ssh')
  })
})

describe('远程压缩包来源', () => {
  it('https zip 直链', () => {
    const source = identifySource('https://example.com/plugin.zip')
    expect(source.kind).toBe('remote-archive')
    expect(source.isZip).toBe(true)
    expect(source.url).toBe('https://example.com/plugin.zip')
  })

  it('https tgz 直链', () => {
    const source = identifySource('https://example.com/plugin.tgz')
    expect(source.kind).toBe('remote-archive')
    expect(source.isZip).toBe(false)
  })

  it('拒绝 http（明文不安全）', () => {
    const source = identifySource('http://example.com/plugin.zip')
    expect(source.reason).toContain('https')
  })

  it('query 参数不影响后缀判断', () => {
    const source = identifySource('https://example.com/plugin.zip?download=1')
    expect(source.kind).toBe('remote-archive')
    expect(source.isZip).toBe(true)
  })

  it('GitHub codeload zip 直链（无文件后缀）', () => {
    const source = identifySource('https://codeload.github.com/sindresorhus/is-plain-obj/zip/refs/heads/main')
    expect(source.kind).toBe('remote-archive')
    expect(source.isZip).toBe(true)
  })

  it('GitHub codeload tar.gz 直链（无文件后缀）', () => {
    const source = identifySource('https://codeload.github.com/owner/repo/tar.gz/refs/tags/v1.0.0')
    expect(source.kind).toBe('remote-archive')
    expect(source.isZip).toBe(false)
  })

  it('GitHub archive 分支 zip（有 .zip 后缀）', () => {
    const source = identifySource('https://github.com/owner/repo/archive/refs/heads/main.zip')
    expect(source.kind).toBe('remote-archive')
    expect(source.isZip).toBe(true)
  })
})

describe('本地目录来源', () => {
  it('存在的目录（含 package.json）', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-fixture' }))
    const source = identifySource(dir)
    expect(source.kind).toBe('local-dir')
    expect(source.localPath).toBe(dir)
  })

  it('file: 前缀', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-fixture' }))
    const source = identifySource(`file:${dir}`)
    expect(source.kind).toBe('local-dir')
    expect(source.localPath).toBe(dir)
  })

  it('存在的目录但缺 package.json → 报中文原因', () => {
    const dir = makeTempDir()
    const source = identifySource(dir)
    expect(source.reason).toContain('package.json')
  })

  it('不存在的路径 → 报中文原因', () => {
    const source = identifySource('D:\\definitely\\not\\exists\\plugin-dir')
    expect(source.reason).toContain('不存在')
  })

  it('Windows 盘符路径形态被当作本地路径', () => {
    const source = identifySource('C:\\dev\\some-plugin')
    // 路径不存在 → reason 提示不存在（而不是被当成 npm 包名）
    expect(source.reason).toContain('不存在')
  })
})

describe('本地压缩包来源', () => {
  it('存在的 .zip 文件', () => {
    const dir = makeTempDir()
    const zipPath = join(dir, 'plugin.zip')
    writeFileSync(zipPath, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    const source = identifySource(zipPath)
    expect(source.kind).toBe('local-archive')
    expect(source.isZip).toBe(true)
  })

  it('存在的 .tgz 文件', () => {
    const dir = makeTempDir()
    const tgzPath = join(dir, 'plugin.tgz')
    writeFileSync(tgzPath, Buffer.from([0x1f, 0x8b, 0x08]))
    const source = identifySource(tgzPath)
    expect(source.kind).toBe('local-archive')
    expect(source.isZip).toBe(false)
  })

  it('存在的普通文件但不是压缩包 → 拒绝', () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'plugin.txt')
    writeFileSync(filePath, 'not an archive')
    const source = identifySource(filePath)
    expect(source.reason).toContain('压缩包')
  })
})

describe('来源中文标签完整', () => {
  it('每个类别都有中文标签', () => {
    for (const kind of ['npm', 'git', 'local-dir', 'local-archive', 'remote-archive'] as const) {
      expect(SOURCE_KIND_LABELS[kind].length).toBeGreaterThan(0)
    }
  })

  it('空输入报中文原因', () => {
    expect(identifySource('').reason).toContain('不能为空')
    expect(identifySource(null).reason).toContain('字符串')
  })
})
