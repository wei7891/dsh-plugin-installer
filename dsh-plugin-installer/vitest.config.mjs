/**
 * Vitest 配置。
 *
 * 说明：在 DSH 的受限环境下，`forks` 池会因子进程 fork 触发 EPERM
 * （命名管道被沙箱禁用）。因此改用 `threads` 池，既能跑通测试又不依赖子进程 fork。
 * Vitest 4 已移除 poolOptions，改用顶层选项表达串行行为。
 */
export default {
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'threads',
    fileParallelism: false
  }
}
