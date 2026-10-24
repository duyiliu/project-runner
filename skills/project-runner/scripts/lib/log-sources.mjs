// Unified log sources and project file browsing (read-only, shared by CLI and ui):
// managed run logs under logs/<appId>/<runId>.<stream>.log, unmanaged logHints,
// and root/.tmp jrebel-local-*/runner-local-* compat scan. Tree/preview stay inside root.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appContext } from './runtime.mjs';
import { ID_RE } from './desc.mjs';
import { UI_FILE_CHUNK, TMP_NAME_RE, uiBlocked, uiFail, uiResolveFile } from './ui-data.mjs';
import { readTailLines, MAX_LOG_BYTES, RUN_LOG_FILE_RE } from './logs.mjs';
import { pickDecoder } from './decode.mjs';
import { verifyRun } from './probe.mjs';
import { usageError, notFoundError } from './errors.mjs';

// 解析 logs 与 ui 共用的日志目标：校验应用、runId 归属与流名，返回绝对路径（不读内容）
export function resolveLogFile(home, ref, run, stream = 'stdout') {
  if (!['stdout', 'stderr'].includes(stream)) throw usageError('--stream 只能是 stdout 或 stderr');
  const { appId, app, rt, cur } = appContext(home, ref);
  const prev = rt && rt.prevRuns ? rt.prevRuns.find((p) => p.runId === run) : null;
  const runId = run ?? cur?.runId ?? null;
  // 非受管记录没有批次日志（设计边界：只记录日志线索，不接管日志）；报错要说清去哪找，不伪装成日志丢失
  if (!run && cur && !cur.managed) {
    const hints = (cur.logHints ?? []).filter((h) => typeof h === 'string' && h);
    throw notFoundError(`${app.alias} 为非受管记录，不提供批次日志${hints.length ? `；日志线索：${hints.join(', ')}` : ''}（可用 logs ${ref} --src hint:<hash> 读取线索，或在 manager ui 的日志源中选择）`);
  }
  if (prev && !prev.managed) {
    throw notFoundError(`runId=${runId} 为非受管记录，无批次日志；请按项目脚本输出路径或在 manager ui 的日志源中选择`);
  }
  if (!runId) throw notFoundError(`${app.alias} 无运行批次`);
  if (!ID_RE.test(runId)) throw usageError(`runId 非法：${runId}`);
  if (run && runId !== cur?.runId && !prev) {
    throw notFoundError(`runId=${runId} 不在 ${app.alias} 的运行记录中`);
  }
  return { appId, alias: app.alias, runId, stream, file: path.join(home, 'logs', appId, `${runId}.${stream}.log`) };
}

// 运行批次列表（ui 日志选择器用）：当前批次 + prevRuns 全量
export function listRuns(home, ref) {
  const { appId, app, rt, cur } = appContext(home, ref);
  return {
    appId, alias: app.alias,
    current: cur ? {
      runId: cur.runId, phase: cur.phase, managed: cur.managed,
      logPaths: cur.logPaths ?? null, logHints: cur.logHints ?? null,
    } : null,
    prevRuns: (rt?.prevRuns ?? []).map((p) => ({
      runId: p.runId, phase: p.phase, managed: p.managed ?? null,
      endedAt: p.endedAt ?? null, archivedAt: p.archivedAt ?? null, archiveReason: p.archiveReason ?? null,
    })),
  };
}

// ---------- ui 统一日志源与项目文件浏览（只读，替代原单项 viewer） ----------
// 日志源三类：受管批次 logs/<appId>/<runId>.<stream>.log、非受管登记的 logHints、
// 应用 root/.tmp 下 jrebel-local-*/runner-local-* 兼容扫描。文件树/预览限定在应用 root 内。

function appRootOf(home, ref) {
  const { appId, app } = appContext(home, ref);
  try {
    return { appId, app, root: fs.realpathSync.native(app.root) };
  } catch {
    throw notFoundError(`${app.alias} 的项目目录不存在或不可访问：${app.root}`);
  }
}

// envFile 是机密注入源：即使位于项目 root 内，也不允许通过 ui 文件浏览回显其内容。
function configuredEnvFile(app, root) {
  if (typeof app?.envFile !== 'string' || !app.envFile) return null;
  const abs = path.isAbsolute(app.envFile) ? app.envFile : path.resolve(app.cwd ?? root, app.envFile);
  try { return fs.realpathSync.native(abs); } catch { return path.resolve(abs); }
}

// 硬链接的 realpath 不同但 inode 相同；必须按文件身份比较，否则别名路径会绕过
// envFile 浏览拦截。ino=0 的文件系统回退到规范化路径比较。
function fileIdentity(file) {
  try {
    const st = fs.statSync(file, { bigint: true });
    if (st.ino === 0n) return null;
    return `${st.dev}:${st.ino}`;
  } catch { return null; }
}

function isConfiguredEnvFile(app, root, file) {
  const envFile = configuredEnvFile(app, root);
  if (!envFile) return false;
  const envIdentity = fileIdentity(envFile);
  const fileIdentityNow = fileIdentity(file);
  if (envIdentity && fileIdentityNow) return envIdentity === fileIdentityNow;
  try { return fs.realpathSync.native(file) === envFile; } catch { return path.resolve(file) === envFile; }
}

// 非受管日志线索定位符：hint:<路径 hash>。listSources 与 tail 之间 current.logHints 可能变化，
// 下标会错位读错文件；hash 定位与内容无关、与顺序无关，错位时明确报错而不是静默读错。
const hintLocator = (hint) => `hint:${crypto.createHash('sha256').update(hint).digest('hex').slice(0, 12)}`;

// 统一日志源列表：src 为不透明定位符（run:/hint:/tmp:），tail 时回传并重新校验
export function listSources(home, ref) {
  const { appId, app, rt } = appContext(home, ref);
  const curRunId = rt?.current?.runId ?? null;
  const sources = [];
  const seen = new Set();
  const push = (s, file) => {
    try {
      const real = fs.realpathSync(file);
      if (seen.has(real)) return;
      const stat = fs.statSync(real);
      if (!stat.isFile()) return;
      seen.add(real);
      sources.push({ ...s, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    } catch { /* 文件可能刚被清理或不可读，跳过 */ }
  };
  const runDir = path.join(home, 'logs', appId);
  if (fs.existsSync(runDir)) {
    for (const name of fs.readdirSync(runDir)) {
      const m = RUN_LOG_FILE_RE.exec(name);
      if (!m) continue;
      const rotated = name.endsWith('.log.1');
      push({ src: `run:${m[1]}.${m[2]}${rotated ? '.1' : ''}`, kind: 'run', label: `${m[1]} · ${m[2]}${rotated ? ' · 轮转前' : ''}`, current: m[1] === curRunId, stream: m[2] }, path.join(runDir, name));
    }
  }
  (rt?.current?.logHints ?? []).forEach((hint) => {
    if (typeof hint !== 'string' || !path.isAbsolute(hint)) return;
    push({ src: hintLocator(hint), kind: 'hint', label: `线索 · ${path.basename(hint)}`, current: true, stream: null }, hint);
  });
  try {
    const tmpDir = uiResolveFile(app.root, '.tmp');
    if (fs.statSync(tmpDir).isDirectory()) {
      for (const name of fs.readdirSync(tmpDir)) {
        if (!TMP_NAME_RE.test(name)) continue;
        push({ src: `tmp:${name}`, kind: 'tmp', label: name.replace(/^(?:jrebel|runner)-local-/, '').replace(/\.log$/, ''), current: false, stream: name.endsWith('.stdout.log') ? 'stdout' : 'stderr' }, path.join(tmpDir, name));
      }
    }
  } catch { /* .tmp 缺失或为符号链接：无兼容日志 */ }
  // 默认排序：当前运行 stdout > 当前运行其余 > 历史源按 mtime
  const rank = (s) => (s.current ? (s.stream === 'stderr' ? 1 : 0) : 2);
  sources.sort((a, b) => rank(a) - rank(b) || b.mtimeMs - a.mtimeMs || Number(b.stream === 'stdout') - Number(a.stream === 'stdout'));
  return { appId, alias: app.alias, sources };
}

export function resolveSource(home, ref, src) {
  const { appId, app, rt } = appContext(home, ref);
  if (typeof src !== 'string' || src.length > 200) throw usageError('日志源标识无效');
  let m;
  if ((m = /^run:([a-z0-9][a-z0-9-]{0,47})\.(stdout|stderr)(\.1)?$/.exec(src))) {
    const suffix = m[3] ?? '';
    let file;
    try { file = uiResolveFile(path.join(home, 'logs', appId), `${m[1]}.${m[2]}.log${suffix}`); }
    catch (e) { if (e.code === 'ENOENT') throw notFoundError('日志不存在'); throw e; }
    if (suffix && !fs.existsSync(file)) throw notFoundError('轮转日志不存在');
    return { appId, alias: app.alias, runId: m[1], stream: m[2], file };
  }
  if (src.startsWith('hint:')) {
    if ((m = /^hint:([0-9a-f]{12})$/.exec(src))) {
      const hints = (rt?.current?.logHints ?? []).filter((h) => typeof h === 'string' && path.isAbsolute(h));
      const hint = hints.find((h) => hintLocator(h) === src);
      if (!hint) throw notFoundError(`日志线索定位符失效（${src}）：登记的日志线索已变化或不存在，请重新拉取日志源列表`);
      let real;
      try { real = fs.realpathSync(hint); } catch { throw notFoundError('日志线索不存在'); }
      if (!fs.statSync(real).isFile()) throw notFoundError('日志线索不存在');
      return { appId, alias: app.alias, runId: null, stream: null, file: real };
    }
    // 旧版下标定位符（hint:0）或其他失效形状：一律明确报错，不静默解析，避免错位读错文件
    throw notFoundError(`日志线索定位符无效或已失效（${src}）：定位符已改为 hint:<hash>，请重新拉取日志源列表`);
  }
  if ((m = /^tmp:(.+)$/.exec(src)) && TMP_NAME_RE.test(m[1])) {
    let file;
    try { file = uiResolveFile(app.root, `.tmp/${m[1]}`); }
    catch (e) { if (e.code === 'ENOENT') throw notFoundError('日志不存在'); throw e; }
    return { appId, alias: app.alias, runId: null, stream: m[1].endsWith('.stdout.log') ? 'stdout' : 'stderr', file };
  }
  throw usageError('日志源标识无效');
}

export function listTree(home, ref, rel = '') {
  const { app, root } = appRootOf(home, ref);
  const dir = uiResolveFile(root, rel);
  if (!fs.statSync(dir).isDirectory()) throw uiFail(400, '不是目录');
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (uiBlocked(item.name) || item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
    if (!item.isDirectory() && isConfiguredEnvFile(app, root, path.join(dir, item.name))) continue;
    entries.push({ name: item.name, path: path.posix.join(rel, item.name), directory: item.isDirectory() });
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { alias: app.alias, root, path: rel, entries };
}

export function readProjectFile(home, ref, rel = '', offset = 0) {
  const { app, root } = appRootOf(home, ref);
  const file = uiResolveFile(root, rel);
  if (isConfiguredEnvFile(app, root, file)) throw uiFail(403, 'envFile 不允许通过管理台浏览');
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw uiFail(400, '不是普通文件');
  offset = Number(offset);
  if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
  offset = Math.min(offset, Math.max(0, stat.size - 1));
  const chunk = Math.min(Math.max(0, stat.size - offset), UI_FILE_CHUNK);
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(chunk);
    const read = fs.readSync(fd, buf, 0, chunk, offset);
    buf = buf.subarray(0, read);
  } finally { fs.closeSync(fd); }
  let text = null;
  try {
    if (buf.includes(0)) throw new Error('binary');
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: stat.size > buf.length });
    if (/[\x01-\x08\x0e-\x1f]/.test(text)) text = null;
  } catch { text = null; }
  return { path: rel, size: stat.size, offset, nextOffset: offset + buf.length, hasMore: offset + buf.length < stat.size, binary: text === null, text };
}

// 双流合并：批次日志没有统一时间戳，按各自行在尾部中的相对位置比例交替归并；
// 只保证各流内顺序稳定、整体确定性（相同输入必得相同输出），不冒充精确时间序
export function mergeStreamTails(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && (i + 1) / a.length <= (j + 1) / b.length)) out.push({ stream: 'stdout', line: a[i++] });
    else out.push({ stream: 'stderr', line: b[j++] });
  }
  return out;
}

export function followLogs(rt, runId, file, initialLines) {
  const cur = rt && rt.current;
  process.on('SIGINT', () => {
    process.stderr.write('\n[已中止 follow]\n');
    process.exit(0);
  });
  const managedWithIdentity = !!(cur && cur.managed && cur.pid != null && cur.creationFileTime && cur.image && cur.runId === runId);
  if (!managedWithIdentity) {
    process.stderr.write(`[非受管或身份未知批次，无法自动结束；Ctrl+C 中止]\n`);
  }
  const first = readTailLines(file, initialLines);
  for (const l of first.lines) process.stdout.write(`${l}\n`);
  let pos = fs.statSync(file).size;
  let decoder = new TextDecoder('utf-8', { fatal: true });
  let lastIdentityCheck = 0;
  const tick = setInterval(() => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // 文件暂时不可读，下一轮再试
    }
    if (size < pos) {
      // 日志已轮转：log-writer 把旧文件 rename 成 .1 并从 0 重建同名新文件，
      // 旧 pos 指向的偏移在新文件中已不存在。重置到新文件起始继续跟随；
      // 旧文件尾部内容可用 logs --src run:<runId>.<stream>.1 查看。
      process.stderr.write(`\n[日志已轮转，从新文件起始继续跟随；轮转前尾部可用 --src run:${runId}.*.1 查看]\n`);
      pos = 0;
      decoder = new TextDecoder('utf-8', { fatal: true }); // 新文件可能重新以 UTF-8 开始
    }
    if (size > pos) {
      const fd = fs.openSync(file, 'r');
      try {
        const len = Math.min(size - pos, MAX_LOG_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        try { process.stdout.write(decoder.decode(buf, { stream: true })); }
        catch {
          decoder = pickDecoder('gbk');
          process.stdout.write(decoder.decode(buf));
        }
      } finally {
        fs.closeSync(fd);
      }
      pos += Math.min(size - pos, MAX_LOG_BYTES);
    }
    if (!managedWithIdentity || Date.now() - lastIdentityCheck < 2000) return;
    lastIdentityCheck = Date.now();
    // 核验异常时保守继续 follow（Ctrl+C 可中止）
    try {
      const v = verifyRun(cur);
      if (!v.alive) {
        try {
          const s2 = fs.statSync(file).size;
          if (s2 > pos) {
            // 最终 drain 与 tick 内读取同一上限：超过 MAX_LOG_BYTES 截断并提示，不无限占内存
            const len = Math.min(s2 - pos, MAX_LOG_BYTES);
            const fd = fs.openSync(file, 'r');
            try {
              const buf = Buffer.alloc(len);
              fs.readSync(fd, buf, 0, len, pos);
              try { process.stdout.write(decoder.decode(buf, { stream: true })); }
              catch {
                decoder = pickDecoder('gbk');
                process.stdout.write(decoder.decode(buf));
              }
            } finally {
              fs.closeSync(fd);
            }
            pos += len;
            if (s2 - pos > 0) {
              process.stderr.write(`\n[日志截断：进程退出后剩余 ${(s2 - pos)} 字节超过单次读取上限 ${MAX_LOG_BYTES} 字节，未继续输出；完整内容可用 manager logs 查看]\n`);
            }
          }
        } catch { /* 忽略 */ }
        clearInterval(tick);
        process.stderr.write(`\n[进程已退出，follow 结束]\n`);
        process.exit(0);
      }
    } catch { /* 核验失败：继续跟随 */ }
  }, 500);
}
