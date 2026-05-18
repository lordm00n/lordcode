# Unit tests: server agent stream

> **Source spec:** `docs/spec/tool-input-streaming/design.md` under `## Test Strategy`.
>
> **Test files under:** `packages/server/src/agent/stream.test.ts`
>
> **Skill:** every change here must follow `harness-kit:tdd` — RED → Verify-RED → GREEN → Verify-GREEN.

## What this module tests

These tests pin the server-side agent stream contract: SDK `fullStream` chunks are translated into `AgentStreamEvent` frames in order, including UI-only tool input lifecycle events that surface model-side argument generation before the formal tool call arrives.

## Test cases

| ID | Case (Given / When / Then) | File |
|----|----------------------------|------|
| UT-S1 | Given `tool-input-start`, when streamed, then `id` is forwarded as `toolCallId`. | `packages/server/src/agent/stream.test.ts` |
| UT-S2 | Given small deltas below throttle thresholds, when streamed, then no progress event is emitted. | `packages/server/src/agent/stream.test.ts` |
| UT-S3 | Given deltas crossing the byte threshold, when streamed, then aggregate progress is emitted. | `packages/server/src/agent/stream.test.ts` |
| UT-S4 | Given `tool-input-end` after deltas, when streamed, then final aggregate bytes are emitted. | `packages/server/src/agent/stream.test.ts` |
| UT-S5 | Given a normal input lifecycle followed by tool call/result, when streamed, then event order is preserved. | `packages/server/src/agent/stream.test.ts` |

## Prerequisites

### 1. Toolchain

- Test runner: Vitest
- Install dependencies (run once per checkout):

  ```bash
  pnpm install
  ```

- Verify the runner is available:

  ```bash
  pnpm --filter @lordcode/server exec vitest --version
  ```

### 2. Environment variables

None.

### 3. Fixtures / external state

None — tests run hermetically with fake streams and injected model/config seams.

## Running

### Run every test in this module

```bash
pnpm --filter @lordcode/server test -- src/agent/stream.test.ts
```

Expected: every UT-N PASS. No warnings, no stderr noise.

### Run a single UT-N

```bash
pnpm --filter @lordcode/server test -- src/agent/stream.test.ts -t 'UT-S1'
```

### Watch mode (optional)

```bash
pnpm --filter @lordcode/server test:watch -- src/agent/stream.test.ts
```

### Coverage (optional)

```bash
pnpm --filter @lordcode/server exec vitest run --coverage src/agent/stream.test.ts
```

### How NOT to run

- Do not skip the RED run when adding behavior.
- Do not mock the accumulator or stream loop under test; inject fake SDK chunks through the real `streamAgent`.

## Expected output

- All UT-S cases from the table above PASS.
- No warnings, deprecated-API noise, or stderr leaks.

## Related files

- `packages/server/src/agent/stream.ts`
- `packages/shared/src/api.ts`
- `docs/spec/tool-input-streaming/design.md`
- `harness-kit:tdd/SKILL.md`
