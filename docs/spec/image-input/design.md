<!-- markdownlint-disable MD060 -->

# Image Input — Spec

本文档描述 lordcode 中**图片粘贴 → base64 编码 → 多模态对话发送**功能的总体设计，作为后续实现的依据。

---

## 1. 概述

本迭代为 lordcode 的 TUI 引入图片输入能力，包含三件事：

1. **粘贴识别**：用户在 TUI 中粘贴图片时，自动判别来源（data URL / 文件路径 / 系统剪贴板二进制）并解出 base64。
2. **out-of-band 暂存**：识别到的图片以占位符 `[image:<mime>#<id>]` 形式留在输入框，真正的 base64 通过 `useRef<Map>` 暂存，避免每次按键触发整树重渲染。
3. **多模态发送**：发送时把输入串展开为 `string | ContentPart[]`，通过既有 `POST /agent/chat` 直接交给 server，server 端把 `messages` 透传给 Vercel AI SDK 的 `streamText` —— shared 层的 wire shape 与 AI SDK 的 `UserContent` 完全同构，全链路零适配层。

终端 bracketed paste 只能传输文本，所以"识别"必须覆盖三种语义形态，其中"系统剪贴板"是唯一可恢复 Chrome / 截图工具内容的兜底通道。

---

## 2. 目标 & 范围

### In Scope

- TUI 中识别三种粘贴形态并解码：
  - **A. data URL / 裸 base64**：`data:image/<sub>;base64,<...>`
  - **B. 文件路径**：`/abs/path.png`、`~/path.png`、`file://...`、单/双引号包裹、shell 转义空格、Windows `C:\...`、UNC `\\server\...`
  - **C. 系统剪贴板二进制**：粘贴文本为空时主动从 OS 剪贴板取 PNG（macOS / Linux / Windows）
- IANA `mediaType` 推断：`image/png`、`image/jpeg`、`image/gif`、`image/webp`、`image/bmp`
- TUI 占位符语法 `[image:<mime>#<id>]` 与 `pendingImagesRef: Map<id, PastedImage>` 协议
- `composeContent(text, pendingImages)` —— 把输入串展开为 `string | ContentPart[]`
- `consumedImageIds(text, pendingImages)` —— 发送后清理用过的图片
- `renderContent(content)` —— TUI 显示侧把 `ContentPart[]` 折叠回字符串（image 部分以 `[image:<mime>]` 字面量呈现）
- 扩展 `@lordcode/shared` 的 `ChatMessage` 形状到多模态（`TextPart | ImagePart`），保持线上格式与 Vercel AI SDK 同构
- 关键纯函数（`composeContent` / `consumedImageIds` / `renderContent`）单测覆盖

### Out of Scope（明确不做）

- 拖拽（drag & drop）附件 — 终端的拖拽行为本身就降级为路径粘贴，已被 B 路径覆盖；非终端拖拽（如未来 Web UI）不在本迭代
- 输入框中把占位符渲染为缩略图 / 色块 / icon —— 一期保持 `[image:<mime>#<id>]` 字面量
- 客户端 / 服务端图片大小上限或压缩
- EXIF 元信息处理、图片裁剪 / 缩放
- 服务端对 `ImagePart` 内容做二次校验（信任 client；非法 base64 由 AI SDK / provider 拒绝）
- 把 base64 写进日志（避免 TB 级噪音）
- 视频 / 音频 / 任意 binary 文件附件
- assistant 端发送图片（assistant content 仍只是 string）
- WSL ↔ Windows 剪贴板互操作（一期 Linux 路径只走原生 `wl-paste` / `xclip`）
- Web UI 接入（设计已留口，本迭代不实现）

---

## 3. 关键设计决策

| #   | 决策                                | 选择                                                                | 理由                                                                                                                  |
| --- | ----------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | 终端 paste 限制如何绕过             | `usePaste` 三层识别（A → B → C）                                    | bracketed paste 只传文本；data URL / 路径 / 空 paste 各自覆盖一种用户场景，缺任何一层都丢用户                         |
| 2   | 系统剪贴板访问方式                  | 平台命令 shell-out：`osascript` / `wl-paste` / `xclip` / `powershell` | 零原生依赖；和 OpenAI Codex 同款；命令缺失时静默跳过，不阻塞普通粘贴                                                  |
| 3   | macOS / Windows 二进制 IO           | 命令把 PNG 写到 tmp 文件，Node 再读                                 | `osascript` / `powershell.exe` 把二进制写 stdout 受换行 / 编码改坏；落 tmp 是行业惯例                                 |
| 4   | 系统剪贴板 fallback 触发条件        | **仅当 `pasted.trim() === ""`**                                     | 普通文本粘贴不应付 ~50–200ms 的 shell-out 成本；空 paste 是 Chrome / 截图工具的可靠信号                               |
| 5   | base64 是否进 React state           | **不进**；存 `useRef<Map<id, PastedImage>>`                         | 5MB 图 → ~6.7MB base64；进 state 后每次按键 setInput 触发全量重渲染，TUI 会肉眼可见地卡顿                              |
| 6   | 输入框中的图片表示                  | 占位符 `[image:<mime>#<id>]`                                        | 短、可读、不和图片本身耦合；用户能看到位置；删占位符即"取消附件"                                                      |
| 7   | 占位符 id 字符集                    | 仅 `[a-zA-Z0-9-]`；mime 仅 `[a-zA-Z0-9./+-]`                        | 收紧字符集让正则 `\[image:([a-zA-Z0-9./+-]+)#([a-zA-Z0-9-]+)\]` 不会误匹配普通文本                                    |
| 8   | 占位符 id 来源                      | `Date.now().toString(36) + '-' + random4`                           | 不依赖外部库；同一会话内不重复，不需要全局唯一                                                                         |
| 9   | 占位符未命中时的行为                | **保留原文**                                                        | 用户手敲 `[image:image/png#xyz]` 应作为普通文本发出；不能因为格式碰巧匹配就静默丢失                                   |
| 10  | `ChatMessage.content` 形状          | `string \| ContentPart[]`                                           | 与 AI SDK `UserContent` 完全同构；server 端 `streamText({ messages })` 零适配                                         |
| 11  | `ImagePart` 字段命名                | `{ type: "image"; image: <base64>; mediaType: <mime> }`             | 完全照抄 AI SDK `ImagePart`；任何重命名都会引入纯样板的转换层                                                          |
| 12  | `image` 字段是否含 `data:` 前缀     | **不含**，纯 base64                                                 | AI SDK `DataContent` 接受裸 base64；含前缀反而需要在每个 provider 适配里去掉                                          |
| 13  | 单字符 / 全文本时的 wire 形状       | 退化为 `string`                                                     | 既保留旧的 text-only 紧凑格式（向后兼容），也避免 `[{type:"text",text:"..."}]` 单元素数组                              |
| 14  | server 端是否加 schema 校验         | 不加（与现状一致）                                                  | 现 `routes/agent.ts` 只校验 `messages` 是数组；非法 part 由 AI SDK 抛出，错误透传到 SSE `error` 帧                    |
| 15  | 发送后图片清理策略                  | 仅删除本次输入实际消费的 id                                         | 用户在输入框删了占位符再发送 → 那张图保留在 ref，可被再次插入                                                          |
| 16  | assistant 是否可携带图片            | 类型上允许，运行时永远是 string                                     | `streamAgent` 累计的是 `acc: string`；类型对称只为简化 `EntryView` 的渲染分支                                          |
| 17  | 输入文件不存在 / 不可读             | 当作普通文本，不报错                                                | 路径检测是启发式，宁可"漏识别"也不"误识别"；用户复制了一段含路径的文本不该被吃成附件                                  |
| 18  | 多行 paste 是否当路径               | 否                                                                  | "图 + 附言"或"两条路径"都是合法用户意图；对单行的限制让 normalize 简单可控                                            |
| 19  | 大小限制                            | 一期不限                                                            | MVP；如果后续遇到 provider 拒绝或 OOM，再在 `clipboard-image.ts` 加 `maxBytes` 选项                                   |
| 20  | 日志中是否含 base64                 | 否；只记 `{mime, source, bytes}`                                    | base64 体积巨大且对调试无意义；保留来源（哪一层识别成功）和大概体积                                                    |

---

## 4. 架构总览

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Node.js Process                                 │
│                                                                              │
│  ┌─────────────────────────────────────────┐    ┌────────────────────────┐  │
│  │              Main Thread (Ink TUI)       │    │     Worker Thread      │  │
│  │                                          │    │     (Hono Server)      │  │
│  │  ┌────────────────────────────────────┐  │    │                        │  │
│  │  │ usePaste(text)                     │  │    │  POST /agent/chat      │  │
│  │  │   ↓                                │  │    │     ↓                  │  │
│  │  │ tryParsePastedImage(text, opts)    │  │    │  streamAgent(messages) │  │
│  │  │   ├─ A. parseDataUrl               │  │    │     ↓                  │  │
│  │  │   ├─ B. parseImagePath             │  │    │  streamText({          │  │
│  │  │   │    └─ normalizePastedPath      │  │    │     model, messages,   │  │
│  │  │   │       (file:// / 引号 / shell  │  │    │     abortSignal })     │  │
│  │  │   │        转义 / Win / UNC)        │  │    │     ↓                  │  │
│  │  │   └─ C. readClipboardImageBytes    │  │    │  Vercel AI SDK         │  │
│  │  │        ├─ darwin: osascript        │  │    │  (UserContent 同构)     │  │
│  │  │        ├─ linux : wl-paste/xclip   │  │    │     ↓                  │  │
│  │  │        └─ win32 : powershell       │  │    │  Provider HTTP         │  │
│  │  └──────────────┬─────────────────────┘  │    │  · openai / responses  │  │
│  │                 │                         │    │  · openai-compatible   │  │
│  │     PastedImage{base64,mimeType,...}      │    │  · anthropic           │  │
│  │                 │                         │    │  · deepseek            │  │
│  │                 ▼                         │    └──────────┬─────────────┘  │
│  │  ┌────────────────────────────────────┐  │               │                │
│  │  │ pendingImagesRef:                  │  │               │                │
│  │  │   Map<id, PastedImage>              │  │               │                │
│  │  └──────────────┬─────────────────────┘  │               │                │
│  │                 │                         │               │                │
│  │  setInput(v + `[image:<mime>#<id>]`)      │               │                │
│  │                 │                         │               │                │
│  │                 ▼                         │               │                │
│  │  ┌────────────────────────────────────┐  │               │                │
│  │  │ <Input value="text [image:.#.]"/>  │  │               │                │
│  │  └──────────────┬─────────────────────┘  │               │                │
│  │                 │  Enter                  │               │                │
│  │                 ▼                         │               │                │
│  │  ┌────────────────────────────────────┐  │               │                │
│  │  │ handleSend(text)                   │  │               │                │
│  │  │   composeContent(text, ref)        │  │               │                │
│  │  │   → string | ContentPart[]         │  │               │                │
│  │  │   consumedImageIds → ref.delete    │  │               │                │
│  │  └──────────────┬─────────────────────┘  │               │                │
│  │                 │ JSON.stringify          │               │                │
│  │                 ▼                         │               │                │
│  │           POST /agent/chat ───────────────┤               │                │
│  │                                           │               │                │
│  │  ◄──────────── SSE ◄───────────────────────┴────────── (start/delta/...)  │
│  │  EntryView: renderContent(entry.content)                                  │
│  └─────────────────────────────────────────────────────────────────────────  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. 关键数据结构

### 5.1 `@lordcode/shared` 扩展

落在 `packages/shared/src/api.ts`，与既有 `ChatMessage` 同位置：

```typescript
export type ChatRole = "user" | "assistant" | "system";

export interface TextPart {
  type: "text";
  text: string;
}

/**
 * Inline image content. `image` is a raw base64 string (no `data:` prefix)
 * and `mediaType` is the IANA type. Wire shape mirrors Vercel AI SDK's
 * `ImagePart` so the server can hand `messages` directly to `streamText`
 * without translation.
 */
export interface ImagePart {
  type: "image";
  /** Raw base64-encoded image data, no `data:` prefix. */
  image: string;
  /** IANA media type — `image/png`, `image/jpeg`, etc. */
  mediaType: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: ChatRole;
  /**
   * Either a plain string (legacy text-only turns) or an ordered list of
   * parts for multimodal turns. Single-modality user turns SHOULD remain a
   * string to keep the wire format compact.
   */
  content: string | ContentPart[];
}
```

### 5.2 TUI 内部类型

落在 `packages/tui/src/lib/clipboard-image.ts`：

```typescript
export interface PastedImage {
  /** Raw base64, no `data:` prefix. */
  base64: string;
  mimeType: string;
  /** Where the image was recovered from. */
  source: "data-url" | "path" | "clipboard";
  /** Convenience: full `data:<mime>;base64,<...>` ready to send. */
  dataUrl: string;
}

export interface ParseOptions {
  /**
   * When the pasted text isn't itself a data URL or image path, fall back to
   * reading image bytes directly from the system clipboard. Pays a ~50–200ms
   * shell-out cost; caller decides when to enable.
   */
  fallbackToClipboard?: boolean;
}
```

### 5.3 占位符语法

输入框中以下面这种短串代表一张已识别但未发送的图片：

```text
[image:<mediaType>#<id>]
```

- `<mediaType>` 字符集：`[a-zA-Z0-9./+-]` —— 覆盖所有 IANA `image/*` 子类型
- `<id>` 字符集：`[a-zA-Z0-9-]` —— 由 `Date.now().toString(36) + '-' + random4` 生成
- 解析正则：`/\[image:([a-zA-Z0-9./+-]+)#([a-zA-Z0-9-]+)\]/g`

---

## 6. 模块拆分

### 6.1 `@lordcode/shared`

| 文件               | 改动                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/api.ts` *(扩)* | 新增 `TextPart` / `ImagePart` / `ContentPart`；`ChatMessage.content` 由 `string` 扩成 `string \| ContentPart[]`，向后兼容        |

### 6.2 `@lordcode/server`

**零代码改动**。`packages/server/src/agent/stream.ts` 的 `streamText` 调用已经 `as unknown as StreamTextFn`，扩展 `ChatMessage` 后语义自动生效；shared 与 AI SDK 形状同构，AI SDK 的 OpenAI / Anthropic / DeepSeek / OpenAI-compatible 适配层各自把 `ImagePart` 翻译成对应 provider 的多模态 wire 格式。

### 6.3 `@lordcode/tui`

| 文件                                       | 类型 | 职责                                                                                                                                                                    |
| ------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/clipboard-image.ts` *(新)*        | impl | `tryParsePastedImage(text, opts)` 主入口；按 A → B → C 顺序识别；导出 `PastedImage` / `normalizePastedPath`                                                              |
| `src/lib/compose-message.ts` *(新)*        | impl | `composeContent(text, pendingImages)`、`consumedImageIds(...)`、`renderContent(content)`；占位符 ↔ `ContentPart[]` 双向转换                                              |
| `src/lib/compose-message.test.ts` *(新)*   | test | 12 个用例覆盖：纯文本、单占位符、纯图片、多图穿插、未命中、混合命中、相邻占位符、显示渲染、id 收集                                                                       |
| `src/components/App.tsx` *(改)*            | impl | 引入 `tryParsePastedImage` / `composeContent` / `consumedImageIds` / `renderContent`；新增 `pendingImagesRef`；改 `usePaste` 回调；改 `handleSend`；改 `EntryView` 渲染   |

#### 6.3.1 `clipboard-image.ts` 内部分层

```text
tryParsePastedImage(text, opts)
  ├─ parseDataUrl(text)               ← A. data:image/...;base64,...
  ├─ parseImagePath(text)             ← B. 文件路径
  │    └─ normalizePastedPath(text)
  │        ├─ file:// URL → fileURLToPath
  │        ├─ 单/双引号包裹 → 去引号
  │        ├─ 反斜杠转义空格 → 去转义
  │        └─ POSIX 绝对路径 / Windows 盘符 / UNC 才返回
  └─ (opts.fallbackToClipboard && trim() === "")
       └─ readImageFromSystemClipboard()
            └─ readClipboardImageBytes()
                ├─ darwin → osascript «class PNGf» → tmp file
                ├─ linux  → wl-paste --type image/png || xclip ...
                └─ win32  → powershell Get-Clipboard -Format Image → tmp file
```

#### 6.3.2 `compose-message.ts` 三个公开函数

```typescript
export function composeContent(
  text: string,
  images: ReadonlyMap<string, PendingImage>,
): string | ContentPart[];

export function consumedImageIds(
  text: string,
  images: ReadonlyMap<string, PendingImage>,
): string[];

export function renderContent(content: string | ContentPart[]): string;
```

`PendingImage` 是 `{ base64: string; mimeType: string }` —— 故意设结构性约束（不依赖 `PastedImage` 标称类型），让单测可以无依赖构造。

#### 6.3.3 `App.tsx` 关键改动

```typescript
const pendingImagesRef = useRef<Map<string, PastedImage>>(new Map());

usePaste((text) => {
  void (async () => {
    const img = await tryParsePastedImage(text, { fallbackToClipboard: true });
    if (img == null) {
      setInput((v) => v + text);
      return;
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    pendingImagesRef.current.set(id, img);
    log.debug("pasted image", {
      id, mime: img.mimeType, source: img.source,
      bytes: Math.floor((img.base64.length * 3) / 4),
    });
    setInput((v) => v + `[image:${img.mimeType}#${id}]`);
  })();
});

// handleSend 中
const pending = pendingImagesRef.current;
const usedImageIds = consumedImageIds(text, pending);
const content = composeContent(text, pending);
for (const id of usedImageIds) pending.delete(id);
const userMsg: ChatMessage = { role: "user", content };
// ...

// EntryView 中
<Text>{renderContent(entry.content)}</Text>
```

---

## 7. 关键数据流

### 7.1 从 Finder 复制图片 → 粘贴 → 发送

```text
用户从 Finder 选中 a.png → ⌘C
  └─ 终端粘贴：bracketed paste → usePaste(text="/Users/me/a.png")
       └─ tryParsePastedImage:
            A. parseDataUrl                      → null
            B. parseImagePath:
                 normalizePastedPath             → "/Users/me/a.png"
                 extname → ".png" → "image/png"
                 fs.readFile(path)               → Buffer
                 → PastedImage { base64, mimeType:"image/png", source:"path", dataUrl }
       └─ pendingImagesRef.set("k0xy-ab12", img)
       └─ setInput(v + "[image:image/png#k0xy-ab12]")
       └─ log.debug { id, mime, source:"path", bytes }

用户继续输入 " what is in this?" → Enter
  └─ handleSend("[image:image/png#k0xy-ab12] what is in this?")
       └─ consumedImageIds → ["k0xy-ab12"]
       └─ composeContent →
            [
              {type:"image", image:"<base64>", mediaType:"image/png"},
              {type:"text",  text:" what is in this?"}
            ]
       └─ pending.delete("k0xy-ab12")
       └─ messages = [..., { role:"user", content }]
       └─ POST /agent/chat
```

### 7.2 截屏 / Chrome 复制图片 → 粘贴

```text
用户 ⌘⇧⌃4 截屏 → 系统剪贴板含 PNG 二进制，不含文本
  └─ 终端粘贴：bracketed paste → usePaste(text="")
       └─ tryParsePastedImage(text, { fallbackToClipboard: true })
            A. parseDataUrl(""):       → null
            B. parseImagePath(""):     → null (空 text)
            C. text.trim() === ""      → readImageFromSystemClipboard()
                 darwin: osascript 写 tmp.png → readFile → Buffer
                 → PastedImage { base64, mimeType:"image/png", source:"clipboard" }
       └─ pendingImagesRef.set(...)
       └─ setInput(v + "[image:image/png#...]")
```

### 7.3 用户手敲 `[image:...]` 字面量

```text
用户输入 "见 [image:image/png#fake] 这条" → Enter
  └─ handleSend(...)
       └─ consumedImageIds → []   (id "fake" 不在 ref 中)
       └─ composeContent  → "见 [image:image/png#fake] 这条"   (字符串原样返回)
       └─ messages = [..., { role:"user", content:"见 [image:image/png#fake] 这条" }]
```

### 7.4 用户改主意删占位符

```text
用户粘贴图片 → input = "[image:image/png#abc]"
用户全选删除 → input = ""
用户改输 "hi" → input = "hi" → Enter
  └─ consumedImageIds("hi", ref) → []
  └─ composeContent("hi", ref) → "hi"        (无未消费占位符；图片留在 ref)
  └─ messages = [..., { role:"user", content:"hi" }]
  └─ pending.delete(...)                      (没有 id 被消费，ref 不动)

后续用户重新粘贴同一张图 → 走完整流程，新 id 入 ref
旧 id 在 ref 中悬挂直到 TUI 进程退出 — 内存影响可控（本会话所有粘贴的图）
```

---

## 8. 边界情况 / 错误处理

| 场景                                   | 处理                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| 粘贴非图片文件路径（`.txt` / `.md`）   | `parseImagePath` 看 ext 不在白名单 → 返回 null → 走原文 `setInput`                  |
| 粘贴的路径不存在 / 无读权限            | `readFile` 抛错 → catch → 返回 null → 走原文                                         |
| 粘贴是多行文本                         | `normalizePastedPath` 遇 `\n` 直接返回 null（路径必须单行）→ 走原文                 |
| `data:image/...;base64,` 但 base64 损坏 | 一期不校验；server 端 AI SDK / provider 拒绝时通过 SSE `error` 帧反馈                |
| 系统剪贴板命令未安装（Linux 无 wl-paste 也无 xclip） | `runBinary` 在 `child.on("error", ...)` 时 resolve(null) → 整体返回 null → 走原文 |
| `osascript` 输出非 `"ok"`              | 视作"剪贴板没有图片" → 返回 null → 走原文                                            |
| WSL（Linux 走 PowerShell 兜底）        | 一期**不**实现；返回 null（codex 有此 fallback，本迭代不做）                         |
| 占位符 id 不在 ref 中                  | `composeContent` 保留原文；`consumedImageIds` 不收录                                 |
| 单条消息内多个图片                     | `composeContent` 按出现顺序生成 ImagePart 数组，AI SDK 原生支持                     |
| 用户在输入框删了占位符再发             | `consumedImageIds` 不返回该 id → 图片保留在 ref，可被后续输入再次插入                |
| 极大图（几十 MB）                      | 一期不限；JSON body 体积膨胀；如遇 OOM / fetch 超时再加 `maxBytes` 选项              |
| assistant 端 stream 累计               | `acc: string`；不会 push 含 image 的 assistant entry；类型上允许只为简化分支         |
| Provider 不支持视觉（如纯文本 deepseek-chat） | server 透传，provider 返回 error；通过既有 SSE `error` 帧渲染成红字 system 消息       |

---

## 9. 不在本迭代

- 输入框中以缩略图 / 色块 / icon 渲染图片占位符
- 图片大小上限、压缩、裁剪
- EXIF 元数据移除
- 多文件批量拖拽
- 视频 / 音频 / PDF 等非图片附件
- WSL ↔ Windows 剪贴板兜底
- 服务端对 `ImagePart.image` 做 base64 / mime 校验
- 把 base64 进日志、进 session 持久化
- assistant 输出图片
- Web UI 的图片输入

---

## 10. 验收标准

- [ ] 启动 TUI；从 Finder 复制一张 `.png`，粘贴到输入框 —— 输入框出现 `[image:image/png#<id>]` 占位符；日志看到 `pasted image source=path`。
- [ ] `⌘⇧⌃4` 截屏（剪贴板二进制，无文本）；在 TUI 中按 `⌘V` —— 输入框出现占位符；日志 `source=clipboard`。
- [ ] 在浏览器手动复制一段 `data:image/png;base64,iVBOR...` —— 粘贴后入框为占位符；日志 `source=data-url`。
- [ ] 粘贴一段普通文本（不含 data URL / 路径）—— 直接拼进 input，无占位符。
- [ ] 粘贴一行 `/path/to/nonexistent.png` —— 当作普通文本入 input，不报错。
- [ ] 粘贴 `Hello\nworld` 多行文本 —— 当作普通文本入 input。
- [ ] 输入 `[image:image/png#fake-id-xxx] hi` 直接回车 —— 整段作为纯字符串发送；不消费任何图片。
- [ ] 发送一条带占位符的消息后，再次发送一条普通文本 —— 普通文本不重复携带上次的图片。
- [ ] 删除占位符再粘贴新图 —— 旧图保留在 ref，新图获得新 id，互不串扰。
- [ ] 一条消息内含多张图（先后两次粘贴）—— 发送的 `content` 是 `[Image, text, Image, ...]` 数组，顺序与输入位置一致。
- [ ] 使用支持视觉的模型（如 `gpt-4o-mini` / `claude-3-5-sonnet`）实际跑一轮"看图说话" —— 模型返回针对图片内容的回答。
- [ ] 使用不支持视觉的 provider（如 `deepseek-chat`）发同样消息 —— 通过 SSE `error` 帧收到 provider 拒绝信息，TUI 显示红字 system 消息。
- [ ] `pnpm -r typecheck` / `pnpm -r test` 全绿；`compose-message` 的 12 个新增单测通过。
- [ ] TUI 渲染中 user / assistant 消息内的图片以 `[image:<mime>]` 字面量显示，不输出 base64 到屏幕。
- [ ] 日志文件中无 base64 出现；只有 `{id, mime, source, bytes}` 元信息。
