<!-- markdownlint-disable MD060 -->

# Chat Model — Unit Test Categories

本文档列出本迭代要覆盖的**单元测试场景**。

- 仅做单元测试，不做集成测试 / UI 测试。
- 每条场景描述"输入或前置 + 期望"，不含实现细节。

---

## 0. 测试框架与边界

- 测试框架：`vitest`。
- 文件系统：用临时目录（`os.tmpdir()` + 唯一子目录）模拟 `~/.lordcode/`，**不**碰真实 home。
- 网络：**不**起 server，**不**调真实 LLM。需要时通过 mock `fetch`、mock `streamText`、mock `@ai-sdk/*` 工厂注入 fake。
- 单元边界：测试只验证**单个模块**的行为契约；跨模块组合行为留给后续手测 / 集成测试。

---

## 1. 行为契约（决策记录，影响测试用例）

| # | 决策 | 选择 |
|---|---|---|
| Q1 | `parseCommand` 接收空输入的责任 | App 层拦截（输入空 trim 为空 → 直接 ignore，不调 parseCommand）。`parseCommand` 假定输入是 trim 后非空字符串 |
| Q2 | slash command 多余参数 | 宽松：忽略多余参数（`/models extra` → `models`；`/model gpt extra` → `set-model "gpt"`） |
| Q3 | slash command 大小写 | 严格区分大小写（`/Models` → `invalid`） |
| Q4 | SSE `data:` 帧 JSON parse 失败 | 跳过该帧，继续读后续帧（鲁棒） |
| Q5 | `resolveLanguageModel` 测试范围 | 仅做防御测试（未知 provider 抛错）；dispatch 正确性由真实路径手测覆盖 |

---

## 2. 服务端单元测试

### 2.1 `config/schema.ts` — `parseConfig`（纯函数）

| ID    | 场景                                                                                       | 期望                                                |
| ----- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| B1.1  | 合法 JSON 输入                                                                             | 返回正确解析的 `LordcodeConfig`                     |
| B1.2  | 合法 JSONC（含 `//` 注释、`/* */` 注释、尾随逗号）                                         | 正常解析                                            |
| B1.3  | 非法 JSONC（语法错误）                                                                     | 抛错；错误信息含位置或原因                          |
| B1.4  | `version` 缺失或不等于 `1`                                                                 | 抛错                                                |
| B1.5a | `models` 字段缺失                                                                          | 抛错                                                |
| B1.5b | `models: []`                                                                               | 合法                                                |
| B1.6  | `models[].name` 为空字符串                                                                 | 抛错                                                |
| B1.7  | `models[].name` 重复                                                                       | 抛错                                                |
| B1.8  | `models[].provider` 不在 `openai \| openai-compatible \| anthropic \| deepseek`             | 抛错                                                |
| B1.8b | `models[].provider = "openai-compatible"` 且 `baseURL` 已设                                  | 合法                                                |
| B1.8c | `models[].provider = "openai-compatible"` 且 `baseURL` 缺失                                  | 抛错；信息含 `baseURL`                              |
| B1.9  | `models[].model` 为空字符串                                                                | 抛错                                                |
| B1.10 | 同时缺 `apiKey` 与 `apiKeyEnv`                                                             | 抛错                                                |
| B1.11 | 仅 `apiKey`                                                                                | 合法                                                |
| B1.12 | 仅 `apiKeyEnv`                                                                             | 合法                                                |
| B1.13 | 同时存在 `apiKey` 与 `apiKeyEnv`                                                           | 合法                                                |
| B1.14 | `currentModel` 缺失                                                                        | 合法（`undefined`）                                  |
| B1.15 | `currentModel` 指向不存在的 name                                                           | schema 层**不**抛错（留给 store 处理）              |
| B1.16 | `baseURL` 不是 string                                                                      | 抛错                                                |
| B1.17 | 上述任一错误的错误信息                                                                     | 含字段路径（如 `models.1.provider`）                |

### 2.2 `config/paths.ts`

| ID   | 场景                                                          | 期望                                              |
| ---- | ------------------------------------------------------------- | ------------------------------------------------- |
| B2.1 | `getConfigPath()` 在 home 注入为 `<tmp>` 时返回的路径         | `<tmp>/.lordcode/config.json`                     |
| B2.2 | `ensureConfigDir()` 目录不存在                                | 创建目录；后续 `stat` 成功                        |
| B2.3 | `ensureConfigDir()` 目录已存在                                | 不抛错（idempotent）                              |

### 2.3 `config/store.ts` — `ConfigStore`（用 tmp dir）

| ID    | 前置                                                                                  | 期望                                                                     |
| ----- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| B3.1  | 配置文件不存在                                                                        | `load()` 创建 skeleton `{ version:1, models:[] }`，store 可用            |
| B3.2  | 合法配置                                                                              | `load()` 成功；`getCurrent()` / `list()` 与文件内容一致                  |
| B3.3  | `currentModel` 指向不存在的 name，`models` 非空                                       | `load()` 后 `currentModel` 降级为 `models[0].name` 并写回磁盘            |
| B3.4  | `currentModel` 失效且 `models` 为空                                                   | `load()` 后 `currentModel = null` 并写回磁盘                              |
| B3.5  | `currentModel` 已经合法                                                               | `load()` **不**触发额外写盘（验证文件 mtime 不变 / spy 未被调用）        |
| B3.6  | 配置文件 JSONC 解析失败                                                               | `load()` 抛错                                                            |
| B3.7  | 配置文件 zod 校验失败                                                                 | `load()` 抛错                                                            |
| B3.8  | 任意 store                                                                            | `list()` 返回的项**不**含 `apiKey` 字段                                  |
| B3.9  | `apiKeyEnv` 指向有值的环境变量                                                        | `list()` 中该项 `apiKeySource = "env"`                                    |
| B3.10 | `apiKeyEnv` 指向无值的环境变量                                                        | `list()` 中该项 `apiKeySource = "missing"`                                |
| B3.11 | 仅 `apiKey`                                                                           | `list()` 中该项 `apiKeySource = "plain"`                                  |
| B3.12 | `currentModel = null`                                                                 | `getCurrent()` 返回 `null`                                                |
| B3.13 | `setCurrent(name)` 且 name 存在                                                       | 内存更新；重新 `load()` 文件内容也已更新                                 |
| B3.14 | `setCurrent(name)` 且 name 不存在                                                     | 抛错；文件 / 内存均**不**变                                              |
| B3.15 | 任意写入                                                                              | 不留下 `.tmp` 中间文件；最终文件是合法 JSON                              |

### 2.4 `agent/apiKey.ts` — `resolveApiKey`（纯函数）

| ID   | 输入                                              | 期望              |
| ---- | ------------------------------------------------- | ----------------- |
| B4.1 | 仅 `apiKey = "X"`                                 | 返回 `"X"`        |
| B4.2 | 仅 `apiKeyEnv = "FOO"`，`process.env.FOO = "Y"`   | 返回 `"Y"`        |
| B4.3 | 仅 `apiKeyEnv = "FOO"`，`process.env.FOO` 未设    | 返回 `null`       |
| B4.4 | `apiKey = "X"` + `apiKeyEnv = "FOO"`，env 有值    | 返回 env 值（忽略 `apiKey`） |
| B4.5 | `apiKey = "X"` + `apiKeyEnv = "FOO"`，env 无值    | 返回 `"X"`        |
| B4.6 | `apiKeyEnv = "FOO"`，`process.env.FOO = ""`       | 视为无值（fallback / null） |
| B4.7 | 都没设                                            | 返回 `null`       |

### 2.5 `agent/provider.ts` — `resolveLanguageModel`（仅防御测试）

| ID   | 输入                                          | 期望                  |
| ---- | --------------------------------------------- | --------------------- |
| B5.1 | `cfg.provider` 为枚举外的值（强制类型转换）   | 抛错                  |

> 其他 dispatch 正确性由 spec §12 验收清单中"四个 provider 各跑通一次"覆盖。

### 2.6 `agent/stream.ts` — `streamAgent`（mock `streamText` + `ConfigStore`）

| ID   | 前置                                                                                            | 期望                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| B6.1 | `ConfigStore.getCurrent() = null`                                                               | 仅 yield 一帧 `error`（消息含"no model selected"语义）；无 `start`；generator 终止                              |
| B6.2 | `getCurrent()` 有值，但 `resolveApiKey` 返回 `null`                                              | 仅 yield 一帧 `error`（消息含 `apiKeyEnv` 名字）；无 `start`                                                    |
| B6.3 | mock `streamText` 的 `textStream` 产出 `["Hel", "lo"]`，正常 finish                              | yield 序列严格为 `start` → `delta("Hel")` → `delta("lo")` → `finish`                                            |
| B6.4 | 同 B6.3                                                                                         | `start` 帧的 `model` 字段等于 `currentModel.name`；`finish` 帧带 `finishReason` / `usage`（mock 提供时）         |
| B6.5 | mock `streamText` 在第二个 delta 后抛错                                                         | 已发的 `start` + 首个 `delta` 不撤回；之后 yield 一帧 `error`；generator 终止                                   |
| B6.6 | 提前 abort `ctx.signal`（在 mock 第一帧之前）                                                   | mock 的 abortSignal 收到 abort；不再 yield 后续 `delta`；generator 终止                                          |
| B6.7 | 同 B6.6 但 abort 在中途                                                                         | 已发出的帧不撤回；终止后不再发新帧                                                                              |

---

## 3. TUI 单元测试

### 3.1 `lib/commands.ts` — `parseCommand`（纯函数）

> 假定输入已经被 App 层 trim，且非空字符串。

| ID    | 输入                | 期望                                  |
| ----- | ------------------- | ------------------------------------- |
| C1.1  | `"hello"`           | `{ kind:"send", text:"hello" }`       |
| C1.2  | `"hello world"`     | `{ kind:"send", text:"hello world" }` |
| C1.3  | `"/models"`         | `{ kind:"models" }`                   |
| C1.4  | `"/models extra"`   | `{ kind:"models" }`（多余参数被忽略）  |
| C1.5  | `"/model"`          | `{ kind:"invalid", reason }`          |
| C1.6  | `"/model "`         | `{ kind:"invalid", reason }`          |
| C1.7  | `"/model gpt-4o"`   | `{ kind:"set-model", name:"gpt-4o" }` |
| C1.8  | `"/model gpt-4o x"` | `{ kind:"set-model", name:"gpt-4o" }`（多余参数被忽略） |
| C1.9  | `"/unknown"`        | `{ kind:"invalid", reason }`          |
| C1.10 | `"/Model gpt"`      | `{ kind:"invalid", reason }`（大小写敏感） |
| C1.11 | `"/"`               | `{ kind:"invalid", reason }`          |
| C1.12 | `"hello /models"`   | `{ kind:"send", text:"hello /models" }`（斜杠不在开头不是命令） |

### 3.2 `api/client.ts` — `chat` SSE 解析（mock `fetch` + `ReadableStream`）

> 用 `vi.stubGlobal("fetch", ...)` 替换全局 fetch；`Response` 的 `body` 由测试手工构造的 `ReadableStream<Uint8Array>` 提供，往里 enqueue SSE 字节流。

| ID    | 前置                                                                                             | 期望                                                                       |
| ----- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| C2.1  | 服务端依次 enqueue `start` / `delta("Hi")` / `delta(" there")` / `finish` 四帧后 close 流        | 客户端 `events` 顺序与内容完全一致                                          |
| C2.2  | 服务端发到第二个 `delta` 后**直接 close 流**（无 `finish`）                                      | 客户端 `events` 自然结束（不抛错；已收到的帧保留）                          |
| C2.3  | 服务端发 `start` 后发 `error` 帧并 close                                                         | 客户端正常 yield `start` 与 `error`；events 自然结束                        |
| C2.4  | 调用 `abort()` 后服务端读取 fetch 的 abortSignal                                                 | abortSignal `aborted` 为 true                                              |
| C2.5  | 调用 `abort()`                                                                                   | 客户端 events 干净结束（不向上抛 `AbortError` 或其他异常）                 |
| C2.6  | 服务端发了一帧合法 JSON、一帧非法 JSON（如 `data: {oops`）、再一帧合法 JSON，最后 close          | 客户端**跳过**非法帧；其余两帧正常 yield；events 正常结束                  |
| C2.7  | 服务端把多帧合并到**同一个 Uint8Array** 一次性 enqueue                                            | 客户端能正确切分并按顺序 yield 每一帧                                       |
| C2.8  | mock `fetch` 对 `GET /models` 返回 200 + 合法 JSON                                               | `listModels()` 返回该 JSON                                                  |
| C2.9  | mock `fetch` 对 `GET /models` 返回非 200                                                         | `listModels()` 抛错                                                         |
| C2.10 | mock `fetch` 对 `POST /models/current` 返回 200 + `{ current }`                                  | `setCurrentModel(name)` 返回该值                                            |
| C2.11 | mock `fetch` 对 `POST /models/current` 返回 400 + `{ error: "..." }`                              | `setCurrentModel(name)` 抛错；错误信息包含服务端 `error` 文案               |

---

## 4. 不在本迭代覆盖

- 集成测试（`routes/models.ts`、`routes/agent.ts` 的 HTTP 行为）
- UI 测试（`App.tsx` 的 ink 组件渲染 / 键盘交互）
- 真实 LLM 调用（OpenAI / OpenAI-compatible / Anthropic / DeepSeek 端到端）
- `resolveLanguageModel` 的 dispatch 正确性（B5.2~5）

这些项目以**手测 + 后续迭代**形式覆盖。

---

## 5. 场景计数

| 模块                              | 场景数 |
| --------------------------------- | ------ |
| `config/schema.ts` (B1)           | 20     |
| `config/paths.ts` (B2)            | 3      |
| `config/store.ts` (B3)            | 15     |
| `agent/apiKey.ts` (B4)            | 7      |
| `agent/provider.ts` (B5)          | 1      |
| `agent/stream.ts` (B6)            | 7      |
| `lib/commands.ts` (C1)            | 12     |
| `api/client.ts` (C2)              | 11     |
| **合计**                          | **76** |
