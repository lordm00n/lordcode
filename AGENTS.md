# AGENTS.md - AI Assistant Guidelines for lordcode

This document provides guidelines and context for AI assistants working on the lordcode project.

## Project Overview

**lordcode** is a local coding agent with a TUI + embedded HTTP server dual-thread architecture.

- **Package Manager**: pnpm (v10.17.1)
- **Node Version**: >=20.10
- **TypeScript**: ^5.6.3
- **Architecture**: Monorepo with multiple packages

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 Node.js Process                     │
│                                                     │
│  ┌──────────────────┐         ┌──────────────────┐  │
│  │   Main Thread    │  HTTP   │  Worker Thread   │  │
│  │                  │ ──────► │                  │  │
│  │   Ink TUI        │         │   Hono Server    │  │
│  │   (@lordcode/tui)│ ◄────── │ (@lordcode/server)│ │
│  │                  │         │   + Agent core   │  │
│  └──────────────────┘         └──────────────────┘  │
└─────────────────────────────────────────────────────┘
```

- **Main Thread**: Runs Ink TUI for rendering and input
- **Worker Thread**: Runs Hono HTTP server for agent logic and API
- **Communication**: TUI and server communicate via HTTP
- **Shared Types**: `@lordcode/shared` contains cross-package types and API contracts

## Package Structure

```
lordcode/
├── packages/
│   ├── shared/   # @lordcode/shared - Shared types / API contracts
│   ├── server/   # @lordcode/server - Hono HTTP server + agent
│   ├── tui/      # @lordcode/tui - Ink TUI (project entry point)
│   ├── web/      # @lordcode/web - [Reserved] Future web UI (placeholder)
│   └── logger/   # @lordcode/logger - Logging utilities
├── .agents/      # Agent skills configuration
├── docs/         # Documentation (specs)
└── .cursor/      # Cursor IDE configuration (currently empty)
```

## Development Commands

```bash
# Install dependencies
pnpm install

# Start TUI (automatically starts server in worker thread)
pnpm dev

# Start server only (standalone process for debugging)
pnpm dev:server

# Type checking
pnpm typecheck

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint

# Clean build artifacts
pnpm clean
```

## Code Guidelines

### TypeScript

- Use strict TypeScript configuration
- Prefer explicit types over `any`
- Use ES modules (`"type": "module"` in package.json)
- Follow the base tsconfig at `tsconfig.base.json`

### Package Conventions

Each package in `packages/` should:
- Have its own `package.json` with proper exports
- Include `build`, `typecheck`, `test`, and `clean` scripts
- Export types from `src/index.ts`
- Keep implementation details private

### Naming Conventions

- **Files**: kebab-case for most file names (e.g., `api-client.ts`, `worker-protocol.ts`). Some React components and legacy files use PascalCase (e.g., `App.tsx`, `Input.tsx`) or camelCase (e.g., `apiKey.ts`).
- **Classes/Types**: PascalCase (e.g., `StreamAgentContext`, `FullStreamChunk`)
- **Functions/Variables**: camelCase (e.g., `streamAgent`, `resolveApiKey`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `API_ROUTES`, `AGENT_LOOP_MAX_STEPS`, `MAX_CONTENT_BYTES`)

## Configuration

### Model Configuration

Models are configured in `~/.lordcode/config.json`:

```jsonc
{
  "version": 1,
  "currentModel": "gpt-4o-mini",
  "models": [
    {
      "name": "gpt-4o-mini",
      "provider": "openai",
      "model": "gpt-4o-mini",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  ]
}
```

**Supported Providers**: `openai`, `anthropic`, `deepseek`

### TUI Commands

| Command | Description |
|---------|-------------|
| `/models` | List all configured models |
| `/model <name>` | Switch to a different model |
| `Esc` | Cancel streaming generation |
| `Ctrl-C` / `Ctrl-D` | Exit TUI |

## AI SDK Guidelines

When working with AI features in this project:

1. **Use Vercel AI SDK** - The project uses `ai` package from Vercel AI SDK
2. **Always verify APIs** - Search `node_modules/ai/docs/` and `node_modules/ai/src/` for current APIs
3. **Use `streamAgent` pattern** - The agent core uses `streamText` from the Vercel AI SDK wrapped in a `streamAgent` async generator in `packages/server/src/agent/stream.ts`
4. **Check Common Errors** - Before debugging type errors, check `.agents/skills/ai-sdk/references/common-errors.md`

## Testing

- Tests are run per-package using `pnpm test` (powered by Vitest)
- Follow the testing conventions established in each package
- Ensure type checking passes before committing

## Common Issues

| Issue | Solution |
|-------|----------|
| `no models configured` | Add models to `~/.lordcode/config.json` |
| JSONC parse error | Fix syntax in config file |
| `missing apiKey` | Set the environment variable or add `apiKey` to config |
| Type errors | Check common-errors.md and verify against source |

## Skills System

The project uses an agent skills system located in `.agents/skills/`:

- Skills are defined in `SKILL.md` files
- Skills lock file: `skills-lock.json` (root level)
- Current skill: `ai-sdk` (Vercel AI SDK documentation and patterns)

## Best Practices for AI Assistants

1. **Read before writing** - Always read existing files before modifying them
2. **Run typecheck** - After making code changes, run `pnpm typecheck`
3. **Minimal changes** - Only modify what's necessary
4. **Follow patterns** - Match existing code style and patterns in the project
5. **Verify APIs** - Don't rely on memory for API details; check source/docs
6. **Test incrementally** - Make small, testable changes

## Debugging

- Set `LORDCODE_DEBUG=1` for debug output (already set in `pnpm dev`)
- Use `pnpm dev:server` to run server standalone for debugging
- Check server logs for HTTP communication issues between TUI and server
