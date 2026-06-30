# Delta for app-independence

## MODIFIED Requirements

### Requirement: Transport Pluggability And Agent Authorization

Apps in this workspace MUST be transport-agnostic at the domain layer. A TypeScript app MUST be able to expose the same tool set over stdio AND Streamable HTTP by selecting transport via `MCP_TRANSPORT` env var, with the default being `stdio`. The HTTP wiring (listener, session management, health endpoint, graceful shutdown) MUST be delegated to a shared workspace package — `packages/mcp-http-base/` for TypeScript, or an equivalent for Python — so each app does not re-implement transport glue. The shared package MUST be an opt-in dependency; apps MUST still own their tool set, profile loader, `.env`, and wire entrypoint.

Apps that serve HTTP MUST also implement the per-agent authorization contract from `mcp-agent-authorization`: per-agent identity records, bearer token verification through the `TokenAuthority` interface, audit-safe error responses, and equal treatment of third-party agents. Apps MUST NOT implement scope-based authorization at the resource server: the resource server does not check `req.auth.scopes` to make an access decision, and any legacy `scopes` value on the request context is treated as decorative/legacy. Non-scope safety controls (sqlGuard, profile/database allowlists, body caps, host/proxy posture) remain the resource server's access boundary. Apps MUST NOT introduce a "trusted agent" code path that bypasses any of these requirements. Future MCPs in this workspace (TypeScript or Python) MUST adopt the same transport + authorization shape so the operational templates and runbook remain valid across the workspace.
(Previously: the contract required resource servers to implement scope-based authorization. Now: resource servers authenticate via `TokenAuthority` and apply non-scope safety controls; scope-based authorization is removed.)

#### Scenario: App adopts the shared base package

- GIVEN `apps/mcp-readonly-sql` depends on `@customized-mcps/mcp-http-base`
- WHEN the operator starts the app with `MCP_TRANSPORT=streamableHttp`
- THEN the HTTP transport, auth middleware, `/healthz`, and shutdown are provided by the shared package
- AND the app's own `src/transports/http.ts` is a thin call into the base
- AND the resource server does not check `req.auth.scopes` to make an access decision.

#### Scenario: Future Python app follows the same shape

- GIVEN a future `apps/mcp-write-audit` Python app
- WHEN the operator reads its `README.md` and the workspace's `mcp-http-transport` / `mcp-agent-authorization` specs
- THEN the Python app implements the same wire contract (path, methods, health, error codes)
- AND does not implement scope-based authorization at the resource server
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

Any future HTTP-served MCP app in this workspace (TypeScript or Python) MUST verify agent tokens through a `TokenAuthority` implementation supplied by the shared base package. For TypeScript apps, the package is `@customized-mcps/mcp-http-base`; for Python apps, it is the workspace-equivalent shared package. The app MUST NOT re-implement token verification, MUST NOT introduce its own HMAC/JWT compare path, and MUST NOT introduce a "trusted agent" code path that bypasses `TokenAuthority`. The backend selection rule (unset env = local; `MCP_AUTHORITY_URL` set = JWKS) and the audit-safe error mapping from `mcp-agent-authorization` and `mcp-token-authority` MUST apply to every future app unchanged. The app MUST NOT implement scope-based authorization at the resource server: the resource server authenticates the agent, applies non-scope safety controls, and exposes all tools subject to those controls. The `scopes` field on the request context is always `[]` and is never consulted for access.
(Previously: the contract explicitly required scope-based authorization at the resource server. Now: scope-based authorization is removed from the resource server contract; non-scope safety controls are the only authorization boundary beyond authentication.)

#### Scenario: Future TS app uses TokenAuthority and does not check scopes

- GIVEN a future TypeScript app under `apps/<ts-app>/`
- WHEN the operator starts the app with `MCP_TRANSPORT=streamableHttp`
- THEN the app's HTTP transport calls `authority.verify(token)` from the shared base
- AND no app-local `validateBearer` or JWT-compare function exists
- AND the app's tool handlers and middleware do not consult `req.auth.scopes` (which is always `[]`) to make an access decision.

#### Scenario: Future Python app uses TokenAuthority and does not check scopes

- GIVEN a future Python app under `apps/<py-app>/`
- WHEN the operator reads its `README.md` and source
- THEN the app delegates token verification to the Python-equivalent `TokenAuthority`
- AND no Python-local HMAC/JWT compare function exists in the app source
- AND the Python app does not implement scope-based authorization at the resource server.

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
