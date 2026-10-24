// Read-only project detection: scan a repo for common launch evidence and emit
// start-desc candidates (detect command). Never writes registry or project files.
import fs from 'node:fs';
import path from 'node:path';
import { usageError } from './errors.mjs';

// 只作为“启动脚本存在且有明显框架依赖”时的置信度证据，不据此推断端口或命令。
const NODE_FRAMEWORK_DEPS = [
  'vite', '@vue/cli-service', 'next', 'nuxt', '@angular/cli',
  'react-scripts', '@sveltejs/kit', 'svelte', 'astro',
  '@remix-run/dev', 'gatsby', '@docusaurus/core', 'parcel', '@nestjs/cli',
];
// 同一目录出现多个 Python 标记时只生成一个候选；顺序决定 evidence.file 的首选来源。
const PYTHON_MARKERS = [
  'requirements.txt', 'Pipfile', 'pyproject.toml', 'poetry.lock', 'uv.lock',
  'setup.py', 'environment.yml',
];

export function detectProjects(root) {
  let stat;
  try { stat = fs.statSync(root); } catch { throw usageError(`detect root 不存在：${root}`); }
  if (!stat.isDirectory()) throw usageError(`detect root 必须是目录：${root}`);
  const absoluteRoot = fs.realpathSync.native(root);
  const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv']);
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name) || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isFile()) files.push(path.relative(absoluteRoot, file).split(path.sep).join('/'));
      else if (entry.isDirectory() && depth < 3) walk(file, depth + 1);
    }
  };
  walk(absoluteRoot, 0);
  const readRel = (rel) => {
    try { return fs.readFileSync(path.join(absoluteRoot, rel), 'utf8'); } catch { return ''; }
  };
  const readJson = (rel) => {
    try { return JSON.parse(readRel(rel)); } catch { return null; }
  };
  const candidates = [];
  const notes = [];
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const pythonExec = process.platform === 'win32' ? 'python' : 'python3';
  const aliasBase = path.basename(absoluteRoot).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 24) || 'project';
  const nextAlias = () => `${aliasBase}-${candidates.length + 1}`.slice(0, 32);
  const quoteArg = (value) => (/\s/.test(value) ? `"${value}"` : value);

  // 项目内解释器优先（SKILL 1A Python 第 2 条）：只在文件真实存在时采用，
  // 不把缺失 venv 当作已就绪；venv 目录本身被 walk 忽略，这里直接检查固定路径。
  const venvParts = process.platform === 'win32'
    ? [['.venv', 'Scripts', 'python.exe'], ['venv', 'Scripts', 'python.exe']]
    : [['.venv', 'bin', 'python'], ['venv', 'bin', 'python']];
  const venvInterpreter = (dir) => {
    for (const parts of venvParts) {
      const abs = path.join(dir, ...parts);
      try {
        if (!fs.statSync(abs).isFile()) continue;
        return { rel: path.relative(dir, abs), display: parts.join('/') };
      } catch { /* 没有该 venv 候选 */ }
    }
    return null;
  };
  const pythonCommand = (dir) => {
    const venv = venvInterpreter(dir);
    return venv
      ? { command: quoteArg(venv.rel), venv }
      : { command: pythonExec, venv: null };
  };
  const projectRootFor = (dir) => path.resolve(absoluteRoot, dir === '.' ? '' : dir);

  // expectedPort 推断：从常见配置文件读端口，并标注证据出处（不猜端口）。
  const inferPort = (dir) => {
    const read = (name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return ''; } };
    // .env.local 通常覆盖 .env；再退到常见开发环境文件，仍只在有显式 PORT 时采用。
    for (const name of ['.env.local', '.env.development', '.env.dev', '.env']) {
      const text = read(name);
      const m = /^(?:export\s+)?(?:PORT|SERVER_PORT)\s*=\s*["']?(\d{2,5})["']?\s*$/m.exec(text);
      if (m) return { expectedPort: Number(m[1]), source: `${name}:PORT` };
    }
    for (const cfg of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']) {
      const text = read(cfg);
      // 先限定 server 段；裸 port: 也可能命中 preview.port（预览端口 ≠ dev 端口），
      // 命中但不在 server 段时标注歧义，由人工核对而非静默采信。
      const mServer = /server\s*:[\s\S]{0,300}?\bport\s*:\s*(\d{2,5})/.exec(text);
      if (mServer) return { expectedPort: Number(mServer[1]), source: `${cfg}:server.port` };
      const mAny = /\bport\s*:\s*(\d{2,5})/.exec(text);
      if (mAny) return { expectedPort: Number(mAny[1]), source: `${cfg}:port（未在 server 段，可能是 preview.port，请人工核对）` };
    }

    // Spring：application.properties / application-<profile>.properties / yml/yaml，
    // 覆盖仓库根与 src/main/resources。基础文件优先，profile 文件按名称排序。
    const subDirs = ['src/main/resources', ''];
    const appFiles = [];
    for (const sub of subDirs) {
      let entries;
      try { entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const m = /^application(?:-([A-Za-z0-9._-]+))?\.(properties|ya?ml)$/.exec(entry.name);
        if (!m) continue;
        appFiles.push({
          sub,
          name: entry.name,
          ext: m[2],
          profile: m[1] ?? '',
          rel: path.posix.join(sub.split(path.sep).join('/'), entry.name),
        });
      }
    }
    const baseFirst = (a, b) => {
      if (!a.profile !== !b.profile) return a.profile ? 1 : -1;
      return a.name.localeCompare(b.name);
    };
    for (const ext of ['properties', 'yml', 'yaml']) {
      for (const item of appFiles.filter((f) => f.ext === ext).sort(baseFirst)) {
        const text = read(item.rel);
        const m = ext === 'properties'
          ? /^\s*server\.port\s*=\s*(\d{2,5})\s*$/m.exec(text)
          : /server\s*:[\s\S]{0,200}?port\s*:\s*(\d{2,5})/.exec(text);
        if (m) return { expectedPort: Number(m[1]), source: `${item.rel}:server.port` };
      }
    }
    return null;
  };

  // 包管理器判定：packageManager 字段优先，其次同目录 lock 文件。
  const nodePm = (dir, pkg) => {
    const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
    if (pm && ['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) return { pm, source: 'packageManager' };
    const has = (name) => files.includes(path.posix.join(path.posix.dirname(dir), name));
    if (has('pnpm-lock.yaml')) return { pm: 'pnpm', source: 'pnpm-lock.yaml' };
    if (has('yarn.lock')) return { pm: 'yarn', source: 'yarn.lock' };
    if (has('bun.lockb') || has('bun.lock')) return { pm: 'bun', source: 'bun.lock' };
    if (has('package-lock.json')) return { pm: 'npm', source: 'package-lock.json' };
    return { pm: 'npm', source: null };
  };

  for (const rel of files.filter((f) => path.basename(f) === 'package.json')) {
    const pkg = readJson(rel);
    if (!pkg) continue;
    const scripts = pkg.scripts ?? {};
    const scriptNames = Object.keys(scripts).filter((name) => typeof scripts[name] === 'string' && scripts[name].trim());
    // dev/start/serve 保持既有优先级；没有时再识别 dev:*（按名称排序取第一个）。
    const exact = ['dev', 'start', 'serve'].find((name) => scriptNames.includes(name));
    const script = exact ?? scriptNames.filter((name) => /^dev:.+/.test(name)).sort()[0];
    if (!script) {
      // package.json 存在但没有可识别脚本：提示 bin/main 字段，不编造候选（#54）
      if (pkg.bin || pkg.main) {
        notes.push({ file: rel, suggestion: 'package.json 无 dev/start/serve/dev:* 脚本；可核对 bin/main 字段或 README 的启动方式后手工拟定 desc。' });
      }
      continue;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = NODE_FRAMEWORK_DEPS.find((name) => deps[name]);
    const projectRoot = path.resolve(absoluteRoot, path.dirname(rel));
    const { pm, source: pmSource } = nodePm(rel, pkg);
    const port = inferPort(projectRoot);
    const alias = nextAlias();
    candidates.push({
      desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'node', command: `${pm} run ${script}`, expectedImage: `node${exeSuffix}`, ...(port ? { expectedPort: port.expectedPort } : {}) },
      confidence: framework ? 'high' : 'medium',
      evidence: { file: rel, rule: `package-script:${script}${framework ? `; dependency:${framework}` : ''}${pmSource ? `; pm:${pm}(${pmSource})` : ''}${port ? `; port:${port.expectedPort}(${port.source})` : ''}` },
    });
  }
  for (const rel of files.filter((f) => path.basename(f) === 'pom.xml')) {
    const text = readRel(rel);
    if (!/<artifactId>spring-boot-maven-plugin<\/artifactId>|spring-boot-starter/.test(text)) continue;
    const projectRoot = path.resolve(absoluteRoot, path.dirname(rel));
    const wrapper = files.includes(path.posix.join(path.posix.dirname(rel), 'mvnw')) || files.includes(path.posix.join(path.posix.dirname(rel), 'mvnw.cmd'));
    const cmd = wrapper ? (process.platform === 'win32' ? 'mvnw.cmd spring-boot:run' : './mvnw spring-boot:run') : 'mvn spring-boot:run';
    const port = inferPort(projectRoot);
    const alias = nextAlias();
    candidates.push({ desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'java', command: cmd, expectedImage: `java${exeSuffix}`, ...(port ? { expectedPort: port.expectedPort } : {}) }, confidence: 'medium', evidence: { file: rel, rule: `${wrapper ? 'maven-spring-boot-wrapper' : 'maven-spring-boot-plugin'}${port ? `; port:${port.expectedPort}(${port.source})` : ''}` } });
  }
  // Gradle：settings/build.gradle(.kts) 含 spring-boot 插件 → bootRun；gradlew 优先。
  for (const rel of files.filter((f) => /^build\.gradle(\.kts)?$/.test(path.basename(f)))) {
    const text = readRel(rel);
    if (!/org\.springframework\.boot|spring-boot/.test(text)) continue;
    const dir = path.posix.dirname(rel);
    const projectRoot = path.resolve(absoluteRoot, dir);
    const wrapper = files.includes(path.posix.join(dir, 'gradlew')) || files.includes(path.posix.join(dir, 'gradlew.bat'));
    const cmd = wrapper ? (process.platform === 'win32' ? 'gradlew.bat bootRun' : './gradlew bootRun') : 'gradle bootRun';
    const port = inferPort(projectRoot);
    const alias = nextAlias();
    candidates.push({
      desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'java', command: cmd, expectedImage: `java${exeSuffix}`, ...(port ? { expectedPort: port.expectedPort } : {}) },
      confidence: 'medium',
      evidence: { file: rel, rule: wrapper ? 'gradle-spring-boot-wrapper' : 'gradle-spring-boot-plugin' },
    });
  }

  // Python：按目录聚合所有依赖标记，避免 pyproject + poetry.lock/uv.lock 生成重复候选。
  const pythonDirs = new Map();
  for (const marker of PYTHON_MARKERS) {
    for (const rel of files.filter((f) => path.basename(f) === marker)) {
      const dir = path.posix.dirname(rel);
      if (!pythonDirs.has(dir)) pythonDirs.set(dir, []);
      pythonDirs.get(dir).push({ marker, rel });
    }
  }
  for (const dir of [...pythonDirs.keys()].sort()) {
    const markers = pythonDirs.get(dir);
    const markerNames = new Set(markers.map((m) => m.marker));
    const primary = PYTHON_MARKERS.flatMap((name) => markers.filter((m) => m.marker === name))[0] ?? markers[0];
    const depText = markers.map((m) => readRel(m.rel)).filter(Boolean).join('\n');
    const local = (name) => files.includes(path.posix.join(dir, name));
    let app = local('manage.py') ? null : local('app.py') ? 'app' : null;
    const django = local('manage.py') || /django/i.test(depText);
    const asgi = /fastapi|uvicorn/i.test(depText);
    if (!app && !django && !asgi) continue;
    const projectRoot = projectRootFor(dir);
    const alias = nextAlias();
    // FastAPI/uvicorn：在常见入口里找 ASGI app 变量名（app/api/application）
    let uvicornTarget = null;
    if (asgi && !django && !local('manage.py')) {
      for (const entry of ['main.py', 'app.py', 'server.py', 'asgi.py']) {
        const entryRel = path.posix.join(dir, entry);
        if (!files.includes(entryRel)) continue;
        const code = readRel(entryRel);
        const mv = /^(app|api|application)\s*=\s*(?:FastAPI|Starlette)\s*\(/m.exec(code);
        if (mv) { uvicornTarget = `${path.basename(entry, '.py')}:${mv[1]}`; break; }
      }
      if (!uvicornTarget) {
        notes.push({ file: primary.rel, suggestion: '检测到 FastAPI/uvicorn 依赖但未定位 ASGI 入口；请核对形如 `uvicorn main:app` 的启动目标后手工拟定 desc。' });
        continue;
      }
    }
    const port = inferPort(projectRoot);
    const { command: py, venv } = pythonCommand(projectRoot);
    const command = local('manage.py') ? `${py} manage.py runserver`
      : uvicornTarget ? `${py} -m uvicorn ${uvicornTarget}`
      : django ? `${py} manage.py runserver`
      : `${py} -m flask --app ${app} run`;
    const baseRule = local('manage.py') ? 'django-manage.py' : uvicornTarget ? `fastapi-uvicorn:${uvicornTarget}` : django ? 'django-dep' : 'flask-app.py';
    const depTags = ['Pipfile', 'poetry.lock', 'uv.lock', 'setup.py', 'environment.yml'].filter((name) => markerNames.has(name));
    const evidenceParts = [
      baseRule,
      ...(depTags.length ? [`deps:${depTags.join(',')}`] : []),
      ...(venv ? [`interpreter:venv(${venv.display})`] : []),
      ...(port ? [`port:${port.expectedPort}(${port.source})`] : []),
    ];
    candidates.push({
      desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'python', command, expectedImage: `python${exeSuffix}`, ...(port ? { expectedPort: port.expectedPort } : {}) },
      confidence: 'medium',
      evidence: { file: primary.rel, rule: evidenceParts.join('; ') },
    });
  }
  // Go：go.mod + package main/func main → go run <包目录>。找不到 main 时只给提示。
  for (const rel of files.filter((f) => path.basename(f) === 'go.mod')) {
    const moduleDir = path.posix.dirname(rel);
    const prefix = moduleDir === '.' ? '' : `${moduleDir}/`;
    const modulePath = /^\s*module\s+(\S+)/m.exec(readRel(rel))?.[1] ?? '';
    const moduleBase = modulePath.split('/').filter(Boolean).pop() || path.posix.basename(moduleDir) || 'app';
    const mainDirs = new Set();
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith('.go')) continue;
      const code = readRel(file);
      if (!/^\s*package\s+main\b/m.test(code) || !/func\s+main\s*\(/.test(code)) continue;
      mainDirs.add(path.posix.dirname(file));
    }
    if (!mainDirs.size) {
      notes.push({ file: rel, suggestion: '检测到 Go 模块但未找到 package main/func main；请核对入口目录后选择 `go run <包目录>`，或经授权先构建再直连产物。' });
      continue;
    }
    const dirs = [...mainDirs].sort();
    for (const mainDir of dirs) {
      const relMain = path.posix.relative(moduleDir === '.' ? '' : moduleDir, mainDir) || '.';
      const pkgArg = relMain === '.' ? '.' : `./${relMain}`;
      const binaryDir = path.posix.basename(mainDir);
      const binaryBase = binaryDir && binaryDir !== '.' ? binaryDir : moduleBase;
      const projectRoot = projectRootFor(moduleDir);
      const alias = nextAlias();
      candidates.push({
        desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'proc', command: `go run ${pkgArg}`, expectedImage: `${binaryBase}${exeSuffix}` },
        confidence: dirs.length === 1 ? 'medium' : 'low',
        evidence: { file: rel, rule: `go-module:${pkgArg}` },
      });
    }
  }
  // .NET：Web SDK / Exe 的 csproj → dotnet run；库项目不生成启动候选。
  for (const rel of files.filter((f) => /\.csproj$/i.test(path.basename(f)))) {
    const text = readRel(rel);
    const web = /Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore/i.test(text);
    const exe = /<OutputType>\s*Exe\s*<\/OutputType>/i.test(text);
    if (!web && !exe) continue;
    const assembly = /<AssemblyName>\s*([^<\s]+)\s*<\/AssemblyName>/i.exec(text)?.[1]
      || path.posix.basename(rel, path.posix.extname(rel));
    const projectRoot = path.resolve(absoluteRoot, path.dirname(rel));
    const port = inferPort(projectRoot);
    const alias = nextAlias();
    candidates.push({
      desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'proc', command: 'dotnet run', expectedImage: `${assembly}${exeSuffix}`, ...(port ? { expectedPort: port.expectedPort } : {}) },
      confidence: web ? 'medium' : 'low',
      evidence: { file: rel, rule: `dotnet-csproj:${web ? 'web' : 'exe'}${port ? `; port:${port.expectedPort}(${port.source})` : ''}` },
    });
  }
  // Rust：有 src/main.rs 或 [[bin]] 的 Cargo 包 → cargo run。
  for (const rel of files.filter((f) => path.basename(f) === 'Cargo.toml')) {
    const dir = path.posix.dirname(rel);
    const text = readRel(rel);
    const local = (name) => files.includes(path.posix.join(dir, name));
    if (!local('src/main.rs') && !/^\s*\[\[bin\]\]/m.test(text)) continue;
    const pkgName = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] || path.posix.basename(dir) || 'app';
    const projectRoot = projectRootFor(dir);
    const alias = nextAlias();
    candidates.push({
      desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'proc', command: 'cargo run', expectedImage: `${pkgName}${exeSuffix}` },
      confidence: 'medium',
      evidence: { file: rel, rule: `cargo-package:${pkgName}` },
    });
  }
  // PHP：Laravel artisan / public/index.php → 真实 php 解释器命令模式。
  for (const rel of files.filter((f) => path.basename(f) === 'composer.json')) {
    const pkg = readJson(rel);
    if (!pkg) continue;
    const dir = path.posix.dirname(rel);
    const local = (name) => files.includes(path.posix.join(dir, name));
    let command = null;
    let rule = null;
    if (local('artisan')) {
      command = 'php artisan serve';
      rule = 'composer-laravel:artisan';
    } else if (local('public/index.php')) {
      command = 'php -S 127.0.0.1:8000 -t public';
      rule = 'composer-php:public/index.php';
    }
    if (!command) continue;
    const projectRoot = projectRootFor(dir);
    const alias = nextAlias();
    candidates.push({
      desc: { alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: 'proc', command, expectedImage: `php${exeSuffix}` },
      confidence: 'medium',
      evidence: { file: rel, rule },
    });
  }
  // 入口文件低置信候选（#54）：仅在同目录尚无候选时给出，保持“未发现不编造”
  const hasCandidateFor = (dir) => candidates.some((c) => path.resolve(c.desc.root) === path.resolve(dir));
  for (const rel of files) {
    const base = path.basename(rel);
    const m = /^(server|app|main|index|run|start)\.(js|mjs|cjs|py)$/.exec(base);
    if (!m) continue;
    const projectRoot = path.resolve(absoluteRoot, path.posix.dirname(rel));
    if (hasCandidateFor(projectRoot)) continue;
    const isPy = m[2] === 'py';
    const alias = nextAlias();
    const py = isPy ? pythonCommand(projectRoot) : null;
    candidates.push({
      desc: {
        alias, root: projectRoot, cwd: projectRoot, entry: 'default', mode: isPy ? 'python' : 'node',
        command: `${isPy ? py.command : 'node'} ${base}`,
        expectedImage: isPy ? `python${exeSuffix}` : `node${exeSuffix}`,
      },
      confidence: 'low',
      evidence: { file: rel, rule: `entry-file:${base}${isPy && py.venv ? `; interpreter:venv(${py.venv.display})` : ''}` },
    });
  }
  return { candidates, notes, suggestion: candidates.length ? null : '未发现可确定的启动证据；请检查仓库说明、启动脚本和应用入口后再手工拟定 desc。' };
}
