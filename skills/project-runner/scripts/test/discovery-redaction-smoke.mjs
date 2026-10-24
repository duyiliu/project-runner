#!/usr/bin/env node
// 安全回归：命令模式歧义证据不得持久化原始命令行。
// 使用复制出的唯一 node 映像启动两个匹配后代，制造 DISCOVERY_AMBIGUOUS；命令带哨兵参数，
// 断言 CLI/status/runtime JSON 均不含原文，候选只保留身份字段与 cmdHash/cmdLength。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { isWindows, hasProcessProbe, killTree } from './platform.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const SENTINEL = 'PR_REDACTION_SENTINEL_DB_PASSWORD_7b2e5c91';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-discovery-redaction-'));
const home = path.join(base, 'home');
const project = path.join(base, 'app');
fs.mkdirSync(project, { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cli = (...args) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', home, '--json', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout || ''); } catch { /* 保留原始输出 */ }
  return { status: r.status, json, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
};

if (isWindows && !hasProcessProbe()) {
  console.log('discovery redaction smoke skipped: 缺 pwsh 7');
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(0);
}

const candidatePids = [];
let wrapperPid = 0;
try {
  // 复制成唯一映像名，避免并行测试/历史残留的同名 node 进程被误当作后代候选。
  const targetName = isWindows ? `pr-redaction-node-${process.pid}.exe` : `pr-redaction-node-${process.pid}`;
  const targetExe = path.join(project, targetName);
  fs.copyFileSync(process.execPath, targetExe);
  if (!isWindows) fs.chmodSync(targetExe, 0o755);
  fs.writeFileSync(path.join(project, 'two.js'),
    'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1e3)"],{stdio:"ignore"});\n'
    + 'setInterval(() => {}, 1000);\n', 'utf8');

  const descFile = path.join(base, 'desc.json');
  // 命令在项目 cwd 下执行：用相对映像名避免 Windows cmd /s /c 对带引号路径的再解析。
  const command = isWindows
    ? `${targetName} two.js --db-password=${SENTINEL}`
    : `./${targetName} two.js --db-password=${SENTINEL}`;
  fs.writeFileSync(descFile, JSON.stringify({
    alias: 'redact', root: project, entry: 'redact', mode: 'node',
    command,
    expectedImage: targetName, discoverTimeoutMs: 15000,
  }), 'utf8');

  const r = cli('start-new', '--desc', descFile);
  if (isWindows && (r.status === 4 || r.json?.error?.code === 'PWSH_MISSING')) {
    console.log('discovery redaction smoke skipped: 缺 pwsh 7');
  } else {
    assert.equal(r.status, 3, r.text);
    assert.equal(r.json.error.code, 'DISCOVERY_AMBIGUOUS', r.text);
    wrapperPid = r.json.error.detail?.wrapperPid ?? 0;
    const candidates = r.json.error.detail?.candidates ?? [];
    for (const c of candidates) candidatePids.push(c.pid);
    assert(candidates.length >= 2, `歧义候选不足：${JSON.stringify(candidates)}`);
    for (const c of candidates) {
      assert.equal(c.cmd, undefined, 'CLI 候选仍携带原始 cmd');
      assert.equal(typeof c.cmdLength, 'number', '候选缺少 cmdLength 证据');
      assert.match(c.cmdHash, /^[0-9a-f]{16}$/, '候选缺少 cmdHash 证据');
    }

    const s = cli('status', 'redact');
    assert.equal(s.status, 0, s.text);
    assert.equal(s.json.data.status, 'UNKNOWN', s.text);
    const runtimeRaw = fs.readFileSync(path.join(home, 'runtime', `${s.json.data.appId}.json`), 'utf8');
    for (const [label, text] of [['CLI', r.text], ['status', s.text], ['runtime JSON', runtimeRaw]]) {
      assert(!text.includes(SENTINEL), `${label} 泄露候选命令行原文`);
    }
    const persisted = JSON.parse(runtimeRaw).current.lastError;
    assert(!/"cmd"\s*:/.test(persisted), `runtime lastError 仍含原始 cmd：${persisted}`);
    console.log('discovery redaction smoke ok');
  }
} finally {
  for (const pid of candidatePids) killTree(pid);
  if (wrapperPid) killTree(wrapperPid);
  for (let i = 0; i < 20 && [...candidatePids, wrapperPid].some(isAlive); i++) await wait(250);
  const left = [...candidatePids, wrapperPid].filter(isAlive);
  if (left.length) throw new Error(`测试临时进程未清理：${left.join(', ')}`);
  let removed = false;
  for (let i = 0; i < 20 && !removed; i++) {
    try { fs.rmSync(base, { recursive: true, force: true }); removed = true; }
    catch { await wait(100); }
  }
  if (!removed) throw new Error(`临时目录未能清理：${base}`);
}
