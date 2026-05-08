<!-- markdownlint-disable MD060 -->

# Chat Model — Spec

本文档描述 lordcode 中**模型配置 + 模型切换 + 流式聊天**功能的总体设计，作为后续实现的依据。

---

## 1. 概述

本迭代为 lordcode 接入真实模型的能力，包含三件事：

1. **配置层**：本地配置文件 `~/.lordcode/config.json`（JSONC）作为模型清单的唯一来源。
2. **运行时**：server 端通过 [Vercel AI SDK](https://sdk.vercel.ai/) 把配置实例化为 `LanguageModel`，调用 `streamText` 产出流式响应。
3. **TUI 交互**：新增 slash command `/models`、`/model <name>`；状态栏展示当前模型；assistant 回复以流式方式渲染；支持 Esc 中止生成。

---

## 2. 目标 & 范围

### In Scope

- `~/.lordcode/config.json` 配置加载、校验、持久化。
- 通过 Vercel AI SDK 接入 `openai` / `openai-compatible` / `anthropic` / `deepseek` 四个 provider。
- HTTP 层流式接口（SSE）。
- TUI slash command 解析、状态栏、流式渲染、Esc 取消。
- 基础错误路径：缺配置、缺 model、缺 apiKey、JSONC 解析失败、schema 不合法。

### Out of Scope（明确不做）

- 工具调用 / agent multi-step loop（仍然是单轮 text generation）。
- `/model add` `/model remove` `/model edit` 等管理命令。
- 配置文件 hot reload / `fs.watch`。
- OS keychain 集成。
- 多 profile / per-project 配置。
- Resume / replay 协议。
- Web UI 的具体接入（设计上保持兼容，本迭代不实现）。

---

## 3. 关键设计决策

| #   | 决策                       | 选择                                            | 理由                                                       |
| --- | -------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| 1   | 配置文件位置               | `~/.lordcode/config.json`                       | 简单直观，单文件                                           |
| 2   | 配置文件格式               | JSONC                                           | 允许注释，用户体验好；零成本兼容 JSON                      |
| 3   | Provider 抽象              | Vercel AI SDK                                   | 屏蔽 provider 差异，未来扩展便捷                           |
| 4   | 第一版 provider            | `openai` / `openai-compatible` / `anthropic` / `deepseek` | `openai` 走 Responses API（OpenAI 自家最新 GPT-5/o-pro 等需要这个）；`openai-compatible` 走 Chat Completions（本地 Ollama / vLLM、ModelScope、OpenCode Zen 非 OpenAI 模型等绝大多数 OpenAI 兼容服务）；Anthropic / DeepSeek 用各自原生 SDK |
| 5   | API key 存储               | 明文 + 环境变量引用（`apiKeyEnv` 优先）         | 灵活，env 优先保证安全                                     |
| 6   | 添加模型方式               | 仅手动编辑                                      | MVP 简洁，避免交互式表单                                   |
| 7   | 空 `models` 行为           | server 起得来；chat 报错；TUI 顶部红字告警      | 不阻塞用户启动                                             |
| 8   | `currentModel` 缺失        | fallback 到 `models[0]`，并写回                 | 减少手动配置负担                                           |
| 9   | 流式协议                   | SSE（`text/event-stream`）                      | Hono 原生支持；未来 web UI 直接 EventSource 消费           |
| 10  | SSE 事件形态               | 单一事件 + payload 内含 `type` 字段             | TUI 端解析更简单，不必订阅多 event name                    |
| 11  | 流式中错误的 partial 内容  | 保留显示，标记 `[interrupted]` + 错误消息       | 用户能看到模型已经写到哪                                   |
| 12  | 取消（Esc）                | 本迭代包含                                      | abort 链路天然，几乎免费                                   |
| 13  | schema 校验                | `zod`                                           | 错误信息清晰；TS 友好；事实标准                            |

---

## 4. 架构总览

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          Node.js Process                                │
│                                                                          │
│  ┌──────────────────────┐              ┌───────────────────────────┐   │
│  │     Main Thread      │   HTTP/SSE   │     Worker Thread         │   │
│  │     (Ink TUI)        │              │     (Hono Server)         │   │
│  │                      │              │                           │   │
│  │  ┌────────────────┐  │  ──────────► │  ┌─────────────────────┐  │   │
│  │  │ slash parser   │  │              │  │ /models routes      │  │   │
│  │  │  /models       │  │  ◄────────── │  │ /agent/chat (SSE)   │  │   │
│  │  │  /model <name> │  │              │  └──────────┬──────────┘  │   │
│  │  └───────┬────────┘  │              │             │             │   │
│  │          │           │              │  ┌──────────▼──────────┐  │   │
│  │  ┌───────▼────────┐  │              │  │  ConfigStore        │  │   │
│  │  │ status bar     │  │              │  │  (singleton, mem +  │  │   │
│  │  │ "model: foo"   │  │              │  │   atomic disk write)│  │   │
│  │  └───────┬────────┘  │              │  └──────────┬──────────┘  │   │
│  │          │           │              │             │             │   │
│  │  ┌───────▼────────┐  │              │  ┌──────────▼──────────┐  │   │
│  │  │ stream renderer│  │              │  │ resolveModel()      │  │   │
│  │  │  (delta accum) │  │              │  │ ModelConfig → LM    │  │   │
│  │  └───────┬────────┘  │              │  │ via Vercel AI SDK   │  │   │
│  │          │           │              │  └──────────┬──────────┘  │   │
│  │  AbortController ────┼─ cancel ────►│  c.req.raw.signal        │   │
│  └──────────────────────┘              │             │             │   │
│                                         │  ┌──────────▼──────────┐  │   │
│                                         │  │ streamAgent (async  │  │   │
│                                         │  │  generator)         │  │   │
│                                         │  └──────────┬──────────┘  │   │
│                                         └─────────────┼─────────────┘   │
└─────────────────────────────────────────────────────┬─┴──────────────────┘
                                                      │       │
                                       ┌──────────────▼───┐   │
                                       │ ~/.lordcode/     │   │
                                       │  config.json     │   │
                                       │  (JSONC)         │   │
                                       └──────────────────┘   │
                                                              │
                                       ┌──────────────────────────────────────────┐
                                       │ Provider HTTP                            │
                                       │  · openai            (@ai-sdk/openai)            → /responses        │
                                       │  · openai-compatible (@ai-sdk/openai-compatible) → /chat/completions │
                                       │  · anthropic         (@ai-sdk/anthropic)         → /messages        │
                                       │  · deepseek          (@ai-sdk/deepseek)          → /chat/completions │
                                       └──────────────────────────────────────────┘
```

---

## 5. 配置文件

### 位置

`~/.lordcode/config.json`

### 格式

JSONC（JSON with Comments）。允许 `//` 和 `/* */` 注释、尾随逗号。

### Schema

落在 `@lordcode/shared/src/config.ts`：

```typescript
/**
 * - `openai`            → `@ai-sdk/openai`，默认走 Responses API（POST /responses）。
 *                         OpenAI 自家 GPT-5 / o-pro 等只支持 Responses 的模型走这里。
 * - `openai-compatible` → `@ai-sdk/openai-compatible`，走 Chat Completions
 *                         （POST /chat/completions）。生态里绝大多数"OpenAI 兼容"
 *                         服务（本地 Ollama / vLLM、ModelScope、OpenCode Zen 的
 *                         Big Pickle / Kimi / GLM 等）都是这种。`baseURL` 必填。
 * - `anthropic`         → `@ai-sdk/anthropic`（Messages API）。
 * - `deepseek`          → `@ai-sdk/deepseek`。
 */
export type ModelProvider =
  | "openai"
  | "openai-compatible"
  | "anthropic"
  | "deepseek";

export interface ModelConfig {
  /** 用户起的别名，主键，唯一 */
  name: string;
  provider: ModelProvider;
  /** 传给 Vercel AI SDK 的真实 model id */
  model: string;
  /**
   * 覆盖 provider 默认 endpoint。
   * 对 `openai` / `anthropic` / `deepseek` 可选（有内置默认）；
   * 对 `openai-compatible` 必填（无默认 host）。
   */
  baseURL?: string;
  /** 明文 apiKey，兜底 */
  apiKey?: string;
  /** 环境变量名；存在时优先于 apiKey */
  apiKeyEnv?: string;
}

export interface LordcodeConfig {
  version: 1;
  /** 指向 models[].name；为空时启动时 fallback 到 models[0] 并写回 */
  currentModel?: string;
  models: ModelConfig[];
}
```

### 示例

```jsonc
{
  // schema 版本，用于后续 migration
  "version": 1,

  "currentModel": "gpt-4o-mini",

  "models": [
    {
      "name": "gpt-4o-mini",
      "provider": "openai",
      "model": "gpt-4o-mini",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    {
      "name": "claude-haiku",
      "provider": "anthropic",
      "model": "claude-3-5-haiku-latest",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    {
      "name": "deepseek-chat",
      "provider": "deepseek",
      "model": "deepseek-chat",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    },
    {
      "name": "local-qwen",
      "provider": "openai-compatible", // 本地 Ollama / vLLM 等用 chat completions
      "model": "qwen2.5-coder",
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama"
    },
    {
      "name": "big-pickle",
      "provider": "openai-compatible", // OpenCode Zen 的非 OpenAI 模型走 chat completions
      "model": "big-pickle",
      "baseURL": "https://opencode.ai/zen/v1",
      "apiKeyEnv": "OPENCODE_ZEN_API_KEY"
    }
  ]
}
```

### 校验规则

- `version` 必须为 `1`。
- `models[].name` 必须唯一、非空。
- `models[].provider` 必须是枚举值之一。
- `models[].model` 非空。
- `apiKey` 与 `apiKeyEnv` 至少存在一个（启动时只校验存在，不校验 env 是否能取到值；后者在 chat 调用时校验）。
- 当 `models[].provider === "openai-compatible"` 时，`baseURL` 必填（无默认 host）。
- `currentModel` 若存在，必须能在 `models` 中找到；否则启动时降级为 `models[0]?.name ?? null` 并写回。

---

## 6. 模块拆分

### 6.1 `@lordcode/shared`（共享类型）

| 文件                     | 职责                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts` *(新)*   | 配置类型 + DTO（`ModelConfig`、`LordcodeConfig`、`ModelSummary`、`ModelsListResponse`、`SetCurrentModelRequest`、`SetCurrentModelResponse`）                       |
| `src/api.ts` *(扩)*      | 增加 `AgentStreamEvent` 联合类型；`API_ROUTES` 增 `models`、`currentModel`                                                                                          |

`AgentStreamEvent`（SSE payload）：

```typescript
export type AgentStreamEvent =
  | { type: "start"; model: string }
  | { type: "delta"; text: string }
  | {
      type: "finish";
      finishReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    }
  | { type: "error"; message: string };
```

`ModelSummary` —— 对外暴露时**不含** `apiKey`，仅用 `apiKeySource` 标识来源：

```typescript
export interface ModelSummary {
  name: string;
  provider: ModelProvider;
  model: string;
  baseURL?: string;
  apiKeySource: "env" | "plain" | "missing";
  apiKeyEnv?: string;
}
```

---

### 6.2 `@lordcode/server`

#### 6.2.1 `src/config/`（新目录）

| 文件        | 职责                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `paths.ts`  | 解析 `~/.lordcode/config.json` 的绝对路径；提供 `ensureConfigDir()`                                                        |
| `schema.ts` | zod schema；导出 `parseConfig(rawText: string): LordcodeConfig`，内部用 `jsonc-parser` 解析；解析/校验失败抛带字段路径的错误 |
| `store.ts`  | `ConfigStore` 单例                                                                                                         |

`ConfigStore` 接口：

```typescript
class ConfigStore {
  static load(): Promise<ConfigStore>;
  list(): ModelSummary[];
  getCurrent(): ModelConfig | null;
  setCurrent(name: string): Promise<ModelConfig>;
}
```

启动时 `ConfigStore.load()` 流程：

1. `ensureConfigDir`；若文件不存在写入 skeleton `{ version: 1, models: [] }`。
2. 读 + JSONC 解析 + zod 校验。
3. 若 `currentModel` 失效 → 降级 + `persist()`。
4. 返回单例。

`persist()` 是内部方法，使用 atomic write（写 `config.json.tmp` → `rename`）。

#### 6.2.2 `src/agent/`

| 文件                  | 职责                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider.ts` *(新)*  | `resolveLanguageModel(cfg, apiKey): LanguageModel`，根据 `cfg.provider` 派发：`openai` → `createOpenAI(...)(modelId)`（Responses）；`openai-compatible` → `createOpenAICompatible(...).chatModel(modelId)`（Chat Completions）；`anthropic` → `createAnthropic(...)(modelId)`；`deepseek` → `createDeepSeek(...)(modelId)`     |
| `apiKey.ts` *(新)*    | `resolveApiKey(cfg): string \| null`：`apiKeyEnv` 优先 `process.env`，否则取 `apiKey`，否则 `null`                                                                          |
| `stream.ts` *(新)*    | `streamAgent(messages, ctx): AsyncIterable<AgentStreamEvent>` — async generator，封装"取 currentModel → 取 apiKey → 实例化 → `streamText` → 转事件"                          |
| `index.ts` *(改)*     | 删除 stub；re-export `streamAgent`                                                                                                                                         |

`streamAgent` 行为：

| 条件                       | 产出                                                                              | 后续    |
| -------------------------- | --------------------------------------------------------------------------------- | ------- |
| 无 currentModel            | `error: no model selected`                                                        | return  |
| apiKey 拿不到              | `error: missing apiKey for <name> (set env <X> or apiKey)`                        | return  |
| 正常                       | `start` → 多个 `delta` → `finish`                                                  | —       |
| `streamText` 内部异常      | 已发送的 partial 不撤回；追加 `error`                                              | return  |
| `ctx.signal.aborted`       | 触发 streamText 的 abortSignal；自然终止；可选追加 `finish` 标记 `aborted`         | —       |

#### 6.2.3 `src/routes/`

| 文件                | 职责                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models.ts` *(新)*  | `GET /models` 返回 `ModelsListResponse`；`POST /models/current` 切换                                                                                                |
| `agent.ts` *(改)*   | `POST /agent/chat` 用 Hono 的 `streamSSE` 包装；把每个 `AgentStreamEvent` `JSON.stringify` 后写为 `data:`；把 `c.req.raw.signal` 透传给 `streamAgent`                |

#### 6.2.4 `src/app.ts` *(改)*

- 启动时 `await ConfigStore.load()`，注入 `AppDeps`。
- 注册 `/models` 路由。

#### 6.2.5 `src/worker.ts` *(改)*

- `ConfigStore.load()` 失败时把错误透传给主线程（已有 `error` message 通道）。

---

### 6.3 `@lordcode/tui`

#### 6.3.1 `src/lib/commands.ts`（新）

纯函数 slash command 解析：

```typescript
export type Command =
  | { kind: "send"; text: string }
  | { kind: "models" }
  | { kind: "set-model"; name: string }
  | { kind: "invalid"; reason: string };

export function parseCommand(input: string): Command;
```

- `/models` → `{ kind: "models" }`
- `/model <name>` → `{ kind: "set-model", name }`；缺 name → `invalid`
- 其他以 `/` 开头未知 → `invalid`
- 无 `/` 前缀 → `send`

#### 6.3.2 `src/api/client.ts`（扩）

- `listModels(): Promise<ModelsListResponse>`
- `setCurrentModel(name): Promise<SetCurrentModelResponse>`
- `chat(req): ChatStream`：

```typescript
export interface ChatStream {
  events: AsyncIterable<AgentStreamEvent>;
  abort: () => void;
}
```

实现要点：

- `AbortController` 控制 fetch。
- `Response.body.getReader()` 读字节。
- 用 `eventsource-parser` 解析 SSE，再 `JSON.parse` 成 `AgentStreamEvent`。
- abort 抛出的 `AbortError` 不向上抛，作为正常结束。

#### 6.3.3 `src/components/App.tsx`（改）

新增 state：

```typescript
const [models, setModels] = useState<ModelsListResponse | null>(null);
const [streaming, setStreaming] = useState<{ text: string } | null>(null);
const abortRef = useRef<(() => void) | null>(null);
```

行为：

- `useEffect` 启动时 `api.listModels()`，写入 `models`。
- 顶部状态栏：`model: <current>` 或红字 `no models configured. edit ~/.lordcode/config.json`。
- `useInput`：
  - 若 `streaming != null`：拦截 Esc → `abortRef.current?.()`；其他按键忽略输入。
  - 否则正常编辑、回车提交。
- 提交时先 `parseCommand`：
  - `models` → 调 `listModels()` 后插入 system 消息（人类可读列表）。
  - `set-model` → 调 `setCurrentModel(name)`；成功插入 system 消息 + 更新 `models.current`；失败红字。
  - `invalid` → 红字提示。
  - `send` → 走流式：
    1. push user message。
    2. `const stream = api.chat({ messages })`；`abortRef.current = stream.abort`。
    3. `for await (ev of stream.events)`：
       - `start` → 创建 `streaming = { text: "" }`。
       - `delta` → `streaming.text += ev.text`。
       - `finish` → 把 streaming 转成 assistant message push 到 `messages`，清空 streaming。
       - `error` → 把当前 streaming 转 assistant message（追加 `[interrupted]`），清空 streaming，再插入红字 system 消息。
    4. `finally` 清 `abortRef`。
- 渲染：`messages` 之后若 `streaming` 非空，额外渲染一行带光标的 partial assistant 消息。

---

## 7. HTTP API 契约

| 方法   | 路径               | Request                                  | Response                                                            | 说明                                                                          |
| ------ | ------------------ | ---------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET`  | `/models`          | —                                        | `ModelsListResponse`                                                | 不含 `apiKey`；含 `apiKeySource`                                              |
| `POST` | `/models/current`  | `SetCurrentModelRequest` `{ name }`      | `SetCurrentModelResponse` `{ current }` 或 `400` `{ error }`        | name 不存在返回 400 + 列出可用 names                                          |
| `POST` | `/agent/chat`      | `AgentChatRequest` `{ messages }`        | `text/event-stream` of `AgentStreamEvent`                            | SSE 流；客户端可 abort                                                        |

`AgentChatResponse`（旧的非流式 DTO）从 `@lordcode/shared` 移除。

### SSE 帧格式

每帧只用一个 `data:` 字段，内容是 `JSON.stringify(AgentStreamEvent)`：

```text
data: {"type":"start","model":"claude-haiku"}

data: {"type":"delta","text":"Hello"}

data: {"type":"delta","text":" world"}

data: {"type":"finish","finishReason":"stop","usage":{"inputTokens":12,"outputTokens":2}}
```

错误帧（流可能在任意时刻发出）：

```text
data: {"type":"error","message":"missing apiKey for claude-haiku"}
```

约定：

- `start` 总是第一帧（除非配置错误，此时只有 `error` 一帧）。
- `finish` 与 `error` 互斥；流以两者之一结束。
- 客户端 abort 后服务端不保证再发任何帧。

---

## 8. 关键数据流

### 8.1 server 启动

```text
worker boot
  └─ ConfigStore.load()
       ├─ ensureConfigDir
       ├─ if !exists: write skeleton {version:1,models:[]}
       ├─ readFile + jsonc parse
       ├─ zod validate  ── fail → throw → worker postMessage({type:"error"})
       ├─ if currentModel ∉ models: fallback to models[0]?.name ?? null
       └─ if changed: persist (atomic)
  └─ createApp({ configStore, ... })
  └─ serve → postMessage({type:"ready", baseUrl, port})
```

### 8.2 TUI 启动

```text
main()
  └─ startServerWorker → wait "ready"
  └─ render(<App />)
        └─ useEffect: api.listModels()
             ├─ models.length === 0 → 顶部红字告警
             └─ else: 状态栏显示 "model: <current>"
```

### 8.3 `/models`

```text
input "/models"
  └─ parseCommand → { kind: "models" }
       └─ api.listModels()
            └─ 渲染 system 消息：
               "name (provider · model · current? · key:env|plain|missing)"
```

### 8.4 `/model <name>`

```text
input "/model claude-haiku"
  └─ parseCommand → { kind: "set-model", name }
       └─ api.setCurrentModel(name)
            ├─ 200 → 更新 models.current；插入 system 消息 "switched to claude-haiku"
            └─ 400 → 红字 "no such model: claude-haiku (available: ...)"
```

### 8.5 chat（含取消）

```text
input "explain X"
  └─ parseCommand → { kind: "send", text }
       └─ messages.push(user)
       └─ stream = api.chat({ messages })
       └─ abortRef.current = stream.abort
       └─ for await ev of stream.events:
            ├─ start  → streaming = { text: "" }
            ├─ delta  → streaming.text += ev.text       (UI 实时刷新)
            ├─ finish → push assistant; streaming = null
            └─ error  → push assistant + "[interrupted]"; streaming = null; 红字
       └─ abortRef = null

input Esc (during streaming)
  └─ abortRef.current()
       └─ fetch abort → server c.req.raw.signal aborted
            └─ streamText abortSignal → 模型调用终止
            └─ 已发出的 partial 仍保留在 TUI
```

---

## 9. 边界情况 / 错误处理

| 场景                                     | 处理                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| 配置文件不存在                           | 自动创建 `{ "version": 1, "models": [] }`                                         |
| JSONC 解析失败                           | server 启动失败 → worker error → TUI 红字（含错误信息）                           |
| zod 校验失败                             | 同上；错误信息含字段路径                                                          |
| `models` 为空                            | server 起得来；chat 立刻返回 `error` 事件；TUI 顶部告警                           |
| `currentModel` 指向已删除模型            | 启动时降级 `models[0]?.name ?? null` 并写回                                       |
| `/model <name>` name 不存在              | 400 + 错误信息列出可用 names                                                      |
| chat 时 apiKey 拿不到                    | 流首帧即 `error: missing apiKey for <name> (set env <X> or apiKey)`               |
| 流中模型 API 报错                        | 已发出的 partial 保留 + `error` 帧 + TUI 标 `[interrupted]`                       |
| 用户 Esc                                 | 客户端 abort fetch；server `streamText` 收到 abortSignal；partial 保留            |
| 配置文件写半途崩溃                       | atomic write：写 `config.json.tmp` → `rename`（POSIX 原子）                       |
| 用户运行时手动编辑配置文件               | **不 hot-reload**；需重启 TUI；README 说明                                        |

---

## 10. 依赖

### 新增（server）

| 包                    | 用途                                            |
| --------------------- | ----------------------------------------------- |
| `ai`                       | Vercel AI SDK 核心（`streamText`、`LanguageModel`） |
| `@ai-sdk/openai`           | OpenAI provider（Responses API）                |
| `@ai-sdk/openai-compatible`| 通用 OpenAI 兼容 provider（Chat Completions）   |
| `@ai-sdk/anthropic`        | Anthropic provider                              |
| `@ai-sdk/deepseek`         | DeepSeek provider                               |
| `zod`                 | schema 校验                                     |
| `jsonc-parser`        | JSONC 解析                                      |

### 新增（tui）

| 包                    | 用途                            |
| --------------------- | ------------------------------- |
| `eventsource-parser`  | SSE 字节流 → event 解析         |

---

## 11. 不在本迭代

- 工具调用 / multi-step agent loop。
- 流式中途切换模型 / 暂停 / 重发。
- `/model add` `/model remove` `/model edit`。
- 配置 hot reload。
- OS keychain。
- 多 profile / per-project config。
- Web UI 接入（设计已留口，本迭代不实现）。
- 日志持久化、observability。

---

## 12. 验收标准

- [ ] `~/.lordcode/config.json` 不存在时启动 TUI，能看到红字告警，不崩溃。
- [ ] 手动写入合法 `config.json`，重启 TUI，状态栏显示 `model: <currentModel>`。
- [ ] `/models` 命令打印模型列表，标注 `current` 与 `apiKeySource`。
- [ ] `/model <name>` 切换成功，状态栏更新；`config.json` 中 `currentModel` 已写回。
- [ ] `/model nonexistent` 显示红字错误。
- [ ] 普通对话能看到 assistant 消息**逐字**出现。
- [ ] 生成中按 Esc 立刻停下，已显示的 partial 文本保留并标 `[interrupted]`。
- [ ] 配置中故意写错 `apiKeyEnv`（指向不存在的环境变量）→ 发消息时立刻收到 `missing apiKey` 错误。
- [ ] OpenAI / OpenAI-compatible / Anthropic / DeepSeek 四个 provider 至少各跑通一次。
