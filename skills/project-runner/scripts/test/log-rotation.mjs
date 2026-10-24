#!/usr/bin/env node
// Integration check for bounded stdout logging, target continuity, and no-op rotation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTailLines } from '../lib/logs.mjs';
import { readRuntimeStrict, registryPath } from '../lib/store.mjs';
import { computeAppId } from '../lib/desc.mjs';
import { launchManaged } from '../lib/launch.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'log-writer.mjs');
const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-log-rotation-'));

function runLogger(name, limit, script, fileOverride, prepare) {
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
  if (typeof prepare === 'function') prepare({ dir, outPath, errPath, runtimeFile, pidFile });
  fs.writeFileSync(runtimeFile, JSON.stringify({ schemaVersion: 1, appId, current: { runId: 'run', phase: 'RUNNING' } }));
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
    logger.once('error', reject);
    logger.once('exit', (code) => resolve({ code, outPath, errPath, runtimeFile }));
  });
}

try {
  const rotated = await runLogger('rotated', 1024,
    "process.stdout.write('x'.repeat(1500)); setTimeout(() => { process.stdout.write('continued-after-rotation\\n', () => process.exit(0)); }, 100);");
  assert.equal(rotated.code, 0, 'logger and target should exit successfully');
  assert(fs.existsSync(`${rotated.outPath}.1`), 'oversized output should create the rotated file');
  assert(fs.statSync(`${rotated.outPath}.1`).size <= 1024, 'rotated output should be bounded');
  assert(fs.readFileSync(rotated.outPath, 'utf8').includes('continued-after-rotation'), 'target output should continue after rotation');
  assert.equal(JSON.parse(fs.readFileSync(rotated.runtimeFile, 'utf8')).current.logRotated, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(rotated.runtimeFile, 'utf8')).current.logRotatedStreams, ['stdout']);

  const errRotated = await runLogger('err-rotated', 1024,
    "process.stderr.write('e'.repeat(1500)); setTimeout(() => { process.stderr.write('stderr-after-rotation\\n', () => process.exit(0)); }, 100);");
  assert.equal(errRotated.code, 0, 'logger and target should exit successfully');
  assert(fs.existsSync(`${errRotated.errPath}.1`), 'oversized stderr should create the rotated file');
  assert(fs.statSync(`${errRotated.errPath}.1`).size <= 1024, 'rotated stderr should be bounded');
  assert(fs.readFileSync(errRotated.errPath, 'utf8').includes('stderr-after-rotation'), 'stderr should continue after rotation');
  assert.deepEqual(JSON.parse(fs.readFileSync(errRotated.runtimeFile, 'utf8')).current.logRotatedStreams, ['stderr']);

  const normal = await runLogger('normal', 1024, "process.stdout.write('small output\\n');");
  assert.equal(normal.code, 0);
  assert(!fs.existsSync(`${normal.outPath}.1`), 'output below limit should not create a rotated file');
  assert.equal(fs.readFileSync(normal.outPath, 'utf8'), 'small output\n');

  // rename 失败回归：用目录占住 .1 使轮转 rename 失败。先恰好写入 1024 字节
  // （等于 limit，不触发轮转），再写入标记触发轮转；此时绝不能回落到
  // open('w') 截断已有内容，且 runtime 需标记轮转失败。
  const blockedPrefix = 'a'.repeat(1024);
  const blockedMarker = 'trigger-failed-rotation\n';
  const rotateFailed = await runLogger('rotate-failed', 1024,
    `process.stdout.write(${JSON.stringify(blockedPrefix)}, () => setTimeout(() => { process.stdout.write(${JSON.stringify(blockedMarker)}, () => process.exit(0)); }, 100));`,
    undefined,
    ({ outPath }) => fs.mkdirSync(`${outPath}.1`));
  assert.equal(rotateFailed.code, 0, '轮转失败不应影响 logger 与目标进程退出');
  assert(fs.statSync(`${rotateFailed.outPath}.1`).isDirectory(), '占位目录应阻止 rename');
  const rotateFailedContent = fs.readFileSync(rotateFailed.outPath, 'utf8');
  assert.equal(rotateFailedContent, blockedPrefix + blockedMarker, 'rename 失败后必须完整保留失败前的 1024 字节并续写标记');
  const rotateFailedRuntime = JSON.parse(fs.readFileSync(rotateFailed.runtimeFile, 'utf8'));
  assert.deepEqual(rotateFailedRuntime.current.logRotateFailedStreams, ['stdout'], 'runtime 应标记 stdout 轮转失败');
  assert(!rotateFailedRuntime.current.logRotated, 'rename 失败不应标记为已轮转');

  // 启动阶段轮转失败：目标在 launchManaged 身份采集完成前写入超限数据，
  // log-writer 先落 runtime；launch 最终落账不得用旧快照覆盖失败证据。
  const startupDir = path.join(temp, 'startup-rotation');
  const startupHome = path.join(startupDir, 'home');
  const startupRoot = path.join(startupDir, 'app');
  fs.mkdirSync(path.join(startupHome, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(startupHome, 'locks'));
  fs.mkdirSync(startupRoot, { recursive: true });
  const startupRootReal = fs.realpathSync(startupRoot);
  const startupAppId = computeAppId(startupRootReal, 'default');
  fs.writeFileSync(path.join(startupRoot, 'rotate.js'), `
const fs = require('node:fs');
const path = require('node:path');
const logDir = path.join(process.env.SMOKE_HOME, 'logs', process.env.SMOKE_APPID);
const latest = fs.readdirSync(logDir)
  .filter((name) => name.endsWith('.stdout.log'))
  .map((name) => { const file = path.join(logDir, name); return { file, mtimeMs: fs.statSync(file).mtimeMs }; })
  .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
fs.mkdirSync(latest.file + '.1');
process.stdout.write('s'.repeat(1024), () => setTimeout(() => {
  process.stdout.write('startup-rotate-failed\\n', () => {});
}, 100));
setInterval(() => {}, 1000);
`, 'utf8');
  const startupApp = {
    appId: startupAppId, alias: 'startup-rotate', entry: 'default', mode: 'node', root: startupRootReal, cwd: startupRootReal,
    exe: process.execPath, args: ['rotate.js'], command: null, expectedImage: null,
    envRefs: [], env: { SMOKE_HOME: startupHome, SMOKE_APPID: startupAppId }, logMaxBytes: 1024,
    expectedPort: null, readyLogPattern: null, readyUrl: null,
  };
  let startupCur = null;
  try {
    startupCur = await launchManaged(startupHome, startupAppId, startupApp);
    let startupRt = null;
    for (let i = 0; i < 50; i++) {
      startupRt = readRuntimeStrict(startupHome, startupAppId);
      if (startupRt?.current?.logRotateFailedStreams?.includes('stdout')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(startupRt?.current?.logRotateFailedStreams, ['stdout'], '启动完成后的 runtime 必须保留轮转失败状态');
    assert(!startupRt.current.logRotated, '启动阶段轮转失败不应误报 logRotated');
    const startupLog = fs.readFileSync(startupRt.current.logPaths.stdout, 'utf8');
    assert.equal(startupLog, 's'.repeat(1024) + 'startup-rotate-failed\n', '启动阶段失败轮转不得截断既有日志');
    fs.writeFileSync(registryPath(startupHome), JSON.stringify({ schemaVersion: 1, apps: { [startupAppId]: startupApp } }));
    const status = spawnSync(process.execPath, [MANAGER, '--home', startupHome, '--json', 'status', 'startup-rotate'], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const statusRun = JSON.parse(status.stdout).data.run;
    assert.deepEqual(statusRun.logRotateFailedStreams, ['stdout'], 'status 必须保留启动阶段的轮转失败 stream');
    assert.equal(statusRun.logRotated, false, 'status 不应误报 logRotated');
  } finally {
    if (startupCur?.pid) { try { process.kill(startupCur.pid, 'SIGKILL'); } catch { /* 已退出 */ } }
    if (startupCur?.loggerPid) { try { process.kill(startupCur.loggerPid, 'SIGKILL'); } catch { /* 已退出 */ } }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  // pidFile=0 契约：目标 spawn 失败时快速落 SPAWN_FAILED 所需的错误信号
  const spawnFailed = await runLogger('spawn-failed', 1024, "process.stdout.write('never')", 'Z:/definitely/missing/target.exe');
  assert.equal(spawnFailed.code, 1, 'spawn 失败时 logger 应以非零码退出');
  assert.equal(fs.readFileSync(path.join(temp, 'spawn-failed', 'target.pid'), 'utf8'), '0', 'spawn 失败应写 pidFile=0');
  assert.match(fs.readFileSync(path.join(temp, 'spawn-failed', 'run.stderr.log'), 'utf8'), /target spawn failed/, 'spawn 错误应落入 stderr 批次日志');

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
