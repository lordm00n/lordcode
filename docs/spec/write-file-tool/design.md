# Write File Tool — Design Spec

## Overview

为 agent 提供一个文件写入工具，允许模型在用户的工作目录中创建或覆写文件。遵循现有 tool 架构（Zod schema + execute + AI SDK `tool()` wrapper）。

核心特性：

- **整文件覆写**语义——content 是完整文件内容，不做 diff/patch。
- **先读后写约束**——对已存在文件，必须在同一 session 内先 `read_file` 过，且文件此后未被外部修改。通过共享的 `FileReadTracker` 实现。
- **原子写入**——tmp + rename，避免进程中断留下半截文件。
- **自动建父目录**——默认 `mkdir -p`，省去模型额外一步 bash。

本设计与未来的 `edit_file`（局部替换）互补：`write_file` 负责新建 / 整体重写，`edit_file` 负责 old_string → new_string 局部编辑。

---

## Directory Structure

```
packages/server/src/tools/
├── file-read-tracker.ts       # NEW — 共享状态，read_file 和 write_file 都用
├── write-file/
│   ├── schema.ts              # Zod input/output schemas + descriptions
│   ├── execute.ts             # WriteFileDeps + executeWriteFile logic
│   ├── tool.ts                # createWriteFileTool — AI SDK wiring
│   └── write-file.test.ts
├── read-file/
│   └── execute.ts             # MODIFY — 成功读取后 tracker.record(...)
└── registry.ts                # MODIFY — 共享 tracker 实例，注册 write_file
```

---

## Input Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes | — | 目标文件路径，相对路径基于 project root 解析 |
| `content` | `string` | yes | — | 文件完整内容（UTF-8 文本，整文件覆写） |
| `mode` | `"overwrite" \| "create"` | no | `"overwrite"` | `"create"` 在文件已存在时报 `EEXIST` |
| `createDirs` | `boolean` | no | `true` | 自动 `mkdir -p` 父目录 |

**刻意不放进 schema 的字段（避免给模型 footgun）：**

- `encoding` —— 始终 UTF-8
- POSIX 权限位 —— 沿用 umask 默认
- `append` —— 追加应通过 `edit_file` 或 `bash >>` 完成
- 二进制写入 —— 写图片等应通过 `bash` 显式做

---

## Output Schema

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | 写入的绝对路径 |
| `bytesWritten` | `number` | 实际写入字节数 |
| `created` | `boolean` | 是否新建文件（false = 覆写已存在文件） |
| `previousBytes` | `number \| null` | 覆写时旧文件大小，新建时 null |

`created` + `previousBytes` 让模型一眼看出"这次操作是创建还是覆盖了一个 X 字节的文件"——对后续推理（要不要 diff 检查）有用。

---

## FileReadTracker — 共享状态模块

### 职责

防止模型"基于过时记忆覆写"。具体拦截三类 bug：

| 场景 | 表现 | 机制 |
|------|------|------|
| A. 从没读过就写 | model 凭记忆/印象 write 已存在文件 | tracker 中无记录 → `READ_REQUIRED` |
| B. 陈旧记忆覆写 | read → bash 改了文件 → write 用旧内容 | stat mtime ≠ tracker mtime → `STALE_READ` |
| C. 用户在 IDE 手改 | read → 用户保存 → write 用旧内容 | 同上，mtime 变化自动检测 |

### 接口

```typescript
// packages/server/src/tools/file-read-tracker.ts

export interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

export interface FileReadTracker {
  /** 记录一次成功的文件读取。 */
  record(absPath: string, snapshot: FileSnapshot): void;
  /** 查询上次记录的快照。 */
  get(absPath: string): FileSnapshot | undefined;
  /** 清除记录（文件被删除时调用）。 */
  forget(absPath: string): void;
}

export function createInMemoryFileReadTracker(): FileReadTracker {
  const map = new Map<string, FileSnapshot>();
  return {
    record: (p, s) => { map.set(p, s); },
    get: (p) => map.get(p),
    forget: (p) => { map.delete(p); },
  };
}
```

### 生命周期

- **per-session**：agent 进程启动时一次创建，跨 turn 共享。
- **不持久化**：重启后文件状态本来就可能变化，旧快照没意义。

### 为什么用 mtime + size

| 特性 | 说明 |
|------|------|
| 零额外 I/O | 只需 `fs.stat`，不需要 `readFile + hash` |
| 覆盖所有外部修改来源 | bash / IDE / git / 其它进程 → 内核自动更新 mtime |
| 误报方向安全 | `touch` 只改 mtime 不改内容 → 触发重读 → 无害 |
| 精度足够 | APFS / ext4 / NTFS 均 ns/µs 级 |
| size 是双保险 | 防 FAT32 等 2 秒粒度文件系统同秒双写漏检 |

---

## Dependencies Interface

```typescript
export interface WriteFileDeps {
  /** Working directory used to resolve relative `input.path`. */
  cwd: string;
  /** Channel-rooted logger. Convention: `…child("tool").child("write_file")`. */
  logger?: Logger;
  /** Cancels the write; on abort the tmp file is cleaned up. */
  signal?: AbortSignal;
  /** Test seam: inject a fake `fs/promises`. */
  fs?: Pick<typeof defaultFs, "stat" | "writeFile" | "rename" | "mkdir" | "unlink">;
  /** Shared tracker for read-before-write enforcement. */
  fileReadTracker?: FileReadTracker;
  /** Optional filter — return false to reject a path. */
  pathFilter?: (absPath: string) => boolean;
}
```

---

## Execute Flow

```typescript
async function executeWriteFile(input: WriteFileInput, deps: WriteFileDeps): Promise<WriteFileOutput> {
  // 1. Size cap check
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > MAX_CONTENT_BYTES) throw WriteFileError("TOO_LARGE");

  // 2. Resolve path
  const resolvedPath = resolve(deps.cwd, input.path);

  // 3. Path filter
  if (deps.pathFilter && !deps.pathFilter(resolvedPath)) throw WriteFileError("REJECTED");

  // 4. Stat existing file
  let existing: Stats | null = null;
  try {
    existing = await fs.stat(resolvedPath);
  } catch (err) {
    if (code(err) !== "ENOENT") throw mapStatError(err);
  }

  // 5. Mode check
  if (existing && existing.isDirectory()) throw WriteFileError("EISDIR");
  if (existing && input.mode === "create") throw WriteFileError("EEXIST");

  // 6. Read-before-write check (only for existing files)
  if (existing && deps.fileReadTracker) {
    const recorded = deps.fileReadTracker.get(resolvedPath);

    if (!recorded) {
      throw WriteFileError(
        "file exists but has not been read in this session",
        { code: "READ_REQUIRED" },
      );
    }

    if (recorded.mtimeMs !== existing.mtimeMs || recorded.size !== Number(existing.size)) {
      throw WriteFileError(
        "file modified since last read — re-read before writing",
        { code: "STALE_READ" },
      );
    }
  }

  // 7. Create parent dirs
  if (input.createDirs !== false) {
    await fs.mkdir(dirname(resolvedPath), { recursive: true });
  }

  // 8. Atomic write: tmp + rename
  const tmpPath = `${resolvedPath}.tmp.${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmpPath, input.content, { encoding: "utf8", signal: deps.signal });
    await fs.rename(tmpPath, resolvedPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw mapWriteError(err);
  }

  // 9. Update tracker with new snapshot
  const after = await fs.stat(resolvedPath);
  deps.fileReadTracker?.record(resolvedPath, {
    mtimeMs: after.mtimeMs,
    size: Number(after.size),
  });

  // 10. Return result
  return {
    path: resolvedPath,
    bytesWritten: bytes,
    created: existing === null,
    previousBytes: existing ? Number(existing.size) : null,
  };
}
```

### Atomic Write 说明

- 写入同目录的 `<filename>.tmp.<random-hex>` 临时文件
- `fs.rename` 在同一文件系统上是原子操作
- 进程被 kill → 只留下孤立 tmp 文件，原文件完好
- 写入失败 → best-effort 清理 tmp

### Read-before-write 时间线示例

```
T=1000  read_file("package.json")
        → fs.stat → { mtimeMs: 1000, size: 450 }
        → tracker.record("/abs/package.json", { mtimeMs: 1000, size: 450 })

T=2000  bash("npm install zod")
        → npm 改写 package.json → 实际 mtimeMs: 2000, size: 470
        → tracker 不知道，存的还是 { 1000, 450 }

T=3000  write_file("package.json", "...")
        → fs.stat 当前文件 → { mtimeMs: 2000, size: 470 }
        → tracker.get → { mtimeMs: 1000, size: 450 }
        → 2000 ≠ 1000 → STALE_READ ← 拦截成功

T=3001  model re-read → 看到最新内容（含 zod）
T=3002  model write_file → stat == tracker → 写入成功
```

---

## Modifications to `read_file`

`read-file/execute.ts` 增加一行（在两个分支返回前）：

```typescript
deps.fileReadTracker?.record(resolvedPath, {
  mtimeMs: stats.mtimeMs,
  size: byteSize,
});
```

`ReadFileDeps` 新增可选字段：

```typescript
export interface ReadFileDeps {
  // ... existing fields ...
  fileReadTracker?: FileReadTracker;
}
```

不破坏现有 API，纯增量。部分读（`truncated: true`）也算"读过"——v1 取宽松，避免逼模型先翻完大文件。

---

## Registry Integration

```typescript
// registry.ts
import { createInMemoryFileReadTracker } from "./file-read-tracker.js";

export interface ToolDeps {
  logger?: Logger;
  cwd: string;
  fileReadTracker?: FileReadTracker;  // 可选，外部注入或内部默认创建
}

export function buildTools(deps: ToolDeps) {
  const tracker = deps.fileReadTracker ?? createInMemoryFileReadTracker();
  return {
    ripgrep: createRipgrepTool({ ... }),
    glob: createGlobTool({ ... }),
    read_file: createReadFileTool({
      cwd: deps.cwd,
      fileReadTracker: tracker,
      ...(deps.logger ? { logger: deps.logger.child("read_file") } : {}),
    }),
    write_file: createWriteFileTool({
      cwd: deps.cwd,
      fileReadTracker: tracker,
      ...(deps.logger ? { logger: deps.logger.child("write_file") } : {}),
    }),
    bash: createBashTool({ ... }),
  };
}
```

---

## Error Taxonomy

```typescript
export type WriteFileErrorCode =
  | "EEXIST"         // mode: "create" 且文件已存在
  | "EISDIR"         // 目标路径是目录
  | "EACCES"         // 权限拒绝
  | "ENOENT"         // 父目录不存在且 createDirs: false
  | "TOO_LARGE"      // content 超过 1 MB
  | "REJECTED"       // pathFilter 否决
  | "READ_REQUIRED"  // 文件存在但 session 内没读过
  | "STALE_READ"     // 读过但之后被修改
  | "WRITE_FAILED";  // 兜底

export class WriteFileError extends Error {
  public override readonly cause: {
    code: WriteFileErrorCode;
    byteSize?: number;
    underlying?: unknown;
  };
  constructor(message: string, cause: { code: WriteFileErrorCode; ... });
}
```

`READ_REQUIRED` 和 `STALE_READ` 是**可恢复**错误——错误消息明确告诉模型"call read_file then retry"。

---

## Design Decisions

| 决策 | 选择 | 理由 |
|------|------|------|
| 写入语义 | 整文件覆写（whole-file replace） | 局部编辑是独立 `edit_file` 的职责。混在一起让 schema 复杂、模型选择错误 |
| 原子性 | tmp + `rename` | 避免进程被 kill 留下半截文件。rename 同文件系统原子 |
| 父目录创建 | `createDirs: true`（默认） | 省一次 `bash mkdir -p`；模型写 `src/foo/bar.ts` 无需预建目录 |
| 大小上限 | 1 MB | 模型一次产出超过 1 MB 几乎一定异常（重复内容等）。早 fail 早暴露 |
| 先读后写 | FileReadTracker: mtime + size 比对 | 防 stale-memory overwrite；零额外 I/O（只需 stat）；自动覆盖所有外部修改来源 |
| 新建文件是否要求先 read | 不要求 | ENOENT 没东西可读；强制要求等于不让 create |
| 写后刷新 tracker | 是 | 让模型连续写同一文件不必夹一次 read |
| 部分读是否算"读过" | 算（v1 宽松） | 严格要求 `truncated: false` 会逼模型先翻完大文件 |
| 路径安全 | 可选 `pathFilter` deps seam，默认不启用 | 和 bash 的 `commandFilter` 对齐；开发环境自用 |
| `mode: "create"` | 提供 | 让"我以为是新建结果覆盖了用户文件"不可能发生 |
| Newline 处理 | 原样写入，不 normalize | 保留模型的字节级意图。CRLF / LF / 末尾换行都是它的责任 |
| BOM | 不加、不剥 | 同上 |
| 符号链接 | 跟随（`fs.writeFile` 默认行为） | 不"贴心"拦截，否则模型行为不可预测 |
| 编码 | UTF-8 only | 与 `read_file` 对称 |
| TOCTOU 窗口 | 接受 | stat → write 之间几 ms，best-effort guard 不是安全机制 |
| 方案 c（模型传 expectedMtime）vs 方案 d（server tracker） | Server tracker（方案 d） | 模型 0 心智成本；不会忘传参数；schema 更干净 |

---

## Tool Description

```text
Write content to a file. Creates new files or overwrites existing ones (whole-file replace).

For existing files: you MUST read_file first in this session. The tool verifies the file has not been modified since your last read — if it has, you'll get a STALE_READ error and must re-read before retrying.

For new files: no prior read is required. Parent directories are created automatically by default.

Content is the complete file — this is NOT a patch/diff tool. For small edits to existing files, prefer edit_file (old_string → new_string) when available.

Content is capped at 1 MB. Encoding is always UTF-8.
```

---

## TUI Rendering

### `formatToolCall`

Key ordering: `["path", "mode", "createDirs"]`

Default suppression:
- `mode === "overwrite"` → 不显示
- `createDirs === true` → 不显示

Examples:
```
→ write_file(path: "src/foo.ts")
→ write_file(path: "src/foo.ts", mode: "create")
→ write_file(path: "src/foo.ts", createDirs: false)
```

### `formatToolResult`

```typescript
function formatWriteFileResult(output: unknown): string {
  if (!isRecord(output)) return safePreview(output);

  const created = output.created === true;
  const bytes = typeof output.bytesWritten === "number"
    ? humanBytes(output.bytesWritten) : "?";
  const prev = typeof output.previousBytes === "number"
    ? ` (was ${humanBytes(output.previousBytes)})` : "";

  return created
    ? `created · ${bytes}`
    : `overwrote · ${bytes}${prev}`;
}
```

Examples:
```
← created · 1.2 KB
← overwrote · 4.3 KB (was 2.1 KB)
← overwrote · 800 B
```

### 颜色规则

| 状态 | 前缀 | 颜色 |
|------|------|------|
| 成功 | `←` | cyan |
| tool error | `×` | red |

写入只有"成功"或"失败"，没有 bash 那种中间态。

---

## Tracker 的局限性（明确声明）

| 情况 | 是否拦截 | 说明 |
|------|----------|------|
| 从没读过就写已存在文件 | ✓ | `READ_REQUIRED` |
| 读后被 bash/IDE/git 修改 | ✓ | mtime 变化 → `STALE_READ` |
| 用户在 IDE 手改后保存 | ✓ | 同上 |
| 部分读后整文件覆写导致丢数据 | ✗ | 模型只读前 N 行但写"完整文件"→ 尾部丢失。靠 tool description 警告 |
| 同毫秒覆写（APFS 上极难发生） | ✗ | 理论盲区，忽略 |
| mtime 被人为回拨 | ✗ | 恶意场景，不在防护范围 |
| stat → write 之间的 TOCTOU | ✗ | 窗口极小，忽略 |

**升级路径**：v2 可将快照从 `(mtimeMs, size)` 升级为 `contentHash (SHA-256)`，代价是每次 write 前多一次 readFile + hash。v1 mtime+size 覆盖 99.9% 场景。

---

## Test Strategy

### UT-1 Schema

- Given 最小输入 `{ path: "x.ts", content: "hello" }`，When 解析，Then `mode` / `createDirs` 缺省。
- Given `path: ""`，Then schema 拒绝。
- Given `content: ""`，Then schema 接受（允许写空文件）。
- Given `mode: "invalid"`，Then schema 拒绝。

### UT-2 `executeWriteFile` — happy path

- Given 新文件路径 + tracker 无记录，When write，Then `created: true`、`previousBytes: null`、文件内容正确。
- Given 已存在文件 + tracker 有匹配记录，When write，Then `created: false`、`previousBytes` 等于旧 size、新内容正确。
- Given 写入成功后，Then tracker 自动 record 新 snapshot（连续两次 write 不报错）。

### UT-3 `executeWriteFile` — read-before-write enforcement

- Given 已存在文件 + tracker 无记录，Then 抛 `READ_REQUIRED`。
- Given 已存在文件 + tracker mtime 不匹配，Then 抛 `STALE_READ`。
- Given 已存在文件 + tracker size 不匹配（mtime 相同），Then 抛 `STALE_READ`。
- Given tracker 未注入（`fileReadTracker` 为 undefined），Then 降级为不检查（兼容测试场景）。
- Given 新建文件（ENOENT），Then 跳过 read 检查，不报错。

### UT-4 `executeWriteFile` — mode: "create"

- Given `mode: "create"` + 文件不存在，Then 正常创建。
- Given `mode: "create"` + 文件已存在，Then 抛 `EEXIST`（不论 tracker 状态）。

### UT-5 `executeWriteFile` — atomic write

- Given 写入失败（fs.writeFile reject），Then 清理 tmp 文件、原文件不受影响。
- Given abort signal 在写入中触发，Then 清理 tmp、reject AbortError。

### UT-6 `executeWriteFile` — dirs & limits

- Given 父目录不存在 + `createDirs: true`（默认），Then 自动创建父目录链。
- Given 父目录不存在 + `createDirs: false`，Then 抛 `ENOENT`。
- Given content 超过 1 MB，Then 抛 `TOO_LARGE`（不写盘）。
- Given 目标路径是目录，Then 抛 `EISDIR`。

### UT-7 `executeWriteFile` — pathFilter

- Given `pathFilter` 返回 false，Then 抛 `REJECTED`。
- Given `pathFilter` 返回 true，Then 正常写入。

### UT-8 FileReadTracker

- Given record + get 同路径，Then 返回记录的 snapshot。
- Given get 未记录的路径，Then 返回 undefined。
- Given forget 后 get，Then 返回 undefined。
- Given 不同绝对路径，Then 互不干扰。

### UT-9 read_file integration

- Given `read_file` 成功返回（text 或 image），Then 调用 `tracker.record` 一次（注入 spy tracker 验证）。

### UT-10 Registry

- Given `buildTools({ cwd })`，Then keys 集合包含 `write_file`。
- Given 传入 `logger`，Then `write_file` 的 logger child channel 为 `write_file`。
- Given 不传 `fileReadTracker`，Then 内部默认创建一个，read_file 和 write_file 共享同一实例。

### UT-11 TUI 格式化

- Given `write_file` call with `{ path: "a.ts", content: "...", mode: "overwrite", createDirs: true }`，Then 显示 `write_file(path: "a.ts")`（默认值省略）。
- Given `{ path, content, mode: "create" }`，Then 显示 `write_file(path: "a.ts", mode: "create")`。
- Given result `{ created: true, bytesWritten: 1234 }`，Then `created · 1.2 KB`。
- Given result `{ created: false, bytesWritten: 4400, previousBytes: 2100 }`，Then `overwrote · 4.3 KB (was 2.1 KB)`。

---

## Constants

```typescript
/** Max content size in bytes. Rejects before writing to disk. */
export const MAX_CONTENT_BYTES = 1 * 1024 * 1024; // 1 MB
```

---

## Non-functional Requirements

### Performance

- Size cap 1 MB：单次写入开销极小。
- Stat 代替 hash：0 额外读盘。
- Atomic rename：单系统调用，几 µs。

### Security

- 写文件操作；风险高于 read — 通过 `pathFilter` seam 预留安全扩展。
- 不执行 shell；不做路径沙箱（与现有 tool 一致）。
- `READ_REQUIRED` / `STALE_READ` 是 best-effort guard，不是安全机制。

### Reliability

- Atomic write 保证断电/kill 不留半截文件。
- abort 时清理 tmp 文件，不留垃圾。
- `createDirs: true` 默认避免 ENOENT 的常见挫折。

### Observability

- 日志通道：`server:agent:stream:tool:write_file`。
- 记录 `path`、`bytesWritten`、`created`、`previousBytes`、`elapsedMs`。
- `STALE_READ` / `READ_REQUIRED` 记为 warn 级别（模型可恢复，但值得关注）。

---

## Acceptance Criteria

- [ ] `pnpm --filter @lordcode/server typecheck && pnpm --filter @lordcode/server test` 全绿。
- [ ] `pnpm --filter @lordcode/tui typecheck && pnpm --filter @lordcode/tui test` 全绿。
- [ ] 实跑：先 `read_file("package.json")`，再 `write_file("package.json", ...)`，成功覆写。
- [ ] 实跑：直接 `write_file("package.json", ...)` 不先 read，看到 `× write_file failed: READ_REQUIRED ...`。
- [ ] 实跑：read → bash 改文件 → write，看到 `× write_file failed: STALE_READ ...`。
- [ ] 实跑：`write_file("new-dir/new-file.ts", ...)`，父目录自动创建，成功写入。
- [ ] 实跑：`write_file("existing.ts", ..., mode: "create")`，看到 `× write_file failed: EEXIST ...`。
- [ ] 实跑：写超过 1 MB 内容，看到 `× write_file failed: TOO_LARGE ...`。
- [ ] TUI 显示 `→ write_file(path: "...")` 和 `← created · X KB` / `← overwrote · X KB (was Y KB)`。
- [ ] logger 通道有完整调用日志。

---

## Not in This Iteration

- `edit_file` 局部编辑工具（old_string → new_string）。
- 二进制文件写入。
- `pathFilter` 默认实现（如禁写 `.git/`）。
- 跨 session tracker 持久化。
- `truncated` 严格模式（拒绝部分读后的整文件覆写）。
- Content hash 替代 mtime（升级路径预留）。
- 写入前自动 backup。
- 批量写入（多文件原子性）。

---

## Open Questions

- 行号 padding / 格式等 → 不适用（write 无行号）。
- 是否需要"dry-run"模式（只检查不写入）？暂不做，等有需求再加。
- 未来 `edit_file` 是否也应走 tracker？是的，共用同一 `FileReadTracker`。
- 连续 write 同一文件是否应要求中间 re-read？不要求——写后自动刷新 tracker 已足够。
