/**
 * dsh-plugin-installer —— DSH 插件全生命周期管理助手。
 *
 * 目标：给 Agent 提供「装、查、更、卸、启」一条龙的标准化工具。
 * 装插件是核心能力（5 种来源全自动），诊断是辅助能力；更新/卸载/启用
 * 是裸命令做不好的「DSH 语义」操作（bundles 条目联动、失败回滚）。
 *
 * 对外暴露 8 个工具：
 *
 *  1. install_dsh_plugin      —— 核心。5 种来源全自动安装（npm/本地目录/本地压缩包/远程压缩包/git）
 *  2. dsh_plugin_inspect      —— 安装前核对：元数据 / DSH 兼容性 / 可用版本
 *  3. dsh_plugin_registry_check —— 官方源 / 镜像源连通性探测
 *  4. dsh_plugin_diagnose     —— 纯诊断：npm/pnpm 报错 → 中文根因 + 修复建议
 *  5. dsh_plugin_outdated     —— 扫描可更新插件（对比 registry 最新版，识别本地依赖）
 *  6. update_dsh_plugin       —— 更新单个插件，失败自动回滚到更新前版本
 *  7. remove_dsh_plugin       —— 卸载插件并同步清理 bundles 条目（防孤儿条目）
 *  8. enable_dsh_plugin       —— 把已装未启用的插件补进 bundles（启用加载）
 *
 * 安全边界（硬约束）：
 *  - npm 元数据只访问官方 registry（host 白名单）；远程压缩包仅 https；
 *  - 只执行「安装/更新/卸载/元数据查询」类子命令，不提供任意命令执行；
 *  - 所有子进程都不经过 shell，避免命令注入。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveConfig, OFFICIAL_REGISTRY, CN_MIRROR_REGISTRY } from './core/config.js';
import { httpGet, HttpError, normalizeRegistryBase } from './core/http.js';
import { parsePackageName, isDshPackageName } from './core/package-name.js';
import { identifySource, SOURCE_KIND_LABELS } from './core/source.js';
import { detectDshSignals } from './core/registry.js';
import { fetchPluginDossier } from './core/registry.js';
import { diagnoseCommandOutput, diagnosisRuleCount } from './core/diagnose.js';
import { installPlugin, inspectProfileReadiness, runSelfCheck, readInstalledVersion } from './core/installer.js';
import { extractLocalArchive, materializeRemoteArchive, MaterializeError } from './core/archive.js';
import { scanUpdates, updatePlugin, uninstallPlugin, declaredSpec } from './core/update.js';
import { addBundleEntry, isBundled, readProfileManifest } from './core/profile.js';
/** Cordis 插件名：出现在 Loader 诊断与日志中。 */
export const name = 'dsh-plugin-installer';
/** 需要注入的服务：仅 tools。 */
export const inject = ['tools'];
/** 工具输出的 JSON Schema 声明：type 'json' 表示「任意 JSON 值」的注解式 schema。
 *  注意：value schema DSL 里 additionalProperties 只能用在 type 'object' 节点上，
 *  type 'json' 节点带 additionalProperties 会被 Loader 以 JsonSchemaError 拒绝。 */
const OUTPUT_SCHEMA = { type: 'json' };
/** 把工具返回值作为 JsonValue 读取（框架的 render / presentationMeta 拿到的是 JsonValue）。 */
function asToolResult(value) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const candidate = value;
        if (typeof candidate.ok === 'boolean' && typeof candidate.message === 'string') {
            return candidate;
        }
    }
    return { ok: false, message: '⚠️ 工具返回值异常：缺少 ok / message 字段' };
}
/** 渲染纯文本内容块。 */
function textBlock(text) {
    return [{ type: 'text', text }];
}
/** 定位 DSH profile 根目录。 */
export function resolveProfileDir() {
    // DSH 会在插件所在进程注入 DSH_PROFILE_DIR；缺失时回退到 ~/.dsh/profiles/<profile>
    const direct = process.env.DSH_PROFILE_DIR;
    if (direct !== undefined && direct.length > 0)
        return direct;
    const home = process.env.DSH_HOME;
    const profile = process.env.DSH_PROFILE ?? 'desktop';
    if (home !== undefined && home.length > 0) {
        return `${home.replace(/[\\/]$/, '')}/profiles/${profile}`;
    }
    return process.cwd();
}
/** 渲染安装结果给 Agent 看的中文摘要。 */
function renderInstallMessage(input) {
    const lines = [];
    if (input.ok) {
        lines.push(`✅ 插件 ${input.packageName} 安装成功`);
        lines.push(`- 安装版本：${input.installedVersion ?? '（未读取到）'}`);
        lines.push(`- 来源：${input.source}`);
        lines.push(`- 包管理器：${input.manager}　registry：${input.registry}`);
        lines.push(`- 尝试次数：${input.attempts}`);
        lines.push(`- 可用性自检：${input.selfCheckOk ? '通过' : '未通过'}（${input.selfCheckSummary}）`);
        lines.push('');
        lines.push('下一步：确认该包已列在 profile 的 dsh.profile.bundles 中即可被普通对话模式加载。');
    }
    else {
        lines.push(`❌ 插件 ${input.packageName} 安装失败`);
        lines.push(`- 来源：${input.source}`);
        lines.push(`- 已尝试次数：${input.attempts}　最后使用的包管理器：${input.manager}`);
        lines.push('');
        for (const diagnosis of input.diagnoses.slice(0, 3)) {
            lines.push(`【${diagnosis.title}】（${diagnosis.severity}）`);
            lines.push(`  原因：${diagnosis.detail}`);
            lines.push(`  建议：${diagnosis.suggestion}`);
        }
    }
    return lines.join('\n');
}
/** 探测一个 registry 是否可达（复用 HTTP 模块的 host 白名单与超时）。 */
async function probeRegistry(url, config) {
    return httpGet(url, config);
}
/**
 * 插件入口。
 * config 全部可选，未提供时每一项都有安全默认值（见 core/config.ts）。
 */
export function apply(ctx, config) {
    // 配置解析失败时直接抛出中文错误，Loader 会把它记录到诊断
    const resolved = resolveConfig(config);
    // ==================== 工具 1：install_dsh_plugin ====================
    ctx.tools.register(defineTool({
        name: 'install_dsh_plugin',
        description: '为一个 DSH profile 全自动安装 DSH 插件（本插件的核心能力）。支持 5 种来源，自动识别并安装：' +
            '① npm 包名（dsh-plugin 或 @scope/name，可带 @version）；' +
            '② 本地目录（含 package.json 的插件源码目录，绝对/相对路径均可）；' +
            '③ 本地压缩包（.zip/.tgz/.tar.gz，自动解压后安装）；' +
            '④ 远程压缩包（https 直链，自动下载解压后安装）；' +
            '⑤ git 仓库（git+https://github.com/owner/repo.git 或 github:owner/repo）。' +
            '安装过程自动探测 registry、自动切换源/包管理器/放宽参数重试，' +
            '完成后自动做可用性自检与一次修复重装；所有失败均给出中文根因诊断。',
        parameters: {
            package: {
                type: 'string',
                required: true,
                description: '要安装的插件来源。可传：npm 包名（"dsh-plugin"、"@scope/name@1.2.3"）、' +
                    '本地目录（"D:\\dev\\my-plugin" 或 "./my-plugin"）、' +
                    '本地压缩包（"D:\\downloads\\plugin.zip"）、' +
                    '远程压缩包（"https://example.com/plugin.zip" 或 .tgz 直链）、' +
                    'git 仓库（"git+https://github.com/owner/repo.git" 或 "github:owner/repo"）。' +
                    '不支持需要交互认证的 ssh git 地址。'
            },
            version: {
                type: 'string',
                description: '可选。仅 npm 来源生效：显式指定版本或 dist-tag（如 0.1.5 / latest / next）。省略则装 latest。'
            },
            registry: {
                type: 'string',
                description: '可选。覆盖默认 registry（仅 npm 来源生效），必须是 http(s) 地址且 host 在白名单内。'
            },
            profileDir: {
                type: 'string',
                description: '可选。目标 DSH profile 根目录。默认使用当前会话的 profile 目录。'
            },
            skipVerify: {
                type: 'boolean',
                description: '可选。为 true 时跳过安装后的自动可用性自检。默认 false（执行自检）。'
            }
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => textBlock(asToolResult(value).message),
            presentationMeta: (_args, value) => {
                const result = asToolResult(value);
                return {
                    ok: result.ok,
                    packageName: result.packageName ?? null,
                    installedVersion: result.installedVersion ?? null,
                    manager: result.manager ?? null,
                    registry: result.registry ?? null,
                    attemptCount: result.attemptCount ?? null,
                    diagnoses: result.diagnoses ?? null,
                    selfCheck: result.selfCheck ?? null
                };
            }
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `安装 DSH 插件 ${args.package}`,
            kind: 'fetch',
            rawInput: args.package
        }),
        presentResult: (args, result) => {
            const value = asToolResult(result.meta ?? { ok: false, message: '' });
            return {
                card: 'generic',
                title: value.ok ? `✅ 已安装 ${args.package}` : `❌ 安装失败 ${args.package}`,
                content: textBlock(value.message)
            };
        },
        async execute(args) {
            // ---- 1. 来源识别（5 种来源统一入口）----
            if (typeof args.package !== 'string' || args.package.trim().length === 0) {
                return {
                    ok: false,
                    message: '❌ 参数 package 不能为空。可传 npm 包名、本地目录/压缩包路径、远程压缩包 https 直链或 git 地址。',
                    diagnoses: []
                };
            }
            const source = identifySource(args.package);
            if (source.reason !== undefined) {
                return {
                    ok: false,
                    message: `❌ 无法识别安装来源：${source.reason}`,
                    packageName: args.package,
                    diagnoses: [
                        {
                            code: 'E_INVALID_SOURCE',
                            title: '安装来源校验失败',
                            detail: source.reason,
                            severity: 'error',
                            suggestion: '支持的来源：npm 包名（dsh-plugin / @scope/name@version）、本地目录、本地压缩包（.zip/.tgz/.tar.gz）、' +
                                '远程压缩包（https 直链）、git 仓库（git+https:// 或 github:owner/repo）。'
                        }
                    ]
                };
            }
            // npm 来源做严格包名校验，其他来源的校验由 installPlugin 内部完成（路径存在性、解压、manifest 等）
            let normalizedName;
            let normalizedVersion;
            if (source.kind === 'npm') {
                const parsed = parsePackageName(source.packageName ?? source.spec);
                if (!parsed.ok || parsed.name === undefined) {
                    return {
                        ok: false,
                        message: `❌ 无法识别插件包名：${parsed.reason ?? '未知原因'}`,
                        packageName: args.package,
                        diagnoses: [
                            {
                                code: 'E_INVALID_PACKAGE_NAME',
                                title: '插件包名校验失败',
                                detail: parsed.reason ?? '未知原因',
                                severity: 'error',
                                suggestion: '请传入纯包名，如 dsh-plugin 或 @scope/name，不要包含非法字符。'
                            }
                        ]
                    };
                }
                normalizedName = parsed.name;
                normalizedVersion = parsed.version ?? (typeof args.version === 'string' ? args.version : undefined);
            }
            const profileDir = typeof args.profileDir === 'string' && args.profileDir.length > 0 ? args.profileDir : resolveProfileDir();
            // ---- 2. profile 环境校验 ----
            const readiness = await inspectProfileReadiness(profileDir);
            if (readiness.length > 0) {
                return {
                    ok: false,
                    message: `❌ 目标 profile 不具备安装条件：\n${readiness.map((r) => `- ${r}`).join('\n')}`,
                    packageName: normalizedName ?? args.package,
                    profileDir,
                    diagnoses: readiness.map((issue) => ({
                        code: 'E_PROFILE_UNREADY',
                        title: 'profile 环境校验失败',
                        detail: issue,
                        severity: 'error',
                        suggestion: '确认安装目录是 DSH profile 根目录（含 package.json 与 pnpm-workspace.yaml）后重试。'
                    }))
                };
            }
            // ---- 3. 执行安装（含自动修复 + 自检） ----
            const effectiveConfig = typeof args.registry === 'string' && args.registry.length > 0
                ? { ...resolved, registry: args.registry }
                : resolved;
            if (args.skipVerify === true)
                effectiveConfig.autoVerify = false;
            const run = await installPlugin({
                spec: args.package,
                packageName: normalizedName,
                version: normalizedVersion,
                profileDir,
                config: effectiveConfig
            });
            return {
                ok: run.ok,
                message: renderInstallMessage({
                    packageName: run.packageName,
                    ok: run.ok,
                    installedVersion: run.installedVersion,
                    source: `${run.source.label}：${run.source.spec}`,
                    manager: run.manager,
                    registry: run.registry,
                    attempts: run.attempts.length,
                    diagnoses: run.diagnoses.map((d) => ({
                        title: d.title,
                        detail: d.detail,
                        suggestion: d.suggestion,
                        severity: d.severity
                    })),
                    selfCheckOk: run.selfCheck.ok,
                    selfCheckSummary: run.selfCheck.summary
                }),
                packageName: run.packageName,
                installedVersion: run.installedVersion ?? null,
                manager: run.manager,
                registry: run.registry,
                attemptCount: run.attempts.length,
                diagnoses: JSON.parse(JSON.stringify(run.diagnoses)),
                selfCheck: JSON.parse(JSON.stringify(run.selfCheck)),
                durationMs: run.durationMs
            };
        }
    }));
    // ==================== 工具 2：dsh_plugin_inspect ====================
    ctx.tools.register(defineTool({
        name: 'dsh_plugin_inspect',
        description: '从官方插件源拉取一个插件的元数据，用于安装前核对：是否存在、有哪些可用版本、是不是真正的 DSH 插件、' +
            '它声明的 dsh.bundle / dsh.compatibility / 客户端注入是什么、依赖了哪些 DSH 包。' +
            '安装失败时也可以用它核对真实包名与版本区间，再决定下一步。返回中文结论。',
        parameters: {
            package: {
                type: 'string',
                required: true,
                description: '插件来源：npm 包名（dsh-plugin / @scope/name，可带 @version）、本地目录、本地压缩包、' +
                    '远程压缩包 https 直链、git 地址。非 registry 来源会读取本地 manifest 判定。'
            }
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => textBlock(asToolResult(value).message),
            presentationMeta: (_args, value) => {
                const result = asToolResult(value);
                return { ok: result.ok, packageName: result.packageName ?? null };
            }
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `核对插件 ${args.package}`,
            kind: 'search',
            rawInput: args.package
        }),
        presentResult: (args, result) => {
            const value = asToolResult(result.meta ?? { ok: false, message: '' });
            return {
                card: 'generic',
                title: value.ok ? `✅ ${args.package} 是 DSH 插件` : `⚠️ ${args.package}`,
                content: textBlock(value.message)
            };
        },
        async execute(args) {
            if (typeof args.package !== 'string' || args.package.trim().length === 0) {
                return { ok: false, message: '❌ 参数 package 不能为空。', packageName: '' };
            }
            const source = identifySource(args.package);
            if (source.reason !== undefined) {
                return { ok: false, message: `❌ 无法识别来源：${source.reason}`, packageName: args.package };
            }
            // ---- 非 registry 来源：读取本地 manifest 做 DSH 插件判定 ----
            if (source.kind !== 'npm') {
                try {
                    let manifestDir;
                    if (source.kind === 'local-dir') {
                        manifestDir = source.localPath;
                    }
                    else if (source.kind === 'local-archive') {
                        manifestDir = await extractLocalArchive(source.localPath ?? '');
                    }
                    else if (source.kind === 'remote-archive') {
                        manifestDir = await materializeRemoteArchive(source.url ?? '', resolved.httpTimeoutMs * 4);
                    }
                    else {
                        // git 来源：无法在不 clone 的情况下预读 manifest
                        return {
                            ok: true,
                            message: `ℹ️ 来源是 git 仓库（${source.gitUrl}），无法在不拉取仓库的情况下预读元数据。\n` +
                                '直接调用 install_dsh_plugin 安装即可；安装后本工具可用包名复核。',
                            packageName: args.package,
                            sourceKind: source.kind
                        };
                    }
                    const manifestPath = `${(manifestDir ?? '').replace(/\\/g, '/')}/package.json`;
                    const { readFileSync } = await import('node:fs');
                    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                    const signals = detectDshSignals(manifest);
                    const lines = [];
                    lines.push(`📦 ${String(manifest.name ?? '(未命名)')}@${String(manifest.version ?? '?')}`);
                    if (typeof manifest.description === 'string')
                        lines.push(`- 描述：${manifest.description}`);
                    lines.push(`- 来源：${SOURCE_KIND_LABELS[source.kind]}（${source.spec}）`);
                    lines.push('');
                    lines.push('【DSH 插件判定】');
                    lines.push(signals.isDshPlugin ? '✅ 是 DSH 插件。判定依据：' : '⚠️ 未检出典型 DSH 插件特征，请谨慎安装。');
                    for (const reason of signals.reasons)
                        lines.push(`  - ${reason}`);
                    return {
                        ok: signals.isDshPlugin,
                        message: lines.join('\n'),
                        packageName: String(manifest.name ?? args.package),
                        sourceKind: source.kind,
                        isDshPlugin: signals.isDshPlugin,
                        reasons: signals.reasons
                    };
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return {
                        ok: false,
                        message: `❌ 读取来源元数据失败：${message}`,
                        packageName: args.package,
                        sourceKind: source.kind
                    };
                }
            }
            // ---- npm 来源：从 registry 拉 packument ----
            const parsed = parsePackageName(args.package);
            if (!parsed.ok || parsed.name === undefined) {
                return {
                    ok: false,
                    message: `❌ 包名校验失败：${parsed.reason ?? '未知原因'}`,
                    packageName: String(args.package)
                };
            }
            try {
                const dossier = await fetchPluginDossier(parsed.name, parsed.version, resolved);
                const lines = [];
                lines.push(`📦 ${dossier.name}@${dossier.version}${dossier.resolvedFromLatest ? '（latest）' : ''}`);
                if (dossier.description)
                    lines.push(`- 描述：${dossier.description}`);
                if (dossier.license)
                    lines.push(`- 许可协议：${dossier.license}`);
                if (dossier.unpackedSize !== undefined) {
                    lines.push(`- 解包体积：约 ${Math.round(dossier.unpackedSize / 1024)} KB`);
                }
                lines.push('');
                lines.push('【DSH 插件判定】');
                lines.push(dossier.dshSignals.isDshPlugin ? '✅ 是 DSH 插件。判定依据：' : '⚠️ 未检出典型 DSH 插件特征，请谨慎安装。');
                for (const reason of dossier.dshSignals.reasons)
                    lines.push(`  - ${reason}`);
                lines.push('');
                lines.push('【可用版本】');
                lines.push(`  - dist-tags：${JSON.stringify(dossier.distTags)}`);
                lines.push(`  - 最近版本：${dossier.availableVersions.join(', ')}`);
                if (dossier.dshField !== undefined) {
                    lines.push('');
                    lines.push('【dsh 字段原文】');
                    lines.push('```json');
                    lines.push(JSON.stringify(dossier.dshField, null, 2).slice(0, 2000));
                    lines.push('```');
                }
                if (Object.keys(dossier.peerDependencies).length > 0) {
                    lines.push('');
                    lines.push('【peer 依赖】');
                    for (const [k, v] of Object.entries(dossier.peerDependencies)) {
                        lines.push(`  - ${k}: ${v}`);
                    }
                }
                if (dossier.engines !== undefined) {
                    lines.push('');
                    lines.push('【引擎要求】');
                    for (const [k, v] of Object.entries(dossier.engines))
                        lines.push(`  - ${k}: ${v}`);
                }
                if (dossier.deprecated !== undefined) {
                    lines.push('');
                    lines.push(`⚠️ 该版本已被作者标记废弃：${dossier.deprecated}`);
                }
                lines.push('');
                lines.push(`来源：${dossier.registryBase}（耗时 ${dossier.durationMs}ms）`);
                return {
                    ok: dossier.dshSignals.isDshPlugin,
                    message: lines.join('\n'),
                    packageName: dossier.name,
                    version: dossier.version,
                    isDshPlugin: dossier.dshSignals.isDshPlugin,
                    reasons: dossier.dshSignals.reasons,
                    availableVersions: dossier.availableVersions,
                    distTags: dossier.distTags,
                    dshField: dossier.dshField === undefined ? null : JSON.parse(JSON.stringify(dossier.dshField)),
                    deprecated: dossier.deprecated === undefined ? null : dossier.deprecated
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const isMissing = message.includes('404');
                return {
                    ok: false,
                    message: `❌ 拉取元数据失败：${message}`,
                    packageName: parsed.name,
                    diagnoses: [
                        {
                            code: isMissing ? 'E_TARGET_NOT_FOUND' : 'E_REGISTRY_UNREACHABLE',
                            title: isMissing ? '插件包不存在' : '官方源暂时不可达',
                            detail: message,
                            severity: 'error',
                            suggestion: isMissing
                                ? '核对包名拼写。DSH 生态的包通常以 dsh- 或 @deepseek-ai/ 开头。'
                                : '用 dsh_plugin_registry_check 探测连通性后再重试。'
                        }
                    ]
                };
            }
        }
    }));
    // ==================== 工具 3：dsh_plugin_registry_check ====================
    ctx.tools.register(defineTool({
        name: 'dsh_plugin_registry_check',
        description: '检查官方插件源（及可选镜像源）是否连通，返回每个源的 HTTP 状态、耗时与体积。' +
            '安装失败且怀疑是网络问题时优先调用，用于区分「网络不可达」与「包本身有问题」。返回中文结论。',
        parameters: {
            registry: {
                type: 'string',
                description: '可选。额外要探测的 registry 地址（http(s)，host 需在白名单内）。'
            },
            probePackage: {
                type: 'string',
                description: '可选。用于探测的包名，默认 dsh-http-tools。只用于发一个轻量 GET 请求。'
            }
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => textBlock(asToolResult(value).message),
            presentationMeta: (_args, value) => {
                const result = asToolResult(value);
                return { ok: result.ok, results: result.results ?? null };
            }
        },
        presentCall: () => ({ card: 'generic', title: '探测插件源连通性', kind: 'fetch' }),
        presentResult: (args, result) => {
            const value = asToolResult(result.meta ?? { ok: false, message: '' });
            return {
                card: 'generic',
                title: value.ok ? '✅ 插件源可用' : '⚠️ 插件源存在问题',
                content: textBlock(value.message)
            };
        },
        async execute(args) {
            const probe = typeof args.probePackage === 'string' && args.probePackage.length > 0 ? args.probePackage : 'dsh-http-tools';
            const targets = [
                { label: '官方源', registry: OFFICIAL_REGISTRY },
                { label: '国内镜像', registry: CN_MIRROR_REGISTRY }
            ];
            if (typeof args.registry === 'string' && args.registry.length > 0) {
                targets.push({ label: '自定义源', registry: args.registry });
            }
            const results = [];
            for (const target of targets) {
                const url = `${normalizeRegistryBase(target.registry)}/${probe.replace(/\//g, '%2f')}`;
                try {
                    const probeResult = await probeRegistry(url, resolved);
                    results.push({
                        label: target.label,
                        registry: target.registry,
                        ok: true,
                        status: probeResult.status,
                        durationMs: probeResult.durationMs,
                        sizeBytes: probeResult.sizeBytes
                    });
                }
                catch (error) {
                    results.push({
                        label: target.label,
                        registry: target.registry,
                        ok: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }
            const lines = ['🔌 插件源连通性探测结果：'];
            for (const r of results) {
                const ok = r.ok === true;
                if (ok) {
                    lines.push(`✅ ${String(r.label)}（${String(r.registry)}）可用 · HTTP ${String(r.status)} · ${String(r.durationMs)}ms · ${String(r.sizeBytes ?? 0)} 字节`);
                }
                else {
                    lines.push(`❌ ${String(r.label)}（${String(r.registry)}）不可用 · ${String(r.error ?? '未知错误')}`);
                }
            }
            const ok = results.some((r) => r.ok === true);
            lines.push('');
            lines.push(ok
                ? '结论：至少有一个插件源可达，可以执行安装。'
                : '结论：所有插件源都不可达。请检查本机网络、代理或 DNS；必要时用可以联网的环境重试。');
            return { ok, message: lines.join('\n'), results };
        }
    }));
    // ==================== 工具 4：dsh_plugin_diagnose ====================
    ctx.tools.register(defineTool({
        name: 'dsh_plugin_diagnose',
        description: '把一段 npm / pnpm 的报错输出翻译成中文诊断，并给出可执行的修复动作。' +
            '覆盖网络超时、DNS 失败、代理拦截、registry 认证、包不存在、版本非法、peer 依赖冲突、' +
            'DSH runtime 不兼容、安装脚本失败、锁文件过期、权限不足、磁盘满、完整性校验失败、平台不匹配等场景。' +
            '本工具不执行任何安装，只做诊断，适合让 Agent 先理解失败原因再决定策略。',
        parameters: {
            output: {
                type: 'string',
                required: true,
                description: 'npm/pnpm 的报错输出（stderr 优先，可含 stdout）。'
            },
            package: {
                type: 'string',
                description: '可选。出问题的插件包名，用于生成更精确的中文结论。'
            }
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => textBlock(asToolResult(value).message),
            presentationMeta: (_args, value) => {
                const result = asToolResult(value);
                return { ok: result.ok, diagnoses: result.diagnoses ?? null };
            }
        },
        presentCall: (args) => ({
            card: 'generic',
            title: '诊断安装报错',
            kind: 'other',
            rawInput: args.package
        }),
        presentResult: (args, result) => {
            const value = asToolResult(result.meta ?? { ok: false, message: '' });
            const diagnoses = Array.isArray(value.diagnoses) ? value.diagnoses : [];
            const first = diagnoses.find((d) => typeof d === 'object' && d !== null);
            const severity = typeof first?.severity === 'string' ? first.severity : 'error';
            const title = severity === 'error' ? '❌ 诊断到错误' : severity === 'warn' ? '⚠️ 诊断到警告' : 'ℹ️ 诊断为提示';
            return { card: 'generic', title, content: textBlock(value.message) };
        },
        async execute(args) {
            if (typeof args.output !== 'string' || args.output.trim().length === 0) {
                return {
                    ok: false,
                    message: '❌ 参数 output 不能为空：请粘贴 npm/pnpm 的报错输出。',
                    diagnoses: []
                };
            }
            const diagnoses = diagnoseCommandOutput(args.output, {
                packageName: typeof args.package === 'string' ? args.package : undefined
            });
            const lines = [`🧯 故障诊断（命中 ${diagnoses.length} 条，规则库共 ${diagnosisRuleCount()} 条）：`, ''];
            for (const [index, d] of diagnoses.entries()) {
                lines.push(`${index + 1}. 【${d.title}】(${d.severity})  [${d.code}]`);
                lines.push(`   原因：${d.detail}`);
                lines.push(`   建议：${d.suggestion}`);
            }
            const isDshPackage = typeof args.package === 'string' && isDshPackageName(args.package);
            lines.push('');
            lines.push(isDshPackage
                ? '提示：目标包名位于 DSH 命名空间下，可继续用 install_dsh_plugin 触发自动安装（会自动套用上述修复策略）。'
                : '提示：如果目标确实是 DSH 插件，建议先用 dsh_plugin_inspect 核对包名。');
            return {
                ok: diagnoses.every((d) => d.severity !== 'error'),
                message: lines.join('\n'),
                diagnoses: JSON.parse(JSON.stringify(diagnoses))
            };
        }
    }));
    // ==================== 工具 5：dsh_plugin_outdated（更新扫描）====================
    ctx.tools.register(defineTool({
        name: 'dsh_plugin_outdated',
        description: '扫描当前 DSH profile 中已安装的插件，对比官方 registry 最新版本，列出可更新项。' +
            '自动识别 link:/file: 本地依赖（没有 registry 版本概念，会标注原因而不是报错）与 DSH 内部包。' +
            '一次调用即可知道「哪些插件该更新、从什么版本更新到什么版本」，' +
            '比逐个查询 registry 再手工对比快得多，也不会漏掉本地依赖的误更新。',
        parameters: {
            profileDir: {
                type: 'string',
                description: '可选。目标 DSH profile 根目录。默认使用当前会话的 profile 目录。'
            }
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => textBlock(asToolResult(value).message),
            presentationMeta: (_args, value) => {
                const result = asToolResult(value);
                return { ok: result.ok, updatable: result.updatable ?? null };
            }
        },
        presentCall: () => ({ card: 'generic', title: '扫描可更新的 DSH 插件', kind: 'search' }),
        presentResult: (_args, result) => {
            const value = asToolResult(result.meta ?? { ok: false, message: '' });
            const updatable = typeof value.updatable === 'number' ? value.updatable : 0;
            return {
                card: 'generic',
                title: updatable > 0 ? `🔄 发现 ${updatable} 个可更新插件` : '✅ 插件均为最新',
                content: textBlock(value.message)
            };
        },
        async execute(args) {
            const profileDir = typeof args.profileDir === 'string' && args.profileDir.length > 0 ? args.profileDir : resolveProfileDir();
            const readiness = await inspectProfileReadiness(profileDir);
            if (readiness.length > 0) {
                return {
                    ok: false,
                    message: `❌ 目标 profile 不可用：\n${readiness.map((r) => `- ${r}`).join('\n')}`,
                    updatable: 0
                };
            }
            const scan = await scanUpdates(profileDir, resolved);
            const lines = [`📋 插件更新扫描（${scan.entries.length} 个依赖）：`, ''];
            for (const entry of scan.entries) {
                const icon = entry.updateAvailable ? '🔄' : entry.sourceKind === 'registry' ? '✅' : 'ℹ️';
                const versionText = entry.sourceKind === 'registry'
                    ? `${entry.installedVersion ?? '(未安装)'} → ${entry.latestVersion ?? '?'}`
                    : `${entry.installedVersion ?? '(未安装)'}（${entry.sourceKind} 依赖）`;
                lines.push(`${icon} ${entry.name}  ${versionText}`);
                lines.push(`    ${entry.note}`);
            }
            if (scan.updatable > 0) {
                lines.push('');
                lines.push(`共 ${scan.updatable} 个插件可更新。用 update_dsh_plugin 传入包名即可自动更新（失败自动回滚）。`);
            }
            else {
                lines.push('');
                lines.push('所有 registry 依赖均已是最新版。');
            }
            if (scan.warnings.length > 0) {
                lines.push('');
                lines.push('⚠️ 扫描警告：');
                for (const w of scan.warnings)
                    lines.push(`  - ${w}`);
            }
            return {
                ok: true,
                message: lines.join('\n'),
                updatable: scan.updatable,
                entries: JSON.parse(JSON.stringify(scan.entries)),
                warnings: scan.warnings
            };
        }
    }));
    // ==================== 工具 6：update_dsh_plugin（更新 + 自动回滚）====================
    ctx.tools.register(defineTool({
        name: 'update_dsh_plugin',
        description: '把一个已安装的 DSH 插件更新到最新（或指定）版本，失败时自动回滚到更新前版本。' +
            '与裸跑 pnpm update 的区别：① 先确认目标是 registry 依赖（link:/file: 本地依赖会中文说明无需更新，不会误操作）；' +
            '② 更新过程复用全套自动修复（换源/放宽 peer/重试）；' +
            '③ 装不上时自动装回旧版本，保证 profile 不停留在半升级状态；' +
            '④ 更新后自动做可用性自检。全程中文反馈。',
        parameters: {
            package: {
                type: 'string',
                required: true,
                description: '要更新的插件包名，如 dsh-plugin 或 @scope/name。'
            },
            version: {
                type: 'string',
                description: '可选。目标版本（用于降级或锁定中间版本）；省略则更新到 registry latest。'
            },
            profileDir: {
                type: 'string',
                description: '可选。目标 DSH profile 根目录。默认当前会话的 profile 目录。'
            }
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => textBlock(asToolResult(value).message),
            presentationMeta: (_args, value) => {
                const result = asToolResult(value);
                return {
                    ok: result.ok,
                    previousVersion: result.previousVersion ?? null,
                    newVersion: result.newVersion ?? null,
                    rolledBack: result.rolledBack ?? null
                };
            }
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `更新 DSH 插件 ${args.package}`,
            kind: 'execute',
            rawInput: args.package
        }),
        presentResult: (args, result) => {
            const value = asToolResult(result.meta ?? { ok: false, message: '' });
            const rolledBack = value.rolledBack === true;
            return {
                card: 'generic',
                title: value.ok
                    ? `✅ ${args.package} 更新完成`
                    : rolledBack
                        ? `⚠️ ${args.package} 更新失败，已回滚`
                        : `❌ ${args.package} 更新失败`,
                content: textBlock(value.message)
            };
        },
        async execute(args) {
            const parsed = parsePackageName(args.package);
            if (!parsed.ok || parsed.name === undefined) {
                return {
                    ok: false,
                    message: `❌ 包名校验失败：${parsed.reason ?? '未知原因'}。更新工具只接受 npm 包名。`,
                    diagnoses: []
                };
            }
            const profileDir = typeof args.profileDir === 'string' && args.profileDir.length > 0 ? args.profileDir : resolveProfileDir();
            const run = await updatePlugin({
                packageName: parsed.name,
                version: typeof args.version === 'string' ? args.version : undefined,
                profileDir,
                config: resolved
            });
            const lines = [];
            if (run.ok) {
                lines.push(`✅ ${run.name} 更新成功：${run.previousVersion ?? '(未安装)'} → ${run.newVersion ?? '?'}`);
                lines.push(`- 可用性自检：${run.selfCheckSummary ?? ''}`);
            }
            else {
                lines.push(`❌ ${run.name} 更新失败${run.rolledBack ? '（已自动回滚）' : ''}`);
                lines.push(`- 目标版本：${args.version ?? 'latest'}　更新前版本：${run.previousVersion ?? '(未安装)'}`);
                lines.push('');
                for (const d of run.diagnoses.slice(0, 4)) {
                    lines.push(`【${d.title}】（${d.severity}）`);
                    lines.push(`  原因：${d.detail}`);
                    lines.push(`  建议：${d.suggestion}`);
                }
            }
            return {
                ok: run.ok,
                message: lines.join('\n'),
                name: run.name,
                previousVersion: run.previousVersion ?? null,
                newVersion: run.newVersion ?? null,
                rolledBack: run.rolledBack,
                rollbackOk: run.rollbackOk ?? null,
                attemptCount: run.attempts.length,
                diagnoses: JSON.parse(JSON.stringify(run.diagnoses))
            };
        }
    }));
    // ==================== 工具 7：remove_dsh_plugin（卸载 + 清理 bundles）====================
    ctx.tools.register(defineTool({
        name: 'remove_dsh_plugin',
        description: '卸载一个 DSH 插件：从 profile 依赖中移除，并同步清理 dsh.profile.bundles 条目（默认）。' +
            '裸跑 pnpm remove 会留下 bundles 孤儿条目，导致下次启动 DSH 报「cannot resolve profile bundle」——' +
            '本工具把这两步做成原子操作，卸载后自动校验 node_modules 与 bundles 均已干净。重启 DSH 后生效。',
        parameters: {
            package: {
                type: 'string',
                required: true,
                description: '要卸载的插件包名。'
            },
            keepBundleEntry: {
                type: 'boolean',
                description: '可选。为 true 时保留 dsh.profile.bundles 条目（只摘依赖）。默认 false（同步清理）。'
            },
            profileDir: {
                type: 'string',
                description: '可选。目标 DSH profile 根目录。默认当前会话的 profile 目录。'
            }
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => textBlock(asToolResult(value).message),
            presentationMeta: (_args, value) => {
                const result = asToolResult(value);
                return { ok: result.ok, removedBundleEntry: result.removedBundleEntry ?? null };
            }
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `卸载 DSH 插件 ${args.package}`,
            kind: 'delete',
            rawInput: args.package
        }),
        presentResult: (args, result) => {
            const value = asToolResult(result.meta ?? { ok: false, message: '' });
            return {
                card: 'generic',
                title: value.ok ? `🗑️ 已卸载 ${args.package}` : `❌ 卸载失败 ${args.package}`,
                content: textBlock(value.message)
            };
        },
        async execute(args) {
            const parsed = parsePackageName(args.package);
            if (!parsed.ok || parsed.name === undefined) {
                return { ok: false, message: `❌ 包名校验失败：${parsed.reason ?? '未知原因'}`, diagnoses: [] };
            }
            const profileDir = typeof args.profileDir === 'string' && args.profileDir.length > 0 ? args.profileDir : resolveProfileDir();
            const run = await uninstallPlugin({
                packageName: parsed.name,
                profileDir,
                config: resolved,
                removeFromBundles: args.keepBundleEntry !== true
            });
            const lines = [];
            if (run.ok) {
                lines.push(`🗑️ 已卸载 ${run.name}${run.removedBundleEntry ? '，并从 dsh.profile.bundles 移除' : ''}`);
                lines.push('重启 DSH 后生效。');
            }
            else {
                lines.push(`❌ 卸载 ${run.name} 未完全成功`);
                for (const d of run.diagnoses.slice(0, 3)) {
                    lines.push(`【${d.title}】（${d.severity}）`);
                    lines.push(`  原因：${d.detail}`);
                    lines.push(`  建议：${d.suggestion}`);
                }
            }
            return {
                ok: run.ok,
                message: lines.join('\n'),
                name: run.name,
                removedDependency: run.removedDependency,
                removedBundleEntry: run.removedBundleEntry,
                diagnoses: JSON.parse(JSON.stringify(run.diagnoses))
            };
        }
    }));
    // ==================== 工具 8：enable_dsh_plugin（补 bundles 条目）====================
    ctx.tools.register(defineTool({
        name: 'enable_dsh_plugin',
        description: '把一个已安装但未启用的 DSH 插件加入 dsh.profile.bundles（启用加载）。' +
            '解决「依赖装了但 DSH 不加载」这一最常见的配置遗漏：插件必须同时满足' +
            '「在 dependencies 里」与「在 dsh.profile.bundles 里」才会被 Loader 加载。' +
            '本工具只补声明、不动依赖，幂等可重复调用。重启 DSH 后生效。',
        parameters: {
            package: {
                type: 'string',
                required: true,
                description: '要启用的插件包名（须已在 profile 依赖中）。'
            },
            profileDir: {
                type: 'string',
                description: '可选。目标 DSH profile 根目录。默认当前会话的 profile 目录。'
            }
        },
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => textBlock(asToolResult(value).message),
            presentationMeta: (_args, value) => {
                const result = asToolResult(value);
                return { ok: result.ok };
            }
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `启用 DSH 插件 ${args.package}`,
            kind: 'edit',
            rawInput: args.package
        }),
        presentResult: (args, result) => {
            const value = asToolResult(result.meta ?? { ok: false, message: '' });
            return {
                card: 'generic',
                title: value.ok ? `✅ 已启用 ${args.package}` : `❌ 启用失败 ${args.package}`,
                content: textBlock(value.message)
            };
        },
        async execute(args) {
            const parsed = parsePackageName(args.package);
            if (!parsed.ok || parsed.name === undefined) {
                return { ok: false, message: `❌ 包名校验失败：${parsed.reason ?? '未知原因'}`, diagnoses: [] };
            }
            const name = parsed.name;
            const profileDir = typeof args.profileDir === 'string' && args.profileDir.length > 0 ? args.profileDir : resolveProfileDir();
            // 前置：依赖必须已声明
            const declared = declaredSpec(profileDir, name);
            if (declared === undefined) {
                return {
                    ok: false,
                    message: `❌ ${name} 不在 profile 依赖中，无法启用。\n` +
                        '请先用 install_dsh_plugin 安装；装完会自动加入 bundles（enable_dsh_plugin 用于补齐遗漏场景）。'
                };
            }
            const manifest = readProfileManifest(profileDir);
            if (isBundled(manifest, name)) {
                return {
                    ok: true,
                    message: `✅ ${name} 已在 dsh.profile.bundles 中，无需重复启用。重启 DSH 后即可加载。`
                };
            }
            addBundleEntry(profileDir, name);
            // 写后复核：确认条目真的落盘
            const nowBundled = isBundled(readProfileManifest(profileDir), name);
            return {
                ok: nowBundled,
                message: nowBundled
                    ? `✅ 已把 ${name} 加入 dsh.profile.bundles（依赖声明：${declared}）。重启 DSH 后生效。`
                    : `❌ 写入后复核失败：${name} 仍未出现在 dsh.profile.bundles 中，请检查 profile 的 package.json 写权限。`
            };
        }
    }));
}
// 导出内部模块，便于测试与二次封装
export { parsePackageName, detectNonRegistrySource, isDshPackageName } from './core/package-name.js';
export { diagnoseCommandOutput, diagnosisRuleCount } from './core/diagnose.js';
export { fetchPluginDossier, packumentUrl, detectDshSignals } from './core/registry.js';
export { identifySource, SOURCE_KIND_LABELS } from './core/source.js';
export { installPlugin, inspectProfileReadiness, runSelfCheck, readInstalledVersion } from './core/installer.js';
export { scanUpdates, updatePlugin, uninstallPlugin } from './core/update.js';
export { addBundleEntry, removeBundleEntry, isBundled, readProfileManifest } from './core/profile.js';
export { HttpError };
//# sourceMappingURL=index.js.map