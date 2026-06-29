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

### Requirement: TokenAuthority Pluggability For Future HTTP Apps

Any future HTTP-served MCP app in this workspace (TypeScript or Python) MUST verify agent tokens through a `TokenAuthority` implementation supplied by the shared base package. For TypeScript apps, the package is `@customized-mcps/mcp-http-base`; for Python apps, it is the workspace-equivalent shared package. The app MUST NOT re-implement token verification, MUST NOT introduce its own HMAC/JWT compare path, and MUST NOT introduce a "trusted agent" code path that bypasses `TokenAuthority`. The backend selection rule (unset env = local; `MCP_AUTHORITY_URL` set = JWKS) and the audit-safe error mapping from `mcp-agent-authorization` and `mcp-token-authority` MUST apply to every future app unchanged.

#### Scenario: Future TS app uses TokenAuthority

- GIVEN a future TypeScript app under `apps/<ts-app>/`
- WHEN the operator starts the app with `MCP_TRANSPORT=streamableHttp`
- THEN the app's HTTP transport calls `authority.verify(token)` from the shared base
- AND no app-local `validateBearer` or JWT-compare function exists.

#### Scenario: Future Python app uses TokenAuthority

- GIVEN a future Python app under `apps/<py-app>/`
- WHEN the operator reads its `README.md` and source
- THEN the app delegates token verification to the Python-equivalent `TokenAuthority`
- AND no Python-local HMAC/JWT compare function exists in the app source.

#### Scenario: No trusted agent bypass

- GIVEN any future app in the workspace
- WHEN the operator greps its source for `trusted`, `internal`, `isLocal`, or similar flags that skip auth
- THEN no such bypass exists in the HTTP path.

#### Scenario: Backend selection matches the contract

- GIVEN a future app with `MCP_AUTHORITY_URL` unset
- WHEN the app starts
- THEN the local backend is selected
- AND `GET /healthz` reports `authorityBackend: "local"`.

- GIVEN the same app with `MCP_AUTHORITY_URL` set
- WHEN the app starts
- THEN the JWKS backend is selected
- AND `GET /healthz` reports `authorityBackend: "jwks"`.

### Requirement: Shared Base Package Is The Source Of Truth

The shared base package (`@customized-mcps/mcp-http-base` for TypeScript and the Python equivalent) MUST be the single source of truth for the `TokenAuthority` interface, the local and JWKS backend implementations, the typed error mapping, and the audit-safe error path. A future app MUST consume the package as an opt-in dependency and MUST NOT vendor a copy of the interface or the backends. A future app MAY add a custom backend that implements the interface (e.g., `IntrospectionAuthority`); the new backend MUST live in the shared package or in a dedicated workspace package, never in an app's own source tree.

#### Scenario: No vendored copy of TokenAuthority

- GIVEN any future app
- WHEN the operator greps its source for `TokenAuthority`, `JwksAuthority`, or `LocalRosterAuthority`
- THEN the references resolve to imports from the shared base package
- AND no vendored re-implementation exists in the app's own `src/`.

#### Scenario: Custom backend lives in the shared base

- GIVEN a future `IntrospectionAuthority` implementation (out of scope for this change)
- WHEN the operator reads its import path
- THEN the implementation lives in the shared base package (or a dedicated workspace package)
- AND it is exported from the shared base's public API.

### Requirement: Operational Templates Reuse The Contract

The deploy templates and runbook from `mcp-deployment-templates` MUST be applicable to any future HTTP-served MCP app with only the `ExecStart` / `ENTRYPOINT` / `proxy_pass` target changed. The `Choose your backend` section in `deploy/README.md` MUST describe the local vs JWKS choice using the same `authorityBackend` vocabulary and MUST point to `mcp-token-authority` for the resource-server contract.

#### Scenario: Deploy templates are reusable

- GIVEN the templates from `mcp-deployment-templates` and a future app
- WHEN the operator deploys the future app
- THEN the only changes are the app path, the port (per `mcp-http-transport` Port Allocation Convention), and the binary target
- AND no auth-related template change is required.

#### Scenario: Choose-your-backend section references mcp-token-authority

- GIVEN the app's `deploy/README.md`
- WHEN the operator reads the `Choose your backend` section
- THEN the section labels the local backend as `dev/offline only`
- AND labels the JWKS backend as `recommended for production and shared deployments`
- AND links to `mcp-token-authority` for the resource-server contract.

### Requirement: Authority Isolation

`apps/mcp-oauth-admin/` is a peer app, not a shared package. A resource-server app under `apps/<app-name>/` MUST NOT import from `apps/mcp-oauth-admin/src/`, MUST NOT add it as a workspace dependency, and MUST NOT symlink to it. The resource server MAY import from `@customized-mcps/mcp-http-base`; it MUST NOT import the authority's templates, UI, DB layer, or OAuth handlers directly. The authority MAY depend on shared packages; the resource server MUST NOT depend on the authority.

#### Scenario: No app-to-app import

- GIVEN any resource-server app under `apps/<app-name>/src/`
- WHEN the operator greps for imports referencing `apps/mcp-oauth-admin` or `mcp-oauth-admin/`
- THEN no matches exist.

#### Scenario: No workspace dependency on authority

- GIVEN any resource-server app's `package.json` (or `pyproject.toml`)
- WHEN the operator inspects the `dependencies` field
- THEN no entry references `mcp-oauth-admin` as a workspace package.

#### Scenario: No symlink to authority

- GIVEN any resource-server app's build artifact
- WHEN the operator inspects it for symlinks
- THEN no symlink points to `apps/mcp-oauth-admin/`.

#### Scenario: Authority may depend on shared base

- GIVEN `apps/mcp-oauth-admin/package.json`
- WHEN the operator inspects the `dependencies` field
- THEN shared packages like `@customized-mcps/mcp-http-base` MAY be listed
- AND no resource-server app is listed.

### Requirement: Per-App Deploy Templates Are Authoritative

The `mcp-deployment-templates` runbook MUST ship one per-app indexed section per MCP app, including the authority. A future resource-server app MUST get its own systemd unit, Dockerfile, and reverse-proxy snippet; the authority MUST get its own variants. Templates MUST NOT be shared across apps; the only shared element is the env-var vocabulary (the `.env.example` lint rule from `mcp-deployment-templates` still applies).

#### Scenario: Authority has its own systemd unit

- GIVEN `deploy/systemd/mcp-oauth-admin.service`
- WHEN the operator inspects the unit
- THEN `ExecStart` runs the authority's entrypoint
- AND `WorkingDirectory` points to `apps/mcp-oauth-admin/`
- AND `EnvironmentFile=/etc/mcp/mcp-oauth-admin.env`.

#### Scenario: Resource server has its own Dockerfile

- GIVEN `deploy/docker/Dockerfile.mcp-readonly-sql`
- WHEN the operator builds it
- THEN only the resource server's `dist/` is copied
- AND no copy step references `apps/mcp-oauth-admin/`.

#### Scenario: Runbook index lists every app

- GIVEN `deploy/README.md`
- WHEN the operator reads the TOC
- THEN each MCP app (resource servers and the authority) has its own anchored section.
