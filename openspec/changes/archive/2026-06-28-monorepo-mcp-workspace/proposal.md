# Proposal: Monorepo MCP Workspace

## Intent

User will author **MCPs in TypeScript and Python**. Repo is one TS package; each new MCP re-creates root config. Convert to a monorepo with each MCP as an independent app under `apps/`.

## Scope

### In Scope
- Root scaffold: `pnpm-workspace.yaml`, `package.json` `private: true`, `pyproject.toml` with `[tool.uv.workspace]`, `tsconfig.base.json`, `.gitignore`.
- Move `mcp-readonly-sql` → `apps/mcp-readonly-sql/`.
- Per-app commands: `pnpm --filter mcp-readonly-sql`, `uv --project apps/<py-app>`.
- Rewrite `openspec/config.yaml` `apply` / `verify` to per-app filter form.
- Package name stays `mcp-readonly-sql` (no `@db/` scope) — avoid deployment/import churn.

### Out of Scope
- New MCP implementations, Turborepo/Nx, CI/CD, Dockerfiles, internal registries, shared Python `sqlGuard`, folder rename, package rename.

## Capabilities

### New
- `monorepo-workspace` — pnpm + uv layout, `tsconfig.base.json` strict, root scripts via `--filter`, `.gitignore` extensions.
- `app-independence` — each app owns its `package.json`/`pyproject.toml`, `bin`/`[project.scripts]`, `src/`, `test/`, `.env.example`, build artifact, and wire entrypoint. No bundling, hoisting, linking, or cross-app paths.

### Modified
- `mcp-tool-surface` — launch path changes from `<repo>/dist/index.js` → `<repo>/apps/mcp-readonly-sql/dist/index.js`; tool set, wire format, and read-only safety contract are unchanged.

## Approach

**pnpm + uv workspaces, no orchestrator.** Apps deploy unchanged. OpenSpec stays top-level; per-app filters parameterize `apply.test_command` / `verify.*`. **No Turborepo / Nx** unless `sdd-design` finds a concrete blocker.

## Affected Areas

- Root: `package.json`, `pnpm-lock.yaml`, `tsconfig.json` change.
- New: `apps/mcp-readonly-sql/**`.
- Config: `openspec/config.yaml` switches to per-app filter form.
- Spec delta: `openspec/specs/mcp-tool-surface/` gets a launch-path delta.
- **Breaking** for MCP hosts: `mcpServers.args` path `<abs>/dist/index.js` → `<abs>/apps/mcp-readonly-sql/dist/index.js`.

## Risks

- **High:** MCP host configs break on new path — one-line `mcpServers` patch in PR description.
- **Medium:** `data/demo.sqlite` resolves vs `process.cwd()` — per-app `.env.example` documents path; deploy sets cwd to app dir.
- **Medium:** config commands run from wrong cwd — rewrite with `--filter` / `--project`; verify in `sdd-verify`.
- **Low:** per-app SDD cross-talk on shared OpenSpec rules — own change per rule.

## Rollback Plan

`git revert <merge-sha>`. Move `apps/mcp-readonly-sql/{src,test,*,data,dist}` back to root; restore root configs; `pnpm install && pnpm test && pnpm build`; re-wire MCP host; delete `apps/`, `pnpm-workspace.yaml`, root `pyproject.toml`, `tsconfig.base.json`. `data/` moves with the app — no data loss.

## Dependencies

pnpm `>=10.33.0` (declared), `uv` for Python (pin deferred to `sdd-design`), Node `>=20` (declared).

## Success Criteria

- [ ] `pnpm --filter mcp-readonly-sql test` passes; `build` produces `apps/mcp-readonly-sql/dist/index.js`; MCP Inspector confirms 5 tools register with read-only safety preserved.
- [ ] `apps/mcp-readonly-sql/` owns `package.json`, `tsconfig.json`, `.env.example`, `src/`, `test/`, and wire entrypoint in its README.
- [ ] Workspace root has `pnpm-workspace.yaml`, `package.json` (`private: true`), `pyproject.toml` with `[tool.uv.workspace]`, `tsconfig.base.json`.
- [ ] Config `apply.test_command` and `verify.*` use `pnpm --filter mcp-readonly-sql` (or `uv --project apps/<py-app>`) from root.
- [ ] PR description documents the one-line `mcpServers` path patch.
