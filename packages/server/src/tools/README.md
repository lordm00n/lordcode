# Tools Process Tests

Back-pointers: `docs/spec/glob-tool/design.md#13-unit-test-strategy` and `harness-kit:tdd/SKILL.md`.

## What This Module Tests

These tests verify the shared ripgrep process runner used by server tools: it collects process output and metadata, preserves abort semantics, and wraps spawn/runtime failures consistently.

## Test Cases

| ID | Given / When / Then | File |
| --- | --- | --- |
| UT-3 | Given fake rg process behavior, when `runRg` executes, then it returns stdout/stderr metadata or rejects with the expected error class. | `process.test.ts` |
| UT-6 | Given tool registry deps, when `buildTools` runs, then both `ripgrep` and `glob` are registered with separate logger children. | `registry.test.ts` |

## Prerequisites

Toolchain:

- Node.js: `node --version`
- pnpm: `pnpm --version`
- Install dependencies: `pnpm install`

Env vars:

| Variable | Purpose | Required when | Default |
| --- | --- | --- | --- |
| None. | | | |

Fixtures / external state:

- Hermetic: these tests use fake child processes and need no external fixtures.

## Running

- All process/registry tests: `pnpm --filter @lordcode/server exec vitest run src/tools/process.test.ts src/tools/registry.test.ts`
- Single UT: `pnpm --filter @lordcode/server exec vitest run src/tools/process.test.ts -t "UT-3"`
- Watch mode: `pnpm --filter @lordcode/server exec vitest src/tools/process.test.ts`
- Coverage: `pnpm --filter @lordcode/server exec vitest run src/tools/process.test.ts --coverage`

How NOT to run:

- Do not bypass Vitest with ad hoc Node scripts.
- Do not replace abort tests with assertions against mocks that never exercise child process event flow.

## Expected Output

Every listed UT passes, with no warnings and pristine stderr.

## Related Files

- `packages/server/src/tools/process.ts`
- `docs/spec/glob-tool/design.md`
- `harness-kit:tdd/SKILL.md`
