// Cross-process advisory locks: holder identity is verified against the live
// process before a stale lock may be reclaimed; corrupted locks are never fixed.
import fs from 'node:fs';
import { lockPath } from './store.mjs';
import { psProc, selfIdentityCapture } from './probe.mjs';
import { sleepSync } from './proc.mjs';
import { conflictError, dataError } from './errors.mjs';

function holderAlive(holder) {
  if (!holder || typeof holder.pid !== 'number' || typeof holder.creationFileTime !== 'string') {
    throw dataError('LOCK_CORRUPT', `锁文件信息不完整，拒绝静默处理；人工核验后删除：${lockPath(holder ? holder.name : '')}`);
  }
  const r = psProc('capture', { id: holder.pid });
  if (r.result === 'notfound' || r.result === 'exited') return false; // 明确已退出 → 持有者已死
  if (r.result !== 'ok') return true; // 权限不足等未知情形：保守视为存活，拒绝回收
  return String(r.creationFileTime) === String(holder.creationFileTime); // 复用 → 视为死锁可回收
}

// 读取锁持有者，容忍「先占位后补全」的写入窗口：内容不完整时短时重试，
// 仍不完整返回 null（调用方按 LOCK_CORRUPT 拒绝静默处理）。
function readHolder(file) {
  for (let i = 0; i < 4; i++) {
    let holder;
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { holder = null; }
    if (holder && typeof holder === 'object' && typeof holder.pid === 'number') return holder;
    if (i < 3) sleepSync(100);
  }
  return null;
}

// 占位持有者（pid 有值、creationFileTime 未补全）只能按 pid 查存活：进程明确
// 已退出才可回收；存活或无法核验一律保守视为存活（无法排除 PID 复用）。
function placeholderAlive(holder) {
  const r = psProc('capture', { id: holder.pid });
  if (r.result === 'notfound' || r.result === 'exited') return false;
  return true;
}

function acquireLock(home, name, op, { light = false } = {}) {
  const file = lockPath(home, name);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw dataError('LOCK_UNWRITABLE', `锁创建失败（${file}）：${e.message}`);
      const holder = readHolder(file);
      if (!holder) {
        throw dataError('LOCK_CORRUPT', `锁文件损坏，拒绝静默处理；人工核验后删除：${file}`);
      }
      holder.name = name;
      let alive;
      try {
        alive = holder.creationFileTime ? holderAlive(holder) : placeholderAlive(holder);
      } catch (e3) {
        if (e3.code === 'PWSH_MISSING' || e3.code === 'LOCK_CORRUPT' || e3.code === 'IDENTITY_UNAVAILABLE') throw e3;
        alive = true; // 权限等未知情形：保守视为存活，拒绝回收
      }
      if (alive) throw conflictError('LOCK_BUSY', `另一操作进行中（${holder.op ?? '?'}，pid=${holder.pid}），拒绝并发执行`, { pid: holder.pid, op: holder.op ?? null });
      try {
        fs.renameSync(file, `${file}.stale-${Date.now()}`); // 回收死锁，保留现场
      } catch (e4) {
        if (e4.code !== 'ENOENT') throw conflictError('LOCK_STEAL_FAILED', `死锁回收失败：${e4.message}`);
      }
      continue;
    }
    let wrote = false;
    try {
      if (light) {
        // 内部日志证据写（log-writer）只持有极短时间，不触发 selfIdentityCapture
        // 的 pwsh 冷启动；占位持有者（pid-only）已足够让并发读方做出正确判断。
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, op, at: new Date().toISOString() }) + '\n', 'utf8');
        wrote = true;
      } else {
        // 先写占位持有者再补全身份：selfIdentityCapture 可能耗时数百毫秒，
        // 期间并发读方看到的是可重试的占位内容而不是空文件（#22）。
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, op, at: new Date().toISOString() }) + '\n', 'utf8');
        const me = selfIdentityCapture();
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, creationFileTime: me.creationFileTime, op, at: new Date().toISOString() }) + '\n', 0, 'utf8');
        wrote = true;
      }
    } finally {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
      if (!wrote) {
        // 持有者信息未写入（如 pwsh 不可用）时必须删掉刚创建的空锁，
        // 否则残留空文件会让后续每次调用都报 LOCK_CORRUPT 而永久卡死该应用。
        try { fs.unlinkSync(file); } catch { /* 已被删/回收则忽略 */ }
      }
    }
    return () => {
      try { fs.unlinkSync(file); } catch { /* 已被回收则忽略 */ }
    };
  }
  throw conflictError('LOCK_BUSY', '锁竞争失败');
}

export function withLock(home, name, op, fn) {
  const release = acquireLockWithEvidenceRetry(home, name, op);
  try {
    return fn();
  } finally {
    release();
  }
}

// 异步版 withLock：fn 返回 Promise 时锁一直保持到其 settle（用于异步 launch 阶段）。
export async function withLockAsync(home, name, op, fn) {
  const release = acquireLockWithEvidenceRetry(home, name, op);
  try {
    return await fn();
  } finally {
    release();
  }
}

// log-writer 专用轻量锁：只写 pid-only 持有者，不做 pwsh 身份采集。
// 仅用于日志轮转/退出证据这类毫秒级内部写；生命周期操作仍用 withLock 的完整身份。
export function withLogEvidenceLock(home, name, op, fn) {
  const release = acquireLockWithEvidenceRetry(home, name, op, { light: true });
  try {
    return fn();
  } finally {
    release();
  }
}

// log-writer 每次写完日志轮转/退出证据都可能持有应用锁（Windows 首次建锁需自证身份，
// 可能持续数百毫秒）。这类内部短写不应让用户的 start/stop 偶发 LOCK_BUSY：
// 仅当当前持有者确为 log-* 内部操作时做有界短重试；真实并发启停仍按原语义拒绝。
function acquireLockWithEvidenceRetry(home, name, op, options = {}) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return acquireLock(home, name, op, options);
    } catch (e) {
      const internal = e.code === 'LOCK_BUSY' && typeof e.detail?.op === 'string' && e.detail.op.startsWith('log-');
      if (!internal || attempt === 59) throw e;
      sleepSync(50);
    }
  }
  throw conflictError('LOCK_BUSY', '锁竞争失败');
}

// 注册表全局短时锁：任何 readRegistry→修改→atomicWriteJson 序列都必须在其中执行，
// 否则不同 appId 并发写入会丢更新（#22）。锁顺序固定为 app 锁 → registry 锁。
// 持有者每次只读写一瞬间，忙时做有界短重试而不是直接拒绝并发启动。
export function withRegistryLock(home, op, fn) {
  for (let i = 0; i < 100; i++) {
    try {
      return withLock(home, 'registry', op, fn);
    } catch (e) {
      if (e.code !== 'LOCK_BUSY') throw e;
      sleepSync(50 + Math.floor(Math.random() * 50));
    }
  }
  throw conflictError('LOCK_BUSY', '注册表锁竞争超时，拒绝执行');
}

export function lockHeld(home, name) {
  return fs.existsSync(lockPath(home, name));
}

// 只读查询锁状态：文件不存在 → 未持有；持有者已退出/PID 复用 → alive=false。
// 锁损坏或权限不足时保守视为仍持有（alive=true），不把无法核验误判成启动中断。
export function lockState(home, name) {
  const file = lockPath(home, name);
  if (!fs.existsSync(file)) return { held: false, alive: false };
  let holder;
  try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { held: true, alive: true, corrupt: true }; }
  if (!holder || typeof holder !== 'object') return { held: true, alive: true, corrupt: true };
  holder.name = name;
  try {
    return { held: true, alive: holderAlive(holder), pid: holder.pid, op: holder.op ?? null };
  } catch (e) {
    return { held: true, alive: true, error: e.code ?? 'UNKNOWN' };
  }
}
