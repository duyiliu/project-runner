// Managed launch pipeline: persist intent → spawn detached log-writer →
// identity capture (direct exe) or descendant discovery (command mode) → record.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './constants.mjs';
import { runtimePath, readRuntimeStrict } from './store.mjs';
import { psProc, COMMAND_DISCOVER_TIMEOUT_MS } from './probe.mjs';
import { resolveExe, newRunId, RUN_LOG_MAX_BYTES } from './desc.mjs';
import { archiveCurrent, writeRuntime, isUnresolvedPhase } from './runtime.mjs';
import { readStderrTailSafe } from './logs.mjs';
import { conflictError } from './errors.mjs';

const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG_WRITER = path.join(SCRIPTS_DIR, 'log-writer.mjs');
const EXIT_WATCHER = path.join(SCRIPTS_DIR, 'exit-watcher.mjs');

// 命令模式的顶层 wrapper：Windows 是 cmd.exe，Linux 是 /bin/sh；两者都必须是
// 可校验的真实可执行文件（sh 不允许被 shebang 脚本冒充）。
function resolveShell(cwd) {
  if (process.platform === 'win32') return resolveExe(process.env.ComSpec || 'cmd.exe', cwd);
  for (const candidate of ['/bin/sh', process.env.SHELL, 'sh']) {
    if (!candidate) continue;
    try { return resolveExe(candidate, cwd); } catch { /* 尝试下一个候选 */ }
  }
  throw conflictError('CONFIG_INVALID', '找不到可用的 POSIX shell（/bin/sh 或 $SHELL）');
}

function shellArgs(command) {
  return process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
}

// log-writer 在目标 spawn 成功后写 pidFile（spawn 失败写 '0'）；等待窗口与直连/命令模式
// 共用。上限 5s：冷启动/杀毒扫描时 1s 不够；文件出现即返回，正常路径无额外等待。
function readPidFile(file) {
  for (let i = 0; i < 500 && !fs.existsSync(file); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    const n = Number(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch { return null; }
}

// 目标进程终止后尽力清理仍存活的 cmd wrapper（多数会随子进程退出自然消亡）。
// wrapper 身份在启动时已采集，同句柄核验+终止，失败仅作留证不影响主结果。
export function cleanupWrapper(rt) {
  const cur = rt.current;
  if (!cur?.wrapperPid || !cur.wrapperCreationFileTime || !cur.wrapperImage) return;
  try {
    psProc('terminate', { id: cur.wrapperPid, creationFileTime: cur.wrapperCreationFileTime, image: cur.wrapperImage });
  } catch { /* best-effort */ }
}

// command 模式：log-writer 只能看到 shell wrapper，真实目标由 discover 找到。
// 目标与 wrapper 不同 pid 时启动 detached watcher，用目标自身身份等待其真实退出，
// 避免把 wrapper 的普通退出当成目标 code/signal。
function startTargetExitWatcher(home, appId, runId, cur) {
  if (!Number.isInteger(cur.pid) || cur.pid <= 0 || !cur.creationFileTime) return false;
  // shell exec 后 wrapper 就是目标，log-writer 自身已有精确 exit 事件，无需 watcher。
  if (Number.isInteger(cur.wrapperPid) && cur.pid === cur.wrapperPid) return true;
  const logDir = cur.logPaths ? path.dirname(cur.logPaths.stdout) : SCRIPTS_DIR;
  const readyFile = path.join(logDir, `.${runId}.exit-watch.ready`);
  let ready = false;
  try { fs.rmSync(readyFile, { force: true }); } catch { /* absent */ }
  try {
    const watcher = spawn(process.execPath, [
      EXIT_WATCHER, home, appId, runId, String(cur.pid), String(cur.creationFileTime), readyFile,
    ], { cwd: logDir, detached: true, windowsHide: true, stdio: 'ignore' });
    watcher.unref();
    // 等 helper 真正持有目标句柄/pidfd 后再返回启动成功；否则目标可能在 watcher
    // 就绪前退出并被 wrapper 回收，真实退出证据永久缺失。
    for (let i = 0; i < 250 && !fs.existsSync(readyFile); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    ready = fs.existsSync(readyFile);
  } catch { /* 下面按未就绪处理 */ }
  try { fs.rmSync(readyFile, { force: true }); } catch { /* absent */ }
  return ready;
}

export async function launchManaged(home, appId, app, opts = {}) {
  const runId = newRunId();
  const logDir = path.join(home, 'logs', appId);
  fs.mkdirSync(logDir, { recursive: true });
  const outPath = path.join(logDir, `${runId}.stdout.log`);
  const errPath = path.join(logDir, `${runId}.stderr.log`);
  const rt = readRuntimeStrict(home, appId) ?? { schemaVersion: SCHEMA_VERSION, appId, prevRuns: [] };
  if (opts.abandonRunId && rt.current && rt.current.runId === opts.abandonRunId
      && rt.current.managed !== false && isUnresolvedPhase(rt.current.phase)) {
    archiveCurrent(rt, { reason: 'abandoned-by-ack' }); // 显式 ack 的未结旧账：保留证据并注明原因
  } else {
    archiveCurrent(rt); // 旧运行证据归档保留，绝不删账
  }

  const isCommand = !!app.command;
  rt.current = {
    runId, phase: 'STARTING', managed: true, mode: app.mode,
    kind: isCommand ? 'command' : 'direct',
    intentAt: new Date().toISOString(), startedAt: null,
    pid: null, creationFileTime: null, image: null,
    wrapperPid: null, wrapperCreationFileTime: null, wrapperImage: null, loggerPid: null,
    envResolved: (app.envRefs ?? []).filter((n) => n in process.env),
    logPaths: { stdout: outPath, stderr: errPath },
    lastError: null, endedAt: null, exitNote: null,
  };
  writeRuntime(home, appId, rt);

  const failUnresolved = (code, message, detail) => {
    writeRuntime(home, appId, rt);
    const stderrTail = readStderrTailSafe(rt.current.logPaths.stderr);
    throw conflictError(code, message, { runId, logPaths: rt.current.logPaths, ...detail, stderrTail });
  };

  let child;
  const pidFile = path.join(logDir, `.${runId}.pid`);
  let spawnError = null;
  try {
    const sinkConfig = path.join(logDir, `.${runId}.sink.json`);
    fs.writeFileSync(sinkConfig, JSON.stringify({
      file: isCommand ? resolveShell(app.cwd) : app.exe,
      args: isCommand ? shellArgs(app.command) : app.args,
      cwd: app.cwd, outPath, errPath,
      home, appId, runtimeFile: runtimePath(home, appId), runId,
      limit: app.logMaxBytes ?? RUN_LOG_MAX_BYTES, pidFile,
    }));
    // The detached logger owns both output descriptors and launches the application
    // with pipes, allowing safe stdout rotation without touching a live app fd.
    // 命令模式：Windows 拉起 cmd /d /s /c，Linux 拉起 /bin/sh -c；真实目标进程
    // 稍后按后代发现确定。必须 detached：Node 在 Windows 上把非 detached 子进程
    // 放入 kill-on-close 作业对象，manager 退出（CLI 必退）会整树终止 logger→shell→目标；
    // Linux 下 detached 让 logger 脱离当前会话，CLI 退出后仍存活。stdout 走 pipe
    // 不依赖控制台，detach 不影响日志转发（Windows cmd 与 Linux sh 均已实测）。
    child = spawn(process.execPath, [LOG_WRITER, sinkConfig], {
      cwd: app.cwd, detached: true, windowsHide: true,
      // env 只在内存中合并传给 logger（不写入落盘的 sink 配置，避免把环境变量落成文件）。
      stdio: 'ignore',
      env: { ...process.env, ...(app.env ?? {}) },
    });
    child.unref();
  } catch (e) {
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `spawn_failed: ${e.message}`;
    failUnresolved('SPAWN_FAILED', `进程启动失败；意图与证据已保留（runId=${runId}），拒绝自动重试`, { cause: e.message });
  }

  // spawn 的异步 error（ENOENT/EACCES 等）要等 'spawn'/'error' 事件落定后再继续：
  // 失败时 child.pid 为 undefined，直接采集会被记成 identity_capture_failed 悬案，
  // 掩盖真实原因——此时直接落 spawn_failed（#22）。
  const spawned = await new Promise((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', (err) => { spawnError = err; resolve(false); });
  });
  if (!spawned) {
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `spawn_failed: ${spawnError.code ?? spawnError.message}`;
    failUnresolved('SPAWN_FAILED', `进程启动失败（${spawnError.message}）；意图与证据已保留（runId=${runId}），拒绝自动重试`, { cause: String(spawnError.code ?? spawnError.message) });
  }

  // logger 身份采集：必须放在目标核验/discover 之后的 RUNNING 落账前——
  // 启动热路径上每多一次 pwsh 调用都会推迟 discover，挤占命令模式
  // 「目标延迟 spawn 后代」场景的歧义窗口余量（runtime-smoke #39 回归）。
  function captureLoggerCreationFileTime(cur) {
    try {
      const lcap = psProc('capture', { id: cur.loggerPid });
      if (lcap.result === 'ok') cur.loggerCreationFileTime = lcap.creationFileTime;
    } catch { /* 探测失败可忽略：status 侧降级为 pid-only 存活探测 */ }
  }

  rt.current.startedAt = new Date().toISOString();
  rt.current.loggerPid = child.pid; // 两种模式都记录：status 据此核验日志管道存活（#82-A3）
  if (isCommand) {
    rt.current.wrapperPid = child.pid; // 先记 logger pid；pidFile 出现后覆盖为真实 wrapper
  } else {
    rt.current.pid = child.pid;
  }

  let cap;
  if (isCommand) {
    // wrapper 是 log-writer spawn 的 cmd/sh（不是 logger 自身）。记录它的身份，
    // 供失败后的 cleanup-wrapper 同身份核验；pidFile 不可用时回退 logger 身份。
    const wrapperPid = readPidFile(pidFile);
    if (wrapperPid === 0) {
      // 与直连模式同一约定：pidFile=0 表示 cmd/sh wrapper 从未拉起，无存活进程，
      // 直接落 STOPPED 可重试——不再走 discover 空等（logger 滞留时会拖到超时）。
      rt.current.wrapperPid = null;
      rt.current.phase = 'STOPPED';
      rt.current.endedAt = new Date().toISOString();
      rt.current.exitNote = 'command wrapper spawn failed（pidFile=0）；详见 stderr 批次日志';
      failUnresolved('SPAWN_FAILED', `命令拉起失败（runId=${runId}）；错误原因见 stderr 日志尾部，未产生进程，可直接修正后重试`, { wrapperPid: 0, loggerPid: child.pid });
    }
    if (wrapperPid) rt.current.wrapperPid = wrapperPid;
    try { cap = psProc('capture', { id: rt.current.wrapperPid }); }
    catch (e) { cap = { result: 'error', message: e.message }; }
  }
  if (!isCommand) {
    // Capture the managed application, not the logging helper.
    // pidFile 由 log-writer 在目标 spawn 成功后写入；拿不到真实目标 pid 时绝不
    // 把 logger 自身的 pid 顶替为目标（否则 stop 会杀错进程、真实目标变孤儿）。
    const targetPid = readPidFile(pidFile);
    rt.current.pid = targetPid > 0 ? targetPid : null;
    if (targetPid === 0) {
      // log-writer 的 spawn 失败约定：pidFile=0 表示目标从未拉起（exe 失效/EACCES 等）。
      // 无存活进程，落 STOPPED 可直接重试；错误原文已由 log-writer 写入 stderr 日志。
      rt.current.phase = 'STOPPED';
      rt.current.endedAt = new Date().toISOString();
      rt.current.exitNote = 'target spawn failed（pidFile=0）；详见 stderr 批次日志';
      failUnresolved('SPAWN_FAILED', `目标进程拉起失败（runId=${runId}）；错误原因见 stderr 日志尾部，未产生进程，可直接修正后重试`, { targetPid: 0, loggerPid: child.pid });
    }
    try {
      cap = targetPid == null
        ? { result: 'error', code: 'target_pid_unavailable', message: `pidFile ${pidFile} 未出现或内容无效` }
        : psProc('capture', { id: targetPid });
    } catch (e) { cap = { result: 'error', message: e.message }; }
    if (cap.result === 'ok') {
      rt.current.phase = 'RUNNING';
      rt.current.creationFileTime = cap.creationFileTime;
      rt.current.image = cap.image;
      captureLoggerCreationFileTime(rt.current); // 目标核验后再采：多一次 pwsh 也不挤占启动热路径
      writeRuntime(home, appId, rt);
      return rt.current;
    }
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `identity_capture_failed: ${JSON.stringify(cap)}${spawnError ? `; spawn_error: ${spawnError.code ?? spawnError.message}` : ''}`;
    failUnresolved('IDENTITY_CAPTURE_FAILED', `已拉起（logger pid=${child.pid}）但目标身份采集失败，标记 UNKNOWN；证据保留，拒绝自动重试`, { targetPid, loggerPid: child.pid, capture: cap });
  }

  // ---- 命令模式：wrapper 身份留证，随后在后代中发现唯一真实目标 ----
  if (cap.result === 'ok') {
    rt.current.wrapperCreationFileTime = cap.creationFileTime;
    rt.current.wrapperImage = cap.image;
  }

  const waitMs = app.discoverTimeoutMs ?? COMMAND_DISCOVER_TIMEOUT_MS;
  // 从已验证的真实 wrapper 往下发现（如 pidFile 未给出时回退 logger pid）：
  // logger 可能因写退出证据而短暂存活，不能把“logger 还活着”误当成“wrapper 还活着”，
  // 否则命令即死场景会从 wrapperExited 退化成 DISCOVERY_TIMEOUT。
  const discoverAnchor = Number.isInteger(rt.current.wrapperPid) && rt.current.wrapperPid > 0
    ? rt.current.wrapperPid : child.pid;
  let d;
  try {
    d = psProc('discover', { id: discoverAnchor, image: app.expectedImage, waitMs });
  } catch (e) {
    d = { result: 'error', code: 'discover_failed', message: e.message };
  }

  if (d.result === 'found' && d.candidates.length === 1) {
    let t;
    try {
      t = psProc('capture', { id: d.candidates[0].pid });
    } catch (e) {
      t = { result: 'error', message: e.message };
    }
    if (t.result === 'ok') {
      rt.current.phase = 'RUNNING';
      rt.current.pid = d.candidates[0].pid;
      rt.current.creationFileTime = t.creationFileTime;
      rt.current.image = t.image;
      captureLoggerCreationFileTime(rt.current);
      writeRuntime(home, appId, rt);
      if (!startTargetExitWatcher(home, appId, runId, rt.current)) {
        // 不能在没有真实目标退出证据通道时报告启动成功：先按已采集身份停止目标，
        // 避免留下“已运行但退出码/信号永远不可得”的记录。
        let term = null;
        try {
          term = psProc('terminate', {
            id: rt.current.pid, creationFileTime: rt.current.creationFileTime, image: rt.current.image,
          });
        } catch (e) {
          term = { result: 'error', message: e.message };
        }
        const stopped = ['terminated', 'exited', 'notfound'].includes(term?.result);
        rt.current.phase = stopped ? 'STOPPED' : 'UNKNOWN';
        rt.current.endedAt = stopped ? new Date().toISOString() : null;
        rt.current.exitNote = stopped ? '退出证据 watcher 未就绪，已停止目标；未采集到退出码/信号' : null;
        if (!stopped) rt.current.lastError = `exit_watch_unavailable: ${JSON.stringify(term)}`;
        if (stopped) cleanupWrapper(rt);
        writeRuntime(home, appId, rt);
        throw conflictError('EXIT_WATCH_UNAVAILABLE',
          stopped
            ? `已发现目标（pid=${rt.current.pid}）但退出证据 watcher 未能就绪；目标已停止，未报告启动成功`
            : `已发现目标（pid=${rt.current.pid}）但退出证据 watcher 未能就绪且目标停止未确认，标记 UNKNOWN；证据已保留`,
          { runId, pid: rt.current.pid, wrapperPid: rt.current.wrapperPid, terminate: term });
      }
      return rt.current;
    }
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `identity_capture_failed(target=${d.candidates[0].pid}): ${JSON.stringify(t)}`;
    failUnresolved('IDENTITY_CAPTURE_FAILED', `已发现目标进程（pid=${d.candidates[0].pid}）但身份采集失败，标记 UNKNOWN；wrapper(pid=${child.pid})证据保留`, { pid: d.candidates[0].pid, wrapperPid: child.pid, capture: t });
  }

  if (d.result === 'found') {
    // 歧义即拒绝：候选清单留证，wrapper 仍在运行由人工决定处置
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `discovery_ambiguous: ${JSON.stringify(d.candidates)}`;
    failUnresolved('DISCOVERY_AMBIGUOUS', `wrapper(pid=${child.pid}) 后代中匹配 ${app.expectedImage} 的进程有 ${d.candidates.length} 个，拒绝任选一个；wrapper 仍在运行，证据已保留`, { wrapperPid: child.pid, expectedImage: app.expectedImage, candidates: d.candidates });
  }

  if (d.result === 'wrapperExited') {
    // wrapper 死了且无目标：命令大概率失败——没有存活进程，落 STOPPED 可直接重试
    rt.current.phase = 'STOPPED';
    rt.current.endedAt = new Date().toISOString();
    rt.current.exitNote = `command wrapper(pid=${child.pid}) 已退出且未发现匹配 ${app.expectedImage} 的目标进程`;
    failUnresolved('SPAWN_FAILED', `命令已退出且未发现目标进程（expectedImage=${app.expectedImage}，详见 stderr 日志）`, { wrapperPid: child.pid });
  }

  if (d.result === 'timeout') {
    rt.current.phase = 'UNKNOWN';
    rt.current.lastError = `discovery_timeout: ${waitMs}ms 内未发现匹配 ${app.expectedImage} 的后代（wrapper pid=${child.pid}）`;
    failUnresolved('DISCOVERY_TIMEOUT', `${waitMs}ms 内未发现匹配 ${app.expectedImage} 的后代进程；wrapper(pid=${child.pid}) 可能仍在启动中，证据保留，拒绝自动重试`, { wrapperPid: child.pid, expectedImage: app.expectedImage });
  }

  rt.current.phase = 'UNKNOWN';
  rt.current.lastError = `discovery_failed: ${JSON.stringify(d)}${spawnError ? `; spawn_error: ${spawnError.code ?? spawnError.message}` : ''}`;
  failUnresolved('DISCOVERY_FAILED', `后代发现失败（${d.code ?? d.result}），标记 UNKNOWN；wrapper(pid=${child.pid})证据保留`, { wrapperPid: child.pid, detail: d });
}
