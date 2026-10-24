#!/usr/bin/env node
// manager ui 日志源"跟随当前批次"测试：真实 ui server + node:vm 沙箱执行页面内嵌脚本（轻量 DOM 桩）。
// 覆盖：重启产生新批次后自动切到新当前源（保留 stdout/stderr 流偏好）；
//       刻意选择的历史批次/.tmp 源不被抢切；旧会话无标志位的 run: 记忆按跟随处理。
//       403（fatal）后各轮询入口停止发请求；loadSources 成功时清除残留横幅。
// 用法：node scripts/test/ui-src-follow.mjs [index.html 路径]（无外部依赖，Node 22+）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const MANAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager.mjs');
const PAGE = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'manager-ui', 'index.html'));

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ui-follow-'));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
for (const d of [path.join(home, 'runtime'), path.join(home, 'logs', 'ahis'), path.join(proj, '.tmp')]) fs.mkdirSync(d, { recursive: true });
const w = (f, c) => fs.writeFileSync(f, c, 'utf8');
const rtFile = path.join(home, 'runtime', 'ahis.json');
const now = '2026-01-01T00:00:00Z';

w(path.join(home, 'logs', 'ahis', 'rtest1.stdout.log'), 'rtest1 stdout\n');
w(path.join(home, 'logs', 'ahis', 'rtest1.stderr.log'), 'rtest1 stderr\n');
w(path.join(home, 'logs', 'ahis', 'rold1.stdout.log'), 'rold1 stdout\n');
w(path.join(proj, '.tmp', 'jrebel-local-20261020-100000.stdout.log'), 'tmp line\n');
w(path.join(proj, 'pom.xml'), '<project/>\n');
const root = fs.realpathSync(proj);

w(path.join(home, 'registry.json'), JSON.stringify({
  schemaVersion: 1,
  apps: {
    ahis: { appId: 'ahis', alias: 'his', displayName: 'HIS', root, entry: 'default', cwd: root, mode: 'java', exe: process.execPath, args: [], envRefs: [], expectedPort: null, sourceFingerprint: null, configRevision: 1, createdAt: now, updatedAt: now },
    arep: { appId: 'arep', alias: 'report', displayName: '报表', root, entry: 'default', cwd: root, mode: 'java', exe: null, args: [], envRefs: [], expectedPort: null, sourceFingerprint: null, configRevision: 1, createdAt: now, updatedAt: now },
  },
}));
// current=rtest1（STOPPED 受管）+ prev rold1；restart(n) 把 current 换成新 runId 并补日志文件
rtFile && w(rtFile, JSON.stringify({
  schemaVersion: 1, appId: 'ahis',
  current: { runId: 'rtest1', phase: 'STOPPED', managed: true, mode: 'java', intentAt: now, startedAt: now, pid: 99999, creationFileTime: '0', image: 'java.exe', envResolved: [], logPaths: { stdout: path.join(home, 'logs', 'ahis', 'rtest1.stdout.log'), stderr: path.join(home, 'logs', 'ahis', 'rtest1.stderr.log') }, lastError: null, endedAt: now, exitNote: 'smoke' },
  prevRuns: [{ runId: 'rold1', phase: 'STOPPED', managed: true, startedAt: now, endedAt: now, archivedAt: now }],
}));
const restart = (rid) => {
  const rt = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
  rt.prevRuns = [{ runId: rt.current.runId, phase: rt.current.phase, managed: rt.current.managed, startedAt: now, endedAt: now, archivedAt: now }, ...(rt.prevRuns ?? [])];
  rt.current = { ...rt.current, runId: rid, phase: 'RUNNING', logPaths: { stdout: path.join(home, 'logs', 'ahis', `${rid}.stdout.log`), stderr: path.join(home, 'logs', 'ahis', `${rid}.stderr.log`) }, endedAt: null, exitNote: null };
  w(rtFile, JSON.stringify(rt));
  w(path.join(home, 'logs', 'ahis', `${rid}.stdout.log`), `${rid} stdout\n`);
  w(path.join(home, 'logs', 'ahis', `${rid}.stderr.log`), `${rid} stderr\n`);
};

// ---------- 轻量 DOM 桩（只覆盖页面脚本用到的 API 面） ----------
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {};
    this.style = {}; this.handlers = {}; this._cls = new Set(); this._text = '';
    this.hidden = false; this.disabled = false; this.value = ''; this.title = '';
    this.scrollTop = 0; this.scrollHeight = 0;
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v ?? '').split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this._cls;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !s.has(c) : !!f; if (on) s.add(c); else s.delete(c); return on; },
      contains: (c) => s.has(c),
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v ?? ''); this.children = []; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new El('#text').withText(c) : c); }
  prepend(...cs) { for (const c of cs.reverse()) { const n = typeof c === 'string' ? new El('#text').withText(c) : c; n.parentNode = this; this.children.unshift(n); } }
  replaceChildren(...cs) { this.children = []; this.append(...cs); }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  remove() { const p = this.parentNode; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); } this.parentNode = null; }
  withText(t) { this._text = t; return this; }
  addEventListener(t, fn) { (this.handlers[t] ??= []).push(fn); }
  removeEventListener(t, fn) { const a = this.handlers[t]; const i = a?.indexOf(fn) ?? -1; if (i >= 0) a.splice(i, 1); }
  dispatch(t, ev) { for (const f of this.handlers[t] ?? []) f(ev); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (matchEl(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  closest(sel) { let n = this; while (n) { if (matchEl(n, sel)) return n; n = n.parentNode; } return null; }
  get nextElementSibling() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return p.children[i + 1] ?? null; }
  get options() { return this.children; }
  get selectedOptions() { return this.children.filter((c) => c.selected); }
  click() { this.dispatch('click', { target: this }); }
  focus() {}
  select() {}
}
// 复合选择器（tag / .cls / [data-x="v"] 组合，无后代组合器）
function matchEl(el, sel) {
  if (!(el instanceof El) || el.tagName === '#text' || el.tagName === '#fragment') return false;
  const re = /\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|([a-zA-Z][\w-]*)|(\*)/g;
  let m, tag = null; const cls = [], attrs = [];
  while ((m = re.exec(sel))) {
    if (m[1]) cls.push(m[1]);
    else if (m[2]) attrs.push([m[2], m[3]]);
    else if (m[4]) tag = m[4].toUpperCase();
  }
  if (tag && el.tagName !== tag) return false;
  for (const c of cls) if (!el._cls.has(c)) return false;
  for (const [k, v] of attrs) {
    const actual = k.startsWith('data-')
      ? el.dataset[k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())]
      : el.attrs[k];
    if (v === undefined ? actual === undefined : String(actual) !== v) return false;
  }
  return cls.length + attrs.length + (tag ? 1 : 0) > 0;
}
class Opt extends El { constructor(text, value) { super('option'); this._text = text ?? ''; this.value = value ?? this._text; this.selected = false; } get text() { return this._text; } }
class Frag extends El { constructor() { super('#fragment'); } }

const byId = new Map();
const elFor = (id) => { if (!byId.has(id)) byId.set(id, new El(id === 'runSel' ? 'select' : 'div')); return byId.get(id); };
const allEls = [];
const documentStub = {
  visibilityState: 'visible',
  documentElement: new El('html'),
  body: new El('body'),
  createElement: (t) => { const e = new El(t); allEls.push(e); return e; },
  createDocumentFragment: () => new Frag(),
  querySelector: (sel) => sel.startsWith('#') ? elFor(sel.slice(1)) : (allEls.find((e) => matchEl(e, sel)) ?? null),
  querySelectorAll: (sel) => {
    if (sel.startsWith('#')) { const e = byId.get(sel.slice(1)); return e ? [e] : []; }
    return allEls.filter((e) => matchEl(e, sel));
  },
  addEventListener: () => {},
  execCommand: () => false,
};
// 页面通过 $('#id') 取元素：预挂到 body 下，保证 querySelectorAll 子树搜索与 closest 可用
const roots = ['appList', 'detail', 'detailBar', 'detailSummary', 'detailOps', 'runSel', 'log', 'fdTree', 'logMeta'];
for (const id of roots) documentStub.body.appendChild(elFor(id));
elFor('fileDrawer').hidden = true; // 文件抽屉默认关闭，跳过 loadTree 分支

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), _map: m }; };
const sessionStorageStub = memStore();

const port = await new Promise((res, rej) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [MANAGER, '--home', home, 'ui', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let banner = '';
child.stdout.on('data', (d) => { banner += d; });
child.stderr.on('data', (d) => { banner += d; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((res, rej) => {
  http.get(`${origin}${p}`, (rs) => { let b = ''; rs.on('data', (d) => { b += d; }); rs.on('end', () => res({ status: rs.statusCode, body: b })); }).on('error', rej);
});

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};

const html = fs.readFileSync(PAGE, 'utf8');
const scriptSrc = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const ctx = vm.createContext({
  document: documentStub,
  sessionStorage: sessionStorageStub,
  localStorage: memStore(),
  location: { origin, href: origin + '/', search: '' },
  history: { replaceState: () => {} },
  navigator: {},
  window: {},
  CSS: { escape: (s) => String(s) },
  Option: Opt,
  fetch, URL, URLSearchParams, TextDecoder, AbortController, Blob, crypto,
  setInterval, setTimeout, clearInterval, clearTimeout,
  console, alert: () => {},
});
new vm.Script(scriptSrc, { filename: 'index.html<script>' }).runInContext(ctx);
const run = (expr) => vm.runInContext(expr, ctx);
const poll = async (expr, pred, ms = 8000) => {
  const t = Date.now();
  for (;;) {
    let v;
    try { v = run(expr); } catch { v = undefined; }
    if (pred(v)) return v;
    if (Date.now() - t > ms) throw new Error(`等待超时: ${expr}（当前 ${JSON.stringify(v)}）`);
    await wait(120);
  }
};
const pickSrc = (src) => {
  const sel = elFor('runSel');
  sel.dispatch('change', { target: { value: src, selectedOptions: sel.options.filter((o) => o.value === src) } });
};
const restartAndSync = async (rid) => { restart(rid); await run('loadSources()'); };

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await get('/api/apps')).status === 200; } catch { /* 未就绪 */ }
    if (!up) await wait(200);
  }
  assert(up, 'manager ui 未在 10s 内就绪');

  await poll('appsCache.length', (v) => v >= 2);
  run(`selectApp('his')`);
  await poll('logSrc', (v) => v !== null);

  await check('初始选中=当前批次 stdout', () => assert.equal(run('logSrc'), 'run:rtest1.stdout'));

  await restartAndSync('rtest2');
  await check('重启后切到新当前批次 stdout', () => assert.equal(run('logSrc'), 'run:rtest2.stdout'));

  pickSrc('run:rtest2.stderr');
  await check('手动选当前批次 stderr 生效', () => assert.equal(run('logSrc'), 'run:rtest2.stderr'));
  await restartAndSync('rtest3');
  await check('跟随保留流偏好：新当前批次 stderr', () => assert.equal(run('logSrc'), 'run:rtest3.stderr'));

  pickSrc('run:rold1.stdout');
  await restartAndSync('rtest4');
  await check('刻意选历史批次：重启后不抢切', () => assert.equal(run('logSrc'), 'run:rold1.stdout'));
  await check('历史选择记忆标志=非当前', () => assert.equal(sessionStorageStub.getItem('pr-ui-src-cur:his'), '0'));

  pickSrc('run:rtest4.stdout');
  await restartAndSync('rtest5');
  await check('手动选当前批次后仍跟随新批次', () => assert.equal(run('logSrc'), 'run:rtest5.stdout'));

  pickSrc('tmp:jrebel-local-20261020-100000.stdout.log');
  await restartAndSync('rtest6');
  await check('.tmp 源选择重启后保持', () => assert.equal(run('logSrc'), 'tmp:jrebel-local-20261020-100000.stdout.log'));

  // 旧会话：有 pr-ui-src 无 -cur 标志位，run: 源按"当时在跟随"处理 → 回到新当前
  sessionStorageStub.setItem('pr-ui-src:his', 'run:rtest6.stdout');
  sessionStorageStub.removeItem('pr-ui-src-cur:his');
  run('logSrc = null; logSrcWasCurrent = false;');
  await restartAndSync('rtest7');
  await check('旧会话记忆（无标志位 run:）重启后跟随新当前', () => assert.equal(run('logSrc'), 'run:rtest7.stdout'));

  // 带标志位的非当前记忆：重启后仍保持原选择
  sessionStorageStub.setItem('pr-ui-src:his', 'run:rold1.stdout');
  sessionStorageStub.setItem('pr-ui-src-cur:his', '0');
  run('logSrc = null; logSrcWasCurrent = false;');
  await restartAndSync('rtest8');
  await check('非当前记忆（标志=0）重启后保持', () => assert.equal(run('logSrc'), 'run:rold1.stdout'));

  await check('启停执行中呈 loading（busy 类 + 禁用 + “中…”标签）', async () => {
    run(`lifecycleBusy = true; lifecycleOpKey = 'his:start:';`);
    run(`renderDetail({ alias:'his', appId:'ahis', status:'STOPPED', managed:true, mode:'java', expectedPort:null, run:{ runId:'rtest8', phase:'STOPPED', managed:true } })`);
    const buttons = [...elFor('detailOps').querySelectorAll('.op-btn'), ...elFor('detail').querySelectorAll('.op-btn')];
    const busy = buttons.filter((b) => b.classList.contains('busy'));
    assert.equal(busy.length, 2, '摘要栏与详情卡头各应有一个 busy 按钮');
    assert(busy.every((b) => b.disabled && b.textContent.includes('启动中')), '执行中按钮应禁用并显示“启动中…”');
    assert(buttons.every((b) => b.disabled), '执行期间其余按钮应全部禁用');
    run(`lifecycleBusy = false; lifecycleOpKey = null;`);
    await run('loadStatus()');
  });

  await check('loadSources 成功加载时清除残留横幅', async () => {
    run(`showBanner('残留横幅')`);
    assert.equal(run(`$('#fatalBanner').hidden`), false, '前置横幅应可见');
    await run('loadSources()');
    assert.equal(run(`$('#fatalBanner').hidden`), true, '成功加载后横幅应隐藏');
  });

  await check('403 后各轮询入口均不再发请求', async () => {
    const realFetch = ctx.fetch;
    let calls = 0;
    ctx.fetch = () => {
      calls++;
      return Promise.resolve({
        ok: false,
        status: 403,
        json: async () => ({ ok: false, error: { code: 'HOST_FORBIDDEN', message: '访问被拒绝（403）' } }),
      });
    };
    try {
      await run('loadSources()'); // 由真实轮询入口触发 403，使 fatal 生效
      assert.equal(run('fatal'), true, 'loadSources 收到 403 后应置 fatal');
      await wait(100); // 等待替换 fetch 前已发出的请求落地
      calls = 0;
      await run('Promise.all([loadApps(), loadStatus(), loadSources(), pollTail(), manualReload()])');
      await wait(1200); // 覆盖 pollTail 的 1s 定时器
      assert.equal(calls, 0, `fatal 后仍发出了 ${calls} 次轮询请求`);
    } finally {
      ctx.fetch = realFetch;
      run('fatal = false');
    }
  });
} finally {
  child.kill();
  fs.rmSync(base, { recursive: true, force: true });
}
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\nui source-follow ok');
process.exit(0); // 页面脚本的轮询定时器仍挂在事件循环，显式退出
