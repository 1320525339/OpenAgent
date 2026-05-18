- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- To regenerate SDK + OpenAPI spec + format, run `./script/generate.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Repo overview

Bun monorepo (bun@1.3.13) managed with Turborepo. Key packages:

- `packages/opencode` — core CLI, server, TUI, business logic
- `packages/app` — web UI (SolidJS + Vite)
- `packages/desktop` — Electron desktop app (wraps `packages/app`)
- `packages/llm` — Effect Schema-first LLM provider/route layer
- `packages/core` — shared core utilities
- `packages/sdk/js` — generated JavaScript SDK
- `packages/ui` — shared UI components
- `packages/plugin` — `@opencode-ai/plugin` source

## Commands

| Task | Command | Notes |
|------|---------|-------|
| Install | `bun install` | from repo root |
| Dev (TUI) | `bun dev` | from root; runs in `packages/opencode` |
| Dev (web) | `bun dev web` | starts server + opens web UI |
| Dev (server) | `bun dev serve` | headless API on port 4096 |
| Typecheck (all) | `bun typecheck` | runs `turbo typecheck` across all packages |
| Typecheck (pkg) | `bun typecheck` | from a package dir; uses `tsgo --noEmit` |
| Lint | `bun lint` | runs `oxlint` from root |
| Test (CI) | `bun turbo test:ci` | all packages, JUnit output |
| Test (pkg) | `bun test` | from a package dir |
| Test (single) | `bun test path/to/file.test.ts` | from a package dir |
| DB migration | `bun run db generate --name <slug>` | from `packages/opencode` |
| SDK generate | `./script/generate.ts` | regenerates SDK, OpenAPI, formats |
| Build exe | `./packages/opencode/script/build.ts --single` | standalone binary |

**Never run tests from repo root** — `bunfig.toml` guards against it (`root = "./do-not-run-tests-from-root"`).

## Git & CI

- Pre-push hook runs `bun typecheck`; ensure it passes before pushing.
- CI runs `bun turbo test:ci` (Linux + Windows) and `bun typecheck`.
- PR titles follow conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. Optionally scope: `feat(app):`, `fix(desktop):`.
- All PRs must reference an existing issue (`Fixes #123`).

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.
- Use `bun test --timeout 30000` from package dirs (matches CI).
- Effect tests use `testEffect(...)` from `test/lib/effect.ts`; see `packages/opencode/test/AGENTS.md` for fixtures and patterns.
- LLM provider tests are fixture-first; live calls require `RECORD=true` and API keys. See `packages/llm/AGENTS.md`.
- Use `pollWithTimeout` / `awaitWithTimeout` for async synchronization in tests; never use `Effect.sleep` as a "wait for readiness" hack.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.
- Typecheck uses `tsgo` (TypeScript native preview), not `tsc`.

## Effect

See `packages/opencode/AGENTS.md` for full Effect conventions, module shape, `InstanceState`, and service patterns.

Key rules:
- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Domain.method")` for named/traced effects.
- Prefer `FileSystem`, `ChildProcessSpawner`, `HttpClient`, `Path`, `Config`, `Clock` over raw platform APIs inside Effect code.
- Use `makeRuntime` (from `src/effect/run-service.ts`) for services; use `InstanceState` for per-directory state with scoped cleanup.
- Do not use `export namespace Foo { ... }` — use flat exports with `export * as Foo from "./foo"` self-reexport.

## LLM Package

See `packages/llm/AGENTS.md` for route/protocol architecture, provider definitions, tool runtime, and recording test patterns.

## Desktop

- Renderer process should only call `window.api` from `src/preload`.
- Main process should register IPC handlers in `src/main/ipc.ts`.

## Formatter

- Prettier: `semi: false`, `printWidth: 120`.
