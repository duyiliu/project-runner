// Runtime-record lifecycle: app context resolution, run archival, unresolved-run
// (STARTING/UNKNOWN) protection with explicit ack recovery, and status computation.
import { runtimePath, readRegistry, readRuntimeStrict, atomicWriteJson } from './store.mjs';
import { psProc, verifyRun, interpretVerifyResult } from './probe.mjs';
import { withLock, lockState } from './locks.mjs';
import { ID_RE } from './desc.mjs';
import { usageError, notFoundError, conflictError } from './errors.mjs';

export const PREV_RUNS_KEEP = 20;
// 未结记录（STARTING、启动中断、pid 未采集、UNKNOWN、进程与记录状态可能并存）
// 以及任何无法识别的 phase：一律禁止自动重试，只有 RUNNING/STOPPED 才可再次启动/移除
const RESUMABLE_PHASES = new Set(['RUNNING', 'STOPPED']);

export function appContext(home, ref) {
  if (!ref) throw usageError('需要 <alias|appId>');
  const reg = readRegistry(home);
  const appId = resolveAppId(reg, ref);
  const app = reg.apps[appId];
  const rt = readRuntimeStrict(home, appId);
  const cur = rt?.current ?? null;
  return { reg, appId, app, rt, cur };
}

export function resolveAppId(reg, ref) {
  const s = String(ref);
  if (ID_RE.test(s) && reg.apps[s]) return s;
  const low = s.toLowerCase();
  for (const app of Object.values(reg.apps)) {
    if (app.alias.toLowerCase() === low) return app.appId;
  }
  throw notFoundError(`未找到应用：${ref}（可用 list 查看）`);
}

/* Store reads/writes and atomic JSON persistence live in scripts/lib/store.mjs. */
export function archiveCurrent(rt, opts = {}) {
  if (rt.current) {
    const cur = rt.current;
    const entry = {
      runId: cur.runId, phase: cur.phase, managed: cur.managed, kind: cur.kind ?? 'direct',
      startedAt: cur.startedAt, endedAt: cur.endedAt ?? null,
      pid: cur.pid ?? null, image: cur.image ?? null,
      wrapperPid: cur.wrapperPid ?? null, wrapperCreationFileTime: cur.wrapperCreationFileTime ?? null,
      lastError: cur.lastError ?? null,
      exit: cur.exit ?? null, wrapperExit: cur.wrapperExit ?? null,
      archivedAt: new Date().toISOString(),
    };
    if (opts.reason) {
      // 显式 ack 放弃的未结记录：保留完整身份与日志证据，注明归档原因
      entry.archiveReason = opts.reason;
      entry.intentAt = cur.intentAt ?? null;
      entry.pid = cur.pid ?? null;
      entry.creationFileTime = cur.creationFileTime ?? null;
      entry.image = cur.image ?? null;
      entry.wrapperPid = cur.wrapperPid ?? null;
      entry.logPaths = cur.logPaths ?? null;
      entry.exitNote = cur.exitNote ?? null;
      entry.envResolved = cur.envResolved ?? [];
    }
    rt.prevRuns = rt.prevRuns ?? [];
    rt.prevRuns.unshift(entry);
    rt.prevRuns = rt.prevRuns.slice(0, PREV_RUNS_KEEP);
    rt.current = null;
  }
}

export function writeRuntime(home, appId, rt) {
  atomicWriteJson(runtimePath(home, appId), rt);
}

// ---------- 未结记录（STARTING/UNKNOWN）防护与显式 ack 恢复 ----------

export function runEvidence(home, appId, cur) {
  return {
    runId: cur.runId,
    phase: cur.phase,
    managed: cur.managed,
    pid: cur.pid ?? null,
    intentAt: cur.intentAt ?? null,
    startedAt: cur.startedAt ?? null,
    lastError: cur.lastError ?? null,
    exit: cur.exit ?? null,
    runtimeFile: runtimePath(home, appId),
    logPaths: cur.logPaths ?? null,
  };
}

function unresolvedRunError(home, appId, rt) {
  const cur = rt.current;
  const ev = runEvidence(home, appId, cur);
  const logHint = cur.logPaths?.stdout ? `，日志：${cur.logPaths.stdout}` : '';
  return conflictError('UNRESOLVED_RUN',
    `存在未结运行记录 runId=${cur.runId}（phase=${cur.phase}${cur.pid != null ? `，pid=${cur.pid}` : ''}），拒绝自动重复启动，未产生新进程；证据：${ev.runtimeFile}${logHint}。请先人工核验该进程是否仍存活（status/logs 可查），确认已退出后再用 --ack-unresolved ${cur.runId} 显式恢复`,
    ev);
}

// ack 前复核：旧进程仍存活则拒绝；已退出/无 pid 可核验才允许放弃旧账。
function verifyAbandonable(home, appId, cur) {
  const ev = runEvidence(home, appId, cur);
  if (cur.pid == null) return; // 无 pid 可核验：显式 ack 即人工核验结论
  if (cur.creationFileTime && cur.image) {
    const v = verifyRun(cur); // 核验失败抛 IDENTITY_UNKNOWN，保守拒绝
    if (v.alive) {
      throw conflictError('UNRESOLVED_RUN',
        `--ack-unresolved=${cur.runId} 被拒绝：旧进程仍存活（pid=${cur.pid}），禁止启动第二份受管实例`,
        { ...ev, verification: 'alive' });
    }
    return; // 已退出或 PID 已复用
  }
  const r = psProc('capture', { id: cur.pid });
  if (r.result === 'notfound' || r.result === 'exited') return;
  if (r.result === 'ok') {
    throw conflictError('UNRESOLVED_RUN',
      `--ack-unresolved=${cur.runId} 被拒绝：pid=${cur.pid} 仍存在但记录缺少完整身份证据（creationFileTime/image），无法确认是否为原实例；请人工核验并处理该进程后重试`,
      { ...ev, verification: 'identity-incomplete-pid-present' });
  }
  throw conflictError('IDENTITY_UNKNOWN',
    `--ack-unresolved=${cur.runId} 无法核验 pid=${cur.pid} 当前状态（${r.code ?? r.result}），拒绝`,
    { ...ev, capture: r });
}

// 返回 null（无未结记录）或 {runId}（已验证可放弃，launchManaged 归档时注明 abandoned-by-ack）。
// managed=false 的登记记录不表示受管实例，不构成受管启动的未结记录。
export function resolveUnresolvedRun(home, appId, rt, ackRunId) {
  const cur = rt && rt.current;
  const unresolved = !!(cur && cur.managed !== false && isUnresolvedPhase(cur.phase));
  if (!unresolved) {
    if (ackRunId) {
      throw conflictError('ACK_MISMATCH',
        `当前没有 STARTING/UNKNOWN 未结记录，--ack-unresolved=${ackRunId} 不适用；请去掉该参数`,
        { ackRunId, current: cur ? { runId: cur.runId, phase: cur.phase, managed: cur.managed } : null });
    }
    return null;
  }
  if (!ackRunId) throw unresolvedRunError(home, appId, rt);
  if (ackRunId !== cur.runId) {
    throw conflictError('ACK_MISMATCH',
      `--ack-unresolved=${ackRunId} 与未结记录 runId=${cur.runId} 不一致，拒绝`,
      { ackRunId, ...runEvidence(home, appId, cur) });
  }
  verifyAbandonable(home, appId, cur);
  return { runId: cur.runId, evidence: runEvidence(home, appId, cur) };
}

// 未结判定：STARTING/UNKNOWN 明确是未结记录；无法识别的 phase（例如记录被外部改坏）
// 同样按未结处理并保留证据，避免“先归档旧账再起”造成旧进程永久失管。
export function isUnresolvedPhase(phase) {
  return !RESUMABLE_PHASES.has(phase);
}

export function parseAckRunId(value) {
  if (value == null) return null;
  if (!ID_RE.test(value)) throw usageError(`--ack-unresolved 需要合法 runId：${value}`);
  return value;
}

// ---------- 状态计算（只读 + 就地标记；落账由 statusWithFacts 在锁内完成） ----------

// 目标进程退出证据的可读摘要。旧 runtime 记录没有 exit 字段时返回 null，
// 状态计算保持原有“进程已退出”等文案，保证向后兼容。
export function exitSummary(cur) {
  const ev = cur?.exit;
  if (!ev || typeof ev !== 'object') return null;
  if (ev.signal) return `被信号终止（signal=${ev.signal}）`;
  if (Number.isInteger(ev.code)) {
    return ev.code === 0 ? '正常退出（code=0）' : `异常退出（code=${ev.code}）`;
  }
  return '退出码/信号不可用';
}

function stoppedNote(cur, fallback = null) {
  const summary = exitSummary(cur);
  const note = cur.exitNote ?? fallback;
  const watchError = cur.exitWatchError?.reason
    ? `退出码/信号不可用（${cur.exitWatchError.reason}）` : null;
  if (!summary) {
    if (!watchError) return note;
    if (!note) return watchError;
    return note.includes('退出码/信号不可用') ? note : `${note}；${watchError}`;
  }
  if (!note || note === summary || note.startsWith(summary)) return summary;
  // stop/grace 等已有过程证据时保留原文，但把具体 code/signal 放在最前面。
  return `${summary}；${note}`;
}

// 状态计算（只读 + 就地标记）。
// prefetched：批量核验预取结果（与逐条 verifyRun 同语义），避免 list 对 N 个应用 spawn N 次
export function computeStatus(home, appId, rt, prefetched = null) {
  if (!rt || !rt.current) return { status: 'UNKNOWN', note: '无当前运行记录' };
  const cur = rt.current;
  if (!cur.managed) {
    return { status: 'UNKNOWN', managed: false, runId: cur.runId, note: '非受管记录：仅记录启动尝试与日志线索，不提供生命周期控制' };
  }
  if (cur.phase === 'STARTING') {
    // 锁存在但持有者已退出（manager 崩溃/被强杀）时不能继续伪装成“启动中”：
    // 明确报启动中断，让用户走 --ack-unresolved 恢复；锁损坏/无法核验仍保守显示 STARTING。
    const lock = lockState(home, appId);
    if (lock.held && lock.alive) return { status: 'STARTING', managed: true, runId: cur.runId };
    const why = lock.held ? '锁持有者已退出' : '启动锁已释放';
    return {
      status: 'UNKNOWN', managed: true, runId: cur.runId,
      note: `启动中断（${why}，intentAt=${cur.intentAt}）；证据保留，需 --ack-unresolved 恢复`,
    };
  }
  if (cur.phase === 'STOPPED') {
    return { status: 'STOPPED', managed: true, runId: cur.runId, note: stoppedNote(cur), exit: cur.exit ?? null };
  }
  if (cur.phase === 'UNKNOWN') {
    return { status: 'UNKNOWN', managed: true, runId: cur.runId, note: cur.lastError ?? '状态未知' };
  }
  if (cur.phase === 'RUNNING') {
    const v = prefetched ? interpretVerifyResult(prefetched) : verifyRun(cur);
    if (v.alive) return { status: 'RUNNING', managed: true, runId: cur.runId, pid: cur.pid, exit: cur.exit ?? null };
    cur.phase = 'STOPPED';
    cur.endedAt = new Date().toISOString();
    cur.exitNote = stoppedNote(cur,
      v.reason === 'pidReused' ? '进程退出后 PID 被复用（未触碰新进程）' : '进程已退出');
    return { status: 'STOPPED', managed: true, runId: cur.runId, pid: cur.pid, note: cur.exitNote, exit: cur.exit ?? null, writeback: true };
  }
  return { status: 'UNKNOWN', managed: true, runId: cur.runId, note: `未知 phase=${cur.phase}` };
}

// 查询发现的进程退出落账：在应用锁内二次确认同一 runId 仍为 RUNNING 后写入，
// 避免与并发启动/停止对运行记录的写入互相覆盖；锁忙或锁损坏时跳过（不阻塞只读命令）
function settleStoppedWriteback(home, appId, marked) {
  try {
    withLock(home, appId, 'status-refresh', () => {
      const rt2 = readRuntimeStrict(home, appId);
      if (rt2 && rt2.current && rt2.current.runId === marked.runId && rt2.current.phase === 'RUNNING') {
        rt2.current.phase = 'STOPPED';
        rt2.current.endedAt = marked.endedAt;
        // logger 可能已在本次核验与锁之间写入 exit：按最新记录重新生成说明，
        // 不把已有的 code/signal 覆盖成笼统的“进程已退出”。
        rt2.current.exitNote = stoppedNote(rt2.current, marked.exitNote);
        writeRuntime(home, appId, rt2);
      }
    });
  } catch {
    // 跳过落账，查询结果照常返回
  }
}

// logger（log-writer）存活核验：只读、尽力而为、绝不误报。
// loggerPid 缺失（旧版记录）→ null；进程已退出 → 断流提示；启动时记录了
// loggerCreationFileTime 且 capture 不一致 → PID 复用提示；capture 失败
// （无权限/探针异常）→ 不提示（保守：误报比漏报更糟）。
export function loggerAliveNote(cur) {
  if (!cur || !Number.isInteger(cur.loggerPid) || cur.loggerPid <= 0) return null;
  let pidAlive;
  try { process.kill(cur.loggerPid, 0); pidAlive = true; }
  catch (e) { pidAlive = e?.code === 'EPERM'; }
  if (!pidAlive) return 'logger 进程已退出：日志管道断流，可能丢失尾部输出，请人工核验';
  if (cur.loggerCreationFileTime) {
    try {
      const cap = psProc('capture', { id: cur.loggerPid });
      if (cap.result === 'ok' && String(cap.creationFileTime) !== String(cur.loggerCreationFileTime)) {
        return 'logger PID 已被复用：日志管道状态不可信，请人工核验';
      }
    } catch { /* 探测失败不提示 */ }
  }
  return null;
}

// 查询即核验，并按 OS 事实落账；rtPrefetched 允许调用方（如 cmdList）复用已读的运行
// 记录避免二次磁盘读——settleStoppedWriteback 在锁内仍会重读最新值，不影响并发正确性。
export function statusWithFacts(home, appId, prefetched = null, rtPrefetched = undefined) {
  const rt = rtPrefetched !== undefined ? rtPrefetched : readRuntimeStrict(home, appId);
  const st = computeStatus(home, appId, rt, prefetched);
  // logger 是日志管道：其死亡不改写目标进程状态，仅以提示透出（#82-A3）。
  if (st.status === 'RUNNING' && rt?.current) st.loggerNote = loggerAliveNote(rt.current);
  if (st.writeback && rt && rt.current) {
    settleStoppedWriteback(home, appId, { endedAt: rt.current.endedAt, exitNote: rt.current.exitNote, runId: rt.current.runId });
  }
  return { rt, st };
}
