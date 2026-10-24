/**
 * 插件包名的解析、规范化与合法性校验。
 *
 * 这是「全自动识别」的第一道关卡：Agent 传入的可能是
 * "dsh-http-tools"、"@scope/name@1.2.3"、"name@latest"、"npm i name" 等，
 * 这里统一归一化为标准 spec，并在不合法时给出中文失败原因。
 */
/** DSH 官方命名空间：只有这些前缀的包被视为「DSH 插件」。 */
const DSH_SCOPES = ['@deepseek-ai/', 'dsh-'];
/**
 * 常见误输入的前缀，需要被剥掉。
 * 每一项都带尾部空格，避免把包名本身的一部分误当作前缀。
 */
const NOISE_PREFIXES = ['npm install ', 'npm i ', 'pnpm install ', 'pnpm add ', 'pnpm i ', 'yarn add '];
/** 裸名部分不允许出现的字符（斜杠交给 scope 规则单独处理）。 */
const INVALID_NAME_CHARS = /[\\`'"<>()[\]{}\s|&;$]/;
/** 版本号不允许出现的字符。 */
const INVALID_VERSION_CHARS = /[\\/`'"<>()[\]{}\s|&;$]/;
/** 裸包名的合法格式。 */
const BARE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
/** 作用域的合法格式（@ 开头 + 首字符为字母数字）。 */
const SCOPE_PATTERN = /^@[a-z0-9][a-z0-9._-]*$/i;
/**
 * 解析并校验一个插件包名 / 安装规格。
 *
 * @param raw Agent 传入的原始字符串
 */
export function parsePackageName(raw) {
    if (typeof raw !== 'string') {
        return { ok: false, reason: '包名必须是字符串' };
    }
    let input = raw.trim();
    if (input.length === 0) {
        return { ok: false, reason: '包名不能为空' };
    }
    // 剥掉用户常见的命令式输入噪声，例如 "npm i dsh-http-tools"
    const lowered = input.toLowerCase();
    for (const prefix of NOISE_PREFIXES) {
        if (lowered.startsWith(prefix)) {
            input = input.slice(prefix.length).trim();
            break;
        }
    }
    if (input.length === 0) {
        return { ok: false, reason: '剥掉命令前缀后没有剩下包名' };
    }
    // 剥掉协议头，例如 "https://registry.npmjs.org/dsh-http-tools"
    if (/^https?:\/\//i.test(input)) {
        try {
            const url = new URL(input);
            input = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        }
        catch {
            return { ok: false, reason: '无法从 URL 中解析出包名' };
        }
    }
    // 分离版本：scope 包 @scope/name@version，普通包 name@version。
    // 第一个 @ 若是开头字符（位置 0）则是 scope 标记，不算版本分隔符；
    // 版本分隔符取「最后一个不在位置 0 的 @」。
    let namePart = input;
    let version;
    let lastAt = -1;
    for (let i = input.length - 1; i > 0; i -= 1) {
        if (input[i] === '@') {
            lastAt = i;
            break;
        }
    }
    if (lastAt > 0) {
        namePart = input.slice(0, lastAt);
        version = input.slice(lastAt + 1).trim();
        if (version.length === 0)
            version = undefined;
    }
    if (version !== undefined && INVALID_VERSION_CHARS.test(version)) {
        return { ok: false, reason: '版本号含有非法字符' };
    }
    // scope 校验：只允许 @scope/name 这一种含斜杠的形式。
    // 因此先确认「有且仅有一个斜杠」，再分别校验 scope 段与裸名段。
    const nameSegments = namePart.split('/');
    const slashCount = namePart.includes('/') ? nameSegments.length - 1 : 0;
    let scope;
    let bare;
    if (slashCount === 0) {
        bare = namePart;
    }
    else if (slashCount === 1) {
        scope = nameSegments[0] ?? '';
        bare = nameSegments[1] ?? '';
        if (!scope.startsWith('@') || scope.length <= 1) {
            return { ok: false, reason: '作用域必须以 @ 开头且非空（形如 @scope/name）' };
        }
        if (!SCOPE_PATTERN.test(scope)) {
            return { ok: false, reason: `作用域名 "${scope}" 含有非法字符` };
        }
    }
    else {
        return { ok: false, reason: '带作用域的包名必须且只能有一个 "/"（形如 @scope/name）' };
    }
    if (namePart.length > 214) {
        return { ok: false, reason: '包名长度超过 npm 的 214 字符上限' };
    }
    // 斜杠既已按 scope 规则放行，这里只检查裸名部分的非法字符
    if (INVALID_NAME_CHARS.test(bare)) {
        return { ok: false, reason: `包名 "${bare}" 含有非法字符（空格、括号、引号等）` };
    }
    if (bare.length === 0) {
        return { ok: false, reason: '包名不能为空' };
    }
    if (bare.startsWith('.') || bare.startsWith('-')) {
        return { ok: false, reason: '包名不能以 "." 或 "-" 开头' };
    }
    if (!BARE_NAME_PATTERN.test(bare)) {
        return { ok: false, reason: `包名 "${bare}" 含有非法字符或格式不正确` };
    }
    return { ok: true, name: namePart, scope, bare, version };
}
/**
 * 判断一个包是否属于 DSH 插件生态。
 * 判定依据：包名位于官方命名空间下。
 */
export function isDshPackageName(name) {
    return DSH_SCOPES.some((prefix) => name.startsWith(prefix));
}
/**
 * 构造用于 `pnpm add` / `npm install` 的标准 spec。
 * 无版本约束时省略 @version，交由包管理器解析 latest。
 */
export function buildInstallSpec(name, version) {
    if (version === undefined)
        return name;
    if (version === 'latest')
        return `${name}@latest`;
    return `${name}@${version}`;
}
/** 规范化版本字符串 → semver 主版本数字。失败返回 null。 */
export function parseMajorVersion(version) {
    const match = /^v?(\d+)\./.exec(version.trim());
    if (!match)
        return null;
    const major = Number(match[1]);
    return Number.isFinite(major) ? major : null;
}
/**
 * 本地路径 / git / tarball 关键词：这些一律视为非 registry 来源，直接拒绝。
 *
 * 顺序有意义：`git+` 排在 `git:` 之前，让 `git+https://...` 命中更精确的标识。
 */
const LOCAL_SOURCE_HINTS = ['file:', 'git+', 'git:', '.tgz', '.tar.gz', 'link:', 'c:\\', 'd:\\', '/users/', '/home/'];
/** 关键词的展示名（返回给调用方用于中文错误消息）。 */
const LOCAL_SOURCE_LABELS = {
    'file:': '本地路径',
    'git+': 'git 源',
    'git:': 'git 源',
    '.tgz': '本地 tarball',
    '.tar.gz': '本地 tarball',
    'link:': '本地 link 协议',
    'c:\\': '本地绝对路径',
    'd:\\': '本地绝对路径',
    '/users/': '本地绝对路径',
    '/home/': '本地绝对路径'
};
/**
 * 判断传入的字符串是否指向「本地路径 / git / tarball」等非官方源。
 * 本插件只支持从官方插件源安装，遇到本地来源要给出中文拒绝理由。
 *
 * @param raw 原始输入（未做包名校验）
 * @returns 命中的原始关键词；未命中返回 undefined
 */
export function detectNonRegistrySource(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const lowered = raw.toLowerCase();
    return LOCAL_SOURCE_HINTS.find((hint) => lowered.includes(hint));
}
/** 把 detectNonRegistrySource 命中的关键词转成中文来源说明。 */
export function describeNonRegistrySource(hint) {
    return LOCAL_SOURCE_LABELS[hint.toLowerCase()] ?? hint;
}
/** DSH 命名空间常量集中导出，便于测试引用。 */
export const DSH_PLUGIN_SCOPES = ['@deepseek-ai/', 'dsh-'];
//# sourceMappingURL=package-name.js.map