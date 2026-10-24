// Command implementations: each cmd* takes the parsed ctx and returns the JSON
// data contract (or throws ManagerError). Lifecycle commands run inside the
// per-app advisory lock; read-only commands never mutate beyond status writeback.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './constants.mjs';
import { registryPath, runtimePath, readRegistry, readRuntimeStrict, atomicWriteJson } from './store.mjs';
import { usageError, notFoundError, conflictError } from './errors.mjs';
import { loadManagedDesc, loadUnmanagedDesc, canonicalizeDesc, realpathOrConflict, resolveExe, computeAppId, upsertApp, newRunId, ENTRY_RE, MODES } from './desc.mjs';
import { psProc, verifyRun, verifyRuns, listDescendants, portOccupants, portConflict, tcpListening, TERMINATE_WAIT_MS, invalidateVerifyCache, cacheVerifyResult, interpretVerifyResult } from './probe.mjs';
import { withLock, withLockAsync, withRegistryLock } from './locks.mjs';
import { resolveAppId, archiveCurrent, writeRuntime, computeStatus, statusWithFacts, resolveUnresolvedRun, parseAckRunId, exitSummary } from './runtime.mjs';
import { launchManaged, cleanupWrapper } from './launch.mjs';
import { resolveLogFile, listRuns, listSources, resolveSource, listTree, readProjectFile, mergeStreamTails, followLogs } from './log-sources.mjs';
import { readTailLines, MAX_LOG_LINES } from './logs.mjs';
import { planPrune, applyPrune } from './prune.mjs';
import { bootId } from './proc-linux.mjs';

const MANAGER_MJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');

// ---------- 简单选项解析 ----------

export function parseNamed(args, spec) {
  const single = new Map();
  const multi = new Map();
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let inlineValue; // --x=v 语法糖：拆出内联值后与空格分隔形式同路径处理
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) { inlineValue = a.slice(eq + 1); a = a.slice(0, eq); }
    }
    const kind = spec[a];
    if (kind === 'flag') {
      if (inlineValue !== undefined) throw usageError(`${a} 不接受参数`);
      flags.add(a);
    } else if (kind === 'value') {
      const v = inlineValue ?? args[++i];
      if (v === undefined) throw usageError(`${a} 需要参数`);
      single.set(a, v);
    } else if (kind === 'multi') {
      const v = inlineValue ?? args[++i];
      if (v === undefined) throw usageError(`${a} 需要参数`);
      multi.set(a, [...(multi.get(a) ?? []), v]);
    } else if (a.startsWith('--')) {
      throw usageError(`未知选项：${a}${inlineValue !== undefined ? `=${inlineValue}` : ''}`);
    } else {
      positional.push(a);
    }
  }
  return {
    get: (k) => single.get(k) ?? multi.get(k)?.[0],
    getAll: (k) => multi.get(k) ?? (single.has(k) ? [single.get(k)] : []),
    has: (k) => single.has(k) || multi.has(k) || flags.has(k),
    positional,
  };
}

export async function cmdStartNew(ctx) {
  const opts = parseNamed(ctx.rest, { '--desc': 'value', '--ack-unresolved': 'value', '--force': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const desc = canonicalizeDesc(loadManagedDesc(opts.get('--desc')));
  const appId = computeAppId(desc.root, desc.entry);
  return withLockAsync(ctx.home, appId, 'start-new', async () => {
    // 已有受管实例在运行则拒绝（并发/重复启动只允许一份实例）
    const rt = readRuntimeStrict(ctx.home, appId);
    if (rt && rt.current && rt.current.managed && rt.current.phase === 'RUNNING') {
      const v = verifyRun(rt.current); // 核验失败抛 IDENTITY_UNKNOWN → 拒绝继续，不会重复起
      if (v.alive) {
        throw conflictError('ALREADY_RUNNING', `${desc.alias} 已有受管实例在运行`, { runId: rt.current.runId, pid: rt.current.pid });
      }
    }
    // STARTING/UNKNOWN 未结记录默认拒绝；显式 ack 且复核通过后才归档旧账并继续
    const abandon = resolveUnresolvedRun(ctx.home, appId, rt, ackRunId);
    const portEvidence = portConflict(desc.expectedPort, opts.has('--force'));
    const app = withRegistryLock(ctx.home, 'start-new', () => {
      const reg = readRegistry(ctx.home);
      const a = upsertApp(reg, appId, desc);
      atomicWriteJson(registryPath(ctx.home), reg);
      return a;
    });
    const cur = await launchManaged(ctx.home, appId, app, { abandonRunId: abandon?.runId ?? null });
    return {
      appId, alias: app.alias, entry: app.entry, mode: app.mode, kind: cur.kind,
      runId: cur.runId, pid: cur.pid, status: 'RUNNING', managed: true,
      ...(cur.wrapperPid ? { wrapperPid: cur.wrapperPid } : {}),
      readinessUntested: true, logPaths: cur.logPaths,
      ...(portEvidence ? { portEvidence } : {}),
      ...(abandon ? { abandonedRunId: abandon.runId, abandonedReason: 'abandoned-by-ack' } : {}),
      note: '进程存活不等于业务就绪；就绪与 JRebel/热加载验证按 SKILL 规程另行执行',
    };
  });
}

export function cmdRecordUnmanaged(ctx) {
  const opts = parseNamed(ctx.rest, { '--desc': 'value', '--log-hints': 'multi', '--force': 'flag' });
  const d = loadUnmanagedDesc(opts.get('--desc'));
  const root = realpathOrConflict('root', d.root);
  const entry = ENTRY_RE.test(d.entry ?? '') ? d.entry : 'default';
  const appId = computeAppId(root, entry);
  const logHints = (opts.getAll('--log-hints') ?? []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  if (logHints.some((h) => !path.isAbsolute(h))) throw usageError('--log-hints 需要绝对路径');
  return withLock(ctx.home, appId, 'record-unmanaged', () => {
    const regResult = withRegistryLock(ctx.home, 'record-unmanaged', () => {
    const reg = readRegistry(ctx.home);
    for (const app of Object.values(reg.apps)) {
      if (app.appId !== appId && app.alias.toLowerCase() === String(d.alias).toLowerCase()) {
        throw conflictError('ALIAS_TAKEN', `别名 ${d.alias} 已被 ${app.displayName ?? app.alias}（${app.appId}）使用`);
      }
    }
    const now = new Date().toISOString();
    const existing = reg.apps[appId];
    // 同 root+entry 的 appId 与 alias 无关：非受管登记覆盖已存在的受管登记会丢失
    // 受管身份与进程追踪证据，必须显式拒绝或 --force（#49）。
    const wasManaged = !!(existing && (existing.exe || existing.command));
    if (wasManaged && !opts.has('--force')) {
      throw conflictError('ALREADY_REGISTERED',
        `appId=${appId}（root=${root}，entry=${entry}）已存在受管登记「${existing.alias}」，非受管登记会覆盖其受管身份与进程追踪证据；确认后用 --force 覆盖，或先 remove 该登记`,
        { appId, alias: existing.alias, root, entry, managed: true });
    }
    if (existing) {
      existing.alias = d.alias;
      existing.displayName = d.displayName ?? d.alias;
      // 转为非受管形态：清空受管启动能力，避免残留 exe/command 继续被当作可受管
      existing.exe = null;
      existing.args = [];
      existing.command = null;
      existing.expectedImage = null;
      existing.discoverTimeoutMs = null;
      existing.mode = MODES.has(d.mode) ? d.mode : existing.mode;
      existing.updatedAt = now;
    } else {
      reg.apps[appId] = {
        appId, alias: d.alias, displayName: d.displayName ?? d.alias, root, entry,
        cwd: d.cwd ? realpathOrConflict('cwd', d.cwd) : root, mode: MODES.has(d.mode) ? d.mode : 'java',
        exe: null, args: [], command: null, expectedImage: null, discoverTimeoutMs: null,
        envRefs: [], env: {}, expectedPort: Number.isInteger(d.expectedPort) ? d.expectedPort : null,
        sourceFingerprint: null, configRevision: 1, createdAt: now, updatedAt: now,
      };
    }
    atomicWriteJson(registryPath(ctx.home), reg);
    return { mode: reg.apps[appId].mode, alias: reg.apps[appId].alias, replaced: !!existing, wasManaged, now };
    });
    const rt = readRuntimeStrict(ctx.home, appId) ?? { schemaVersion: SCHEMA_VERSION, appId, prevRuns: [] };
    archiveCurrent(rt);
    rt.current = {
      runId: newRunId(), phase: 'UNKNOWN', managed: false, mode: regResult.mode,
      intentAt: regResult.now, startedAt: regResult.now, pid: null, creationFileTime: null, image: null,
      envResolved: [], logPaths: null, logHints,
      lastError: null, endedAt: null,
      note: 'Skill 在既有授权下执行的启动，未托管目标进程；仅记录尝试与日志线索',
    };
    writeRuntime(ctx.home, appId, rt);
    return {
      appId, alias: regResult.alias, runId: rt.current.runId,
      managed: false, status: 'UNKNOWN', logHints,
      replaced: regResult.replaced,
      ...(regResult.wasManaged ? { replacedManaged: true } : {}),
      note: regResult.wasManaged
        ? '已用 --force 覆盖同 appId 的受管登记：原受管身份与进程追踪证据不再可用（运行记录与日志证据仍保留）'
        : '非受管登记不提供 RUNNING/STOPPED 断言与跨会话启停；日志线索仅原路径关联',
    };
  });
}

export function cmdPort(ctx, value) {
  if (ctx.rest.length > 1) throw usageError(`无法识别的参数：${ctx.rest[1]}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError('port 需要 1-65535 的整数');
  return { port, occupants: portOccupants(port), note: '外部进程仅诊断，不接管、不停止' };
}

export function cmdDoctor(ctx) {
  const home = ctx.home;
  const problems = [];
  const addProblem = (file, e) => {
    const code = e.code ?? 'UNKNOWN';
    if (problems.some((p) => p.file === file && p.code === code)) return;
    problems.push({ file, code, message: e.message });
  };

  // 注册表损坏不阻断其余独立诊断项；错误显式列入 problems，绝不静默当空注册表。
  let reg = { schemaVersion: null, apps: {} };
  try {
    reg = readRegistry(home);
  } catch (e) {
    addProblem(registryPath(home), e);
  }

  const runtimes = [];
  const runtimeDir = path.join(home, 'runtime');
  let runtimeNames = [];
  try {
    if (fs.existsSync(runtimeDir)) runtimeNames = fs.readdirSync(runtimeDir);
  } catch (e) {
    addProblem(runtimeDir, e);
  }
  for (const name of runtimeNames) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}\.json$/.test(name)) continue;
    const appId = name.slice(0, -5);
    let rt;
    try {
      rt = readRuntimeStrict(home, appId);
    } catch (e) {
      addProblem(runtimePath(home, appId), e);
      runtimes.push({ appId, schemaVersion: null, prevRuns: 0, logs: [], error: e.code ?? 'UNKNOWN' });
      continue;
    }
    const logChecks = [];
    for (const run of [rt?.current, ...(rt?.prevRuns ?? [])].filter(Boolean)) {
      if (!run.runId || !run.managed) continue;
      const paths = run.logPaths ?? { stdout: path.join(home, 'logs', appId, `${run.runId}.stdout.log`), stderr: path.join(home, 'logs', appId, `${run.runId}.stderr.log`) };
      for (const stream of ['stdout', 'stderr']) logChecks.push({ runId: run.runId, stream, exists: !!paths[stream] && fs.existsSync(paths[stream]) });
    }
    runtimes.push({ appId, schemaVersion: rt.schemaVersion, prevRuns: rt.prevRuns?.length ?? 0, logs: logChecks });
  }

  const locksDir = path.join(home, 'locks');
  let locks = [];
  try {
    locks = fs.existsSync(locksDir) ? fs.readdirSync(locksDir).filter((n) => n.endsWith('.lock')) : [];
  } catch (e) {
    addProblem(locksDir, e);
  }

  const tempFiles = [];
  const scanTemps = (dir, depth = 0) => {
    if (!fs.existsSync(dir) || depth > 2) return;
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, name.name);
      if (name.name.startsWith('.tmp-')) tempFiles.push(file);
      else if (name.isDirectory()) scanTemps(file, depth + 1);
    }
  };
  for (const dir of [home, runtimeDir, path.join(home, 'logs'), locksDir]) {
    try { scanTemps(dir); } catch (e) { addProblem(dir, e); }
  }

  const isWin = process.platform === 'win32';
  const isLinux = process.platform === 'linux';
  let pw = { error: true, status: null, stdout: '' };
  if (isWin) {
    pw = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  }
  const procReadable = isLinux
    ? (() => { try { fs.accessSync('/proc/self/stat', fs.constants.R_OK); return true; } catch { return false; } })()
    : null;
  const homeWritable = (() => { try { fs.accessSync(home, fs.constants.W_OK); return true; } catch { return false; } })();
  const portSummary = Object.values(reg.apps).filter((a) => Number.isInteger(a.expectedPort)).map((a) => ({ alias: a.alias, port: a.expectedPort, listening: tcpListening(a.expectedPort) }));
  return Promise.all(portSummary.map(async (p) => ({ ...p, listening: await p.listening }))).then((ports) => ({
    nodeVersion: process.version, platform: process.platform,
    procBackend: isLinux ? 'linux-proc' : (isWin ? 'pwsh-win32' : null),
    pwshVersion: isWin && !pw.error && pw.status === 0 ? pw.stdout.trim() : null,
    bootId: isLinux ? bootId() : null,
    procReadable,
    home, homeWritable, registrySchemaVersion: reg.schemaVersion, runtime: runtimes, locks, orphanTmpFiles: tempFiles, portSummary: ports, problems,
    note: '只读诊断；locks 项仅列出，不回收；problems 为诊断发现，不自动修复；orphanTmpFiles 可由 prune 按保留集回收；端口监听不代表业务就绪',
  }));
}

export function cmdList(ctx) {
  const reg = readRegistry(ctx.home);
  const apps = Object.values(reg.apps);
  // 一次批量核验所有 RUNNING 记录（#15/#51）：N 个受管应用只产生 1 次 pwsh 调用；
  // 批量失败时回退逐条核验，语义与结果不变。
  const prefetched = new Map();
  const pending = [];
  const runtimes = new Map();
  for (const app of apps) {
    try {
      const rt = readRuntimeStrict(ctx.home, app.appId);
      runtimes.set(app.appId, rt);
      const cur = rt?.current;
      if (cur && cur.managed && cur.phase === 'RUNNING' && cur.pid != null && cur.creationFileTime && cur.image) {
        pending.push({ appId: app.appId, pid: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
      }
    } catch (e) {
      // 损坏/不兼容记录：保留错误供下方按 DATA_* 呈现
      runtimes.set(app.appId, e);
    }
  }
  if (pending.length) {
    try {
      const results = verifyRuns(pending);
      pending.forEach((p, i) => {
        if (!results[i]) return;
        prefetched.set(p.appId, results[i]);
        // 填充单条核验缓存：同一轮询周期内 /api/status 的 verifyRun 直接命中，不再多起 pwsh
        try { cacheVerifyResult(p, interpretVerifyResult(results[i])); } catch { /* error 结果不缓存 */ }
      });
    } catch { /* 回退逐条 */ }
  }
  const rows = apps.map((app) => {
    let rt;
    let st;
    try {
      const cached = runtimes.get(app.appId);
      if (cached instanceof Error) throw cached;
      ({ rt, st } = statusWithFacts(ctx.home, app.appId, prefetched.get(app.appId) ?? null, cached));
    } catch (e) {
      return { alias: app.alias, appId: app.appId, mode: app.mode, status: 'UNKNOWN', managed: null, error: `${e.code}: ${e.message}`, root: app.root };
    }
    const current = rt?.current ?? null;
    const runExit = current?.exit ?? null;
    return {
      alias: app.alias, appId: app.appId, mode: app.mode,
      status: st.status, managed: st.managed ?? (current?.managed ?? null),
      pid: st.status === 'RUNNING' ? (st.pid ?? current?.pid) : null,
      expectedPort: app.expectedPort, lastRunId: current?.runId ?? rt?.prevRuns?.[0]?.runId ?? null,
      exit: runExit, exitSummary: exitSummary(current),
      exitWatchError: current?.exitWatchError ?? null,
      exitNote: st.note ?? current?.exitNote ?? null,
      log: current?.logPaths?.stdout ?? null, root: app.root,
    };
  });
  if (!apps.length) return { apps: [], note: '注册表为空：尚无由本 Skill 启动并记录的应用' };
  return { apps: rows };
}

function extractJrebelEvidence(home, appId, cur) {
  const files = ['stdout', 'stderr'].map((stream) => cur.logPaths?.[stream]).filter((file) => file && fs.existsSync(file));
  if (!files.length) return { available: false, note: '当前批次日志不存在；日志证据，不是热加载成功证明' };
  const read = files.map((file) => ({ file, ...readTailLines(file, MAX_LOG_LINES) }));
  const lines = read.flatMap((r) => r.lines).slice(-MAX_LOG_LINES);
  const matching = (re) => lines.filter((line) => re.test(line));
  return {
    available: true, files: read.map((r) => r.file), truncated: read.some((r) => r.truncated),
    banner: matching(/JRebel:/i), licenseErrors: matching(/(?:license|licence).*(?:error|invalid|expired|fail)|(?:error|invalid|expired|fail).*license/i),
    reloadingClassCount: matching(/Reloading class/i).length,
    reloadingSqlMapsCount: matching(/Reloading SQL maps/i).length,
    note: '仅引用当前批次日志原文；banner 不代表许可有效，日志证据不是热加载成功证明',
  };
}

function displayEnv(env = {}) {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [
    name, value.length > 120 ? `${value.slice(0, 120)}… (截断)` : value,
  ]));
}

// 就绪证据评估：desc 可选 readyLogPattern（当前批次 stdout/stderr 正则）与 readyUrl
// （http GET <400 即就绪）。两者都未配置 → UNTESTED；任一证据命中 → READY；配置了但
// 无命中 → NOT_READY。只读评估，不改状态。
// readyLogPattern 编译缓存：status --ready 每次调用都编译同一正则（#82-B3）。
const readyReCache = new Map();
const readyRe = (pattern) => {
  let r = readyReCache.get(pattern);
  if (!r) { r = new RegExp(pattern); readyReCache.set(pattern, r); }
  return r;
};

async function readinessCheck(home, app, cur) {
  const evidence = [];
  if (app.readyLogPattern && cur?.runId) {
    const re = readyRe(app.readyLogPattern);
    const dir = path.join(home, 'logs', app.appId);
    for (const stream of ['stdout', 'stderr']) {
      let line = null;
      try {
        // 复用 readTailLines：UTF-8 边界探测/GBK 回退与 logs 命令同口径（#82-B3），
        // 窗口上限沿用原 512KB 语义。
        line = readTailLines(path.join(dir, `${cur.runId}.${stream}.log`), MAX_LOG_LINES, 512 * 1024)
          .lines.find((l) => re.test(l));
      } catch { /* 批次日志尚不存在 */ }
      if (line != null) evidence.push({ kind: 'logPattern', stream, matched: line.slice(0, 200) });
    }
  }
  if (app.readyUrl) {
    try {
      const r = await fetch(app.readyUrl, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
      evidence.push(r.status < 400
        ? { kind: 'http', url: app.readyUrl, status: r.status }
        : { kind: 'http', url: app.readyUrl, status: r.status, failed: true });
    } catch (e) {
      evidence.push({ kind: 'http', url: app.readyUrl, error: String(e?.message ?? e).slice(0, 160), failed: true });
    }
  }
  const configured = Boolean(app.readyLogPattern || app.readyUrl);
  const state = !configured ? 'UNTESTED' : evidence.some((e) => !e.failed) ? 'READY' : 'NOT_READY';
  return { state, configured, evidence };
}

export async function cmdStatus(ctx, ref, probeRequested = false, readyRequested = false) {
  if (!ref) throw usageError('status 需要 <alias|appId>');
  const reg = readRegistry(ctx.home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const { rt, st } = statusWithFacts(ctx.home, appId);
  const cur = rt && rt.current;
  const evidenceFile = runtimePath(ctx.home, appId);
  const portListening = probeRequested && Number.isInteger(app.expectedPort) ? await tcpListening(app.expectedPort) : null;
  const readiness = readyRequested && st.status === 'RUNNING' ? await readinessCheck(ctx.home, app, cur)
    : readyRequested ? { state: 'UNTESTED', configured: Boolean(app.readyLogPattern || app.readyUrl), evidence: [], note: '非 RUNNING，不就绪评估' } : null;
  const jrebelEvidence = cur?.mode === 'jrebel' ? extractJrebelEvidence(ctx.home, appId, cur) : null;
  const runExit = cur?.exit ?? null;
  const runExitSummary = exitSummary(cur);
  return {
    alias: app.alias, appId, entry: app.entry, mode: app.mode, root: app.root,
    status: st.status, managed: st.managed ?? false,
    env: displayEnv(app.env ?? {}),
    pid: st.pid ?? cur?.pid ?? null,
    runtimeFile: evidenceFile,
    expectedPort: app.expectedPort,
    exit: runExit,
    exitSummary: runExitSummary,
    portNote: probeRequested ? '端口监听仅为 TCP 证据；监听 ≠ 业务就绪' : '使用 --probe 执行本机 TCP 监听探测',
    ...(probeRequested ? { portListening } : {}),
    ...(jrebelEvidence ? { jrebelEvidence } : {}),
    run: cur ? {
      runId: cur.runId, phase: cur.phase, managed: cur.managed, mode: cur.mode,
      kind: cur.kind ?? 'direct', wrapperPid: cur.wrapperPid ?? null, loggerPid: cur.loggerPid ?? null,
      wrapperCleaned: cur.wrapperCleaned ?? false,
      intentAt: cur.intentAt ?? null, startedAt: cur.startedAt ?? cur.intentAt,
      endedAt: cur.endedAt, pid: cur.pid ?? null,
      creationFileTime: cur.creationFileTime ?? null, image: cur.image ?? null,
      envResolved: cur.envResolved ?? [],
      logPaths: cur.logPaths, logHints: cur.logHints ?? null,
      logRotated: cur.logRotated ?? false, logRotatedStreams: cur.logRotatedStreams ?? [],
      logRotateFailedStreams: cur.logRotateFailedStreams ?? [],
      lastError: cur.lastError, exitNote: cur.exitNote ?? null,
      exit: runExit, exitSummary: runExitSummary, wrapperExit: cur.wrapperExit ?? null,
      exitWatchError: cur.exitWatchError ?? null,
      evidenceFile,
    } : null,
    ...(readiness ? { readiness } : {}),
    readinessUntested: st.status === 'RUNNING' && readiness?.state !== 'READY',
    note: st.note ?? null,
    loggerNote: st.loggerNote ?? null,
    prevRuns: (rt?.prevRuns ?? []).slice(0, 5),
  };
}

// 公开 start：已登记应用复用保存的配置，从任意目录启动
export async function cmdStart(ctx, ref) {
  if (!ref) throw usageError('start 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--ack-unresolved': 'value', '--force': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLockAsync(ctx.home, appId, 'start', async () => {
    const app = readRegistry(ctx.home).apps[appId];
    if (!app.exe && !app.command) {
      throw conflictError('CONFIG_INVALID', `${app.alias} 为非受管登记，无可复用启动配置；需 Skill 重新分析该项目并走 start-new`);
    }
    // 结构性检查：路径/产物失效只报该应用，不做全盘扫描（AC02）
    const cwd = realpathOrConflict('cwd', app.cwd);
    const exe = app.command ? null : resolveExe(app.exe, cwd);
    const rt = readRuntimeStrict(ctx.home, appId);
    if (rt && rt.current && rt.current.managed && rt.current.phase === 'RUNNING') {
      const v = verifyRun(rt.current);
      if (v.alive) throw conflictError('ALREADY_RUNNING', `${app.alias} 已有受管实例在运行`, { runId: rt.current.runId, pid: rt.current.pid });
    }
    // STARTING/UNKNOWN 未结记录默认拒绝；显式 ack 且复核通过后才归档旧账并继续
    const abandon = resolveUnresolvedRun(ctx.home, appId, rt, ackRunId);
    const portEvidence = portConflict(app.expectedPort, opts.has('--force'));
    const appForLaunch = withRegistryLock(ctx.home, 'start', () => {
      const reg = readRegistry(ctx.home);
      const a = reg.apps[appId];
      a.cwd = cwd;
      a.exe = exe;
      a.updatedAt = new Date().toISOString();
      atomicWriteJson(registryPath(ctx.home), reg);
      return a;
    });
    const cur = await launchManaged(ctx.home, appId, appForLaunch, { abandonRunId: abandon?.runId ?? null });
    return {
      appId, alias: app.alias, entry: app.entry, mode: app.mode, kind: cur.kind, source: 'saved-config',
      runId: cur.runId, pid: cur.pid, status: 'RUNNING', managed: true,
      readinessUntested: true, logPaths: cur.logPaths,
      ...(portEvidence ? { portEvidence } : {}),
      ...(abandon ? { abandonedRunId: abandon.runId, abandonedReason: 'abandoned-by-ack' } : {}),
      note: '复用已保存启动配置；进程存活不等于业务就绪',
    };
  });
}

// --tree 快照：目标身份核验通过后按 PPID 向下枚举当时仍在的后代（含多级），
// 各自用 capture 采集 pid+创建时间+映像。只向下、不向上，不认领外部进程。
function snapshotTree(cur) {
  const rows = listDescendants(cur.pid);
  const snapshot = [];
  for (const row of rows) {
    const pid = Number.isInteger(row) ? row : row?.pid;
    if (!Number.isInteger(pid) || pid <= 0 || pid === cur.pid) continue;
    try {
      const id = psProc('capture', { id: pid });
      if (id.result === 'ok') snapshot.push({ pid, creationFileTime: id.creationFileTime, image: id.image });
    } catch { /* 后代可能已自行退出；跳过不报错 */ }
  }
  return snapshot;
}

// 目标已确认退出后，按快照逐个同句柄核验+终止；已退出或 PID 已复用的后代会返回
// exited/notfound/mismatch。已退出/不存在不报错并记入 treeKilled 证据（快照中的后代已不在），
// mismatch 表示 PID 已复用为其他进程，绝不触碰也不记入。逆 BFS 顺序先杀深层后代，减少中间层退出后的 reparent。
function terminateTreeSnapshot(snapshot) {
  const killed = [];
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const item = snapshot[i];
    let t;
    try {
      t = psProc('terminate', { id: item.pid, creationFileTime: item.creationFileTime, image: item.image });
    } catch { continue; }
    if (t.result === 'terminated' || t.result === 'exited' || t.result === 'notfound') killed.push({ pid: item.pid, image: item.image });
  }
  return killed;
}

// 停止核心逻辑：返回 {result: stopped|alreadyStopped} 或抛错；调用方负责落账。
// opts.tree：连带终止目标后代进程（#39）；opts.graceMs：先发优雅信号等待，超时仍存活再强杀。
function stopCurrent(home, appId, app, rt, opts = {}) {
  const cur = rt.current;
  if (!cur.managed) throw conflictError('NOT_MANAGED', `${app.alias} 为非受管记录，不提供停止`);
  if (cur.phase === 'STARTING') throw conflictError('IDENTITY_UNKNOWN', `启动阶段记录（runId=${cur.runId}），身份未采集完成，拒绝停止；证据已保留`);
  if (cur.phase === 'UNKNOWN') throw conflictError('IDENTITY_UNKNOWN', `状态 UNKNOWN（${cur.lastError ?? '原因不明'}），拒绝停止；人工核验后可重新 start`);
  if (cur.phase === 'STOPPED') return { result: 'alreadyStopped', runId: cur.runId };
  // --tree 必须在终止目标前快照后代（Linux 目标退出后会 reparent）。先核验目标身份再枚举，
  // 避免 PID 复用后把无关进程的后代当成目标后代；目标后续核验失败时不会触碰快照。
  let treeSnapshot = null;
  if (opts.tree) {
    treeSnapshot = [];
    const v = psProc('verify', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
    if (v.result === 'ok') treeSnapshot = snapshotTree(cur);
  }
  const markStopped = (note, extra = {}, killTree = false, exitEvidence = null) => {
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = note;
    if (exitEvidence) cur.exit = { ...exitEvidence, at: cur.endedAt };
    invalidateVerifyCache(cur.pid); // 终止后立即作废缓存存活结论，避免 stop→start 竞态读到旧值
    cleanupWrapper(rt); // 命令模式：先清理残留 wrapper，再处理目标后代
    const treeKilled = opts.tree ? (killTree && treeSnapshot ? terminateTreeSnapshot(treeSnapshot) : []) : null;
    writeRuntime(home, appId, rt);
    return {
      result: 'stopped', runId: cur.runId, pid: cur.pid,
      ...(opts.tree ? { treeKilled, killedPids: treeKilled.map((k) => k.pid) } : {}),
      ...extra,
    };
  };
  if (opts.graceMs != null) {
    const g = psProc('grace', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image, waitMs: opts.graceMs });
    if (g.result === 'gracefulTerminated') {
      // 只证明“发出 SIGTERM 后目标在窗口内退出”，不能据此断言目标被信号终止：
      // 目标可能捕获 SIGTERM 后以 code=0 正常退出。真实退出结果由 log-writer（直连）
      // 或 exit-watcher（command 模式目标）在观察到实际退出事件后写入。
      return markStopped(`grace 窗口 ${opts.graceMs}ms 内优雅退出（SIGTERM/WM_CLOSE）`, {}, true);
    }
    if (g.result !== 'stillAlive') {
      // gracefulTerminated/stillAlive 之外的结果视同普通 terminate 结果走下面分支
      if (g.result === 'exited' || g.result === 'notfound') {
        return { ...markStopped('进程已自行退出'), result: 'alreadyStopped' };
      }
      if (g.result === 'mismatch') {
        return { ...markStopped('进程退出后 PID 被复用；未触碰新进程'), result: 'alreadyStopped',
          note: '原实例已退出，PID 已被其他进程复用，未触碰新进程' };
      }
      cur.phase = 'UNKNOWN';
      cur.lastError = `grace_failed: ${JSON.stringify(g)}`;
      writeRuntime(home, appId, rt);
      throw conflictError('IDENTITY_UNKNOWN', `优雅停止探测失败（${g.code ?? g.result}），标记 UNKNOWN，拒绝进一步操作`, { runId: cur.runId, detail: g });
    }
    // stillAlive：grace 超时，继续走下面的强制终止路径
  }
  const t = psProc('terminate', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
  if (t.result === 'terminated') {
    const graceNote = opts.graceMs != null ? `；已先等待 grace ${opts.graceMs}ms 未退出` : '';
    // stop 自己发出的有界强杀也是目标退出事实：command 模式下 wrapper 的 exit 不能
    // 代表目标，这里先在锁内落下受管目标的信号/137 语义证据，后续 logger 仅能补写同类。
    const forcedExit = process.platform === 'linux'
      ? { code: null, signal: 'SIGKILL', source: 'manager-stop' }
      : { code: 137, signal: null, source: 'manager-stop' };
    return markStopped(`terminated(137) 有界强制停止${opts.tree ? '（--tree）' : ''}${graceNote}`, {}, true, forcedExit);
  }
  if (t.result === 'exited' || t.result === 'notfound') {
    return { ...markStopped('进程已自行退出'), result: 'alreadyStopped' };
  }
  if (t.result === 'mismatch') {
    // 记录的实例已退出，该 PID 现属其他进程：不触碰，落账退出
    return { ...markStopped('进程退出后 PID 被复用；未触碰新进程'), result: 'alreadyStopped',
      note: '原实例已退出，PID 已被其他进程复用，未触碰新进程' };
  }
  if (t.result === 'terminateTimeout') {
    cur.phase = 'UNKNOWN';
    cur.lastError = 'terminate_timeout';
    writeRuntime(home, appId, rt);
    throw conflictError('TERMINATE_TIMEOUT', `终止已发出但等待 ${TERMINATE_WAIT_MS}ms 未确认退出，标记 UNKNOWN，不自动重试`, { runId: cur.runId, pid: cur.pid });
  }
  cur.phase = 'UNKNOWN';
  cur.lastError = `terminate_failed: ${JSON.stringify(t)}`;
  writeRuntime(home, appId, rt);
  throw conflictError('IDENTITY_UNKNOWN', `终止失败（${t.code ?? t.result}），标记 UNKNOWN，拒绝进一步操作`, { runId: cur.runId, detail: t });
}

// 命令模式失败（UNKNOWN）后清理残留 wrapper：只终止已记录身份的同进程，
// 不改变 UNKNOWN 证据；目标候选与后代由人工处置（后代清理见 #39）。
export function cmdCleanupWrapper(ctx, ref) {
  if (!ref) throw usageError('cleanup-wrapper 需要 <alias|appId>');
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'cleanup-wrapper', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    const rt = readRuntimeStrict(ctx.home, appId);
    if (!rt || !rt.current) throw notFoundError(`${app.alias} 无运行记录`);
    const cur = rt.current;
    if (!cur.managed) throw conflictError('NOT_MANAGED', `${app.alias} 为非受管记录，不提供 wrapper 清理`);
    if (cur.phase !== 'UNKNOWN') {
      throw conflictError('CONFLICT', `仅 UNKNOWN 记录可清理 wrapper（当前 phase=${cur.phase}）`);
    }
    if (!Number.isInteger(cur.wrapperPid) || !cur.wrapperCreationFileTime || !cur.wrapperImage) {
      throw conflictError('IDENTITY_UNKNOWN', `runId=${cur.runId} 缺少完整 wrapper 身份证据，拒绝清理`, { runId: cur.runId, wrapperPid: cur.wrapperPid ?? null });
    }
    // Linux 的 sh 可能 exec 成目标（image 改变但 starttime 不变）：先按记录核验
    // starttime，再用当前 image 调 terminate，避免把 exec 误判为身份不符。
    let now;
    try { now = psProc('capture', { id: cur.wrapperPid }); }
    catch (e) { now = { result: 'error', message: e.message }; }
    if (now.result === 'exited' || now.result === 'notfound') {
      cur.wrapperCleaned = true;
      cur.wrapperCleanupAt = new Date().toISOString();
      cur.wrapperCleanupResult = now.result;
      writeRuntime(ctx.home, appId, rt);
      return { appId, alias: app.alias, runId: cur.runId, wrapperPid: cur.wrapperPid, result: now.result, note: 'wrapper 已退出；UNKNOWN 证据保留' };
    }
    if (now.result !== 'ok' || String(now.creationFileTime) !== String(cur.wrapperCreationFileTime)) {
      throw conflictError('IDENTITY_UNKNOWN', `wrapper(pid=${cur.wrapperPid}) 身份与记录不一致，拒绝清理；未触碰任何进程`, { runId: cur.runId, wrapperPid: cur.wrapperPid, capture: now });
    }
    let t;
    try { t = psProc('terminate', { id: cur.wrapperPid, creationFileTime: now.creationFileTime, image: now.image }); }
    catch (e) { t = { result: 'error', message: e.message }; }
    if (t.result === 'terminated' || t.result === 'exited' || t.result === 'notfound' || t.result === 'mismatch') {
      cur.wrapperCleaned = true;
      cur.wrapperCleanupAt = new Date().toISOString();
      cur.wrapperCleanupResult = t.result;
      writeRuntime(ctx.home, appId, rt);
      return {
        appId, alias: app.alias, runId: cur.runId, wrapperPid: cur.wrapperPid, result: t.result,
        note: 'wrapper 已清理；UNKNOWN 证据与 prevRuns 保留，确认目标已退出后可用 --ack-unresolved 恢复',
      };
    }
    if (t.result === 'terminateTimeout') {
      throw conflictError('TERMINATE_TIMEOUT', `wrapper(pid=${cur.wrapperPid}) 终止超时，未确认退出`, { runId: cur.runId, wrapperPid: cur.wrapperPid });
    }
    throw conflictError('IDENTITY_UNKNOWN', `wrapper 清理失败（${t.code ?? t.result}）`, { runId: cur.runId, detail: t });
  });
}

// --grace 参数校验：stop/restart 共用（Number() 严格解析，3000abc 不豁免为 3000）。
function parseGraceMs(opts) {
  if (!opts.has('--grace')) return null;
  const graceMs = Number(opts.get('--grace'));
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 600000) {
    throw usageError('--grace 需要 0-600000 的毫秒数');
  }
  return graceMs;
}

export function cmdStop(ctx, ref) {
  if (!ref) throw usageError('stop 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--tree': 'flag', '--grace': 'value' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const graceMs = parseGraceMs(opts);
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'stop', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    const rt = readRuntimeStrict(ctx.home, appId);
    if (!rt || !rt.current) throw notFoundError(`${app.alias} 无运行记录`);
    return { appId, alias: app.alias, ...stopCurrent(ctx.home, appId, app, rt, { tree: opts.has('--tree'), graceMs }) };
  });
}

export async function cmdRestart(ctx, ref) {
  if (!ref) throw usageError('restart 需要 <alias|appId>');
  // --tree/--grace 透传给停旧实例那一步：等价于 stop --tree/--grace + start 的组合。
  const opts = parseNamed(ctx.rest.slice(1), { '--force': 'flag', '--tree': 'flag', '--grace': 'value' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const graceMs = parseGraceMs(opts);
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLockAsync(ctx.home, appId, 'restart', async () => {
    const app = readRegistry(ctx.home).apps[appId];
    if (!app.exe && !app.command) throw conflictError('CONFIG_INVALID', `${app.alias} 为非受管登记，无可复用启动配置`);
    const rt = readRuntimeStrict(ctx.home, appId);
    if (!rt || !rt.current) throw notFoundError(`${app.alias} 无运行记录`);
    const cwd = realpathOrConflict('cwd', app.cwd);
    const exe = app.command ? null : resolveExe(app.exe, cwd);
    const portEvidence = portConflict(app.expectedPort, opts.has('--force'), rt.current.pid);
    const stopResult = stopCurrent(ctx.home, appId, app, rt, { tree: opts.has('--tree'), graceMs }); // 必须确认退出才继续；抛错则中止，绝不先起后停
    const appForLaunch = withRegistryLock(ctx.home, 'restart', () => {
      const reg = readRegistry(ctx.home);
      const a = reg.apps[appId];
      a.cwd = cwd;
      a.exe = exe;
      a.updatedAt = new Date().toISOString();
      atomicWriteJson(registryPath(ctx.home), reg);
      return a;
    });
    const cur = await launchManaged(ctx.home, appId, appForLaunch);
    return {
      appId, alias: app.alias, stop: stopResult,
      start: { runId: cur.runId, pid: cur.pid, status: 'RUNNING', readinessUntested: true, logPaths: cur.logPaths, ...(portEvidence ? { portEvidence } : {}) },
      note: '已确认旧实例退出后启动新实例；进程存活不等于业务就绪',
    };
  });
}

// Bounded log tail implementation lives in scripts/lib/logs.mjs.
// 移除注册表条目；运行记录与日志证据一律保留。仅允许无存活受管实例时移除：
// RUNNING 核验存活一律拒绝（CONFLICT）；STARTING/UNKNOWN 未结记录按既有 ack 流程（核验已退出才可放弃）。
export function cmdRemove(ctx, ref) {
  if (!ref) throw usageError('remove 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--ack-unresolved': 'value' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  const ackRunId = parseAckRunId(opts.get('--ack-unresolved'));
  const reg0 = readRegistry(ctx.home);
  const appId = resolveAppId(reg0, ref);
  return withLock(ctx.home, appId, 'remove', () => {
    const reg = readRegistry(ctx.home);
    const app = reg.apps[appId];
    if (!app) throw notFoundError(`未找到应用：${ref}（可用 list 查看）`);
    const rt = readRuntimeStrict(ctx.home, appId);
    let abandonedRunId = null;
    if (rt && rt.current && rt.current.managed) {
      const st = computeStatus(ctx.home, appId, rt);
      if (st.writeback && rt.current) writeRuntime(ctx.home, appId, rt); // RUNNING→STOPPED 按 OS 事实落账（已在应用锁内）
      if (st.status === 'RUNNING') {
        throw conflictError('INSTANCE_RUNNING',
          `${app.alias} 有受管实例在运行（pid=${st.pid ?? rt.current.pid}），拒绝移除；先 stop 确认退出后再 remove`,
          { runId: rt.current.runId, pid: st.pid ?? rt.current.pid });
      }
      if (st.status !== 'STOPPED') {
        // STARTING/UNKNOWN/无法识别的 phase：未结记录，默认拒绝；显式 ack 且复核通过才归档旧账
        const abandon = resolveUnresolvedRun(ctx.home, appId, rt, ackRunId);
        if (abandon) {
          archiveCurrent(rt, { reason: 'abandoned-by-ack' }); // 完整身份与日志证据保留在 prevRuns 并注明原因
          writeRuntime(ctx.home, appId, rt);
          abandonedRunId = abandon.runId;
        }
      } else if (ackRunId) {
        // 已确认 STOPPED 的记录没有可 ack 的未结旧账：与 start 同一 ACK_MISMATCH 语义
        throw conflictError('ACK_MISMATCH',
          `当前没有 STARTING/UNKNOWN 未结记录，--ack-unresolved=${ackRunId} 不适用；请去掉该参数`,
          { ackRunId, current: { runId: rt.current.runId, phase: rt.current.phase, managed: rt.current.managed } });
      }
    }
    withRegistryLock(ctx.home, 'remove', () => {
      const regW = readRegistry(ctx.home);
      delete regW.apps[appId];
      atomicWriteJson(registryPath(ctx.home), regW);
    });
    return {
      appId, alias: app.alias, removed: true,
      runtimeFile: runtimePath(ctx.home, appId),
      logsDir: path.join(ctx.home, 'logs', appId),
      ...(abandonedRunId ? { abandonedRunId, abandonedReason: 'abandoned-by-ack' } : {}),
      note: '注册表条目已移除；运行记录与日志证据保留。超保留期历史批次日志可用 prune 回收',
    };
  });
}

export function cmdPrune(ctx) {
  const opts = parseNamed(ctx.rest, { '--dry-run': 'flag', '--apply': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  if (opts.has('--dry-run') && opts.has('--apply')) throw usageError('--dry-run 与 --apply 不能同时使用');
  const dryRun = !opts.has('--apply'); // 默认 dry-run：只打印将删内容，--apply 才真正删除
  const plan = planPrune(ctx.home);
  if (!dryRun) applyPrune(plan);
  const all = [...plan.logs.flatMap((a) => a.files), ...plan.staleLocks, ...plan.tmpOrphans];
  return {
    dryRun,
    logs: plan.logs,
    staleLocks: plan.staleLocks,
    tmpOrphans: plan.tmpOrphans,
    skipped: plan.skipped,
    summary: { files: all.length, bytes: all.reduce((n, f) => n + (f.size ?? 0), 0) },
    note: dryRun ? '默认 dry-run：未删除任何文件；确认后加 --apply 执行删除' : '已删除以上文件；current 运行日志与 runtime/registry 证据一律保留',
  };
}

export function cmdLogs(ctx, ref) {
  if (!ref) throw usageError('logs 需要 <alias|appId>');
  const opts = parseNamed(ctx.rest.slice(1), { '--lines': 'value', '--run': 'value', '--stream': 'value', '--follow': 'flag', '--src': 'value', '--list-sources': 'flag' });
  const lines = opts.has('--lines') ? Number(opts.get('--lines')) : 200;
  if (!Number.isInteger(lines) || lines < 1) throw usageError('--lines 需要正整数');

  // 统一日志源列表：与 ui 的日志源选择器同一数据（run:批次 / hint:非受管线索 / tmp:.tmp 兼容日志）
  if (opts.has('--list-sources')) {
    if (opts.has('--src') || opts.has('--run') || opts.has('--stream') || opts.has('--follow')) {
      throw usageError('--list-sources 只列出日志源，不能与 --src/--run/--stream/--follow 同时使用');
    }
    return { ...listSources(ctx.home, ref), note: '用 logs <alias|appId> --src <src> 读取对应日志源（可配合 --lines/--follow）' };
  }

  // 统一日志源读取：复用 ui 的 resolveSource，--src 已完整定位文件，与 --run/--stream 互斥
  const src = opts.get('--src');
  if (src != null) {
    if (opts.has('--run') || opts.has('--stream')) throw usageError('--src 已指定日志源，不能与 --run/--stream 同时使用');
    const t = resolveSource(ctx.home, ref, src);
    if (!fs.existsSync(t.file)) throw notFoundError(`日志不存在（src=${src}）`);
    if (opts.has('--follow')) {
      if (ctx.json) throw usageError('--follow 与 --json 不兼容');
      const rt = readRuntimeStrict(ctx.home, t.appId);
      // hint/tmp 源没有受管身份，followLogs 会提示无法自动结束，直到 Ctrl+C
      followLogs(rt, t.runId, t.file, lines);
      return { following: true };
    }
    const r = readTailLines(t.file, lines);
    return { appId: t.appId, alias: t.alias, src, runId: t.runId, stream: t.stream, lines: r.lines, truncated: r.truncated, skippedBytes: r.skippedBytes, file: t.file };
  }

  const stream = opts.get('--stream') ?? 'stdout';
  if (!['stdout', 'stderr', 'both'].includes(stream)) throw usageError('--stream 只能是 stdout、stderr 或 both');
  // 双流合并：复用 stdout 路径的校验（应用/runId 归属/非受管拒绝），stderr 按同批次路径派生
  if (stream === 'both') {
    if (opts.has('--follow')) throw usageError('--stream both 不支持 --follow；请选择单一数据流跟随');
    const t = resolveLogFile(ctx.home, ref, opts.get('--run'), 'stdout');
    const files = { stdout: t.file, stderr: path.join(path.dirname(t.file), `${t.runId}.stderr.log`) };
    const has = { stdout: fs.existsSync(files.stdout), stderr: fs.existsSync(files.stderr) };
    if (!has.stdout && !has.stderr) throw notFoundError(`日志不存在（runId=${t.runId}, stream=stdout/stderr）`);
    const parts = {};
    for (const s of ['stdout', 'stderr']) if (has[s]) parts[s] = readTailLines(files[s], lines);
    return {
      appId: t.appId, alias: t.alias, runId: t.runId, stream: 'both',
      lines: mergeStreamTails(parts.stdout?.lines ?? [], parts.stderr?.lines ?? []),
      truncated: { stdout: parts.stdout?.truncated ?? false, stderr: parts.stderr?.truncated ?? false },
      skippedBytes: { stdout: parts.stdout?.skippedBytes ?? 0, stderr: parts.stderr?.skippedBytes ?? 0 },
      files,
      missingStreams: Object.keys(has).filter((s) => !has[s]),
    };
  }
  const t = resolveLogFile(ctx.home, ref, opts.get('--run'), stream);
  if (!fs.existsSync(t.file)) throw notFoundError(`日志不存在（runId=${t.runId}, stream=${t.stream}）`);
  if (opts.has('--follow')) {
    if (ctx.json) throw usageError('--follow 与 --json 不兼容');
    const rt = readRuntimeStrict(ctx.home, t.appId);
    followLogs(rt, t.runId, t.file, lines);
    return { following: true };
  }
  const r = readTailLines(t.file, lines);
  return { appId: t.appId, alias: t.alias, runId: t.runId, stream: t.stream, lines: r.lines, truncated: r.truncated, skippedBytes: r.skippedBytes, file: t.file };
}

// ---------- 本地只读 Web 管理台（ui，design.md §2.2 / AC08） ----------

// 固定端口 8199 的占用探测：区分"已有 ui 实例"与"被其他程序占用"。
// 优先 /api/meta（几十字节的版本化 JSON，#82-B4）；旧版实例无此端点时
// 回退首页特征探测。连接失败一律按"非本实例"处理。
function probeManagerUi(port) {
  const get = (p) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 800 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
  return (async () => {
    const meta = await get('/api/meta');
    if (meta && meta.status === 200) {
      try {
        const j = JSON.parse(meta.body);
        return j?.ok === true && typeof j?.data?.version === 'string';
      } catch { return false; }
    }
    if (meta == null) return false;
    const page = await get('/');
    return Boolean(page && page.status === 200 && page.body.includes('id="roBanner"'));
  })();
}

// 生命周期操作经 manager.mjs --json 子进程执行：stdout 是同一数据契约的 JSON。
// 子进程退出码即 ManagerError exitCode（1-5），重构错误后 errorStatus 映射不变；
// 180s 超时兜底（CLI 前端 150s abort 通常先到），超时强杀子进程——中断的
// start/stop 按既有语义留下 STARTING/UNKNOWN 未结证据，不静默伪造结果。
function runLifecycleSubprocess(home, op, ref, ack) {
  const args = [MANAGER_MJS, '--json', '--home', home, op, ref];
  if (ack) args.push('--ack-unresolved', ack);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      reject(Object.assign(new Error(`${op} ${ref} 子进程超时（180s）已终止；状态可能未落定，请刷新后人工核验`), { code: 'LIFECYCLE_TIMEOUT', exitCode: 4 }));
    }, 180000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`manager 子进程拉起失败：${e.message}`), { code: 'LIFECYCLE_SPAWN_FAILED', exitCode: 4 }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(out); } catch { /* stdout 非 JSON：走通用错误 */ }
      if (j?.ok === true) return resolve(j.data);
      const e2 = j?.error ?? {};
      const errObj = Object.assign(
        new Error(e2.message || err.trim() || `manager ${op} 异常退出（code=${code}）`),
        { code: e2.code ?? 'LIFECYCLE_FAILED', exitCode: Number.isInteger(code) && code >= 1 && code <= 5 ? code : 4 },
      );
      if (e2.detail !== undefined) errObj.detail = e2.detail;
      reject(errObj);
    });
  });
}

export async function cmdUi(ctx) {
  const opts = parseNamed(ctx.rest, { '--port': 'value', '--open': 'flag' });
  if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
  let port = 8199; // 固定端口契约；--port 0 使用随机端口
  if (opts.has('--port')) {
    port = Number.parseInt(opts.get('--port'), 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw usageError('--port 需要 0-65535 的整数（0 为随机端口）');
  }
  const { startUiServer } = await import('../manager-ui/server.mjs');
  try {
    await startUiServer({
      home: ctx.home,
      port,
      open: opts.has('--open'), // 默认不开浏览器：Agent 前台拉起场景不期望弹窗
      api: {
        list: () => cmdList(ctx),
        status: (ref) => cmdStatus(ctx, ref).then((data) => { delete data.portListening; delete data.portNote; return data; }),
        listRuns: (ref) => listRuns(ctx.home, ref),
        resolveLogFile: (ref, run, stream) => resolveLogFile(ctx.home, ref, run, stream),
        listSources: (ref) => listSources(ctx.home, ref),
        resolveSource: (ref, src) => resolveSource(ctx.home, ref, src),
        listTree: (ref, p) => listTree(ctx.home, ref, p),
        readFile: (ref, p, offset) => readProjectFile(ctx.home, ref, p, offset),
        doctor: () => cmdDoctor(ctx),
        // 受管启停与移除：改由 manager.mjs 子进程执行（#82-B1）——start/stop/restart
        // 可能持锁等待与进程核验数十秒，同进程同步执行会冻结 ui 事件循环、
        // 期间全部轮询停摆。--json 输出保证数据契约与直调 cmd* 一致（同一实现）。
        lifecycle: (ref, op, ack) => {
          if (!['start', 'stop', 'restart', 'remove'].includes(op)) throw usageError(`不支持的操作：${op}（仅 start|stop|restart|remove）`);
          // --ack-unresolved 只在支持它的操作上生效；对 stop/restart 明确拒绝而非静默丢弃，
          // 避免调用方误以为未结记录已被确认。
          if (ack && op !== 'start' && op !== 'remove') throw usageError(`${op} 不支持 ack 参数（仅 start/remove 接受 --ack-unresolved）`);
          return runLifecycleSubprocess(ctx.home, op, ref, ack);
        },
      },
    });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const ours = await probeManagerUi(port);
    throw conflictError('PORT_IN_USE', ours
      ? `端口 ${port} 已有 manager ui 实例在运行：直接访问 http://127.0.0.1:${port}/，或 --port <N> 换端口另起实例`
      : `端口 ${port} 被其他程序占用：用 --port <N> 换端口（--port 0 为随机端口）`);
  }
}
