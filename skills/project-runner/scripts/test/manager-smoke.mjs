#!/usr/bin/env node
// manager CLI 生命周期冒烟测试：隔离 --home + process.execPath 作假 JVM exe，不触碰真实 ~/.project-runner/。
// 覆盖：start-new→RUNNING、重复 start→ALREADY_RUNNING、杀进程后 status 自动落账 STOPPED、
// stop/alreadyStopped、restart 新 runId+归档、伪造未结记录的 UNRESOLVED_RUN 与 --ack-unresolved 正反例、
// list 与单条 status 核验一致性、退出码/--json 抽查。
// 用法：node scripts/test/manager-smoke.mjs   （无外部依赖，Node 22+；缺 pwsh 7 时按惯例跳过核验类断言）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { hasProcessProbe, isWindows } from './platform.mjs';
import { MANAGER_VERSION } from '../lib/constants.mjs';
import { psProc, verifyRuns } from '../lib/probe.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-manager-smoke-'));
const home = path.join(base, 'home');
fs.mkdirSync(path.join(base, 'proj'), { recursive: true });
const proj = fs.realpathSync(path.join(base, 'proj'));

// 同步休眠（主线程，用于轮询进程退出落账）
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitLogPid = (file, re) => {
  let pid = null;
  for (let i = 0; i < 50 && pid == null; i++) {
    try {
      const m = re.exec(fs.readFileSync(file, 'utf8'));
      if (m) pid = Number(m[1]);
    } catch { /* 日志尚未落盘 */ }
    if (pid == null) sleep(100);
  }
  return pid;
};

const run = (args, { json = true } = {}) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', home, ...(json ? ['--json'] : []), ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON（文本模式或崩溃） */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json: parsed };
};
const runAt = (targetHome, args, { json = true } = {}) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', targetHome, ...(json ? ['--json'] : []), ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json: parsed };
};
const isPsMissing = (r) => r.code === 4
  && (r.json?.error?.code === 'PWSH_MISSING' || r.stdout.includes('PWSH_MISSING') || r.stderr.includes('PWSH_MISSING'));

let failed = 0;
const skipped = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};
class Skip extends Error { }
// 核验类断言：整条链路（锁/身份采集/核验/终止）依赖 pwsh，缺 pwsh 7 时按惯例跳过；
// 跳过时输出底层响应，区分「未安装」与「pwsh 瞬时失败」（如 Add-Type 偶发崩溃重试后仍失败）
const lifecycle = (name, fn) => {
  if (!hasPwsh) { skipped.push(name); console.log(`  skip  ${name}（缺进程探针，跳过核验类断言）`); return; }
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    if (e instanceof Skip) {
      skipped.push(name);
      console.log(`  skip  ${name}（缺进程探针，跳过核验类断言；底层响应：${e.message}）`);
      return;
    }
    failed++; console.log(`  FAIL ${name}: ${e.message}`);
  }
};
const expectOk = (r) => {
  if (isPsMissing(r)) throw new Skip(JSON.stringify(r.json?.error ?? { code: r.code, stderr: r.stderr.slice(0, 200) }));
  assert.equal(r.code, 0, `退出码期望 0，实际 ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.json?.ok, true, `JSON ok 期望 true：${r.stdout}`);
  return r.json;
};
const expectFail = (r, code, errCode) => {
  if (isPsMissing(r)) throw new Skip(JSON.stringify(r.json?.error ?? { code: r.code, stderr: r.stderr.slice(0, 200) }));
  assert.equal(r.code, code, `退出码期望 ${code}，实际 ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  if (errCode) assert.equal(r.json?.error?.code, errCode, `错误码期望 ${errCode}：${r.stdout}`);
  return r.json;
};

// ---------- 进程探针（一次，决定核验类断言是否执行） ----------
const hasPwsh = hasProcessProbe();
if (!hasPwsh) console.log(`（未检测到进程探针 ${isWindows ? 'pwsh 7' : '/proc'}：仅覆盖不依赖核验的检查，核验类断言跳过）`);

let currentPid = null;
try {
  // ---------- 基础检查（不依赖 pwsh）：退出码与 --json 形状 ----------
  check('list 空注册表（--json 形状 schemaVersion/ok/command/data）', () => {
    const r = run(['list']);
    assert.equal(r.code, 0);
    assert.equal(r.json.schemaVersion, 1);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.command, 'list');
    assert.deepEqual(r.json.data.apps, []);
    assert(r.json.data.note.includes('注册表为空'));
  });
  check('未知命令退出码 1（USAGE，--json error 形状）', () => {
    const r = run(['no-such-command']);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'USAGE');
    assert(r.json.error.message.includes('未知命令'));
  });
  check('status 未登记别名退出码 2（NOT_FOUND，--json error 形状）', () => {
    const r = run(['status', 'ghost']);
    assert.equal(r.code, 2);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.command, 'status');
    assert.equal(r.json.error.code, 'NOT_FOUND');
  });

  check('只读命令在空 home 上不创建数据目录', () => {
    const emptyHome = path.join(base, 'empty-home');
    assert.equal(runAt(emptyHome, ['list']).code, 0);
    assert.equal(runAt(emptyHome, ['logs', 'ghost']).code, 2);
    assert.equal(runAt(emptyHome, ['prune']).code, 0);
    assert.equal(runAt(emptyHome, ['version']).code, 0);
    assert.equal(fs.existsSync(emptyHome), false, '只读命令不应创建 home');
  });

  check('version/--version/-v 输出版本号（与 MANAGER_VERSION 一致）', () => {
    for (const arg of ['version', '--version', '-v']) {
      const r = runAt(path.join(base, 'empty-home'), ['--json', arg]);
      assert.equal(r.code, 0, `${arg} 退出码`);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.data.version, MANAGER_VERSION, `${arg} 版本号`);
      assert.match(r.json.data.version, /^\d+\.\d+\.\d+$/, 'semver 形状');
    }
  });

  check('doctor 逐项收集损坏记录并继续输出其余诊断', () => {
    const dh = path.join(base, 'doctor-home');
    fs.mkdirSync(path.join(dh, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(dh, 'locks'), { recursive: true });
    fs.mkdirSync(path.join(dh, 'logs'), { recursive: true });
    const homeReal = fs.realpathSync.native(dh);
    const registryFile = path.join(homeReal, 'registry.json');
    const corruptRuntime = path.join(homeReal, 'runtime', 'abad.json');
    const goodRuntime = path.join(homeReal, 'runtime', 'agood.json');
    fs.writeFileSync(registryFile, '{broken');
    fs.writeFileSync(corruptRuntime, '{broken');
    fs.writeFileSync(goodRuntime, JSON.stringify({ schemaVersion: 1, appId: 'agood', current: null, prevRuns: [] }));
    fs.writeFileSync(path.join(homeReal, 'locks', 'agood.lock'), '{}');
    const orphan = path.join(homeReal, '.tmp-1234-deadbeef');
    fs.writeFileSync(orphan, 'x');
    const r = runAt(homeReal, ['doctor']);
    assert.equal(r.code, 0, `doctor 应正常退出：${r.stdout}${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert(r.json.data.problems.find((p) => p.file === registryFile), '缺少损坏注册表');
    assert(r.json.data.problems.find((p) => p.file === corruptRuntime), '缺少损坏运行记录');
    assert(r.json.data.runtime.some((x) => x.appId === 'agood'), '健康运行记录应继续输出');
    assert(r.json.data.locks.includes('agood.lock'), '锁诊断不应被阻断');
    assert(r.json.data.orphanTmpFiles.includes(orphan), '临时文件诊断不应被阻断');
  });

  // POSIX 专属：shell 脚本是包装进程，真实目标会变成解释器子进程，必须拒绝。
  if (!isWindows) {    check('POSIX: exe 指向 #! 脚本被拒绝（CONFIG_INVALID，退出码 3）', () => {
      const fake = path.join(base, 'fake.sh');
      fs.writeFileSync(fake, '#!/bin/sh\necho hi\n');
      fs.chmodSync(fake, 0o755);
      const f = path.join(base, 'desc-shebang.json');
      fs.writeFileSync(f, JSON.stringify({ alias: 'shebang', root: proj, mode: 'proc', exe: fake, args: [] }));
      const r = run(['start-new', '--desc', f]);
      assert.equal(r.code, 3, r.stdout + r.stderr);
      assert.equal(r.json.error.code, 'CONFIG_INVALID');
      assert(r.json.error.message.includes('#!'));
    });
  }

  // ---------- 生命周期（依赖进程探针） ----------
  const descFile = path.join(base, 'desc.json');
  fs.writeFileSync(descFile, JSON.stringify({
    alias: 'smoke', root: proj, entry: 'default', mode: 'java',
    exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'],
    envRefs: [], expectedPort: 18080,
  }, null, 2));
  let appId = null;
  let firstRunId = null;

  lifecycle('start-new → RUNNING（readinessUntested=true）', () => {
    const j = expectOk(run(['start-new', '--desc', descFile]));
    assert.equal(j.data.status, 'RUNNING');
    assert.equal(j.data.managed, true);
    assert.equal(j.data.readinessUntested, true);
    assert(Number.isInteger(j.data.pid) && j.data.pid > 0, `pid 异常：${j.data.pid}`);
    assert(j.data.runId && /^[a-z0-9][a-z0-9-]{0,47}$/.test(j.data.runId), `runId 异常：${j.data.runId}`);
    firstRunId = j.data.runId;
    currentPid = j.data.pid;
  });

  lifecycle('list 核验：RUNNING + expectedPort 列 + 数据层含 appId', () => {
    const j = expectOk(run(['list']));
    const row = j.data.apps.find((a) => a.alias === 'smoke');
    assert(row, 'list 缺少 smoke 行');
    assert.equal(row.status, 'RUNNING');
    assert.equal(row.pid, currentPid);
    assert.equal(row.expectedPort, 18080);
    appId = row.appId;
  });

  lifecycle('status 单条核验与 list 结果一致（RUNNING）', () => {
    const j = expectOk(run(['status', 'smoke']));
    assert.equal(j.data.status, 'RUNNING');
    assert.equal(j.data.run.runId, firstRunId);
    assert.equal(j.data.run.pid, currentPid);
  });

  lifecycle('批量核验 verify-batch 与逐条核验结果一致', () => {
    const cur = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${appId}.json`), 'utf8')).current;
    const one = psProc('verify', { id: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image });
    const batch = verifyRuns([{ pid: cur.pid, creationFileTime: cur.creationFileTime, image: cur.image }]);
    assert.equal(batch.length, 1);
    assert.equal(batch[0].result, one.result, `批量与逐条不一致：${JSON.stringify(batch[0])} vs ${JSON.stringify(one)}`);
  });
  lifecycle('status --ready → 未配置就绪证据时报 UNTESTED', () => {
    const j = expectOk(run(['status', 'smoke', '--ready']));
    assert.equal(j.data.status, 'RUNNING');
    assert.equal(j.data.readiness.state, 'UNTESTED');
    assert.equal(j.data.readiness.configured, false);
    assert.equal(j.data.readinessUntested, true);
  });

  lifecycle('重复 start → ALREADY_RUNNING（退出码 3）', () => {
    const j = expectFail(run(['start', 'smoke']), 3, 'ALREADY_RUNNING');
    assert(j.error.message.includes('已有受管实例在运行'));
  });

  lifecycle('stop → stopped（有界强制终止）', () => {
    const j = expectOk(run(['stop', 'smoke']));
    assert.equal(j.data.result, 'stopped');
    assert.equal(j.data.runId, firstRunId);
  });

  lifecycle('重复 stop → alreadyStopped', () => {
    const j = expectOk(run(['stop', 'smoke']));
    assert.equal(j.data.result, 'alreadyStopped');
  });

  let secondRunId = null;
  lifecycle('restart → 已停实例直接起新 runId，旧批次归档 prevRuns', () => {
    const j = expectOk(run(['restart', 'smoke']));
    assert.equal(j.data.stop.result, 'alreadyStopped');
    assert.equal(j.data.start.status, 'RUNNING');
    assert.notEqual(j.data.start.runId, firstRunId, 'restart 未产生新 runId');
    secondRunId = j.data.start.runId;
    currentPid = j.data.start.pid;
    const st = expectOk(run(['status', 'smoke']));
    assert.equal(st.data.status, 'RUNNING');
    assert(st.data.prevRuns.some((p) => p.runId === firstRunId), '旧 runId 未归档到 prevRuns');
  });

  lifecycle('杀进程后 status 自动落账 STOPPED（运行记录写回）', () => {
    process.kill(currentPid, 'SIGKILL');
    let st = null;
    for (let i = 0; i < 40; i++) {
      st = run(['status', 'smoke']);
      if (st.code === 0 && st.json?.data?.status === 'STOPPED') break;
      sleep(250);
    }
    expectOk(st);
    assert.equal(st.json.data.status, 'STOPPED');
    // 落账：运行记录文件本身写回 STOPPED（带退出证据），而非只在响应里显示
    const rtFile = path.join(home, 'runtime', `${appId}.json`);
    const rt = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
    assert.equal(rt.current.phase, 'STOPPED');
    assert(rt.current.endedAt, '缺少 endedAt 退出证据');
  });

  lifecycle('list 与单条核验一致（进程已退出 → STOPPED）', () => {
    const j = expectOk(run(['list']));
    assert.equal(j.data.apps.find((a) => a.alias === 'smoke').status, 'STOPPED');
  });

  // ---------- 未结记录与 --ack-unresolved 正反例 ----------
  const rtFile = () => path.join(home, 'runtime', `${appId}.json`);
  lifecycle('残留锁 + STARTING → status 显示启动中断（UNKNOWN）', () => {
    const saved = fs.readFileSync(rtFile(), 'utf8');
    const lockFile = path.join(home, 'locks', `${appId}.lock`);
    const rt = JSON.parse(saved);
    rt.current = {
      runId: 'rstale1', phase: 'STARTING', managed: true, mode: 'java',
      intentAt: new Date().toISOString(), startedAt: null,
      pid: null, creationFileTime: null, image: null, envResolved: [],
      logPaths: null, lastError: null, endedAt: null, exitNote: null,
    };
    fs.writeFileSync(rtFile(), JSON.stringify(rt, null, 2));
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, creationFileTime: '1', op: 'start', at: new Date().toISOString() }));
    try {
      const st = expectOk(run(['status', 'smoke']));
      assert.equal(st.data.status, 'UNKNOWN');
      assert(st.data.note.includes('启动中断'), `note 未提示启动中断：${st.data.note}`);
      expectFail(run(['start', 'smoke']), 3, 'UNRESOLVED_RUN');
    } finally {
      fs.writeFileSync(rtFile(), saved);
      try { fs.unlinkSync(lockFile); } catch { /* start 已回收死锁 */ }
    }
  });
  lifecycle('伪造 STARTING 未结记录 → start 默认拒绝（UNRESOLVED_RUN）', () => {
    const rt = JSON.parse(fs.readFileSync(rtFile(), 'utf8'));
    rt.current = {
      runId: 'rfakestuck1', phase: 'STARTING', managed: true, mode: 'java',
      intentAt: new Date().toISOString(), startedAt: null,
      pid: null, creationFileTime: null, image: null, envResolved: [],
      logPaths: {
        stdout: path.join(home, 'logs', appId, 'rfakestuck1.stdout.log'),
        stderr: path.join(home, 'logs', appId, 'rfakestuck1.stderr.log'),
      },
      lastError: null, endedAt: null, exitNote: null,
    };
    fs.writeFileSync(rtFile(), JSON.stringify(rt, null, 2));
    const j = expectFail(run(['start', 'smoke']), 3, 'UNRESOLVED_RUN');
    assert(j.error.message.includes('rfakestuck1'), '错误信息未给出 runId');
    assert(j.error.message.includes('--ack-unresolved'), '错误信息未给出恢复指引');
  });

  lifecycle('--ack-unresolved 与未结 runId 不一致 → ACK_MISMATCH（退出码 3）', () => {
    expectFail(run(['start', 'smoke', '--ack-unresolved', 'rwrongrun1']), 3, 'ACK_MISMATCH');
  });

  lifecycle('--ack-unresolved 正例 → 显式放弃旧账并启动', () => {
    const j = expectOk(run(['start', 'smoke', '--ack-unresolved', 'rfakestuck1']));
    assert.equal(j.data.abandonedRunId, 'rfakestuck1');
    assert.equal(j.data.abandonedReason, 'abandoned-by-ack');
    assert.equal(j.data.status, 'RUNNING');
    currentPid = j.data.pid;
    const st = expectOk(run(['status', 'smoke']));
    const archived = st.data.prevRuns.find((p) => p.runId === 'rfakestuck1');
    assert(archived, 'rfakestuck1 未归档到 prevRuns');
    assert.equal(archived.archiveReason, 'abandoned-by-ack');
  });

  lifecycle('stop 后无未结记录时带 --ack-unresolved → ACK_MISMATCH', () => {
    expectOk(run(['stop', 'smoke']));
    expectFail(run(['start', 'smoke', '--ack-unresolved', 'rfakestuck1']), 3, 'ACK_MISMATCH');
  });

  lifecycle('并发 start-new 不同 alias 双双登记（#22 registry 全局锁防丢更新）', () => {
    const mkDesc = (alias) => {
      const f = path.join(base, `desc-${alias}.json`);
      fs.writeFileSync(f, JSON.stringify({
        alias, root: proj, entry: alias, mode: 'java',
        exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'], envRefs: [],
      }));
      return f;
    };
    const files = [mkDesc('conc-a'), mkDesc('conc-b')];
    const driver = path.join(base, 'concurrent-driver.cjs');
    fs.writeFileSync(driver,
      `const {spawn}=require('child_process');`
      + `const M=${JSON.stringify(MANAGER)},H=${JSON.stringify(home)},F=${JSON.stringify(files)};`
      + 'Promise.all(F.map((f)=>new Promise((res)=>{'
      + "const c=spawn(process.execPath,[M,'--home',H,'--json','start-new','--desc',f]);"
      + "let o='';c.stdout.on('data',(d)=>{o+=d;});"
      + "c.on('close',(code)=>res({code,out:o}));}))).then((rs)=>console.log(JSON.stringify(rs)));");
    const r = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 120000 });
    const rs = JSON.parse(r.stdout);
    assert.equal(rs.length, 2, `驱动输出异常：${r.stdout}${r.stderr}`);
    for (const x of rs) {
      const j = JSON.parse(x.out);
      assert(j.ok, `并发 start-new 失败（code=${x.code}）：${x.out}`);
    }
    const list = expectOk(run(['list']));
    const aliases = list.data.apps.map((a) => a.alias);
    assert(aliases.includes('conc-a') && aliases.includes('conc-b'), `注册表丢更新：${JSON.stringify(aliases)}`);
    expectOk(run(['stop', 'conc-a']));
    expectOk(run(['stop', 'conc-b']));
  });

  // ---------- stop --tree / --grace（#39 后代连带终止 + 优雅退出） ----------
  const treeProj = path.join(base, 'tree-proj');
  fs.mkdirSync(treeProj, { recursive: true });
  const treeRoot = fs.realpathSync(treeProj);
  fs.writeFileSync(path.join(treeRoot, 'parent.js'),
    "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},500)'],{detached:true,stdio:'ignore'});c.unref();console.log('child='+c.pid);setInterval(()=>{},500);\n");
  fs.writeFileSync(path.join(base, 'desc-tree.json'), JSON.stringify({
    alias: 'smoke-tree', root: treeRoot, entry: 'default', mode: 'node',
    exe: process.execPath, args: ['parent.js'], envRefs: [],
  }));

  lifecycle('stop --tree → 连带终止后代（treeKilled 含子进程身份）', () => {
    const s = expectOk(run(['start-new', '--desc', path.join(base, 'desc-tree.json')]));
    const logFile = path.join(home, 'logs', s.data.appId, `${s.data.runId}.stdout.log`);
    const childPid = waitLogPid(logFile, /child=(\d+)/);
    assert(childPid, '未能从 stdout 日志读到子进程 pid');
    const j = expectOk(run(['stop', 'smoke-tree', '--tree']));
    assert.equal(j.data.result, 'stopped');
    const killed = j.data.treeKilled ?? [];
    const entry = killed.find((k) => k.pid === childPid);
    assert(entry, `treeKilled 不含子进程 ${childPid}：${JSON.stringify(j.data)}`);
    assert(entry.image, 'treeKilled 缺少后代映像证据');
    const cap = psProc('capture', { id: childPid });
    assert(cap.result === 'notfound' || cap.result === 'exited', `后代进程仍存活：${JSON.stringify(cap)}`);
  });

  fs.writeFileSync(path.join(treeRoot, 'gone.js'),
    "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),200)'],{detached:true,stdio:'ignore'});c.unref();console.log('gone='+c.pid);setInterval(()=>{},500);\n");
  fs.writeFileSync(path.join(base, 'desc-gone.json'), JSON.stringify({
    alias: 'smoke-gone', root: treeRoot, entry: 'default', mode: 'node',
    exe: process.execPath, args: ['gone.js'], envRefs: [],
  }));

  lifecycle('stop --tree 后代已自行退出：跳过且不报错', () => {
    const s = expectOk(run(['start-new', '--desc', path.join(base, 'desc-gone.json')]));
    const logFile = path.join(home, 'logs', s.data.appId, `${s.data.runId}.stdout.log`);
    const childPid = waitLogPid(logFile, /gone=(\d+)/);
    assert(childPid, '未能从 stdout 日志读到已退出子进程 pid');
    let cap = null;
    for (let i = 0; i < 50; i++) {
      cap = psProc('capture', { id: childPid });
      if (cap.result === 'notfound' || cap.result === 'exited') break;
      sleep(100);
    }
    assert(cap.result === 'notfound' || cap.result === 'exited', `子进程尚未退出：${JSON.stringify(cap)}`);
    const j = expectOk(run(['stop', 'smoke-gone', '--tree']));
    assert.equal(j.data.result, 'stopped');
    assert.ok(Array.isArray(j.data.treeKilled), 'treeKilled 应为数组');
    assert(!j.data.treeKilled.some((k) => k.pid === childPid), `已退出的后代不应被记为终止：${JSON.stringify(j.data)}`);
  });

  lifecycle('restart --tree → 停旧实例时连带终止后代并起新实例', () => {
    const s = expectOk(run(['start-new', '--desc', path.join(base, 'desc-tree.json')]));
    const logFile = path.join(home, 'logs', s.data.appId, `${s.data.runId}.stdout.log`);
    const childPid = waitLogPid(logFile, /child=(\d+)/);
    assert(childPid, '未能从 stdout 日志读到重启前子进程 pid');
    const j = expectOk(run(['restart', 'smoke-tree', '--tree']));
    assert.equal(j.data.stop.result, 'stopped');
    const entry = (j.data.stop.treeKilled ?? []).find((k) => k.pid === childPid);
    assert(entry, `restart --tree 的 treeKilled 不含子进程 ${childPid}：${JSON.stringify(j.data)}`);
    const cap = psProc('capture', { id: childPid });
    assert(cap.result === 'notfound' || cap.result === 'exited', `重启前子进程仍存活：${JSON.stringify(cap)}`);
    assert.equal(j.data.start.status, 'RUNNING');
    expectOk(run(['stop', 'smoke-tree', '--tree'])); // 新实例也可能已派生后代，一并清理
  });

  fs.writeFileSync(path.join(treeRoot, 'gracer.js'),
    "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},500);\n");
  fs.writeFileSync(path.join(base, 'desc-grace.json'), JSON.stringify({
    alias: 'smoke-grace', root: treeRoot, entry: 'default', mode: 'node',
    exe: process.execPath, args: ['gracer.js'], envRefs: [],
  }));

  lifecycle('stop --grace → 优雅信号先行，仍存活则强制', () => {
    const s = expectOk(run(['start-new', '--desc', path.join(base, 'desc-grace.json')]));
    const j = expectOk(run(['stop', 'smoke-grace', '--grace', '3000']));
    assert.equal(j.data.result, 'stopped');
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${s.data.appId}.json`), 'utf8'));
    // Linux：SIGTERM 被捕获应优雅退出；Windows 控制台进程 taskkill 无 /F 多半失败 → grace 超时后强制
    assert(rt.current.exitNote.includes('grace'), `exitNote 未记录 grace 过程：${rt.current.exitNote}`);
    if (!isWindows) {
      // 发出 SIGTERM ≠ 目标被信号终止：gracer.js 捕获 SIGTERM 后 process.exit(0)，
      // 退出证据必须来自实际 exit 事件（code=0/signal=null），不能写成 SIGTERM。
      let exit = null;
      for (let i = 0; i < 40; i++) {
        exit = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${s.data.appId}.json`), 'utf8')).current.exit ?? null;
        if (exit) break;
        sleep(100);
      }
      assert.equal(exit?.code, 0, `grace 后目标退出码应为 0：${JSON.stringify(exit)}`);
      assert.equal(exit?.signal, null, `捕获 SIGTERM 后正常退出不应记 signal：${JSON.stringify(exit)}`);
    }
  });

  lifecycle('文本模式人类可读输出抽查（status 含 port/状态）', () => {
    const r = run(['status', 'smoke'], { json: false });
    assert.equal(r.code, 0);
    assert(r.stdout.includes('status=STOPPED'), r.stdout);
    assert(r.stdout.includes('run=') && r.stdout.includes('证据:'), r.stdout);
  });

  lifecycle('list 人类可读输出含 port 列', () => {
    const r = run(['list'], { json: false });
    assert.equal(r.code, 0);
    assert(r.stdout.split('\n')[0].includes('port'), r.stdout.split('\n')[0]);
    assert(r.stdout.includes('18080'), r.stdout);
  });

  // ---------- 退出码/信号证据展示（#102；纯读，不依赖进程探针） ----------
  check('status/list 展示退出码与信号，旧记录无 exit 仍可读', () => {
    const file = path.join(home, 'runtime', `${appId}.json`);
    const saved = fs.readFileSync(file, 'utf8');
    const writeExit = (exit) => {
      const rt = JSON.parse(saved);
      rt.current.phase = 'STOPPED';
      rt.current.exit = exit;
      rt.current.exitNote = null;
      fs.writeFileSync(file, JSON.stringify(rt, null, 2));
    };
    try {
      writeExit({ code: 7, signal: null, at: '2026-01-01T00:00:00.000Z' });
      const st = expectOk(run(['status', 'smoke']));
      assert.equal(st.data.status, 'STOPPED');
      assert.equal(st.data.run.exit.code, 7);
      assert.match(st.data.run.exitSummary, /异常退出（code=7）/);
      assert.match(st.data.note, /异常退出（code=7）/, `status note 未展示异常退出：${st.data.note}`);
      const row = expectOk(run(['list'])).data.apps.find((a) => a.alias === 'smoke');
      assert.equal(row.exit.code, 7);
      assert.match(row.exitSummary, /异常退出（code=7）/);
      assert(run(['status', 'smoke'], { json: false }).stdout.includes('code=7'), 'status 文本未展示 code');
      assert(run(['list'], { json: false }).stdout.includes('code=7'), 'list 文本未展示 code');

      writeExit({ code: null, signal: 'SIGKILL', at: '2026-01-01T00:00:01.000Z' });
      const sig = expectOk(run(['status', 'smoke']));
      assert.equal(sig.data.run.exit.signal, 'SIGKILL');
      assert.match(sig.data.note, /被信号终止（signal=SIGKILL）/, `status note 未展示信号：${sig.data.note}`);
      const sigRow = expectOk(run(['list'])).data.apps.find((a) => a.alias === 'smoke');
      assert.equal(sigRow.exit.signal, 'SIGKILL');

      // 旧 runtime 记录没有 exit 字段：沿用原有“进程已退出”文案，不报错。
      const legacy = JSON.parse(saved);
      legacy.current.phase = 'STOPPED';
      delete legacy.current.exit;
      legacy.current.exitNote = '进程已退出';
      fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
      const old = expectOk(run(['status', 'smoke']));
      assert.equal(old.data.status, 'STOPPED');
      assert.equal(old.data.run.exit, null);
      assert.match(old.data.note, /进程已退出/);
      assert.equal(expectOk(run(['list'])).data.apps.find((a) => a.alias === 'smoke').exit, null);

      // watcher 无法取得真实退出状态时必须显式透出不可用原因，不能静默伪装成已采集。
      legacy.current.exitWatchError = { reason: 'target reaped before status', at: '2026-01-01T00:00:02.000Z' };
      fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
      const watchErr = expectOk(run(['status', 'smoke']));
      assert.match(watchErr.data.note, /退出码\/信号不可用（target reaped before status）/);
      assert.equal(watchErr.data.run.exitWatchError.reason, 'target reaped before status');
      const watchErrRow = expectOk(run(['list'])).data.apps.find((a) => a.alias === 'smoke');
      assert.equal(watchErrRow.exitWatchError.reason, 'target reaped before status');
    } finally {
      fs.writeFileSync(file, saved);
    }
  });
} finally {
  try { if (currentPid) process.kill(currentPid, 'SIGKILL'); } catch { /* 已退出 */ }
  // stop 返回后 log-writer 可能仍在同一 cwd 下落退出证据（毫秒级）；Windows 上
  // 立即删临时目录会偶发 EBUSY。等待内部短写完成，不修改任何智能断言。
  for (let i = 0; i < 50; i++) {
    try { fs.rmSync(base, { recursive: true, force: true }); break; }
    catch (e) { if (i === 49) throw e; sleep(100); }
  }
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
if (skipped.length) console.log(`\n${skipped.length} 项跳过（缺 pwsh 7）`);
console.log('\nmanager smoke ok');
