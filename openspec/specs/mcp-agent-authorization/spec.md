# mcp-agent-authorization Specification

## Purpose

Defines the per-agent identity and token validation that every HTTP-served MCP in this workspace MUST apply. Authentication runs in middleware before the request reaches the MCP transport, so unauthenticated traffic never reaches a tool handler. Scope authorization is removed; any authenticated agent has access to all MCP capabilities. Stdio traffic is unaffected.

## Requirements

### Requirement: Per-Agent Identity Records

The app MUST load per-agent identity through the selected `TokenAuthority`. When the local backend is selected, the source is `MCP_AGENTS_JSON` (path to a JSON file) or `MCP_AGENTS_INLINE` (raw JSON string in env). When `MCP_AGENTS_JSON` is set, it wins over `MCP_AGENTS_INLINE`. Each local record MUST include `id` (stable string, opaque to the agent) and `keyHash` (server-side HMAC of the agent's bearer token, hex-encoded). The `scopes` field on a local record is treated as decorative/legacy: the runtime MUST NOT use its value to gate access. The plaintext bearer token MUST never be persisted on the server; only its HMAC is stored. The format MUST support third-party agents as ordinary records (no special "first-party" class). When the JWKS backend is selected, the identity record is the JWT subject; the `scopes` claim (if any) is treated as decorative/legacy and is not used for authorization.
(Previously: `scopes` was an enforced authorization field. Now decorative/legacy.)

#### Scenario: Third-party agent onboards on local backend

- GIVEN an operator adds a record `{ "id": "third-party-x", "keyHash": "<hmac-of-token>", "scopes": ["read:bi_catastro"] }` to `MCP_AGENTS_JSON`
- WHEN `third-party-x` sends a request with a valid bearer token
- THEN the request is accepted by `LocalRosterAuthority`
- AND the legacy `scopes` field does not influence which tools the agent can call.

#### Scenario: Third-party agent onboards on JWKS backend

- GIVEN a third-party agent registered at the authority with `agentId=third-party-x` and `scopes=["read:bi_catastro"]` (legacy field)
- WHEN the agent sends a JWT with `sub=third-party-x`
- THEN `JwksAuthority.verify` returns `{ agentId: "third-party-x", scopes: [] }`
- AND no `.agents.local.json` is required
- AND the `scopes` claim is treated as decorative and not used to gate access.

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

The app MUST validate each agent record's `keyHash` at startup and refuse to start (exit non-zero with a stderr message naming the offending record) if it is malformed. `keyHash` MUST be exactly 64 lowercase or uppercase hex characters (the SHA-256 hex digest of the agent's bearer token under the server's HMAC secret). The `scopes` field on a local record MUST be tolerated in any shape (array, missing, wrong-typed) and MUST NOT cause startup to fail. The `SCOPE_PATTERN` grammar check is removed for `scopes` fields on local records; the `SCOPE_PATTERN` constant is itself deprecated.
(Previously: malformed scopes failed startup. Now: tolerated.)

#### Scenario: Malformed keyHash fails closed

- GIVEN an agent record whose `keyHash` is not 64 hex characters (too short, too long, or contains non-hex characters)
- WHEN the app starts in HTTP mode
- THEN the process exits non-zero
- AND stderr names the offending record index and explains the format.

#### Scenario: Malformed or missing scopes field does not fail startup

- GIVEN an agent record whose `scopes` field is missing, set to `null`, set to a string, or contains values that would not have matched the old `SCOPE_PATTERN` (e.g. `delete:foo`)
- WHEN the app starts in HTTP mode
- THEN the process starts successfully
- AND the malformed `scopes` value is treated as decorative/legacy and never read for authorization.

### Requirement: Bearer Token Validation

Clients present `Authorization: Bearer <token>` on every request. Tokens MAY be opaque (local) or JWT (JWKS); the wire contract is unchanged. The HMAC secret for the local backend is loaded from `MCP_AGENT_HMAC_SECRET` and MUST be >=32 bytes; a missing/short secret exits non-zero at startup. JWT verification on the JWKS backend is defined in `mcp-token-authority`. The middleware runs before `transport.handleRequest`.

(Previously: the v1 wording explicitly forbade JWT. The constraint is removed because the JWKS backend in `mcp-token-authority` validates signatures; the local-roster path is the dev/offline fallback until Phase 5.)

#### Scenario: Valid token accepted on either backend

- GIVEN a valid opaque token (HMAC match) on the local backend OR a valid signed JWT on the JWKS backend
- WHEN the middleware validates it
- THEN the request is forwarded to the MCP transport.

#### Scenario: Missing or invalid token returns 401

- GIVEN a request with no `Authorization` header OR a malformed/mismatched bearer token
- WHEN the middleware validates it
- THEN the response is `401` and the body is a sanitized JSON-RPC error with no token value.

### Requirement: Audit-Safe Error Responses

All `401` and `503` responses MUST be sanitized. They MUST NOT include the supplied token, the agent's `id`, the agent's `keyHash`, the resolved `keyHash`, the HMAC secret, the list of valid agents, or any other internal auth state. Errors MUST be emitted through the existing `sanitizeError` path so the same guarantees that protect DB credentials also protect auth state. The `403` status code is no longer produced by scope enforcement because scope authorization is removed.
(Previously: the contract also covered `403` responses for scope mismatches. Now: only `401`/`503` apply to authentication; `403` is no longer used for scope decisions.)

#### Scenario: 401 body is minimal

- GIVEN a request with a malformed bearer token
- WHEN the response is generated
- THEN the body is `{ "error": "unauthorized" }` (or equivalent minimal JSON-RPC error)
- AND the body contains no token fragment and no agent metadata.

#### Scenario: No 403 from scope enforcement

- GIVEN any authenticated request (regardless of legacy `scopes` field on the agent record or `scopes` claim on the JWT)
- WHEN the request is processed
- THEN the response MUST NOT be `403` due to a scope mismatch (scope enforcement is removed)
- AND any non-auth failure (e.g. profile allowlist) returns the existing allowlist error, not a scope error.

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

JWT signature verification and the `mcp-oauth-authority` endpoints (token, introspect, JWKS) are IN scope through the JWKS backend. OAuth2 client_credentials and password grants are IN scope at the authority but OUT of scope for the resource server. Local HMAC roster is the dev/offline fallback until Phase 5. Authorization-code flow (Phase 6) and third-party IdPs remain OUT of scope.

(Previously: the v1 wording forbade JWT and OAuth2; the external path is now in scope. The local backend's HMAC-only rule is preserved until Phase 5.)

#### Scenario: Local is HMAC-only; JWKS is signature-based

- GIVEN the local backend OR the JWKS backend is active
- WHEN the app validates a token
- THEN the token is opaque (HMAC + constant time) OR the JWT is verified against the authority's JWKS per `mcp-token-authority`.

### Requirement: TokenAuthority Interface Contract

The app MUST verify every HTTP request through a `TokenAuthority` implementation supplied by `mcp-http-base`. The middleware MUST call `authority.verify(token)` and MUST attach `{ agentId, scopes: [] }` to the request context on success (the `scopes` field is retained on the context for backward compatibility with downstream code but is always `[]` and MUST NOT be used for authorization). The middleware MUST NOT call `validateBearer` directly; that function is now an implementation detail of `LocalRosterAuthority`. The middleware MUST map `TokenInvalidError` to `401` and `AuthorityUnavailableError` to `503`, reusing the audit-safe error path.
(Previously: `req.auth` carried the agent's `scopes` for downstream authorization. Now: the field is present but always empty and not consulted for access.)

#### Scenario: Middleware delegates to authority

- GIVEN any configured `TokenAuthority`
- WHEN an HTTP request arrives with a bearer token
- THEN the middleware calls `authority.verify(token)`
- AND attaches `{ agentId, scopes: [] }` to the request context on success
- AND returns `401` on `TokenInvalidError` and `503` on `AuthorityUnavailableError`
- AND the `scopes` value on the context is never inspected to make an authorization decision.

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

`LocalRosterAuthority` is the dev/offline fallback. The app's `.env.example` and `deploy/README.md` MUST mark the local backend as dev/offline-only and MUST recommend `JwksAuthority` for production and shared deployments. The `SCOPE_PATTERN` regex `^(read|list|call):(\*|[A-Za-z0-9_.-]+)$` is deprecated and is no longer used to validate `scopes` from either backend. The `loadAgents` parser MUST tolerate a `scopes` field of any shape (missing, non-string-array, or containing non-pattern values) and MUST NOT drop or warn on a record solely because of its `scopes` value. The local roster is unaffected by OAuth authority defaults and vice versa.
(Previously: `SCOPE_PATTERN` applied to scopes from both backends; mismatched entries were dropped and warned. Now: the pattern is unused.)

#### Scenario: Local backend documented as fallback

- GIVEN the app's `.env.example`
- WHEN an operator reads the `Choose your backend` section
- THEN the local backend is labeled `dev/offline only`
- AND the JWKS backend is labeled `recommended for production and shared deployments`.

#### Scenario: Any scopes shape is tolerated

- GIVEN a JWT or local record with `scopes` set to `["read:bi_catastro", "delete:foo", 42, null]` or omitted entirely
- WHEN the backend parses the value
- THEN the request proceeds
- AND no record is dropped because of the `scopes` value
- AND no `WARN` is emitted for the `scopes` value.

### Requirement: Local Roster Deprecation Notice

When the local backend is active, the resource server MUST log a one-shot `WARN` at startup naming `MCP_AGENTS_JSON`, `MCP_AGENTS_INLINE`, and `MCP_AGENT_HMAC_SECRET` as deprecated. Emitted exactly once per process; points to `deploy/README.md` and `mcp-oauth-authority`.

#### Scenario: WARN emitted and suppressed

- GIVEN the local backend is active OR `MCP_AUTHORITY_URL` is set
- WHEN the resource server starts
- THEN stderr contains exactly one `WARN` line naming the three env vars, OR the line is not emitted.
