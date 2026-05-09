<!-- markdownlint-disable MD060 -->

# @lordcode/logger

lordcode 内部使用的轻量级 logger。运行时零依赖，TUI 与 server 共用一套接口。

设计完整版见 [`docs/spec/log/design.md`](../../docs/spec/log/design.md)，本文只覆盖**怎么用**。

## 主要特性

- **多输出去向**：一个 logger 可以同时写到文件、stderr，等等。
- **派生子 logger**：用 `child("name")` 拼 channel 路径（如 `server:agent:stream`），grep 友好。
- **fan-out**：用 `tee(transport)` 在已有 logger 上加一个新 sink，原 sink 不变。
- **资源所有权清晰**：每个 logger 节点只关闭自己引入的 transport；child 默认 no-op。
- **永不抛错**：写入失败、序列化失败都会兜底（降级到 stderr / 写 `<unserializable>`），调用方不需要 try/catch。
- **格式固定**：`[ISO] level [channel] message key=value ...`，人眼读、grep 都顺手。

## 安装

monorepo 内通过 workspace 引用：

```jsonc
// packages/your-pkg/package.json
{
  "dependencies": {
    "@lordcode/logger": "workspace:*"
  }
}
```

## 入口

| Import 路径                | 内容                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `@lordcode/logger`         | 运行时无关：`createLogger`、`consoleTransport`、`formatLine`、`formatRunHeader`、所有类型 |
| `@lordcode/logger/node`    | 仅 Node：`fileTransport`（用到 `node:fs`）                      |

> 拆两个入口是为了让浏览器 / edge runtime 也能复用核心接口，不会被 `node:fs` 阻断。

## 快速上手

```ts
import { createLogger } from "@lordcode/logger";
import { fileTransport } from "@lordcode/logger/node";

const root = createLogger({
  level: "debug",
  transports: [fileTransport("/tmp/myapp.log")],
});

const log = root.child("myapp");
log.info("server started", { port: 3000 });
log.debug("loaded modules", { count: 42 });

await root.close();
```

输出（`/tmp/myapp.log`）：

```text
[2026-05-09T08:00:00.000Z] info  [myapp] server started port=3000
[2026-05-09T08:00:00.001Z] debug [myapp] loaded modules count=42
```

## 核心概念

| 概念         | 说明 |
| ------------ | ---- |
| **logger**   | 一个具体实例。持有 channel 路径、一组 transport、一个 level。 |
| **transport**| 一个出口。拿到一行已格式化的字符串决定它写到哪（文件、stderr、…）。 |
| **channel**  | 日志的分类路径，`:` 分隔（例 `server:agent:stream`）。**仅用于过滤**，不承载属性数据。 |
| **meta**     | 一条日志附带的结构化字段对象 `{ key: value }`，承载动态属性（model 名、长度等）。 |
| **level**    | `silent` / `info` / `debug` 三档，控制哪些方法实际触发写入。 |

## API

### `createLogger(opts)`

构造一个 root logger。

```ts
import { createLogger, type LogLevel } from "@lordcode/logger";

const root = createLogger({
  level: "info",                 // "silent" | "info" | "debug"
  transports: [/* ... */],       // 至少一个
  // channel: [],                // 默认 []，一般不用手动传
});
```

`root.close()` 会**关闭它构造时传入的全部 transport**——这是"谁打开谁关"的根节点契约。

### `Logger` 实例方法

```ts
interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info (message: string, meta?: Record<string, unknown>): void;
  warn (message: string, meta?: Record<string, unknown>): void;
  error(message: string, err?: unknown, meta?: Record<string, unknown>): void;

  child(name: string): Logger;
  tee(transport: LogTransport): Logger;
  close(): Promise<void>;
}
```

#### `debug` / `info` / `warn` / `error`

写一条日志。`meta` 是可选的扁平对象，键值会渲染成 `key=value` 拼到行尾。

```ts
log.debug("chunk", { type: "text-delta", len: 42 });
// => [iso] debug [...] chunk type=text-delta len=42

log.info("server listening", { url: "http://127.0.0.1:5173" });
// => [iso] info  [...] server listening url=http://127.0.0.1:5173
```

`error` 的第二个参数 `err` 是任意值（推荐 `Error`）。是 `Error` 时，`err.message` 作为 `err="..."` 拼在行尾，`err.stack` 作为续行（每行 2 空格缩进）输出：

```ts
try {
  await doStuff();
} catch (err) {
  log.error("doStuff failed", err, { userId: 123 });
}
// => [iso] error [...] doStuff failed userId=123 err="boom"
//      Error: boom
//          at doStuff (...)
```

> ⚠️ `<message>` 不能含换行（会被替换成空格）。需要多行内容请放进 `meta` 或截断后塞 `meta.preview`。

#### `child(name)` — 派生子 channel

把 `name` 追加到 channel 路径末尾。父子**共享 transport 和 level**，几乎零开销。

```ts
const root = createLogger({ level: "info", transports: [fileT] });
const serverLog = root.child("server");        // channel = "server"
const agentLog  = serverLog.child("agent");    // channel = "server:agent"
const streamLog = agentLog.child("stream");    // channel = "server:agent:stream"

streamLog.info("frame", { type: "text-delta" });
// => [iso] info  [server:agent:stream] frame type=text-delta
```

约定：channel 段必须是**有限静态集合**（如 `boot` / `http` / `agent`）。属性类的东西（model 名、用户输入）一律走 `meta`。唯一例外是 resource id（session id 等），允许出现在 channel 里。

#### `tee(transport)` — 加一个新出口（fan-out）

派生一个新 logger，同时写到父的所有 transport **和**新加的这个。channel 不变。

```ts
const sessionFileT = fileTransport(`/tmp/session-${id}.log`);
const sessionLog = root.tee(sessionFileT).child("session").child(id);

sessionLog.info("turn started");
// 同时写到 root 的原始 transport 和 sessionFileT

await sessionLog.close();   // 只关 sessionFileT，root 的不动
```

#### `close()` — 释放资源

只关闭**本节点新引入**的 transport：

| 调用对象             | 关闭范围 |
| -------------------- | -------- |
| `createLogger` 的产物 | 它构造时传入的**全部** transport |
| `child(...)` 的产物   | 不关任何东西（child 没新引入 transport） |
| `tee(t)` 的产物       | 只关那个 `t` |

幂等。多次调用不会出错。

> 关 transport 是异步的（`await`）：文件 transport 会等到 `'close'` 事件后才 resolve，保证写入已落盘。

### 内置 transport

#### `consoleTransport()`

写到 `process.stderr`（**不是 stdout**，避免与 Ink TUI 抢屏）。`close()` 是 no-op，不会关 stderr。

```ts
import { consoleTransport } from "@lordcode/logger";

const log = createLogger({ level: "debug", transports: [consoleTransport()] });
```

适合：单元测试、headless 脚本、调试时临时接 stderr。

#### `fileTransport(path)`

```ts
import { fileTransport } from "@lordcode/logger/node";

const t = fileTransport("/Users/me/.lordcode/logs/debug.log");
const log = createLogger({ level: "debug", transports: [t] });
```

行为要点：

- 用 `createWriteStream(path, { flags: "a" })`：**追加**模式，POSIX `O_APPEND` 保证单次 ≤ 512B 的 `write(2)` 在多 writer 间不交错。
- **调用方需保证父目录存在**（自己 `mkdir -p`）。
- 写入失败（磁盘满、`EBADF`、…）不会抛——降级到 `process.stderr`，并打一行 `[lordcode logger] file write failed: ...` 提示。
- `close()` 等 `'close'` 事件 resolve（FD 完全释放，比 `'finish'` 强），让后续 `readFile` 一定能看到完整内容。

### `formatRunHeader(opts)`

格式化一条 run header（每次进程启动时写一次，标记本段日志的"运行身份"）：

```ts
import { formatRunHeader } from "@lordcode/logger";

transport.write(
  formatRunHeader({
    mode: "dev",          // "dev" | "release"
    pid: process.pid,
    version: "0.1.0",
  }) + "\n",
);
// => === run start 2026-05-09T08:00:00.000Z mode=dev pid=12345 version=0.1.0 ===
```

注意：返回值不含末尾换行，调用方自己加。

## 常用模式

### 1. 文件 + 子 channel（最常见）

```ts
import { mkdir } from "node:fs/promises";
import { createLogger, formatRunHeader } from "@lordcode/logger";
import { fileTransport } from "@lordcode/logger/node";

await mkdir("/tmp/myapp/logs", { recursive: true });
const t = fileTransport("/tmp/myapp/logs/debug.log");
const root = createLogger({ level: "debug", transports: [t] });

t.write(formatRunHeader({ mode: "dev", pid: process.pid, version: "0.1.0" }) + "\n");

const log = root.child("myapp");
log.child("boot").info("started");
log.child("api").debug("request", { path: "/foo" });

process.on("SIGINT", async () => {
  await root.close();
  process.exit(0);
});
```

### 2. 多 logger 共用一个文件

进程内多线程 / 多模块都希望写同一份文件时，**各自 `fileTransport(samePath)` 即可**，不需要共享句柄。`O_APPEND` 会保证单行不交错。

```ts
const mainLog   = createLogger({ level, transports: [fileTransport(p)] }).child("main");
const workerLog = createLogger({ level, transports: [fileTransport(p)] }).child("worker");
```

每个 root 各自 `await close()` 即可，互不影响。

### 3. fan-out：同时写主日志和单 session 日志

```ts
const sessionT = fileTransport(`/var/log/sessions/${id}.log`);
const sessionLog = serverLog.tee(sessionT).child("session").child(id);

sessionLog.info("turn started");   // 同时进 server 主日志和 sessions/<id>.log

await sessionLog.close();          // 只关 sessions/<id>.log，主日志不受影响
```

### 4. 在测试里用 silent logger

需要传 logger 但不想任何输出时，构造一个 silent + 任意 transport 的实例：

```ts
const silentLog = createLogger({
  level: "silent",
  transports: [{ write() {}, close() {} }],
});
```

## 日志等级

| 调用方法 | `silent` | `info` | `debug` |
| -------- | :------: | :----: | :-----: |
| `debug`  |    ✗     |   ✗    |    ✓    |
| `info`   |    ✗     |   ✓    |    ✓    |
| `warn`   |    ✗     |   ✓    |    ✓    |
| `error`  |    ✗     |   ✓    |    ✓    |

只有 `silent` 完全静默；`info` 仍输出 `warn` / `error`（即"info 以上"的语义）。

## 输出格式

```text
[<iso>] <level> [<channel>] <message> [<key>=<value> ...]
```

- `<iso>`：`new Date().toISOString()`，毫秒精度。
- `<level>`：固定 5 字符宽对齐——`debug`、`error`，以及补 1 空格的 `info`、`warn`。
- `<channel>`：完整路径，例 `server:agent:stream`。root logger（无 channel）会省略 `[]`。
- `<message>`：自由文本，**内部换行会被替换为空格**（保证一条日志 = 一行）。
- `<key>=<value>`：来自 meta；含空格 / `=` / `"` / `\` 的值整体加双引号并转义。
- `error` 的 `Error.stack`：作为续行紧跟在主行后，每行 2 空格缩进。

示例：

```text
=== run start 2026-05-09T08:00:00.000Z mode=dev pid=12345 version=0.1.0 ===
[2026-05-09T08:00:00.456Z] info  [server:boot] server listening url=http://127.0.0.1:54321
[2026-05-09T08:00:01.789Z] debug [server:agent:stream] chunk type=text-delta len=42
[2026-05-09T08:00:02.111Z] error [server:route:agent] streamAgent failed err="model timeout"
  Error: model timeout
      at streamText (...)
```

## 注意事项

1. **行长度**：跨进程 / 跨线程共享同一份文件时，单行 ≤ 512 字节才能保证不交错（POSIX 限制）。超长字段请在调用方截断后塞 `meta`：

   ```ts
   log.debug("user input", { preview: text.slice(0, 200), len: text.length });
   ```

2. **不会抛错**：transport 写失败会降级到 stderr 并打提示行，meta 序列化失败会写 `<unserializable>`。调用方不需要 try/catch logger。

3. **child 是廉价的**：可以放心在热路径里 `parent.child("xxx")`；不复制 transport / level，只多一层引用。

4. **不要把敏感信息放进日志**：API key、token 等绝不要 `meta` 进去。channel 选用 `apikey` 类时也只记**来源**（`source: "env"`）和环境变量名，不打 key 本身。

5. **stdout 静音**：`consoleTransport` 故意写 stderr，目的就是给 TUI（用 stdout 渲染 Ink）让出 stdout 通道。请不要在 logger 之外再 `console.log` 调试。
