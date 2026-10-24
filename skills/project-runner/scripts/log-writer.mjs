#!/usr/bin/env node
// Run a managed process behind a bounded log sink. The target's stdout/stderr
// are pipes owned here, so rotating files never changes the target's descriptors.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { readRuntimeStrict, atomicWriteJson } from './lib/store.mjs';
import { withLogEvidenceLock } from './lib/locks.mjs';

const [configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
try { fs.unlinkSync(configPath); } catch { /* best effort */ }
const { file, args, cwd, outPath, errPath, home, appId, runtimeFile, runId, limit } = config;
let outSize = 0;
let errSize = 0;
try { outSize = fs.statSync(outPath).size; } catch { /* first write */ }
try { errSize = fs.statSync(errPath).size; } catch { /* first write */ }
let outFd = fs.openSync(outPath, 'a');
let errFd = fs.openSync(errPath, 'a');
const rotatedStreams = new Set();
const recordedStreams = new Set();
const rotateFailedStreams = new Set();
const recordedFailedStreams = new Set();
let rotationRetryTimer = null;
let rotationRetryAttempts = 0;
// 目标进程退出证据：runId 匹配当前记录时写入 current.exit（spawn 失败走 pidFile=0/lastError，不写 exit）。
// 与轮转状态共用应用锁并按 runId 二次确认，避免并发 start/stop 时记到错误的 run。
let exitInfo = null;
let exitRecorded = false;
let exitRetryTimer = null;
let exitRetryAttempts = 0;

function scheduleRotationRetry() {
  if (rotationRetryTimer || rotationRetryAttempts >= 40) return;
  const delay = Math.min(100 * (2 ** Math.min(rotationRetryAttempts, 4)), 2000);
  rotationRetryAttempts++;
  rotationRetryTimer = setTimeout(() => {
    rotationRetryTimer = null;
    persistRotationState();
  }, delay);
}

function persistRotationState() {
  if ([...rotatedStreams].every((stream) => recordedStreams.has(stream))
    && [...rotateFailedStreams].every((stream) => recordedFailedStreams.has(stream))) return;
  try {
    withLogEvidenceLock(home, appId, 'log-rotation', () => {
      const rt = readRuntimeStrict(home, appId);
      if (rt?.current?.runId !== runId) {
        for (const stream of rotatedStreams) recordedStreams.add(stream);
        for (const stream of rotateFailedStreams) recordedFailedStreams.add(stream);
        return;
      }
      const streams = new Set([...(rt.current.logRotatedStreams ?? []), ...rotatedStreams]);
      const failed = new Set([...(rt.current.logRotateFailedStreams ?? []), ...rotateFailedStreams]);
      if (streams.size) rt.current.logRotated = true;
      rt.current.logRotatedStreams = [...streams];
      if (failed.size) rt.current.logRotateFailedStreams = [...failed];
      atomicWriteJson(runtimeFile, rt);
      for (const stream of rotatedStreams) recordedStreams.add(stream);
      for (const stream of rotateFailedStreams) recordedFailedStreams.add(stream);
    });
  } catch {
    scheduleRotationRetry();
  }
}

function markRotated(stream) {
  rotatedStreams.add(stream);
  persistRotationState();
}

function markRotateFailed(stream) {
  rotateFailedStreams.add(stream);
  persistRotationState();
}

function scheduleExitRetry() {
  if (exitRetryTimer || exitRetryAttempts >= 40) return;
  const delay = Math.min(100 * (2 ** Math.min(exitRetryAttempts, 4)), 2000);
  exitRetryAttempts++;
  exitRetryTimer = setTimeout(() => {
    exitRetryTimer = null;
    persistExitState();
  }, delay);
}

// command 模式的直接子进程通常是 shell wrapper，manager 托管的是 discover 找到的后代。
// 只有确认直接子进程就是受管目标（例如 Linux shell exec 后 pid 不变）时，才把它的
// 退出结果写成目标 exit；否则单独写 wrapperExit，避免把 wrapper 的退出码/信号冒充目标。
function isCommandWrapper(run) {
  if (run?.kind !== 'command') return false;
  // 目标尚未发现（pid 缺失）时 wrapper 的退出绝不能当成目标退出；只有记录中
  // 有真实目标 pid、且目标与 wrapper 是同一进程（如 shell exec）时才算目标。
  if (!Number.isInteger(run.pid) || run.pid <= 0) return true;
  if (!Number.isInteger(run.wrapperPid) || run.wrapperPid <= 0) return true;
  return run.pid !== run.wrapperPid;
}

function applyExitEvidence(run) {
  if (!run || run.runId !== runId) return false;
  if (isCommandWrapper(run)) run.wrapperExit = exitInfo;
  else run.exit = exitInfo;
  return true;
}

function persistExitState() {
  if (!exitInfo || exitRecorded) return;
  try {
    withLogEvidenceLock(home, appId, 'log-exit', () => {
      const rt = readRuntimeStrict(home, appId);
      // 先匹配 current；目标退出后若 manager 已因 stdio 延迟/并发 start 把旧 run
      // 归档到 prevRuns，则继续按 runId 写入历史条目，绝不改新 current。
      let matched = applyExitEvidence(rt?.current);
      if (!matched) {
        const archived = (rt?.prevRuns ?? []).find((p) => p.runId === runId);
        matched = applyExitEvidence(archived);
      }
      if (!matched) {
        exitRecorded = true;
        return;
      }
      atomicWriteJson(runtimeFile, rt);
      exitRecorded = true;
    });
  } catch {
    // 停止/启动持锁期间短暂 LOCK_BUSY：有界重试，拿到锁后按 runId 复核。
    scheduleExitRetry();
  }
}

const target = spawn(file, args, { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
// pidFile 契约：spawn 同步拿到 pid 时立即写入；异步 error（ENOENT/EACCES 等）时写 0，
// manager 据此快速落 SPAWN_FAILED（无进程产生，可直接重试），不再等窗口超时后
// 误报 IDENTITY_CAPTURE_FAILED/UNKNOWN，错误原文同时落入 stderr 批次日志。
if (Number.isInteger(target.pid) && target.pid > 0) {
  fs.writeFileSync(config.pidFile, String(target.pid));
}
let spawnFailed = false;
target.on('error', (err) => {
  spawnFailed = true;
  try {
    fs.writeFileSync(config.pidFile, '0');
    const line = `[project-runner] target spawn failed: ${err.code ?? ''} ${err.message} (file=${file})\n`;
    fs.writeSync(errFd, line);
  } catch { /* 尽力而为 */ }
  process.exitCode = 1;
});
function writeChunk(stream, input) {
  const isOut = stream === 'stdout';
  let chunk = input;
  let fd = isOut ? outFd : errFd;
  let size = isOut ? outSize : errSize;
  const filePath = isOut ? outPath : errPath;
  if (chunk.length > limit) chunk = chunk.subarray(chunk.length - limit);
  if (fd == null) {
    // 此前轮转 reopen 失败（标记过 rotateFailed）：懒重开——append 模式，
    // 若 rename 当时也失败则旧内容仍在，append 续写不覆盖；仍失败则丢本
    // chunk 等下次再试，日志管道故障绝不波及目标进程。
    try {
      fd = fs.openSync(filePath, 'a');
      size = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
      if (isOut) { outFd = fd; outSize = size; } else { errFd = fd; errSize = size; }
    } catch { return; }
  }
  if (size + chunk.length > limit) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(`${filePath}.1`); } catch { /* absent */ }
    try { fs.renameSync(filePath, `${filePath}.1`); } catch { /* best effort */ }
    try {
      fd = fs.openSync(filePath, 'w');
    } catch {
      // reopen 失败：置空 fd 转为懒重开路径，并持久化 logRotateFailedStreams
      // 供 status/UI 透出——不再静默丢后续全部日志。
      if (isOut) outFd = null; else errFd = null;
      markRotateFailed(stream);
      return;
    }
    size = 0;
    if (isOut) outFd = fd; else errFd = fd;
    markRotated(stream);
  }
  fs.writeSync(fd, chunk);
  size += chunk.length;
  if (isOut) outSize = size; else errSize = size;
}
function forward(stream, isOut) {
  stream.on('data', (input) => {
    try {
      writeChunk(isOut ? 'stdout' : 'stderr', input);
    } catch { /* logging failure must not terminate the target */ }
  });
}
forward(target.stdout, true);
forward(target.stderr, false);
// 退出证据必须在 'exit' 落账：'close' 要等 stdio 全部关闭，若目标派生的子进程继续
// 持有 stdout/stderr 管道，会延迟到旧 run 已归档之后，导致证据丢失。
// 日志 fd 仍在下面 'close' 时关闭，临终输出不丢。
target.on('exit', (code, signal) => {
  if (spawnFailed) return;
  exitInfo = {
    code: Number.isInteger(code) ? code : null,
    signal: signal ?? null,
    at: new Date().toISOString(),
  };
  persistExitState();
});
// 'close' 在进程终止且 stdio 管道全部关闭后才触发：退出瞬间管道里残余的数据
// 都已在 'data' 回调写完，此时再关日志 fd 不会丢临终输出。
target.on('close', (code, signal) => {
  persistRotationState();
  try { fs.closeSync(outFd); } catch {}
  try { fs.closeSync(errFd); } catch {}
  if (!spawnFailed) process.exitCode = code ?? (signal ? 1 : 0);
});
