#!/usr/bin/env node
// Persist the real exit status of a command-mode managed target (#102).
// log-writer is the parent of the shell wrapper, not of the discovered target; this
// detached helper holds/opens the target's OS identity and waits for that exact
// instance, then records exit/{code,signal,at} under the same app lock + runId match.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRuntimeStrict, atomicWriteJson, runtimePath } from './lib/store.mjs';
import { withLogEvidenceLock } from './lib/locks.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PS_PROC = path.join(SCRIPTS_DIR, 'ps', 'proc.ps1');
const LINUX_WAIT = path.join(SCRIPTS_DIR, 'linux', 'wait-exit.py');
const [home, appId, runId, pidArg, creationFileTime, readyFile = ''] = process.argv.slice(2);
const targetPid = Number(pidArg);
if (!home || !appId || !runId || !Number.isInteger(targetPid) || targetPid <= 0 || !creationFileTime) {
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runHelper(file, args) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ result: 'error', code: e.code ?? 'spawnFailed' });
      return;
    }
    child.once('error', (e) => resolve({ result: 'error', code: e.code ?? 'spawnFailed' }));
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.once('close', () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!line) {
        resolve({ result: 'error', code: 'noOutput', message: err.trim().slice(0, 500) });
        return;
      }
      try { resolve(JSON.parse(line)); }
      catch { resolve({ result: 'error', code: 'badOutput', message: line.slice(0, 500) }); }
    });
  });
}

async function waitForTargetExit() {
  if (process.platform === 'win32') {
    return runHelper('pwsh', [
      '-NoProfile', '-NonInteractive', '-File', PS_PROC,
      '-Action', 'wait-exit', '-Id', String(targetPid), '-CreationFileTime', String(creationFileTime),
      '-ReadyFile', readyFile,
    ]);
  }
  if (process.platform === 'linux') {
    for (const python of ['python3', 'python']) {
      const r = await runHelper(python, [LINUX_WAIT, String(targetPid), String(creationFileTime), readyFile]);
      if (r.result !== 'error' || r.code !== 'ENOENT') return r;
    }
  }
  return { result: 'error', code: 'PLATFORM_UNSUPPORTED' };
}

function matchingRun(rt) {
  if (rt?.current?.runId === runId) return rt.current;
  return (rt?.prevRuns ?? []).find((p) => p.runId === runId) ?? null;
}

async function persistRun(mutate) {
  const file = runtimePath(home, appId);
  // 目标可能恰好在 start 归档/新 run 启动时退出：按 runId 写入 current 或已归档条目，
  // 绝不覆盖新 run；锁忙时有界重试。
  for (let attempt = 0; attempt < 80; attempt++) {
    let written = false;
    try {
      withLogEvidenceLock(home, appId, 'exit-watch', () => {
        const rt = readRuntimeStrict(home, appId);
        const run = matchingRun(rt);
        if (!run || !mutate(run)) return;
        atomicWriteJson(file, rt);
        written = true;
      });
    } catch { /* 锁忙/记录暂不可读：下一轮按最新磁盘状态重试 */ }
    if (written) return true;
    await sleep(100);
  }
  return false;
}

const result = await waitForTargetExit();
if (result?.result === 'exited' && (Number.isInteger(result.code) || result.signal)) {
  const exitEvidence = {
    code: Number.isInteger(result.code) ? result.code : null,
    signal: result.signal ?? null,
    at: new Date().toISOString(),
    source: 'target-watch',
  };
  await persistRun((run) => {
    run.exit = exitEvidence;
    delete run.exitWatchError;
    return true;
  });
} else {
  // watcher 已就绪但目标退出状态不可读（例如 Linux 父进程抢先回收）：不伪造
  // code/signal，也不清空既有证据，只留下明确的不可用原因供 status/list/UI 展示。
  const reason = result?.result === 'unavailable'
    ? (result.reason ?? 'target exit status unavailable')
    : `target exit watch failed: ${result?.code ?? result?.result ?? 'unknown'}`;
  await persistRun((run) => {
    if (run.exit) return false;
    run.exitWatchError = { reason, at: new Date().toISOString(), source: 'target-watch' };
    return true;
  });
}
process.exit(0);
