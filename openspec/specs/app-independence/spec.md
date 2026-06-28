# app-independence Specification

## Purpose

Contract that makes each MCP app in the workspace a self-contained, independently deployable unit. Apps do not share source, build, or runtime code through the workspace.

## Requirements

### Requirement: App Self-Containment

Each app under `apps/<app-name>/` MUST own its manifest (`package.json` for TypeScript, `pyproject.toml` for Python), its own `src/`, `test/`, `.env.example`, and its own build artifact. The app MUST be installable, testable, and buildable using only its own files plus declared dependencies.

#### Scenario: TypeScript app owns its files

- GIVEN `apps/mcp-readonly-sql/`
- WHEN the operator inspects the directory
- THEN it contains `package.json`, `tsconfig.json`, `src/`, `test/`, `.env.example`, and `dist/` after build.

#### Scenario: Python app owns its files

- GIVEN `apps/<py-app>/`
- WHEN the operator inspects the directory
- THEN it contains `pyproject.toml` with a `[project.scripts]` entry pointing at the wire entrypoint, `src/`, `test/`, and `.env.example`.

### Requirement: Independent Install, Test, Build

An app MUST install, test, and build successfully when the workspace filter targets that app alone. A broken sibling app MUST NOT affect this app's pipeline.

#### Scenario: Filtered install succeeds in isolation

- GIVEN a workspace with one TypeScript and one Python app
- WHEN the operator runs `pnpm --filter mcp-readonly-sql install`
- THEN only `mcp-readonly-sql` is installed
- AND the Python app's environment is not required.

#### Scenario: Sibling failure does not break app build

- GIVEN a workspace where the Python app is intentionally broken
- WHEN the operator runs `pnpm --filter mcp-readonly-sql build`
- THEN the TypeScript app build succeeds
- AND no error references the Python app.

### Requirement: Independent Deployability

Each app MUST be launchable as a standalone MCP server using only the files inside its own directory plus resolved dependencies. Launching an app MUST NOT require code from sibling apps or workspace-root scripts.

#### Scenario: TypeScript app launches from its own directory

- GIVEN `apps/mcp-readonly-sql/dist/index.js` exists
- WHEN the MCP host runs `<abs>/apps/mcp-readonly-sql/dist/index.js` over stdio
- THEN the server starts and registers its 5 tools
- AND no file from the repository root is required at runtime.

#### Scenario: Python app launches from its own directory

- GIVEN `apps/<py-app>` is built and installed
- WHEN the MCP host runs the `[project.scripts]` entrypoint
- THEN the server starts and registers its tools
- AND no `cd` to the repository root is required.

### Requirement: No Cross-App Code Paths

Apps MUST NOT import from, depend on, or symlink to another app's source, build, or test code. The MCP host entrypoint of one app MUST NOT be re-exported by another app.

#### Scenario: No cross-app source imports

- GIVEN any file inside `apps/mcp-readonly-sql/src/`
- WHEN the operator greps for imports referencing a sibling app
- THEN no matches exist.

#### Scenario: No shared runtime symlinks

- GIVEN the workspace
- WHEN the operator inspects each app's build artifact
- THEN no symlink points to a sibling app's source or build directory.

### Requirement: Transport Pluggability And Agent Authorization

Apps in this workspace MUST be transport-agnostic at the domain layer. A TypeScript app MUST be able to expose the same tool set over stdio AND Streamable HTTP by selecting transport via `MCP_TRANSPORT` env var, with the default being `stdio`. The HTTP wiring (listener, session management, health endpoint, graceful shutdown) MUST be delegated to a shared workspace package — `packages/mcp-http-base/` for TypeScript, or an equivalent for Python — so each app does not re-implement transport glue. The shared package MUST be an opt-in dependency; apps MUST still own their tool set, profile loader, `.env`, and wire entrypoint.

Apps that serve HTTP MUST also implement the per-agent authorization contract from `mcp-agent-authorization`: per-agent identity records, opaque HMAC-signed bearer tokens, scope-based authorization, audit-safe error responses, and equal treatment of third-party agents. Apps MUST NOT introduce a "trusted agent" code path that bypasses any of these requirements. Future MCPs in this workspace (TypeScript or Python) MUST adopt the same transport + authorization shape so the operational templates and runbook remain valid across the workspace.

#### Scenario: App adopts the shared base package

- GIVEN `apps/mcp-readonly-sql` depends on `@customized-mcps/mcp-http-base`
- WHEN the operator starts the app with `MCP_TRANSPORT=streamableHttp`
- THEN the HTTP transport, auth middleware, `/healthz`, and shutdown are provided by the shared package
- AND the app's own `src/transports/http.ts` is a thin call into the base.

#### Scenario: Future Python app follows the same shape

- GIVEN a future `apps/mcp-write-audit` Python app
- WHEN the operator reads its `README.md` and the workspace's `mcp-http-transport` / `mcp-agent-authorization` specs
- THEN the Python app implements the same wire contract (path, methods, health, error codes, scopes)
- AND the systemd / Docker / reverse-proxy templates from `mcp-deployment-templates` are applicable with only the `ExecStart` / `ENTRYPOINT` / `proxy_pass` target changed.

#### Scenario: No "trusted agent" bypass

- GIVEN any app in the workspace
- WHEN the operator greps its source for `trusted`, `internal`, or `isLocal` flags that skip auth
- THEN no such bypass exists in the HTTP path.

#### Scenario: App still owns its entrypoint

- GIVEN any app adopting the shared base
- WHEN the operator inspects the app's `src/` (or `src/<app>/`)
- THEN the wire entrypoint (the file pointed at by the bin / `[project.scripts]`) lives inside the app's own directory
- AND no entrypoint is re-exported by the shared package.
