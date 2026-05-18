# Unit tests: TUI stream projection helpers

> **Source spec:** `docs/spec/tool-input-streaming/design.md` under `## Test Strategy`.
>
> **Test files under:** `packages/tui/src/lib/*.test.ts`
>
> **Skill:** every change here must follow `harness-kit:tdd` — RED → Verify-RED → GREEN → Verify-GREEN.

## What this module tests

These tests pin pure TUI helpers that keep provider-facing history canonical while projecting live UI state: the history accumulator ignores UI-only events, live tool-input placeholders update and clear locally, and formatting stays terse enough for a single TUI row.

## Test cases

| ID | Case (Given / When / Then) | File |
|----|----------------------------|------|
| UT-A1 | Given tool input lifecycle events, when accumulated, then history and pending state are unchanged. | `packages/tui/src/lib/history-accumulator.test.ts` |
| UT-A2 | Given assistant text followed by tool input lifecycle events and a formal tool call, when accumulated, then text is not flushed early. | `packages/tui/src/lib/history-accumulator.test.ts` |
| UT-T1 | Given `tool-input-start`, when applied to live state, then a preparing placeholder is present and formats without bytes. | `packages/tui/src/lib/live-tool-inputs.test.ts`, `packages/tui/src/lib/format-tool-call.test.ts` |
| UT-T2 | Given `tool-input-progress`, when applied to live state, then aggregate bytes and elapsed time update and bytes are formatted. | `packages/tui/src/lib/live-tool-inputs.test.ts`, `packages/tui/src/lib/format-tool-call.test.ts` |
| UT-T3 | Given `tool-input-end`, when applied to live state, then the placeholder becomes executing and formats accordingly. | `packages/tui/src/lib/live-tool-inputs.test.ts`, `packages/tui/src/lib/format-tool-call.test.ts` |
| UT-T4 | Given a matching formal `tool-call`, when applied to live state, then the placeholder is removed. | `packages/tui/src/lib/live-tool-inputs.test.ts` |
| UT-T5 | Given stale placeholders and `tool-result` or `tool-error`, when applied to live state, then matching placeholders are defensively removed. | `packages/tui/src/lib/live-tool-inputs.test.ts` |

## Prerequisites

### 1. Toolchain

- Test runner: Vitest
- Install dependencies (run once per checkout):

  ```bash
  pnpm install
  ```

- Verify the runner is available:

  ```bash
  pnpm --filter @lordcode/tui exec vitest --version
  ```

### 2. Environment variables

None.

### 3. Fixtures / external state

None — tests run hermetically against pure functions.

## Running

### Run every test in this module

```bash
pnpm --filter @lordcode/tui test -- src/lib/history-accumulator.test.ts src/lib/format-tool-call.test.ts src/lib/live-tool-inputs.test.ts
```

Expected: every UT-N PASS. No warnings, no stderr noise.

### Run a single UT-N

```bash
pnpm --filter @lordcode/tui test -- src/lib/live-tool-inputs.test.ts -t 'UT-T1'
```

### Watch mode (optional)

```bash
pnpm --filter @lordcode/tui test:watch -- src/lib/live-tool-inputs.test.ts
```

### Coverage (optional)

```bash
pnpm --filter @lordcode/tui exec vitest run --coverage src/lib/history-accumulator.test.ts src/lib/format-tool-call.test.ts src/lib/live-tool-inputs.test.ts
```

### How NOT to run

- Do not skip the RED run when adding behavior.
- Do not mock the pure helper under test; feed real `AgentStreamEvent` values.

## Expected output

- All UT-A and UT-T cases from the table above PASS.
- No warnings, deprecated-API noise, or stderr leaks.

## Related files

- `packages/tui/src/lib/history-accumulator.ts`
- `packages/tui/src/lib/live-tool-inputs.ts`
- `packages/tui/src/lib/format-tool-call.ts`
- `packages/tui/src/components/App.tsx`
- `packages/shared/src/api.ts`
- `docs/spec/tool-input-streaming/design.md`
- `harness-kit:tdd/SKILL.md`
