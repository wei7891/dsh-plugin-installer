# dsh-plugin-installer

> DSH 辅助插件：**全自动安装 DSH 插件**（核心能力），诊断是辅助能力。
> 支持 **5 种来源**，传入任意一种即可自动完成安装 + 可用性自检 + 中文故障诊断：
>
> 1. **npm 包名**：`dsh-plugin`、`@scope/name@1.2.3`
> 2. **本地目录**：`D:\dev\my-plugin`、`./my-plugin`（含 package.json 的插件源码目录）
> 3. **本地压缩包**：`D:\downloads\plugin.zip` / `.tgz` / `.tar.gz`（自动解压后安装）
> 4. **远程压缩包**：`https://example.com/plugin.zip`、GitHub codeload 直链、`.tgz` 直链（自动下载解压后安装）
> 5. **git 仓库**：`git+https://github.com/owner/repo.git`、`github:owner/repo`

## 为什么需要它

Agent 在会话中替用户安装 DSH 插件时，通常会撞上这些坑：

- 用户给的是本地目录 / 压缩包 / git 地址，老式安装器直接拒绝；
- pnpm 解析 `@deepseek-ai/*` 内部包 404（这些包由 DSH 运行时内部提供、不发布到 npm），
  却被粗粒度的错误匹配误判成「插件不存在」；
- 网络超时、锁文件过期、peer 依赖冲突、权限不足等错误只能人工逐条排查；
- 安装命令成功 ≠ 插件可用（入口缺失、node_modules 残留）。

本插件针对上述每一点都提供了自动识别与自动修复。

## 对外工具（4 个）

| 工具 | 用途 |
| --- | --- |
| `install_dsh_plugin` | **核心工具**。传入插件包名（可带 `@version`），在 DSH profile 目录全自动安装：探测官方 registry → 执行 pnpm/npm 安装 → 失败时自动切换 registry/包管理器/放宽参数重试 → 安装后自动可用性自检 + 一次修复重装 |
| `dsh_plugin_inspect` | 安装前核对：从官方源拉取 packument，报告可用版本、`dsh.bundle.patch` / `dsh.compatibility` / 客户端注入声明、DSH peer 依赖、是否判定为 DSH 插件 |
| `dsh_plugin_registry_check` | 探测官方源 / 国内镜像的连通性（HTTP 状态、耗时、体积），用于区分「网络不可达」与「包本身有问题」 |
| `dsh_plugin_diagnose` | 纯诊断：把一段 npm/pnpm 报错翻译成中文根因 + 可执行修复建议（不执行任何安装） |

## 安装

在 DSH profile 根目录（含 `package.json` 与 `pnpm-workspace.yaml`）执行：

```bash
dsh plugin install dsh-plugin-installer
```

或手动把本包加入 profile 的 `dsh.profile.bundles` 并安装依赖。

## 配置

全部可选，在 Cordis 配置里按需覆盖：

```yaml
dsh:
  plugin:
    installer:
      packageManager: pnpm # 默认 pnpm（优先使用 DSH 运行时自带的 pnpm）
      registry: https://registry.npmjs.org # 主 registry
      fallbackRegistries: [] # 主源不可达时的回退源
      installTimeoutMs: 600000 # 单条命令硬超时
      totalBudgetMs: 900000 # 全流程（含修复重试）总预算
      maxRepairAttempts: 3 # 最大自动修复轮数
      httpTimeoutMs: 15000 # 元数据请求超时
      httpMaxBodyChars: 262144 # 响应体上限
      allowedRegistryHosts: [] # 追加 host 白名单
      autoVerify: true # 安装后自动可用性自检
```

## 工作原理

```
来源输入（5 种之一）
  │ 1. 来源识别（source）
  │    · git 特征（git+ / github: / .git 结尾）优先于 URL 判断
  │    · https URL：.zip/.tgz/.tar.gz 后缀或 GitHub codeload 直链 → 远程压缩包
  │    · 本地路径形态或磁盘存在 → 本地目录 / 本地压缩包
  │    · 其余 → npm 包名（严格校验 scope / 非法字符）
  ▼
来源物化（archive，仅压缩包需要）
  │    · 本地压缩包：系统 bsdtar 解压，自动识别顶层单目录布局
  │    · 远程压缩包：https 流式下载（100MB 上限）后解压
  │    · 解压产物统一转为 file:<目录> 交给 pnpm
  ▼
registry 元数据探测（仅 npm 来源）
  │    · host 白名单 + 超时 + 大小上限
  │    · 依据 dsh.bundle / compatibility / peer 判定「是否 DSH 插件」
  ▼
安装 + 自动修复循环（installer + exec + diagnose）
  │    · spawn 不经 shell（防注入），输出走临时文件采集（绕开沙箱管道限制）
  │    · 30+ 条中文诊断规则：网络/代理/404/peer 冲突/锁文件/权限/磁盘/平台/git/下载/解压…
  │    · npm 来源按诊断自动调整：换 registry → 换包管理器 → 放宽 peer → 去版本约束
  │    · git/压缩包来源按诊断调整：换包管理器、放宽 peer、重试
  ▼
安装后可用性自检（installer）
       · 模块目录 / 包清单 / 版本匹配 / 入口文件 / 目录可访问
       · git/远程 tgz 来源从 profile 依赖差集解析真实包名再自检
       · 未通过则自动 --force 重装一次，仍失败才上报
```

### 诊断规则节选

| 场景 | 诊断码 | 自动修复 |
| --- | --- | --- |
| 网络超时 / DNS 失败 / 连接重置 | `E_NETWORK_*` | 切换 npmmirror 镜像、重试 |
| 代理拦截 / 认证失败 | `E_NETWORK_EPROXY` / `E_HTTP_401` | 官方源直连 |
| **DSH 内部包未发布（404）** | `E_PEER_NOT_PUBLISHED` | 提示在真实 profile 中安装、放宽 peer |
| peer 依赖冲突 | `E_ERESOLVE_PEER` | `--legacy-peer-deps` / 清缓存 |
| 插件与 runtime 不兼容 | `E_INCOMPATIBLE_PEER` | 精确锁定匹配版本、按 latest 重试 |
| 包 / 版本不存在 | `E_TARGET_NOT_FOUND` | 去掉版本约束重试、inspect 核对包名 |
| 锁文件过期 | `E_LOCKFILE_CONFLICT` | `--no-frozen-lockfile` |
| 权限不足 / 磁盘满 / 完整性失败 | `E_EPERM` / `E_ENOSPC` / `E_INTEGRITY` | 清理目录、清缓存、官方源校验 |
| 包管理器缺失 | `E_MANAGER_NOT_FOUND` | 自动切换 pnpm/npm |
| 系统未安装 git | `E_GIT_NOT_FOUND` | 提示安装 git 或改用压缩包直链 |
| git 仓库私有 / 不存在 | `E_GIT_AUTH_FAILED` / `E_GIT_REPO_NOT_FOUND` | 提示改用公开地址或 npm 包 |
| 压缩包下载失败 / 超时 | `E_DOWNLOAD_*` | 重试、建议手动下载后按本地路径装 |
| 压缩包损坏 / 缺 package.json | `E_ARCHIVE_EXTRACT_FAILED` / `E_ARCHIVE_NO_MANIFEST` | 提示重新下载 / 核对压缩包内容 |

规则排序刻意保证「最具体的根因优先」：例如 pnpm 解析内部依赖失败时会同时打印
`ERR_PNPM_FETCH_404` 与 404 文案，本插件会命中 `E_PEER_NOT_PUBLISHED`
（DSH 内部包未发布），而不是给出错误的「插件不存在」结论。

## 安全边界

- **npm 元数据只走官方源**：registry host 白名单默认只含 `registry.npmjs.org` 与 `registry.npmmirror.com`；
- **远程压缩包仅 https**：http:// 明文地址直接拒绝；下载带 100MB 大小上限与超时；
- **拒绝交互式 git**：ssh:// 协议需要交互认证，一律中文拒绝并引导改用 https 地址；
- **不提供任意命令执行**：只执行「安装」与「元数据查询」两类 npm/pnpm 子命令，解压只调用系统 tar；
- **防命令注入**：`spawn` 不经过 shell，参数按数组传递；
- **超时保护**：单命令与全流程双层超时，修复轮数有上限，避免死循环。

## 开发

```bash
# 依赖（需 pnpm；DSH 运行时自带）
pnpm install

# 类型检查 + 构建（tsc，产物输出到 lib/）
pnpm run typecheck
pnpm run build

# 单元测试（vitest，threads 池）
pnpm test

# 冒烟测试（加载构建产物、验证 4 个工具注册）
pnpm run smoke

# 端到端：隔离临时 profile 中真实安装，验证失败归因
node test/e2e.mjs

# 5 来源全链路：npm 包 / 本地目录 / 本地 zip / 远程压缩包 / git 均真实安装
node test/e2e-sources.mjs

# 验收：全链路成功安装 + 自检（需要网络）
node test/acceptance.mjs dsh-plugin
```

### 目录结构

```
src/
  index.ts            # 插件入口：4 个工具的注册与编排
  core/
    types.ts          # 公共类型（诊断、执行结果…）
    config.ts         # 配置解析与默认值
    package-name.ts   # 包名解析 / 校验
    source.ts         # 5 种安装来源识别（npm/git/本地目录/本地压缩包/远程压缩包）
    archive.ts        # 压缩包物化（https 下载 + bsdtar 解压）
    http.ts           # 内置 HTTP（白名单、超时、大小上限）
    registry.ts       # 官方源元数据拉取 + DSH 插件信号判定
    exec.ts           # npm/pnpm 子进程执行（临时文件采集输出）
    diagnose.ts       # 30+ 条中文诊断规则引擎（含 git/下载/解压）
    installer.ts      # 安装编排：识别→物化→安装→自检修复
tests/                # vitest 单元测试（含 source/archive）
test/                 # 冒烟 / e2e / 5 来源 e2e / 验收脚本
```

## 许可

MIT
