// Launch-description contract: validation regexes, desc loading/normalization,
// executable resolution (wrapper/shim rejection) and registry app upsert.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { usageError, conflictError } from './errors.mjs';
import { decodeText } from './decode.mjs';

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 可登记的运行形态标签：java/jrebel 为 JVM 应用，python/node 为对应解释器进程，
// proc 为其他真实可执行进程（编译产物、dotnet、php 等）
export const MODES = new Set(['java', 'jrebel', 'python', 'node', 'proc']);
// 启动目标校验：.cmd/.bat/.ps1 包装与 WindowsApps 0 字节 stub 会改变子进程形态一律拒绝
export const WRAPPER_EXT_RE = /\.(cmd|bat|ps1)$/i;
export const EXEC_EXT_RE = /\.(exe|com)$/i;
// 命令模式的目标进程映像基名：Windows 必须 .exe/.com；Linux 允许无扩展名（node/java），
// 只要求是单个文件名，不含路径分隔符。
export const IMAGE_NAME_RE = process.platform === 'win32'
  ? /^[^\\/]+\.(exe|com)$/i
  : /^[^/\\]+$/;

export const RUN_LOG_MAX_BYTES = 16 * 1024 * 1024; // 单次运行日志的写入上限（超过即轮转）

export function computeAppId(root, entry) {
  const key = process.platform === 'win32'
    ? `${root.toLowerCase()}\u0000${entry.toLowerCase()}`
    : `${root}\u0000${entry}`;
  return 'a' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 15);
}

export function newRunId() {
  return `r${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

// 受管启动描述：完整校验（start-new）
export function loadManagedDesc(file) {
  if (!file) throw usageError('start-new 需要 --desc <启动描述 JSON 文件>');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw usageError(`启动描述文件不可读：${e.message}`);
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    throw usageError(`启动描述 JSON 无效：${e.message}`);
  }
  if (!d || typeof d !== 'object') throw usageError('启动描述必须是 JSON 对象');
  const errs = [];
  if (!ALIAS_RE.test(d.alias ?? '')) errs.push(`alias 需匹配 ${ALIAS_RE}`);
  if (!d.root || !path.isAbsolute(d.root)) errs.push('root 必须是绝对路径');
  if (d.cwd != null && !path.isAbsolute(d.cwd)) errs.push('cwd 必须是绝对路径');
  if (d.entry != null && !ENTRY_RE.test(d.entry)) errs.push(`entry 需匹配 ${ENTRY_RE}`);
  const hasExe = typeof d.exe === 'string' && d.exe;
  const hasCmd = typeof d.command === 'string' && d.command.trim();
  // 两种受管形态：exe+args（真实可执行进程）或 command+expectedImage（脚本/复合命令，wrapper+后代发现）
  if (!hasExe && !hasCmd) errs.push('exe 或 command 必填其一');
  if (hasExe && hasCmd) errs.push('exe 与 command 只能填一个（command 已是完整命令行）');
  if (hasCmd && d.command.length > 2000) errs.push('command 不超过 2000 字符');
  if (hasCmd && d.args != null) errs.push('command 模式不接受 args（参数写入 command 本身）');
  if (hasCmd && !IMAGE_NAME_RE.test(d.expectedImage ?? '')) errs.push('command 模式需要 expectedImage（目标进程映像基名，如 node.exe/java.exe）');
  if (hasExe && (d.expectedImage != null || d.discoverTimeoutMs != null)) errs.push('expectedImage/discoverTimeoutMs 仅 command 模式使用');
  if (d.discoverTimeoutMs != null && (!Number.isInteger(d.discoverTimeoutMs) || d.discoverTimeoutMs < 1000 || d.discoverTimeoutMs > 120000)) errs.push('discoverTimeoutMs 需为 1000-120000 整数');
  if (d.args != null && (!Array.isArray(d.args) || d.args.some((a) => typeof a !== 'string'))) errs.push('args 必须是字符串数组');
  if (d.envRefs != null && (!Array.isArray(d.envRefs) || d.envRefs.some((a) => typeof a !== 'string' || !ENV_NAME_RE.test(a)))) errs.push('envRefs 必须是合法环境变量名数组（仅名称，不含值）');
  if (d.envFile != null && (typeof d.envFile !== 'string' || !d.envFile.trim())) errs.push('envFile 必须是非空字符串路径');
  if (d.env != null && (!d.env || typeof d.env !== 'object' || Array.isArray(d.env))) errs.push('env 必须是环境变量名到字符串值的对象');
  else if (d.env != null && Object.entries(d.env).some(([name, value]) => !ENV_NAME_RE.test(name) || typeof value !== 'string')) errs.push('env 的键必须是合法环境变量名，值必须是字符串');
  if (d.mode != null && !MODES.has(d.mode)) errs.push(`mode 只能是 ${[...MODES].join(' 或 ')}`);
  if (d.expectedPort != null && (!Number.isInteger(d.expectedPort) || d.expectedPort < 1 || d.expectedPort > 65535)) errs.push('expectedPort 需为 1-65535 的整数');
  if (d.readyLogPattern != null) {
    if (typeof d.readyLogPattern !== 'string' || !d.readyLogPattern) errs.push('readyLogPattern 必须是非空字符串（正则）');
    else { try { new RegExp(d.readyLogPattern); } catch { errs.push('readyLogPattern 不是合法正则'); } }
  }
  if (d.readyUrl != null) {
    if (typeof d.readyUrl !== 'string' || !/^https?:\/\//.test(d.readyUrl)) errs.push('readyUrl 必须是 http(s) URL');
    else { try { new URL(d.readyUrl); } catch { errs.push('readyUrl 不是合法 URL'); } }
  }
  if (d.logMaxBytes != null && (!Number.isSafeInteger(d.logMaxBytes) || d.logMaxBytes < 1024 || d.logMaxBytes > 1024 * 1024 * 1024)) errs.push('logMaxBytes 需为 1024 到 1073741824 的整数');
  if (errs.length) throw usageError(`启动描述无效：${errs.join('；')}`);
  return {
    alias: d.alias,
    displayName: typeof d.displayName === 'string' && d.displayName ? d.displayName : d.alias,
    root: d.root,
    entry: d.entry ?? 'default',
    cwd: d.cwd ?? d.root,
    mode: d.mode ?? 'java',
    exe: d.exe ?? null,
    args: d.args ?? [],
    command: d.command ?? null,
    expectedImage: d.expectedImage ?? null,
    discoverTimeoutMs: d.discoverTimeoutMs ?? null,
    envRefs: d.envRefs ?? [],
    envFile: typeof d.envFile === 'string' ? d.envFile : null,
    env: d.env ?? {},
    expectedPort: Number.isInteger(d.expectedPort) ? d.expectedPort : null,
    readyLogPattern: d.readyLogPattern ?? null,
    readyUrl: d.readyUrl ?? null,
    logMaxBytes: d.logMaxBytes ?? RUN_LOG_MAX_BYTES,
    sourceFingerprint: typeof d.sourceFingerprint === 'string' ? d.sourceFingerprint : null,
  };
}

// 非受管登记描述：宽松校验（record-unmanaged）
export function loadUnmanagedDesc(file) {
  if (!file) throw usageError('record-unmanaged 需要 --desc <描述 JSON 文件>');
  let d;
  try {
    d = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw usageError(`描述文件不可读或 JSON 无效：${e.message}`);
  }
  if (!d || typeof d !== 'object') throw usageError('描述必须是 JSON 对象');
  const errs = [];
  if (!ALIAS_RE.test(d.alias ?? '')) errs.push(`alias 需匹配 ${ALIAS_RE}`);
  if (!d.root || !path.isAbsolute(d.root)) errs.push('root 必须是绝对路径');
  // 宽松校验仍要挡住明显非法类型：这些字段会原样进注册表，错了在下游才炸。
  if (d.displayName != null && typeof d.displayName !== 'string') errs.push('displayName 必须是字符串');
  if (d.entry != null && !ENTRY_RE.test(d.entry)) errs.push(`entry 需匹配 ${ENTRY_RE}`);
  if (d.mode != null && !MODES.has(d.mode)) errs.push(`mode 只能是 ${[...MODES].join(' 或 ')}`);
  if (d.cwd != null && (typeof d.cwd !== 'string' || !path.isAbsolute(d.cwd))) errs.push('cwd 必须是绝对路径');
  if (d.expectedPort != null && (!Number.isInteger(d.expectedPort) || d.expectedPort < 1 || d.expectedPort > 65535)) errs.push('expectedPort 需 1-65535 的整数');
  if (d.logHints != null && (!Array.isArray(d.logHints) || d.logHints.some((h) => typeof h !== 'string'))) errs.push('logHints 必须是字符串数组');
  if (errs.length) throw usageError(`描述无效：${errs.join('；')}`);
  return d;
}

export function realpathOrConflict(label, p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    throw conflictError('CONFIG_INVALID', `${label} 不存在或不可解析：${p}（Skill 需重新分析该目标项目）`);
  }
}

// WindowsApps 应用执行别名：Node lstat 视为符号链接（AppX reparse point）。
// 未安装应用时是 0 字节 stub（运行即打开商店），已安装时也无法预先验证目标进程身份，
// 一律不作为受管 exe——真实解释器应来自安装目录或项目 venv。
function isAppExecAlias(file) {
  if (!/\\Microsoft\\WindowsApps\\/i.test(file)) return false;
  try {
    const st = fs.lstatSync(file);
    return st.size === 0 || st.isSymbolicLink();
  } catch {
    return false;
  }
}

// 校验解析出的候选可执行文件：返回 null 表示可用，否则为拒绝原因。
function exeRejection(resolved) {
  if (process.platform !== 'win32') return posixExeRejection(resolved);
  if (isAppExecAlias(resolved)) {
    return `WindowsApps 应用执行别名（reparse point，无法核验真实目标进程）`;
  }
  if (WRAPPER_EXT_RE.test(resolved)) {
    return `脚本包装（${path.extname(resolved)}），真实进程会变成其子进程：日志句柄不落地、终止目标错位`;
  }
  if (/javapath/i.test(resolved)) {
    return `Oracle javapath 转发 shim，其真实 JVM 为子进程：日志句柄不落地、终止会错位`;
  }
  if (!EXEC_EXT_RE.test(resolved)) {
    return `不是可直接启动的可执行文件（受管要求 .exe/.com）；请解析到底层真实进程`;
  }
  return null;
}

// POSIX：必须是普通文件 + 可执行位；#! 脚本是包装进程（真实目标是解释器子进程），
// 与 Windows 的 .cmd/.bat 同类，必须解析到真实解释器或改用 command 模式。
function posixExeRejection(resolved) {
  let st;
  try { st = fs.statSync(resolved); } catch { return '不可执行或不是普通文件'; }
  if (!st.isFile()) return '不是普通文件';
  if (/\.(cmd|bat|ps1)$/i.test(resolved)) {
    return `Windows 脚本包装（${path.extname(resolved)}），Linux 上无法作为受管进程`;
  }
  let real = resolved;
  try { real = fs.realpathSync.native(resolved); } catch { /* 保持原路径 */ }
  try { fs.accessSync(real, fs.constants.X_OK); } catch { return '没有可执行权限'; }
  try {
    const fd = fs.openSync(real, 'r');
    try {
      const head = Buffer.alloc(2);
      const n = fs.readSync(fd, head, 0, 2, 0);
      if (n === 2 && head[0] === 0x23 && head[1] === 0x21) {
        return `脚本包装（#!），真实进程会变成解释器子进程：日志句柄不落地、终止目标错位`;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* 读不到头部：交给 spawn 报错，不据此拒绝 */ }
  return null;
}

// where 的输出按系统 ANSI 代码页编码（中文 Windows 为 GBK）：与日志解码同策略，
// 收敛到 lib/decode.mjs（UTF-8 严格 → GBK → lossy UTF-8）。
const decodeCmdOutput = decodeText;

export function resolveExe(exe, cwd) {
  if (process.platform !== 'win32') return resolveExePosix(exe, cwd);
  return resolveExeWindows(exe, cwd);
}

function resolveExeWindows(exe, cwd) {
  if (/[\\/]/.test(exe)) {
    const abs = path.isAbsolute(exe) ? exe : path.resolve(cwd, exe);
    const rejected = [];
    for (const cand of [abs, `${abs}.exe`]) {
      if (!fs.existsSync(cand)) continue;
      const resolved = path.resolve(cand);
      const why = exeRejection(resolved);
      if (!why) return resolved;
      rejected.push(`${resolved}（${why}）`);
    }
    if (rejected.length) {
      throw conflictError('CONFIG_INVALID', `exe 不可用：${rejected.join('；')}。请改用真实可执行文件路径`);
    }
    throw conflictError('CONFIG_INVALID', `exe 不存在：${exe}（Skill 需重新分析该目标项目）`);
  }
  // 裸名 java/javac 优先用 JAVA_HOME 下真实 JDK，绕开 Oracle javapath 转发 shim：
  // shim 会把真实 JVM 拉成子进程，导致重定向句柄不落地、终止目标错位。
  if (/^java(c)?$/i.test(exe) && process.env.JAVA_HOME) {
    const jh = path.join(process.env.JAVA_HOME, 'bin', `${exe}.exe`);
    if (fs.existsSync(jh)) return path.resolve(jh);
  }
  const r = spawnSync('where', [exe], { encoding: 'buffer', windowsHide: true, timeout: 10000 });
  if (r.error) return exe; // 无法定位 where 时按原值交给 spawn
  if (r.status !== 0) throw conflictError('CONFIG_INVALID', `exe 不在 PATH 中：${exe}（Skill 需重新分析该目标项目）`);
  const candidates = decodeCmdOutput(r.stdout).trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // 按 where 顺序逐个校验：跳过 stub/脚本包装/非 exe，取第一个真实可执行文件；
  // 全部不可用时报告候选清单与原因，不静默选一个包装进程冒充受管目标。
  const rejected = [];
  for (const cand of candidates) {
    const resolved = path.resolve(cand);
    const why = exeRejection(resolved);
    if (!why) return resolved;
    rejected.push(`${resolved}（${why}）`);
  }
  throw conflictError('CONFIG_INVALID',
    `exe ${exe} 的 PATH 候选均不可作为受管目标：${rejected.join('；')}。请提供真实可执行文件路径（如真实 python.exe/node.exe）后重试`);
}

function resolveExePosix(exe, cwd) {
  if (exe.includes('/')) {
    const abs = path.isAbsolute(exe) ? exe : path.resolve(cwd, exe);
    if (!fs.existsSync(abs)) {
      throw conflictError('CONFIG_INVALID', `exe 不存在：${exe}（Skill 需重新分析该目标项目）`);
    }
    const why = exeRejection(abs);
    if (why) throw conflictError('CONFIG_INVALID', `exe 不可用：${abs}（${why}）。请改用真实可执行文件或 command 模式`);
    return fs.realpathSync.native(abs);
  }
  if (/^java(c)?$/i.test(exe) && process.env.JAVA_HOME) {
    const jh = path.join(process.env.JAVA_HOME, 'bin', exe);
    if (fs.existsSync(jh) && !exeRejection(jh)) return fs.realpathSync.native(jh);
  }
  // Linux 无 where：按 PATH 顺序逐个校验，规则与 Windows 分支一致。
  const rejected = [];
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const cand = path.join(dir, exe);
    if (!fs.existsSync(cand)) continue;
    const why = exeRejection(cand);
    if (!why) return fs.realpathSync.native(cand);
    rejected.push(`${cand}（${why}）`);
  }
  if (rejected.length) {
    throw conflictError('CONFIG_INVALID',
      `exe ${exe} 的 PATH 候选均不可作为受管目标：${rejected.join('；')}。请提供真实可执行文件路径（脚本请用 command 模式）`);
  }
  throw conflictError('CONFIG_INVALID', `exe 不在 PATH 中：${exe}（Skill 需重新分析该目标项目）`);
}

export function canonicalizeDesc(desc) {
  const root = realpathOrConflict('root', desc.root);
  const cwd = realpathOrConflict('cwd', desc.cwd);
  // 命令模式不解析 exe——cmd wrapper 与真实目标进程都在 launchManaged 内确认
  const exe = desc.command ? null : resolveExe(desc.exe, cwd);
  return { ...desc, root, cwd, exe };
}

export function upsertApp(reg, appId, desc) {
  for (const app of Object.values(reg.apps)) {
    if (app.appId !== appId && app.alias.toLowerCase() === desc.alias.toLowerCase()) {
      throw conflictError('ALIAS_TAKEN', `别名 ${desc.alias} 已被 ${app.displayName ?? app.alias}（${app.appId}）使用`);
    }
  }
  const now = new Date().toISOString();
  const existing = reg.apps[appId];
  if (existing) {
    existing.alias = desc.alias;
    existing.displayName = desc.displayName;
    existing.root = desc.root;
    existing.entry = desc.entry;
    existing.cwd = desc.cwd;
    existing.mode = desc.mode;
    existing.exe = desc.exe;
    existing.args = desc.args;
    existing.command = desc.command ?? null;
    existing.expectedImage = desc.expectedImage ?? null;
    existing.discoverTimeoutMs = desc.discoverTimeoutMs ?? null;
    existing.envRefs = desc.envRefs;
    existing.envFile = desc.envFile ?? null;
    existing.env = desc.env ?? {};
    existing.expectedPort = desc.expectedPort ?? null;
    existing.readyLogPattern = desc.readyLogPattern ?? null;
    existing.readyUrl = desc.readyUrl ?? null;
    existing.logMaxBytes = desc.logMaxBytes ?? RUN_LOG_MAX_BYTES;
    existing.sourceFingerprint = desc.sourceFingerprint ?? null;
    existing.configRevision = (existing.configRevision ?? 1) + 1;
    existing.updatedAt = now;
    return existing;
  }
  const app = {
    appId, alias: desc.alias, displayName: desc.displayName, root: desc.root, entry: desc.entry,
    cwd: desc.cwd, mode: desc.mode, exe: desc.exe, args: desc.args,
    command: desc.command ?? null, expectedImage: desc.expectedImage ?? null,
    discoverTimeoutMs: desc.discoverTimeoutMs ?? null, envRefs: desc.envRefs,
    envFile: desc.envFile ?? null, env: desc.env ?? {},
    expectedPort: desc.expectedPort ?? null, readyLogPattern: desc.readyLogPattern ?? null,
    readyUrl: desc.readyUrl ?? null, logMaxBytes: desc.logMaxBytes ?? RUN_LOG_MAX_BYTES,
    sourceFingerprint: desc.sourceFingerprint ?? null,
    configRevision: 1, createdAt: now, updatedAt: now,
  };
  reg.apps[appId] = app;
  return app;
}
