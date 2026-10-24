#!/usr/bin/env node
// Integration check for bounded stdout logging, target continuity, and no-op rotation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTailLines } from '../lib/logs.mjs';
import { psProc } from '../lib/probe.mjs';
import { hasProcessProbe } from './platform.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'log-writer.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-log-rotation-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runLogger(name, limit, script, fileOverride, runtimeState, onStarted) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir);
  const home = path.join(dir, 'home');
  const appId = 'arotation';
  fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(home, 'locks'));
  const outPath = path.join(dir, 'run.stdout.log');
  const errPath = path.join(dir, 'run.stderr.log');
  const runtimeFile = path.join(home, 'runtime', `${appId}.json`);
  const pidFile = path.join(dir, 'target.pid');
  fs.writeFileSync(runtimeFile, JSON.stringify(runtimeState
    ?? { schemaVersion: 1, appId, current: { runId: 'run', phase: 'RUNNING' } }));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    file: fileOverride ?? process.execPath,
    args: ['-e', script],
    cwd: dir,
    env: process.env,
    outPath,
    errPath,
    home,
    appId,
    runtimeFile,
    runId: 'run',
    limit,
    pidFile,
  }));
  return new Promise((resolve, reject) => {
    const logger = spawn(process.execPath, [SCRIPT, configPath], {
      stdio: 'ignore', env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    onStarted?.(logger, { home, runtimeFile, pidFile });
    logger.once('error', reject);
    logger.once('exit', (code) => resolve({ code, outPath, errPath, runtimeFile, home, pidFile }));
  });
}

try {
  const rotated = await runLogger('rotated', 1024, "process.stdout.write('x'.repeat(1500)); setTimeout(() => { process.stdout.write('continued-after-rotation\\n'); process.exit(0); }, 100);");
  assert.equal(rotated.code, 0, 'logger and target should exit successfully');
  assert(fs.existsSync(`${rotated.outPath}.1`), 'oversized output should create the rotated file');
  assert(fs.statSync(`${rotated.outPath}.1`).size <= 1024, 'rotated output should be bounded');
  assert(fs.readFileSync(rotated.outPath, 'utf8').includes('continued-after-rotation'), 'target output should continue after rotation');
  assert.equal(JSON.parse(fs.readFileSync(rotated.runtimeFile, 'utf8')).current.logRotated, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(rotated.runtimeFile, 'utf8')).current.logRotatedStreams, ['stdout']);

  const errRotated = await runLogger('err-rotated', 1024,
    "process.stderr.write('e'.repeat(1500)); setTimeout(() => { process.stderr.write('stderr-after-rotation\\n'); process.exit(0); }, 100);");
  assert.equal(errRotated.code, 0, 'logger and target should exit successfully');
  assert(fs.existsSync(`${errRotated.errPath}.1`), 'oversized stderr should create the rotated file');
  assert(fs.statSync(`${errRotated.errPath}.1`).size <= 1024, 'rotated stderr should be bounded');
  assert(fs.readFileSync(errRotated.errPath, 'utf8').includes('stderr-after-rotation'), 'stderr should continue after rotation');
  assert.deepEqual(JSON.parse(fs.readFileSync(errRotated.runtimeFile, 'utf8')).current.logRotatedStreams, ['stderr']);

  const normal = await runLogger('normal', 1024, "process.stdout.write('small output\\n');");
  assert.equal(normal.code, 0);
  assert(!fs.existsSync(`${normal.outPath}.1`), 'output below limit should not create a rotated file');
  assert.equal(fs.readFileSync(normal.outPath, 'utf8'), 'small output\n');
  const normalRt = JSON.parse(fs.readFileSync(normal.runtimeFile, 'utf8'));
  assert.equal(normalRt.current.exit.code, 0, '正常退出应记录 exit.code=0');
  assert.equal(normalRt.current.exit.signal, null, '正常退出不应带信号');
  assert.match(normalRt.current.exit.at, /^\d{4}-\d{2}-\d{2}T/, '退出证据应带 ISO 时间');

  const nonZero = await runLogger('non-zero', 1024, 'process.exit(7);');
  assert.equal(nonZero.code, 7, 'logger 应沿用目标的非零退出码');
  const nonZeroRt = JSON.parse(fs.readFileSync(nonZero.runtimeFile, 'utf8'));
  assert.equal(nonZeroRt.current.exit.code, 7, '非零退出应记录具体 code');
  assert.equal(nonZeroRt.current.exit.signal, null);

  // 目标退出但派生进程继续持有 stdout/stderr 时，'close' 会延迟；退出证据必须在 'exit' 落账。
  const delayedStartedAt = Date.now();
  let delayedExit = null;
  let delayedAt = null;
  const delayed = await runLogger('delayed-close', 1024,
    "const{spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>{},1600)'],{stdio:['ignore','inherit','inherit']});setTimeout(()=>process.exit(9),100);",
    undefined, undefined, (logger, { runtimeFile }) => {
      const timer = setInterval(() => {
        try {
          const ev = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).current.exit;
          if (ev) { delayedExit = ev; delayedAt = Date.now() - delayedStartedAt; clearInterval(timer); }
        } catch { /* runtime 尚未写入 */ }
      }, 25);
      logger.once('exit', () => clearInterval(timer));
    });
  assert.equal(delayed.code, 9);
  const delayedFinishedAt = Date.now() - delayedStartedAt;
  if (!delayedExit) {
    delayedExit = JSON.parse(fs.readFileSync(delayed.runtimeFile, 'utf8')).current.exit ?? null;
    delayedAt = Date.now() - delayedStartedAt;
  }
  assert.equal(delayedExit?.code, 9, 'stdio 未关闭时也应先记录目标退出码');
  if (delayedFinishedAt >= 1200) {
    // Linux 等平台：后代继续持有管道时 close 明显晚于 exit；必须已在 close 前落账。
    assert(delayedAt != null && delayedAt < 1200, `退出证据不应等待 stdio close（观察到 ${delayedAt}ms，logger 结束于 ${delayedFinishedAt}ms）`);
  }

  // 并发 start 已把旧 run 归档到 prevRuns 时，迟到的退出写入必须补到旧 run，且不碰新 current。
  if (hasProcessProbe()) {
    const lateName = 'late-archive';
    const lateRuntime = path.join(temp, lateName, 'home', 'runtime', 'arotation.json');
    const lateLock = path.join(temp, lateName, 'home', 'locks', 'arotation.lock');
    const me = psProc('capture', { id: process.pid });
    assert.equal(me.result, 'ok');
    const latePromise = runLogger(lateName, 1024,
      "const{spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>{},1800)'],{stdio:['ignore','inherit','inherit']});setTimeout(()=>process.exit(5),400);",
      undefined, undefined, () => {
        // 先占住应用锁，模拟 manager 正在归档/启动：logger 的 exit 写入会进入有界重试。
        fs.writeFileSync(lateLock, JSON.stringify({
          pid: process.pid, creationFileTime: me.creationFileTime, op: 'test-hold', at: new Date().toISOString(),
        }));
      });
    await sleep(700);
    const before = JSON.parse(fs.readFileSync(lateRuntime, 'utf8'));
    assert(!before.current.exit, '持锁期间不应写入退出证据');
    const archived = { ...before.current, archivedAt: new Date().toISOString() };
    delete archived.exit;
    before.prevRuns = [archived, ...(before.prevRuns ?? [])];
    before.current = { runId: 'new-run', phase: 'RUNNING' };
    fs.writeFileSync(lateRuntime, JSON.stringify(before, null, 2));
    fs.unlinkSync(lateLock);
    let archivedExit = null;
    for (let i = 0; i < 60 && !archivedExit; i++) {
      try {
        const rt = JSON.parse(fs.readFileSync(lateRuntime, 'utf8'));
        archivedExit = rt.prevRuns?.find((p) => p.runId === 'run')?.exit ?? null;
      } catch { /* 写入窗口 */ }
      if (!archivedExit) await sleep(50);
    }
    assert.equal(archivedExit?.code, 5, '迟到的退出证据应补写到已归档的旧 run');
    const during = JSON.parse(fs.readFileSync(lateRuntime, 'utf8'));
    assert.equal(during.current.runId, 'new-run');
    assert(!during.current.exit, '旧 run 的退出不得写到新 current');
    assert.equal((await latePromise).code, 5);
    const finalLate = JSON.parse(fs.readFileSync(lateRuntime, 'utf8'));
    assert.equal(finalLate.prevRuns.find((p) => p.runId === 'run').exit.code, 5);
    assert(!finalLate.current.exit);
  } else {
    console.log('  skip late-archive（缺进程探针，无法构造持锁归档竞态）');
  }

  // command 模式的直接子进程是 shell wrapper 时，不能把 wrapper 的普通退出伪装成目标 exit。
  const relabelRuntime = path.join(temp, 'command-wrapper', 'home', 'runtime', 'arotation.json');
  const relabel = await runLogger('command-wrapper', 1024, 'setTimeout(() => process.exit(0), 600);', undefined,
    { schemaVersion: 1, appId: 'arotation', current: { runId: 'run', phase: 'RUNNING' } },
    (logger, { pidFile, runtimeFile }) => {
      const timer = setInterval(() => {
        try {
          const pid = Number(fs.readFileSync(pidFile, 'utf8'));
          if (!Number.isInteger(pid) || pid <= 0) return;
          const rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
          rt.current = { ...rt.current, kind: 'command', pid: pid + 1, wrapperPid: pid };
          fs.writeFileSync(runtimeFile, JSON.stringify(rt, null, 2));
          clearInterval(timer);
        } catch { /* pidFile/runtime 尚未就绪 */ }
      }, 20);
      logger.once('exit', () => clearInterval(timer));
    });
  assert.equal(relabel.code, 0);
  const relabelCur = JSON.parse(fs.readFileSync(relabelRuntime, 'utf8')).current;
  assert.equal(relabelCur.wrapperExit.code, 0, 'wrapper 退出应单独留证');
  assert(!Object.prototype.hasOwnProperty.call(relabelCur, 'exit'), 'wrapper 退出不得冒充目标退出');

  // 未发现目标（pid 仍为空）时 wrapper 退出更不能写目标 exit。
  const undiscoveredRuntime = path.join(temp, 'command-undiscovered', 'home', 'runtime', 'arotation.json');
  const undiscovered = await runLogger('command-undiscovered', 1024, 'setTimeout(() => process.exit(4), 400);', undefined,
    { schemaVersion: 1, appId: 'arotation', current: { runId: 'run', phase: 'STARTING', kind: 'command', pid: null } },
    (logger, { pidFile, runtimeFile }) => {
      const timer = setInterval(() => {
        try {
          const pid = Number(fs.readFileSync(pidFile, 'utf8'));
          if (!Number.isInteger(pid) || pid <= 0) return;
          const rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
          rt.current = { ...rt.current, wrapperPid: pid };
          fs.writeFileSync(runtimeFile, JSON.stringify(rt, null, 2));
          clearInterval(timer);
        } catch { /* 尚未就绪 */ }
      }, 20);
      logger.once('exit', () => clearInterval(timer));
    });
  assert.equal(undiscovered.code, 4);
  const undiscoveredCur = JSON.parse(fs.readFileSync(undiscoveredRuntime, 'utf8')).current;
  assert.equal(undiscoveredCur.wrapperExit.code, 4, '未发现目标时 wrapper 结果应留存在 wrapperExit');
  assert(!Object.prototype.hasOwnProperty.call(undiscoveredCur, 'exit'), '未发现目标时不得生成目标 exit');

  // Linux shell exec 目标（pid 相同）时，直接子进程就是受管目标，仍需写目标 exit。
  const execRuntime = path.join(temp, 'command-exec-target', 'home', 'runtime', 'arotation.json');
  const execTarget = await runLogger('command-exec-target', 1024, 'setTimeout(() => process.exit(0), 500);', undefined,
    { schemaVersion: 1, appId: 'arotation', current: { runId: 'run', phase: 'RUNNING' } },
    (logger, { pidFile, runtimeFile }) => {
      const timer = setInterval(() => {
        try {
          const pid = Number(fs.readFileSync(pidFile, 'utf8'));
          if (!Number.isInteger(pid) || pid <= 0) return;
          const rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
          rt.current = { ...rt.current, kind: 'command', pid, wrapperPid: pid };
          fs.writeFileSync(runtimeFile, JSON.stringify(rt, null, 2));
          clearInterval(timer);
        } catch { /* 尚未就绪 */ }
      }, 20);
      logger.once('exit', () => clearInterval(timer));
    });
  assert.equal(execTarget.code, 0);
  const execCur = JSON.parse(fs.readFileSync(execRuntime, 'utf8')).current;
  assert.equal(execCur.exit.code, 0, '直接子进程即受管目标时应写目标 exit');

  if (process.platform !== 'win32') {
    const signalled = await runLogger('signalled', 1024,
      "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);");
    const signalledRt = JSON.parse(fs.readFileSync(signalled.runtimeFile, 'utf8'));
    assert.equal(signalledRt.current.exit.signal, 'SIGTERM', '被信号终止应记录 signal');
    assert.equal(signalledRt.current.exit.code, null, '信号终止的 code 应为 null');
  }

  // 迟到的 close 不得写到新 run：当前记录已切换为 other-run 时必须原样保留。
  const mismatch = await runLogger('mismatch', 1024, 'process.exit(0);', undefined, {
    schemaVersion: 1, appId: 'arotation',
    current: { runId: 'other-run', phase: 'RUNNING', exitNote: 'keep' },
  });
  assert.equal(mismatch.code, 0);
  const mismatchCurrent = JSON.parse(fs.readFileSync(mismatch.runtimeFile, 'utf8')).current;
  assert.equal(mismatchCurrent.runId, 'other-run', '不应改写其他 run 的记录');
  assert.equal(mismatchCurrent.exitNote, 'keep');
  assert(!Object.prototype.hasOwnProperty.call(mismatchCurrent, 'exit'), '旧 run 的退出信息不得写入当前 run');

  // pidFile=0 契约：目标 spawn 失败时快速落 SPAWN_FAILED 所需的错误信号
  const spawnFailed = await runLogger('spawn-failed', 1024, "process.stdout.write('never')", 'Z:/definitely/missing/target.exe');
  assert.equal(spawnFailed.code, 1, 'spawn 失败时 logger 应以非零码退出');
  assert.equal(fs.readFileSync(path.join(temp, 'spawn-failed', 'target.pid'), 'utf8'), '0', 'spawn 失败应写 pidFile=0');
  assert.match(fs.readFileSync(path.join(temp, 'spawn-failed', 'run.stderr.log'), 'utf8'), /target spawn failed/, 'spawn 错误应落入 stderr 批次日志');
  assert(!Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(spawnFailed.runtimeFile, 'utf8')).current, 'exit'),
    'spawn 失败不得伪装成正常/信号退出证据');

  const utf8File = path.join(temp, 'utf8-tail.log');
  const utf8Body = Buffer.from('中\n'.repeat(20000) + 'X');
  fs.writeFileSync(utf8File, Buffer.concat([Buffer.alloc(65533, 0x61), Buffer.from('中'), utf8Body]));
  const tail = readTailLines(utf8File, 3);
  assert.deepEqual(tail.lines, ['中', '中', 'X'], 'tail must preserve UTF-8 when its byte window starts inside a code point');
  assert(!tail.lines.some((line) => line.includes('\uFFFD')), 'tail must not replace characters at its byte boundary');
  console.log('log rotation checks passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
