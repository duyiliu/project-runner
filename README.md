# Project Runner

**Agent-native 本地开发项目启动与运行管理 Skill**

> 当前可用：Java / Spring Boot、Python、Vue/React/Vite 等 Node 前端及其他主流栈的项目识别与启动、Standalone JRebel 环境初始化、热加载验证，以及 `manager.mjs` 跨项目运行管理 P0 与其 `ui` 统一本机 Web 管理台（默认只读展示状态、日志与项目文件，本机启停/移除须页面显式二次确认；命令与使用规程见 [SKILL.md](skills/project-runner/SKILL.md) 第 8 节，能力与验收基线见 [design.md](docs/design.md)）。
>
> 跨项目能力包括首次启动自动登记、全局列表/状态、已登记应用从任意目录启动、受管进程跨 Agent 会话核验与有界强制启停、按批次查询日志；只管理本 Skill 启动并登记的应用进程，**不接管 IDEA / 手工启动的外部进程**。受管两种形态：直连真实可执行进程（`.exe`/`.com`，Linux 为无扩展名的真实 ELF），或命令模式（`command`+`expectedImage`——manager 拉起脚本命令后在后代中发现唯一真实目标托管，覆盖 `npm run dev`、`mvn spring-boot:run` 等脚本/复合命令）。真实 Agent 会话退出后的跨会话存活终验状态以 [design.md](docs/design.md) 的状态行为准。
>
> **平台支持**：Windows 11 + PowerShell 7（受管身份核验/终止/端口诊断走 `ps/*.ps1`）与 **Linux（`/proc`，无 pwsh 依赖）**。Linux 安全停止使用随 Skill 提供的 pidfd helper，需要 Python 3.9+ 和内核 pidfd 支持；缺少时会明确拒绝终止。macOS 暂不支持（无 `/proc`），命令会以 `PLATFORM_UNSUPPORTED` 明确拒绝。Windows 与 Linux 的受管目标都必须是可核验身份的真实进程；shell 脚本（`#!`）与 `.cmd`/`.bat`/`.ps1` 包装不能作为 `exe`，请用命令模式或解析到真实解释器。

## 安装

本仓库是 `project-runner` Skill 的**唯一维护源**，原 `duyiliu/agent-skills` 不再维护 `jrebel-start` 副本。

```bash
npx skills add duyiliu/project-runner --skill project-runner -g
```

安装后以 Agent 实际加载的 Skill 目录为准解析附带脚本；不同运行器的目录不必相同。重新安装或更新不会自动清理旧的 `jrebel-start` 本地副本，请先确认新 Skill 可用，再自行卸载旧版本，避免触发冲突。

**版本与更新**：manager 版本号见 `manager.mjs version`（或管理台顶栏徽标），与 Git 标签 `vX.Y.Z` 同步。更新=重跑上面的安装命令拉取最新 main；要固定版本则检出对应 tag 后安装。升级不清理 `~/.project-runner/` 数据目录。

## 用途

- **当前项目启动**：读取 `AGENTS.md`、已有脚本及构建配置，确定运行时、模块、入口、profile、端口、启动参数。Java 走 Maven/Gradle 识别；Python 走 venv/依赖声明识别；Vue/React/Vite 等前端把 `package.json` script 解析为真实 `node` 入口进程后受管启动。
- **JRebel**：初始化 / 检查 standalone JRebel、许可与 `rebel.xml`，按已有项目约定启动，验证加载与热更新证据（仅 Java）。
- **跨项目运行管理**：`manager.mjs` 统一登记并管理**本 Skill 启动且具有可信进程身份**的应用进程；支持全局 `list`/`status`、已登记应用从任意目录 `start`、受管实例 `stop`/`restart`、不再需要的登记 `remove`（须无存活受管实例，运行证据保留）、残留回收 `prune`（默认 dry-run）、按运行批次或统一日志源（`logs --src`）查日志，以及跨 Agent 会话核验。只管理本 Skill 启动并记录的应用，**不接管 IDEA / 手工启动的外部进程**；`stop` 默认为有界强制终止（`--grace <ms>` 可选优雅信号先行、`--tree` 连带终止后代进程），不承诺优雅关机。
- **本地运行管理台**：`manager ui` 按需启动网页（默认固定 `127.0.0.1:8199`，无令牌仅本机可访问，`--port 0` 随机端口，`--open` 自动打开；Ctrl+C 即退出，无常驻服务），查看全局应用状态、未结记录证据与日志（受管批次、非受管线索、项目 `.tmp` 兼容日志，支持正则过滤与只看错误；标题栏显示运行中应用数），并浏览所选应用的项目文件；原单项目 Viewer 已移除，能力并入本台。详情卡提供受管应用的启动/停止/重启/移除按钮（页面显式二次确认，与 CLI 同一实现与安全边界；`stop` 仍是有界强制终止）。
- **非受管启动**：连命令模式也无法定位唯一目标进程的项目脚本仍可按原授权执行，但只记录启动尝试与日志线索并标记为非受管，不承诺跨会话启停。

## 目录

```text
README.md
docs/design.md                   # 跨项目管理设计与验收基线（P0 已实现）
skills/project-runner/
├── SKILL.md
└── scripts/
    ├── manager.mjs              # 跨项目运行管理 P0（CLI 入口）
    ├── log-writer.mjs           # detached 日志转发/轮转
    ├── lib/                     # 领域模块：probe/locks/runtime/launch/desc/commands/...
    │   └── proc-linux.mjs       # Linux /proc 身份核验、终止、后代发现、端口诊断
    ├── manager-ui/
    │   ├── index.html           # manager ui 管理台页面（默认只读，启停/移除二次确认）
    │   └── server.mjs           # ui 本地服务（仅 127.0.0.1，无令牌）
    ├── ps/
    │   └── proc.ps1             # Windows 受管进程身份核验、终止与端口诊断适配
    ├── linux/
    │   └── pidfd-terminate.py   # Linux pidfd 安全终止 helper（Python 3.9+）
    └── test/
        ├── platform.mjs         # 跨平台测试辅助（探针探测/可执行文件查找/进程清理）
        ├── ui-smoke.mjs         # manager ui 冒烟测试（隔离 --home，不碰真实数据）
        ├── manager-smoke.mjs    # CLI 生命周期/未结记录/ack 冒烟
        ├── cli-smoke.mjs        # remove / prune / logs 统一日志源
        ├── ui-src-follow.mjs    # ui 日志源切换与跟随回归
        ├── runtime-smoke.mjs    # 受管生命周期冒烟（真实 node/python 直连 + 命令模式 + 拒绝路径）
        └── log-rotation.mjs     # 日志大小上限与轮转
```

## 本地测试项目

仓库内置 [Spring Boot 测试项目](examples/spring-boot-demo/README.md)，使用 Java 17，不依赖数据库、Nacos 或 Redis，默认只监听 `127.0.0.1:18273`。可用于验证受管启动、全局管理台日志、健康检查及 JRebel 热加载；构建、登记与接口检查步骤见该项目说明。

## 来源与兼容性

从 [duyiliu/agent-skills](https://github.com/duyiliu/agent-skills) 的 `skills/engineering/jrebel-start/` 和 `work/任务/JRebel跨项目统一运行管理/design.md` 迁移，基础能力来自 [PR #5](https://github.com/duyiliu/agent-skills/pull/5)，设计来自 [PR #6](https://github.com/duyiliu/agent-skills/pull/6)。

- 新 Skill 名称 `project-runner`；保留原项目日志命名 `jrebel-local-*.log`（由 `manager ui` 兼容扫描），不要求改业务仓库。
- 运行数据目录为 `~/.project-runner/`（2026-10-17 由设计初稿的 `~/.jrebel-start/` 更名：管理器已覆盖非 JRebel 的纯 Java 应用，且更名时尚无真实数据，无迁移问题）。
- 项目启动、构建、许可证配置及服务停止都遵循 Skill 中的授权边界；安装 Skill 不等于获得修改业务项目的授权。

## 开发边界

Skill 负责理解目标项目，确定性脚本只负责需要可靠重复执行的操作。不要为了支持更多语言预先引入通用适配框架、Daemon、数据库或 MCP。跨项目能力的验收要求见 [design.md](docs/design.md)。

改动 `manager.mjs` / `manager-ui` / `lib` 后运行全部冒烟测试（与 CI 同一组）：

```bash
npm test          # log-rotation → ui → manager → cli → ui-src-follow → runtime-smoke
npm run check     # 全部 .mjs 语法检查
```

CI 在 `windows-latest` 与 `ubuntu-latest` 上跑同一组测试：Windows 使用 pwsh 7 的真实探针；Linux 使用 `/proc`，缺 pwsh 时自动跳过仅 Windows 的断言。macOS 未纳入支持范围。
