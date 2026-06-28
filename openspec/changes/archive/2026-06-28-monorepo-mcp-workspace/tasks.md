# Tasks: Monorepo MCP Workspace

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 250–450 net (renames via `git rename detection`); README ~275 lines moved unchanged |
| 400-line budget risk | Medium |
| 800-line budget risk | Low |
| Suggested split | Single PR (auto-forecast / pending chain) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

Rationale: 400 Medium for reviewer load; 800 Low via rename detection; no chain.

## Phase 1: Workspace Root Scaffold

- [x] 1.1 `pnpm-workspace.yaml` (`packages: ["apps/*"]`); root `package.json` → `name: "db-workspace"`, `private: true`, `packageManager: "pnpm@10.33.0"`, no `bin`/`main`/`files`; keep `pnpm.onlyBuiltDependencies` for `esbuild`/`sqlite3`. Root `pyproject.toml` uv scaffold (`requires-python=">=3.12"`; uv pin deferred to first Python app).
- [x] 1.2 `tsconfig.base.json` carries current root compiler options (ES2022, NodeNext, strict, `noUncheckedIndexedAccess`, `noImplicitOverride`); no `rootDir`/`outDir`/`include`/`exclude`. Delete root `tsconfig.json` and stale root `dist/`.
- [x] 1.3 Replace `.gitignore` with recursive patterns: `**/node_modules`, `**/dist`, `.env`, `.env.local`, `**/.venv`, `**/__pycache__`, `**/data/*.sqlite*`, `coverage/`, `*.log`, `.DS_Store`. Keep `.atl/` at workspace root (NOT in app); verify patterns do not match `.atl/`.

## Phase 2: Move App to apps/mcp-readonly-sql/

- [x] 2.1 App `package.json` preserves `name: "mcp-readonly-sql"` (NO `@db/` rename), `type: module`, `bin`, `main`, deps/devDeps, scripts; add `typecheck: "tsc -p tsconfig.json --noEmit"`. App `tsconfig.json` extends `../../tsconfig.base.json` with `rootDir: "src"`, `outDir: "dist"`.
- [x] 2.2 `git mv src/`, `test/`, `vitest.config.ts`, `.env.example`, `README.md` to `apps/mcp-readonly-sql/`; keep current 275-line README content unchanged, do NOT rewrite.
- [x] 2.3 Safe-move untracked root `.env` to `apps/mcp-readonly-sql/.env` (operator step, never commit); verify with `git check-ignore`; never `print`/`cat`/stage/diff. Safe-move gitignored root `data/` runtime files to `apps/mcp-readonly-sql/data/` with `mv` (NOT `git mv`); keep `**/data/*.sqlite*` in `.gitignore`; `.gitkeep` only if app `data/` empty.

## Phase 3: Root Scripts and OpenSpec Rewrite

- [x] 3.1 Root `package.json` scripts delegate via `pnpm --filter mcp-readonly-sql <script>`: `dev`, `start`, `inspect`, `test:watch`, `test`, `build`, `typecheck`. Run `pnpm install` at root to refresh `pnpm-lock.yaml`.
- [x] 3.2 Rewrite `openspec/config.yaml` `context:` prose for the monorepo (pnpm + uv workspaces, multi-MCP, no app-specific stack assumptions); rewrite `apply.settings.{test,build}_command`, `verify.settings.{test,build,typecheck}_command`, `testing.{runner,watch}_command` to per-app `pnpm --filter mcp-readonly-sql` form.

## Phase 4: Documentation and Host Wiring

- [x] 4.1 After 2.2 verifies the moved app README is intact, create a NEW concise root `README.md` (workspace overview: app index, link to `apps/mcp-readonly-sql/README.md`, breaking host-path note). Do NOT delete original until moved copy verified. Update `apps/mcp-readonly-sql/README.md` install/run/test sections to use `pnpm --filter mcp-readonly-sql <script>` from repo root; publish MCP host `mcpServers` snippet with new `args` path AND `cwd` set to `apps/mcp-readonly-sql/` so SQLite `process.cwd()` and `.env` lookup stay correct.

## Phase 5: Behavior-First Verification

- [x] 5.1 `pnpm --filter mcp-readonly-sql typecheck/test/build/inspect` → pass (6 vitest files; `dist/index.js` exists; root `dist/` absent; 5 tools register, read-only preserved). `node apps/mcp-readonly-sql/dist/index.js` directly → stdio server starts without referencing repo root.
- [x] 5.2 Grep `apps/mcp-readonly-sql/src` for `../<other-app>/` imports → no matches. Assert: root `package.json` has no `bin`/`main`; no `dist/index.js`; `.atl/skill-registry.md` tracked; `.env` not staged; `data/*.sqlite*` not staged; `openspec` apply/verify from root resolve to one app via `--filter`.
- [x] 5.3 PR description includes one-line `mcpServers` `args` path patch (`<abs>/dist/index.js` → `<abs>/apps/mcp-readonly-sql/dist/index.js`).
