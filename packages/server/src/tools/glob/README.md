# Glob Tool Tests

Back-pointers: `docs/spec/glob-tool/design.md#13-unit-test-strategy` and `harness-kit:tdd/SKILL.md`.

## What This Module Tests

These tests verify that the glob tool lists files by path pattern, applies defaults and limits, preserves ripgrep's ignore behavior, handles hidden files and excludes, and maps no-match/error/abort cases into the expected tool output or error.

## Test Cases

| ID | Given / When / Then | File |
| --- | --- | --- |
| UT-1 | Given glob inputs, when schema parsing runs, then defaults are applied and invalid limits are rejected. | `execute.test.ts` |
| UT-2 | Given glob inputs, when args are built, then `rg --files` flags match the spec. | `execute.test.ts` |
| UT-4 | Given the fixture corpus, when `executeGlob` runs, then it returns matching, truncated, excluded, hidden, empty, or error results as specified. | `execute.test.ts` |

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

- Fixture tree: `packages/server/tests/fixtures/glob-corpus`
- Recreate command: tracked in git; no external setup required.

## Running

- All glob tool tests: `pnpm --filter @lordcode/server exec vitest run src/tools/glob/execute.test.ts`
- Single UT: `pnpm --filter @lordcode/server exec vitest run src/tools/glob/execute.test.ts -t "UT-4"`
- Watch mode: `pnpm --filter @lordcode/server exec vitest src/tools/glob/execute.test.ts`
- Coverage: `pnpm --filter @lordcode/server exec vitest run src/tools/glob/execute.test.ts --coverage`

How NOT to run:

- Do not bypass Vitest with ad hoc `tsx` scripts.
- Do not mock the real `executeGlob` path for fixture cases; those tests should exercise the shipped `@vscode/ripgrep` binary.

## Expected Output

Every listed UT passes, with no warnings and pristine stderr.

## Related Files

- `packages/server/src/tools/glob/schema.ts`
- `packages/server/src/tools/glob/execute.ts`
- `packages/server/src/tools/glob/tool.ts`
- `packages/server/src/tools/process.ts`
- `docs/spec/glob-tool/design.md`
- `harness-kit:tdd/SKILL.md`
