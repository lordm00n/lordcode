# Session Store Unit Tests

Back-pointer: `docs/spec/session-persistence/design.md` `## Unit Test Strategy` and `harness-kit:tdd/SKILL.md`.

## What This Module Tests

These tests cover the SQLite-backed canonical session store and runtime: schema migrations, session metadata, canonical event append/load semantics, project-scoped listing, title ownership, malformed payload handling, cascade deletion, and per-session log file fan-out.

## Test Cases

| ID | Given / When / Then | File |
| --- | --- | --- |
| UT-1 | Given an empty database, when migrations run, then all required tables and indexes exist. | `store.test.ts` |
| UT-2 | Given a new session, when it is created, then it has `title = NULL` and `title_source = "none"`. | `store.test.ts` |
| UT-3 | Given a session with no title, when the first user message is appended, then the session receives an automatic truncated title. | `store.test.ts` |
| UT-4 | Given a user-renamed session, when later user messages are appended, then the title is not overwritten. | `store.test.ts` |
| UT-5 | Given multiple events, when they are appended, then their `seq` order is stable and unique. | `store.test.ts` |
| UT-6 | Given a session with events, when it is deleted, then related events are deleted. | `store.test.ts` |
| UT-7 | Given a session with message, tool call, and tool result events, when it is loaded, then events are returned in `seq` order. | `store.test.ts` |
| UT-8 | Given malformed event payload JSON, when the session is loaded, then loading fails with a clear recoverable error. | `store.test.ts` |
| UT-9 | Given sessions from multiple projects, when listing sessions for one project, then only that project's sessions are returned. | `store.test.ts` |
| SL-1 | Given an active session runtime, when session logs are written, then they fan out to global and session-specific logs. | `runtime.test.ts` |
| SL-2 | Given a new active session, when logging continues, then later lines go only to the new session file. | `runtime.test.ts` |
| SL-3 | Given a restored session, when logging continues, then lines reattach to the restored session file. | `runtime.test.ts` |

## Prerequisites

Toolchain:

- Check runner version: `pnpm --filter @lordcode/server exec vitest --version`
- Install dependencies: `pnpm install`

Environment variables:

| Variable | Purpose | Required when | Default |
| --- | --- | --- | --- |
| None. | None. | None. | None. |

Fixtures / external state: Tests create temporary SQLite databases and log files under the OS temp directory and remove them after each test. No external fixtures are required.

## Running

- Run every test in this module: `pnpm --filter @lordcode/server test -- src/session/store.test.ts src/session/runtime.test.ts`
- Run a single `UT-N`: `pnpm --filter @lordcode/server test -- src/session/store.test.ts -t "UT-1"`
- Run a single `SL-N`: `pnpm --filter @lordcode/server test -- src/session/runtime.test.ts -t "SL-1"`
- Watch mode: `pnpm --filter @lordcode/server test:watch -- src/session/store.test.ts src/session/runtime.test.ts`
- Coverage: `pnpm --filter @lordcode/server exec vitest run src/session/store.test.ts src/session/runtime.test.ts --coverage`
- How NOT to run: Do not skip Vitest and call store methods from ad-hoc scripts; do not mock SQLite behavior that these tests are meant to verify.

## Expected Output

Every UT-1 through UT-9 and SL-1 through SL-3 test passes, with no warnings and pristine stderr.

## Related Files

- `packages/server/src/session/store.ts`
- `packages/server/src/session/types.ts`
- `packages/server/src/session/runtime.ts`
- `packages/server/src/config/paths.ts`
- `docs/spec/session-persistence/design.md`
- `harness-kit:tdd/SKILL.md`
