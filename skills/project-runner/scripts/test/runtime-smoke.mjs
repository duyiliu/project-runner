#!/usr/bin/env node
// 多语言受管生命周期冒烟：隔离 --home + 真实 node/python 进程，验证 start-new → status/logs → stop，
// 以及包装脚本、WindowsApps stub、非法 mode 的拒绝路径。不触碰真实注册表与业务进程。
// 用法：node scripts/test/runtime-smoke.mjs   （无外部依赖，Node 22+；缺 pwsh 7 或 python 时跳过对应检查）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { isWindows, findExecutable, killTree, listDescendants, findProcesses } from './platform.mjs';
import { computeAppId } from '../lib/desc.mjs';
import { psProc } from '../lib/probe.mjs';
import { persistableDiscovery } from '../lib/launch.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-runtime-smoke-'));
const home = path.join(base, 'home');
const projNode = path.join(base, 'node-app');
const projPy = path.join(base, 'py-app');
const projUm = path.join(base, 'um-app');
const projCmd = path.join(base, 'cmd-app');
const projAmb = path.join(base, 'amb-app');
const projNpm = path.join(base, 'npm-app');
const CMD_SENTINEL = 'PR_SMOKE_SENTINEL_DB_PASSWORD_e7c1f4a9';
for (const d of [projNode, projPy, projUm, projCmd, projAmb, projNpm]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(path.join(projNode, 'srv.js'),
  'console.log("node-ready PORT=" + (process.env.PORT ?? "<unset>"));\nsetInterval(() => {}, 1000);\n', 'utf8');
// #50 回归：detached 链路下多行 stdout 是否完整（内建/复合命令同样经过 pipe）
fs.writeFileSync(path.join(projNode, 'multi.js'),
  "console.log('multi-line-1');\nconsole.log('multi-line-2');\nconsole.log('multi-line-3');\nsetInterval(() => {}, 1000);\n", 'utf8');
fs.writeFileSync(path.join(projCmd, 'srv.js'),
  'console.log("cmd-ready");\nsetInterval(() => {}, 1000);\n', 'utf8');
fs.writeFileSync(path.join(projAmb, 'srv.js'),
  'console.log("amb-ready");\nsetInterval(() => {}, 1000);\n', 'utf8');
// 自身再 spawn 一个 node 子进程 → wrapper 后代中稳定出现 2 个 node.exe，用于歧义拒绝
fs.writeFileSync(path.join(projAmb, 'two.js'),
  'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1e3)"],{stdio:"ignore"});\nsetInterval(() => {}, 1000);\n', 'utf8');
// #39 --tree 验收：命令模式目标 node 在发现 settle 之后 spawn 第二个 node 后代。
// 默认 stop 应留后代存活；stop --tree 应两代都退出。延迟 spawn 避免被 discover 当成候选。
fs.writeFileSync(path.join(projCmd, 'tree-parent.js'),
  'const{spawn}=require("node:child_process");\n'
  + 'console.log("tree-parent-ready");\n'
  + 'setTimeout(()=>{const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});c.unref();console.log("tree-child="+c.pid);},4000);\n'
  + 'setInterval(()=>{},1000);\n', 'utf8');
fs.writeFileSync(path.join(projPy, 'srv.py'),
  'import time\nprint("py-ready", flush=True)\nwhile True:\n    time.sleep(1)\n', 'utf8');
// npm run dev 回归：npm 自身也是 node，与真实目标同映像且构成单链 wrapper→npm→srv；
// 叶子折叠后应托管 srv 而不是歧义拒绝。
fs.writeFileSync(path.join(projNpm, 'package.json'), JSON.stringify({ name: 'pr-npm-smoke', scripts: { dev: 'node srv.js' } }), 'utf8');
fs.writeFileSync(path.join(projNpm, 'srv.js'),
  'console.log("npm-srv-ready");\nsetInterval(() => {}, 1000);\n', 'utf8');
// 端口诊断回归：受管 node 监听固定端口，port 命令应给出同一 pid 与完整身份
fs.writeFileSync(path.join(projNpm, 'lsn.js'),
  'require("node:http").createServer((q, s) => s.end("ok")).listen(process.env.PORT || 18123, "127.0.0.1", () => console.log("lsn-ready"));\n', 'utf8');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (...args) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', home, '--json', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout || ''); } catch { /* 保留原始输出 */ }
  return { code: r.status, json, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const descFile = (d) => {
  const f = path.join(base, `desc-${d.alias}.json`);
  fs.writeFileSync(f, JSON.stringify(d), 'utf8');
  return f;
};
const logHas = async (file, needle) => {
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(needle)) return true;
    await wait(500);
  }
  return false;
};
const waitChildPid = async (file) => {
  for (let i = 0; i < 40; i++) {
    try {
      const m = /tree-child=(\d+)/.exec(fs.readFileSync(file, 'utf8'));
      if (m) return Number(m[1]);
    } catch { /* 日志尚未落盘 */ }
    await wait(500);
  }
  return null;
};

let failed = 0;
let skipped = false;
let strayWrapperPids = []; // 歧义/超时场景残留的命令模式 wrapper，兜底清理
const strayPids = [];      // 当时仍在的后代进程（wrapper 可能先死，按 PID 定位更可靠）
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) {
    if (e.code === 'PR_SKIP') { skipped = true; console.log(`  skip ${name}: ${e.message}`); return; }
    failed++; console.log(`  FAIL ${name}: ${e.message}`);
  }
};
const skip = (why) => { const e = new Error(why); e.code = 'PR_SKIP'; throw e; };
// pwsh 缺失时 start-new 会在锁内失败（exit 4/PWSH_MISSING），统一判定；Linux 不应出现。
const pwshMissing = (r) => isWindows && (r.code === 4 || (r.json?.error?.code === 'PWSH_MISSING'));

// ---- 预检：python 是否可用（Windows 可能有 WindowsApps stub；Linux 回退 python3） ----
const NODE_IMAGE = isWindows ? 'node.exe' : 'node';
const isWinAppsAlias = (p) => {
  if (!isWindows || !/\\Microsoft\\WindowsApps\\/i.test(p)) return false;
  try { const s = fs.lstatSync(p); return s.size === 0 || s.isSymbolicLink(); } catch { return false; }
};
const pyCandidates = isWindows
  ? (() => {
    const r = spawnSync('where', ['python'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return r.status === 0 ? r.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  })()
  : [];
const pyReal = isWindows
  ? pyCandidates.find((p) => !isWinAppsAlias(p))
  : (findExecutable('python') ?? findExecutable('python3'));
const winAppsStub = isWindows ? pyCandidates.find(isWinAppsAlias) : null;

try {
  await check('appId 遵循平台路径大小写语义', () => {
    const upper = computeAppId('/tmp/Project', 'Main');
    const lower = computeAppId('/tmp/project', 'main');
    assert.equal(upper === lower, isWindows);
  });
  await check('discovery 候选持久化投影：丢弃原始 cmd，仅保留身份与长度/摘要', () => {
    const raw = {
      result: 'error', code: 'cimFailed',
      candidates: [{ pid: 1, image: '/usr/bin/node', comm: 'node', creationFileTime: 'boot:1', cmd: `node --db-password=${CMD_SENTINEL}` }],
    };
    const projected = persistableDiscovery(raw);
    assert.equal(projected.code, 'cimFailed');
    assert.equal(projected.candidates[0].pid, 1);
    assert.equal(projected.candidates[0].image, '/usr/bin/node');
    assert.equal(projected.candidates[0].comm, 'node');
    assert.equal(projected.candidates[0].cmd, undefined, '投影仍保留原始 cmd');
    assert.equal(projected.candidates[0].cmdLength, raw.candidates[0].cmd.length);
    assert.match(projected.candidates[0].cmdHash, /^[0-9a-f]{16}$/);
    assert(!JSON.stringify(projected).includes(CMD_SENTINEL), '投影仍包含哨兵原文');
  });
  if (process.platform === 'linux') {
    await check('Linux pidfd 终止在身份不匹配时拒绝发送信号', () => {
      const r = psProc('terminate', { id: process.pid, creationFileTime: 'wrong-boot:0', image: '/wrong/image' });
      assert.equal(r.result, 'mismatch');
    });
  }

  // ---------- node 受管生命周期 ----------
  let nodeRunId = null;
  await check('node start-new 持久化 env，desc 值覆盖当前进程环境', () => {
    const previousPort = process.env.PORT;
    process.env.PORT = '9999';
    let r;
    try {
      r = cli('start-new', '--desc', descFile({
        alias: 'nodeapp', root: projNode, mode: 'node', exe: 'node', args: ['srv.js'], env: { PORT: '3001' }, expectedPort: null,
      }));
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.status, 'RUNNING');
    assert.equal(r.json.data.mode, 'node');
    nodeRunId = r.json.data.runId;
  });
  if (nodeRunId) {
    await check('node 日志出现就绪标记与 desc 环境值', async () => {
      const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${cli('status', 'nodeapp').json.data.appId}.json`), 'utf8'));
      assert(await logHas(rt.current.logPaths.stdout, 'node-ready PORT=3001'), 'stdout 未见 PORT=3001');
      const reg = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
      assert.equal(Object.values(reg.apps)[0].env.PORT, '3001');
    });
    await check('node status=RUNNING 且 logs 可读', () => {
      const s = cli('status', 'nodeapp');
      assert.equal(s.json.data.status, 'RUNNING');
      assert.equal(s.json.data.run.managed, true);
      const l = cli('logs', 'nodeapp', '--lines', '50');
      assert.equal(l.code, 0, l.text);
    });
    await check('node stop → STOPPED，进程确已退出', () => {
      const r = cli('stop', 'nodeapp');
      assert.equal(r.code, 0, r.text);
      assert.equal(cli('status', 'nodeapp').json.data.status, 'STOPPED');
    });
    await check('跨 node 进程 start 在 PORT 未设置时仍传递持久化值', async () => {
      const childEnv = { ...process.env };
      delete childEnv.PORT;
      const start = spawnSync(process.execPath, [MANAGER, '--home', home, '--json', 'start', 'nodeapp'],
        { encoding: 'utf8', windowsHide: true, timeout: 60000, env: childEnv });
      assert.equal(start.status, 0, `${start.stdout}${start.stderr}`);
      assert.equal(cli('status', 'nodeapp').json.data.env.PORT, '3001');
      const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${cli('status', 'nodeapp').json.data.appId}.json`), 'utf8'));
      assert(await logHas(rt.current.logPaths.stdout, 'node-ready PORT=3001'), '跨进程 start 未见 PORT=3001');
      assert.equal(cli('stop', 'nodeapp').code, 0);
    });
    await check('node restart 复用配置再启动 → 再停', () => {
      const r = cli('restart', 'nodeapp');
      assert.equal(r.code, 0, r.text);
      assert.equal(cli('status', 'nodeapp').json.data.status, 'RUNNING');
      assert.equal(cli('stop', 'nodeapp').code, 0);
    });
  }

  // ---------- python 受管生命周期 ----------
  await check('python start-new 受管启动（Windows 跳过 WindowsApps stub；Linux 用真实解释器）', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    if (!pyReal) skip('PATH 中无真实 python');
    const r = cli('start-new', '--desc', descFile({
      alias: 'pyapp', root: projPy, mode: 'python', exe: isWindows ? 'python' : pyReal, args: ['srv.py'],
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.mode, 'python');
    const appId = r.json.data.appId;
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${appId}.json`), 'utf8'));
    assert(await logHas(rt.current.logPaths.stdout, 'py-ready'), 'stdout 未见 py-ready');
    assert.equal(cli('status', 'pyapp').json.data.status, 'RUNNING');
    assert.equal(cli('stop', 'pyapp').code, 0);
    assert.equal(cli('status', 'pyapp').json.data.status, 'STOPPED');
  });

  // ---------- 命令模式受管（cmd wrapper + 后代发现） ----------
  let cmdRunId = null;
  await check('command 模式 start-new：cmd wrapper → 后代发现 node → 受管', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdapp', root: projCmd, mode: 'node',
      command: 'node srv.js', expectedImage: NODE_IMAGE,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.status, 'RUNNING');
    assert.equal(r.json.data.kind, 'command');
    assert.ok(r.json.data.wrapperPid > 0, '缺少 wrapperPid 证据');
    cmdRunId = r.json.data.runId;
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${r.json.data.appId}.json`), 'utf8'));
    assert(await logHas(rt.current.logPaths.stdout, 'cmd-ready'), 'stdout 未见 cmd-ready');
    assert.equal(cli('status', 'cmdapp').json.data.status, 'RUNNING');
    assert.equal(cli('status', 'cmdapp').json.data.run.kind, 'command');
    assert.equal(cli('stop', 'cmdapp').code, 0);
    assert.equal(cli('status', 'cmdapp').json.data.status, 'STOPPED');
    // restart 复用 command 配置：重放命令+重新发现
    assert.equal(cli('restart', 'cmdapp').code, 0);
    assert.equal(cli('status', 'cmdapp').json.data.status, 'RUNNING');
    assert.equal(cli('stop', 'cmdapp').code, 0);
  });
  await check('command 模式歧义拒绝：多候选 DISCOVERY_AMBIGUOUS 不任选', () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdamb', root: projAmb, entry: 'amb', mode: 'node',
      command: `node two.js --db-password=${CMD_SENTINEL}`, expectedImage: NODE_IMAGE, discoverTimeoutMs: 15000,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    for (const c of (r.json.error?.detail?.candidates ?? [])) strayPids.push(c.pid);
    strayWrapperPids.push(r.json.error?.detail?.wrapperPid ?? r.json.data?.wrapperPid ?? 0);
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'DISCOVERY_AMBIGUOUS');
    const s = cli('status', 'cmdamb');
    assert.equal(s.json.data.status, 'UNKNOWN');
    // 安全回归：命令带哨兵参数，歧义证据的 CLI 输出、status 输出与 runtime JSON 均不得出现原文。
    const runtimeRaw = fs.readFileSync(path.join(home, 'runtime', `${s.json.data.appId}.json`), 'utf8');
    for (const [label, text] of [['CLI', r.text], ['status', s.text], ['runtime JSON', runtimeRaw]]) {
      assert(!text.includes(CMD_SENTINEL), `${label} 泄露候选命令行原文`);
    }
    const candidates = r.json.error.detail.candidates;
    assert(candidates.length >= 2, '歧义候选数不足，无法验证投影');
    for (const c of candidates) {
      assert.equal(c.cmd, undefined, 'CLI 候选仍携带原始 cmd');
      assert.equal(typeof c.cmdLength, 'number', '候选缺少 cmdLength 证据');
      assert.match(c.cmdHash, /^[0-9a-f]{16}$/, '候选缺少 cmdHash 证据');
    }
    const persisted = JSON.parse(runtimeRaw).current.lastError;
    assert(!/"cmd"\s*:/.test(persisted), `runtime lastError 仍含原始 cmd：${persisted}`);
  });
  await check('cleanup-wrapper 清理歧义残留 wrapper，UNKNOWN 证据保留', () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('cleanup-wrapper', 'cmdamb');
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert(['terminated', 'exited', 'notfound', 'mismatch'].includes(r.json.data.result), r.text);
    const s = cli('status', 'cmdamb').json.data;
    assert.equal(s.status, 'UNKNOWN');
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${s.appId}.json`), 'utf8'));
    assert.equal(rt.current.wrapperCleaned, true);
  });
  await check('command 模式发现超时：DISCOVERY_TIMEOUT 留证 UNKNOWN', () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdtmo', root: projAmb, entry: 'tmo', mode: 'node',
      command: isWindows ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 30', expectedImage: NODE_IMAGE, discoverTimeoutMs: 5000,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    const tmoWrapper = r.json.error?.detail?.wrapperPid ?? 0;
    strayWrapperPids.push(tmoWrapper);
    // 超时场景没有 candidates：枚举 wrapper 当时仍在的后代作为兜底证据（#46）
    if (tmoWrapper) for (const pid of listDescendants(tmoWrapper)) strayPids.push(pid);
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'DISCOVERY_TIMEOUT');
  });
  await check('command 模式命令即死：wrapperExited → SPAWN_FAILED（可重试）', () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdfail', root: projAmb, entry: 'fail', mode: 'node',
      command: 'node missing-module-for-runtime-smoke.js', expectedImage: NODE_IMAGE, discoverTimeoutMs: 5000,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'SPAWN_FAILED');
    assert.match(r.json.error.detail.stderrTail, /Cannot find module/);
    assert.equal(cli('status', 'cmdfail').json.data.status, 'STOPPED');
  });
  await check('command 模式多行 stdout 经 detached 链路完整（#50 回归）', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'mline', root: projNode, mode: 'node', command: 'node multi.js', expectedImage: NODE_IMAGE,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${r.json.data.appId}.json`), 'utf8'));
    assert(await logHas(rt.current.logPaths.stdout, 'multi-line-1'), 'stdout 缺失 multi-line-1');
    assert(await logHas(rt.current.logPaths.stdout, 'multi-line-3'), 'stdout 缺失 multi-line-3');
    assert.equal(cli('stop', 'mline').code, 0);
  });
  // 回归：npm 与目标同映像（node）且构成单链，叶子折叠后应托管真实目标而非 DISCOVERY_AMBIGUOUS
  await check('command 模式 npm run dev：同映像单链折叠到真实目标', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    if (!findExecutable('npm')) skip('PATH 无 npm');
    const r = cli('start-new', '--desc', descFile({
      alias: 'npmdev', root: projNpm, mode: 'node', command: 'npm run dev', expectedImage: NODE_IMAGE, discoverTimeoutMs: 30000,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    // 失败也先留证：wrapper 与候选进程交给 finally 兑底清理，避免残留孤儿
    if (r.code !== 0) {
      strayWrapperPids.push(r.json.error?.detail?.wrapperPid ?? 0);
      for (const c of (r.json.error?.detail?.candidates ?? [])) strayPids.push(c.pid);
    }
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.status, 'RUNNING');
    assert.equal(r.json.data.kind, 'command');
    const appId = r.json.data.appId;
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${appId}.json`), 'utf8'));
    assert(await logHas(rt.current.logPaths.stdout, 'npm-srv-ready'), 'stdout 未见 npm-srv-ready');
    // 托管的必须是 srv.js 目标而非 npm-cli 本身：pid 有身份且映像为 node
    assert(rt.current.creationFileTime && rt.current.image, '目标身份证据缺失');
    assert.match(rt.current.image.replace(/\\/g, '/'), /node(\.exe)?$/, '托管目标映像不是 node');
    assert.notEqual(rt.current.pid, rt.current.wrapperPid, '托管了 wrapper 自身');
    const stopR = cli('stop', 'npmdev', '--tree'); // --tree 连带终止残留的 npm-cli 进程
    assert.equal(stopR.code, 0, stopR.text);
    assert.equal(cli('status', 'npmdev').json.data.status, 'STOPPED');
  });
  // ---------- stop --tree：命令模式 node 目标 + node 后代（#39） ----------
  await check('默认 stop 不触碰目标后代（存活留证）', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdtree', root: projCmd, entry: 'tree', mode: 'node',
      command: 'node tree-parent.js', expectedImage: NODE_IMAGE,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${r.json.data.appId}.json`), 'utf8'));
    const childPid = await waitChildPid(rt.current.logPaths.stdout);
    assert(childPid, '未从 stdout 日志读到 tree-child pid');
    strayPids.push(childPid);
    const childId = psProc('capture', { id: childPid });
    assert.equal(childId.result, 'ok', `后代未存活：${JSON.stringify(childId)}`);
    const stop = cli('stop', 'cmdtree');
    assert.equal(stop.code, 0, stop.text);
    assert.equal(stop.json.data.result, 'stopped');
    assert.ok(!stop.json.data.treeKilled?.length, '不带 --tree 不应返回 treeKilled 证据');
    const cap = psProc('capture', { id: childPid });
    assert.equal(cap.result, 'ok', `不带 --tree 时后代被误杀：${JSON.stringify(cap)}`);
    assert.equal(cli('status', 'cmdtree').json.data.status, 'STOPPED');
    // 清理这一轮的后代，避免影响下一场景；按采集到的身份同句柄终止。
    const cleaned = psProc('terminate', { id: childPid, creationFileTime: childId.creationFileTime, image: childId.image });
    assert(['terminated', 'notfound', 'exited'].includes(cleaned.result), `后代清理失败：${JSON.stringify(cleaned)}`);
  });
  await check('stop --tree 连带终止目标与后代两代并留证', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const rr = cli('restart', 'cmdtree');
    assert.equal(rr.code, 0, rr.text);
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${rr.json.data.appId}.json`), 'utf8'));
    const childPid = await waitChildPid(rt.current.logPaths.stdout);
    assert(childPid, '重启后未从 stdout 日志读到 tree-child pid');
    strayPids.push(childPid);
    const childId = psProc('capture', { id: childPid });
    assert.equal(childId.result, 'ok', `重启后后代未存活：${JSON.stringify(childId)}`);
    const targetPid = rr.json.data.start.pid;
    const stop = cli('stop', 'cmdtree', '--tree');
    assert.equal(stop.code, 0, stop.text);
    const killed = stop.json.data.treeKilled ?? [];
    const entry = killed.find((k) => k.pid === childPid);
    assert(entry, `treeKilled 未包含后代 ${childPid}：${JSON.stringify(stop.json.data)}`);
    assert(entry.image, 'treeKilled 缺少后代映像证据');
    for (const [label, pid] of [['目标', targetPid], ['后代', childPid]]) {
      const cap = psProc('capture', { id: pid });
      assert(cap.result === 'notfound' || cap.result === 'exited', `${label} ${pid} 仍存活：${JSON.stringify(cap)}`);
    }
    assert.equal(cli('status', 'cmdtree').json.data.status, 'STOPPED');
  });
  // 回归：port 诊断单次调用给出占用者完整身份（与 capture 同源 image）
  await check('port 诊断：受管监听进程的 pid/身份与 status 一致', async () => {
    if (!nodeRunId && skipped) skip('pwsh 缺失已跳过');
    const PORT = 18123;
    const pre = cli('port', String(PORT));
    if (pre.code === 0 && pre.json?.data?.occupants?.length) skip(`端口 ${PORT} 已被占用`);
    const r = cli('start-new', '--desc', descFile({
      alias: 'portapp', root: projNpm, entry: 'lsn', mode: 'node', exe: 'node', args: ['lsn.js'], env: { PORT: String(PORT) }, expectedPort: PORT,
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    const st = cli('status', 'portapp').json.data;
    const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime', `${st.appId}.json`), 'utf8'));
    assert(await logHas(rt.current.logPaths.stdout, 'lsn-ready'), 'stdout 未见 lsn-ready');
    const p = cli('port', String(PORT));
    assert.equal(p.code, 0, p.text);
    const occ = (p.json.data.occupants ?? []).find((o) => o.pid === st.run.pid);
    assert(occ, `port 未报告受管 pid=${st.run.pid}：${JSON.stringify(p.json.data.occupants)}`);
    assert.equal(occ.identity?.result, 'ok', `身份采集失败：${JSON.stringify(occ)}`);
    assert(occ.executablePath, '缺少 executablePath');
    assert.match(occ.executablePath.replace(/\\/g, '/'), /node(\.exe)?$/);
    assert.equal(cli('stop', 'portapp').code, 0);
  });
  await check('desc 校验：command 缺 expectedImage / 与 exe 混填均拒绝', () => {
    const r1 = cli('start-new', '--desc', descFile({
      alias: 'nocmd', root: projAmb, mode: 'node', command: 'node srv.js',
    }));
    assert.equal(r1.code, 1, r1.text);
    const r2 = cli('start-new', '--desc', descFile({
      alias: 'both', root: projAmb, mode: 'node', exe: 'node', command: 'node srv.js', expectedImage: NODE_IMAGE,
    }));
    assert.equal(r2.code, 1, r2.text);
  });

  // ---------- 拒绝路径 ----------
  await check('非法 env 键名或非字符串值拒绝（USAGE 退出码 1）', () => {
    for (const env of [{ 'BAD-NAME': 'x' }, { PORT: 3001 }]) {
      const r = cli('start-new', '--desc', descFile({
        alias: `badenv${Object.keys(env)[0].length}`, root: projNode, mode: 'node', exe: 'node', args: ['srv.js'], env,
      }));
      assert.equal(r.code, 1, r.text);
    }
  });
  await check('非法 mode 拒绝（USAGE 退出码 1）', () => {
    const r = cli('start-new', '--desc', descFile({
      alias: 'badmode', root: projNode, mode: 'jvm', exe: 'node', args: ['srv.js'],
    }));
    assert.equal(r.code, 1, r.text);
    assert(r.json.error.message.includes('mode'));
  });
  await check('npm 裸名拒绝（仅 .cmd/无扩展包装候选，CONFIG_INVALID 退出码 3）', () => {
    if (!findExecutable('npm')) skip('无 npm');
    const r = cli('start-new', '--desc', descFile({
      alias: 'npmbad', root: projNode, mode: 'node', exe: 'npm', args: ['run', 'dev'],
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'CONFIG_INVALID');
  });
  await check(isWindows ? 'exe 直接指向 .cmd 拒绝' : 'exe 直接指向 #! 脚本拒绝', () => {
    const fake = path.join(base, isWindows ? 'fake.cmd' : 'fake.sh');
    fs.writeFileSync(fake, isWindows ? '@echo off\r\n' : '#!/bin/sh\necho hi\n');
    if (!isWindows) fs.chmodSync(fake, 0o755);
    const r = cli('start-new', '--desc', descFile({
      alias: 'cmdbad', root: projNode, mode: 'proc', exe: fake, args: [],
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'CONFIG_INVALID');
  });
  await check('WindowsApps 0 字节 stub 路径拒绝', () => {
    if (!isWindows) skip('仅 Windows 有 WindowsApps 执行别名');
    if (!winAppsStub) skip('本机无 WindowsApps python stub');
    const r = cli('start-new', '--desc', descFile({
      alias: 'stubbad', root: projPy, mode: 'python', exe: winAppsStub, args: ['srv.py'],
    }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'CONFIG_INVALID');
    assert(r.json.error.message.includes('WindowsApps'));
  });
  await check('record-unmanaged 登记非受管记录并保留 mode', () => {
    const r = cli('record-unmanaged', '--desc', descFile({
      alias: 'pyum', root: projUm, mode: 'python',
    }), '--log-hints', path.join(projUm, '.tmp', 'runner-local-x.stdout.log'));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 0, r.text);
    assert.equal(r.json.data.managed, false);
    const s = cli('status', 'pyum');
    assert.equal(s.json.data.mode, 'python');
  });
  await check('record-unmanaged 同 appId 已有受管登记时拒绝，--force 才覆盖', () => {
    if (!nodeRunId) skip('无受管登记可构造冲突');
    const r = cli('record-unmanaged', '--desc', descFile({ alias: 'dup', root: projNode, mode: 'node' }));
    if (pwshMissing(r)) skip('缺 pwsh 7');
    assert.equal(r.code, 3, r.text);
    assert.equal(r.json.error.code, 'ALREADY_REGISTERED');
    const f = cli('record-unmanaged', '--desc', descFile({ alias: 'dup2', root: projNode, mode: 'node' }), '--force');
    assert.equal(f.code, 0, f.text);
    assert.equal(f.json.data.replacedManaged, true);
  });
  await check('list 汇总有真实 mode 展示', () => {
    if (!nodeRunId) skip('无受管实例');
    const r = cli('list');
    assert.equal(r.code, 0, r.text);
    assert(r.json.data.apps.some((a) => a.mode === 'node'));
  });
} finally {
  // 兜底：按当时仍在的后代 PID 清理，不只依赖 wrapper PID（wrapper 可能先死，#46）
  for (const a of ['nodeapp', 'pyapp', 'cmdapp', 'mline', 'npmdev', 'portapp', 'cmdtree', 'cmdamb', 'cmdtmo', 'cmdfail']) {
    try { cli('stop', a, '--tree'); } catch { /* 忽略 */ }
  }
  const cleanupFailures = [];
  for (const p of [...strayWrapperPids, ...strayPids].filter(Boolean)) {
    if (!killTree(p)) cleanupFailures.push(p); // 多数情况是 wrapper 先死；最终由下方残留断言判定
  }
  if (cleanupFailures.length) console.log(`  note 清理未命中（进程可能已退出）：${cleanupFailures.join(', ')}`);
  // 进程退出后句柄释放需要一点时间：轮询删除，仍失败则显式报告（不静默）
  let removed = false;
  for (let i = 0; i < 20 && !removed; i++) {
    try { fs.rmSync(base, { recursive: true, force: true }); removed = true; }
    catch { await wait(100); }
  }
  if (!removed) {
    failed++;
    console.log(`  FAIL 临时目录未能清理：${base}（进程可能仍占用句柄）`);
  }
  // 回归断言：本轮启动的临时进程都已退出（kill 后进程退出需要一点时间，轮询等待）
  let leftover = [];
  for (let i = 0; i < 20; i++) {
    leftover = findProcesses('two\\.js|srv\\.js|multi\\.js|lsn\\.js|npm-cli\\.js run dev|setInterval|sleep 30').filter((pid) => pid !== process.pid);
    if (!leftover.length) break;
    await wait(250);
  }
  if (leftover.length) {
    failed++;
    console.log(`  FAIL 残留进程未退出：${leftover.join(', ')}`);
  }
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nruntime smoke ok');
