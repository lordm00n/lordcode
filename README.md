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

## 开发

```bash
# 安装依赖
pnpm install

# 启动 TUI（会自动在 worker 线程里起 server）
pnpm dev

# 仅启动 server（独立进程，方便调试 / 给 web UI 用）
pnpm dev:server

# 类型检查 / 构建
pnpm typecheck
pnpm build
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
