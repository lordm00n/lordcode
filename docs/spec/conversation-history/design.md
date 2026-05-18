<!-- markdownlint-disable MD060 -->

# Conversation History — Spec

本文档描述 lordcode 的**跨 turn 对话历史持久化**设计——把当前丢失的 tool call / tool result 等"非纯文本"消息纳入历史，使后续 turn（包括 ESC 中断后续命的 turn）拥有完整上下文。设计原则是**全链路对齐 Vercel AI SDK 的 `ModelMessage` 形状，server 保持无状态，TUI 是 history 的唯一权威**。

---

## 1. 概述

### 1.1 现状

- 单个 turn 内部，AI SDK 的 `streamText` + `stepCountIs(N)` 在**一次调用内**完成完整的 agent loop：模型 → tool call → SDK 执行 tool → tool result → 模型 → ...直到模型不再调 tool 或达到 step 上限。每一步的 `tool-call` / `tool-result` 由 SDK 自己维护并发回模型。
- 跨 turn 时，TUI → server 的 wire 只携带 `ChatMessage[]`，其 `role` 仅支持 `"user" | "assistant" | "system"`，且 `content` 仅支持 `string | (TextPart | ImagePart)[]`。没有任何位置承载 `tool-call` / `tool-result`。
- TUI 的 `entries` 数组里其实存了 `ToolEntry`（kind = "tool"），但在构建发送给 server 的 `messages` 时用 `.filter((e) => e.kind === "msg")` 直接丢弃；assistant 的 `reasoningDurationMs` 也只是 UI 元数据，不上 wire。
- 当前的 `ChatMessage` 形状是 SDK `ModelMessage` 的"窄子集"——`streamText({ messages })` 能直接吃 `ChatMessage[]`，是**结构同构**带来的隐式适配，没有显式转换层（见 `docs/spec/image-input/design.md` 决策 #10）。但这层"巧合的同构"只覆盖 user / assistant / system 三种 role，tool 相关消息从未在 wire 上出现。
- 结果：**上一 turn 模型用 tool 读到的真实内容、orphan 的 tool-call/result 状态全部丢失**；下一 turn 模型只能依靠"自己上次写的文本回复"来回忆，对工具产物只剩二手描述。

### 1.2 触发场景

| 场景 | 当前问题 |
| --- | --- |
| 上一 turn 模型 grep 了一段代码并回复"找到 5 处"，下一 turn 用户问"第二处具体内容是什么？" | 模型无法回到原 tool result，只能再 grep 一次 |
| 上一 turn 模型读了一个文件并基于内容给出建议，下一 turn 用户要求"按建议改这个文件" | 模型必须先重新读一遍——不仅慢，还可能错位（文件已变） |
| 模型在 turn 1 跑了一系列 tool 步骤但 ESC 中断；用户在 turn 2 说"继续刚才的" | 模型完全不知道"刚才"做到了哪一步、tool 返回了什么 |
| 模型在长 reasoning 后被 ESC 打断 | 推理过程彻底消失，TUI 仅看到 "Thought for Xs"，再次发送时模型重头思考 |

### 1.3 设计思路

不再自定义 `ChatMessage`，而是直接以 SDK 的 [`ModelMessage`](https://ai-sdk.dev/docs/foundations/prompts#message-prompts) 作为 wire format：

```ts
// from @ai-sdk/provider-utils (re-exported via `ai`)
type ModelMessage = SystemModelMessage | UserModelMessage | AssistantModelMessage | ToolModelMessage;
```

数据流向：

```text
            ┌────── SSE 事件 ──────┐
            │  text-delta          │
 streamText │  tool-call           │           ┌──── accumulator ────┐
   ↑↓       │  tool-result         │ ─────────▶│ 累加成 ModelMessage[]│
 server 透传│  tool-error          │           └──────────┬──────────┘
            │  finish              │                      │
            └──────────────────────┘                      ▼
                                                   history (ModelMessage[])
                                                          │
                                                 deriveEntries(history)
                                                          │
                                                          ▼
                                                       Entry[] (UI)
```

- **server** 完全保持无状态；现有 `streamAgent` → `streamText` 透传逻辑**几乎不动**，仅把类型签名从 `ChatMessage[]` 升级到 `ModelMessage[]`。
- **TUI** 用**纯函数累加器**把已有的 SSE 事件流（`text-delta` / `tool-call` / `tool-result` / `tool-error`）实时累加成 `ModelMessage[]`，作为 history 的权威表示。
- **UI 渲染**通过 `deriveEntries(history)` 派生出现在用的 `Entry[]`——这一步几乎等价于旧的 `buildAssistantSegment` + segment 切分逻辑。
- 下次发送时，TUI 把完整 `ModelMessage[]` 提交给 server，server 直接喂给 `streamText`，**全链路同一份类型**。

带来三个好处：

1. **零适配层**：TUI ↔ server ↔ AI SDK ↔ Provider 都用同一份类型；现在隐式的"结构同构"升级为显式的"类型同构"，TS 编译器替我们盯死。
2. **跨 turn tool 上下文完整**：包括 ESC 中断场景——只要某一 step 在中断前已完整收齐（assistant tool-call + 对应 tool-result），它在累加器里就已 flush 进 history，下个 turn 完整可见。
3. **wire 不冗余**：TUI 已经在为 UI 渲染处理这些事件（参见 `App.tsx` 第 251–352 行的事件累加），目标类型从 `Entry` 改为 `ModelMessage` 即可——不需要在 SSE 流上重复一遍 tool result 内容。

---

## 2. 目标 & 范围

### 2.1 In Scope

- `@lordcode/shared` 的 `ChatMessage` 替换/扩展为 SDK 兼容的 `ModelMessage` 形状（保留 `ChatMessage` 别名做软兼容）。
- `AgentChatRequest.messages` 改为 `ModelMessage[]`；server 端 `streamAgent` 直接透传给 `streamText`。
- 新增 TUI 端的 `accumulate(state, event) → state` **纯函数**：把 `AgentStreamEvent` 流累加成 `ModelMessage[]`（含 AssistantModelMessage + ToolModelMessage），含完整的 step 边界识别规则。
- 新增 TUI 端的 `deriveEntries(history) → Entry[]`：把 `ModelMessage[]` 投影为 UI 渲染节点，覆盖旧的 segment 切分逻辑。
- ESC 中断时：已 flush 的完整 step 必须保留；in-flight（未配对完整）的内容丢弃，仅在 UI 显示带 `[interrupted]` 标记。
- TUI 入口前，对历史做 **conversation integrity 检查 / 修复**：`repairOrphanToolCalls(messages)` 保证发出去的 `ModelMessage[]` 满足"每个 tool-call 都有对应 tool-result"（用合成 cancelled 标记兜底），否则部分 provider 会拒接。
- 关键纯函数（`accumulate` / `deriveEntries` / `repairOrphanToolCalls`）的单测覆盖。
- 现有的 `chat-entries.ts` 中 `collapseMessageEntries`、`buildAssistantSegment`、`upgradeToolEntry` 等函数随之删除或合并到新模块。

### 2.2 Out of Scope（明确不做）

- 改动 `AgentStreamEvent` 的 wire 形状（不新增 SSE 事件类型；现有事件流已足够 TUI 累加）。
- Server 端持久化对话（保持无状态；持久化由 TUI 持有 history 实现，重启后丢失，与当前一致）。
- 多会话 / session 切换（一期 TUI 仍是单会话上下文）。
- 历史长度 / token 预算管理（不做自动 prune；后续如遇上下文超限再加 trim 策略）。
- 把 reasoning 内容跨 turn 回放给模型——AI SDK 默认不持久化 reasoning text；保留 `reasoning-delta` 仅作 UI 展示用（与当前一致）。
- 多模态 tool result（image-data 等 `output.type === "content"` 的形态）——一期 tool 都只产 `output.type === "json" | "text"`。
- Web UI（设计已留口，但本迭代仅 TUI 改造）。
- 历史导入 / 导出 / 文件落盘。
- Provider-specific cache control（`providerOptions.anthropic.cacheControl` 之类）的自动注入。

---

## 3. 关键设计决策

| #   | 决策                                              | 选择                                                                                                                          | 理由                                                                                                                                       |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | wire format 形状                                   | 直接复用 SDK 的 `ModelMessage`                                                                                                  | 端到端零适配；现状已经是这个形状的"窄子集"了，升级到完整集合让 TS 替我们盯死                                                                              |
| 2   | 类型 re-export 位置                                | `@lordcode/shared` 用 `import type` 从 `ai` 取类型                                                                              | type-only import 不引入运行时依赖，不破坏 shared "dependency-free contracts" 的语义；避免手抄类型导致 SDK 升级时漂移                                  |
| 3   | message 的生产方                                    | **TUI 端**：从既有 SSE 事件累加成 `ModelMessage[]`；server 不推回任何"已生成消息"                                                          | TUI 已在为 UI 渲染累加这些事件（见 `App.tsx` 第 251–352 行），换个目标类型即可；wire 不冗余；server 改动面最小                                              |
| 4   | step 边界如何在 TUI 累加器中识别                       | **事件类型转移触发 flush**：`text/tool-call → tool-result` 转移时 flush 当前 assistant；`tool-result → text/tool-call` 转移时 flush 当前 tool message | LLM provider 协议本身的形状：一个 step = 0~N text + 0~N tool-call 组成的 assistant + 可选的 tool-result 组成的 tool message；该状态机非常稳定        |
| 5   | 并行 tool-call 的累加规则                           | 连续多个 `tool-call` 聚合到**同一** `AssistantModelMessage.content`（多个 `ToolCallPart`）；连续多个 `tool-result` 聚合到**同一** `ToolModelMessage.content` | OpenAI / Anthropic 协议都把 parallel calls 放在同一条 assistant message；累加器只看事件序列即可，不需要 step 元数据                                       |
| 6   | TUI 内部 history 与 entries 的关系                  | `history: ModelMessage[]` 是权威；`entries: Entry[]` 通过 `useMemo(() => deriveEntries(history), [history])` 派生                  | 单源真实；避免双向同步出错；entries 只是 UI 投影                                                                                                       |
| 7   | ESC 中断时累加器中 in-flight 的 step 怎么办            | **丢弃** in-flight 的 partial assistant / partial tool；不 flush 进 history                                                          | "in-flight" 在累加器里意味着缺对应的 tool-result 或缺下一种事件触发 flush；强行入库会让下一 turn 收到非法历史                                                |
| 8   | 中断前已部分流出的 assistant 文本                    | UI 端在 streaming panel 中标 `[interrupted]` 显示；**不**进 history                                                                  | 流式 text 没有对应的 step 完成信号；下一 turn 让模型完全不知道"那段半句话"反而比让它误以为说完了更安全；与方案 A 一致                                       |
| 9   | orphan tool-call 修复策略                          | 提交前 `repairOrphanToolCalls(messages)`：任何 assistant 消息中孤悬的 `tool-call` part（没有 matching tool-result）合成一条 cancelled 结果             | 部分 provider（OpenAI / Anthropic）会拒绝 unmatched tool_call；合成"用户中断"语义的 result 比丢整条 assistant 消息保留信息量更大                          |
| 10  | tool 修复合成的 output 形状                        | `{ type: "json", value: { interrupted: true, reason: "user_cancelled" } }`                                                    | 保持 `ToolResultOutput` 合法形状；模型读到后能理解"上次这个 tool 没真的执行完"，自行决定是否重试                                                          |
| 11  | history 上限 / 自动 trim                           | **不做**；上下文超限直接让 provider 抛错并 surface 到 SSE `error`                                                                          | MVP 不引入隐式行为；trim 策略涉及"删谁、保多少"的取舍，留到出现真实超限案例后再设计                                                                       |
| 12  | reasoning 是否回放到模型                           | **不回放**（仅 `reasoningDurationMs` 作 UI 标签）                                                                                          | SDK 默认行为；reasoning 内容通常 provider 不接受 echo 回去，部分模型甚至会被搞乱；与现状一致                                                              |
| 13  | system message 怎么来                              | 一期仍由 server 端不显式注入；如未来加 `system` prompt，走 `streamText` 的 `system` 选项而不是 `messages[0]`                                   | 避免历史里塞一条 user 看不到也改不动的 `role: "system"`；保持 messages 数组 = "用户可见对话"                                                              |
| 14  | provider-specific `providerOptions` 是否上 wire    | **是**，但 TUI 不感知；server 收到后原样透传                                                                                                | 未来若加 anthropic 的 `cacheControl` 等，只需在某条 message 上挂 `providerOptions`，wire 已支持                                                          |
| 15  | 兼容性：旧的 `ChatMessage` 怎么过渡                 | 软兼容：保留 `ChatMessage` 类型别名指向 `ModelMessage`；server 端在收到 messages 时不做 schema 校验（与现状一致）                                    | 渐进切换；TUI 一次性升级到 `ModelMessage` 之后 alias 可移除                                                                                                |
| 16  | `result.response.messages` 是否使用                | **不使用**——TUI 累加器是 single source of truth；server 上的 `response` promise 在 abort 路径不可靠，且现在压根不需要                                | TUI 端从事件累加，跟 server 端 `result.response` 互为印证但 wire 上不重复                                                                                  |
| 17  | `tool-error` 怎么进 history                       | 当成 `tool-result`：合成一条 `output: { type: "json", value: { error: <message>, errored: true } }` 的 `ToolModelMessage`                  | SDK 在 `tool-error` 后会自己把错误反馈给模型；模型预期 history 里有 tool 输出；保持 assistant tool-call + tool result（error 标记）的成对结构                |

---

## 4. 架构总览

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                              Node.js Process                                   │
│                                                                                │
│  ┌──────────────────────────────────────────────┐    ┌──────────────────────┐ │
│  │              Main Thread (Ink TUI)            │    │   Worker Thread      │ │
│  │                                               │    │   (Hono Server)      │ │
│  │  history: ModelMessage[]   (canonical)        │    │                      │ │
│  │  ┌─────────────────────────────────────────┐  │    │  POST /agent/chat    │ │
│  │  │  ┌─ UserModelMessage      (turn1 user)   │  │    │     ↓                │ │
│  │  │  ├─ AssistantModelMessage(tool-call A)  │  │    │  streamAgent(        │ │
│  │  │  ├─ ToolModelMessage      (result A)    │  │    │    messages,         │ │
│  │  │  ├─ AssistantModelMessage(text)         │  │    │    { signal, ... })  │ │
│  │  │  ├─ UserModelMessage      (turn2 user)  │  │    │     ↓                │ │
│  │  │  └─ ...                                 │  │    │  streamText({        │ │
│  │  └────────────┬────────────────────────────┘  │    │    messages, tools,  │ │
│  │               │ deriveEntries(history)         │    │    stopWhen, signal  │ │
│  │  ┌────────────▼────────────────────────────┐  │    │  })                  │ │
│  │  │ entries: Entry[]   (rendered view)       │  │    │     ↓                │ │
│  │  │   - MessageEntry / ToolEntry / System    │  │    │  for await chunk of  │ │
│  │  └─────────────────────────────────────────┘  │    │   result.fullStream  │ │
│  │                                               │    │     ├─ text-delta────┼─┐
│  │  on SSE event (text-delta / tool-call /       │    │     ├─ tool-call ───┼┐│
│  │                 tool-result / tool-error):    │    │     ├─ tool-result ─┼┐││
│  │     accState = accumulate(accState, event)    │    │     ├─ tool-error ──┼┼┤│
│  │     // accumulator emits new ModelMessage(s)  │    │     └─ finish        │││
│  │     // on event-type transitions; flushes     │    │                       │││
│  │     // them into history                      │    │     forward raw      │││
│  │                                               │◀───┤──── as SSE ──────────┼┘│
│  │  handleSend(text):                            │    │                       │ │
│  │     1. push UserModelMessage(text) to history │    │                       │ │
│  │     2. POST /agent/chat                       │────▶                       │ │
│  │        { messages: repairOrphanToolCalls(     │    │                       │ │
│  │                       history) }              │    │                       │ │
│  └───────────────────────────────────────────────┘    └───────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
```

关键观察：

- server 端的 `streamAgent` 与现状几乎完全一致——只换类型签名。`fullStream` switch 不新增 case。
- TUI 端用累加器替换掉现有的 `acc: string` + `setEntries` 手写累加；权威格式从 `Entry[]` 变成 `ModelMessage[]`。
- `accumulate` 是纯函数，便于单测；`deriveEntries` 也是纯函数（无状态投影）。

---

## 5. 数据模型

### 5.1 共享类型（`@lordcode/shared`）

```ts
// type-only re-export (no runtime cost; preserves shared's dependency-free contract)
export type {
  ModelMessage,
  AssistantModelMessage,
  ToolModelMessage,
  UserModelMessage,
  SystemModelMessage,
  TextPart,
  ImagePart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
  AssistantContent,
  UserContent,
  ToolContent,
  ToolResultOutput,
} from "ai";

// alias for soft backward compat during migration
export type ChatMessage = ModelMessage;

export interface AgentChatRequest {
  messages: ModelMessage[];
}

// AgentStreamEvent: 与现状完全一致，不新增事件类型
export type AgentStreamEvent =
  | { type: "start"; model: string }
  | { type: "delta"; text: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning-end" }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; toolName: string; message: string }
  | { type: "finish"; finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number }; aborted?: boolean }
  | { type: "error"; message: string };
```

### 5.2 TUI 端累加器（`packages/tui/src/lib/history-accumulator.ts` *new*）

```ts
import type {
  AgentStreamEvent,
  AssistantContent,
  AssistantModelMessage,
  ModelMessage,
  ToolContent,
  ToolModelMessage,
} from "@lordcode/shared";

/**
 * Rolling state used by `accumulate`. Captures messages that have been fully
 * flushed into `history` plus any in-flight assistant / tool message being
 * built up from the current event run.
 *
 * Invariants:
 * - At most one of `pendingAssistant` / `pendingTool` is non-null at any time:
 *   we transition assistant → tool when a `tool-result` arrives, and tool →
 *   assistant when a subsequent `text-delta` / `tool-call` arrives.
 * - `history` only ever grows by full ModelMessages (never partial).
 */
export interface AccumulatorState {
  history: ModelMessage[];
  pendingAssistant: AssistantInFlight | null;
  pendingTool: ToolInFlight | null;
}

interface AssistantInFlight {
  /** Text accumulated so far in this assistant message (across multiple deltas). */
  text: string;
  /** Tool-call parts collected so far in this assistant message (parallel calls). */
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[];
}

interface ToolInFlight {
  /** Tool-result / tool-error parts collected so far for this tool message. */
  results: {
    toolCallId: string;
    toolName: string;
    output: unknown;
    /** Set when accumulated via tool-error rather than tool-result. */
    errored?: boolean;
    errorMessage?: string;
  }[];
}

export const initialAccumulatorState: AccumulatorState = {
  history: [],
  pendingAssistant: null,
  pendingTool: null,
};

/**
 * Apply one SSE event to the accumulator. Pure; returns a NEW state value.
 *
 * Flush rules (event-type transitions):
 * - tool-result / tool-error arriving → flush pendingAssistant into history,
 *   then append the result to pendingTool (start a new ToolInFlight if needed).
 * - text-delta / tool-call arriving while pendingTool != null → flush pendingTool
 *   into history, then start a new AssistantInFlight.
 * - text-delta accumulates into pendingAssistant.text.
 * - tool-call appends to pendingAssistant.toolCalls.
 * - `finish` flushes any pendingAssistant and pendingTool.
 * - `start`, `reasoning-*`, `error` do not affect history (UI-only).
 */
export function accumulate(
  state: AccumulatorState,
  event: AgentStreamEvent,
): AccumulatorState;

/**
 * Adopt the user's outgoing message at send time. Pure; appends and resets
 * pending state (any pending content would be invalid history and is dropped).
 */
export function appendUserMessage(
  state: AccumulatorState,
  message: ModelMessage,
): AccumulatorState;
```

### 5.3 TUI 端派生（`packages/tui/src/lib/derive-entries.ts` *new*）

```ts
/**
 * Project the canonical history (+ optional in-flight streaming state) into
 * the UI's Entry[] shape. Pure; no state.
 *
 * Splits a multi-part assistant message into:
 *   - one MessageEntry for its text part (if any),
 *   - one ToolEntry per tool-call part (matched up with results from the
 *     following ToolModelMessage if present, otherwise rendered as `phase: "call"`).
 */
export function deriveEntries(
  history: ModelMessage[],
  streaming?: {
    text: string;
    reasoningDurationMs: number | null;
  },
): Entry[];
```

`MessageEntry` 与 `ToolEntry` 的结构与现状基本一致（仅 `MessageEntry` 不再含 `kind: "msg"` 之外的对话字段——它就是某条 ModelMessage 的纯文本投影）。

### 5.4 修复函数（`packages/tui/src/lib/repair-history.ts` *new*）

```ts
/**
 * Ensure every tool-call part in assistant messages has a matching tool-result
 * (or synthetic cancelled result) in a following ToolModelMessage. Pure;
 * deterministic; returns a new array.
 *
 * Used right before submitting `history` to /agent/chat: in-flight tool calls
 * dropped by the accumulator at abort time are already absent, but historical
 * orphans (e.g. from a prior session if we ever add persistence) get patched.
 *
 * In the current accumulator design this should be a no-op in steady state;
 * keeping it ensures correctness if upstream invariants break.
 */
export function repairOrphanToolCalls(messages: ModelMessage[]): ModelMessage[];
```

合成的 result 形态：

```ts
{
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "<id>",
      toolName: "<name>",
      output: {
        type: "json",
        value: { interrupted: true, reason: "user_cancelled" },
      },
    },
  ],
}
```

---

## 6. 端到端流程

### 6.1 场景 A：正常 turn（无 tool）

1. 用户输入 → TUI `handleSend(text)`
2. TUI 通过 `appendUserMessage` 把 `{ role: "user", content }` 入 history
3. TUI POST `/agent/chat` with `{ messages: repairOrphanToolCalls(history) }`（无 orphan，恒等返回）
4. server `streamAgent` → `streamText`
5. fullStream 上多次 `text-delta` → server emit `delta`
6. TUI 收到 `delta`：`accumulate` 把 text append 到 `pendingAssistant.text`
7. fullStream 结束 → server emit `finish`
8. TUI 收到 `finish`：`accumulate` flush `pendingAssistant` → push `AssistantModelMessage { role: "assistant", content: [{ type: "text", text: acc }] }` 到 history
9. UI 关闭 streaming 面板；`deriveEntries(history)` 自然包含新 assistant 段

### 6.2 场景 B：正常 turn（带 tool-call，单 step 单 tool）

1-4 同上
5. **Step 1**：模型 emit tool-call（如 grep）
   - fullStream: `tool-call` → server emit `tool-call`
   - TUI 累加器：`pendingAssistant.toolCalls.push({ id, name, input })`（若之前没有 pendingAssistant 则现起）
   - SDK 执行 tool（异步 await `tool.execute(input, { abortSignal })`）
   - fullStream: `tool-result` → server emit `tool-result`
   - TUI 累加器：**事件类型转移**触发 flush——push `AssistantModelMessage(text + toolCalls)` 到 history；开新 `pendingTool`，把 result append 进去
6. **Step 2**：模型基于 tool result 生成最终文本
   - fullStream: `text-delta` 多次 → emit `delta`
   - TUI 累加器：**事件类型转移**触发 flush——push `ToolModelMessage(results)` 到 history；开新 `pendingAssistant`，把 text 累加进去
7. fullStream 结束 → emit `finish`
8. TUI 累加器：flush `pendingAssistant` → push `AssistantModelMessage(text)` 到 history

历史最终包含：
```
[user, assistant(tool-call), tool(result), assistant(text)]
```

下一 turn 直接拿这条 history 发，模型完整记得这次 tool 的输入和输出。

### 6.3 场景 C：并行 tool-call（一个 step 内多个 tool）

5. Step 1：模型同时 emit tool-call A 和 tool-call B（parallel）
   - 累加器：`tool-call A` → push 到 `pendingAssistant.toolCalls`；`tool-call B` → push 到同一 `pendingAssistant.toolCalls`
   - SDK 并行执行 A 和 B
   - `tool-result A` 到达：转移触发，flush assistant（包含 A、B 两个 tool-call part）→ 开 `pendingTool`，append A 的 result
   - `tool-result B` 到达：仍在 `pendingTool` 状态（连续 tool-result，无类型转移），append B 的 result 到同一 `pendingTool`
6. Step 2：模型生成 text → 转移触发，flush tool（包含 A、B 两个 result part），开 `pendingAssistant`
7. ...同 §6.2

历史：
```
[user, assistant(toolCallA, toolCallB), tool(resultA, resultB), assistant(text)]
```

### 6.4 场景 D：ESC 中断（中断发生在 step 之间，正在流文本）

假设 §6.2 中 step 1 已完整收齐、step 2 文本流到一半时用户按 ESC：

1. TUI: `abortRef.current?.()` → `controller.abort()`
2. fetch signal 触发，SSE 连接断开
3. server: `c.req.raw.signal.aborted === true` → `streamAgent` `for await` 循环里 `ctx.signal?.aborted` 检查命中 → return
4. server 端不再有事件流出；TUI 也不再收到 `finish`
5. TUI 累加器当前状态：history 末尾 = step 1 的 `assistant(tool-call) + tool(result)`（已 flush）；`pendingAssistant` 持有 step 2 的部分文本
6. TUI 处理中断：**丢弃** `pendingAssistant`（不 flush 进 history），只在 streaming panel 的 UI 上保留 `[interrupted]` 标记的显示节点
7. 下一 turn：用户输入"继续刚才的"
8. TUI: `appendUserMessage(history, { role: "user", content: "继续刚才的" })` → `repairOrphanToolCalls`（step 1 的 tool-call 已配对 result，无需修复）→ POST
9. 模型收到完整的 turn 1 step 1 + turn 2 user，知道 tool 跑过、知道结果、知道用户想继续

### 6.5 场景 E：ESC 中断（中断发生在 tool 执行中）

step 1 模型 emit `tool-call`，SDK 正在 execute，用户按 ESC：

1. abort 信号传到 `tool.execute(input, { abortSignal })`；tool 抛 abort 错误
2. SDK 把错误转发到 fullStream → `tool-error` → server emit `tool-error`
3. TUI 累加器收到 `tool-error`：按决策 #17，作为一个 errored result 合并到 `pendingTool`（事件类型转移逻辑与 tool-result 相同），flush 当前 assistant 到 history
4. SDK 端因 abort 信号 fullStream 结束；server: signal.aborted → return；TUI **不**收到 `finish`
5. TUI 处理中断：累加器中已无 in-flight 内容；history 末尾是完整的 `assistant(tool-call) + tool(errored result)` 对
6. 下一 turn：history 包含一对"模型尝试调 tool，结果是 cancelled"的对话，模型可读
7. UI 端：streaming panel 显示 `[interrupted]`

> 注：若 SDK 在某些 abort 路径下**不** emit `tool-error`（行为待 §8 Open Q #2 验证），则累加器的 `pendingAssistant` 里会留下 orphan 的 tool-call part 而无对应 result。这正是 `repairOrphanToolCalls` 在发送前兜底的场景——合成一条 cancelled result 接上，避免 provider 拒接。

### 6.6 场景 F：连续多 turn 累积

```
turn1: history = [user1, asst1(tool-call), tool1(result), asst1(text)]
turn2: appendUserMessage → POST repairOrphanToolCalls([..., user2])
       SDK 跑新的 agent loop（可能又有 N 个 step）
       SSE 事件流 → 累加器 → history append × M (每次 step 边界 flush)
       finish → 最后一次 flush
turn3: ...
```

server 端始终无状态，每次都从 client 收到完整 `messages`。

---

## 7. 影响面（按文件）

### 7.1 `@lordcode/shared`

| 文件                           | 变更                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/api.ts`   | 删除自定义 `ChatRole` / `ChatMessage` / `TextPart` / `ImagePart` / `ContentPart`；改为 type-only re-export `ai` 的对应类型；保留 `ChatMessage` 作为 `ModelMessage` 别名；`AgentChatRequest.messages` 类型改为 `ModelMessage[]`；`AgentStreamEvent` **不变** |
| `packages/shared/package.json` | 加 `ai` 为 `devDependency`（只用于类型）。运行时不引入 `ai` 包                                                                  |

> **取舍**：`ai` 进 shared 的 `devDependency` 而非 `dependency`，是 type-only import + 不在 build 输出里 import 任何运行时符号的前提下做到的；如果工具链对 type-only import 处理不当导致打进 bundle，备选方案是把需要的类型片段（约 6–8 个 interface）手抄到 shared 并加 SDK 版本注释。

### 7.2 `@lordcode/server`

| 文件                                      | 变更                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `packages/server/src/routes/agent.ts`     | `body.messages` 类型签名从 `ChatMessage[]` 改为 `ModelMessage[]`（运行时校验保持不变） |
| `packages/server/src/agent/stream.ts`     | `streamAgent` 的 `messages` 参数类型签名升级；**fullStream switch 不变**             |
| `packages/server/src/agent/stream.test.ts`| 测试 fixtures 中的 messages 改用 ModelMessage 形状（tool message 等）；新增 turn 包含 tool 消息时也能正确转发的用例 |

> server 端的运行时代码**几乎不动**——只换类型。

### 7.3 `@lordcode/tui`

| 文件                                                  | 变更                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/tui/src/lib/history-accumulator.ts` *(new)* | `accumulate(state, event)` / `appendUserMessage(state, msg)` / `initialAccumulatorState` 纯函数 + 单测                                                              |
| `packages/tui/src/lib/derive-entries.ts` *(new)*      | `deriveEntries(history, streaming?)` 纯函数 + 单测                                                                                                                  |
| `packages/tui/src/lib/repair-history.ts` *(new)*      | `repairOrphanToolCalls(messages)` 纯函数 + 单测                                                                                                                    |
| `packages/tui/src/lib/chat-entries.ts`                | 删除 `collapseMessageEntries` / `buildAssistantSegment` / `upgradeToolEntry`；保留 `Entry` / `MessageEntry` / `ToolEntry` / `SystemEntry` 的类型定义                  |
| `packages/tui/src/components/App.tsx`                 | `entries` state 替换为 `accState: AccumulatorState` state；事件处理统一为 `setAccState(s => accumulate(s, ev))`；`entries` 改为 `useMemo(() => deriveEntries(history, streaming), [history, streaming])`；`handleSend` 用 `repairOrphanToolCalls` 处理 wire payload；删除旧的 `acc: string` / `setEntries` 累加逻辑 |
| `packages/tui/src/api/client.ts`                      | 类型签名迁移到 `ModelMessage`；`AgentStreamEvent` 不变                                                                                                                |
| `packages/tui/src/lib/compose-message.ts`             | `composeContent` 不变（仍是 user content 的形状）                                                                                                                    |

### 7.4 测试增量

- `history-accumulator.test.ts`：
  - 纯 text turn：start → delta×N → finish 后得到一条 `AssistantModelMessage`
  - 单 tool turn：start → tool-call → tool-result → delta → finish，得到 `[assistant(tool-call), tool(result), assistant(text)]`
  - 并行 tool turn：tool-call A → tool-call B → tool-result A → tool-result B → ...
  - 中断 in-flight assistant：丢弃 pendingAssistant
  - 中断 in-flight tool（tool-error 路径）：作为 errored result 合并
  - reasoning 事件不影响 history（仅 UI）
- `derive-entries.test.ts`：multi-part assistant 切成 (message segment + tool entries) 正确顺序；空 history + streaming 单独投影
- `repair-history.test.ts`：orphan tool-call 修复矩阵（0 个 / 1 个 / 多个 / 部分配对）
- `App` 集成测：完整 turn → history 正确累积；下一 turn POST 携带完整 history（含 tool 消息）

---

## 8. Open Questions

| #   | 问题                                                                                                                          | 当前倾向                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | `@lordcode/shared` 用 type-only re-export `ai` 类型是否会被工具链（tsup / tsc）误打进 bundle                                              | 实测验证；若中招则改为手抄类型片段并加 SDK 版本注释                                                                                |
| 2   | SDK 在 tool 执行被 abort 时是否一定 emit `tool-error` 事件到 fullStream                                                                  | 待源码 / 实测验证；若不 emit 则依赖 `repairOrphanToolCalls` 在发送前补救                                                            |
| 3   | 并行 tool-call 的事件顺序是否一定是"所有 call 在所有 result 之前"                                                                          | 当前累加器在 §3 决策 #4 / #5 假设此顺序；SDK 文档暗示 step 内 calls 先聚合再统一执行；待实测验证。**最坏情况**累加器需放松到"任何 tool-result 都先 flush pendingAssistant" |
| 4   | `tool.execute` 的返回值在 fullStream 上是裸值还是已包成 `ToolResultOutput`                                                              | 现 `stream.ts` 第 237 行 `output: chunk.output` 是裸值；累加器写入 history 时需包成 `{ type: "json", value: chunk.output }`        |
| 5   | history 在 TUI 进程退出时是否需要持久化到磁盘（恢复对话）                                                                          | 一期不做；明确为 Out of Scope                                                                                              |
| 6   | 模型生成的 `ReasoningPart` 是否要进 history                                                                                    | 不进；SDK 默认也不要求回放                                                                                                |
| 7   | `usePaste` 引入的 user image content 与新的 `UserContent` 类型是否完全一致                                                              | 字段名 / 字段类型均一致（`image: string` + `mediaType: string`）；纯类型迁移                                                       |

---

## 9. 不在本 spec 内但相关的未来工作

- **Conversation 持久化**：把 history 存到 `~/.lordcode/sessions/<id>.jsonl`，支持 `lordcode resume <id>`。
- **History pruning**：上下文窗口接近上限时按"保留最近 N 个 turn + system + 最早的 user prompt"自动 trim。
- **Multi-session UI**：TUI 内 tab 切换不同 conversation。
- **Streaming reasoning persistence**：少数支持的 provider（如 anthropic extended thinking）的 reasoning 显式入库以支持 turn 间的 "thought chaining"。
- **Tool approval**：在 `streamText` 选项加 `needsApproval`，TUI 渲染确认 UI，approval 决定通过新 SSE 事件回传。
- **Provider cache control**：Anthropic prompt caching / OpenAI cache prefix 的自动注入。
