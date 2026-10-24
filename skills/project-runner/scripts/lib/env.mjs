// Managed-launch environment resolution: validate envRefs before spawning,
// read optional envFile values in memory only, and redact secret-looking
// names from status/UI output.
import fs from 'node:fs';
import path from 'node:path';
import { conflictError } from './errors.mjs';
import { ENV_NAME_RE } from './desc.mjs';

// 敏感名模式：只用于回显脱敏与启动前告警，不改变 env/envRefs 的持久化契约。
export const SENSITIVE_ENV_NAME_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|PRIVATE|KEY)/i;

export function isSensitiveEnvName(name) {
  return SENSITIVE_ENV_NAME_RE.test(String(name));
}

// 值层面的兜底告警（名称不含敏感词时）：只做常见凭据形态识别，不阻断启动。
function looksLikeSecretValue(value) {
  if (typeof value !== 'string' || !value) return false;
  if (/^bearer\s+\S+/i.test(value)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return true; // JWT
  if (/^-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/.test(value)) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/.test(value)) return true; // URL 内嵌口令
  if (/^(?:sk_live_|sk_test_|ghp_|github_pat_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_-]+/.test(value)) return true;
  return false;
}

// 返回疑似机密的 env 变量名（不含值），用于成功启动后的非阻断告警。
export function envSecretWarnings(env = {}) {
  return Object.entries(env)
    .filter(([name, value]) => isSensitiveEnvName(name) || looksLikeSecretValue(value))
    .map(([name]) => name);
}

export function envWarningMessage(names = []) {
  if (!names.length) return null;
  return `env 中疑似机密字面值：${names.join(', ')}（非阻断告警）；请改用 envRefs 或 envFile 提供，status/UI 已对敏感名称显示 ***`;
}

function stripInlineComment(value) {
  // 仅对未加引号的值识别「空白 + #」的行尾注释；显式引号内的 # 原样保留。
  const m = /^([^]*?)(\s+#.*)$/.exec(value);
  return m ? m[1] : value;
}

function unquote(raw, file, lineNo) {
  const value = raw.trim();
  const trailingOk = (rest) => {
    const tail = rest.trim();
    if (!tail || tail.startsWith('#')) return;
    throw conflictError('ENV_FILE_INVALID', `envFile 第 ${lineNo} 行引号后存在多余内容（文件：${file}）`, { file, line: lineNo });
  };
  if (value.startsWith('"')) {
    let body = '';
    let escaped = false;
    for (let i = 1; i < value.length; i++) {
      const ch = value[i];
      if (escaped) {
        body += ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') {
        trailingOk(value.slice(i + 1));
        return body;
      }
      body += ch;
    }
    throw conflictError('ENV_FILE_INVALID', `envFile 第 ${lineNo} 行双引号未闭合（文件：${file}）`, { file, line: lineNo });
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    if (end < 0) {
      throw conflictError('ENV_FILE_INVALID', `envFile 第 ${lineNo} 行单引号未闭合（文件：${file}）`, { file, line: lineNo });
    }
    trailingOk(value.slice(end + 1));
    return value.slice(1, end);
  }
  return stripInlineComment(value).trimEnd();
}

// __proto__ 是合法环境变量名，但普通对象赋值会触发原型 setter 而丢失该键；
// 统一用 defineProperty 建立自有数据属性，envFile 与 env 合并都走这条路径。
function setEnvValue(target, name, value) {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

// 解析 .env 文本：KEY=VALUE，支持空行、# 注释、export 前缀、单/双引号与常见转义。
// 错误信息只包含文件与行号，绝不回显值。
export function parseEnvFile(text, file = '<envFile>') {
  const vars = {};
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (/^export\s+/i.test(line)) line = line.replace(/^export\s+/i, '').trim();
    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw conflictError('ENV_FILE_INVALID', `envFile 第 ${i + 1} 行不是合法的 KEY=VALUE（文件：${file}）`, { file, line: i + 1 });
    }
    const name = line.slice(0, eq).trim();
    if (!ENV_NAME_RE.test(name)) {
      throw conflictError('ENV_FILE_INVALID', `envFile 第 ${i + 1} 行的变量名不合法（文件：${file}）`, { file, line: i + 1 });
    }
    setEnvValue(vars, name, unquote(line.slice(eq + 1), file, i + 1));
  }
  return vars;
}

export function readEnvFile(file, cwd) {
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd ?? process.cwd(), file);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw conflictError('ENV_FILE_UNREADABLE', `envFile 不可读：${abs}（${e.code ?? e.message}）`, { file: abs });
  }
  return parseEnvFile(raw, abs);
}

// 启动前一次性解析环境：envFile 值只存在于内存，envRefs 校验失败会列出全部缺失名称。
// 优先级沿用既有语义：进程环境 < envFile < desc.env（env 仍覆盖同名宿主变量）。
// Windows 环境变量名不区分大小写：展开成普通对象后必须按大小写不敏感查找/合并，
// 否则宿主已设置但大小写不同的引用会被误报为 ENV_MISSING。
const ENV_CASE_INSENSITIVE = process.platform === 'win32';

function mergeEnvLayers(...layers) {
  const merged = {};
  if (!ENV_CASE_INSENSITIVE) {
    for (const layer of layers) {
      for (const [name, value] of Object.entries(layer ?? {})) setEnvValue(merged, name, value);
    }
    return merged;
  }
  const keysByLower = new Map();
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer ?? {})) {
      const lower = name.toLowerCase();
      const previous = keysByLower.get(lower);
      if (previous !== undefined) delete merged[previous];
      keysByLower.set(lower, name);
      setEnvValue(merged, name, value);
    }
  }
  return merged;
}

function findEnvValue(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return { found: true, key: name, value: env[name] };
  if (ENV_CASE_INSENSITIVE) {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(env)) {
      if (key.toLowerCase() === lower) return { found: true, key, value };
    }
  }
  return { found: false };
}

export function prepareLaunchEnv(app) {
  const warnings = envSecretWarnings(app.env ?? {});
  // 告警必须在 registry 写入/进程拉起等副作用之前输出；即使随后环境校验失败或
  // 进程拉不起来，用户也已看到“改用 envRefs/envFile”的提示。
  if (warnings.length) process.stderr.write(`[project-runner] 警告：${envWarningMessage(warnings)}\n`);
  const envRefs = Array.isArray(app.envRefs) ? app.envRefs : [];
  const fileEnv = app.envFile ? readEnvFile(app.envFile, app.cwd) : {};
  const env = mergeEnvLayers(process.env, fileEnv, app.env ?? {});
  const missing = [];
  const envResolved = [];
  for (const name of envRefs) {
    if (findEnvValue(env, name).found) envResolved.push(name);
    else missing.push(name);
  }
  if (missing.length) {
    throw conflictError(
      'ENV_MISSING',
      `启动前环境校验失败：缺少 envRefs 变量：${missing.join(', ')}；请先设置这些环境变量，或用 desc.envFile 提供（envRefs 只记录名称，envFile 值不写入运行记录）`,
      { missing },
    );
  }
  return { env, envResolved, warnings };
}

// status/UI 回显：敏感名一律 ***，非敏感值保持原有截断行为。
export function displayEnv(env = {}) {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => {
    if (isSensitiveEnvName(name)) return [name, '***'];
    const text = typeof value === 'string' ? value : String(value);
    return [name, text.length > 120 ? `${text.slice(0, 120)}… (截断)` : text];
  }));
}
