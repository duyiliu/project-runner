#!/usr/bin/env node
// project-runner 跨项目管理器（P0）
// 设计基线：docs/design.md v2。要点：
// - 只管理本 Skill 启动并记录的应用进程（Java/Python/Node/其他真实可执行进程）；外部进程绝不接管或终止。
// - 受管启停依赖 ps/proc.ps1 的"同句柄身份核验 + 终止"，防 PID 复用误杀。
// - 启动前先持久化意图（runId/STARTING），中断保留证据并拒绝自动重试。
// - 数据目录 ~/.project-runner/（或 --home 绝对路径）；注册表/运行记录带 schemaVersion，
//   损坏或不兼容版本拒绝覆盖并保留原件；写入均为临时文件 + 原子替换。
// - stdout 只输出管理结果，不混入被启动应用的日志（--follow 是用户显式要求的例外）。
//
// 本文件为 CLI 入口：参数解析、数据目录解析、输出渲染与命令分发。
// 命令实现见 lib/commands.mjs；领域逻辑见 lib/{errors,probe,locks,desc,runtime,launch,log-sources,prune,detect}.mjs。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { EXIT, SCHEMA_VERSION, MANAGER_VERSION, ManagerError } from './lib/constants.mjs';
import { usageError } from './lib/errors.mjs';
import { detectProjects } from './lib/detect.mjs';
import {
  parseNamed, cmdList, cmdStatus, cmdPort, cmdDoctor, cmdStart, cmdStop, cmdRestart,
  cmdRemove, cmdPrune, cmdLogs, cmdStartNew, cmdRecordUnmanaged, cmdUi, cmdCleanupWrapper,
} from './lib/commands.mjs';
import { resolveLogFile, listRuns, listSources, resolveSource } from './lib/log-sources.mjs';

export { SCHEMA_VERSION, MANAGER_VERSION };

// ---------- 参数与 home ----------

function parseArgv(argv) {
  const ctx = { json: false, home: null, command: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') ctx.json = true;
    else if (a === '--home') {
      ctx.home = argv[++i];
      if (!ctx.home) throw usageError('--home 需要绝对路径参数');
    } else if (ctx.command === null) ctx.command = (a === '--version' || a === '-v') ? 'version' : a;
    else ctx.rest.push(a);
  }
  if (!ctx.command || ctx.command === 'help') {
    throw usageError(usageText());
  }
  return ctx;
}

function resolveHome(argHome, readOnly = false) {
  const raw = argHome || path.join(os.homedir(), '.project-runner');
  if (!path.isAbsolute(raw)) throw usageError(`--home 需要绝对路径：${raw}`);
  if (readOnly) return fs.existsSync(raw) ? fs.realpathSync.native(raw) : path.resolve(raw);
  fs.mkdirSync(raw, { recursive: true });
  const home = fs.realpathSync.native(raw);
  for (const d of ['runtime', 'logs', 'locks']) fs.mkdirSync(path.join(home, d), { recursive: true });
  return home;
}

// 只读命令绝不创建 home/子目录；数据缺失由数据层按空数据处理。
// status 的 RUNNING→STOPPED 落账仅在 home 已存在且有记录时发生，不受影响。
const READ_ONLY_COMMANDS = new Set(['doctor', 'port', 'status', 'detect', 'list', 'logs', 'prune', 'version']);

// ---------- 输出 ----------

function emitOk(ctx, command, data) {
  if (data && data.following) return; // follow 模式由自身控制生命周期
  const out = ctx.json
    ? `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: true, command, data }, null, 2)}\n`
    : `${renderHuman(command, data)}\n`;
  // 输出 flush 后再退出：Windows 管道下 stdout 是异步写，立即 exit 会截断大 JSON（#22）
  process.stdout.write(out, () => process.exit(EXIT.OK));
}

function emitErr(ctx, command, e) {
  if (ctx.json) {
    const err = { code: e.code ?? 'UNKNOWN', message: e.message };
    if (e.detail !== undefined) err.detail = e.detail;
    // 同 emitOk：flush 后再退出，避免 Windows 管道截断（#22）
    process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, command, error: err }, null, 2)}\n`, () => process.exit(e.exitCode ?? 1));
    return;
  } else {
    let text = `错误[${e.code ?? 'UNKNOWN'}] ${e.message}`;
    if (e.detail) {
      // detail.stderrTail 单独按原样附在末尾，不进 JSON 转义
      const { stderrTail, ...rest } = typeof e.detail === 'object' ? e.detail : {};
      const body = typeof e.detail === 'string' ? e.detail : JSON.stringify(rest);
      text += `\n详情: ${body}`;
      if (typeof stderrTail === 'string' && stderrTail) text += `\nstderr 尾部:\n${stderrTail}`;
    }
    process.stderr.write(`${text}\n`, () => process.exit(e.exitCode ?? 1));
  }
}

function envWarnLine(names) {
  return names?.length
    ? `警告：env 中疑似机密字面值 ${names.join(', ')}（非阻断）；请改用 envRefs 或 envFile，status/ui 已对本类名称脱敏`
    : null;
}

function renderHuman(command, data) {
  switch (command) {
    case 'version':
      return `project-runner manager v${data.version}`;
    case 'list': {
      if (!data.apps?.length) return data.note ?? '（空）';
      const head = 'alias'.padEnd(14) + 'mode'.padEnd(8) + 'status'.padEnd(10) + 'managed'.padEnd(9) + 'pid'.padEnd(8) + 'port'.padEnd(7) + 'lastRunId';
      const rows = data.apps.map((a) =>
        String(a.alias).padEnd(14) + String(a.mode ?? '').padEnd(8) + String(a.status).padEnd(10)
        + String(a.managed ?? '?').padEnd(9) + String(a.pid ?? '-').padEnd(8) + String(a.expectedPort ?? '-').padEnd(7) + String(a.lastRunId ?? '-')
        + (a.error ? `\n  ! ${a.error}` : ''));
      return [head, ...rows].join('\n');
    }
    case 'port':
      return [`端口 ${data.port}`, ...data.occupants.map((p) => `PID=${p.pid} process=${p.processName ?? '-'} path=${p.executablePath ?? '-'} started=${p.startedAt ?? '-'} identity=${p.identity?.result ?? 'unknown'}`), data.note].join('\n');
    case 'doctor':
      return JSON.stringify(data, null, 2);
    case 'status':
      return [
        `${data.alias} (${data.appId}) mode=${data.mode} status=${data.status} managed=${data.managed}${data.pid ? ` pid=${data.pid}` : ''}`,
        data.run ? `run=${data.run.runId} phase=${data.run.phase} managed=${data.run.managed} started=${data.run.startedAt ?? '-'}` : 'run=无',
        data.run?.pid != null ? `pid=${data.run.pid}${data.run.creationFileTime ? ` creationFileTime=${data.run.creationFileTime}` : ''}${data.run.image ? ` image=${data.run.image}` : ''}` : null,
        Object.keys(data.env ?? {}).length ? `env=${JSON.stringify(data.env)}` : null,
        data.run?.lastError ? `lastError: ${data.run.lastError}` : null,
        data.run?.logPaths?.stdout ? `stdout=${data.run.logPaths.stdout}` : null,
        data.run?.logPaths?.stderr ? `stderr=${data.run.logPaths.stderr}` : null,
        data.run?.logHints?.length ? `logHints=${data.run.logHints.join(', ')}` : null,
        data.portListening !== undefined ? `portListening=${data.portListening}（监听 ≠ 业务就绪）` : null,
        data.jrebelEvidence ? `jrebelEvidence=${JSON.stringify(data.jrebelEvidence)}` : null,
        data.runtimeFile ? `证据: ${data.runtimeFile}` : null,
        ...(data.prevRuns ?? []).map((p) => `prev=${p.runId} phase=${p.phase}${p.archiveReason ? ` archiveReason=${p.archiveReason}` : ''}${p.pid != null ? ` pid=${p.pid}` : ''} archivedAt=${p.archivedAt}`),
        data.readinessUntested ? '就绪未检测：进程存活不等于业务就绪' : null,
        data.note ? `note: ${data.note}` : null,
      ].filter(Boolean).join('\n');
    case 'start-new':
    case 'start':
      return [
        `已启动（受管）${data.alias} (${data.appId})`,
        `run=${data.runId} pid=${data.pid} status=${data.status}`,
        envWarnLine(data.envWarnings),
        data.portEvidence?.forced ? data.portEvidence.note : null,
        data.abandonedRunId ? `已显式放弃未结记录 run=${data.abandonedRunId}（${data.abandonedReason}），证据保留在 prevRuns` : null,
        `stdout=${data.logPaths.stdout}`,
        `stderr=${data.logPaths.stderr}`,
        data.note ?? '',
        '观察：manager ui 可在浏览器只读查看全部受管应用与日志（Ctrl+C 退出）',
      ].filter(Boolean).join('\n');
    case 'record-unmanaged':
      return [
        `已记录非受管启动 ${data.alias} (${data.appId}) run=${data.runId}`,
        data.logHints?.length ? `日志线索: ${data.logHints.join(', ')}` : null,
        '观察：非受管日志在项目 .tmp 下，可在 manager ui 的日志源中选择查看',
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'stop':
      return `stop ${data.alias}: ${data.result}${data.runId ? ` (run=${data.runId})` : ''}${data.treeKilled?.length ? `；后代已终止 ${data.treeKilled.length} 个` : ''}${data.note ? `；${data.note}` : ''}`;
    case 'remove':
      return [
        `已移除登记 ${data.alias} (${data.appId})`,
        data.abandonedRunId ? `已显式放弃未结记录 run=${data.abandonedRunId}（${data.abandonedReason}），证据保留在 prevRuns` : null,
        `运行记录保留: ${data.runtimeFile}`,
        `日志目录保留: ${data.logsDir}`,
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'prune': {
      const lines = [data.dryRun
        ? 'prune 预览（默认 dry-run，未删除任何文件；确认后加 --apply 执行）'
        : 'prune 完成，已删除以下文件'];
      let any = false;
      for (const a of data.logs) for (const f of a.files) { any = true; const kind = /^(stdout|stderr)$/.test(f.stream) ? '超保留期批次日志' : '超保留期运行元文件'; lines.push(`- [${kind}] ${f.file}（${f.size} 字节，run=${f.runId}.${f.stream}，appId=${a.appId}）`); }
      for (const f of data.staleLocks) { any = true; lines.push(`- [死锁残留] ${f.file}（${f.size} 字节）`); }
      for (const f of data.tmpOrphans) { any = true; lines.push(`- [孤儿临时文件] ${f.file}（${f.size} 字节）`); }
      for (const s of data.skipped) lines.push(`  跳过 ${s.target}：${s.reason}`);
      if (!any) lines.push(data.dryRun ? '无可回收残留' : '无文件被删除');
      lines.push(`共 ${data.summary.files} 个文件 / ${data.summary.bytes} 字节${data.dryRun ? '可回收' : '已删除'}`);
      return lines.join('\n');
    }
    case 'restart':
      return [
        `restart ${data.alias}: stop=${data.stop.result} → start run=${data.start.runId} pid=${data.start.pid} status=${data.start.status}`,
        envWarnLine(data.start.envWarnings),
        `stdout=${data.start.logPaths.stdout}`,
        data.start.portEvidence?.forced ? data.start.portEvidence.note : null,
        data.note ?? '',
      ].filter(Boolean).join('\n');
    case 'logs': {
      if (data.sources) {
        return [
          `${data.alias} (${data.appId}) 的日志源（* 为当前运行）：`,
          ...data.sources.map((s) => `${s.current ? '*' : ' '} ${s.src}  ${s.kind}${s.stream ? `/${s.stream}` : ''}  ${s.size} 字节  ${s.label}`),
          data.note ?? null,
        ].filter(Boolean).join('\n');
      }
      if (data.stream === 'both') {
        const body = data.lines.map((l) => `[${l.stream}] ${l.line}`).join('\n');
        return data.missingStreams?.length ? `${body}${body ? '\n' : ''}（无 ${data.missingStreams.join('/')} 日志文件）` : body;
      }
      return data.lines.join('\n');
    }
    default:
      return JSON.stringify(data, null, 2);
  }
}

function usageText() {
  return [
    '用法：node manager.mjs [--home <绝对路径>] [--json] <命令> [参数]',
    '',
    '命令：',
    '  version                           显示 manager 版本号（--version/-v 同效）',
    '  list                              列出已登记应用与实时状态',
    '  status <alias|appId> [--probe] [--ready]   单应用详情；--probe 检测本机 TCP 监听，',
    '       --ready 按 desc 的 readyLogPattern/readyUrl 评估业务就绪证据',
    '  port <N>                           只读端口占用诊断（外部进程不接管、不停止）',
    '  doctor [--json]                    只读自检（不修复）',
    '  detect --root <dir>                 只读扫描仓库并输出启动描述候选',
    '  start <alias|appId> [--force] [--ack-unresolved <runId>] 用已保存配置启动（任意目录可用）',
    '  stop <alias|appId> [--tree] [--grace <ms>]   停止受管实例：默认有界强制终止；',
    '       --tree 连带终止全部后代进程（#39）；--grace 先发优雅信号（Linux SIGTERM /',
    '       Windows taskkill 无 /F），等待 <ms> 仍存活再走强制终止；restart 的 --tree/--grace',
    '       作用于停旧实例这一步',
    '  cleanup-wrapper <alias|appId>     清理命令模式失败后残留的 wrapper（仅 UNKNOWN 且身份完整）',
    '  restart <alias|appId> [--force] [--tree] [--grace <ms>]   确认退出后重启（仅受管实例；--tree/--grace 作用于停旧实例这一步）',
    '  logs <alias|appId> [--lines N] [--stream stdout|stderr|both] [--run <runId>] [--follow]',
    '       [--src <run:…|hint:<hash>|tmp:…>] [--list-sources]    统一日志源（--src 与 --run/--stream 互斥；both 合并双流）',
    '  remove <alias|appId> [--ack-unresolved <runId>]   移除登记：须无存活受管实例；运行记录与日志证据保留',
    '  prune [--dry-run] [--apply]                       回收超保留期批次日志/死锁残留/孤儿临时文件（默认 dry-run）',
    '  ui [--port N] [--open]              本地 Web 管理台（默认固定 127.0.0.1:8199，无令牌仅本机；--open 监听成功后用默认浏览器打开 URL，失败仅打印地址；Ctrl+C 退出）',
    '',
    '内部入口（Skill 调用，不对用户暴露注册 CRUD）：',
    '  start-new --desc <file> [--ack-unresolved <runId>]   首次受管启动：意图→启动→身份采集→登记',
    '  record-unmanaged --desc <file> [--log-hints p1,p2] [--force]   记录非受管启动尝试（同 appId 已有受管登记时须 --force）',
    '',
    '启动描述 mode 取值：java | jrebel | python | node | proc（其他真实可执行进程）。',
    '受管目标两种形态（desc 二选一）：',
    '  exe+args                 真实可执行文件（.exe/.com）；.cmd/.bat/.ps1 包装与',
    '                           WindowsApps 应用执行别名会被拒绝',
    '  command+expectedImage    脚本/复合命令（npm run dev、mvn spring-boot:run 等）；',
    '                           manager 拉起 cmd wrapper 后在后代中按映像基名发现',
    '                           唯一真实目标并托管；多个匹配拒绝任选（discoverTimeoutMs 可调）',
    '',
    'STARTING/UNKNOWN 未结记录默认拒绝启动或移除（UNRESOLVED_RUN）；人工核验进程已退出后，',
    '用 --ack-unresolved <runId> 显式放弃旧账：start <ref> --ack-unresolved <runId> 重启，或 remove <ref> --ack-unresolved <runId> 移除登记',
    '',
    '退出码：0 成功 | 1 用法 | 2 未找到 | 3 状态冲突 | 4 环境依赖 | 5 数据损坏/内部错误（DATA_* | INTERNAL）',
  ].join('\n');
}

// ---------- 供 manager-ui 复用的只读数据层 ----------

export { resolveHome, cmdList, cmdStatus, listRuns, resolveLogFile, listSources, resolveSource };

// ---------- 入口 ----------

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    process.stderr.write(`project-runner manager 需要 Node.js 20 或更高版本；当前版本：${process.versions.node}\n`);
    process.exit(1);
  }
  let ctx;
  let command;
  try {
    ctx = parseArgv(process.argv.slice(2));
    command = ctx.command;
    ctx.home = resolveHome(ctx.home, READ_ONLY_COMMANDS.has(command));
  } catch (e) {
    const c = command ?? 'cli';
    if (e instanceof ManagerError) { emitErr({ json: false }, c, e); return; }
    throw e;
  }
  try {
    let data;
    const refCommands = new Set(['status', 'stop', 'restart']);
    if (command === 'start' || command === 'remove') {
      if (!ctx.rest[0] || ctx.rest[0].startsWith('--')) throw usageError(`${command} 需要 <alias|appId>`);
    } else if (command === 'cleanup-wrapper') {
      if (!ctx.rest[0] || ctx.rest[0].startsWith('--')) throw usageError('cleanup-wrapper 需要 <alias|appId>');
      if (ctx.rest.length > 1) throw usageError(`无法识别的参数：${ctx.rest[1]}`);
    } else if (refCommands.has(command)) {
      if (!ctx.rest[0] || ctx.rest[0].startsWith('--')) throw usageError(`${command} 需要 <alias|appId>`);
      if (command !== 'stop' && command !== 'restart' && command !== 'status') {
        // stop/restart/status 的选项由各自分支内 parseNamed 统一解析——
        // 手工白名单与 cmd 参数解析是两份口径，会漂移（#82-D）；其余 ref 命令无选项。
        const extra = ctx.rest.slice(1)[0];
        if (extra !== undefined) throw usageError(`无法识别的参数：${extra}`);
      }
    }
    switch (command) {
      case 'version': if (ctx.rest.length) throw usageError(`无法识别的参数：${ctx.rest[0]}`); data = { version: MANAGER_VERSION }; break;
      case 'list': if (ctx.rest.length) throw usageError(`无法识别的参数：${ctx.rest[0]}`); data = cmdList(ctx); break;
      case 'status': {
        const opts = parseNamed(ctx.rest.slice(1), { '--probe': 'flag', '--ready': 'flag' });
        if (opts.positional.length) throw usageError(`无法识别的参数：${opts.positional[0]}`);
        data = await cmdStatus(ctx, ctx.rest[0], opts.has('--probe'), opts.has('--ready'));
        break;
      }
      case 'port': data = cmdPort(ctx, ctx.rest[0]); break;
      case 'doctor': if (ctx.rest.length) throw usageError(`无法识别的参数：${ctx.rest[0]}`); data = await cmdDoctor(ctx); break;
      case 'detect': {
        const opts = parseNamed(ctx.rest, { '--root': 'value' });
        if (opts.positional.length || !opts.get('--root')) throw usageError('detect 需要 --root <dir>');
        data = detectProjects(path.resolve(opts.get('--root')));
        break;
      }
      case 'start': data = await cmdStart(ctx, ctx.rest[0]); break;
      case 'stop': data = cmdStop(ctx, ctx.rest[0]); break;
      case 'cleanup-wrapper': data = cmdCleanupWrapper(ctx, ctx.rest[0]); break;
      case 'restart': data = await cmdRestart(ctx, ctx.rest[0]); break;
      case 'remove': data = cmdRemove(ctx, ctx.rest[0]); break;
      case 'prune': data = cmdPrune(ctx); break;
      case 'logs': data = cmdLogs(ctx, ctx.rest[0]); break;
      case 'start-new': data = await cmdStartNew(ctx); break;
      case 'record-unmanaged': data = cmdRecordUnmanaged(ctx); break;
      case 'ui': await cmdUi(ctx); return; // 前台常驻直到 Ctrl+C，不走 emitOk
      default: throw usageError(`未知命令：${command}\n${usageText()}`);
    }
    emitOk(ctx, command, data);
  } catch (e) {
    // 已知契约错误按 ManagerError 输出；未知内部错误用 INTERNAL code 明确区分（#57），
    // 退出码仍为 5（数据损坏/内部错误一类），但不冒充 DATA_CORRUPT。
    if (e instanceof ManagerError) emitErr(ctx, command, e);
    else emitErr(ctx, command, new ManagerError('INTERNAL', `内部错误：${e.message}`, EXIT.DATA, { stack: e.stack }));
  }
}

// 仅在直接执行时进入 CLI；被其他模块 import（如 ui 服务或测试）时不运行 main
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync.native(path.resolve(process.argv[1])) === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
