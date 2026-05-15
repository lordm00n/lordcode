<!-- markdownlint-disable MD060 -->

# Ripgrep Tool — Spec

本文档描述 lordcode 接入**第一个 agent tool（ripgrep 文件内容搜索）**的总体设计，作为后续实现的依据。

---

## 1. 概述

本迭代是一个**端到端垂直切片**，同时落地两件强耦合的事：

1. **Tool 框架（一次性投入）**：让 `streamAgent` 能给模型挂 tools，能把 Vercel AI SDK 的 `tool-call` / `tool-result` / `tool-error` 三类 `fullStream` chunk 翻译成自己的 `AgentStreamEvent`，server 端真正执行 tool，结果回喂给模型形成 multi-step agent loop。
2. **Ripgrep tool（第一个具体 tool）**：基于 [`@vscode/ripgrep`](https://www.npmjs.com/package/@vscode/ripgrep) 自带的二进制，封装一个对 LLM 友好的文件内容搜索 tool。

这两件事必须一起做：tool 框架不验证就没法回头改；只做 tool 不接框架就无法被模型调用。

---

## 2. 目标 & 范围

### In Scope

- `@vscode/ripgrep` 二进制的接入（新依赖；server 端使用其导出的 `rgPath`）。
- `executeRipgrep(input, deps)` 纯函数：spawn `rg --json` → 解析 JSON Lines → 折叠成结构化输出 → 截断 → 返回。
- `createRipgrepTool(deps)` 工厂：把上述函数包成 Vercel AI SDK 的 `tool({ inputSchema, outputSchema, execute })`。
- 一个最小 **tool registry**：`{ ripgrep: createRipgrepTool(...) }`，由 `streamAgent` 在每次 turn 注入 `streamText`。
- `streamAgent` 改造：传 `tools`、设置 `stopWhen`，处理 `tool-call` / `tool-result` / `tool-error` chunk。
- `AgentStreamEvent` 新增三类：`tool-call` / `tool-result` / `tool-error`。
- TUI 最小渲染：在消息流中显示 `→ ripgrep(pattern: "...")` / `← 12 matches` / `× rg failed: <msg>` 三种行。
- abort 链路串联：HTTP signal → `streamAgent` → tool `execute` → `rg` 子进程 kill。
- `~/.lordcode/config.json` **不**新增字段（tool 是默认开启的）。

### Out of Scope（明确不做）

- **多 tool**：本迭代只暴露 `ripgrep` 一个；`read_file` / `glob` / `bash` 等放后续迭代。
- **Tool 权限/审批**：不做"调用前 ack"或允许列表；模型可以自由调用 ripgrep。
- **路径沙箱**：不强制路径必须在 workspace 内。`path` 参数允许任何值，由用户对自己 agent 的信任负责。
- **流式输入**：不消费 SDK 的 `tool-input-start` / `tool-input-delta` / `tool-input-available` chunks。我们等 SDK 给出完整 `tool-call` 再展示。
- **结果缓存 / 去重**：每次调用都是真 spawn。
- **rg 全部 flag**：只暴露 spec §5.1 列出的子集；`--encoding` `--pre` `--hidden` `--no-ignore` `--engine` 等不暴露给 LLM。
- **per-call cwd**：tool 用 server 启动时的 `process.cwd()`，不接受 LLM 传 `cwd`。
- **多 workspace / project root 检测**：将来需要时另起迭代。
- **流式渲染长 result**：tool 结果作为单一 `tool-result` 事件整体下发，不做"边出边渲"。
- **结构化 output schema 校验失败的 fallback**：`outputSchema` 解析失败直接当 tool error 处理（因为是我们自己写的 execute，理论上不该失败）。

---

## 3. 关键设计决策

| #  | 决策                                  | 选择                                                                 | 理由                                                                                                              |
| -- | ------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1  | Tool API                              | **直接用 Vercel AI SDK 的 `tool()`**，不自造 `Tool` 抽象             | SDK 已处理 provider 间的 tool-calling 协议差异、input 校验、agent loop；自造抽象在只有 1 个 tool 时是过度设计 |
| 2  | 适配层模式                            | **工厂函数 `createRipgrepTool(deps)`** 包 `tool({...})`              | execute 闭包要拿 logger / cwd / rgPath 等依赖；工厂模式与 `provider.ts` `apiKey.ts` 风格一致                      |
| 3  | 真实逻辑放哪                          | **独立 `executeRipgrep(input, deps)`**，与 SDK 解耦                   | 单元测试只测它，不需要 mock SDK；将来换 LLM 框架成本最低                                                          |
| 4  | rg 二进制来源                         | **`@vscode/ripgrep`** npm 包，自带跨平台二进制                       | 用户机器 rg 版本不可控（不同版本 `--json` 字段微妙差异）；自带版本固定可控；省去 `which` 检测分支                |
| 5  | rg 调用形态                           | `spawn(rgPath, ["--json", ...flags, pattern])` + 解析 stdout JSON Lines | `--json` 输出稳定结构化；不用解析 `rg` 的 human 模式输出                                                          |
| 6  | tool 执行位置                         | **server 进程内**，不开 worker / sandbox                              | 当前 server 已经是独立 worker thread；rg 是只读、短时进程；嵌套隔离收益不大                                       |
| 7  | tool 输出形态                         | **结构化 discriminated union**（按 outputMode），不是 raw stdout      | LLM 解析结构化 JSON 比 grep 文本友好；token 也更省                                                                |
| 8  | output schema 校验                    | 用 Zod `outputSchema` 双重校验                                       | 防止实现 bug 把脏数据喂给 LLM；SDK 也会自动校验                                                                   |
| 9  | rg exit code 映射                     | `0`/`1` → 正常返回（1 = no match）；`2`+ → throw                      | rg 约定：`1` 是"没找到"不是错；只有 `2` 是真正解析/IO 错                                                          |
| 10 | 截断                                  | execute 内部做（按 `headLimit`）；返回 `truncated: true`              | 让 LLM 知道结果被截断，可以追加调用；token 上限可控                                                               |
| 11 | abort                                 | `execute` 接 `abortSignal`，`signal.aborted` 时 `child.kill("SIGTERM")` | rg 是 well-behaved 进程，SIGTERM 即刻退；用户 Esc 不会有僵尸                                                      |
| 12 | agent loop 上限                       | `stopWhen: stepCountIs(10)`                                          | 防止失控调 tool；10 步对当前 use case 够用；可调                                                                  |
| 13 | tool 暴露给 LLM 的 cwd                | **不暴露**；execute 用 server 的 `process.cwd()`                      | 减少模型出错面；workspace 概念尚未引入；将来加 workspace 再说                                                     |
| 14 | tool input streaming                  | **不消费** `tool-input-*` chunks                                     | 仅是 cosmetic「正在拼参数」；wait 一下完整 `tool-call` 简洁太多                                                   |
| 15 | TUI 渲染                              | 文本占位（`→ ripgrep(...)` / `← N matches`），不开折叠面板             | MVP；后续迭代再做可展开的 tool 详情面板                                                                           |
| 16 | tool 调用日志                         | server logger `server:tool:ripgrep` 通道，input/exitCode/duration 全记 | 出问题能复现；与现有 `server:agent:stream` 风格一致                                                               |
| 17 | tool 注册位置                         | `streamAgent` 内部构造 `tools` 对象并注入                            | tool 集合与 agent turn 一对一；将来"按模型挑 tool"的逻辑也长在这里                                                |

---

## 4. 架构总览

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                       Server Worker (Hono / streamText)                       │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  routes/agent.ts                                                         │  │
│  │  POST /agent/chat → streamSSE(stream → AgentStreamEvent)                 │  │
│  └────────────────────────────────┬────────────────────────────────────────┘  │
│                                   │                                            │
│  ┌────────────────────────────────▼────────────────────────────────────────┐  │
│  │  agent/stream.ts  ::  streamAgent(messages, ctx)                         │  │
│  │                                                                          │  │
│  │   const tools = buildTools({ logger, cwd, rgPath })                      │  │
│  │                                                                          │  │
│  │   result = streamText({                                                  │  │
│  │     model, messages, tools,                                              │  │
│  │     stopWhen: stepCountIs(10),                                           │  │
│  │     abortSignal,                                                         │  │
│  │   })                                                                     │  │
│  │                                                                          │  │
│  │   for await (chunk of result.fullStream):                                │  │
│  │     ├ text-delta       → yield { delta }                                 │  │
│  │     ├ reasoning-*      → yield { reasoning-* }                           │  │
│  │     ├ tool-call        → yield { tool-call, id, name, input }    ◄── new │  │
│  │     ├ tool-result      → yield { tool-result, id, name, output } ◄── new │  │
│  │     ├ tool-error       → yield { tool-error, id, name, message } ◄── new │  │
│  │     └ error / finish   → … (existing)                                    │  │
│  └────────────────────────────────┬────────────────────────────────────────┘  │
│                                   │                                            │
│  ┌────────────────────────────────▼────────────────────────────────────────┐  │
│  │  tools/registry.ts  ::  buildTools(deps) → { ripgrep: <Tool> }           │  │
│  └────────────────────────────────┬────────────────────────────────────────┘  │
│                                   │                                            │
│  ┌────────────────────────────────▼────────────────────────────────────────┐  │
│  │  tools/ripgrep/tool.ts  ::  createRipgrepTool(deps) → Vercel SDK tool    │  │
│  │                                                                          │  │
│  │     tool({                                                               │  │
│  │       description, inputSchema, outputSchema,                            │  │
│  │       execute: async (input, { abortSignal }) =>                         │  │
│  │         executeRipgrep(input, { ...deps, signal: abortSignal })          │  │
│  │     })                                                                   │  │
│  └────────────────────────────────┬────────────────────────────────────────┘  │
│                                   │                                            │
│  ┌────────────────────────────────▼────────────────────────────────────────┐  │
│  │  tools/ripgrep/execute.ts  ::  executeRipgrep(input, deps) → output      │  │
│  │                                                                          │  │
│  │   ┌─ spawn(rgPath, [--json, ...flags, pattern], { cwd, signal })         │  │
│  │   ├─ collect stdout (JSON Lines)                                         │  │
│  │   ├─ parse → fold → truncate(headLimit)                                  │  │
│  │   └─ exit 0/1 → output;  exit 2+ → throw                                 │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
                                   │ (SSE: AgentStreamEvent JSON frames)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│   TUI (App.tsx)                                                                │
│   ── 流式 reducer 中新增 case：tool-call / tool-result / tool-error            │
│   ── 渲染为带前缀的 system-like 行：                                           │
│        →  ripgrep(pattern: "useState", type: "ts")                            │
│        ←  12 matches in 7 files                                                │
│        ×  rg failed: ...                                                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. 暴露的接口

这一节是本 spec 的核心 —— 把所有"对外契约"集中列出。后续实现 PR 应保持这一节同步。

### 5.1 Tool 输入 schema —— `RipgrepInput`

落在 `packages/server/src/tools/ripgrep/schema.ts`：

```typescript
import { z } from "zod";

export const RipgrepInputSchema = z.object({
  pattern: z.string().min(1).describe(
    "Regex pattern in ripgrep syntax. For literal text, the model should still pass plain text — it works as a regex.",
  ),

  path: z.string().optional().describe(
    "File or directory to search in. Relative to workspace root. Defaults to workspace root.",
  ),

  glob: z.string().optional().describe(
    "Glob filter, e.g. '*.ts' or '!**/node_modules/**'. Supports negation with leading '!'.",
  ),

  type: z.string().optional().describe(
    "ripgrep file type filter (e.g. 'js', 'py', 'rust'). Cheaper than glob for standard types. See `rg --type-list`.",
  ),

  outputMode: z
    .enum(["content", "files_with_matches", "count"])
    .default("content")
    .describe(
      "'content' returns matched lines (with optional context); 'files_with_matches' returns file paths only; 'count' returns per-file match counts.",
    ),

  caseInsensitive: z.boolean().default(false),

  contextBefore: z.number().int().min(0).max(20).optional().describe(
    "Lines of context before each match (rg -B). Only meaningful when outputMode='content'.",
  ),
  contextAfter: z.number().int().min(0).max(20).optional().describe(
    "Lines of context after each match (rg -A). Only meaningful when outputMode='content'.",
  ),

  multiline: z.boolean().default(false).describe(
    "Enable multiline mode where '.' matches newlines (rg -U --multiline-dotall).",
  ),

  headLimit: z.number().int().positive().max(1000).default(100).describe(
    "Cap result count. For outputMode='content': max matches. For other modes: max files.",
  ),
});

export type RipgrepInput = z.infer<typeof RipgrepInputSchema>;
```

### 5.2 Tool 输出 schema —— `RipgrepOutput`

```typescript
const ContentMatchSchema = z.object({
  file: z.string(),                    // 相对 cwd 的路径
  line: z.number().int().positive(),   // 1-indexed
  text: z.string(),                    // 匹配行原文，去掉行尾换行
  before: z.array(z.string()).optional(),
  after: z.array(z.string()).optional(),
});

export const RipgrepOutputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("content"),
    matches: z.array(ContentMatchSchema),
    truncated: z.boolean(),
  }),
  z.object({
    mode: z.literal("files_with_matches"),
    files: z.array(z.string()),
    truncated: z.boolean(),
  }),
  z.object({
    mode: z.literal("count"),
    counts: z.array(z.object({ file: z.string(), count: z.number().int().nonnegative() })),
    truncated: z.boolean(),
  }),
]);

export type RipgrepOutput = z.infer<typeof RipgrepOutputSchema>;
```

### 5.3 Tool 执行函数 —— `executeRipgrep`

落在 `packages/server/src/tools/ripgrep/execute.ts`：

```typescript
export interface RipgrepDeps {
  rgPath: string;                       // 来自 @vscode/ripgrep
  cwd: string;                          // server 进程的 process.cwd()
  logger?: Logger;                      // child("tool").child("ripgrep")
  signal?: AbortSignal;
  /** test seam: 注入假的 spawn，与 stream.ts 的 streamText seam 同套路 */
  spawn?: typeof import("node:child_process").spawn;
}

export class RipgrepError extends Error {
  constructor(
    message: string,
    public readonly cause: { exitCode?: number; stderr?: string; spawnError?: unknown },
  ) { super(message); }
}

export async function executeRipgrep(
  input: RipgrepInput,
  deps: RipgrepDeps,
): Promise<RipgrepOutput>;
```

**抛出 `RipgrepError` 的情况**（exit code 2+、spawn 失败、二进制不存在），其它走正常 return。

### 5.4 SDK 适配层 —— `createRipgrepTool`

落在 `packages/server/src/tools/ripgrep/tool.ts`：

```typescript
import { tool } from "ai";
import { RipgrepInputSchema, RipgrepOutputSchema } from "./schema.js";
import { executeRipgrep, type RipgrepDeps } from "./execute.js";

export function createRipgrepTool(
  deps: Omit<RipgrepDeps, "signal">,
): ReturnType<typeof tool<typeof RipgrepInputSchema, typeof RipgrepOutputSchema>>;
```

实现是几行胶水：

```typescript
return tool({
  description: RIPGREP_TOOL_DESCRIPTION,    // 见 §5.5
  inputSchema: RipgrepInputSchema,
  outputSchema: RipgrepOutputSchema,
  execute: async (input, { abortSignal }) =>
    executeRipgrep(input, { ...deps, signal: abortSignal }),
});
```

### 5.5 Tool description（喂给 LLM 的说明）

定为模块级常量，在 spec 里固化：

```text
Search file contents using ripgrep. Use this when you need to find code by
exact text, regex, or filter by file type / glob.

Output modes:
- "content" (default): return matched lines with optional surrounding context.
- "files_with_matches": return only the list of files containing matches.
- "count": return per-file match counts.

Prefer narrowing with `type` (e.g. "ts") or `glob` (e.g. "*.tsx") to avoid
scanning irrelevant files. Use `headLimit` to control output size; results
can be truncated, in which case `truncated: true` will be set.
```

### 5.6 Tool registry —— `buildTools`

落在 `packages/server/src/tools/registry.ts`：

```typescript
import type { Logger } from "@lordcode/logger";
import { rgPath } from "@vscode/ripgrep";
import { createRipgrepTool } from "./ripgrep/tool.js";

export interface ToolDeps {
  logger?: Logger;                      // 调用方传 child("tool")
  cwd: string;
}

export function buildTools(deps: ToolDeps) {
  return {
    ripgrep: createRipgrepTool({
      rgPath,
      cwd: deps.cwd,
      logger: deps.logger?.child("ripgrep"),
    }),
  };
}
```

返回类型对 SDK 透明。将来加 tool 时只在这里扩。

### 5.7 `streamAgent` 改造点

`packages/server/src/agent/stream.ts` 改动归纳：

| 位置                              | 改动                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `StreamAgentContext`              | 新增可选 `tools?: Record<string, Tool>` 与 `cwd?: string`（test seam；默认 `process.cwd()`）                            |
| `StreamTextFn` 参数               | 接受 `tools` 与 `stopWhen`                                                                                              |
| 构造 `streamText` 调用            | 传 `tools: ctx.tools ?? buildTools({ logger, cwd })`，传 `stopWhen: stepCountIs(10)`                                   |
| `fullStream` switch               | 在 `default` 之前新增三个 case：`tool-call` / `tool-result` / `tool-error`，分别 `yield` 对应 `AgentStreamEvent`        |
| logger child                      | 在 `streamAgent` 顶部新增 `toolLog = log?.child("tool")`，传给 `buildTools`                                              |

`stepCountIs` 来自 `ai`：

```typescript
import { streamText, stepCountIs } from "ai";
```

### 5.8 `AgentStreamEvent` 新增三类

落在 `packages/shared/src/api.ts`，扩展现有联合类型：

```typescript
export type AgentStreamEvent =
  | { type: "start"; model: string }
  | { type: "delta"; text: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning-end" }
  | { type: "finish"; finishReason?: string; usage?: {...}; aborted?: boolean }
  | { type: "error"; message: string }
  // ── new for tools ──
  | { type: "tool-call";   toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { type: "tool-error";  toolCallId: string; toolName: string; message: string };
```

约定：

- `tool-call` 一定先于配对的 `tool-result` / `tool-error`，按 `toolCallId` 配对。
- 一个 turn 可以发多次 tool-call（agent loop）；它们与 `delta` / `reasoning-*` 任意交织。
- `input` / `output` 在 wire 上是 `unknown`，TUI 端按 `toolName` 决定渲染。第一版只会出现 `toolName === "ripgrep"`。

### 5.9 HTTP API 契约

**无变化**：仍然是 `POST /agent/chat` SSE。只是 `data:` 里的 JSON 现在可能是新的三种事件类型之一。客户端只要不假设事件枚举封闭即可向前兼容。

### 5.10 TUI client 解析改造

`packages/tui/src/api/client.ts` 的 `events: AsyncIterable<AgentStreamEvent>` 形态不变；TUI 端只需在 `App.tsx` 的事件 reducer 里新增三个 case，落到一个 `messages` 中的新消息类型 `{ kind: "tool"; ... }`（具体形态见 §6.3）。

---

## 6. 模块拆分

### 6.1 Dir tree

```text
packages/server/src/
├── agent/
│   ├── stream.ts               (改：传 tools + 处理 tool-* chunks)
│   └── ...                     (其它不动)
├── tools/                      (新目录)
│   ├── index.ts                (re-export buildTools, types)
│   ├── registry.ts             (buildTools)
│   └── ripgrep/
│       ├── schema.ts           (Zod input/output)
│       ├── execute.ts          (纯函数 + RipgrepError)
│       ├── tool.ts             (createRipgrepTool — SDK 胶水)
│       ├── parse.ts            (rg --json 行 → 内部结构；纯函数，给单测用)
│       ├── execute.test.ts     (集成：跑真二进制 + fixture)
│       └── parse.test.ts       (单元：固定 JSON 行 → 输出)

packages/shared/src/
└── api.ts                      (扩：AgentStreamEvent 新增三类)

packages/tui/src/
├── components/App.tsx          (改：reducer 新增三个 case + 渲染 tool 行)
└── lib/format-tool-call.ts     (新：把 tool input/output 折叠成单行人类可读串)
```

### 6.2 `@lordcode/server` — `tools/`

| 文件          | 职责                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `registry.ts` | `buildTools(deps)`：组装所有 tool，返回 `{ name: tool }` 对象。第一版仅 `ripgrep`。                        |
| `ripgrep/schema.ts`  | Zod input/output schema，导出 `RipgrepInput` / `RipgrepOutput` 类型。                              |
| `ripgrep/execute.ts` | `executeRipgrep`、`RipgrepError`；不依赖 `ai` 包，可独立测。                                       |
| `ripgrep/parse.ts`   | `parseRipgrepJsonLines(lines, opts) → RipgrepOutput`；rg `--json` 输出的折叠逻辑，纯函数。         |
| `ripgrep/tool.ts`    | `createRipgrepTool(deps)`：薄薄一层 `tool({...})`，把 execute 包给 SDK。                            |

### 6.3 `@lordcode/tui` — App 改造

`App.tsx` 现有的 reducer 形态保持不变（流式事件按顺序累积成 `messages`）。新增的渲染需求：

- 在 `messages` 联合类型里新增 `{ kind: "tool"; toolCallId: string; toolName: string; phase: "call" | "result" | "error"; payload: ... }` 一条。
- reducer：
  - `tool-call`：push 一条 `phase: "call"` 的 tool 消息。
  - `tool-result`：找到同 `toolCallId` 的那条，**升级为 `phase: "result"`** 并填 `output`。
  - `tool-error`：同上，升级为 `phase: "error"` 并填 `message`。
- 渲染（`format-tool-call.ts`）：
  - call：`→ ripgrep(pattern: "useState", type: "ts")`
  - result（按 `outputMode` 各自摘要）：
    - `content`：`← 12 matches in 7 files (truncated)` 或 `← 12 matches in 7 files`
    - `files_with_matches`：`← 7 files`
    - `count`：`← 42 matches across 5 files`
  - error：`× rg failed: <message>`

完整 result payload 不在第一版 UI 中展开（后续迭代加可折叠面板）。

---

## 7. ripgrep 调用细节

### 7.1 `rg --json` 输出格式

每行一个 JSON object，类型有 `begin` / `match` / `context` / `end` / `summary`。示例（搜 `"useState"`）：

```text
{"type":"begin","data":{"path":{"text":"src/app.tsx"}}}
{"type":"match","data":{"path":{"text":"src/app.tsx"},"lines":{"text":"  const [n, setN] = useState(0)\n"},"line_number":12,"absolute_offset":234,"submatches":[{"match":{"text":"useState"},"start":18,"end":26}]}}
{"type":"end","data":{"path":{"text":"src/app.tsx"},"binary_offset":null,"stats":{...}}}
{"type":"summary","data":{"elapsed_total":{...},"stats":{...}}}
```

包含 `--context-before` / `-A` 时会插入 `{"type":"context", ...}` 行。

### 7.2 解析 → `RipgrepOutput`

`parse.ts` 内部状态机（纯函数 over `string[]`）：

| 输入 chunk          | 处理（按 outputMode）                                                              |
| ------------------- | ---------------------------------------------------------------------------------- |
| `begin`             | content/files_with_matches: 记当前 file；count: 准备累加器                         |
| `match`             | content: 累一条 ContentMatch；files_with_matches: 标记此 file 命中；count: ++       |
| `context`           | content: 按位置塞进上一/下一 ContentMatch 的 `before` / `after`                    |
| `end`               | files_with_matches: 若已命中则 push file；count: push `{file, count}`              |
| `summary`           | 忽略（统计信息我们不暴露给 LLM；过 token，且容易诱导其依赖）                       |
| 解析失败的行         | 记 warn 日志，跳过                                                                 |

### 7.3 截断

在解析过程中即时累计。一旦超过 `headLimit`：

- **停止 push**（不再追加 ContentMatch / file / count）。
- 继续吃完 stdout（让 rg 跑完，避免 SIGPIPE 噪音；rg 通常很快）。
- 设 `truncated = true`。

> 备选：用 rg 自带的 `--max-count` 在源头限制 per-file matches。本期不用，让 truncate 完全在我们手里以保证 cross-file 的总量上限。

### 7.4 Flag 拼装

`buildArgs(input: RipgrepInput): string[]`：

| 字段                | 翻译                                                |
| ------------------- | --------------------------------------------------- |
| 总是                | `--json`, `--no-config`                             |
| `caseInsensitive`   | `-i`                                                |
| `multiline`         | `-U`, `--multiline-dotall`                          |
| `glob`              | `-g <glob>`                                         |
| `type`              | `-t <type>`                                         |
| `contextBefore` >0  | `-B <n>`（仅 outputMode=content 拼）                |
| `contextAfter` >0   | `-A <n>`（仅 outputMode=content 拼）                |
| 末尾                | `pattern`，再 `path`（若提供）                        |

**重要**：我们**不**给 rg 传 `-l` 或 `-c`。实测（rg 15.0.0 + `@vscode/ripgrep@1.18.0`）这两个 flag 会让 rg 退出 JSON 模式、改回 plain-text 输出，即使同时带了 `--json`。所以我们对所有 outputMode 都让 rg 输出统一的 JSON `match` 事件，再在 `parse.ts` 里自己把它折叠成 `files_with_matches` / `count` 形态。代价是 rg 不再做 per-file 的 early-exit 优化，但对代码搜索体量来说可忽略，换来的是只有一条解析路径要维护。

---

## 8. 关键数据流

### 8.1 LLM 一次成功的 ripgrep 调用

```text
user: "where is useState used in this repo?"
  └─ POST /agent/chat
       └─ streamAgent
            ├─ buildTools({ logger, cwd })
            ├─ streamText({ model, messages, tools, stopWhen })
            └─ for await chunk of result.fullStream:
                 ├─ chunk: tool-call { toolCallId, toolName: "ripgrep",
                 │                     input: { pattern: "useState", type: "ts" } }
                 │   └─ yield { type:"tool-call", ... }                  ← SSE
                 │
                 │   (SDK 自动跑 execute → executeRipgrep → spawn rg)
                 │
                 ├─ chunk: tool-result { toolCallId, output: { mode:"content", matches:[...], truncated:false } }
                 │   └─ yield { type:"tool-result", ... }                ← SSE
                 │
                 │   (SDK 把 result 放回 messages 喂给模型，开始下一步)
                 │
                 ├─ chunk: text-delta "useState appears in ..."
                 │   └─ yield { type:"delta", text:"..." }               ← SSE
                 │
                 └─ chunk: finish
                      └─ yield { type:"finish", ... }                    ← SSE
```

### 8.2 用户中途 Esc

```text
TUI: Esc
  └─ AbortController.abort()
       └─ fetch aborted
            └─ Hono c.req.raw.signal aborted
                 └─ streamAgent ctx.signal aborted
                      └─ streamText abortSignal aborted
                           ├─ 若当前在 execute 中：
                           │     └─ ripgrep execute 监听到 signal.aborted
                           │          └─ child.kill("SIGTERM")
                           │               └─ rg 进程退出
                           │                    └─ execute throw AbortError
                           │                         (SDK 不发 tool-result，整流终止)
                           └─ 若当前在 LLM 文本输出：
                                 └─ 已发出的 partial 不撤回；流自然终止
```

### 8.3 rg 失败

```text
chunk: tool-error { toolCallId, error: "rg failed (exit 2): regex parse error: ..." }
  └─ yield { type:"tool-error", toolCallId, toolName:"ripgrep", message:"..." }
       └─ TUI 渲染 "× rg failed: regex parse error: ..."
            └─ SDK 把 error 放回 messages 喂给模型，模型可以重试或换策略
```

---

## 9. 边界情况 / 错误处理

| 场景                                              | 处理                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| rg exit 0 + 无 match                              | 正常返回空数组的 `RipgrepOutput`，`truncated:false`                                           |
| rg exit 1（"没找到任何 match"）                   | 同上：当 0 个 match 处理，**不**算错                                                          |
| rg exit 2+（regex / IO 错）                        | `executeRipgrep` throw `RipgrepError`，含 stderr；SDK 转成 `tool-error` chunk                  |
| spawn 失败（二进制不存在等）                      | throw `RipgrepError` with `cause.spawnError`                                                  |
| stdout 出现解析失败的行                           | warn 日志 + 跳过；不让一行坏数据带崩整次调用                                                   |
| 用户传非法 input（zod 校验失败）                  | SDK 自己拦截，不会进 `execute`；SDK 返回 tool-error 给模型                                     |
| 模型连续调 N 次 tool                              | SDK 走 agent loop；`stopWhen: stepCountIs(10)` 兜底                                            |
| `path` 不存在                                     | rg exit 2 → 错误信息含 "No such file or directory" → `tool-error` chunk 给模型                  |
| `glob` / `type` 拼写错                            | rg exit 2 → 同上                                                                              |
| stdout 太大撑爆内存                               | `headLimit` + 解析中即时截断；最坏情况下 buffer 是当前 chunk 大小，安全                        |
| Esc 中途                                          | signal → kill SIGTERM；execute throw AbortError（不当 tool-error，整流自然终止；§8.2）          |
| `process.cwd()` 是非 git 仓库                     | rg 默认仍可工作（不依赖 git）；只是会走更多目录；不需特殊处理                                  |
| symlink 循环                                      | rg 默认不跟随 symlink，安全                                                                   |
| 文件含 binary 数据                                | rg 默认跳过 binary；不需要特殊处理                                                            |
| Windows 路径分隔                                  | rg 自身处理；返回 `file` 字段保留 rg 输出原样                                                   |
| Worker thread 重启                                | 旧 in-flight tool execute 被中断（worker 进程退）；客户端会感知到 SSE 断流                     |

---

## 10. 依赖

### 新增（server）

| 包                 | 版本         | 用途                                  |
| ------------------ | ------------ | ------------------------------------- |
| `@vscode/ripgrep`  | latest       | 自带跨平台 rg 二进制，导出 `rgPath`   |

`ai` 已存在；新引入它的 `tool` / `stepCountIs` export，无需升版本。

### 新增（tui）

无新依赖。

---

## 11. 测试策略概要

> 详细 UT category 另写 `test-category.md`（与 `chat-model/` 同惯例）；这里仅给纲要。

| 模块               | 验证方式                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `parse.ts`         | 纯单元测试：固定 JSON Lines 字符串数组 → 期望 `RipgrepOutput`。覆盖 begin/match/context/end/summary、各 outputMode、截断、坏行 |
| `execute.ts`       | 集成测试：跑真实 `@vscode/ripgrep` 二进制 over fixture 目录（`tests/fixtures/ripgrep-corpus/`）；覆盖 happy path、no-match、glob/type 过滤、上下文行、multiline、headLimit truncate、exit 2、abort |
| `tool.ts`          | 不单独测；由 `stream.test.ts` 间接覆盖                                                                   |
| `registry.ts`      | 微测：`buildTools(...)` 返回的 keys 是 `["ripgrep"]`                                                     |
| `stream.ts`（已有 + 新增） | 用 fake `streamText` 喂含 `tool-call` / `tool-result` / `tool-error` 的 `fullStream`，断言 `streamAgent` 翻译出对应 `AgentStreamEvent`；abort 链路；agent loop 多步 |
| TUI App reducer    | reducer 单测：连续投喂事件序列，断言 `messages` 形态正确（包括 tool-call → tool-result 的"升级"）         |

`@lordcode/shared` 的类型增删通过 `tsc -b` 静态保证。

---

## 12. 不在本迭代

- 第二、第三个 tool（`read_file` / `glob` / `bash` / `edit_file` 等）。
- Tool 调用前置的"用户审批"步骤。
- Tool 输出在 TUI 中的可展开/可滚动详情面板。
- 流式 tool input 的 token-by-token 渲染。
- 路径沙箱（"只允许在 workspace 内"）。
- per-conversation / per-call 的 cwd 切换。
- Tool registry 的"按模型挑 tool"或"按权限过滤 tool"。
- Workspace 概念本身（多目录 / project root 检测）。
- rg 进阶 flag（`--encoding` / `--pre` / `--hidden` / `--no-ignore` / `--engine pcre2`）。
- 结果缓存。

---

## 13. 验收标准

- [ ] `pnpm --filter @lordcode/server typecheck && pnpm --filter @lordcode/server test` 全绿
- [ ] `pnpm --filter @lordcode/tui typecheck && pnpm --filter @lordcode/tui test` 全绿
- [ ] 在装好的 lordcode 中，向当前模型问 "find all uses of useState in this repo"，**TUI 中能看到** 形如 `→ ripgrep(pattern: "useState", type: "tsx")` 与 `← N matches in M files` 的事件，最终模型回复内容里**确实**引用了 ripgrep 找到的文件路径
- [ ] 故意问 "search for `[invalid(regex`"，能看到 `× rg failed: ...` 一行，模型能继续对话（不是整个 turn 崩）
- [ ] 模型连续调 ripgrep ≥ 2 次，agent loop 正常推进；步数到 `stepCountIs(10)` 后由 `finish` 终止（不阻塞）
- [ ] 流式中按 Esc：当前 tool 调用被中止，不留 zombie `rg` 进程（`pgrep rg` 无残留）
- [ ] `~/.lordcode/config.json` 不存在 / 模型未配置时，行为与现有保持一致（`error` 帧立刻返回，与 tool 框架引入无关）
- [ ] `server:tool:ripgrep` 通道日志能看到每次调用的 input / exitCode / duration
- [ ] 关掉 server 重启，再问同样问题，行为可重现
