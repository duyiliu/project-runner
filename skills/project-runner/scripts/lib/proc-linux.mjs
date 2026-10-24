// Linux process probes backed by /proc. Termination delegates to a pidfd helper
// so verification and signaling stay anchored to the same process instance.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TERMINATE_WAIT_MS, COMMAND_DISCOVER_TIMEOUT_MS, EXIT, ManagerError } from './constants.mjs';
import { sleepSync } from './proc.mjs';

const PROC = '/proc';
const PIDFD_TERMINATE = fileURLToPath(new URL('../linux/pidfd-terminate.py', import.meta.url));
const DISCOVER_SETTLE_MS = 1500;
const DISCOVER_POLL_MS = 400;
// 已知包管理器/构建器启动器的命令行特征：同映像单链折叠时只别除命中特征的祖先
// （npm-cli/yarn/pnpm/maven/gradle wrapper，含 npm 重写进程标题后的 "npm run …" 形式）；
// 其余同映像链仍按歧义拒绝。
const LAUNCHER_CMD_RE = /npm-cli\.js|yarn\.js|pnpm(\.cjs|\.js)?|[\\/]\.pnpm[\\/]|plexus[.\-]classworlds|org\.gradle\.wrapper|gradle-launcher|GradleMain|^\s*(?:npm|npx|pnpm|yarn|bun)(?:[ /]|$)/i;

function readCmdline(pid) {
  try { return fs.readFileSync(`${PROC}/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); }
  catch { return ''; }
}

let bootIdCache = null;
export function bootId() {
  if (bootIdCache == null) {
    try { bootIdCache = fs.readFileSync(path.join(PROC, 'sys/kernel/random/boot_id'), 'utf8').trim(); }
    catch { bootIdCache = 'boot-unknown'; }
  }
  return bootIdCache;
}

// /proc/<pid>/stat 的 comm 可含空格与括号：先取最后一个 ')'，再按空白切分。
// fields[0]=state, fields[1]=ppid, fields[19]=starttime（第 22 字段）。
function readStat(pid) {
  let raw;
  try { raw = fs.readFileSync(`${PROC}/${pid}/stat`, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return { result: 'notfound' };
    return { result: 'error', code: 'openFailed', message: e.message };
  }
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < 0) return { result: 'error', code: 'statParseFailed', message: `无法解析 /proc/${pid}/stat` };
  const comm = raw.slice(open + 1, close);
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number.parseInt(fields[1], 10);
  const starttime = fields[19];
  if (!state || !Number.isInteger(ppid) || !starttime) {
    return { result: 'error', code: 'statParseFailed', message: `无法解析 /proc/${pid}/stat` };
  }
  if (state === 'Z' || state === 'X' || state === 'x') return { result: 'exited' };
  return { ok: true, state, ppid, starttime, comm };
}

// /proc/<pid>/exe 在权限不足（yama/hidepid）或内核线程时不可读：降级为 comm 前缀，
// verify 时按同一算法比较；记录中若为 exe 路径而当前不可读，则保守拒绝操作。
function readImage(pid, comm) {
  try {
    return fs.readlinkSync(`${PROC}/${pid}/exe`).replace(/ \(deleted\)$/, '');
  } catch {
    return `comm:${comm}`;
  }
}

function identityOf(pid) {
  const s = readStat(pid);
  if (!s.ok) return s;
  return {
    result: 'ok',
    creationFileTime: `${bootId()}:${s.starttime}`,
    image: readImage(pid, s.comm),
    comm: s.comm,
    starttime: s.starttime,
  };
}

export function capture(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { result: 'error', code: 'badArgs' };
  const id = identityOf(pid);
  if (id.result !== 'ok') return id;
  return { result: 'ok', creationFileTime: id.creationFileTime, image: id.image, comm: id.comm };
}

function verifyIdentity(expected, current) {
  const parts = String(expected.creationFileTime ?? '').split(':');
  if (parts.length !== 2) return { result: 'error', code: 'badArgs' };
  const [boot, starttime] = parts;
  if (boot !== bootId() || starttime !== current.starttime) return { result: 'mismatch', field: 'creationTime' };
  const expectedImage = String(expected.image ?? '');
  if (current.image.startsWith('comm:')) {
    if (expectedImage !== current.image) {
      return { result: 'error', code: 'imageUnreadable', message: '目标进程 exe 不可读，记录中的 image 无法核验；拒绝操作' };
    }
  } else if (expectedImage !== current.image) {
    return { result: 'mismatch', field: 'image' };
  }
  return { result: 'ok' };
}

export function verify(pid, expected) {
  if (!Number.isInteger(pid) || pid <= 0) return { result: 'error', code: 'badArgs' };
  const id = identityOf(pid);
  if (id.result !== 'ok') return id;
  const checked = verifyIdentity(expected, id);
  if (checked.result !== 'ok') return checked;
  return { result: 'ok', creationFileTime: id.creationFileTime, image: id.image };
}

// pidfd 终止原语：helper 先 pidfd_open 锚定进程实例，再核验记录身份，最后在同一
// pidfd 上发信号并等待退出——PID 复用无法进入核验→发信号这个窗口。sig 为信号名。
function pidfdTerminate(pid, expected, waitMs, sig) {
  let lastError = null;
  for (const python of ['python3', 'python']) {
    const r = spawnSync(python, [PIDFD_TERMINATE, String(pid), String(expected.creationFileTime), String(expected.image), String(waitMs), sig],
      { encoding: 'utf8', timeout: Math.max(0, waitMs) + 5000, windowsHide: true, maxBuffer: 64 * 1024 });
    if (r.error?.code === 'ENOENT') continue;
    if (r.error) {
      lastError = r.error.message;
      break;
    }
    if (r.status !== 0) {
      lastError = (r.stderr || `helper exited with code ${r.status}`).trim();
      break;
    }
    try {
      const result = JSON.parse((r.stdout || '').trim());
      if (result.code === 'pidfdUnsupported') {
        lastError = result.message;
        continue;
      }
      return result;
    } catch (error) {
      if (error instanceof ManagerError) throw error;
      lastError = `无法解析 pidfd 终止结果：${(r.stdout || '').trim()}`;
      break;
    }
  }
  throw new ManagerError('PIDFD_UNAVAILABLE',
    `安全终止 Linux 受管进程需要 Python 3.9+、pidfd_open 与 pidfd_send_signal；${lastError ?? '未找到 python3/python'}`,
    EXIT.DEPENDENCY);
}

export function terminate(pid, expected, waitMs = TERMINATE_WAIT_MS) {
  if (!Number.isInteger(pid) || pid <= 0 || !expected?.creationFileTime || !expected?.image) {
    return { result: 'error', code: 'badArgs' };
  }
  return pidfdTerminate(pid, expected, waitMs, 'SIGKILL');
}

function childrenByParent(rows) {
  const byParent = new Map();
  for (const [pid, s] of rows) {
    if (!byParent.has(s.ppid)) byParent.set(s.ppid, []);
    byParent.get(s.ppid).push(pid);
  }
  return byParent;
}

function descendantsOf(rootPid, byParent) {
  const found = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const cur = queue.shift();
    for (const child of byParent.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

// 枚举目标进程当时仍在的后代（PPID 树，含多级）：stop --tree 在终止目标前留证（#39）。
// 只向下遍历，不向上爬、不认领外部进程。返回 [{pid,image,comm}]。
export function descendants(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const rows = snapshotProcesses();
  if (rows.error) return [];
  return descendantsOf(pid, childrenByParent(rows)).map((child) => {
    const s = rows.get(child);
    return { pid: child, image: readImage(child, s.comm), comm: s.comm };
  });
}

// --grace：与 terminate 同一 pidfd 同锚定核验语义，只把信号换成 SIGTERM；
// waitMs 内确认退出 → gracefulTerminated，超时仍存活 → stillAlive，由调用方回退强杀。
export function gracefulTerminate(pid, expected, waitMs) {
  if (!Number.isInteger(pid) || pid <= 0 || !expected?.creationFileTime || !expected?.image) {
    return { result: 'error', code: 'badArgs' };
  }
  const r = pidfdTerminate(pid, expected, waitMs, 'SIGTERM');
  if (r.result === 'terminated') return { result: 'gracefulTerminated' };
  if (r.result === 'terminateTimeout') return { result: 'stillAlive' };
  return r;
}

// --tree：核验目标身份后，快照中的后代逐个复核 starttime 再 SIGKILL——快照到发信号
// 之间若发生 PID 复用，starttime 必不相同，复核不过即跳过不杀；根进程走 terminate()
// 的 pidfd 同锚定核验+终止。新拉起的后代漏网仍是已知限制，记录 killedPids 供人工核验。
export function terminateTree(pid, expected, waitMs = TERMINATE_WAIT_MS) {
  const v = verify(pid, expected);
  if (v.result !== 'ok') return v;
  const rows = snapshotProcesses();
  if (rows.error) return { result: 'error', code: 'procUnreadable', message: rows.error.message };
  const kids = descendantsOf(pid, childrenByParent(rows));
  const killedPids = [];
  for (const k of kids) {
    const s = readStat(k);
    if (!s.ok || s.starttime !== rows.get(k)?.starttime) continue;
    try { process.kill(k, 'SIGKILL'); killedPids.push(k); } catch { /* 已退出/无权限：尽力而为 */ }
  }
  const w = terminate(pid, expected, waitMs);
  return { ...w, killedPids };
}

function snapshotProcesses() {
  let names;
  try { names = fs.readdirSync(PROC); } catch (e) { return { error: e }; }
  const rows = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const s = readStat(pid);
    if (s.ok) rows.set(pid, s);
  }
  return rows;
}

export function discover(rootPid, expectedImage, waitMs = COMMAND_DISCOVER_TIMEOUT_MS) {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !expectedImage) {
    return { result: 'error', code: 'badArgs' };
  }
  const deadline = Date.now() + waitMs;
  let foundAt = null;
  for (;;) {
    const rows = snapshotProcesses();
    if (rows.error) return { result: 'error', code: 'procUnreadable', message: rows.error.message };
    const found = [];
    // 锚点自身也参与映像匹配（与 ps/proc.ps1 同语义）：/bin/sh -c 可能 exec 成
    // 真实目标而 pid 不变，此时目标不是自己的后代，仅按后代枚举会错过。
    const root = rows.get(rootPid);
    if (root) {
      const rootImage = readImage(rootPid, root.comm);
      const rootBase = rootImage.startsWith('comm:') ? rootImage.slice(5) : path.basename(rootImage);
      if (rootBase === expectedImage || root.comm === expectedImage) {
        found.push({ pid: rootPid, image: rootImage, comm: root.comm, cmd: readCmdline(rootPid), creationFileTime: `${bootId()}:${root.starttime}` });
      }
    }
    for (const child of descendantsOf(rootPid, childrenByParent(rows))) {
      const s = rows.get(child);
      const image = readImage(child, s.comm);
      const base = image.startsWith('comm:') ? image.slice(5) : path.basename(image);
      if (base === expectedImage || s.comm === expectedImage) {
        found.push({ pid: child, image, comm: s.comm, cmd: readCmdline(child), creationFileTime: `${bootId()}:${s.starttime}` });
      }
    }
    // 已知启动器单链折叠（与 ps/proc.ps1 同规则）：只别除「是其他候选祖先且命令行命中已知
    // 启动器特征」的候选；npm/mvn 与目标同映像单链时折叠到真实目标，其余仍歧义拒绝。
    if (found.length > 1) {
      const parentOf = new Map();
      for (const [pid, s] of rows) parentOf.set(pid, s.ppid);
      const ancestors = new Set();
      for (const f of found) {
        let cur = parentOf.get(f.pid);
        while (Number.isInteger(cur) && cur > 0) {
          ancestors.add(cur);
          if (!parentOf.has(cur)) break;
          cur = parentOf.get(cur);
        }
      }
      const leaves = found.filter((f) => !(ancestors.has(f.pid) && LAUNCHER_CMD_RE.test(f.cmd ?? '')));
      if (leaves.length === 1) found = leaves;
    }
    if (found.length) {
      if (!foundAt) foundAt = Date.now();
      if (Date.now() - foundAt >= DISCOVER_SETTLE_MS) return { result: 'found', candidates: found };
    } else {
      foundAt = null;
      if (!rows.has(rootPid)) return { result: 'wrapperExited', candidates: [] };
      if (Date.now() >= deadline) return { result: 'timeout', candidates: [] };
    }
    sleepSync(DISCOVER_POLL_MS);
  }
}

function ipv4FromHex(hex) {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return hex; // IPv6 保留 hex，避免臆造格式
  const bytes = [];
  for (let i = 6; i >= 0; i -= 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return bytes.join('.');
}

function parseNet(file, port) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10 || parts[3] !== '0A') continue; // 0A = TCP LISTEN
    const [addrHex, portHex] = (parts[1] ?? '').split(':');
    if (!portHex || Number.parseInt(portHex, 16) !== port) continue;
    rows.push({ inode: parts[9], localAddress: ipv4FromHex(addrHex), localPort: port, source: path.basename(file) });
  }
  return rows;
}

// 非 root 只能看到同 uid 进程的 fd：定位不到时 pid=null，仅报告端口监听。
function pidBySocketInodes(inodes) {
  const found = new Map();
  if (!inodes.size) return found;
  let names;
  try { names = fs.readdirSync(PROC); } catch { return found; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let fds;
    try { fds = fs.readdirSync(`${PROC}/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`${PROC}/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1])) found.set(m[1], pid);
    }
  }
  return found;
}

export function portOccupants(port) {
  const rows = [...parseNet(`${PROC}/net/tcp`, port), ...parseNet(`${PROC}/net/tcp6`, port)];
  if (!rows.length) return [];
  const pids = pidBySocketInodes(new Set(rows.map((r) => r.inode)));
  return rows.map((row) => {
    const pid = pids.get(row.inode) ?? null;
    const id = pid ? identityOf(pid) : null;
    const ok = id?.result === 'ok';
    return {
      pid,
      processName: ok ? id.comm : null,
      executablePath: ok && !id.image.startsWith('comm:') ? id.image : null,
      commandLine: null,
      startedAt: null,
      localAddress: row.localAddress,
      localPort: row.localPort,
      source: row.source,
      identity: ok ? { result: 'ok', creationFileTime: id.creationFileTime, image: id.image } : null,
      note: pid ? null : '无法在 /proc 中定位监听进程（权限不足或 hidepid）；仅报告端口监听',
    };
  });
}

export function selfIdentity() {
  const r = capture(process.pid);
  if (r.result !== 'ok') {
    throw new ManagerError('IDENTITY_UNAVAILABLE', `无法采集自身进程身份（/proc 不可读）：${JSON.stringify(r)}`, EXIT.DEPENDENCY);
  }
  return r;
}

// 批量核验：与 verify 同语义（boot_id:starttime + image），Linux 侧无 spawn 成本，
// 仅为与 Windows 的 verify-batch 保持同一接口。
export function verifyBatch(items) {
  return (items ?? []).map((it) => {
    try { return verify(it.id ?? it.pid, it); } catch (e) { return { result: 'error', code: 'verifyFailed', message: e.message }; }
  });
}

export function run(action, params = {}) {
  switch (action) {
    case 'verify-batch': return verifyBatch(params.items);
    case 'descendants': return descendants(params.id);
    case 'capture': return capture(params.id);
    case 'verify': return verify(params.id, params);
    case 'terminate': return terminate(params.id, params, params.waitMs ?? TERMINATE_WAIT_MS);
    case 'terminate-tree': return terminateTree(params.id, params, params.waitMs ?? TERMINATE_WAIT_MS);
    case 'grace': return gracefulTerminate(params.id, params, params.waitMs ?? TERMINATE_WAIT_MS);
    case 'discover': return discover(params.id, params.image, params.waitMs ?? COMMAND_DISCOVER_TIMEOUT_MS);
    default: return { result: 'error', code: 'unsupportedAction' };
  }
}
