# Delta for app-independence

## Purpose

Append a `TokenAuthority` pluggability requirement so any future HTTP-served MCP app (TypeScript or Python) adopts the same `TokenAuthority` abstraction defined in `mcp-token-authority`. The per-agent identity, token validation, scope enforcement, and audit-safe error contract continue to be defined in `mcp-agent-authorization`; the pluggability requirement makes that contract a hard dependency for new apps.

## ADDED Requirements

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

## MODIFIED Requirements

None.

## REMOVED Requirements

None.
