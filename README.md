<!-- markdownlint-disable MD060 -->

# lordcode

一个本地的 coding agent，采用 TUI + 内嵌 HTTP server 的双线程架构。

## 架构

```
┌─────────────────────────────────────────────────────┐
│                 Node.js Process                     │
│                                                     │
│  ┌──────────────────┐         ┌──────────────────┐  │
│  │   Main Thread    │  HTTP   │  Worker Thread   │  │
│  │                  │ ──────► │                  │  │
│  │   Ink TUI        │         │   Hono Server    │  │
│  │   (@lordcode/tui)│ ◄────── │ (@lordcode/server)│ │
│  │                  │         │   + Agent core   │  │
│  └──────────────────┘         └──────────────────┘  │
│                                                     │
└─────────────────────────────────────────────────────┘

                  Future:
        ┌──────────────────────────┐
        │   Web UI (browser)       │
        │   (@lordcode/web)        │
        └──────────────────────────┘
                    │ HTTP
                    ▼
              same Hono server
```

- **主线程** 跑 Ink TUI，负责渲染与输入。
- **Worker 线程** 跑 Hono HTTP server，负责 agent 逻辑与 API。
- TUI 与 server 通过 **HTTP** 通信（也方便后续接入 web UI）。
- 共享类型与 API 契约抽到 `@lordcode/shared`。

## 目录结构

```
lordcode/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── packages/
    ├── shared/   # @lordcode/shared  —— 共享类型 / API 契约
    ├── server/   # @lordcode/server  —— Hono HTTP server + agent
    ├── tui/      # @lordcode/tui     —— Ink TUI（项目入口）
    └── web/      # @lordcode/web     —— [预留] 未来的 web UI
```

## 配置模型

lordcode 通过本地配置文件来声明可用的模型，**没有交互式向导**——直接编辑文件即可。

### 配置文件位置

`~/.lordcode/config.json`

首次启动 TUI 时如果文件不存在，会自动创建一个空骨架 `{ "version": 1, "models": [] }`，TUI 顶部会用红字提示 `no models configured`，此时无法发起对话——按下面的步骤补齐配置后**重启 TUI**。

> 设计上不做 hot-reload，运行时手动改文件不会生效。

### 文件格式

JSONC（JSON with Comments）：允许 `//` 和 `/* */` 注释，以及尾随逗号。

### 字段说明

| 字段          | 类型                                  | 必填 | 说明                                                                       |
| ------------- | ------------------------------------- | ---- | -------------------------------------------------------------------------- |
| `version`     | `1`                                   | 是   | 配置 schema 版本，目前固定为 `1`                                           |
| `currentModel`| `string`                              | 否   | 启动时使用的模型；缺失或指向不存在的 name 时会自动 fallback 到 `models[0]` |
| `models[]`    | `ModelConfig[]`                       | 是   | 模型列表，可以为空（但空列表时无法对话）                                    |

每条 `ModelConfig`：

| 字段        | 类型                                          | 必填    | 说明                                                                              |
| ----------- | --------------------------------------------- | ------- | --------------------------------------------------------------------------------- |
| `name`      | `string`                                      | 是      | 你给模型起的别名；唯一、非空，是 `/model <name>` 切换时引用的标识                 |
| `provider`  | `"openai" \| "anthropic" \| "deepseek"`        | 是      | 通过 Vercel AI SDK 接入的 provider                                                |
| `model`     | `string`                                      | 是      | 传给 provider 的真实 model id（如 `gpt-4o-mini`）                                  |
| `baseURL`   | `string`                                      | 否      | 覆盖 provider 默认 endpoint（OpenAI 兼容服务用，例如 Ollama）                     |
| `apiKey`    | `string`                                      | 二选一  | 明文 API key（兜底）                                                              |
| `apiKeyEnv` | `string`                                      | 二选一  | 环境变量名；存在且非空时**优先于** `apiKey`                                        |

> `apiKey` 与 `apiKeyEnv` **至少要有一个**；同时存在时 env 取胜，env 没值则回落到 `apiKey`。

### 完整示例

```jsonc
{
  // schema 版本，留给后续 migration
  "version": 1,

  // 启动时默认选中的模型 name
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
      // OpenAI 兼容的本地服务也走 openai provider
      "name": "local-qwen",
      "provider": "openai",
      "model": "qwen2.5-coder",
      "baseURL": "http://localhost:11434/v1",
      "apiKey": "ollama"
    }
  ]
}
```

### TUI 内的命令

启动 TUI 后可在输入框使用 slash 命令（**区分大小写**）：

| 命令              | 作用                                                            |
| ----------------- | --------------------------------------------------------------- |
| `/models`         | 列出所有模型，标注 `current` 与 apiKey 来源（env / plain / missing） |
| `/model <name>`   | 切换当前模型；切换结果会写回 `~/.lordcode/config.json`                |
| `Esc`             | 流式生成中按下会立刻取消，已输出的 partial 文本会保留并标 `[interrupted]` |
| `Ctrl-C` / `Ctrl-D` | 退出 TUI                                                       |

### 常见错误与定位

| 现象                                     | 处理                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| TUI 顶部红字 `no models configured`      | `models` 数组为空，编辑配置文件补一条                                              |
| 启动时报 JSONC 解析错误                  | 修复语法（错误信息含 offset）                                                      |
| 启动时报 schema 校验错误                 | 错误信息含字段路径，如 `models.1.provider: ...`                                     |
| 发消息时 `missing apiKey for <name>`     | `apiKeyEnv` 指向的环境变量没设置 / 为空，且没有兜底 `apiKey`                       |
| `/model <name>` 报 `no such model: ...`  | name 拼写错误；错误信息会列出可用 names                                            |
| 想改配置后立即生效                       | 暂不支持 hot reload，**重启 TUI**                                                  |

## 开发

```bash
# 安装依赖
pnpm install

# 启动 TUI（会自动在 worker 线程里起 server）
pnpm dev

# 仅启动 server（独立进程，方便调试 / 给 web UI 用）
pnpm dev:server

# 类型检查 / 构建 / 测试
pnpm typecheck
pnpm build
pnpm test
```

## 包说明

### `@lordcode/shared`
所有跨包的纯类型与 API 契约都放这里，避免 TUI 与 server 互相依赖实现。

### `@lordcode/server`
Hono server，提供 agent 与其他 API。同一份代码支持两种启动方式：
- `src/worker.ts` —— 作为 worker_thread 被 TUI 拉起（生产模式）。
- `src/index.ts` —— 作为独立 Node 进程启动（开发 / 给 web UI 用）。

### `@lordcode/tui`
Ink TUI，项目主入口。启动时通过 `worker_threads` 拉起 server，等待 server 报告端口后再渲染界面。

### `@lordcode/web` *(预留)*
当前迭代不实现，目录与 `package.json` 占位。未来直接连接同一个 server。
