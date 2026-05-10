<!-- markdownlint-disable MD060 -->

# Cursor Move — Spec

本文档描述 lordcode TUI 中**输入框光标的呈现与移动**的总体设计，作为后续改动 / 排错的依据。

---

## 1. 概述

本迭代解决 TUI 输入框里"光标在哪、怎么动、怎么显示"这件事，由三层组成：

1. **InputState 模型**：`{ value: string, cursor: number }`，光标用**字符偏移**（offset，不是 col）表示。所有按键转移在 `lib/input-buffer.ts` 里以纯函数实现，与 Ink 解耦。
2. **位置映射**：把 `(value, cursor)` 转成屏幕坐标 `{ x, y }`，给 Ink 的 `useCursor()` 钉硬件光标。映射经过 `offsetToLineCol` → 加 prompt 前缀宽度 → 用 `string-width` 折算 CJK / emoji 宽字符。
3. **硬件光标作为唯一视觉来源**：删除原本的 `<Text inverse>` 反色块；改由 `useCursor().setCursorPosition({x,y})` 驱动终端硬件光标，再由 `main.tsx` 在启动时强制 cursor style 为 **steady block (DECSCUSR 2)**，让"光标这一格看起来是反色的字符"由终端原生渲染负责。退出时恢复终端默认形态。

也就是说：**lordcode 不再画自己的光标**，它只告诉终端"光标在屏幕的哪个 cell + 长什么样"，由终端做反色合成。这同时白送一个能力：**IME 候选窗能挂在正确的字符位置**，因为 IME 组字依赖硬件光标坐标。

---

## 2. 目标 & 范围

### In Scope

- `InputState` 数据结构与 `lib/input-buffer.ts` 中的纯函数转移：
  - 编辑：`insert` / `deleteBefore`（Backspace）/ `deleteAt`（Delete）
  - 水平移动：`moveLeft` / `moveRight` / `moveWordLeft` / `moveWordRight`
  - 垂直移动：`moveUp` / `moveDown`（保留 col，跨行短行 snap 到行尾）
  - 偏移 ↔ 行列映射：`offsetToLineCol` / `lineColToOffset`
  - 工具：`clampCursor` / `countLines`
- `App.tsx` 中 `useInput` 把按键事件路由到上述纯函数
- `Input.tsx` 中硬件光标的位置计算（用 `useBoxMetrics` 取 box origin + `string-width` 折算列宽）
- `Input.tsx` 中 streaming / 未测量 状态对硬件光标的隐藏
- `main.tsx` 在启动时主动写 `ESC [ 2 SP q`（DECSCUSR 2，steady block），cleanup / `process.on("exit")` 写 `ESC [ 0 SP q` 恢复终端默认
- 测试：`input-buffer.test.ts` 87 个用例覆盖所有 InputState 转移
- IME 支持：硬件光标坐标由 `useCursor` 通过 ANSI cursor-positioning 序列下发到终端，IME 组字时候选窗自动挂在该坐标

### Out of Scope（明确不做）

- **手绘**视觉反色块（`<Text inverse>` 风格的 `CursorText`）—— 已删除，不再保留
- 主动设置终端的 cursor color（OSC 12）—— 会污染用户配色，不做
- 自定义光标闪烁频率 / 颜色 / 形状随上下文切换（如"输入态闪烁、思考态实心"）
- 鼠标光标 / 鼠标点击定位插入点
- 多光标 / 块选 / Vim 模式
- shell 风格 history 上 / 下翻历史命令（`moveUp` / `moveDown` 仅在当前 buffer 内移动）
- 折行（soft wrap）下的"视觉行"上下移动 —— 当前 `moveUp` / `moveDown` 走**逻辑行**（按 `\n` 切分）
- BiDi / RTL 文本布局
- 输入字符宽度的 `wcwidth` 自定义；完全交给 `string-width` 包

---

## 3. 关键设计决策

| #   | 决策 | 选择 | 理由 |
| --- | --- | --- | --- |
| 1 | 光标的视觉来源 | **唯一来源 = 终端硬件光标**；不再绘制 `<Text inverse>` 反色块 | 两套光标会重叠（视觉两层皮）、CJK 边界偶尔错 1 cell；终端硬件光标是 IME 必需的，已经在那；保留另一套只是冗余 |
| 2 | 反色效果谁负责 | **终端原生**：写 DECSCUSR 让 cursor 形态为 block，由终端把那一格渲染成 cursor color × cell 合成 | 99% 的现代终端默认配色下视觉等价于 ANSI inverse；不写 SGR 7 意味着不与终端配色硬碰硬，且支持 IME |
| 3 | DECSCUSR 形态 | **`2`（steady block）**，非 blink | 闪烁会跟"insertion point 应该稳定"这个直觉打架；多数用户终端默认是 `1`（blink block），覆盖成 `2` 提升观感稳定性 |
| 4 | 何时写 DECSCUSR | **进程启动期写一次** + cleanup / `process.on("exit")` 兜底恢复 | DECSCUSR 是 sticky 状态，写一次就持久；Ink 自己 render 不会重置；只在启动一次写最简单 |
| 5 | 退出时是否恢复 | **是**，`ESC [ 0 SP q` 恢复终端默认 | 不恢复 = 污染 host shell，用户回到 zsh 后 prompt 光标也是 block；这是终端工具的基本礼仪 |
| 6 | 兜底退出路径 | `process.on("exit", reset)` 注册一次 + `cleanup()` 内部再写一次 | `cleanup` 走 SIGINT/SIGTERM/正常退出，但 `uncaughtException` 路径只会触发 Node 默认退出 → 'exit' 事件兜底；两层冗余安全 |
| 7 | 非 TTY 是否写 DECSCUSR | **跳过**（`!process.stdout.isTTY` 短路） | pipe / 重定向场景下 ANSI 序列会污染输出；Ink 也是同样不应该跑，但跳过让最坏情况只是"无效果"而不是"输出乱码" |
| 8 | DECSCUSR 写入失败 | try/catch 吞掉 | shutdown 期 EPIPE 常见；cursor 形态纯 cosmetic，不应让 process 因为它崩 |
| 9 | 光标坐标系（在 InputState 中） | **字符偏移**（`cursor: number`，范围 `[0, value.length]`） | 字符串切片操作的最自然单位；`value.slice(0, cursor)` 即光标前文，`offsetToLineCol` 处理换行 |
| 10 | newline 归属 | `\n` 属于**前一行**：`"abc\ndef"` 中 offset 3 = 行 0 末，offset 4 = 行 1 头 | 跟 readline / 大多数文本编辑器一致；让"行末"和"下一行起点"是两个**不同**的光标位置 |
| 11 | 光标在屏幕上的 col 用什么衡量 | **`string-width`**（CJK = 2 cells、emoji = 2 cells、ASCII = 1 cell） | offset 不等于显示列；CJK 用 offset 算 col 会偏移；`string-width` 是 Ink 生态事实标准 |
| 12 | prompt 前缀如何参与位置计算 | line 0 加 `stringWidth("› ")`（= 2），其它行 0 | 我们的 prompt 只渲染在第一行；连续行（`\n` 后）紧贴 box 左边缘 |
| 13 | streaming 时的光标 | **隐藏**：`setCursorPosition(undefined)` | 流式输出期间用户不能输入，光标存在会暗示"还能打字"，误导 |
| 14 | 未测量（first frame）的光标 | **隐藏**：`setCursorPosition(undefined)` | `useBoxMetrics` 第一次 render 还没拿到坐标；写 `(0,0)` 会让光标短暂闪到屏幕左上角 |
| 15 | 上下移动跨行 | 走**逻辑行**（按 `\n` 切），保留 col；目标行更短则 snap 到行尾 | 简单且可预测；soft wrap 的视觉行不在本迭代 |
| 16 | 上 / 下到边界 | 第一行按 ↑ → 跳到 buffer 起点；最后一行按 ↓ → 跳到 buffer 末尾 | 跟 shell 提示符 / VS Code 行为一致；让边界是 deterministic 的 |
| 17 | 词跳风格（Option/Alt + 左/右） | macOS Terminal 风：先吞当前方向上的连续空白，再吞一个词 | 跟用户在 Terminal.app / iTerm2 / zsh 中的肌肉记忆一致 |
| 18 | "词"的定义 | 极大化非空白连续段（`\s` 否则） | 与 readline `Meta-b/Meta-f` 一致；newline 也算 whitespace（跨行能过去） |
| 19 | 纯函数 + React state | 转移函数纯，在 `setInput((prev) => fn(prev))` 中调用 | 易测（87 个 unit test 不引 Ink）；React 18+ batching 安全；时光旅行调试可行 |
| 20 | Input.tsx 是 presentational | `value` / `cursor` / `isStreaming` 全部由 App 传入；组件本身不持状态 | 跟 App.tsx 的 single-source-of-truth 风格一致；可独立 mount |
| 21 | `useCursor` 调用时机 | **render body 中同步调用**（非 `useEffect`） | Ink 的 `useCursor` 用 `useInsertionEffect` 在 commit 阶段把位置交给 log-update；render body 中调用是上游官方推荐用法 |
| 22 | 多次 `setCursorPosition` 同一帧 | 取最后一次 | 我们一帧只调用一次；`useCursor` 内部用 ref 累积，最后一次写入 |

---

## 4. 架构总览

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Node.js Process (TUI)                                 │
│                                                                                │
│   ┌────────────────────────────────────────────────────────────────────────┐ │
│   │  packages/tui/src/main.tsx                                              │ │
│   │                                                                         │ │
│   │  // before Ink takes over stdout:                                       │ │
│   │  process.stdout.write("\x1b[2 q")        ← steady block                  │ │
│   │  process.on("exit", () => write("\x1b[0 q"))                             │ │
│   │                                                                         │ │
│   │  render(<App ... />)                                                    │ │
│   │  cleanup() {                                                            │ │
│   │    ink.unmount(); writeCursorStyle("\x1b[0 q");                          │ │
│   │  }                                                                      │ │
│   └─────────────────────────────────┬───────────────────────────────────────┘ │
│                                     │                                         │
│   ┌─────────────────────────────────▼───────────────────────────────────────┐ │
│   │  packages/tui/src/components/App.tsx                                    │ │
│   │                                                                         │ │
│   │  const [input, setInput] = useState<InputState>({ value:"", cursor:0 }) │ │
│   │                                                                         │ │
│   │  useInput((char, key) => {                                              │ │
│   │    if (key.leftArrow)   setInput(prev => key.meta                       │ │
│   │                                            ? moveWordLeft(prev)         │ │
│   │                                            : moveLeft(prev));           │ │
│   │    if (key.rightArrow)  setInput(prev => key.meta                       │ │
│   │                                            ? moveWordRight(prev)        │ │
│   │                                            : moveRight(prev));          │ │
│   │    if (key.upArrow)     setInput(prev => moveUp(prev));                 │ │
│   │    if (key.downArrow)   setInput(prev => moveDown(prev));               │ │
│   │    if (key.backspace)   setInput(prev => deleteBefore(prev));           │ │
│   │    if (key.delete)      setInput(prev => deleteAt(prev));               │ │
│   │    if (char)            setInput(prev => insert(prev, char));           │ │
│   │  })                                                                     │ │
│   │                                                                         │ │
│   │  <Input value={input.value} cursor={input.cursor} isStreaming={...}/>   │ │
│   └─────────────────────────────────┬───────────────────────────────────────┘ │
│                                     │                                         │
│   ┌─────────────────────────────────▼───────────────────────────────────────┐ │
│   │  packages/tui/src/components/input/Input.tsx                            │ │
│   │                                                                         │ │
│   │  const ref = useRef<DOMElement>(null!)                                  │ │
│   │  const { left, top, hasMeasured } = useBoxMetrics(ref)                  │ │
│   │  const { setCursorPosition } = useCursor()                              │ │
│   │                                                                         │ │
│   │  if (isStreaming || !hasMeasured) {                                     │ │
│   │    setCursorPosition(undefined)         // hide                         │ │
│   │  } else {                                                               │ │
│   │    const { line, col } = offsetToLineCol(value, cursor)                 │ │
│   │    const prefix       = line === 0 ? PROMPT_DISPLAY_WIDTH : 0           │ │
│   │    const linePrefix   = sliceLine(value, line).slice(0, col)            │ │
│   │    setCursorPosition({                                                  │ │
│   │      x: left + prefix + stringWidth(linePrefix),                        │ │
│   │      y: top + line,                                                     │ │
│   │    })                                                                   │ │
│   │  }                                                                      │ │
│   │                                                                         │ │
│   │  return <Box ref={ref}><Text>… {value}</Text></Box>                     │ │
│   └─────────────────────────────────┬───────────────────────────────────────┘ │
│                                     │                                         │
│   ┌─────────────────────────────────▼───────────────────────────────────────┐ │
│   │  Ink internals (node_modules/ink/build/log-update.js)                    │ │
│   │                                                                         │ │
│   │  - cliCursor.hide(stdout) on first render                               │ │
│   │  - on commit: write(returnPrefix + eraseLines + frame + cursorSuffix)   │ │
│   │  - cursorSuffix uses ANSI CUP (CSI y;x H) to position the hardware      │ │
│   │    cursor at (x, y) and ESC [?25h to make it visible                    │ │
│   └─────────────────────────────────┬───────────────────────────────────────┘ │
│                                     │                                         │
│                                     ▼                                         │
│                           ┌──────────────────┐                                │
│                           │  Terminal Emulator │                                │
│                           │                    │                                │
│                           │  cursor shape:     │                                │
│                           │    DECSCUSR 2      │                                │
│                           │    → steady block  │                                │
│                           │  cursor pos:       │                                │
│                           │    (col, row)      │                                │
│                           │  rendering:        │                                │
│                           │    block × cell    │                                │
│                           │    composite       │                                │
│                           │    ≈ inverse char  │                                │
│                           └──────────────────┘                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

要点：

- **`main.tsx` 拥有 cursor style**：在 Ink render 前写一次 DECSCUSR，cleanup / 'exit' 兜底恢复。这是**终端会话级**状态，不放在组件里。
- **`Input.tsx` 拥有 cursor position**：每次 render 同步调用 `useCursor().setCursorPosition`，Ink 在 commit 阶段把它编码成 ANSI CUP 写到 stdout。
- **`App.tsx` 拥有 cursor offset**：`InputState.cursor` 是 single source of truth；任何变更走 `setInput((prev) => fn(prev))`。
- **`input-buffer.ts` 是纯计算**：完全无 Ink、无 React，只接 `InputState`，便于单元测试。

---

## 5. 关键数据结构

### 5.1 `InputState`（`lib/input-buffer.ts`）

```typescript
export interface InputState {
  value: string;
  /**
   * Character offset of the cursor in `value`, in `[0, value.length]`.
   * Position `value.length` means "after the last character".
   */
  cursor: number;
}
```

### 5.2 行列坐标

`offsetToLineCol(value, offset) → { line, col }`：

- `line`、`col` 都是 0-indexed
- `\n` 归属其**前一行**（见 §3 决策 #10）
- 例：`offsetToLineCol("ab\ncd", 2) === { line: 0, col: 2 }`（行 0 末），`offsetToLineCol("ab\ncd", 3) === { line: 1, col: 0 }`（行 1 头）

`lineColToOffset(value, line, col) → offset`：反向映射，越界 col snap 到行尾，越界 line snap 到 buffer 末。

### 5.3 屏幕坐标

`Input.tsx` 中由 `useBoxMetrics` 提供：

- `left`：`<Box>` 在 Ink frame 中的 origin x
- `top`：`<Box>` 在 Ink frame 中的 origin y
- `hasMeasured`：第一次 layout 完成前为 `false`

最终硬件光标位置：

```typescript
x = left + (line === 0 ? stringWidth("› ") : 0) + stringWidth(linePrefix)
y = top + line
```

`linePrefix` 是当前行从行首到 col 的子串。用 `string-width` 而不是 `linePrefix.length`，CJK / emoji 才能正确折算。

---

## 6. 模块拆分

### 6.1 `lib/input-buffer.ts` —— 纯模型

| 函数 | 类型 | 行为概述 |
| --- | --- | --- |
| `clampCursor(value, n)` | `(string, number) => number` | 把任意 `n`（含 NaN / ±∞）规整到 `[0, value.length]` |
| `insert(state, text)` | `(InputState, string) => InputState` | 在 cursor 位置插入；空串为 no-op；cursor 推进 `text.length` |
| `deleteBefore(state)` | Backspace | 删 cursor 前一字符；起点 no-op |
| `deleteAt(state)` | Forward Delete | 删 cursor 处字符；末尾 no-op；cursor 不动 |
| `moveLeft(state)` / `moveRight(state)` | 单字符左右 | 边界饱和 |
| `moveWordLeft(state)` / `moveWordRight(state)` | 词级左右 | 先吃方向上空白，再吃一个词 |
| `moveUp(state)` / `moveDown(state)` | 跨逻辑行 | 保留 col；短行 snap 到行尾；越界 snap 到 buffer 端 |
| `offsetToLineCol(value, offset)` | offset → 行列 | `\n` 归前一行 |
| `lineColToOffset(value, line, col)` | 行列 → offset | 越界 clamp |
| `countLines(value)` | 逻辑行数 | 空串 = 1，N 个 `\n` 即 N+1 |

**约束**：

- **不引入** Ink / React 的任何 import。
- 所有函数返回**新**对象（哪怕是 no-op，也返回相同结构）—— 让上层 `setInput((prev) => fn(prev))` 总是收到干净引用，避免误共享。
- 全部用 `lib/input-buffer.test.ts` 覆盖（87 用例已就位）。

### 6.2 `components/input/Input.tsx` —— 视觉 + 硬件光标定位

职责：

1. 渲染 prompt 前缀（`›` / `…`）+ 输入文本
2. 通过 `useBoxMetrics` 取屏幕 origin
3. 通过 `useCursor` 设置硬件光标位置（或隐藏）

**不持状态**：`value` / `cursor` / `isStreaming` 全部从 prop 传入。

**不再含 `<CursorText>`**：原本的"反色块"组件已删除；非 streaming 分支与 streaming 分支共用 `<Text>{value}</Text>`。

**辅助函数**：`sliceLine(value, line)` —— 抽出 line N 的子串，仅本文件内部使用。

### 6.3 `components/App.tsx` —— 按键路由

职责：

- 持有 `InputState`
- 在 `useInput((char, key) => …)` 中把按键事件映射到 `input-buffer.ts` 的转移函数
- streaming 中按键的特殊处理：除了 ctrl-c/d 退出和 esc 中止，其它一律忽略
- enter 提交：清空 input，分发到 `/send` / `/models` / `/model <name>` 等命令

按键到转移的对照表：

| 按键 | 路由 |
| --- | --- |
| `←` | `moveLeft` |
| `→` | `moveRight` |
| `Option/Alt + ←` | `moveWordLeft` |
| `Option/Alt + →` | `moveWordRight` |
| `↑` | `moveUp` |
| `↓` | `moveDown` |
| `Backspace` | `deleteBefore` |
| `Delete` / `Fn+Backspace` | `deleteAt` |
| 普通字符 | `insert(prev, char)` |
| `Enter` | 清空 + 分发命令 |
| `Esc`（streaming 中） | abort 当前 stream |
| `Ctrl+C` / `Ctrl+D` | 退出 |

### 6.4 `main.tsx` —— Cursor style 生命周期

新增（已实现）：

```typescript
const CURSOR_STYLE_BLOCK_STEADY = "\x1b[2 q"; // DECSCUSR 2
const CURSOR_STYLE_RESET        = "\x1b[0 q"; // DECSCUSR 0 → terminal default

function writeCursorStyle(seq: string) {
  if (!process.stdout.isTTY) return;
  try { process.stdout.write(seq); } catch { /* swallow */ }
}
```

时序：

1. `await startServerWorker(...)` → worker 就绪
2. **`writeCursorStyle(CURSOR_STYLE_BLOCK_STEADY)`** —— 在 Ink 接管 stdout **之前**写
3. **`process.on("exit", () => writeCursorStyle(CURSOR_STYLE_RESET))`** —— 兜底
4. `ink = render(<App />)`
5. 退出时 `cleanup()` 中 `ink.unmount()` 后 **再写一次 reset**（双保险）

---

## 7. 关键数据流

### 7.1 用户按 `→`

```text
keypress: rightArrow
  └─ App.useInput((char, key) => …)
       └─ key.rightArrow && !key.meta
            └─ setInput(prev => moveRight(prev))
                 └─ moveRight(prev): { value, cursor: clampCursor(value, cursor+1) }
                      └─ React schedule re-render
                           └─ Input.tsx render:
                                ├─ const { line, col } = offsetToLineCol(value, cursor)
                                ├─ const linePrefix    = sliceLine(value, line).slice(0, col)
                                ├─ setCursorPosition({
                                │     x: left + (line===0 ? 2 : 0) + stringWidth(linePrefix),
                                │     y: top + line
                                │   })
                                └─ <Text>{value}</Text>
                                     └─ Ink commit:
                                          └─ stdout.write(eraseLines + frame
                                                + ESC[<y>;<x>H + ESC[?25h)
                                               └─ terminal: cursor moves to (x, y),
                                                  shape stays steady block (sticky),
                                                  renders block-on-char composite
```

### 7.2 用户键入一个 CJK 字符 `中`

```text
input was: "ab|"  (offset 2, end-of-buffer)
keypress: "中"
  └─ insert(prev, "中") → { value: "ab中", cursor: 3 }
       └─ Input.tsx render:
            ├─ offsetToLineCol("ab中", 3) → { line: 0, col: 3 }
            ├─ linePrefix = "ab中"
            ├─ stringWidth("ab中") = 1 + 1 + 2 = 4   ← 关键：中=2 cells
            ├─ setCursorPosition({ x: left + 2 + 4, y: top })
            │    = 屏幕第 5 个 cell （prompt "› "占 2，"ab中" 占 4，光标在 6 之后）
            └─ frame 中渲染 "› ab中"，硬件光标落在 "中" 之后的下一格 (cell index 6, 0-indexed)
```

### 7.3 用户在多行 buffer 中按 `↑`

```text
value = "abcdef\nuvwxyz\n123456", cursor = 17  (col 4 on line 2)
keypress: upArrow
  └─ moveUp(prev):
       ├─ offsetToLineCol → { line: 2, col: 4 }
       ├─ line > 0 → lineColToOffset(value, 1, 4) = 11   (col 4 on line 1: "uvwxy|z")
       └─ next: { value, cursor: 11 }
            └─ Input.tsx render:
                 ├─ offsetToLineCol → { line: 1, col: 4 }
                 ├─ prefix = 0  (因为 line !== 0)
                 ├─ linePrefix = "uvwx"
                 ├─ setCursorPosition({ x: left + 0 + 4, y: top + 1 })
                 └─ 硬件光标移到第二行第 4 cell（注意 line 1 没有 prompt）
```

### 7.4 流式响应开始 / 结束

```text
handleSend(text):
  ├─ setStreaming({ ... })
  └─ Input.tsx render with isStreaming=true:
       └─ setCursorPosition(undefined)        ← 硬件光标隐藏

stream finishes:
  ├─ setStreaming(null)
  └─ Input.tsx render with isStreaming=false:
       ├─ recompute (x, y) from current InputState
       └─ setCursorPosition({ x, y })          ← 硬件光标重新出现在正确位置
```

### 7.5 进程启动 / 退出

```text
startup (main.tsx):
  ├─ await startServerWorker(...)
  ├─ writeCursorStyle("\x1b[2 q")              ← terminal: cursor shape = steady block
  ├─ process.on("exit", reset)
  └─ render(<App />)
       └─ Ink: cliCursor.hide() + renders frames; subsequent setCursorPosition
                emits CSI y;x H + ESC[?25h on each commit

shutdown (Ctrl+C → cleanup()):
  ├─ ink.unmount()                             ← Ink: cliCursor.show() + erase frame
  ├─ writeCursorStyle("\x1b[0 q")              ← terminal: cursor shape ← user default
  ├─ await handle.shutdown()
  └─ process.exit(0)
       └─ 'exit' handler also writes "\x1b[0 q" (idempotent: harmless second reset)

uncaughtException path:
  ├─ logged, no cleanup() runs
  └─ Node default exit triggers 'exit' event
       └─ writeCursorStyle("\x1b[0 q")          ← still recovers
```

---

## 8. 边界情况 / 错误处理

| 场景 | 处理 |
| --- | --- |
| 空 buffer，cursor = 0 | `linePrefix = ""`，`stringWidth = 0`，硬件光标落在 prompt `›` + space 之后第 1 个 cell；视觉上是个空块，对终端 block cursor 渲染天然友好 |
| cursor 在 buffer 末尾（含末尾是字符） | `linePrefix` 包含到末位字符；硬件光标落在最后一字符**之后**的空 cell；终端渲染为空 block，跟原 `<Text inverse> </Text>` 视觉等价 |
| cursor 紧贴 `\n`（即一行末，下一行非空） | offset 仍归属前一行（`offsetToLineCol`）；光标落在 `\n` 应在的视觉 cell（即 `value` 在屏幕上 wrap 之前的空白处）；按 `→` 一次后跳到下一行行首 |
| 含 CJK / emoji 的 `linePrefix` | `stringWidth` 折算列宽；CJK = 2、ASCII = 1、组合字符 / ZWJ 序列由 `string-width` 处理 |
| Ink 还没 layout 完成（`hasMeasured === false`） | `setCursorPosition(undefined)` 隐藏，避免短暂闪到屏幕左上 (0,0) |
| `isStreaming === true` | 同上：隐藏 |
| 多次 `setInput` 同步连发 | React 18+ batching 合并，最终只 render 一次；`useCursor` 取 render body 中最后一次 `setCursorPosition`，正确 |
| 终端不支持 DECSCUSR（远古终端、纯 dumb tty） | 终端会忽略未知 CSI 序列；cursor 形态保持终端默认；功能上不受影响，只是 cosmetic 不强制为 block |
| 终端支持 DECSCUSR 但用户配的是 `bar` cursor color | DECSCUSR 改的是**形态**（block / underline / bar），不改颜色；写 `2` 后形态强制 block，颜色仍是用户配的 cursor color；多数主题下视觉接近反色 |
| `stdout` 不是 TTY（pipe / 重定向） | `writeCursorStyle` 短路，跳过；Ink 也通常不该这么跑，但跳过让最坏只是无效果 |
| `cleanup()` 跑过一次后再次触发 | `cleaningUp` 锁防止重入；`process.on("exit")` 的兜底 reset 是幂等的（重复写 DECSCUSR 0 无副作用） |
| `uncaughtException` 路径 | `bootLog.error` 记录；不调用 `cleanup`；'exit' 事件兜底恢复 cursor style |
| SIGKILL / 被强制杀 | 终端 cursor 形态会停在 `steady block` 直到下一次 ANSI 重置（user 在 shell 里运行任何会发 CSI 的程序就会重置）；我们能做的兜底已经穷尽 |
| `↑` 在第一行 | snap 到 buffer 起点（offset 0） |
| `↓` 在最后一行 | snap 到 buffer 末尾（offset = length） |
| col 跨行短行 | snap 到目标行行尾，下次 `↑` / `↓` 从新位置算 col（**不**保留原始虚拟列；这是 readline 风格，不是 vim 风格） |
| `moveWordLeft` 在 buffer 起点 | no-op |
| `moveWordRight` 在 buffer 末 | no-op |
| `Backspace` 在 buffer 起点 | no-op |
| `Delete` 在 buffer 末 | no-op |

---

## 9. 兼容性矩阵

| 终端 | DECSCUSR 支持 | block cursor 反色合成 | IME 候选窗位置正确 |
| --- | --- | --- | --- |
| iTerm2 (macOS) | ✓ | ✓（smart cursor color 默认开） | ✓ |
| Terminal.app (macOS) | ✓ | ✓ | ✓ |
| Alacritty | ✓ | ✓（依赖 theme cursor.background / .text 配置） | ✓ |
| kitty | ✓ | ✓ | ✓ |
| wezterm | ✓ | ✓ | ✓ |
| Windows Terminal | ✓ | ✓ | ✓ |
| VS Code 集成终端 | ✓ | ✓ | ✓ |
| GNOME Terminal / KDE Konsole | ✓ | ✓ | ✓ |
| 老旧 xterm（非 patch 版） | ⚠ 部分 | ⚠ 视配置 | ⚠ |
| 纯 dumb tty / `script(1)` 输出 | ✗（忽略） | n/a | n/a |

**说明**：DECSCUSR 是 xterm 扩展，主流终端都遵循；不支持的终端会忽略未知 CSI 序列，不会出错。

---

## 10. 不在本迭代

- soft wrap 下的"视觉行" `↑` / `↓`
- 输入历史（shell 风格的 `Up` 翻历史）
- 多光标 / 块选 / 矩形选区
- Vim / Emacs 模式键位
- 鼠标点击定位 / 选择
- BiDi / RTL 文本布局
- 自定义光标颜色（OSC 12）
- 光标形态随上下文切换（输入态 = block，思考态 = underline 等）
- 自动换行包装计算（依赖终端宽度的 wrap 模拟）
- 中文 IME 在 lordcode 内的"内嵌候选窗"（仍由系统 IME 处理）

---

## 11. 验收标准

- [ ] `pnpm --filter @lordcode/tui typecheck` ✅
- [ ] `pnpm --filter @lordcode/tui test` 全绿；`input-buffer.test.ts` 87 用例覆盖所有转移
- [ ] 启动 TUI 后，输入框光标显示为**稳定块**（不闪烁、不下划线、不竖条），无论用户终端默认 cursor style 是什么
- [ ] `Ctrl+C` 退出 TUI 后回到 shell，shell 提示符的光标恢复到 **shell 原本设定的形态**（不是 lordcode 留下的 block）
- [ ] `kill -TERM <pid>` lordcode 进程，shell 光标同样恢复
- [ ] **故意触发 `uncaughtException`**（临时改代码加 `throw`），进程退出后 shell 光标仍然恢复到原配置（验证 `process.on("exit")` 兜底）
- [ ] 输入纯 ASCII：`hello world`，按 ←/→ 移动，硬件光标准确落在每一字符上
- [ ] 输入含 CJK：`你好 world`，按 ←/→ 移动，硬件光标在 `你` `好` 两字符上各占 1 步移动（offset 步进），但视觉上在屏幕上跨过 2 个 cell
- [ ] 输入含 emoji：`hi 🚀 there`，硬件光标对 emoji 也按"1 字符 = 2 cell"对齐
- [ ] `Option + ←` / `Option + →` 按词跳：在 `hello   world` 中跳过中间多个空格 + 整词
- [ ] 多行 buffer（粘贴 `aaa\nbbb\nccc`），`↑` / `↓` 在逻辑行间跳；`↑` 到第一行再按一次跳到 buffer 起点；`↓` 到最后一行再按一次跳到 buffer 末尾
- [ ] 第二行及后续行的硬件光标**不**再加 `›` + space 前缀偏移（前缀只渲染在 line 0）
- [ ] 流式响应进行中（`isStreaming === true`），硬件光标**消失**；流结束后，光标重新出现在用户上次输入位置
- [ ] 把光标移到字符串中间然后切换到中文输入法组字（macOS Pinyin / iBus），候选词浮窗应**贴在光标所在字符**位置，而不是飘到屏幕左上 / 行首
- [ ] 输入框**没有**任何 `<Text inverse>` 风格的反色块（确认 `<CursorText>` 已删除：`grep -r "CursorText" packages/tui/src` 无结果）
- [ ] 屏幕截图工具截图：硬件光标可能因截屏瞬间未画入而不可见；这是已知 trade-off，不是回归
- [ ] **跨终端验证**：iTerm2 / Terminal.app / Alacritty / VS Code 终端 / Windows Terminal 至少一台覆盖；光标视觉一致（block + 反色合成）
