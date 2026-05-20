<!-- markdownlint-disable MD060 -->

# Logging — Spec

本文档描述 lordcode 中**日志系统**的总体设计，作为后续实现的依据。

---

## 1. 概述

本迭代为 lordcode 引入统一的日志能力，包含三件事：

1. **统一 logger 抽象**：抽出 `@lordcode/logger` 包，server 与 tui 共用同一套接口；支持多输出去向、可派生子 logger。
2. **文件输出**：所有日志默认写入 `~/.lordcode/logs/debug.log`；不再写 stdout / stderr，避免与 Ink TUI 抢屏。
3. **开发开关**：环境变量 `LORDCODE_DEBUG=1` 控制等级；`pnpm dev` / `pnpm dev:server` 脚本默认设上。

同时**预留**第二期 session 持久化所需的架构钩子（多 transport、`tee`、独立 close 语义），本迭代**不**实现。

---

## 2. 目标 & 范围

### In Scope

- 新建 `@lordcode/logger` 包，导出 `Logger` 接口、`createLogger`、`consoleTransport`、`fileTransport`。
- `Logger` 实现：`debug` / `info` / `warn` / `error` / `child` / `tee` / `close`。
- 文件 transport：`O_APPEND` 模式 `createWriteStream`；启动时写 run header；进程退出 flush + close。
- `~/.lordcode/logs/` 目录路径常量与 `mkdir -p`。
- 启动时 50MB 兜底轮转（覆盖式 `.old`）。
- `LORDCODE_DEBUG` 开关；dev 脚本接入 `cross-env`。
- server 端 `app.ts` / `server.ts` / `worker.ts` / `routes/*` / `agent/*` / `config/*` 全部接入新 logger，删除 `packages/server/src/lib/logger.ts`。
- TUI 端通过 React Context 暴露 logger，`api/client.ts` 与 `components/App.tsx` 接入。
- 12 个 channel 命名落地（见 §9）。

### Out of Scope（明确不做）

- **session 持久化**与**每 session 一份独立日志文件**（架构预留，二期实现）。
- 日志轮转的"完整"形态（按时间归档、保留 N 份）。仅做单文件 50MB 兜底。
- 结构化输出格式（JSON Lines / logfmt）。本迭代仅 human-readable 文本格式。
- 日志上传 / 远端 sink。
- 在 TUI 内做日志查看面板。
- web 包接入（接口设计兼容，不做具体实现）。
- 自动从异常 stack 推导 channel。

---

## 3. 关键设计决策

| #   | 决策 | 选择 | 理由 |
| --- | --- | --- | --- |
| 1 | 输出位置 | **文件**（`~/.lordcode/logs/debug.log`），不写 stdout / stderr | TUI 通过 stdout 渲染 Ink；stderr 默认也落到同一终端，同样会撕裂渲染。文件输出是 TUI 类应用的事实标准（neovim / lazygit / k9s 同款） |
| 2 | dev / release 区分 | **不区分日志行为**，只在 run header 标 `mode=dev\|release`；行内不重复 | 一份文件、一套行为，最少心智负担；mode 仅用于读日志时回溯"这条来自哪种构建" |
| 3 | 开关 | `LORDCODE_DEBUG=1` → `level=debug`；否则 `level=info`；`warn` / `error` 总输出 | 显式 env，prod 也能临时开调试；和已有 `LORDCODE_LOG_LEVEL`/`LORDCODE_PORT`/`LORDCODE_HOME` 风格一致 |
| 4 | dev 脚本默认 | `pnpm dev` / `pnpm dev:server` 通过 `cross-env LORDCODE_DEBUG=1` 默认设上 | 新人 clone 即用；`LORDCODE_DEBUG=0` 可显式关 |
| 5 | mode 来源 | `mode = (LORDCODE_DEBUG === "1") ? "dev" : "release"` | 不引入 `NODE_ENV`，少一个变量 |
| 6 | logger 包归属 | 新建 `@lordcode/logger` | server 与 tui 都依赖；放任一侧都让依赖关系别扭；shared 包目前是纯 types 不引入 node 模块 |
| 7 | TUI 与 server 写同一文件 | **各自 `createWriteStream(path, { flags: "a" })`** | POSIX `O_APPEND` 单次 < `PIPE_BUF`（macOS 512B / Linux 4KB）的 `write(2)` 是原子的；普通行不会撕裂；超长行（极少数）有撕裂风险但可接受 |
| 8 | TUI 内 logger 传递 | **React Context** + `useLogger()` hook | 测试好替换；React 风格；组件层级会增长，避免 prop drilling |
| 9 | channel 表达 | 路径式 + `:` 分隔（如 `server:agent:stream`），通过 `child(name)` 派生 | grep 友好；调用点决定下沉粒度；child 自动拼接 |
| 10 | channel 取值约束 | 默认必须是**有限静态集合**；唯一例外是 **resource id**（session id、request id） | grep 过滤价值依赖有限集；属性类（model 名、文本长度）走 `meta` |
| 11 | 多输出去向 | **一期：单 file transport**；架构上 `transports` 是数组 | 二期 session 持久化可平滑加 transport，无需改一期代码 |
| 12 | `tee(transport)` API | **一期就实现**，对外可用 | 实现成本接近零；接口"完整"才能写测试覆盖；二期 session 直接用 |
| 13 | `close()` 语义 | 每个 logger 节点只 close 自己**新引入**的 transport（不递归到父） | session 结束 close 自己的 file，不能误关全局 `debug.log` |
| 14 | 第三方库噪音 | 接管：`hono/logger` 输出转接到 `server:http` channel | 一处看全 |
| 15 | 文件轮转 | **不做完整轮转**；启动时若 `debug.log > 50MB`，`mv` 成 `debug.log.old`（覆盖旧 `.old`）后开新 | 本地 dev 工具，磁盘可控；零依赖；后续真有需要再上 `pino-roll` |
| 16 | 日志格式 | run header + `[UTC+8 ISO] level [channel] message [meta]` | human-readable 优先；行内 `meta` 用 `key=value`，便于 grep |
| 17 | session 文件位置 *(二期)* | `~/.lordcode/logs/sessions/<session-id>.log` | 与 `debug.log` 同根；目录路径常量一期就定 |
| 18 | session 日志写入策略 *(二期)* | **双写**：同时进 `debug.log`（全局视图）和 `sessions/<id>.log`（单 session 视图） | `debug.log` 保留全局时序；session 文件聚焦单对话；以 `tee` 实现 |
| 19 | session id 格式 *(二期)* | `<YYYYMMDDTHHmmss>-<short-random>`，例 `20260509T150300-a1b2` | 文件名直接看出时间；ULID/UUID 也可，但人眼识别差 |

---

## 4. 术语

由于"session"等词在不同语境下含义不同，本节统一定义。后文严格按这里的口径用。

| 术语 | 含义（在本设计中） |
| --- | --- |
| **logger** | 一个具体的实例（不是日志系统整体）。每个 logger 持有：一组 transports、一个 channel 路径、一个 level。通过 `child` / `tee` 派生。 |
| **transport** | 日志的**出口**。一个 transport 拿到一行已经格式化好的字符串，决定它最终落到哪（文件、console）。一个 logger 可以有多个 transport（fan-out）。 |
| **fan-out** | 一行日志被同一 logger 同时写到多个 transport。例：二期 session logger 同时写 `debug.log` 和 `sessions/<id>.log`。 |
| **channel** | 日志的**分类路径**，由 `:` 分隔的若干段组成。例 `server:agent:stream`。仅用于"这条日志属于哪个模块"的过滤，不承载属性数据。 |
| **meta** | 一条日志附带的结构化字段对象 `{ key: value, ... }`，承载动态属性（model 名、文本长度等）。与 channel 正交。 |
| **level** | 日志严重程度档位，`silent` / `info` / `debug` 三档。`silent` 表示完全静默；`info` 输出 info / warn / error；`debug` 输出全部。 |
| **mode** | 进程的"构建/运行身份"，`dev` 或 `release`，由 `LORDCODE_DEBUG` 推导。**仅用于 run header 标注**，不影响 logger 行为。 |
| **run** | **一次进程从启动到退出的生命周期**。每次启动写一行 run header 到日志文件。一个 run 内可能包含 0 到 N 个 session（二期）。 |
| **run header** | 一次 run 开始时写入日志文件的头一行，格式见 §6.1。**注意**：这里的"header"对应的是 run，不是 session。 |
| **session** *(二期概念)* | **一次用户与 agent 的对话**（用户消息 + agent 回复构成的列表）。可以被持久化、被 resume。一个 run 内可同时存在多个 session（未来若支持）。 |
| **child(name)** | 派生维度 1：在 channel 路径末尾追加一段。父子**共享**同一组 transports 和 level。 |
| **tee(transport)** | 派生维度 2：在父的 transports 集合上**追加**一个新 transport。channel 路径不变。命名取自 Unix `tee(1)` 命令。 |
| **POSIX atomic append** | 当多个 writer 用 `O_APPEND` 模式打开同一文件时，**单次 `write(2)` 系统调用**，只要长度 ≤ `PIPE_BUF`（Linux 4096 / macOS 512），保证不会与其他 writer 的写交错。Node 的 `fs.WriteStream` 一次 `.write()` 会触发一次 `write(2)`，所以单行日志（< 512B）安全。 |
| **transport 句柄所有权** | "谁通过 `tee` 把 transport 加进来，谁负责 `close` 它"。`createLogger` 时传入的 transports 由调用方在进程结束时 close；通过 `tee` 派生的子 logger，自己 `close()` 时只关自己加进来的那一个。 |

---

## 5. 架构总览

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                         Node.js Process (one "run")                       │
│                                                                            │
│  ┌──────────────────────────────┐         ┌──────────────────────────┐   │
│  │     Main Thread (TUI)         │         │   Worker Thread (server)  │   │
│  │                               │         │                           │   │
│  │  createLogger({               │         │  createLogger({           │   │
│  │    level, transports:[file]   │         │    level, transports:[file]│   │
│  │  }).child("tui")              │         │  }).child("server")       │   │
│  │      │                        │         │      │                    │   │
│  │      ▼                        │         │      ▼                    │   │
│  │  <LoggerProvider>             │         │  pass into createApp({    │   │
│  │    └─ useLogger() in:         │         │       logger, ... })      │   │
│  │       App, api/client, ...    │         │      │                    │   │
│  └───────────┬───────────────────┘         │      ▼                    │   │
│              │                              │  routes/*, agent/*       │   │
│              │ both write via               │  via .child(...)         │   │
│              │ POSIX O_APPEND               └──────────┬───────────────┘   │
│              │                                         │                    │
│              ▼                                         ▼                    │
│      ┌─────────────────────────────────────────────────────────┐          │
│      │          ~/.lordcode/logs/debug.log                       │          │
│      │ === run start <iso> mode=dev pid=N version=X ===          │          │
│      │ [iso] info  [tui:boot] starting worker                    │          │
│      │ [iso] info  [server:boot] listening on http://...         │          │
│      │ [iso] debug [server:agent:stream] chunk type=text-delta   │          │
│      │ ...                                                        │          │
│      └─────────────────────────────────────────────────────────┘          │
│                                                                            │
│      ┌─────────────────────────────────────────────────────────┐          │
│      │  二期：~/.lordcode/logs/sessions/<session-id>.log          │          │
│      │  通过 logger.tee(fileTransport(...)) 派生，与 debug.log     │          │
│      │  fan-out 双写                                              │          │
│      └─────────────────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────────────────┘
```

要点：

- **每个线程独立 `createLogger`**。worker 收到主线程 postMessage 的启动参数（含 `debugLogPath`、`level`、`mode`），自己开自己的 file transport。
- **两线程的 file transport 写同一个文件**。靠 POSIX atomic append 保证单行不交错。
- **每次进程启动**只在主线程写 **一次** run header（见 §10.1）。worker 不再单独写 run header，避免重复。

---

## 6. 日志格式

### 6.1 Run header

每次 lordcode 进程启动，**主线程**在打开 file transport 后写入一行：

```text
=== run start 2026-05-09T21:10:00.123+08:00 mode=dev pid=12345 version=0.0.0 ===
```

字段：

| 字段 | 含义 | 取值 |
| --- | --- | --- |
| `<iso>`（无字段名前缀） | 进程启动时间，UTC+8 ISO-8601，毫秒精度 | 固定 `+08:00` offset |
| `mode` | 见 §4 | `dev` 或 `release` |
| `pid` | 主进程 pid | `process.pid` |
| `version` | lordcode 版本 | 来自 `packages/server/src/version.ts` |

无 "run end" 行。进程崩溃也不需要兜底 —— 下一次 run start 出现就意味着上一段结束。

### 6.2 普通日志行

```text
[<iso>] <level> [<channel>] <message> [<key>=<value> ...]
```

约束：

- `<iso>` 同 run header 的格式。
- `<level>` 五字符宽度对齐：`debug`、`info`（补 1 空格）、`warn`（补 1 空格）、`error`。
- `<channel>` 完整路径，例 `server:agent:stream`。channel 为空时省略 `[]`（仅 root logger，不应出现在生产日志）。
- `<message>` 自由文本，**不允许包含换行**（写入前 `replace(/\n/g, " ")`）。
- `<key>=<value>` 来自 meta 对象。value 经 `JSON.stringify` 后去掉外层引号；含空格 / 特殊字符时整体加引号。`error` 级若带 `Error` 对象，附 `err="<message>"`，并把 `stack` 行作为续行（每行加 `  `（两空格）缩进）。

示例：

```text
[2026-05-09T21:10:00.456+08:00] info  [server:boot] server listening url=http://127.0.0.1:54321
[2026-05-09T21:10:01.789+08:00] debug [server:agent:stream] chunk type=text-delta len=42
[2026-05-09T21:10:02.111+08:00] error [server:route:agent] streamAgent failed err="model timeout"
  Error: model timeout
      at streamText (...)
      at ...
[2026-05-09T21:10:03.222+08:00] debug [tui:ui] user pressed enter input="hello"
```

### 6.3 行长与原子性

- 单行（含换行符）必须 ≤ 512 字节才保证不与 worker 的写交错。
- `meta` 中超长字段（如完整 message 内容）应在调用点截断，例 `{ preview: text.slice(0, 200) }`。
- error 的 stack 续行**不要求原子**：stack 里的行可能与其他线程交错；read 时按 `[<iso>] level` 开头的行重新对齐即可。

---

## 7. Logger API 详解

### 7.1 `LogLevel`

```ts
export type LogLevel = "silent" | "info" | "debug";
```

排序：`silent < info < debug`。`level` 决定**触发**哪些方法的写入：

| 方法 | `silent` | `info` | `debug` |
| --- | --- | --- | --- |
| `debug` | ✗ | ✗ | ✓ |
| `info`  | ✗ | ✓ | ✓ |
| `warn`  | ✗ | ✓ | ✓ |
| `error` | ✗ | ✓ | ✓ |

**注**：`warn` / `error` 在 `info` 级也会写出（即"等同 info 等级"）。**只有 `silent` 才完全静默**。

### 7.2 `LogTransport`

```ts
export interface LogTransport {
  /** 写入一行已格式化字符串。**实现必须自己负责追加换行符**（如果有需要）。 */
  write(line: string): void;
  /** 关闭底层资源（文件句柄）。可异步。幂等。 */
  close(): Promise<void> | void;
}
```

内置实现：

| 函数 | 用途 |
| --- | --- |
| `consoleTransport()` | 写到 `process.stderr`（**不是 stdout**），可选用于无 TUI 场景或单元测试 |
| `fileTransport(path: string)` | 用 `fs.createWriteStream(path, { flags: "a" })` 打开，调用方需保证父目录存在；`close()` 等待 `'finish'` 事件 |

### 7.3 `Logger`

```ts
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info (message: string, meta?: Record<string, unknown>): void;
  warn (message: string, meta?: Record<string, unknown>): void;
  /** err 可以是 Error / 字符串 / 任意。Error 的 message + stack 会附在行内 / 续行。 */
  error(message: string, err?: unknown, meta?: Record<string, unknown>): void;

  /** 派生一个子 logger，channel 路径末尾追加 `:name`；transports 与父共享。 */
  child(name: string): Logger;

  /**
   * 派生一个子 logger，transports = [...父.transports, transport]；channel 不变。
   * 子 logger `close()` 时只关 `transport`，不关父的。
   */
  tee(transport: LogTransport): Logger;

  /**
   * 关闭本节点**新引入**的 transport（即 `tee` 加进来的那一个）。
   * 对 root logger（`createLogger` 直接产物）调用：关闭其构造时传入的所有 transports。
   * 对 `child` 派生的 logger 调用：no-op（child 没新引入 transport）。
   * 幂等。
   */
  close(): Promise<void>;
}
```

### 7.4 `createLogger`

```ts
export function createLogger(opts: {
  level: LogLevel;
  transports: LogTransport[];
  /** 默认 [] (root, 无 channel)；一般不直接传，用 .child() 派生 */
  channel?: string[];
}): Logger;
```

### 7.5 行为细节

- 多个 transport 写入顺序按数组顺序，**串行同步调用** `write()`。任一 transport 抛错被捕获并 `console.error` 到 stderr（最后兜底），不影响其他 transport。
- `child` / `tee` 的实现是**轻量**的：不复制状态，新 logger 持有父的引用 + 自己新增的部分。
- meta 序列化失败（循环引用等）时，对应 key 的 value 写为 `<unserializable>`，不抛错。

---

## 8. 模块拆分

### 8.1 `@lordcode/logger`（新包）

新增 `packages/logger/`：

| 文件 | 职责 |
| --- | --- |
| `package.json` | name `@lordcode/logger`；type module；exports `.` 和 `./node`（区分纯接口与依赖 `node:fs` 的 `fileTransport`） |
| `src/index.ts` | export `Logger`、`LogLevel`、`LogTransport`、`createLogger`、`consoleTransport` |
| `src/node.ts` | export `fileTransport`（依赖 `node:fs`） |
| `src/format.ts` | 内部：`formatLine(level, channel, msg, meta, err?)`、`formatRunHeader(...)` |
| `src/logger.ts` | 内部：`createLogger` 实现，`child` / `tee` / `close` |
| `src/transports/file.ts` | `fileTransport` 实现 |
| `src/transports/console.ts` | `consoleTransport` 实现 |
| `src/*.test.ts` | 单测（vitest） |
| `tsconfig.json` / `tsconfig.dev.json` | 跟 server 包同款 |

依赖：仅 `@types/node`（dev）。运行时零依赖。

### 8.2 `@lordcode/server` 改动

| 文件 | 改动 |
| --- | --- |
| `src/lib/logger.ts` | **删除**。原有的 `Logger` / `LogLevel` 改为从 `@lordcode/logger` import |
| `src/server.ts` | `StartServerOptions` 增 `logger: Logger`（必填，由 worker 传入）；不再调用旧 `createLogger`；`logger.info("server listening url=...")` 走新格式 |
| `src/worker.ts` | 收到 `workerData` 中新增的 `debugLogPath`、`level`、`mode`；调用 `createLogger({ level, transports: [fileTransport(debugLogPath)] }).child("server")`；启动失败把 `err.message` 既发回主线程又写一行 `error` 到日志 |
| `src/main.ts` | server-only 入口；自己也走 `createLogger` + `fileTransport`；写 run header（与 TUI 模式互斥使用） |
| `src/app.ts` | `AppDeps.logger` 已存在，类型改为 `@lordcode/logger`；`hono/logger` 中间件转发到 `logger.child("http")`，所以最终 channel 是 `server:http` |
| `src/routes/agent.ts` | 接收 `deps.logger`，内部 `const log = deps.logger.child("route").child("agent")` |
| `src/routes/models.ts` | 同上，`...child("route").child("models")` |
| `src/routes/health.ts` | 同上（一期可不写日志） |
| `src/agent/stream.ts` | 接受可选 `logger` 参数（向后兼容，测试不传），channel 由调用方注入；调用点写 `log.debug("chunk", { type: chunk.type, ... })` 替代 HACK 注释里描述的事件 |
| `src/agent/provider.ts` | 解析失败时 `log.error(...)`（channel `server:agent:provider` 由调用方注入） |
| `src/agent/apiKey.ts` | apiKey 来源记录 `log.debug("apiKey resolved", { source: "env" \| "plain", env: cfg.apiKeyEnv })`；**绝不打 key 本身** |
| `src/config/store.ts` / `src/config/schema.ts` | 加载/校验失败 `log.error(...)`（channel `server:config`） |
| `src/config/paths.ts` | 新增 `getLogsDir()` / `getDebugLogPath()` / `getSessionsLogDir()`（最后一个仅二期使用，先定常量）；`ensureLogsDir()` |
| `package.json` | 新增 dep `@lordcode/logger: "workspace:*"` |

### 8.3 `@lordcode/tui` 改动

| 文件 | 改动 |
| --- | --- |
| `src/lib/logger-context.tsx` *(新)* | `LoggerProvider`、`useLogger()`；context 默认值是个 no-op logger，避免没 Provider 时崩 |
| `src/main.tsx` | 启动时：决定 `mode` / `level` / `debugLogPath`；`ensureLogsDir()`；`rotateIfHuge(debugLogPath)`（见 §12.3）；`createLogger(...)` → `child("tui")`；写 run header；`startServerWorker({ debugLogPath, level, mode, ... })`；`<LoggerProvider logger={tuiLogger}>` 包住 `<App>`；进程退出前 `await tuiLogger.close()` |
| `src/server-host.ts` | `ServerWorkerOptions` 扩字段 `debugLogPath: string`、`level: LogLevel`、`mode: "dev" \| "release"`；不再硬编码 `logLevel: "silent"`；移除 `silent` 默认 |
| `src/api/client.ts` | 顶层导出工厂改为 `createApiClient(baseUrl, logger?)`；内部 `const log = logger?.child("api") ?? noopLogger`；记录请求/响应/SSE 帧 |
| `src/components/App.tsx` | `const log = useLogger().child("ui")`；关键路径打 debug |
| `package.json` | 新增 dep `@lordcode/logger: "workspace:*"` |

### 8.4 `@lordcode/shared` 改动

`ServerWorkerOptions` 扩字段：

```ts
export interface ServerWorkerOptions {
  port: number;
  host: string;
  /** @deprecated 由 debugLogPath + level 替代；保留一版兼容期可移除 */
  logLevel?: "silent" | "info" | "debug";
  /** 新增：worker 自己开 file transport 写入此路径 */
  debugLogPath: string;
  /** 新增：worker 内部 logger 的 level */
  level: "silent" | "info" | "debug";
  /** 新增：仅供 worker 自己输出诊断（如初始化失败）时使用，**不写 run header** */
  mode: "dev" | "release";
}
```

### 8.5 根 `package.json` 改动

```jsonc
{
  "scripts": {
    "dev":         "cross-env LORDCODE_DEBUG=1 pnpm --filter @lordcode/tui dev",
    "dev:server":  "cross-env LORDCODE_DEBUG=1 pnpm --filter @lordcode/server dev",
    "build":       "pnpm -r --filter './packages/*' build",
    // ...
  },
  "devDependencies": {
    "cross-env": "^7.0.3"
    // ...
  }
}
```

`packages/logger/` 也要加进 pnpm workspace（如果 workspace glob 还没覆盖，确认 `pnpm-workspace.yaml`）。

---

## 9. Channel 命名清单

落地的 12 个 channel（顶层只有 `tui` 和 `server` 两个 root，其它通过 `child` 派生）：

**TUI 侧**（root: `tui`）：

| channel | 覆盖 | 主要日志内容 |
| --- | --- | --- |
| `tui:boot` | `main.tsx`, `server-host.ts` | worker 启停、shutdown 流程、致命错误 |
| `tui:api` | `api/client.ts` | HTTP 请求/响应、SSE 帧解析 |
| `tui:ui` | `components/App.tsx` | 用户输入、命令分发、流式渲染状态 |
| `tui:cmd` | `lib/commands.ts` | 命令解析失败 / 警告 |

**Server 侧**（root: `server`）：

| channel | 覆盖 | 主要日志内容 |
| --- | --- | --- |
| `server:boot` | `main.ts`, `worker.ts`, `server.ts` | 监听端口、shutdown、worker 消息 |
| `server:http` | `app.ts`（`hono/logger` 转接） | 请求级中间件 |
| `server:route:agent` | `routes/agent.ts` | `/agent/chat` 入口、abort、错误返回 |
| `server:route:models` | `routes/models.ts` | `/models` 系列 |
| `server:route:health` | `routes/health.ts` | （一期可空） |
| `server:agent:stream` | `agent/stream.ts` | 流帧分发、SDK 兼容 hack 触发、finishReason / usage |
| `server:agent:provider` | `agent/provider.ts` | model 解析失败 |
| `server:agent:apikey` | `agent/apiKey.ts` | apiKey 来源（**不打 key 本身**） |
| `server:config` | `config/*.ts` | 配置加载 / 校验失败、写回 |

**约束**（重申）：

- channel 段必须是有限静态集合。**唯一例外**：resource id（`session id`、`request id`），允许出现，例 `server:session:abc123:agent:stream`（二期）。
- 属性数据（model 名、文本长度、用户输入内容）一律走 `meta`。

---

## 10. 关键数据流

### 10.1 TUI 模式启动

```text
main()
  ├─ readEnv: LORDCODE_DEBUG → debug? → level/mode
  ├─ ensureLogsDir(~/.lordcode/logs)
  ├─ rotateIfHuge(~/.lordcode/logs/debug.log)
  ├─ const fileT = fileTransport(debugLogPath)
  ├─ const root = createLogger({ level, transports: [fileT] })
  ├─ root.transports[0].write(formatRunHeader({ mode, pid, version }))   ← 唯一一次 run header
  ├─ const tuiLog = root.child("tui")
  ├─ startServerWorker({ debugLogPath, level, mode, port, host })
  │    └─ worker:
  │         ├─ const wfileT = fileTransport(debugLogPath)
  │         ├─ const wroot = createLogger({ level, transports: [wfileT] })
  │         │   ← worker **不写** run header
  │         ├─ const log = wroot.child("server")
  │         └─ startServer({ logger: log, ... })
  │              └─ log.child("boot").info("server listening", { url })
  ├─ render(<LoggerProvider logger={tuiLog}><App /></LoggerProvider>)
  └─ on shutdown:
       ├─ ink.unmount()
       ├─ await handle.shutdown()
       └─ await root.close()    ← 关闭主线程的 fileT
```

### 10.2 server-only 模式启动 (`pnpm dev:server`)

```text
main.ts
  ├─ readEnv → level / mode / debugLogPath
  ├─ ensureLogsDir; rotateIfHuge
  ├─ const root = createLogger({ level, transports: [fileTransport(...)] })
  ├─ root.transports[0].write(formatRunHeader({ mode, pid, version }))
  ├─ const log = root.child("server")
  ├─ await startServer({ logger: log, ... })
  └─ on SIGINT/SIGTERM:
       ├─ await running.close()
       └─ await root.close()
```

### 10.3 一行日志的写入路径

```text
log.debug("chunk", { type: "text-delta", len: 42 })
  └─ if level allows debug:
       └─ line = formatLine("debug", "server:agent:stream",
                            "chunk", { type: "text-delta", len: 42 })
       └─ for t of this.transports:
            └─ t.write(line + "\n")
                 └─ fileTransport: writeStream.write(line + "\n")
                      └─ Node 一次 write(2) 系统调用（O_APPEND atomic if < PIPE_BUF）
```

### 10.4 二期 session 接续点（**架构示意，不实施**）

```text
// 当 SessionManager 出现后
const sessionFileT = fileTransport(getSessionsLogDir() + `/${sessionId}.log`)
const sessionLog   = serverLog.tee(sessionFileT).child("session").child(sessionId)
//                  ↑ transports = [debugLog, sessionFile]; channel = "server:session:abc123"

sessionLog.debug("turn started", { messages: msgs.length })
//   ├─ 写 debug.log     （来自父的 transport）
//   └─ 写 sessions/abc123.log （新加的 transport）

// session 结束
await sessionLog.close()    // 只关 sessionFileT，**不关** debug.log
```

---

## 11. 环境变量

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `LORDCODE_DEBUG` | unset (= `0`) | `1` 时 `level=debug` + `mode=dev`；其他值视为关 |
| `LORDCODE_DEBUG_LOG` | `~/.lordcode/logs/debug.log` | 覆盖日志文件路径（绝对路径） |
| `LORDCODE_LOG_LEVEL` | （**移除**） | 由 `LORDCODE_DEBUG` 取代；server `main.ts` 中删除该读取 |
| `LORDCODE_HOME` | （已存在） | 决定 `~/.lordcode/` 根目录；日志路径也跟着走 |
| `LORDCODE_PORT` / `LORDCODE_HOST` | （已存在） | 不变 |

---

## 12. 边界情况 / 错误处理

### 12.1 文件无法写入（权限 / 磁盘满）

- `ensureLogsDir` 失败：抛错到进程入口，写到 `process.stderr` 后退出码 1。
- `fileTransport` `write` 内部错误：`writeStream.on("error")` 捕获，**降级**到 `process.stderr.write` 一行 `[lordcode logger] file write failed: <msg>`，后续日志行也走 stderr 直到进程结束。**不**让用户看到 TUI 崩溃。
- TUI 在文件不可写时还是能正常运行，只是丢失日志。

### 12.2 跨进程 / 跨线程并发

- 主线程与 worker 各自 `O_APPEND` 写同一文件：单行 ≤ 512B 不交错（§4 POSIX atomic append 条目）。
- 两个 lordcode 进程同时跑（用户多开终端）：同样 OK，只要每条 ≤ 512B。
- run header 由不同进程写入会交错出现，但每行本身仍原子，读日志的人能看出有多个 run。

### 12.3 启动时 50MB 兜底轮转

```ts
async function rotateIfHuge(path: string, maxBytes = 50 * 1024 * 1024) {
  try {
    const s = await stat(path);
    if (s.size > maxBytes) await rename(path, `${path}.old`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
```

- 永远只占用 ≤ 100 MB（current + `.old`）。
- `.old` 之前的内容被覆盖，无历史归档。
- 不引入任何依赖。

### 12.4 `LORDCODE_DEBUG=1` 但 `level=silent` 显式覆盖？

不支持。**`LORDCODE_DEBUG` 是一对一映射**到 level（`1` → debug；其他 → info）。要静默必须改源码 / 删日志文件，不提供 silent 的 env 入口。理由：避免出现"我设了 DEBUG=1 却没日志"的迷惑。

### 12.5 第三方库的 `console.*` 呢？

不接管。`hono/logger` 已经能拿到回调，转接到 logger；其它库（如 ai SDK）若 `console.log`，仍然会去 stdout / stderr 撕裂 TUI —— 这是**现有问题**，不是本迭代回归。后续若有具体哪个库噪音影响 TUI，再单独处理。

### 12.6 unhandled rejection / uncaughtException

入口 `main.tsx` / `main.ts` 注册：

```ts
process.on("uncaughtException",  (err) => log.error("uncaughtException", err));
process.on("unhandledRejection", (err) => log.error("unhandledRejection", err));
```

不阻止默认行为（仍然会按 Node 默认退出），只是确保事故有日志记录。

---

## 13. 二期接续点（session 持久化）

本节列出**一期不做但已经预留好**的内容，二期实现时只需"接上"，不需要改一期代码：

| 接续点 | 一期已就位 | 二期补完 |
| --- | --- | --- |
| 多 transport 数据结构 | `transports: LogTransport[]` 是数组，目前只放一个 | 通过 `tee` 在数组里追加 session 专属 transport |
| `tee(transport)` API | 已实现，已测试 | 直接调用 |
| `close()` 不递归语义 | 已定义 + 已实现 | session 结束直接 `sessionLog.close()` |
| 路径常量 | `getSessionsLogDir()` 已存在 | `mkdir -p` + 拼 session id 作为文件名 |
| channel 命名约束 | session id 作为"resource id 例外"已声明 | 用 `child("session").child(sessionId)` |
| session id 格式 | 已定 `<YYYYMMDDTHHmmss>-<short-random>` | 实现 generator |
| 双写策略 | 由 `tee` + `child` 组合表达，无需额外机制 | — |

---

## 14. 不在本迭代

- session 持久化（用户对话数据落盘）
- 每 session 一份独立日志文件（架构预留，§13）
- 完整日志轮转（按时间归档、保留 N 份）
- 结构化输出（JSON Lines、logfmt）
- 日志查看面板 / `/log` 命令
- 远端 sink、上报
- web 包接入

---

## 15. 验收标准

- [ ] 新建 `packages/logger/`，可 `pnpm --filter @lordcode/logger build` 通过；含单元测试覆盖 `child` / `tee` / `close` / `level` 过滤 / meta 序列化 / 错误兜底。
- [ ] `pnpm dev` 启动 TUI 后，`~/.lordcode/logs/debug.log` 出现且首行是合规的 run header（`mode=dev`），后续可看到 `[server:boot]` 与 `[tui:boot]` 的 info 日志。
- [ ] `pnpm build && node packages/tui/dist/main.js` 启动后，run header 显示 `mode=release`，level 默认为 `info`（无 debug 行）。
- [ ] `LORDCODE_DEBUG=1 node packages/tui/dist/main.js` 启动后 `mode=dev`，能看到 debug 行。
- [ ] `LORDCODE_DEBUG=0 pnpm dev` 启动后 `mode=release`，无 debug 行。
- [ ] TUI 启动后 stdout / stderr **没有任何**未预期日志输出；Ink 渲染无撕裂。
- [ ] `tail -f ~/.lordcode/logs/debug.log` 在 chat 过程中能看到 `[server:agent:stream]` 的逐 chunk debug 行（开 debug 时）。
- [ ] 主线程与 worker 同时写入大量短行（< 200B），最终文件里**每一行**都能匹配行格式正则（无撕裂）。
- [ ] 杀 disk 空间到 0 模拟 write 失败：TUI 不崩；stderr 出现一行 fallback 提示；恢复空间后日志可继续（重启进程后）。
- [ ] 写到 60MB 后重启 TUI：`debug.log.old` 出现，新 `debug.log` 从 run header 重新开始。
- [ ] 删除 `packages/server/src/lib/logger.ts` 后，整库 `pnpm typecheck` 通过。
- [ ] `LORDCODE_DEBUG_LOG=/tmp/foo.log pnpm dev` 后日志写入指定路径而非默认位置。
- [ ] **二期预留检查**：手写一段最小代码 `serverLog.tee(fileTransport("/tmp/x.log")).child("session").child("test").info("hi")`，能在 `/tmp/x.log` 与 `debug.log` 同时看到该行；调用其 `close()` 后只关 `/tmp/x.log`，`debug.log` 句柄仍可用。
