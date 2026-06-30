# Delta for mcp-agent-authorization

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Scope-Based Authorization

(Reason: scope authorization is removed. Any authenticated agent MAY access all MCP capabilities; scope strings MUST NOT gate tool access. The check is no longer performed at the middleware or tool layer.)
(Migration: tool handlers and middleware MUST NOT consult `req.auth.scopes` for access decisions. The `scopes` field on the request context is preserved for backward compatibility but is always `[]`. Non-scope safety controls (sqlGuard, profile/database allowlists, body caps, host/proxy posture, admin session/CSRF/backoff, audit, token revocation) remain authoritative.)

### Requirement: Resource Server Scope Claims Are Authoritative

(Reason: the contract that the resource server must authorize from verified JWT `scopes` claims only is removed because scope authorization itself is removed. There is no claim to consult.)
(Migration: downstream code that previously read JWT `scopes` claims MUST NOT make an authorization decision on that value. The new contract is "any authenticated agent may call any tool subject to non-scope safety controls" — see the modified `TokenAuthority Interface Contract` and the `mcp-tool-surface` deltas.)

## RENAMED Requirements

None.
