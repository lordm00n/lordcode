# @lordcode/web

未来的 Web UI 占位包，当前迭代不实现。

## 设计意图

- 直接消费 `@lordcode/shared` 中定义的 HTTP 契约。
- 直接连接 `@lordcode/server`（与 TUI 同一份 server，不区分前后端）。
- 接入时只需要一个 server 的 baseUrl，可以是 worker 模式（TUI 同进程内）也可以是独立进程模式（`pnpm dev:server`）。

## 接入步骤建议

1. 在本目录用 Vite + React 起个空项目。
2. 把 `@lordcode/shared` 加到 dependencies，复用 `API_ROUTES` 与 `AgentChat*` 类型。
3. 把 `packages/tui/src/api/client.ts` 抽到 `@lordcode/shared` 或 `@lordcode/api-client`，TUI / web 共用。
