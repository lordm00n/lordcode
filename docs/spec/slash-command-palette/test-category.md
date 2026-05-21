# Slash Command Palette — Test Categories

## Unit Test Strategy

### `commands.ts`

- UT-1:
  - **Given**: `COMMAND_DEFINITIONS` is exported.
  - **When**: the command usages are read.
  - **Then**: the list includes `/models`, `/model <name>`, `/sessions`, `/new`, and `/rename <title>`.
  - **Intent**: Protects Goal G2 (Keep one command list as the source for parsing, display, filtering, and completion), so a new panel cannot silently omit an existing command.

- UT-2:
  - **Given**: input is `/models extra`.
  - **When**: `parseCommand` parses it.
  - **Then**: it returns `{ kind: "models" }`.
  - **Intent**: Protects compatibility from §4, so the panel work does not change existing submitted command behavior.

- UT-3:
  - **Given**: input is `/model`.
  - **When**: `parseCommand` parses it.
  - **Then**: it returns `{ kind: "invalid", reason: "usage: /model <name>" }`.
  - **Intent**: Protects compatibility from §4, so template completion does not make incomplete manual commands execute.

- UT-4:
  - **Given**: input is `/rename New title`.
  - **When**: `parseCommand` parses it.
  - **Then**: it returns `{ kind: "rename-session", title: "New title" }`.
  - **Intent**: Protects Goal G1 (Make existing slash commands discoverable while the user types), so the command panel can expose `/rename <title>` without changing its argument behavior.

### `command-palette.ts`

- UT-5:
  - **Given**: input is `/` and the built-in command list is available.
  - **When**: `openCommandPalette` opens the panel.
  - **Then**: selected index is `0` and all built-in commands are visible.
  - **Intent**: Protects Goal G1 (Make existing slash commands discoverable while the user types), so typing `/` immediately shows commands.

- UT-6:
  - **Given**: input is `/mo` and the built-in command list is available.
  - **When**: `filterCommandPalette` filters the panel.
  - **Then**: visible commands include `/models` and `/model <name>`.
  - **Intent**: Protects Goal G1 (Make existing slash commands discoverable while the user types), so partial command names narrow the list.

- UT-7:
  - **Given**: input is `/zzz`.
  - **When**: `filterCommandPalette` filters the panel.
  - **Then**: visible commands is `[]` and selected index is `0`.
  - **Intent**: Protects the no-results behavior in §3 Error Handling Strategy, so uncommon input does not crash the panel.

- UT-8:
  - **Given**: a panel with three visible commands and selected index `0`.
  - **When**: `moveCommandPaletteSelection` receives `-1`.
  - **Then**: selected index remains `0`.
  - **Intent**: Protects Goal G5 (Keep command behavior testable with pure state helpers), so Up at the top cannot select a missing command.

- UT-9:
  - **Given**: a panel with three visible commands and selected index `0`.
  - **When**: `moveCommandPaletteSelection` receives `1`.
  - **Then**: selected index becomes `1`.
  - **Intent**: Protects Goal G5 (Keep command behavior testable with pure state helpers), so Down moves through the command list predictably.

- UT-10:
  - **Given**: selected command is `/models` with `completion: "execute"`.
  - **When**: `activateSelectedCommand` runs.
  - **Then**: it returns `{ kind: "execute", input: "/models" }`.
  - **Intent**: Protects Goal G2 (Keep one command list as the source for parsing, display, filtering, and completion), so executable commands can use the existing submit path.

- UT-11:
  - **Given**: selected command is `/model <name>` with `completion: "insert-template"`.
  - **When**: `activateSelectedCommand` runs.
  - **Then**: it returns `{ kind: "complete-input", input: "/model " }`.
  - **Intent**: Protects Goal G1 (Make existing slash commands discoverable while the user types), so commands that need arguments guide the user instead of failing.

- UT-12:
  - **Given**: built-in commands and one skill command `/review` are merged.
  - **When**: `openCommandPalette` opens the panel.
  - **Then**: visible commands include `/review`.
  - **Intent**: Protects Goal G4 (Support future skill commands through the same command panel contract), so the panel can show commands from more than one source.

### `App.useInput`

- UT-13:
  - **Given**: input is empty and no modal state is open.
  - **When**: the user types `/`.
  - **Then**: input becomes `/` and command panel state is open.
  - **Intent**: Protects Goal G1 (Make existing slash commands discoverable while the user types), so the panel appears at the expected trigger.

- UT-14:
  - **Given**: command panel state is open.
  - **When**: the user presses Esc.
  - **Then**: command panel state becomes `null` and input is unchanged.
  - **Intent**: Protects the Esc assumption in §2 Assumptions, so closing the panel does not destroy typed text.

- UT-15:
  - **Given**: command panel state is open and streaming state is null.
  - **When**: the user presses Down.
  - **Then**: command panel selection moves and input cursor does not move down a line.
  - **Intent**: Protects Goal G3 (Render the command panel centered above the rest of the TUI without moving chat content), so keyboard focus belongs to the panel while it is open.

- UT-16:
  - **Given**: streaming state is active.
  - **When**: the user presses Esc.
  - **Then**: streaming is cancelled and command panel state does not open.
  - **Intent**: Protects the key routing in §3 Module: `App.useInput`, so the existing cancel behavior keeps priority.

### `CommandPaletteOverlay`

- UT-17:
  - **Given**: command panel state is null.
  - **When**: the app renders.
  - **Then**: no command panel title or command rows are rendered.
  - **Intent**: Protects Goal G3 (Render the command panel centered above the rest of the TUI without moving chat content), so the overlay only appears when requested.

- UT-18:
  - **Given**: command panel state has visible commands.
  - **When**: `CommandPaletteOverlay` renders.
  - **Then**: it shows `Commands`, the current query, command usages, descriptions, and `Up/Down select · Enter · Esc`.
  - **Intent**: Protects Goal G1 (Make existing slash commands discoverable while the user types), so users can see what the panel is for and how to leave it.

## E2E Strategy

EXEMPT: This feature runs in the Ink terminal UI and the project is not adding a terminal PTY E2E harness in this iteration. Browser automation is not suitable for this TUI surface. The behavior will be covered by pure state tests and component-level render tests.
