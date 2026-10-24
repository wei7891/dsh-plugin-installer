/**
 * 故障诊断引擎：把 npm/pnpm 报错输出解析为中文结论 + 可执行修复动作。
 *
 * 这是「自动解析错误原因、自动尝试修复」的核心：每条规则都是
 *   `正则/关键词` → `中文诊断` → `修复动作`
 * 的三元组，按优先级顺序匹配，命中即返回并可继续叠加多个诊断。
 */
/**
 * 规则表。顺序即优先级：越靠前越具体。
 * 覆盖：超时、网络、DNS、代理、registry 认证、DSH 内部包未发布、
 * peer 不兼容、依赖冲突、安装脚本失败、包不存在、版本非法、
 * 锁文件过期、权限、磁盘、完整性、平台、包管理器缺失等。
 *
 * 排序原则（重要）：最具体的根因规则放在最前，通用报错文案放后面。
 * 例如 pnpm 解析 peer 失败会同时打印 404 文案与「X is not in the npm
 * registry」，若不把 E_PEER_NOT_PUBLISHED 提前，就会误判成「用户请求
 * 的插件不存在」，给出完全错误的修复方向。
 */
const RULES = [
    // ---- 网络类 ----
    {
        code: 'E_NETWORK_TIMEOUT',
        match: /ETIMEDOUT|request to .* timed out|网络超时|operation timed out|Timeout for GET/i,
        title: '网络下载超时',
        severity: 'error',
        detail: (m) => `registry 或网络在限定时间内没有响应。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '先切换为国内镜像源再重试；若仍失败，用 dsh_plugin_registry_check 探测 registry 连通性。',
        repairs: [
            { kind: 'add-registry', label: '追加 npmmirror 镜像源作为回退' },
            { kind: 'retry', label: '原命令重试一次' }
        ]
    },
    {
        code: 'E_NETWORK_ECONNRESET',
        match: /ECONNRESET|socket hang up|Client network socket disconnected/i,
        title: '网络连接被重置',
        severity: 'error',
        detail: (m) => `连接在传输过程中被对端重置，通常是网络抖动或代理干扰。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '重试一次；若反复出现，切换镜像源，并检查系统代理 / VPN 设置。',
        repairs: [
            { kind: 'add-registry', label: '追加 npmmirror 镜像源作为回退' },
            { kind: 'retry', label: '原命令重试一次' }
        ]
    },
    {
        code: 'E_NETWORK_ENOTFOUND',
        match: /ENOTFOUND|getaddrinfo|EAI_AGAIN|名称解析失败/i,
        title: 'DNS 解析失败',
        severity: 'error',
        detail: (m) => `无法解析 registry 域名，通常是 DNS 配置或网络不通。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '切换到已知可达的国内镜像源；必要时在系统层检查 DNS。',
        repairs: [{ kind: 'add-registry', label: '追加 npmmirror 镜像源作为回退' }]
    },
    {
        code: 'E_NETWORK_EPROXY',
        match: /EPROXY|proxy|tunnel|407|HTTP_PROXY/i,
        title: '代理配置导致请求失败',
        severity: 'warn',
        detail: (m) => `请求被代理拦截或代理需要认证。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '检查 HTTP_PROXY / HTTPS_PROXY 环境变量；必要时在命令中显式指定 registry 直连。',
        repairs: [{ kind: 'use-official-registry', label: '显式指定官方 registry 直连' }]
    },
    {
        code: 'E_HTTP_503',
        match: /\b503\b|Service Unavailable|服务暂不可用/i,
        title: 'registry 服务暂不可用',
        severity: 'warn',
        detail: (m) => `registry 返回 503，通常是上游过载或临时故障。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '等待数秒后重试；若持续出现则切换镜像源。',
        repairs: [
            { kind: 'retry', label: '原命令重试一次' },
            { kind: 'add-registry', label: '追加 npmmirror 镜像源作为回退' }
        ]
    },
    {
        code: 'E_HTTP_429',
        match: /\b429\b|Too Many Requests|rate limit/i,
        title: '请求被限流',
        severity: 'warn',
        detail: (m) => `registry 触发限流，短时间内请求过多。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '降低并发后重试；反复出现时切换到镜像源。',
        repairs: [
            { kind: 'retry', label: '原命令重试一次' },
            { kind: 'add-registry', label: '追加 npmmirror 镜像源作为回退' }
        ]
    },
    {
        code: 'E_HTTP_401',
        match: /\b401\b|\b403\b|ENEEDAUTH|Unable to authenticate|unauthorized/i,
        title: 'registry 认证失败',
        severity: 'error',
        detail: (m) => `registry 需要认证或拒绝了本次请求。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '确认使用的 registry 是否内置了 token 校验；本插件只支持公开官方源，请改用 https://registry.npmjs.org。',
        repairs: [{ kind: 'use-official-registry', label: '改回官方公开 registry' }]
    },
    // ---- peer 依赖 / 版本冲突（DSH 生态的核心坑） ----
    // 注意：E_PEER_NOT_PUBLISHED 必须排在 E_TARGET_NOT_FOUND 之前。
    // pnpm 解析 peer 依赖失败时会同时打印 ERR_PNPM_FETCH_404 与
    // "X is not in the npm registry, or you have no permission to fetch it"，
    // 若先命中 404 规则，会把「DSH 内部包不对外发布」这个真实原因
    // 掩盖成「用户请求的插件不存在」，给出完全错误的修复方向。
    {
        code: 'E_PEER_NOT_PUBLISHED',
        match: /is not in the npm registry, or you have no permission to fetch it|ERR_PNPM_FETCH_404/i,
        title: '依赖的 DSH 内部包未对外发布',
        severity: 'error',
        detail: (m, raw) => {
            const pkg = extractPackageName(raw);
            const which = pkg === undefined ? '某个 @deepseek-ai/ 前缀的包' : pkg;
            return `依赖链里的 ${which} 在公开 registry 中不存在。命中片段："${clip(m.input ?? '')}"`;
        },
        suggestion: '这是 DSH 生态的正常现象：大量 @deepseek-ai/dsh-* 包由 DSH 运行时内部提供，不发布到 npm。' +
            '请确认安装目录是真实的 DSH profile 根目录（含 package.json 与 pnpm-workspace.yaml），' +
            '让 pnpm 从工作区解析这些内部依赖，而不是在空白目录里安装。' +
            '如果确实在真实 profile 中操作，可尝试追加 --legacy-peer-deps 放宽 peer 校验。',
        repairs: [
            { kind: 'add-registry', label: '追加 npmmirror 镜像源作为回退' },
            { kind: 'legacy-peer-deps', label: '追加 --legacy-peer-deps 放宽 peer 校验' }
        ]
    },
    {
        code: 'E_INCOMPATIBLE_PEER',
        match: /incompatible|not supported|Unsupported peer|supports.*but .*is requested/i,
        title: '插件与当前 DSH runtime 不兼容',
        severity: 'error',
        detail: (m) => `插件的 dsh.compatibility / peerDependencies 未覆盖当前 runtime。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '这是一个版本兼容问题：要么升级/降级插件版本，要么升级 DSH。先用 dsh_plugin_inspect 核对，再选择具体版本安装。',
        repairs: [
            { kind: 'exact-pin', label: '改装与当前 runtime 匹配的最新小版本' },
            { kind: 'normalize-spec', label: '去掉版本约束按 latest 重试' }
        ]
    },
    {
        code: 'E_ERESOLVE_PEER',
        match: /ERESOLVE|could not resolve|peer dependency|Conflicting peer|unable to resolve dependency tree/i,
        title: '依赖冲突（peer 依赖无法满足）',
        severity: 'error',
        detail: (m) => `包管理器无法同时满足所有 peer 依赖版本。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '优先尝试 --legacy-peer-deps / --strict-peer-dependencies=false 放宽 peer 校验；' +
            '若仍失败，用 dsh_plugin_inspect 核对该插件要求的 DSH 版本区间与当前 runtime 版本。',
        repairs: [
            { kind: 'legacy-peer-deps', label: '追加 --legacy-peer-deps 放宽 peer 校验' },
            { kind: 'clear-cache', label: '清理包管理器缓存后重试' }
        ]
    },
    {
        code: 'E_BUILD_SCRIPT_FAILED',
        match: /ELIFECYCLE|failed in|run scripts|ERR_PNPM_RUNNING_BUILD_SCRIPTS|node-gyp|prebuild|postinstall/i,
        title: '安装后置脚本执行失败',
        severity: 'error',
        detail: (m) => `安装过程本身成功，但 postinstall / prebuild 脚本报错。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '多为原生构建或构建脚本环境问题。可尝试跳过构建脚本（--ignore-scripts）完成安装，再单独排查；也可能是硬件工具链缺失。',
        repairs: [{ kind: 'reinstall', label: '以 --ignore-scripts 重新安装' }]
    },
    // ---- 包名 / 版本类 ----
    {
        // 精确匹配 404，不要用宽泛的 not found / no permission：
        // pnpm 在解析 peer 依赖失败时也会打印
        // "X is not in the npm registry, or you have no permission to fetch it"，
        // 过早命中本规则会把真正的 peer 冲突问题掩盖成「包不存在」。
        code: 'E_TARGET_NOT_FOUND',
        match: /\b404\b|E404|ETARGET|No matching version found|is not in this registry/i,
        title: '插件包不存在或版本不存在',
        severity: 'error',
        detail: (m, raw) => {
            const pkg = extractPackageName(raw);
            return pkg === undefined
                ? `registry 返回 404。命中片段："${clip(m.input ?? '')}"`
                : `registry 未找到包 ${pkg}，可能包名拼错、已从 registry 下架，或指定版本不存在。`;
        },
        suggestion: '用 dsh_plugin_inspect 传入不含版本的包名核对真实包名与 availableVersions，再重新安装。' +
            '如果报的是某个 @deepseek-ai/ 前缀的包 404，说明它是 DSH 内部包（不对外发布），' +
            '需要在真实的 DSH profile 目录中安装，由 pnpm 的工作区解析提供。',
        repairs: [{ kind: 'normalize-spec', label: '去掉版本约束后按 latest 重试' }]
    },
    {
        code: 'E_INVALID_PACKAGE_NAME',
        match: /Invalid package name|invalid package|Unsupported URL Type|is not a valid/i,
        title: '包名格式非法',
        severity: 'error',
        detail: (m) => `传入的包名不符合 npm 规范。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '检查包名大小写、是否含空格/中文/特殊字符；带作用域时形如 @scope/name。',
        repairs: [{ kind: 'normalize-spec', label: '规范化包名后重试' }]
    },
    {
        code: 'E_INVALID_VERSION',
        match: /Invalid version|not a valid semver|版本.*非法|Invalid version specified/i,
        title: '版本号非法或不存在',
        severity: 'error',
        detail: (m) => `指定的版本号无法解析为该包的可用版本。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '用 dsh_plugin_inspect 查看 availableVersions 后选一个真实存在的版本；或直接省略版本装 latest。',
        repairs: [{ kind: 'normalize-spec', label: '去掉版本约束后按 latest 重试' }]
    },
    {
        code: 'E_DEPRECATED_PACKAGE',
        match: /deprecated/i,
        title: '目标版本已被作者标记废弃',
        severity: 'warn',
        detail: (m) => `registry 提示该版本已 deprecated。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '如非必要，改用 distTags.latest 或 availableVersions 中的较新版本安装。',
        repairs: [{ kind: 'exact-pin', label: '锁定到最新可用版本' }]
    },
    // ---- workspace / profile 结构类 ----
    {
        code: 'E_WORKSPACE_NOT_FOUND',
        match: /ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND|Cannot read properties of undefined.*dir|no such file or directory.*manifest/i,
        title: '未找到 profile 工作区清单',
        severity: 'error',
        detail: (m) => `当前目录缺少 package.json，包管理器拒绝安装。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '确认安装目录是 DSH profile 根目录（应包含 package.json 与 pnpm-workspace.yaml）。',
        repairs: []
    },
    {
        code: 'E_LOCKFILE_CONFLICT',
        match: /ERR_PNPM_LOCKFILE_BREAKING_CHANGE|lockfile.*out of date|Cannot install with .frozen-lockfile|ERR_PNPM_OUTDATED_LOCKFILE|lockfile is broken/i,
        title: '锁文件与实际依赖不一致',
        severity: 'warn',
        detail: (m) => `pnpm-lock.yaml 与 package.json 不匹配，或处于 --frozen-lockfile 模式。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '允许包管理器重新解析并更新锁文件（--no-frozen-lockfile）。',
        repairs: [{ kind: 'strip-lockfile', label: '以 --no-frozen-lockfile 重新解析安装' }]
    },
    {
        code: 'E_ALREADY_INSTALLED',
        match: /Already installed|already exists|ERR_PNPM_ALREADY_INSTALLED|Package already installed/i,
        title: '插件已在 profile 中',
        severity: 'info',
        detail: (m) => `目标插件已经是 profile 的已安装依赖。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '这通常不是错误。确认 dsh.profile.bundles 中是否已声明启用即可；如需升级先升级版本。',
        repairs: []
    },
    // ---- 权限 / 磁盘类 ----
    {
        code: 'E_EPERM',
        match: /EPERM|EROFS|EACCES|permission denied|只读|无权限|Access is denied/i,
        title: '文件系统权限不足',
        severity: 'error',
        detail: (m) => `写入 node_modules / 缓存目录被拒绝。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '以管理员身份运行 DSH，或清理被杀毒软件/索引服务占用的 node_modules 后重试；' +
            '如果安装目标在系统保护目录（如 Program Files），请改到用户可写目录下的 profile。',
        repairs: [{ kind: 'prune-node-modules', label: '清理残留目录后重试' }]
    },
    {
        code: 'E_ENOSPC',
        match: /ENOSPC|no space left|磁盘空间不足/i,
        title: '磁盘空间不足',
        severity: 'error',
        detail: (m) => `磁盘已满，无法写入缓存。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '清理磁盘空间或包管理器缓存后重试。',
        repairs: [{ kind: 'clear-cache', label: '清理包管理器缓存后重试' }]
    },
    {
        code: 'E_INTEGRITY',
        match: /EINTEGRITY|integrity checksum failed|sha512|sha256/i,
        title: '包完整性校验失败（可能被中间人篡改）',
        severity: 'error',
        detail: (m) => `下载的 tarball sha 与 registry 声明不一致。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '清理缓存后重试；若持续失败，请检查网络中间层（代理/镜像）是否可信，并改用官方源。',
        repairs: [
            { kind: 'clear-cache', label: '清理包管理器缓存后重试' },
            { kind: 'use-official-registry', label: '改回官方公开 registry' }
        ]
    },
    {
        code: 'E_EBADPLATFORM',
        match: /EBADPLATFORM|Unsupported platform|required .* architecture|osX|win32-x64/i,
        title: '平台 / 架构不匹配',
        severity: 'error',
        detail: (m) => `包内含原生二进制，但当前平台/架构不匹配。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '确认插件支持当前平台（win32-x64 / darwin-arm64 等）。可尝试 --force 强制安装，但可能不可用。',
        repairs: [
            { kind: 'reinstall', label: '以 --force 强制安装' },
            { kind: 'legacy-peer-deps', label: '追加 --legacy-peer-deps 放宽校验' }
        ]
    },
    // ---- git 来源类 ----
    // git 相关规则必须排在 E_MANAGER_NOT_FOUND 之前：git 缺失的报错
    // （'git' is not recognized / command not found）同样会命中管理器缺失的
    // 宽正则，先命中才能给出「装 git 或改用压缩包」这种精确建议。
    {
        code: 'E_GIT_NOT_FOUND',
        match: /'git' is not recognized|git: command not found|cannot find git|Can't find git|git is not installed|unable to auto-detect git/i,
        title: '系统未安装 git',
        severity: 'error',
        detail: (m) => `安装 git 仓库来源的插件需要系统里有 git，但当前环境找不到。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '请先安装 git（Windows：winget install Git.Git；macOS：xcode-select --install；Debian/Ubuntu：apt install git）。' +
            '若暂时无法安装 git，可改用该插件的压缩包直链（.zip/.tgz）或 npm 包名安装。',
        repairs: [{ kind: 'switch-package-manager', label: '切换到另一个包管理器重试' }]
    },
    {
        code: 'E_GIT_AUTH_FAILED',
        match: /Authentication failed|Permission denied \(publickey\)|could not read Username|terminal prompts disabled|auth failed/i,
        title: 'git 仓库需要认证',
        severity: 'error',
        detail: (m) => `目标 git 仓库是私有的或需要凭据，全自动安装无法完成交互式认证。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '请改用公开仓库地址；私有仓库请先配置好系统级 git 凭据（credential helper）后重试。',
        repairs: []
    },
    {
        code: 'E_GIT_REPO_NOT_FOUND',
        match: /Repository not found|could not read from remote repository|remote: .*not found|fatal: .*does not appear to be a git repository/i,
        title: 'git 仓库不存在或不可访问',
        severity: 'error',
        detail: (m) => `git 无法访问目标仓库：地址拼写错误、仓库已删除，或网络不可达。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '核对仓库地址拼写；如果是 GitHub 私有/已删除仓库，改用 npm 包名或压缩包直链安装。',
        repairs: []
    },
    // ---- 压缩包下载 / 解压类 ----
    {
        code: 'E_DOWNLOAD_FAILED',
        match: /download failed|ECONNREFUSED|getaddrinfo|certificate|SSL|TLS|self.signed/i,
        title: '压缩包下载失败',
        severity: 'error',
        detail: (m) => `远程压缩包下载过程中网络或证书出错。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '检查网络连通性与代理设置；确认 URL 可在浏览器直接下载；必要时把压缩包下载到本地后按本地路径安装。',
        repairs: [{ kind: 'retry', label: '原命令重试一次' }]
    },
    {
        code: 'E_ARCHIVE_EXTRACT_FAILED',
        match: /extract failed|not a zipped|End-of-central-directory|invalid compressed|unexpected end of archive|命令解压失败/i,
        title: '压缩包损坏或格式不受支持',
        severity: 'error',
        detail: (m) => `压缩包无法解压：可能下载不完整、文件损坏，或不是标准 zip/tar 格式。命中片段:"${clip(m.input ?? '')}"`,
        suggestion: '重新下载压缩包；确认它是标准 .zip / .tgz / .tar.gz；GitHub 请用「Code → Download ZIP」或 release 附件。',
        repairs: []
    },
    {
        code: 'E_ARCHIVE_NO_MANIFEST',
        match: /未找到 package\.json|no package\.json/i,
        title: '压缩包内缺少 package.json',
        severity: 'error',
        detail: (m) => `解压后没有找到 package.json，说明这不是一个 npm/DSH 插件包。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '确认下载的是插件源码包的顶层目录压缩包，而不是仓库的其他子目录或文档包。',
        repairs: []
    },
    // ---- 包管理器自身 ----
    // 注意：这条规则的正则不能太宽。早期版本用了宽泛的 not found，
    // 结果把「node ...pnpm.mjs add x」里的 npm.cmd 也判成管理器缺失，
    // 触发了无意义的包管理器切换。这里只匹配真正的可执行文件缺失 / 启动失败。
    {
        code: 'E_MANAGER_NOT_FOUND',
        // EINVAL：DSH 沙箱内 spawn .cmd 失败（需要 cmd.exe 上下文）
        // ENOENT：可执行文件不存在
        // E2BIG：命令行参数过长
        // "is not recognized ..."：Windows cmd 找不到命令
        // "command not found"：POSIX shell 找不到命令
        match: /EINVAL|E2BIG|ENOENT|is not recognized as an internal or external command|[^a-z]command not found[^a-z]|cannot find the (?:file|path)/i,
        title: '包管理器可执行文件缺失或无法启动',
        severity: 'error',
        detail: (m) => `系统 PATH 或 DSH 运行时内找不到 / 无法启动 npm / pnpm。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '切换到另一个包管理器重试；本插件优先使用 DSH 自带运行时内的 pnpm（通过 node 执行 pnpm.mjs），' +
            '若当前环境两者都不可用，请检查 ~/.dsh/dsh-runtimes 是否完整。',
        repairs: [{ kind: 'switch-package-manager', label: '切换到另一个包管理器重试' }]
    },
    {
        code: 'E_PNPM_INCOMPATIBLE',
        match: /ERR_PNPM_UNSUPPORTED_ENGINE|unsupported engine|The current version of pnpm is not compatible/i,
        title: '包管理器版本过旧',
        severity: 'warn',
        detail: (m) => `当前包管理器版本不满足插件 engines 要求。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '切换到另一个包管理器；pnpm 不可用时可让 npm 接管安装。',
        repairs: [{ kind: 'switch-package-manager', label: '切换到另一个包管理器重试' }]
    },
    {
        code: 'E_PNPM_CONFIG_MISSING',
        match: /ERR_PNPM_NO_PKG_MANIFEST|ERR_PNPM_NO_PKGMAN/i,
        title: '缺少 packageManager 声明',
        severity: 'warn',
        detail: (m) => `pnpm 因 packageManager 字段缺失或配置异常退出。命中片段："${clip(m.input ?? '')}"`,
        suggestion: '显式指定使用 npm 完成安装，绕开 pnpm 的版本校验。',
        repairs: [{ kind: 'switch-package-manager', label: '切换到 npm 完成安装' }]
    }
];
/** 截断匹配到的原文，避免诊断消息过长。 */
function clip(text, max = 160) {
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}
/** 从原始输出里提取疑似包名，用于诊断消息精确化。 */
function extractPackageName(raw) {
    const scoped = /\b(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:@[0-9][^ )\]]*)?)/i.exec(raw);
    if (scoped)
        return scoped[1];
    const bare = /\b(dsh-[a-z0-9][a-z0-9._-]*(?:@[0-9][^ )\]]*)?)/i.exec(raw);
    if (bare)
        return bare[1];
    return undefined;
}
/** 超时 / 取消类错误没有 stdout，需要用特殊归一化。 */
function normalizeTimedOut(raw) {
    if (/timed out|killed|SIGKILL|ETIMEDOUT/i.test(raw))
        return `${raw}\nETIMEDOUT 命令超时被终止`;
    return raw;
}
/**
 * 主入口：根据一次执行的输出给出中文诊断列表。
 *
 * @param raw 原始的 stderr + stdout 拼接文本
 * @param context 附带上下文（被安装的包名等），用于生成更精确的中文说明
 */
export function diagnoseCommandOutput(raw, context) {
    const text = normalizeTimedOut(raw);
    const diagnoses = [];
    const seenCodes = new Set();
    for (const rule of RULES) {
        const match = text.match(rule.match);
        if (match === null)
            continue;
        if (seenCodes.has(rule.code))
            continue;
        seenCodes.add(rule.code);
        const pkg = context?.packageName ?? extractPackageName(text);
        diagnoses.push({
            code: rule.code,
            title: rule.title,
            detail: rule.detail(match, text),
            severity: rule.severity,
            suggestion: pkg === undefined ? rule.suggestion : `${rule.suggestion}（目标插件：${pkg}）`,
            evidence: clip(match.input ?? match[0])
        });
    }
    if (diagnoses.length === 0) {
        diagnoses.push(fallbackDiagnosis(text, context));
    }
    // 严重度排序：error > warn > info，保证多命中的情况下首要结论最有价值
    const weight = { error: 0, warn: 1, info: 2 };
    return diagnoses.sort((a, b) => weight[a.severity] - weight[b.severity]);
}
/** 未命中任何已知规则时的兜底诊断：仍然给中文说明与可操作建议。 */
function fallbackDiagnosis(raw, context) {
    const pkg = context?.packageName;
    const base = pkg === undefined ? '安装失败' : `插件 ${pkg} 安装失败`;
    return {
        code: 'E_UNKNOWN',
        title: `${base}：未识别的报错`,
        detail: `包管理器返回了本插件诊断规则未覆盖的错误。原始输出尾部："${clip(raw, 400)}"`,
        severity: 'error',
        suggestion: '先按原命令重试一次；若持续失败，请把 stderr 尾部贴给 Agent，由其逐条判断。也推荐先用 dsh_plugin_registry_check 确认 registry 连通性。',
        evidence: clip(raw, 400)
    };
}
/** 汇总一次尝试的诊断与修复动作，供上层写入 AttemptOutcome。 */
export function summarizeAttempt(raw, context) {
    const diagnoses = diagnoseCommandOutput(raw, context);
    const repairs = [];
    const seen = new Set();
    for (const diagnosis of diagnoses) {
        for (const repair of repairsForDiagnosis(diagnosis)) {
            const key = `${repair.kind}:${JSON.stringify(repair.payload ?? {})}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            repairs.push(repair);
        }
    }
    return { diagnoses, repairs };
}
/** 根据诊断找到对应规则的修复动作集合。 */
function repairsForDiagnosis(diagnosis) {
    for (const rule of RULES) {
        if (rule.code === diagnosis.code)
            return rule.repairs;
    }
    return [];
}
/** 导出规则总数，便于测试断言「覆盖度」。 */
export function diagnosisRuleCount() {
    return RULES.length;
}
/** 构造一条「成功」的诊断（供自检阶段使用）。 */
export function successDiagnosis(message) {
    return {
        code: 'OK',
        title: '安装成功',
        detail: message,
        severity: 'info',
        suggestion: '插件已可用。若它在 cordis.yml 的 dsh.profile.bundles 中被声明，Agent 即可在普通对话模式下调用。'
    };
}
/** 构造一条「需人工确认」的诊断（自检/修复上限用）。 */
export function manualInterventionDiagnosis(reason, attempts) {
    const lines = attempts
        .map((a, i) => `  第 ${i + 1} 次：${a.command} → 退出码 ${a.exitCode ?? 'null'}${a.timedOut ? '（超时）' : ''}`)
        .slice(-5)
        .join('\n');
    return {
        code: 'E_MANUAL_INTERVENTION_REQUIRED',
        title: '自动修复尝试达到上限，需人工介入',
        detail: `${reason}\n最近的尝试记录：\n${lines}`,
        severity: 'error',
        suggestion: '请把上方「尝试记录」与最后的 stderr 尾巴交给 Agent 分析；也可以先用 dsh_plugin_inspect 核对目标插件的版本、兼容性与 peer 依赖，再手动指定版本安装。'
    };
}
//# sourceMappingURL=diagnose.js.map