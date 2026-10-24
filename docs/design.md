# Project Runner 跨项目运行管理

> 设计版本：v2（收敛版，替代 v1）
> 状态：v2 已实现（manager.mjs，PR #2 合并）；2026-10-17 完成合并后验收，AC01–AC07 核心场景全部通过。**AC03 分层结论：全量通过**（L1/L2 于 2026-10-19 隔离环境实测；L3「真实 pi 会话退出后的存活」于 2026-10-20 按同判据补验通过——真实嵌套 pi 会话正常退出后，会话外全新进程实测 status/logs/stop 四项判据全过，Managed 启动路径无需阻塞）。实测命令与原始输出见 `docs/verification/ac03-l1-l2-evidence.md`（L3 见其 §4.5）。若未来更换运行器或宿主调度层（尤其新增 `KILL_ON_JOB_CLOSE` 包裹），须按同一判据重验后方可宣称 AC03 兼容。2026-10-20 新增 `manager ui` 本地只读管理台（§2.2、AC08），"简单部署"原则、非目标与 P2 表述已同步调整。
> **v2.3（2026-10-21，多语言）**：受管范围由 JVM 推广到任意真实可执行进程——desc `mode` 扩展为 `java|jrebel|python|node|proc`；`resolveExe` 收紧为"必须解析为 .exe/.com 真实可执行文件"，拒绝 `.cmd`/`.bat`/`.ps1` 包装与 `Microsoft\WindowsApps` 应用执行别名 reparse point（npm/pnpm 等 shim 场景须先解析到底层 `node <entry>.js`）；`.tmp` 兼容日志新增 `runner-local-*` 通用名。生命周期、未结记录、锁与 ui 机制全部不变；冒烟见 `scripts/test/runtime-smoke.mjs`。
> **v2.4（2026-10-21，命令模式）**：desc 新增 `command` + `expectedImage`（+可选 `discoverTimeoutMs`），与 `exe/args` 二选一。manager 亲自用 `cmd /d /s /c <command>` 拉起脚本/复合命令（`npm run dev`、`mvn spring-boot:run`、`*.cmd` 编排等），再按 PPID 链在后代进程中有界轮询匹配 `expectedImage` 映像基名：首次匹配后再观察 ~1.5s 取最终清单（防"假唯一"），恰好 1 个 → 采集 pid+创建时间+映像进既有受管模型（kind=`command`，wrapper 身份一并记录供清理佐证）；≥2 个 → `DISCOVERY_AMBIGUOUS` 拒绝并列候选，wrapper 留证标 UNKNOWN；wrapper 先退出且无目标 → `SPAWN_FAILED`；超时 → UNKNOWN。`stop` 终止目标进程（同句柄核验不变）并尽力终止残留 wrapper；`restart`=`stop`+重放命令+重新发现。**实测约束**：5ec3fb4 起 logger 与 wrapper 一律 `detached: true`——非 detached 子进程在 Windows 会被放入 kill-on-close 作业对象，CLI 退出即整树终止；detached 后 stdout 经 pipe 转发不受影响（Windows cmd 与 Linux sh 均已实测）。安全边界不变：管理目标仍只能是 manager 自己启动的后代，不凭端口/事后断言认领外部进程。
> 依赖：原 agent-skills PR #5 迁移来的 `skills/project-runner/` Java/JRebel Skill；日志查看能力自 v2.2 起并入 `manager ui`（原单项目 Viewer 已移除）
> 评审说明：v1 的 same-context PASS 不继承为 v2 的代码审查或运行验证结论；实施后须按本文件验收。

## 1. 目标与非目标

**定位**：全局安装一次 `project-runner` Skill，在不同业务目录和不同 Agent 会话中，**统一查看与管理由该 Skill 启动并记录的应用进程**（v2.3 起覆盖 Java/Python/Node/其他真实进程）。不是 Windows 全机进程管理器，也不是独立 CLI 产品。

核心体验：

1. 在 HIS 目录说“启动 HIS”：复用原 Skill 识别项目和启动方式，启动时自动登记。
2. 在其他目录说“查看运行项目”：直接读取同一用户的全局记录并核验实时进程，不重新扫描全机或所有仓库。
3. 在其他 Agent 会话说“重启 HIS”：仅当记录的目标 JVM 可安全核验并由管理器托管时才执行。

原则：

- **Agent-first**：Skill 负责用户意图、项目结构分析、现有启动脚本及 JRebel 策略；确定性脚本只负责记录、受管启停、状态和日志。**不复制 PR #5 的 Maven/Gradle 项目解析逻辑**。
- **启动即登记**：不要求用户预先 `register`；首次由 Skill 在获得启动授权后提交经过确认的启动描述。
- **管理范围最小化**：仅记录本 Skill 发起的启动；IDEA Run/Debug、手工 Maven/Gradle、手工 `java -jar`、Docker 启动均不纳入注册表或生命周期管理。外部进程只可用于端口冲突诊断，绝不被自动接管/停止。
- **零项目侵入**：默认不改 `pom.xml`、`build.gradle`、`rebel.xml`、源码或项目启动脚本；构建、配置变更与初始化依 PR #5 的独立授权规则处理。
- **简单部署**：Windows 11 + PowerShell 7，或 Linux（`/proc`，不依赖 pwsh）；Node.js 22。Linux 安全停止还需要随 Skill 分发的 Python 3.9+ pidfd helper 与内核 pidfd 支持；缺少时拒绝终止，不回退到有 PID 复用竞态的 `kill(pid)`。尽量仅使用 Node 内置模块；不新增 npm 包、服务、Daemon 或数据库。唯一的 Web 界面是 `manager ui` 本地只读管理台：按需启动、非常驻、仅绑定 127.0.0.1 且无令牌（本机可信用户，见 §2.2）。任何需要的 PowerShell 适配脚本随 Skill 分发；Linux 路径不调用 PowerShell。macOS 暂不支持（无 `/proc`）。
- **保持原能力**：PR #5 现有单项目启动规程、热加载验证、`.tmp` 日志与只读日志查看能力不被替换（v2.2 起并入 `manager ui`，原单项目 Viewer 移除）。

非目标：项目全盘扫描、通用进程盘点、IDEA 进程关联与接管、批量启停、自动构建、跨机器管理、Docker 编排、JVM 监控、远程管理、对外网开放或常驻的 Web 控制台、多实例托管（本地只读管理台的边界见 §2.2）。

## 2. 组件与数据

~~~text
Codex / Pi / Claude Code
           │
     project-runner Skill
     ├─ 现有能力（PR #5）：识别项目、选择启动方式、JRebel 初始化与验证
     └─ 跨项目能力（PR #6）：调用 scripts/manager.mjs
                              ├─ 自动登记/读取注册表
                              ├─ 自有 JVM 的受管启停与身份核验
                              └─ 运行状态/日志定位
                                        │
                               ~/.project-runner/
~~~

Skill 安装副本可因 Agent 而不同，但都指向当前 Windows 用户下的同一个数据目录。不得把注册表写入 Git 仓库、Skill 安装目录或业务项目。

~~~text
~/.project-runner/
├── registry.json                   # 已由 Skill 启动的应用及可重用启动描述
├── runtime/<appId>.json           # 最近/当前运行实例及验证证据
└── logs/<appId>/<runId>.*.log     # 管理器直接启动 JVM 的分批日志
~~~

允许 `--home <absolute-path>` 使用隔离数据目录做验证；跨会话各调用须使用同一 home。安装或升级 Skill 不清理运行数据。所有结构化记录含 `schemaVersion`；不兼容版本/损坏 JSON 拒绝覆盖并保留原件。

### 2.1 应用记录

稳定配置至少包括：不可变 `appId`、别名、仓库真实路径、启动模块/入口、运行模式（`java|jrebel|python|node|proc`，仅标签语义）、工作目录、可执行文件与参数数组/兼容脚本引用、非敏感环境变量**引用**、预期端口、来源配置指纹及配置修订。

运行记录至少包括：`appId`、唯一 `runId`、启动意图/阶段、可用时的目标进程 PID、OS 创建时间、可核验的唯一进程标识（映像+创建时间）、`managed`、已知日志路径、时间及最近操作结果。

- 一个仓库可有多个应用；按规范化仓库真实路径 + 应用入口去重，别名不区分 Windows 大小写。
- 保留已经由 Skill 登记、但现在停止的项目；`list` 不等于“只列正在运行”。不再需要的登记由用户显式 `remove` 移除：仅允许无存活受管实例时移除（RUNNING 一律拒绝，STARTING/UNKNOWN 未结记录按既有 ack 流程）；只删注册表条目，`runtime/<appId>.json` 与 `logs/<appId>/` 证据保留，供事后追溯与 `prune` 按保留期回收。
- desc 可包含 `env`（合法环境变量名到字符串字面值的映射），随应用配置明文持久化到 `registry.json`，启动时覆盖 manager 当前环境中的同名变量；`envRefs` 仍只记录依赖宿主提供的变量名，不存值。**`env` 禁止存放机密**（如密码、Token、许可证内容）；机密由系统环境变量提供并用 `envRefs` 声明，或用 `envFile` 指向本机 env 文件。启动前一次性校验 `envRefs`：任一变量缺失即以 `ENV_MISSING` 拒绝并列出全部缺失名称；`envFile` 仅启动时读取并注入内存（`KEY=VALUE`，值不写入 registry/runtime/status/UI），其文件本身不允许通过管理台浏览。`env` 中出现敏感名称（`SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIAL` 等）或疑似凭据字面值时启动前告警但不阻断；human/JSON 状态与 UI 回显对敏感名称显示 `***`，非敏感 env 值保持截断行为。不存完整原始进程命令行或展开后的秘密。
- 不使用别名拼接可信文件路径；`appId`、`runId` 由脚本生成且严格校验。原子写文件，冲突写入不覆盖。

### 2.2 本地 Web 管理台（manager ui，v1 只读）

定位：给"不开 Agent、不开终端"的场景一个本机可视化入口，查看全局应用与实时状态、按批次查看日志。它是 `manager.mjs` 的一个子命令，不是独立产品：

- **按需启动、非常驻**：`manager ui [--port N] [--open]` 前台运行，Ctrl+C 即退出；不注册开机自启、不拉起守护进程、崩溃不自动重启。默认固定 `127.0.0.1:8199`（`--port 0` 为随机端口），端口被占用时按启动提示复用已有实例或换端口。`--open` 在监听成功后用默认浏览器打开 URL（默认不开：Agent 前台拉起场景不期望弹浏览器；打开失败降级为仅打印 URL，不阻塞 ui）。**ui 实例数量与项目数无关**：启动项目不自动拉起任何 Web 进程，并行多项目共用同一个实例（读共享数据目录，天然全局视角）。
- **只读**：v1 提供 list、status（含未结记录证据与 prevRuns）、统一日志源 tail（受管批次、非受管线索、项目 `.tmp` 兼容日志）与所选应用的项目文件只读浏览；不提供启动/停止/重启操作——stop 是有界强制终止，网页误触风险高于显式 CLI 调用。后续如要开放操作，必须在服务端同级复刻 CLI 的全部防护（身份核验、未结记录拒绝、显式确认），不得绕过 manager 直接改运行数据。
- **访问控制**：仅绑定 `127.0.0.1`，供本机可信用户使用，无令牌、地址固定可收藏；校验 Host 头防 DNS rebinding；仅允许 GET，启停例外为 POST `/api/lifecycle`（与 CLI 同一实现）。安全边界依赖本机绑定：不得将端口代理/转发到局域网或公网。
- **实现边界**：复用 manager 的数据层与命令实现（list/status 的状态计算、日志目标校验），不在 UI 里复制业务逻辑；损坏或不兼容数据按既有契约原样报错，不静默当空数据。页面为随 Skill 分发的单文件静态页，无外部资源。
- 日志内容可能含敏感信息且页面可启停受管应用，页面展示与 CLI `logs` 同责；管理台地址仅本机可达，不得转发给他人。
- **默认观察入口**：受管启动（start/start-new）后的日志与状态观察默认引导用户使用本管理台；受管批次日志在数据目录。非受管应用的日志线索、项目 `.tmp` 兼容日志与项目文件树同样在本台查看——v2.2 起原单项目 viewer 移除，AC07 的保持原能力承诺由本台承接。

## 3. Skill 与管理脚本边界

### 3.1 首次启动由 Skill 处理

1. 根据 PR #5 从当前仓库识别项目、模块、JDK、profile、端口、启动约定与 JRebel 配置；优先审查并复用项目现有脚本，不在 `manager.mjs` 重新做这些识别。
2. 按原授权规则判断是否允许启动；缺少编译产物或必需配置时报告阻塞，不偷偷构建/修改项目。**普通 Java 模式不要求 JRebel Agent 或 `rebel.xml`；JRebel 模式才检查其要求**。
3. 检查已知受管实例、已知端口占用及启动描述是否失效；外部占用只报告，不自动停进程、不擅自切端口。
4. 把经过确认的启动描述交给管理脚本，先持久化启动意图，再执行。首次成功或可确认的启动尝试自动生成/复用应用记录；不要求用户另行注册。
5. 依据真实证据区分受管/非受管、进程存活/业务就绪/JRebel 加载/许可/热加载验证。没有检测就明确标记“未检测/未验证”。

已登记应用从任意目录再启动时，先复用保存的启动描述；每次检查路径、JDK、构建产物及配置来源变化。失效时由 Skill 重新分析该目标项目，而不是全盘重新扫描。

### 3.2 两条启动路径，不强改项目脚本

**受管（Managed）**：脚本可可靠定位并持续核验**目标业务进程**（非 Maven/Gradle 启动器、cmd/pwsh/npm.cmd 等包装进程），有唯一 `runId`、PID、创建时间与其他可信身份证据。P0 保证经过实测的直接进程启动（v2.3 起 `exe` 必须解析为真实 `.exe`/`.com`）；已有项目脚本只有能交付同等证据、不会开启不可追踪的多进程/远端进程时才获得托管能力。受管应用可跨会话 `status/logs/stop/restart`。

**非受管（Unmanaged）**：Skill 可以按 PR #5 在既有授权下使用经审查的项目脚本；如果不能安全识别目标进程，则记录“本 Skill 发起过启动”及可信日志线索，标记 `managed=false`，**不承诺 RUNNING、跨会话启停或可靠的日志接管**。执行前要向用户说明能力限制；不为了适配而修改脚本或凭端口猜测 JVM。若无法确认脚本是否启动成功，则记录 UNKNOWN 而非成功。

如果用户明确要求“可自动托管”而当前启动方式无法满足要求，必须在执行前报告 `UNSUPPORTED_LAUNCH`，不能偷偷降级后声称可管理。

### 3.3 停止与重启原则

- 仅对 `managed=true`、本 Skill 留存的受管进程执行停止/重启；不能用 `runId`、端口或主类去认领外部进程。
- 停止前验证目标 PID、OS 创建时间、唯一 `runId` 与可执行文件身份；Windows 上要确保**身份核验与终止针对同一进程句柄**，避免“先查 PID 再按 PID 杀”的复用竞态。环境做不到可靠操作则拒绝。
- P0 默认**有界强制停止**，执行前说明，不盲目终止整棵进程树。v2.5 起提供两个显式可选项：`stop --tree`/`restart --tree` 连带终止受管目标当时的后代进程（针对命令模式遗留子进程占端口，#39）；`stop --grace <ms>` 先发优雅信号（Linux `SIGTERM`、Windows `taskkill` 无 `/F`），窗口内未退出再回退强制终止——优雅关机仍不保证，只是尽力而为。
- **树终止的有界性声明**：`--tree` 仅限**受管目标进程的后代**，不向上爬、不碰外部进程，也不引入任何外部认领。终止前先核验目标身份，通过后按 PPID 向下枚举当时仍在的子孙（含多级）并各自采集 `pid`+创建时间+映像；随后先终止目标、清理命令模式 wrapper，再对仍存活的后代逐个按快照身份同句柄核验后终止，返回 `treeKilled: [{pid,image}]` 留证。后代已自行退出或 PID 已复用时跳过不报错；目标身份核验不通过时不会触碰快照。未传 `--tree` 时默认不触碰后代（保守默认）。
- `restart` 必须先确认旧进程已退出，才启动新实例；重复停止可返回 alreadyStopped。UNKNOWN、身份无法验证或外部进程一律拒绝停止/重启。
- 用户明确要求单个目标的启动/重启可按已授权流程执行；不提供 `all`、通配符或自动批量重启。

## 4. 最小命令接口

统一入口为 `node <skill>/scripts/manager.mjs`（路径按安装位置解析，不要求 cd 到业务目录）。

~~~text
list [--json]
status <alias|appId> [--probe] [--ready] [--json]  # --probe 附加本机 TCP 监听探测；--ready 按 desc 的 readyLogPattern/readyUrl 评估业务就绪证据
port <N> [--json]                        # 只读端口占用诊断（外部进程不接管、不停止）
doctor [--json]                          # 只读自检（不修复）
start <alias|appId> [--force] [--ack-unresolved <runId>] [--json]   # 已登记应用，复用有效配置；expectedPort 被占用时 PORT_IN_USE 拒绝，--force 放行留证
stop <alias|appId> [--tree] [--grace <ms>] [--json]  # 仅 Managed；--tree 连带后代（#39），--grace 优雅信号先行
restart <alias|appId> [--force] [--tree] [--json] # 仅 Managed；--tree 同 stop
remove <alias|appId> [--ack-unresolved <runId>] [--json]   # 移除登记：仅无存活受管实例；只删注册表条目，运行记录与日志证据保留
prune [--dry-run] [--apply] [--json]     # 回收三类残留：超保留期批次日志（对齐 PREV_RUNS_KEEP=20）、locks/*.stale-*、.tmp-* 孤儿临时文件；默认 dry-run
logs <alias|appId> [--lines N] [--stream stdout|stderr|both] [--run <runId>] [--src <run:…|hint:<hash>|tmp:…>] [--list-sources] [--follow] [--json]
ui [--port N] [--open]                      # 本地 Web 管理台（127.0.0.1 无令牌，--open 自动打开；Ctrl+C 退出）
~~~

首次启动需要 Skill 调用的**内部登记与启动入口**：传递结构化启动描述并以原子流程“保存启动意图 → 启动 → 完成登记”；可以实现为内部子命令/参数文件，**不对用户暴露额外的手动注册 CRUD**。不可要求用户手写 `registry.json`。当一次普通项目脚本启动不能托管时，用同一内部入口记录尝试及日志线索。

`list/status` 读取注册表，实时核验受管 JVM 身份；区分 RUNNING、STOPPED、STARTING、UNKNOWN，以及独立的 `managed` 状态。未注册项目不在列表；历史 Unmanaged 记录不得凭端口扫描宣称 STOPPED 或 RUNNING。输出项目别名、来源、状态、PID/端口（有证据才填写）、托管能力、日志位置。

输出默认简短，`--json` 采用单一稳定对象（schemaVersion、ok、command、data/error），明确退出码；stdout 不混入启动应用日志。日志仅读取受信运行记录内的路径，按批次/流区分，读取有大小/行数限制；`follow` 可中止。既有项目脚本在 `.tmp` 输出的日志**只关联原路径，不迁移/覆盖**；日志读取统一由 `manager ui`（网页，按登记路径与 `.tmp` 兼容扫描）与 `manager logs`（CLI；`--src`/`--list-sources` 复用与 ui 相同的统一日志源解析，覆盖受管批次、非受管线索与 `.tmp` 兼容日志；`--stream both` 合并双流输出，`--src` 与 `--run`/`--stream` 互斥）提供。数据目录内的残留由 `prune` 有界回收：只删超出运行记录保留范围的批次日志、死锁回收残留与孤儿临时文件，绝不删 current 运行日志与 runtime/registry 证据，绝不触碰 home 之外的文件；运行记录损坏时按 DATA_* 契约整体拒绝。

## 5. 最小可靠性要求

**跨会话真实存活是 P0 核心能力**：受管进程（Windows JVM / Linux 真实进程）脱离启动 Agent/管理命令的管道与会话；新 Agent 用共享记录重新核验并安全操作。启动辅助进程只能短时存在，不能引入常驻服务。Windows 的 Job Object、沙箱等可能回收后代进程，必须在实际目标运行器上验证；不支持时明确阻塞 Managed 启动，不能假报能力。

为避免重复 JVM 或误杀，保留最少机制：

- 同一应用的跨进程启停互斥；注册表原子写入/必要的短时互斥；不同应用无需全局串行启停。
- JVM 启动前持久化意图与 `runId`；中断或身份不明时**保留证据并拒绝自动重试**，不得删账后再起。
- 受管记录每次查询按 OS 事实更新；PID 已复用绝不能停止新进程。
- 进程检查、日志访问、磁盘写入、权限失败均明确报错；损坏状态不静默当作空数据。
- 若无法在 Windows 安全实现“身份确认 + 同句柄终止”，即使已启动也只开放查看，禁止停止/重启，并明确显示受限原因。

不在 P0 建立通用跨进程锁交接框架、完整事务恢复引擎、端口级锁、全机索引或复杂故障注入平台。**简化机制不等于降低上述安全边界**。

## 6. 范围与阶段

| 阶段 | 交付 |
| --- | --- |
| P0 | 首次启动自动登记；全局列表/状态；已登记应用从任意目录启动；支持的受管 JVM 跨 Agent 会话存活、安全启停、分批日志；不兼容脚本只记录、不托管 |
| P0+（2026-10-20） | `manager ui` 本地只读管理台：list、status（含未结记录证据）、按批次日志 tail；无常驻、仅 127.0.0.1 + 一次性令牌（§2.2、AC08） |
| P1（按需） | 更友好的异常恢复、更多既有脚本托管适配、自动化就绪/JRebel 诊断（必须有实际证据） |
| P2（不预置） | 多实例、性能指标、远程管理（本地只读管理台已按 §2.2 收敛为 `manager ui`，不在此列） |

无需在 P0 实现外部 IDEA/Maven 进程发现；启动前可以调查**已知端口冲突**，但不是项目注册或生命周期接管。

## 7. 验收（实施后执行）

| ID | 通过条件 |
| --- | --- |
| AC01 | 首次由 Skill 启动自动记录；无手动注册；在两个工作目录/Agent 安装副本中读取一致，更新 Skill 不丢记录 |
| AC02 | 已登记停止的应用可跨目录复用配置启动；配置失效只重新分析目标项目；不依赖扫描全机 |
| AC03 | 真实 Windows Agent 会话退出后受管 JVM 继续运行；新会话能核验、查看日志并控制；未验证运行器不宣称兼容 |
| AC04 | 并发/重复启动同一应用最多一份受管实例；启动中断/UNKNOWN 不自动重复启动 |
| AC05 | PID 复用、伪造 runId、外部 IDEA/手工进程、身份不明时不误停；停止后再重启才允许起新 JVM |
| AC06 | 日志按运行批次可查询且有界；受管与非受管、存活与就绪、JRebel 是否验证分别展示，无虚假成功 |
| AC07 | 不改业务项目；普通 Java 模式无需 JRebel 配置；PR #5 单项目启动、JRebel 验证、只读日志查看（v2.2 起为 `manager ui`）、原 `.tmp` 日志继续可用 |
| AC08 | `manager ui` 默认不运行；启动后仅本机 127.0.0.1 可访问（无令牌），Host 不符一律 403；GET 只读展示 list、status（含未结记录证据）、统一日志源（批次/线索/.tmp）与项目文件（路径白名单、拒绝穿越与符号链接），启停仅 POST `/api/lifecycle`（与 CLI 同一实现）；Ctrl+C 后无残留服务与监听；数据损坏时原样报错 |
| AC09 | Linux（`ubuntu-latest`，无 pwsh）上 `start-new`（直连 node/python）→ `status`/`logs` → `stop`/`restart` 可用；安全停止使用 pidfd 锚定进程身份，pidfd 不可用时明确拒绝；命令模式经 `/bin/sh -c` 后代发现唯一目标；身份核验使用 `boot_id:starttime` + exe，PID 复用不误停；`.sh`/`#!` 脚本作为 exe 被拒绝；端口诊断可降级为仅端口；Windows 全量冒烟保持通过 |

验证优先使用**隔离 `--home` + 临时可控 JVM 应用**；不停止或改造现有业务服务。若 AC03/AC05 尚未实测，不得标为验收通过。

### 7.1 AC03 分层验证方法与当前结论

AC03 按三层递进取证，结论必须分层表述，不得用低层级证据冒充高层级：

| 层级 | 判据 | 当前结论 |
| --- | --- | --- |
| L1 父子脱离 | `start-new` 的 manager 进程退出后，`Get-Process -Id <pid>` 仍可查到受管 JVM，且其父 PID 已不存在 | **通过**（2026-10-19 实测） |
| L2 新会话核验 | manager 已退出时，用全新 node 进程执行 `status`（RUNNING + 创建时间/映像核验）、`logs`（读到本批次日志）、`stop`（进程消失、再查为 STOPPED）、`start`（重新起实例） | **通过**（2026-10-19 实测） |
| L3 真实会话退出 | 真实 pi/Agent 会话（run）结束后，受管 JVM 仍存活，且后续会话可核验/看日志/控制 | **通过**（2026-10-20 实测：真实嵌套 pi 会话 `pi --print` 内受管启动，会话正常退出后，会话外全新进程实测进程存活、`status=RUNNING` 身份一致、心跳日志跨退出连续、`stop` 生效转 STOPPED——四项判据全过，详见 evidence §4.5） |

L3 补验已于 2026-10-20 完成（执行方式、时间线与逐项证据见 `docs/verification/ac03-l1-l2-evidence.md` §4.5）：会话 A 为真实嵌套 pi 会话（`pi --print --no-session --tools bash`，真实模型+工具调用+正常退出），受管启动探针 JVM（runId=rmvghsoag-2e3f7277，pid=32908）；会话 A 正常退出后，会话外全新进程按 §4.3 判据 (a)–(d) 逐项实测全部满足。**AC03 三层全部通过，Managed 启动路径无需阻塞**。若未来更换运行器或宿主调度层（尤其新增 `KILL_ON_JOB_CLOSE` 包裹），须按同一判据重验后方可宣称 AC03 兼容。

Job Object 观测旁证（2026-10-19/20 两次实测合并；不构成 L3 通过依据，仅解释机制）：2026-10-19 观测到运行器 shell 所在 Job 的 `LimitFlags=0x800`（仅 `BREAKAWAY_OK`，无 `KILL_ON_JOB_CLOSE`），且受管 JVM 不是该 Job 成员；2026-10-20 L3 期间进一步用系统句柄表枚举取得全部可复制 Job 句柄（115 个），其 `LimitFlags=0x0`（均无 `KILL_ON_JOB_CLOSE`）且均不包含受管 JVM；包含受管 JVM 的 Job 属主为受保护进程，`LimitFlags` 仍不可读。各已知 Job 层均不连带回收后代；run 结束后的进程实测（存活且可控）为最终判据，已通过。

## 8. 决策记录

本 v2 来源于 `duyiliu/agent-skills` PR #6，按“只管理本 Skill 启动的项目、跨项目可见、避免另造 CLI 产品”收敛；删除全机发现、手动注册 CRUD、IDEA 接管与复杂通用恢复设计。本仓库为设计与实现的唯一维护源。管理器已按本设计实现并于 2026-10-17 完成合并后验收；后续修订以本文件为基线。

**v2.2（2026-10-20）**：移除按项目启动的单项目 `log-viewer`，日志与文件浏览能力并入 `manager ui` 统一入口——日志源选择器覆盖受管批次、非受管登记线索与 `root/.tmp` 兼容扫描；新增所选应用的项目文件只读浏览（路径白名单、拒绝穿越/符号链接、UTF-8 前 256 KB）；`manager ui` 默认固定 `127.0.0.1:8199`（`--port 0` 随机），重复启动探测已有实例并提示复用。这样保持“只有一个统一管理入口”的定位，避免同一机器上两套 Web 界面与端口竞争。

**v2.5（2026-10-20）**：CLI 能力补齐——新增 `remove`（移除登记：仅无存活受管实例时允许，RUNNING 核验存活一律拒绝（退出码 3），STARTING/UNKNOWN 未结记录按既有 ack 流程；只删注册表条目，runtime 记录与日志证据保留）与 `prune`（默认 dry-run，`--apply` 才删除；回收 `logs/<appId>/` 超保留期历史批次日志（与 PREV_RUNS_KEEP=20 对齐）、`locks/*.stale-*` 死锁残留与 `.tmp-*` 原子写孤儿临时文件；不删 current 运行日志与证据，不触碰 home 之外文件，损坏数据按 DATA_* 契约整体拒绝）；`logs` 接入与 ui 相同的统一日志源（`--src run:…|hint:<hash>|tmp:…` 复用 `resolveSource`、`--list-sources` 列出日志源、`--stream both` 双流合并）。

**v2.6（2026-10-20，issue #12 管理台体验增强）**：① `ui` 新增 `--open`：监听成功后用默认浏览器打开带令牌 URL；默认不开（Agent 前台拉起场景不期望弹浏览器），打开失败降级为仅打印 URL，不阻塞 ui；端口冲突时不拉浏览器。② 日志面板新增渲染层正则过滤输入框与「只看错误」开关（等价内置 errorPattern）：`lines` 数组保留全量、清空条件即恢复，增量 poll 新行按当前条件入视图，follow/滚动停止语义不变；无效正则给出标红与 meta 提示而非静默失效。③ 页面选择应用后 `history.replaceState` 回写 `?app=<别名>`，刷新保持选中。④ 未结记录（UNRESOLVED_RUN）告警中的 `start <alias> --ack-unresolved <runId>` 提供一键复制（`navigator.clipboard` 优先，选区 + `execCommand` 降级）。⑤ `document.title` 显示运行中应用数，如 `(2) Project Runner · 运行管理台`。

**v2.7（2026-10-22，Linux 支持）**：在 Windows 11 + pwsh 7 之外新增 Linux 支持（`/proc`，无 pwsh 依赖）；macOS 明确不支持并返回 `PLATFORM_UNSUPPORTED`。进程探针在 `lib/probe.mjs` 按平台分派，Windows 实现保持原位，Linux 使用 `lib/proc-linux.mjs`：
- 身份：`creationFileTime` 在 Linux 为不透明字符串 `<boot_id>:<starttime>`（starttime 取 `/proc/<pid>/stat` 第 22 字段），`image` 为 `/proc/<pid>/exe`（剥离 `" (deleted)"`，不可读时降级 `comm:<comm>`）；`Z`/`X`/`x` 视为已退出。
- 终止：通过 pidfd 锚定进程实例，再核验同 bootId+starttime+image 后发送 `SIGKILL`，有界等待退出；PID 复用不触碰新进程。
- 命令模式：Windows `cmd /d /s /c`，Linux `/bin/sh -c`；后代发现扫描 `/proc/*/stat` 的 ppid 树，`expectedImage` 按 exe basename（回退 comm）匹配。
- desc：Linux 允许无扩展名真实可执行文件，要求普通文件 + 可执行位；`#!` 脚本与 `.cmd`/`.bat`/`.ps1` 拒绝（脚本是包装进程）；`where`/`.exe` 补全/WindowsApps 检查仅 Windows。
- 端口诊断：Linux 解析 `/proc/net/tcp{,6}` 的 LISTEN inode，再扫 `/proc/*/fd` 反查 pid；权限不足时 `pid=null`，只报告监听。
- 安全终止：Linux 使用 `scripts/linux/pidfd-terminate.py`，以 pidfd 锚定进程实例后核验 `boot_id:starttime` + exe 并发送信号；需要 Python 3.9+、`os.pidfd_open`、`signal.pidfd_send_signal` 与内核 pidfd 支持。缺少任一能力时拒绝终止，不回退到存在 PID 复用竞态的 `process.kill(pid)`。
- 测试/CI：新增 `test/platform.mjs`；CI matrix `windows-latest` + `ubuntu-latest`，补齐 cli/runtime 冒烟。
Windows 行为与安全边界不变；同一 `--home` 不跨操作系统共享。

**v2.8（2026-10-23，命令模式可用性与探针开销修复）**：
- **已知启动器单链折叠（discover）**：`npm run dev`/`mvn spring-boot:run` 等场景中包装器与目标同映像且构成单链，原实现直接 `DISCOVERY_AMBIGUOUS`，与 SKILL/README 宫称的命令模式覆盖面不符（detect 给出的 npm 候选实际不可用）。两侧探针（`ps/proc.ps1` 与 `lib/proc-linux.mjs`）在 settle 后别除「是其他候选祖先且命令行命中已知启动器特征（npm-cli/yarn/pnpm/maven plexus-classworlds/gradle wrapper）」的候选；恰好利 1 个候选时折叠为真实目标。目标自身派生同映像子进程等其余同映像链结构上不可区分，仍按歧义拒绝，安全边界不变。回归：`runtime-smoke` 新增真实 `npm run dev` 用例，原歧义拒绝用例继续通过。另修复上游 `terminate-tree` 在 Windows 的必败 bug（PSCustomObject 不能直接赋值新属性 killedPids，改用 Add-Member）。
- **端口诊断单次调用**：`portOccupants` 在 Windows 原先 1 次 `port.ps1` + 每监听人 1 次 capture（N+1 次 pwsh 冷启动）。合并为 `proc.ps1 -Action port`（复用同进程已编译的 ProcUtil，identity.image 与 capture 同源，保持 #55 口径）；`ps/port.ps1` 移除。
- **核验短缓存（1.5s TTL）**：ui 同一轮询周期内 `/api/apps`（批量）与 `/api/status`（单条）重复核验同一运行，Windows 上每次都是 pwsh 冷启动。缓存仅存活结论，键含完整身份（pid+creationFileTime+image），终止类操作后主动失效；`cmdList` 同时复用单次 runtime 读取。
- **pidFile 契约补全**：log-writer spawn 失败时写 `pidFile=0` 并把错误原文落入 stderr 批次日志；manager 据此立即落 `SPAWN_FAILED`（STOPPED 可重试），不再等满窗口后误报 `IDENTITY_CAPTURE_FAILED`/UNKNOWN；pidFile 等待窗口 1s→5s（冷启动/杀毒扫描余量，文件出现即返回）。
- **follow 轮转重置**：`logs --follow` 检测到 `size < pos`（log-writer 已 rename 旧文件并重建同名新文件）时重置到新文件起始继续跟随并提示；旧尾部可用 `--src run:<runId>.<stream>.1` 查看。
- **ui 渲染窗口有界**：过滤激活时旧逻辑按「DOM 行数−缓存行数」修剪永不触发，长会话 DOM 无界增长；改为计数式上限（MAX_LINES），不再每 tick 全量 `querySelectorAll`。
- 其他：仓库根新增 `package.json`（engines + `npm test`/`npm run check` 聚合冒烟）；`decodeCmdOutput` 在无 GBK 解码器的 Node 上回退 lossy UTF-8。
