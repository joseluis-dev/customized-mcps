# Exploration: monorepo-mcp-workspace

> **Outcome-oriented.** Convert the current single-package `mcp-readonly-sql` repo
> into a monorepo that hosts multiple MCP servers (TypeScript and Python), where
> each MCP is an **independent, decoupled app** with its own install, test,
> build, and deployment surface. Today's TypeScript MCP becomes the first app
> under `apps/`.

## Quick path

1. The repo becomes a **pnpm workspace** (TypeScript side) + **uv workspace** (Python side), coordinated by a thin root.
2. The current TypeScript MCP is moved to `apps/mcp-readonly-sql/` with its own `package.json`, `tsconfig.json`, `src/`, `test/`, `.env`.
3. Each MCP under `apps/` ships as its own npm/PyPI-installable package and can be wired into an MCP host (Claude Desktop, Cursor, etc.) with a single `command` + `args` entry — the same wire format that works today.
4. Each app has its own test/build/deploy lifecycle. Workspace tooling only dedupes `node_modules` and pins versions; it does **not** couple apps.
5. **No build orchestrator** (Turborepo, Nx) is added in this change. It is a follow-up if/when caching becomes a bottleneck.

## Why now

The user will develop "a series of MCPs" in TypeScript and Python. Keeping each in its own repository forces duplicated config (`tsconfig.json`, `vitest.config.ts`, `openspec/`, `.env.example`, SDD config) and makes cross-cutting work (lint, format, secret rotation, OpenSpec rule updates) one-repo-at-a-time. A monorepo with isolated apps keeps the convenience of one repo while preserving the operational model of "one MCP = one shippable unit."

## Current state

`mcp-readonly-sql` is a single TypeScript 5.7 / ESM MCP server. Verified facts:

- **Repo layout** (everything lives at the root — no subdirs):
  - `package.json` — name `mcp-readonly-sql`, version `0.1.0`, bin `dist/index.js`, type `module`, packageManager `pnpm@10.33.0`.
  - `tsconfig.json` — `target: ES2022`, `module/moduleResolution: NodeNext`, `rootDir: src`, `outDir: dist`, `strict + noUncheckedIndexedAccess + noImplicitOverride`.
  - `src/` — 8 files across `config/`, `db/`, `security/`, `tools/`, plus `index.ts` (entrypoint over stdio) and `types.ts`.
  - `test/` — 6 vitest unit tests (`sqlGuard`, `profiles`, `profileAlias`, `secretRefs`, `describeSchema`, `sanitizeError`).
  - `dist/` — pre-built (`index.js`, `index.d.ts`, subdirs) — single deployable artifact.
  - `openspec/` — `config.yaml` + `specs/{profiles,mcp-tool-surface}/spec.md` + `changes/archive/2026-06-27-dynamic-profile-selection/`. One archived change.
  - `data/` — gitignored SQLite demo directory.
  - `.env` (real, gitignored) and `.env.example` (committed).
  - `.atl/skill-registry.md` and `.atl/.skill-registry.cache.json` — registry.
  - **No** `.github/`, `Dockerfile`, CI config, linter/formatter config, Python files.
  - **No** git remote (`git remote -v` is empty) — repo is local-only.
- **Hexagonal architecture**: `config → db → security → tools → index`. Each folder has a single responsibility. The boundaries are clean and migration-friendly (no cross-cutting `__init__` or singleton).
- **Runtime model**: stdio MCP server. `pnpm start` runs `node dist/index.js`; `pnpm dev` runs `tsx src/index.ts`. Logging goes to `stderr` (stdout is reserved for the MCP transport).
- **Distribution**: ESM-only, single `bin`. MCP clients wire it with `{ "command": "node", "args": [".../dist/index.js"] }`.
- **SDD posture**: hybrid mode, strict TDD, one verified & archived change (`dynamic-profile-selection`), vitest is the only test layer, no integration/E2E. OpenSpec paths in `openspec/config.yaml` assume app-relative globs (`test/**/*.test.ts`) — these are local to the app, not the root.

## Affected areas

These files / paths will move or change when the monorepo is scaffolded:

- `package.json` (root) — replaced with a workspace root (`pnpm-workspace.yaml`, root `package.json` with `private: true`).
- `pnpm-lock.yaml` — regenerated; `pnpm install` rewrites it for the workspace.
- `tsconfig.json` — replaced with `tsconfig.base.json` (root, shared strict flags) + per-app `tsconfig.json` extending it.
- `vitest.config.ts` — stays with the app, not the root.
- `src/**`, `test/**`, `dist/**`, `.env`, `.env.example`, `README.md` — move into `apps/mcp-readonly-sql/`.
- `data/` — relocate to `apps/mcp-readonly-sql/data/` (the SQLite filename is relative to `process.cwd()`, so the per-app `.env` should set `DB_<NAME>_FILENAME` relative to the app dir; this is the same constraint that exists today, just scoped to the app).
- `openspec/` — keep at root if SDD rules are cross-cutting; otherwise move per app (see "OpenSpec placement" below).
- `.atl/` — keep at root (skill registry is repo-wide, not per-app).
- `.gitignore` — extend to cover `**/node_modules`, `**/dist`, `**/.venv`, `**/data/*.sqlite*`, `coverage/`.
- `openspec/config.yaml` — `apply.test_command` and `verify.*` references must resolve to the active app. Either parameterize per change (recommended) or set them to root-level workspace commands that use `pnpm --filter`.

## Approach comparison

| # | Approach | Pros | Cons | Effort |
|---|----------|------|------|--------|
| 1 | **pnpm workspaces + uv workspaces, no orchestrator** — `pnpm-workspace.yaml` lists `apps/*` and `packages/*`; root `pyproject.toml` declares `[tool.uv.workspace]` with the same `apps/*` Python members. Each app is fully self-contained. | Fits the current pnpm-only stack; lowest possible complexity; each app's deploy story is unchanged (`node dist/index.js` or `uvx mcp-foo`); well-understood tools; easy CI later (`pnpm --filter @db/<app> test`). | No caching layer (acceptable at small scale); no parallel test runner (vitest already parallelizes within an app); Python and TS workspaces are independent and coordinated by humans/shell scripts. | **Low** (one PR, phased). |
| 2 | **pnpm workspaces + Turborepo + uv** — same as #1, plus `turbo.json` defining `build`/`test`/`lint` pipelines with caching. | Caches `tsc`/`vitest` outputs across runs; remote cache when CI is added; clear DAG. | New tool to learn; extra config; cache invalidation can be confusing at first; meaningful only when 3+ apps or slow builds. | **Medium** (one PR plus docs). |
| 3 | **pnpm workspaces + Nx + uv** — same as #1, plus Nx generators for new apps, dependency graph, affected commands. | Strong dependency graph, `nx affected` for PRs, generators. | Heavier than Turborepo; opinionated; biggest blast radius; not justified for 2–5 MCPs. | **High**. |
| 4 | **No workspaces — just `apps/*` folders, each with its own `package.json` / `pyproject.toml`, no hoisting** | Smallest possible workspace concept; each app is a fully self-contained repo-in-a-folder. | No `node_modules` dedup, no version pinning across apps, slower `pnpm install` per app, no `pnpm --filter` convenience. | **Low–Medium** (no gain over #1 for this scale). |
| 5 | **No monorepo — keep one repo per MCP, factor shared code into a `git submodule` / versioned package** | Maximum isolation, no tool complexity. | Loses the user's stated goal of a single workspace; shared code version drift across repos; more CI/CD overhead. | **High** in setup, **High** in maintenance. |

### Recommended: Approach 1 — pnpm + uv workspaces, no orchestrator

Rationale:

- **Independent apps preserved.** Every app has its own `package.json` / `pyproject.toml`, its own `bin`, its own `.env`, its own test suite, its own `dist/` or wheel. Workspace tools never bundle or link apps for deployment.
- **Matches the existing toolchain.** pnpm 10.33 is already declared; uv is the modern Python tool (`uv` handles virtualenvs, `pyproject.toml` PEP 621, `uv tool install` / `uvx` for shippable stdio MCPs).
- **YAGNI for an orchestrator.** With 1 app today and likely 3–6 within a year, Turborepo / Nx would add config without measurable benefit. The caching story matters once `pnpm test` becomes slow — and per-app vitest already parallelizes.
- **Honors the user's decoupling constraint.** Each MCP's "deploy" is its current shape: `node dist/index.js` for TS, `uvx <package>` for Python. Workspace membership does not couple the runtime.

### Target layout (sketch)

```text
db/                                  <- workspace root (engram project key stays "db")
  pnpm-workspace.yaml                <- packages: ["apps/*", "packages/*"]
  pyproject.toml                     <- [project], [tool.uv.workspace] members = ["apps/*"]
  package.json                       <- private: true, scripts delegate via --filter
  tsconfig.base.json                 <- shared strict flags
  .gitignore                         <- **/node_modules, **/dist, **/.venv, **/data/*.sqlite*, coverage/
  README.md                          <- workspace overview + per-app links
  .atl/                              <- skill registry (unchanged)
  apps/
    mcp-readonly-sql/                <- current TypeScript MCP, moved here
      package.json                   <- name: @db/mcp-readonly-sql (or unscoped)
      tsconfig.json                  <- extends ../../tsconfig.base.json
      vitest.config.ts
      src/                           <- moved verbatim
      test/                          <- moved verbatim
      .env                           <- moved (gitignored, as today)
      .env.example                   <- moved
      README.md                      <- moved (or replace with a pointer to the app README)
      data/                          <- moved (gitignored, holds SQLite demo)
    mcp-foo/                         <- future TS MCP (sketch only)
      package.json
      tsconfig.json
      src/
      test/
    mcp-bar/                         <- future Python MCP (sketch only)
      pyproject.toml                 <- [project], [project.scripts] mcp-bar = "mcp_bar.server:main"
      src/mcp_bar/server.py          <- FastMCP / mcp stdio entrypoint
      tests/
      README.md
  packages/                          <- optional shared libraries (only if needed)
  openspec/                          <- top-level (see "OpenSpec placement")
```

### OpenSpec placement (decision needed at proposal time)

Two reasonable options. Both preserve per-app independence:

- **Top-level `openspec/`** (recommended for now). One `config.yaml` with cross-cutting rules; specs live under `openspec/specs/` keyed by domain (e.g. `profiles`, `mcp-tool-surface`, future `python-mcp-surface`); changes are still per-app. The `apply.test_command` and `verify.*` are parameterized per change (e.g. `pnpm --filter @db/mcp-readonly-sql test` or `uv --project apps/mcp-bar run pytest`).
- **Per-app `openspec/`** under each app folder. Cleaner for the long term when MCPs diverge in tooling and rules, but creates a new problem: cross-cutting changes (e.g. shared lint policy) lose a single home.

### Independent-deployment contract (to be enforced by specs)

Each app under `apps/` MUST satisfy:

- Own `package.json` (TS) or `pyproject.toml` (Python) with a unique name and a `bin`/`[project.scripts]` entry.
- Own `src/` (and optionally `test/`) directory — no path traversal into sibling apps.
- Own `.env.example` documenting every env var the app reads.
- Own build artifact (`dist/` for TS, wheel for Python) produced by a single command from the app dir (`pnpm build` / `uv build`).
- Own test command runnable from the app dir without touching siblings (`pnpm test` / `uv run pytest`).
- Own MCP wire entrypoint: `node <abs>/apps/<ts-app>/dist/index.js` or `uvx <py-app>`, suitable for an MCP host `mcpServers` config block.

The workspace root MUST NOT define a single shared bin, must NOT bundle apps, and MUST NOT make the monorepo installable as one package.

### Migration path (concrete steps for the proposal)

1. **Scaffold root**: create `pnpm-workspace.yaml`, root `package.json` (`private: true`, `"name": "@db/workspace"`), root `pyproject.toml` (with `[tool.uv.workspace]`), `tsconfig.base.json`, extend `.gitignore`. No app code moves yet.
2. **Move `mcp-readonly-sql`**: relocate `src/`, `test/`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env`, `.env.example`, `README.md`, `data/` into `apps/mcp-readonly-sql/`. Update the moved `tsconfig.json` to extend `../../tsconfig.base.json`. Adjust `package.json` name (recommend `@db/mcp-readonly-sql`) and `bin` path (still `dist/index.js`, relative to the new app dir).
3. **Verify parity**: `pnpm install` at root, `pnpm --filter @db/mcp-readonly-sql test`, `pnpm --filter @db/mcp-readonly-sql build`, `pnpm --filter @db/mcp-readonly-sql start`. Launch the MCP inspector (`pnpm --filter @db/mcp-readonly-sql inspect`) and confirm the five tools still register.
4. **Update OpenSpec**: rewrite `openspec/config.yaml` `apply` / `verify` blocks to use per-app filter commands; add a rule that each new app must declare its own filter.
5. **Update docs**: workspace `README.md` lists the apps and links to each app's README; the per-app `README.md` retains its current content (now under `apps/mcp-readonly-sql/README.md`).
6. **No commits in this exploration phase** (exploration does not change code). The proposal phase owns the staged PR strategy; the `sdd-tasks` phase will forecast whether the move fits the 800-line review budget (likely: yes for the move itself, since it is mostly file relocation + small config edits; yes for new apps, as separate changes).

### Out of scope (defer to follow-up changes)

- A new `mcp-foo` or `mcp-bar` implementation. The user has not asked for one yet.
- A shared Python package that ports `sqlGuard` / `sanitizeError`. Useful if a Python MCP also needs SQL read-only enforcement; not justified until then.
- Turborepo / Nx. Add when caching becomes a real cost.
- CI/CD pipelines. None exist today; the monorepo does not require them, but they become more valuable per app once added.
- Containerization (Dockerfiles, compose). The MCP wire is stdio, not HTTP; per-app containers are a deployment concern, not a repo-structure concern.
- Internal npm/PyPI registry. Apps can be installed directly from the repo for now; private registry is a release-engineering decision.
- Renaming the workspace folder from `db` to something like `mcp-workspace`. The user did not ask. The engram project key stays `db` for continuity regardless of folder name.

## Risks

- **Path-relative SQLite resolution today**: `data/demo.sqlite` is resolved against `process.cwd()`. When the app moves under `apps/mcp-readonly-sql/`, the documented behavior is preserved only if `.env` (and any deployment instructions) keep the file at `<app>/data/demo.sqlite`. Mitigation: per-app `.env.example` documents the relative path; deployment README shows how to set the cwd to the app dir before launching.
- **OpenSpec rules vs. monorepo paths**: today's `openspec/config.yaml` references `test/**/*.test.ts` (app-relative). When specs move to a per-app convention, the rule must be re-anchored. Mitigation: keep the OpenSpec config at the workspace root and use `apply.test_command: pnpm --filter @db/<app> test`; the per-app filter resolves the correct glob.
- **`dist/` artifact paths in the MCP client config**: existing clients wire `node <abs>/dist/index.js`. After the move, the path is `<abs>/apps/mcp-readonly-sql/dist/index.js`. This is a breaking change for any currently-wired client (Claude Desktop, Cursor, etc.). Mitigation: surface this clearly in the PR description; provide a one-line path update for the user.
- **`.env` migration**: the live `.env` (gitignored) contains real secrets. The move is `git mv` / file system move, not a copy — but the user must update the path on disk. Mitigation: step-by-step migration in the proposal; do not change `.env` content.
- **Per-app SDD cross-talk**: if two apps need a change in `openspec/config.yaml` (e.g. a new shared rule), their changes race. Mitigation: treat `openspec/config.yaml` rule changes as their own change in a single PR; per-app specs and per-app code live in separate changes.
- **Renaming the package to `@db/mcp-readonly-sql`**: scoped names are friendlier for a workspace but break any tooling that imports the package by its old name. Mitigation: keep the unscoped name `mcp-readonly-sql` if external import paths exist; otherwise move to a scoped name in the same PR. The README and the MCP client config use the bin path, not the package name, so the user-facing impact is limited.
- **Workspace root `package.json` scripts**: a generic `pnpm test` at the root must be defined (e.g. `pnpm -r test`) to be useful, otherwise it does nothing. Mitigation: define root scripts that delegate (`"test": "pnpm -r test"`, `"build": "pnpm -r build"`, `"lint": "pnpm -r lint"`); keep them optional.
- **`data/` directory inside an app**: putting `data/` under the app means the app owns its runtime data; some deployment models want data at a fixed absolute path. Mitigation: per-app `.env` is the right home for `DB_<NAME>_FILENAME`; the existing `${secret:file:...}` machinery already supports any absolute path.
- **No git remote**: there is no upstream to push a PR to, so the entire migration is local until the user adds a remote. The SDD preflight `auto-forecast` PR strategy will need to be re-evaluated once a remote exists.

## Open questions (for the proposal, not blockers)

- **Workspace folder name**: keep `db` (current folder, current engram key), or rename to `mcp-workspace` / similar? The user did not say. Recommend keeping the folder name and the engram key as-is to minimize churn.
- **Python tool pin**: `uv` is the proposed choice; if the user prefers Poetry or `pyenv` + `pip`, the workspace design still works but the root `pyproject.toml` changes shape. Recommend `uv` (modern, fast, supports PEP 621 and workspace layouts).
- **OpenSpec placement**: top-level (recommended) vs per-app. The exploration recommends top-level for the current scale.

## Ready for proposal

**Yes.** The exploration answers the core question (pnpm + uv workspaces, no orchestrator, apps under `apps/`, per-app independence contract) and identifies the minimal migration path: scaffold root, move `mcp-readonly-sql` into `apps/mcp-readonly-sql/`, update OpenSpec commands to use `pnpm --filter`, update docs. No application code logic changes are required for the move itself. Each app remains an independent, decoupled deployable.

The next phase is `sdd-propose` (intents, scope, approach, rollback plan). After that: `sdd-spec` for the workspace + per-app independence contract + OpenSpec path contract, then `sdd-design` (root config, per-app config, OpenSpec integration, Python app entrypoint pattern), then `sdd-tasks` (scaffold → move → verify → docs).
