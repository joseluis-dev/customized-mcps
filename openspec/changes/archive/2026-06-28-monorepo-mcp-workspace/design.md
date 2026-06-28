# Design: Monorepo MCP Workspace

## Technical Approach

Convert the repo root into a non-deployable workspace and move the existing TypeScript MCP unchanged into `apps/mcp-readonly-sql/`. Root tooling delegates to one app via pnpm filters; future Python MCPs use `uv --project apps/<py-app>`. OpenSpec remains at the root and is rewritten to call app-scoped commands. Application source logic is moved, not edited.

## Architecture Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Workspace tools | pnpm workspace + uv workspace, no Turborepo/Nx | Turborepo/Nx, no workspace | Matches current pnpm stack, supports TS/Python, and avoids orchestration scope. Context7 confirms pnpm workspaces use `pnpm-workspace.yaml` packages and `--filter`; uv supports workspace members and `--project`. |
| Package identity | Keep app package name `mcp-readonly-sql` | Rename to `@db/mcp-readonly-sql` | Avoids package/bin churn and satisfies proposal. |
| TypeScript config | Root `tsconfig.base.json`; app config extends it | Keep root `tsconfig.json`; duplicate configs | TypeScript supports `extends`; base holds shared NodeNext strict flags while app owns `rootDir`/`outDir`. |
| Runtime cwd | App owns `.env`, `.env.example`, `data/`; SQLite relative paths resolve from app cwd | Change source path resolution | Existing `profiles.ts` resolves SQLite paths from `process.cwd()`. To avoid source changes, docs require running from `apps/mcp-readonly-sql/` or setting MCP host cwd there for SQLite. |

## Data Flow

```text
repo root command
  ├─ pnpm --filter mcp-readonly-sql <script>
  │    └─ apps/mcp-readonly-sql/{src,test,dist,.env.example,data}
  └─ uv --project apps/<py-app> run <tool>  (future Python apps)

MCP host ── node <abs>/apps/mcp-readonly-sql/dist/index.js ── stdio tools
```

## File Changes

| File | Action | Description |
|---|---|---|
| `pnpm-workspace.yaml` | Create | `packages: ["apps/*"]`. |
| `package.json` | Modify | Root workspace only: `name: "db-workspace"`, `private: true`, `packageManager: "pnpm@10.33.0"`, no `bin`/`main`; scripts delegate: `test/build/typecheck/inspect` use `pnpm --filter mcp-readonly-sql ...`; keep pnpm built dependency allowlist for `esbuild` and `sqlite3`. |
| `pyproject.toml` | Create | Root uv scaffold: `[project] name="db-workspace"`, `version="0.0.0"`, `requires-python=">=3.12"`, `dependencies=[]`; `[tool.uv.workspace] members=[]` until a Python app is added. |
| `tsconfig.base.json` | Create | Existing shared compiler options: ES2022, NodeNext, strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, declarations, source maps; no `rootDir`/`outDir`. |
| `apps/mcp-readonly-sql/package.json` | Create from root | Preserve `name: "mcp-readonly-sql"`, `type`, `bin`, `main`, dependencies/devDependencies, scripts; add `typecheck: "tsc -p tsconfig.json --noEmit"`. |
| `apps/mcp-readonly-sql/tsconfig.json` | Create from root | `extends: "../../tsconfig.base.json"`; app-only `rootDir: "src"`, `outDir: "dist"`, `include: ["src/**/*"]`. |
| `apps/mcp-readonly-sql/vitest.config.ts` | Move | Keep `include: ["test/**/*.test.ts"]` because pnpm runs scripts in the app package cwd. |
| `src/`, `test/`, `dist/`, `.env.example`, `data/`, app `README.md` | Move | Move under `apps/mcp-readonly-sql/`; `.env` is untracked and must be moved manually, not committed. |
| `README.md` | Modify | Become workspace overview; link to app README; document breaking host path. |
| `.gitignore` | Modify | Use recursive patterns: `**/node_modules`, `**/dist`, `.env`, `.env.local`, `**/.venv`, `**/__pycache__`, `**/data/*.sqlite*`, `coverage/`. |
| `openspec/config.yaml` | Modify | Rewrite app commands: `apply.settings.test_command: pnpm --filter mcp-readonly-sql test`, `build_command: pnpm --filter mcp-readonly-sql build`; `verify.settings.test_command/build_command/typecheck_command` use `pnpm --filter mcp-readonly-sql test/build/typecheck`; testing runner commands match. |

## Interfaces / Contracts

- Root is not deployable: no root `bin`, `main`, `dist/index.js`, or bundled app artifact.
- MCP host entrypoint changes to `<repo>/apps/mcp-readonly-sql/dist/index.js`; tools and JSON-RPC behavior stay unchanged.
- Future Python apps add their own `apps/<py-app>/pyproject.toml` with `[project.scripts]` and are invoked with `uv --project apps/<py-app> run <script>`.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | Existing SQL guard, profiles, aliases, secrets, schema behavior | `pnpm --filter mcp-readonly-sql test`. |
| Build/typecheck | App-local NodeNext output and declarations | `pnpm --filter mcp-readonly-sql build` and `typecheck`. |
| Smoke | New MCP path and tool registration | `pnpm --filter mcp-readonly-sql inspect`; confirm 5 tools. |
| Structure | No root deployable artifact or cross-app imports | Check no root `dist/index.js`; grep for sibling app imports. |

## Migration / Rollout

Run as one migration PR if line budget allows: scaffold root, move app files, install to refresh lockfile, update docs/OpenSpec, verify. Rollback is `git revert`; manually move untracked `.env` back if already relocated. MCP hosts must update `args` from `<repo>/dist/index.js` to `<repo>/apps/mcp-readonly-sql/dist/index.js`.

## Open Questions

None.
