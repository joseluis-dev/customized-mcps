# monorepo-workspace Specification

## Purpose

Workspace-root contract for hosting multiple MCP apps (TypeScript and Python). The root is a non-deployable scaffold; apps are the deployable units.

## Requirements

### Requirement: Workspace Root Scaffold

The repository root MUST contain `pnpm-workspace.yaml`, a root `package.json` with `"private": true` and no `"bin"`, a root `pyproject.toml` declaring `[tool.uv.workspace]`, a `tsconfig.base.json` with strict TypeScript flags (`noUncheckedIndexedAccess`, `noImplicitOverride`), and a root `.gitignore` excluding `**/node_modules`, `**/dist`, `**/.venv`, `**/__pycache__`.

#### Scenario: Root scaffold present

- GIVEN a fresh clone of the repository
- WHEN the operator inspects the root directory
- THEN `pnpm-workspace.yaml`, root `package.json` (`"private": true`), root `pyproject.toml` (`[tool.uv.workspace]`), `tsconfig.base.json`, and `.gitignore` are all present.

#### Scenario: Root has no deployable entrypoint

- GIVEN the root scaffold
- WHEN the operator searches for executable entrypoints
- THEN root `package.json` declares no `"bin"` field
- AND no `dist/index.js` exists at the repo root.

### Requirement: Per-App Command Surface

Root-level scripts MUST target a single app by name using `pnpm --filter <app-name>` (TypeScript) or `uv --project apps/<app-name>` (Python). Filters MUST be invokable from the repo root without changing directory.

#### Scenario: TypeScript app filtered from root

- GIVEN the workspace
- WHEN the operator runs `pnpm --filter mcp-readonly-sql test` from the repo root
- THEN the command executes inside `apps/mcp-readonly-sql/`.

#### Scenario: Python app filtered from root

- GIVEN the workspace
- WHEN the operator runs `uv --project apps/<py-app> run <tool>` from the repo root
- THEN the command executes inside `apps/<py-app>/`.

### Requirement: OpenSpec Per-App Filters

`openspec/config.yaml` `apply.test_command`, `apply.build_command`, and `verify.*` commands MUST be expressed as per-app filters (`pnpm --filter <app-name> ...` or `uv --project apps/<app-name> ...`) runnable from the repo root. No command MAY resolve to "the whole repo".

#### Scenario: Apply step targets one app

- GIVEN the change folder for an active change
- WHEN the apply step runs `apply.test_command`
- THEN the command targets one app via `--filter` or `--project`.

#### Scenario: Verify step targets one app

- GIVEN `verify.test_command`, `verify.build_command`, `verify.typecheck_command`
- WHEN the verify step runs them
- THEN each targets one app via `--filter` or `--project`
- AND none resolves to the repository root as the app.

### Requirement: Workspace Root Is Not Deployable

The repo root MUST NOT bundle apps into one deployable artifact. No root `dist/`, `build/`, or `bundle/` is produced for distribution. Each app's build artifact lives inside its own `apps/<app-name>/` directory.

#### Scenario: No root combined artifact

- GIVEN `pnpm --filter mcp-readonly-sql build` has run
- WHEN the operator inspects the repo root
- THEN no root `dist/`, `build/`, or `bundle/` directory contains app code.

#### Scenario: App owns its build artifact

- GIVEN the same build
- WHEN the operator inspects `apps/mcp-readonly-sql/`
- THEN `dist/index.js` exists inside that app directory.

### Requirement: Source Layout Boundary

After migration, all MCP source and tests MUST live under `apps/<app-name>/src` and `apps/<app-name>/test`. Cross-app relative imports (e.g. `../other-app/src/...`) MUST NOT exist.

#### Scenario: Apps own their source tree

- GIVEN the workspace after migration
- WHEN the operator lists `apps/mcp-readonly-sql/`
- THEN it contains `src/`, `test/`, `package.json`, `tsconfig.json`, `.env.example`.

#### Scenario: No cross-app relative imports

- GIVEN any app source file
- WHEN the operator greps for relative imports that cross app boundaries
- THEN no matches exist.
