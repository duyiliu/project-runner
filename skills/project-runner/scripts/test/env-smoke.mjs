#!/usr/bin/env node
// 环境契约冒烟：envRefs 启动前校验、envFile 注入不落盘、status/UI 脱敏。
// 用法：node scripts/test/env-smoke.mjs（隔离 --home；核验类断言缺进程探针时跳过）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { hasProcessProbe, isWindows } from './platform.mjs';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-env-smoke-'));
const proj = path.join(base, 'proj');
fs.mkdirSync(proj, { recursive: true });
const root = fs.realpathSync(proj);

const runAt = (home, args, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [MANAGER, '--home', home, '--json', ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 非 JSON（崩溃或文本模式） */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json: parsed };
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFile = (file, timeoutMs = 8000) => {
  for (let i = 0; i < timeoutMs / 100; i++) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return true;
    sleep(100);
  }
  return false;
};

let failed = 0;
const skipped = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};
const skipWithoutProbe = (name, fn) => {
  if (!hasProcessProbe()) {
    skipped.push(name);
    console.log(`  skip  ${name}（缺进程探针）`);
    return;
  }
  check(name, fn);
};

const cleanup = [];
const hasPwsh = hasProcessProbe();
if (!hasPwsh) console.log(`（未检测到进程探针 ${isWindows ? 'pwsh 7' : '/proc'}：本次仅执行不依赖核验的断言）`);

try {
  // 1) 缺失 envRefs：一次性列出全部名称，且在注册/日志/运行记录落盘前失败。
  const missingHome = path.join(base, 'missing-home');
  const suffix = process.pid.toString(36).toUpperCase();
  const missing = [`PR_SMOKE_MISSING_ALPHA_${suffix}`, `PR_SMOKE_MISSING_BETA_${suffix}`];
  const missingDesc = path.join(base, 'desc-missing.json');
  fs.writeFileSync(missingDesc, JSON.stringify({
    alias: 'env-smoke-missing', root, entry: 'missing', mode: 'node',
    exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'],
    envRefs: missing,
  }));
  check('缺失 envRefs：ENV_MISSING 且错误包含全部缺失名称', () => {
    const r = runAt(missingHome, ['start-new', '--desc', missingDesc]);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.error?.code, 'ENV_MISSING');
    for (const name of missing) assert(r.json.error.message.includes(name), `错误未包含 ${name}：${r.json.error.message}`);
  });
  check('缺失 envRefs：拒绝带病启动，不写注册表/运行记录/日志', () => {
    assert.equal(fs.existsSync(path.join(missingHome, 'registry.json')), false, '不应写入注册表');
    const runtimeDir = path.join(missingHome, 'runtime');
    assert(!fs.existsSync(runtimeDir) || fs.readdirSync(runtimeDir).length === 0, '不应写运行记录');
    const logsDir = path.join(missingHome, 'logs');
    assert(!fs.existsSync(logsDir) || fs.readdirSync(logsDir).length === 0, '不应创建运行日志');
  });

  const badFileDesc = path.join(base, 'desc-bad-envfile.json');
  fs.writeFileSync(badFileDesc, JSON.stringify({
    alias: 'env-smoke-bad-envfile', root, entry: 'bad-envfile', mode: 'node',
    exe: process.execPath, args: ['-e', 'setInterval(() => {}, 500)'],
    envFile: path.join(base, 'does-not-exist.env'),
  }));
  check('envFile 不可读：启动前 ENV_FILE_UNREADABLE，不写注册表/运行记录/日志', () => {
    const r = runAt(missingHome, ['start-new', '--desc', badFileDesc]);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(r.json?.error?.code, 'ENV_FILE_UNREADABLE');
    assert(r.json.error.message.includes('does-not-exist.env'), '错误未给出 envFile 路径');
    assert.equal(fs.existsSync(path.join(missingHome, 'registry.json')), false, '不应写入注册表');
    const runtimeDir = path.join(missingHome, 'runtime');
    assert(!fs.existsSync(runtimeDir) || fs.readdirSync(runtimeDir).length === 0, '不应写运行记录');
    const logsDir = path.join(missingHome, 'logs');
    assert(!fs.existsSync(logsDir) || fs.readdirSync(logsDir).length === 0, '不应创建运行日志');
  });

  // 2) envFile 注入 + 敏感名脱敏 + envFile 值不落 registry/runtime/status。
  const home = path.join(base, 'home');
  const probeOut = path.join(base, 'probe.json');
  const probeScript = path.join(root, 'probe.js');
  fs.writeFileSync(probeScript, [
    "const fs=require('fs');",
    "fs.writeFileSync(process.argv[2], JSON.stringify({",
    '  token: process.env.PR_SMOKE_ENVFILE_TOKEN,',
    '  plain: process.env.PR_SMOKE_ENVFILE_PLAIN,',
    '  password: process.env.PR_SMOKE_LITERAL_PASSWORD,',
    '  hostRef: process.env.PR_SMOKE_HOST_REF,',
    '  proto: Object.prototype.hasOwnProperty.call(process.env, "__proto__") ? process.env["__proto__"] : "missing",',
    '}));',
    'setInterval(() => {}, 500);',
  ].join('\n'));
  const envFile = path.join(base, 'app.env');
  const fileToken = 'file-token-value-not-persisted';
  const filePlain = 'file-plain-value-not-persisted';
  fs.writeFileSync(envFile, [
    '# envFile smoke',
    `export PR_SMOKE_ENVFILE_TOKEN="${fileToken}" # 行尾注释`,
    `PR_SMOKE_ENVFILE_PLAIN='${filePlain}' # 行尾注释`,
  ].join('\n'));
  const directEnv = { PR_SMOKE_LITERAL_PASSWORD: 'literal-password-value-not-echoed', PR_SMOKE_PLAIN_LITERAL: 'plain-literal-ok', PR_SMOKE_LONG_TEXT: 'x'.repeat(130) };
  // 对象字面量里的 __proto__ 会改原型；测试必须显式建自有属性，才能覆盖合并逻辑。
  Object.defineProperty(directEnv, '__proto__', { value: 'proto-app-value', enumerable: true, writable: true, configurable: true });
  const descFile = path.join(base, 'desc-envfile.json');
  fs.writeFileSync(descFile, JSON.stringify({
    alias: 'env-smoke-envfile', root, entry: 'envfile', mode: 'node',
    exe: process.execPath, args: [probeScript, probeOut],
    envRefs: ['PR_SMOKE_ENVFILE_TOKEN', 'PR_SMOKE_ENVFILE_PLAIN', 'PR_SMOKE_HOST_REF', '__proto__'],
    envFile,
    env: directEnv,
  }, null, 2));
  const hostRef = 'host-ref-value';
  let appId = null;
  cleanup.push({ home, alias: 'env-smoke-envfile' });
  skipWithoutProbe('envFile 注入变量且 envRefs 可由 envFile/宿主环境满足；疑似机密 env 非阻断告警', () => {
    const r = runAt(home, ['start-new', '--desc', descFile], { PR_SMOKE_HOST_REF: hostRef });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json?.ok, true);
    assert.equal(r.json.data.status, 'RUNNING');
    assert(r.json.data.envWarnings?.includes('PR_SMOKE_LITERAL_PASSWORD'), `缺少 env 机密告警：${JSON.stringify(r.json.data)}`);
    assert(r.json.data.envWarning?.includes('envRefs') && r.json.data.envWarning.includes('envFile'), `告警未提示改用 envRefs/envFile：${r.json.data.envWarning}`);
    appId = r.json.data.appId;
    assert(waitFile(probeOut), '目标进程未写出 env 探针文件');
    const got = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
    assert.equal(got.token, fileToken, 'envFile 变量未注入目标进程');
    assert.equal(got.plain, filePlain, 'envFile 普通变量未注入目标进程');
    assert.equal(got.password, 'literal-password-value-not-echoed', 'desc.env 覆盖行为异常');
    assert.equal(got.hostRef, hostRef, '宿主 envRefs 未注入目标进程');
    assert.equal(got.proto, 'proto-app-value', 'desc.env 的 __proto__ 变量丢失或未注入');
  });

  skipWithoutProbe('envFile 值不写入 registry/runtime', () => {
    const regRaw = fs.readFileSync(path.join(home, 'registry.json'), 'utf8');
    const rtRaw = fs.readFileSync(path.join(home, 'runtime', `${appId}.json`), 'utf8');
    const reg = JSON.parse(regRaw);
    assert.equal(reg.apps[appId].envFile, envFile, 'envFile 路径应持久化供跨会话重启');
    for (const value of [fileToken, filePlain]) {
      assert(!regRaw.includes(value), `registry 泄漏 envFile 值：${value}`);
      assert(!rtRaw.includes(value), `runtime 泄漏 envFile 值：${value}`);
    }
  });

  skipWithoutProbe('status 对敏感 env 名显示 ***，非敏感 env 保持原行为，envFile 值不出现', () => {
    const r = runAt(home, ['status', 'env-smoke-envfile']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.data.env.PR_SMOKE_LITERAL_PASSWORD, '***');
    assert.equal(r.json.data.env.PR_SMOKE_PLAIN_LITERAL, 'plain-literal-ok');
    assert.equal(r.json.data.env.PR_SMOKE_LONG_TEXT, `${'x'.repeat(120)}… (截断)`, '非敏感 env 的既有截断行为改变');
    assert(r.json.data.run.envResolved.includes('PR_SMOKE_ENVFILE_TOKEN'), 'envRefs 应只回显名称');
    const text = JSON.stringify(r.json.data);
    assert(!text.includes('literal-password-value-not-echoed'), 'status 回显了敏感 env 值');
    assert(!text.includes(fileToken) && !text.includes(filePlain), 'status 回显了 envFile 值');
  });

  skipWithoutProbe('restart 环境预检失败不停止旧实例、不改写运行证据与注册表', () => {
    const rtFile = path.join(home, 'runtime', `${appId}.json`);
    const regFile = path.join(home, 'registry.json');
    const rtBefore = fs.readFileSync(rtFile, 'utf8');
    const original = JSON.parse(fs.readFileSync(regFile, 'utf8')).apps[appId];
    const readReg = () => JSON.parse(fs.readFileSync(regFile, 'utf8'));
    const writeReg = (reg) => fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));
    const assertStillRunning = () => {
      const st = runAt(home, ['status', 'env-smoke-envfile']);
      assert.equal(st.code, 0, st.stdout + st.stderr);
      assert.equal(st.json.data.status, 'RUNNING', '旧实例被停止或状态被改写');
      assert.equal(st.json.data.run.runId, JSON.parse(rtBefore).current.runId);
    };

    try {
      const missingRef = 'PR_SMOKE_RESTART_MISSING';
      const reg1 = readReg();
      reg1.apps[appId].envRefs = [...(original.envRefs ?? []), missingRef];
      writeReg(reg1);
      const regBefore = fs.readFileSync(regFile, 'utf8');
      const r = runAt(home, ['restart', 'env-smoke-envfile']);
      assert.equal(r.code, 3, r.stdout + r.stderr);
      assert.equal(r.json.error.code, 'ENV_MISSING');
      assert(r.json.error.message.includes(missingRef), 'restart ENV_MISSING 未列出缺失名称');
      assert.equal(fs.readFileSync(rtFile, 'utf8'), rtBefore, 'restart 预检失败改写了运行记录');
      assert.equal(fs.readFileSync(regFile, 'utf8'), regBefore, 'restart 预检失败改写了注册表');
      assertStillRunning();
    } finally {
      const restore = readReg();
      restore.apps[appId].envRefs = original.envRefs;
      writeReg(restore);
    }

    try {
      const reg2 = readReg();
      reg2.apps[appId].envFile = path.join(base, 'missing-restart.env');
      writeReg(reg2);
      const regBefore = fs.readFileSync(regFile, 'utf8');
      const r = runAt(home, ['restart', 'env-smoke-envfile']);
      assert.equal(r.code, 3, r.stdout + r.stderr);
      assert.equal(r.json.error.code, 'ENV_FILE_UNREADABLE');
      assert.equal(fs.readFileSync(rtFile, 'utf8'), rtBefore, 'envFile 预检失败改写了运行记录');
      assert.equal(fs.readFileSync(regFile, 'utf8'), regBefore, 'envFile 预检失败改写了注册表');
      assertStillRunning();
    } finally {
      const restore = readReg();
      restore.apps[appId].envFile = original.envFile;
      writeReg(restore);
    }
  });

  skipWithoutProbe('start 环境预检失败：ENV_MISSING/ENV_FILE_UNREADABLE 且不产生新运行副作用', () => {
    const regFile = path.join(home, 'registry.json');
    const rtFile = path.join(home, 'runtime', `${appId}.json`);
    const logsDir = path.join(home, 'logs', appId);
    const readReg = () => JSON.parse(fs.readFileSync(regFile, 'utf8'));
    const writeReg = (reg) => fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));
    const original = readReg().apps[appId];
    const stopped = runAt(home, ['stop', 'env-smoke-envfile']);
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
    const rtBefore = fs.readFileSync(rtFile, 'utf8');
    const logsBefore = fs.readdirSync(logsDir).sort();
    const assertNoSideEffects = (regBefore, extra = {}) => {
      assert.equal(fs.readFileSync(rtFile, 'utf8'), rtBefore, '启动失败改写了运行记录');
      assert.equal(fs.readFileSync(regFile, 'utf8'), regBefore, '启动失败改写了注册表');
      assert.deepEqual(fs.readdirSync(logsDir).sort(), logsBefore, '启动失败创建了新日志批次');
      const st = runAt(home, ['status', 'env-smoke-envfile'], extra);
      assert.equal(st.code, 0, st.stdout + st.stderr);
      assert.equal(st.json.data.status, 'STOPPED');
      assert.equal(st.json.data.run.runId, JSON.parse(rtBefore).current.runId);
    };

    try {
      const startMissing = [`PR_SMOKE_START_MISSING_A_${suffix}`, `PR_SMOKE_START_MISSING_B_${suffix}`];
      const reg1 = readReg();
      reg1.apps[appId].envRefs = [...(original.envRefs ?? []), ...startMissing];
      writeReg(reg1);
      const regBefore = fs.readFileSync(regFile, 'utf8');
      const r = runAt(home, ['start', 'env-smoke-envfile'], { PR_SMOKE_HOST_REF: hostRef });
      assert.equal(r.code, 3, r.stdout + r.stderr);
      assert.equal(r.json.error.code, 'ENV_MISSING');
      for (const name of startMissing) assert(r.json.error.message.includes(name), `start ENV_MISSING 未列出 ${name}`);
      assertNoSideEffects(regBefore, { PR_SMOKE_HOST_REF: hostRef });
    } finally {
      const restore = readReg();
      restore.apps[appId].envRefs = original.envRefs;
      writeReg(restore);
    }

    try {
      const reg2 = readReg();
      reg2.apps[appId].envFile = path.join(base, 'missing-start.env');
      writeReg(reg2);
      const regBefore = fs.readFileSync(regFile, 'utf8');
      const r = runAt(home, ['start', 'env-smoke-envfile'], { PR_SMOKE_HOST_REF: hostRef });
      assert.equal(r.code, 3, r.stdout + r.stderr);
      assert.equal(r.json.error.code, 'ENV_FILE_UNREADABLE');
      assertNoSideEffects(regBefore, { PR_SMOKE_HOST_REF: hostRef });
    } finally {
      const restore = readReg();
      restore.apps[appId].envFile = original.envFile;
      writeReg(restore);
    }
  });

  skipWithoutProbe('命令模式同样注入 envFile/envRefs 与环境字面值', () => {
    const cmdHome = path.join(base, 'cmd-home');
    const cmdOut = path.join(base, 'cmd-probe.json');
    const cmdScript = path.join(root, 'cmd-probe.js');
    const cmdEnvFile = path.join(base, 'cmd.env');
    const cmdToken = 'cmd-file-token-not-persisted';
    fs.writeFileSync(cmdScript, [
      "const fs=require('fs');",
      'fs.writeFileSync(process.argv[2], JSON.stringify({',
      '  token: process.env.PR_SMOKE_CMD_TOKEN,',
      '  plain: process.env.PR_SMOKE_CMD_PLAIN,',
      '  proto: Object.prototype.hasOwnProperty.call(process.env, "__proto__") ? process.env["__proto__"] : "missing",',
      '}));',
      'setInterval(() => {}, 500);',
    ].join('\n'));
    fs.writeFileSync(cmdEnvFile, `PR_SMOKE_CMD_TOKEN=${cmdToken}\n__proto__=proto-file-value\n`);
    const cmdDesc = path.join(base, 'desc-cmd-envfile.json');
    fs.writeFileSync(cmdDesc, JSON.stringify({
      alias: 'env-smoke-cmd', root, entry: 'cmd', mode: 'node',
      command: `node ${cmdScript} ${cmdOut}`,
      expectedImage: path.basename(process.execPath),
      discoverTimeoutMs: 5000,
      envRefs: ['PR_SMOKE_CMD_TOKEN', '__proto__'],
      envFile: cmdEnvFile,
      env: { PR_SMOKE_CMD_PLAIN: 'cmd-plain-ok' },
    }, null, 2));
    cleanup.push({ home: cmdHome, alias: 'env-smoke-cmd' });
    const r = runAt(cmdHome, ['start-new', '--desc', cmdDesc]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.data.status, 'RUNNING');
    assert(waitFile(cmdOut), '命令模式目标进程未写出 env 探针文件');
    const got = JSON.parse(fs.readFileSync(cmdOut, 'utf8'));
    assert.equal(got.token, cmdToken, '命令模式未注入 envFile 值');
    assert.equal(got.plain, 'cmd-plain-ok', '命令模式未注入 env 字面值');
    assert.equal(got.proto, 'proto-file-value', 'envFile 的 __proto__ 变量丢失或未注入');
    const rtRaw = fs.readFileSync(path.join(cmdHome, 'runtime', `${r.json.data.appId}.json`), 'utf8');
    assert(!rtRaw.includes(cmdToken), '命令模式 runtime 泄漏 envFile 值');
  });

  skipWithoutProbe('机密 env 告警在任何启动副作用前输出，启动失败仍可见且不回显值', () => {
    const failHome = path.join(base, 'warn-fail-home');
    const warnName = 'PR_SMOKE_WARN_SECRET';
    const warnValue = 'warn-secret-value-never-echoed';
    const failDesc = path.join(base, 'desc-warn-fail.json');
    fs.writeFileSync(failDesc, JSON.stringify({
      alias: 'env-smoke-warn', root, entry: 'warn', mode: 'node',
      command: 'node -e "process.exit(1)"',
      expectedImage: path.basename(process.execPath),
      discoverTimeoutMs: 1000,
      env: { [warnName]: warnValue },
    }, null, 2));
    cleanup.push({ home: failHome, alias: 'env-smoke-warn' });
    const r = runAt(failHome, ['start-new', '--desc', failDesc]);
    assert.notEqual(r.code, 0, '预期启动失败，实际成功');
    assert(r.stderr.includes(warnName), `启动失败路径缺少机密 env 告警：${r.stderr}`);
    assert(r.stderr.includes('envRefs') && r.stderr.includes('envFile'), `告警未提示改用 envRefs/envFile：${r.stderr}`);
    assert(!r.stdout.includes(warnValue) && !r.stderr.includes(warnValue), '告警或输出回显了机密值');
  });

  if (isWindows) {
    skipWithoutProbe('Windows: envRefs 名称大小写与宿主不同仍识别并注入', () => {
      const caseHome = path.join(base, 'case-home');
      const caseOut = path.join(base, 'case-probe.json');
      const caseScript = path.join(root, 'case-probe.js');
      const refLower = `pr_smoke_case_${suffix.toLowerCase()}`;
      const hostUpper = refLower.toUpperCase();
      fs.writeFileSync(caseScript, [
        "const fs=require('fs');",
        'fs.writeFileSync(process.argv[2], JSON.stringify({',
        '  lower: process.env[process.argv[3]],',
        '  upper: process.env[process.argv[4]],',
        '}));',
        'setInterval(() => {}, 500);',
      ].join('\n'));
      const caseDesc = path.join(base, 'desc-case.json');
      fs.writeFileSync(caseDesc, JSON.stringify({
        alias: 'env-smoke-case', root, entry: 'case', mode: 'node',
        exe: process.execPath, args: [caseScript, caseOut, refLower, hostUpper],
        envRefs: [refLower],
      }, null, 2));
      cleanup.push({ home: caseHome, alias: 'env-smoke-case' });
      const r = runAt(caseHome, ['start-new', '--desc', caseDesc], { [hostUpper]: 'case-value' });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(r.json.data.status, 'RUNNING');
      assert(waitFile(caseOut), '目标进程未写出大小写探针文件');
      const got = JSON.parse(fs.readFileSync(caseOut, 'utf8'));
      assert.equal(got.lower, 'case-value', '大小写不同时 envRefs 未被识别');
      assert.equal(got.upper, 'case-value', '目标进程未取得宿主变量值');
    });
  }

  skipWithoutProbe('清理 envFile 测试实例', () => {
    const r = runAt(home, ['stop', 'env-smoke-envfile']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });
} finally {
  for (const item of cleanup) {
    try { runAt(item.home, ['stop', item.alias]); } catch { /* 已退出或从未启动 */ }
  }
  fs.rmSync(base, { recursive: true, force: true });
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
if (skipped.length) console.log(`\n${skipped.length} 项跳过（缺进程探针）`);
console.log('\nenv smoke ok');
