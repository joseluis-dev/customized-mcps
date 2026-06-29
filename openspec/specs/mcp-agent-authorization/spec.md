# mcp-agent-authorization Specification

## Purpose

Defines the per-agent identity, token validation, and scope enforcement that every HTTP-served MCP in this workspace MUST apply. Authorization runs in middleware before the request reaches the MCP transport, so unauthorized traffic never reaches a tool handler. Stdio traffic is unaffected.

## Requirements

### Requirement: Per-Agent Identity Records

The app MUST load per-agent identity through the selected `TokenAuthority`. When the local backend is selected, the source is `MCP_AGENTS_JSON` (path to a JSON file) or `MCP_AGENTS_INLINE` (raw JSON string in env). When `MCP_AGENTS_JSON` is set, it wins over `MCP_AGENTS_INLINE`. Each local record MUST include `id` (stable string, opaque to the agent), `keyHash` (server-side HMAC of the agent's bearer token, hex-encoded), and `scopes` (array of strings matching `SCOPE_PATTERN`). The plaintext bearer token MUST never be persisted on the server; only its HMAC is stored. The format MUST support third-party agents as ordinary records (no special "first-party" class). When the JWKS backend is selected, the identity record is the JWT subject and the `scopes` claim, both delivered by the authority.

#### Scenario: Third-party agent onboards on local backend

- GIVEN an operator adds a record `{ "id": "third-party-x", "keyHash": "<hmac-of-token>", "scopes": ["read:bi_catastro"] }` to `MCP_AGENTS_JSON`
- WHEN `third-party-x` sends a request with a valid bearer token
- THEN the request is accepted by `LocalRosterAuthority`
- AND the request is denied only on the rules that apply to that agent's scopes.

#### Scenario: Third-party agent onboards on JWKS backend

- GIVEN a third-party agent registered at the authority with `agentId=third-party-x` and `scopes=["read:bi_catastro"]`
- WHEN the agent sends a JWT with `sub=third-party-x`
- THEN `JwksAuthority.verify` returns `{ agentId: "third-party-x", scopes: ["read:bi_catastro"] }`
- AND no `.agents.local.json` is required.

#### Scenario: Missing agent config fails closed on local backend

- GIVEN no `MCP_AGENTS_JSON`, no `MCP_AGENTS_INLINE`, and no `MCP_AUTHORITY_URL`
- WHEN the app starts in HTTP mode
- THEN the process exits non-zero
- AND stderr explains that at least one agent or `MCP_AUTHORITY_URL` must be configured.

#### Scenario: Malformed agent config fails closed on local backend

- GIVEN `MCP_AGENTS_JSON` whose contents are not valid JSON
- WHEN the app starts in HTTP mode
- THEN the process exits non-zero
- AND stderr names the offending file.

### Requirement: Per-Record Validation At Startup

The app MUST validate each agent record's `keyHash` and `scopes` at startup and refuse to start (exit non-zero with a stderr message naming the offending record) if either is malformed. `keyHash` MUST be exactly 64 lowercase or uppercase hex characters (the SHA-256 hex digest of the agent's bearer token under the server's HMAC secret). `scopes` MUST each match the grammar `<verb>:<resource>` where `<verb>` is one of `read`, `list`, `call` and `<resource>` is either `*` or an identifier made of `[A-Za-z0-9_.-]+`. v1 does not wildcard verbs; only resources.

#### Scenario: Malformed keyHash fails closed

- GIVEN an agent record whose `keyHash` is not 64 hex characters (too short, too long, or contains non-hex characters)
- WHEN the app starts in HTTP mode
- THEN the process exits non-zero
- AND stderr names the offending record index and explains the format.

#### Scenario: Malformed scope fails closed

- GIVEN an agent record whose `scopes` include a value that is not `<read|list|call>:<resource>` (e.g. `delete:foo`, `readfoo`, `read:`, `:foo`)
- WHEN the app starts in HTTP mode
- THEN the process exits non-zero
- AND stderr names the offending record and the offending scope.

### Requirement: Bearer Token Validation

Clients MUST present credentials as `Authorization: Bearer <token>` on every request. The middleware MUST verify the token by calling `authority.verify(token)`. On the local backend, verification is `HMAC(secret, token) === keyHash` in constant time; on the JWKS backend, verification is signature-based against the authority's JWKS with `iss`/`aud`/`exp`/`nbf` checks (defined in `mcp-token-authority`). The HMAC secret for the local backend MUST be loaded from `MCP_AGENT_HMAC_SECRET` and MUST be at least 32 bytes of entropy. A missing or short secret MUST cause the process to exit non-zero at startup. The middleware MUST run before `transport.handleRequest` so unauthorized requests never reach the MCP transport.

#### Scenario: Valid token accepted (local backend)

- GIVEN a request with a bearer token whose HMAC matches an agent's `keyHash`
- WHEN the local backend verifies it
- THEN the request is forwarded to the MCP transport
- AND the agent's scopes are attached to the request context.

#### Scenario: Valid JWT accepted (JWKS backend)

- GIVEN a JWT signed by the authority with valid `iss`, `aud`, and `exp`
- WHEN the JWKS backend verifies it
- THEN the request is forwarded to the MCP transport
- AND the JWT subject and `scopes` claim are attached to the request context.

#### Scenario: Missing header rejected with 401

- GIVEN a request with no `Authorization` header
- WHEN the middleware validates it
- THEN the response status is `401`
- AND the body is a JSON-RPC error with a sanitized message (no token, no agent id).

#### Scenario: Invalid token rejected with 401

- GIVEN a request with a malformed or mismatched bearer token
- WHEN the middleware validates it
- THEN the response status is `401`
- AND the body does not include the supplied token value.

#### Scenario: Authority unreachable returns 503

- GIVEN the JWKS backend and the authority unreachable
- WHEN the middleware validates it
- THEN the response status is `503`
- AND the body is a sanitized `service unavailable` error.

#### Scenario: Constant-time comparison on local backend

- GIVEN the local backend's validation code path
- WHEN an operator inspects the implementation
- THEN the comparison uses `crypto.timingSafeEqual` (or equivalent)
- AND never short-circuits on the first byte.

### Requirement: Scope-Based Authorization

Each scope string MUST be of the form `<verb>:<resource>`, where `<verb>` is one of `read`, `list`, `call`, and `<resource>` is either a profile alias or the wildcard `*`. An agent MUST hold a scope that matches the resource for the call to proceed. The server-side profile allowlist (from `mcp-tool-surface`) and the read-only safety contract (`sqlGuard`) ALWAYS win over scopes; an agent with the right scope MUST still be blocked by a database allowlist mismatch or a non-read SQL keyword.

#### Scenario: Read scope on a known profile

- GIVEN an agent with scopes `["read:bi_catastro"]`
- WHEN the agent calls `execute_read_query` against `bi_catastro`
- THEN the tool runs.

#### Scenario: Insufficient scope returns 403

- GIVEN an agent with scopes `["read:reporting"]`
- WHEN the agent calls `execute_read_query` against `bi_catastro`
- THEN the response status is `403`
- AND the body is a sanitized error that does not enumerate valid scopes or profiles.

#### Scenario: Wildcard scope

- GIVEN an agent with scopes `["read:*"]`
- WHEN the agent calls `execute_read_query` against any profile
- THEN the tool is permitted to run (subject to the server-side allowlist).

#### Scenario: Server-side allowlist still wins

- GIVEN an agent with scope `["read:bi_catastro"]` and a profile whose allowlist excludes the requested database
- WHEN the agent calls `execute_read_query` against a non-allowlisted database
- THEN the call is rejected with the standard allowlist error from `mcp-tool-surface`
- AND scope is not a factor in the decision.

### Requirement: Audit-Safe Error Responses

All 401, 403, and 503 responses MUST be sanitized. They MUST NOT include the supplied token, the agent's `id`, the agent's `keyHash`, the resolved `keyHash`, the HMAC secret, the list of valid agents, or the list of valid scopes. Errors MUST be emitted through the existing `sanitizeError` path so the same guarantees that protect DB credentials also protect auth state.

#### Scenario: 401 body is minimal

- GIVEN a request with a malformed bearer token
- WHEN the response is generated
- THEN the body is `{ "error": "unauthorized" }` (or equivalent minimal JSON-RPC error)
- AND the body contains no token fragment and no agent metadata.

#### Scenario: 403 body does not enumerate

- GIVEN a scope mismatch
- WHEN the response is generated
- THEN the body explains the failure category only
- AND does not list the agent's actual scopes or any other agent's scopes.

### Requirement: Third-Party Agent Constraints

Third-party agents (agents the operator does not control) MUST be subject to the same validation, scope, and audit rules as first-party agents. The app MUST NOT include a "trusted" / "internal" flag in v1 that would bypass any requirement above. Operators MUST be able to revoke a third-party agent by removing its record from `MCP_AGENTS_JSON` and reloading (SIGTERM/reload or restart) without code changes.

#### Scenario: Third-party agent is not implicitly trusted

- GIVEN a third-party agent record with the widest possible scopes
- WHEN the agent sends a request that violates the read-only safety contract
- THEN the call is rejected by `sqlGuard` regardless of scope
- AND the rejection is logged the same way as for any other agent.

#### Scenario: Revocation is configuration-only

- GIVEN an operator removes an agent's record from `MCP_AGENTS_JSON`
- WHEN the app reloads configuration
- THEN that agent's token is no longer accepted
- AND no app code change was required.

### Requirement: Token Rotation Friendly

The app MUST support rotating agent tokens by replacing the `keyHash` in `MCP_AGENTS_JSON` and reloading, with no app code change. The app SHOULD log agent id and request id for every authenticated request, and MUST NOT log the token or the `keyHash`. When `MCP_LOG_FORMAT=json`, the agent id MUST appear as a structured `agentId` field, not embedded in a free-text message.

#### Scenario: Rotated keyHash takes effect on reload

- GIVEN an agent record whose `keyHash` is replaced
- WHEN the app reloads configuration and the agent retries with the new token
- THEN the request is accepted
- AND the old token is rejected.

#### Scenario: Agent id present, key absent in JSON logs

- GIVEN `MCP_LOG_FORMAT=json` and an authenticated request
- WHEN the request is logged
- THEN the log line includes `agentId`
- AND the log line does not include `keyHash`, the plaintext token, or the HMAC secret.

### Requirement: Out Of Scope For V1 Boundaries

OAuth2 flows remain OUT of scope for the local backend. JWT signature verification and third-party identity provider integration are explicitly IN scope through the JWKS backend and are defined in `mcp-token-authority`. The local backend remains opaque HMAC + scopes only; the external path is JWT/JWKS only. New verbs beyond `read`/`list`/`call` and introspection-based verification remain OUT of scope.

#### Scenario: Local backend is HMAC-only

- GIVEN the local backend
- WHEN the app validates a token
- THEN the token is opaque (no JWT parse)
- AND the comparison is HMAC + constant time.

#### Scenario: JWKS backend uses signature verification

- GIVEN the JWKS backend
- WHEN the app validates a token
- THEN the JWT is verified against the authority's JWKS
- AND `iss`, `aud`, `exp`, `nbf` are validated with the configured leeway.

### Requirement: TokenAuthority Interface Contract

The app MUST verify every HTTP request through a `TokenAuthority` implementation supplied by `mcp-http-base`. The middleware MUST call `authority.verify(token)` and MUST attach `{ agentId, scopes }` to the request context on success. The middleware MUST NOT call `validateBearer` directly; that function is now an implementation detail of `LocalRosterAuthority`. The middleware MUST map `TokenInvalidError` to `401` and `AuthorityUnavailableError` to `503`, reusing the audit-safe error path.

#### Scenario: Middleware delegates to authority

- GIVEN any configured `TokenAuthority`
- WHEN an HTTP request arrives with a bearer token
- THEN the middleware calls `authority.verify(token)`
- AND attaches `{ agentId, scopes }` to the request context on success
- AND returns `401` on `TokenInvalidError` and `503` on `AuthorityUnavailableError`.

### Requirement: Backend Selection By Environment

When `MCP_AUTHORITY_URL` is unset, the runtime MUST instantiate `LocalRosterAuthority`. When `MCP_AUTHORITY_URL` is set, the runtime MUST instantiate `JwksAuthority`. The selection MUST be deterministic and MUST be reflected in the `GET /healthz` body via the `authorityBackend` field. The local backend is the unset-env default, NOT a recommendation; the JWKS backend is the recommended default for production and shared deployments.

#### Scenario: Unset env uses local backend

- GIVEN no `MCP_AUTHORITY_URL`
- WHEN the app starts in HTTP mode
- THEN the backend is `LocalRosterAuthority`
- AND `GET /healthz` reports `authorityBackend: "local"`.

#### Scenario: Set env uses JWKS backend

- GIVEN `MCP_AUTHORITY_URL=https://auth.example.com` and a reachable JWKS
- WHEN the app starts in HTTP mode
- THEN the backend is `JwksAuthority`
- AND `GET /healthz` reports `authorityBackend: "jwks"`.

### Requirement: Local Backend Boundary

`LocalRosterAuthority` is the dev/offline fallback. The app's `.env.example` and `deploy/README.md` MUST mark the local backend as dev/offline-only and MUST recommend `JwksAuthority` for production and shared deployments. The `SCOPE_PATTERN` regex `^(read|list|call):(\*|[A-Za-z0-9_.-]+)$` MUST apply to scopes from both backends; `loadAgents` MUST parse the authority's `scopes` claim as well as the local roster, and entries that fail to match MUST be dropped and logged at `WARN`.

#### Scenario: Local backend documented as fallback

- GIVEN the app's `.env.example`
- WHEN an operator reads the `Choose your backend` section
- THEN the local backend is labeled `dev/offline only`
- AND the JWKS backend is labeled `recommended for production and shared deployments`.

#### Scenario: Scope grammar uniform across backends

- GIVEN a JWT with `scopes` claim `["read:bi_catastro", "delete:foo"]`
- WHEN `JwksAuthority.verify` returns
- THEN only `["read:bi_catastro"]` is returned as `scopes`
- AND the invalid entry is dropped and logged at `WARN` (value omitted).
