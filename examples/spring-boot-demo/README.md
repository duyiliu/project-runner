# Spring Boot 测试项目

供 Project Runner 验证项目识别、受管启动、全局管理台日志及 JRebel 热加载。独立 Maven 项目，使用 Java 17、Spring Boot 3.3.5，不依赖数据库、Redis、Nacos 或其他业务服务。

默认只监听 `127.0.0.1:18273`，不对局域网开放。不要用于生产。

## 编译和首次启动

在仓库根目录执行：

```bash
mvn -B -q -f examples/spring-boot-demo/pom.xml compile dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=target/dependency
```

然后让加载了 `project-runner` Skill 的 Agent 启动 `examples/spring-boot-demo`，建议别名 `runner-demo`。启动识别信息：

- `root` / `cwd`：本项目目录的绝对路径。
- 主类：`dev.projectrunner.demo.DemoApplication`。
- 直接 JVM classpath：`target/classes` 和 `target/dependency/*`，分隔符 Windows 为 `;`，Linux/macOS 为 `:`。
- 预期端口：`18273`。
- JRebel：使用本机已安装、已授权的 agent；Maven 资源过滤自动将 `rebel.xml` 中的项目路径展开为当前机器路径。
- 通过 `manager start-new --desc <本机描述文件>` 首次登记，不通过 `mvn spring-boot:run` 包装进程托管。

本机启动描述可放在 `.tmp/manager-desc.json`；它包含机器路径，不提交 Git。运行记录和受管日志保存在 manager 数据目录，不在本项目 `.tmp`。

## 已登记后管理

以下命令从仓库根目录执行；全局安装 Skill 时可将脚本路径替换为实际安装位置：

```bash
node skills/project-runner/scripts/manager.mjs start runner-demo
node skills/project-runner/scripts/manager.mjs status runner-demo
node skills/project-runner/scripts/manager.mjs logs runner-demo --lines 80
node skills/project-runner/scripts/manager.mjs stop runner-demo
```

需要观察日志与项目文件时另运行 `manager ui`：默认固定 `http://127.0.0.1:8199`，无令牌仅本机可访问，页面可显式二次确认启停/移除受管应用。`stop` 是身份核验后的强制终止，不承诺优雅关机。

## 接口检查

```bash
curl --fail http://127.0.0.1:18273/api/health
curl --fail 'http://127.0.0.1:18273/api/hello?name=Runner'
curl --fail -X POST 'http://127.0.0.1:18273/api/logs?level=INFO'
curl --fail -X POST 'http://127.0.0.1:18273/api/logs?level=WARN'
curl --fail -X POST 'http://127.0.0.1:18273/api/logs?level=ERROR'
```

- `GET /api/health`：返回 `status=UP`、应用名、PID 和时间。
- `GET /api/hello?name=Runner`：返回问候语和 `version`，可用来验证热加载。
- `POST /api/logs?level=INFO|WARN|ERROR`：产生固定示例日志；ERROR 附带刻意构造的异常堆栈，但不终止应用。
- 非法日志级别返回 HTTP 400；GET 不会触发日志写入接口。

## 热加载验证

先调用 `/api/health` 记录 PID，再修改 `DemoController.java` 的问候语或 `version`：

```bash
mvn -B -q -f examples/spring-boot-demo/pom.xml compile
```

等待至少 3 秒，再访问 `/api/hello`，确认新结果生效，同时 `/api/health` 的 PID 不变，日志出现 `Reloading class`。不要为了验证 Java 方法修改而重启 JVM。

`target/`、`.tmp/` 已在项目级 `.gitignore` 中忽略。构建需要可用的 Maven 依赖仓库；没有有效 JRebel 许可时，不应声称已验证热加载。
