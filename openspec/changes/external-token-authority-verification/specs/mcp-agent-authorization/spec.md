# Delta for mcp-agent-authorization

## Purpose

Move from a v1-only local-roster assumption to a `TokenAuthority` abstraction with two implementations. The local HMAC roster is the dev/offline fallback; the JWKS-backed authority is the recommended default for production and shared deployments. The constant-time, fail-closed, and audit-safe guarantees on the local backend are preserved; signature-based verification is added on the JWKS backend and is defined in `mcp-token-authority`.

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Per-Agent Identity Records

The app MUST load per-agent identity through the selected `TokenAuthority`. When the local backend is selected, the source is `MCP_AGENTS_JSON` (path to a JSON file) or `MCP_AGENTS_INLINE` (raw JSON string in env). When `MCP_AGENTS_JSON` is set, it wins over `MCP_AGENTS_INLINE`. Each local record MUST include `id` (stable string, opaque to the agent), `keyHash` (server-side HMAC of the agent's bearer token, hex-encoded), and `scopes` (array of strings matching `SCOPE_PATTERN`). The plaintext bearer token MUST never be persisted on the server; only its HMAC is stored. The format MUST support third-party agents as ordinary records (no special "first-party" class). When the JWKS backend is selected, the identity record is the JWT subject and the `scopes` claim, both delivered by the authority.

(Previously: the v1 wording assumed a single local-roster source; it is now scoped to the local backend and complemented by a JWKS path defined in `mcp-token-authority`.)

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

### Requirement: Bearer Token Validation

Clients MUST present credentials as `Authorization: Bearer <token>` on every request. The middleware MUST verify the token by calling `authority.verify(token)`. On the local backend, verification is `HMAC(secret, token) === keyHash` in constant time; on the JWKS backend, verification is signature-based against the authority's JWKS with `iss`/`aud`/`exp`/`nbf` checks (defined in `mcp-token-authority`). The HMAC secret for the local backend MUST be loaded from `MCP_AGENT_HMAC_SECRET` and MUST be at least 32 bytes of entropy. A missing or short secret MUST cause the process to exit non-zero at startup. The middleware MUST run before `transport.handleRequest` so unauthorized requests never reach the MCP transport.

(Previously: the v1 wording hard-coded HMAC + opaque token and forbade JWT; the requirement is now backend-agnostic and the JWT line is removed for the external path only.)

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

### Requirement: Out Of Scope For V1 Boundaries

OAuth2 flows remain OUT of scope for the local backend. JWT signature verification and third-party identity provider integration are explicitly IN scope through the JWKS backend and are defined in `mcp-token-authority`. The local backend remains opaque HMAC + scopes only; the external path is JWT/JWKS only. New verbs beyond `read`/`list`/`call` and introspection-based verification remain OUT of scope.

(Previously: the v1 wording forbade JWT signature verification; the external path is now in scope, the local backend's HMAC-only rule is preserved.)

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

## REMOVED Requirements

None.
