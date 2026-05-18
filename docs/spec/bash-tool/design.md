# Bash Tool — Design Spec

## Overview

为 agent 提供一个 bash 命令执行工具，允许模型在用户的工作目录中运行 shell 命令。遵循现有 tool 架构（Zod schema + execute + AI SDK `tool()` wrapper）。

## Directory Structure

```
packages/server/src/tools/bash/
├── schema.ts        # Zod input/output schemas + descriptions
├── execute.ts       # BashDeps + executeBash logic
├── tool.ts          # createBashTool — AI SDK wiring
├── runners/
│   └── local.ts     # LocalRunner: spawn("bash", ["-c", cmd])
└── bash.test.ts
```

## Input Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `command` | `string` | yes | — | 要执行的 bash 命令 |
| `cwd` | `string` | no | project root | 工作目录覆盖（相对于 project root 解析） |
| `timeout` | `number` | no | `30_000` | 最大执行时间（ms），超时发 SIGTERM |

## Output Schema

| Field | Type | Description |
|-------|------|-------------|
| `exitCode` | `number` | 进程退出码；0 = 成功 |
| `stdout` | `string` | 捕获的 stdout（可能被截断） |
| `stderr` | `string` | 捕获的 stderr（可能被截断） |
| `truncated` | `boolean` | 输出超过 cap 时为 true |
| `killed` | `boolean` | 进程被 kill（超时或 signal）时为 true |

## Runner Abstraction（沙箱预留）

核心设计决策：将 **执行策略** 抽象为 `BashRunner` 接口，`executeBash` 不直接耦合 `child_process.spawn`。

```typescript
export interface BashRunner {
  run(opts: {
    command: string;
    cwd: string;
    env: Record<string, string>;
    timeout: number;
    signal?: AbortSignal;
  }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    killed: boolean;
  }>;
}
```

### 现阶段

- 只实现 `LocalRunner`（直接 `spawn("bash", ["-c", cmd])`）
- `deps.runner ?? localRunner` — 一行切换

### 未来扩展路径

- `DockerRunner` — `docker run --rm --network=none`
- `FirecrackerRunner` — microVM 隔离
- `RemoteRunner` — cloud sandbox（E2B / Modal）

新增 runner 时，`executeBash` 和 test 不需要改动。

## Dependencies Interface

```typescript
export interface BashDeps {
  cwd: string;
  logger?: Logger;
  signal?: AbortSignal;
  runner?: BashRunner;          // 默认 localRunner
  commandFilter?: (cmd: string) => boolean;  // 安全过滤 seam
}
```

## Design Decisions

| 决策 | 选择 | 理由 |
|------|------|------|
| 沙箱 | 现在不做，通过 `BashRunner` 接口预留 | 本地开发场景无需隔离；避免引入 Docker 依赖和延迟 |
| 安全过滤 | 可选 `commandFilter`，默认不启用 | 开发环境自用场景；通过 deps 注入保留扩展性 |
| 输出截断 | 按字节 cap（100KB），保留尾部 | 模型更需要看到最后的错误信息 |
| Shell 模式 | `spawn("bash", ["-c", cmd])` | 支持 abort + timeout；stream 式收集 |
| 环境变量 | 继承 `process.env`，strip 敏感变量 | 方便使用，但过滤 `*_SECRET`、`*_TOKEN` 等 |
| 交互式 | 不支持 stdin | 只跑 non-interactive 命令 |
| 并发 | 不在 tool 层限制 | 由 agent loop 控制 |
| timeout 默认 | 30s | 覆盖大多数开发命令；长任务可显式传入更大值 |

## TUI Rendering

遵循现有 tool 展示模式（Ink + React），执行完成后一次性展示结果，不做实时流式输出。

### 生命周期展示

```
执行中（phase: "call"）:
  → bash(npm test)

成功（phase: "result", exitCode === 0）:
  → bash(npm test)
  ← exit 0 · 3 lines

失败（phase: "result", exitCode !== 0）:
  → bash(npm test)
  ← exit 1 · 12 lines

超时/killed:
  → bash(npm test)
  ← killed · exit 137 · 8 lines (timeout)

错误（phase: "error"）:
  → bash(npm test)
  × spawn ENOENT: bash
```

### `formatToolCall` — 调用行

显示命令本身，遵循 80 字符截断规则：

```typescript
// format-tool-call.ts
if (toolName === "bash") {
  const cmd = isRecord(input) && typeof input.command === "string"
    ? input.command : "";
  return clip(cmd);  // 复用现有 clip(80)
}
```

示例：
- `→ bash(npm run build)`
- `→ bash(find . -name "*.ts" | head -20)`
- `→ bash(docker compose up --build --detach --wait && curl http://localhos…)`

### `formatToolResult` — 结果行

一行摘要，包含退出码 + 输出行数 + 状态标记：

```typescript
function formatBashResult(output: unknown): string {
  if (!isRecord(output)) return safePreview(output);

  const exitCode = typeof output.exitCode === "number" ? output.exitCode : null;
  const killed = output.killed === true;
  const truncated = output.truncated === true;

  // 合并 stdout + stderr 计算行数
  const stdout = typeof output.stdout === "string" ? output.stdout : "";
  const stderr = typeof output.stderr === "string" ? output.stderr : "";
  const lines = (stdout + stderr).split("\n").filter(Boolean).length;

  const parts: string[] = [];
  if (killed) parts.push("killed");
  parts.push(`exit ${exitCode ?? "?"}`);
  parts.push(`${lines} line${lines === 1 ? "" : "s"}`);
  if (truncated) parts.push("(truncated)");
  if (killed && !truncated) parts.push("(timeout)");

  return parts.join(" · ");
}
```

### 颜色规则

| 状态 | 前缀 | 颜色 |
|------|------|------|
| 执行中 | `→` | dim cyan（与其他工具一致） |
| exitCode === 0 | `←` | cyan |
| exitCode !== 0 | `←` | yellow（区别于 tool error 的 red） |
| killed/timeout | `←` | yellow |
| tool error（ENOENT 等） | `×` | red |

> **Note:** 非零退出码用 yellow 而非 red，因为这是命令本身的失败（模型可重试），
> 不同于 tool infrastructure error（红色 `×`）。

### 不展示完整输出的理由

- 保持 TUI 紧凑，避免 `npm install` 之类的命令刷屏
- 完整输出已经发给模型（通过 `output.stdout/stderr`），模型可以基于内容做决策
- 用户需要看原始输出时，可查看 log 文件（logger 会记录完整 payload）

## Registration

```typescript
// registry.ts
bash: createBashTool({
  cwd: deps.cwd,
  ...(deps.logger ? { logger: deps.logger.child("bash") } : {}),
}),
```

## Test Strategy

- Mock `BashRunner` 注入 — 不依赖真实 shell 即可测试 `executeBash` 逻辑
- 集成测试用 `localRunner` 跑简单命令（`echo`, `exit 1`）
- 验证 timeout / abort / truncation 行为
- `registry.test.ts` 更新：断言 `bash` key 存在 + logger child name
