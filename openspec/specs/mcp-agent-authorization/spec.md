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

JWT signature verification and the `mcp-oauth-authority` endpoints (token, introspect, JWKS) are IN scope through the JWKS backend. OAuth2 client_credentials and password grants are IN scope at the authority but OUT of scope for the resource server. Local HMAC roster is the dev/offline fallback until Phase 5. Authorization-code flow (Phase 6) and third-party IdPs remain OUT of scope.

(Previously: the v1 wording forbade JWT and OAuth2; the external path is now in scope. The local backend's HMAC-only rule is preserved until Phase 5.)

#### Scenario: Local is HMAC-only; JWKS is signature-based

- GIVEN the local backend OR the JWKS backend is active
- WHEN the app validates a token
- THEN the token is opaque (HMAC + constant time) OR the JWT is verified against the authority's JWKS per `mcp-token-authority`.

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

### Requirement: Resource Server Scope Claims Are Authoritative

The JWKS/resource-server path MUST authorize from verified JWT claims only. Resource servers MUST NOT add scopes from env vars, local config, or deployment defaults. If a required scope is absent from the claim, the existing authorization failure applies; no fallback grants. The local roster is self-contained and unaffected by OAuth authority defaults.

#### Scenario: Claim is the only authority

- GIVEN an agent whose JWT `scopes` claim is `["list:bi_catastro"]` and a tool requiring `read:bi_catastro`
- WHEN the agent calls the tool
- THEN the call is permitted only if `read:bi_catastro` is in the claim; no env-var, config, or default widens the authorization.

#### Scenario: Missing scope denies; local roster unaffected

- GIVEN the local backend is active, or the JWKS backend is active with a claim lacking the required scope
- WHEN an agent makes a request
- THEN the local roster's `scopes` field is the only authority on the local backend, and on the JWKS backend the call is denied with the standard authorization failure (no fallback).

### Requirement: Local Roster Deprecation Notice

When the local backend is active, the resource server MUST log a one-shot `WARN` at startup naming `MCP_AGENTS_JSON`, `MCP_AGENTS_INLINE`, and `MCP_AGENT_HMAC_SECRET` as deprecated. Emitted exactly once per process; points to `deploy/README.md` and `mcp-oauth-authority`.

#### Scenario: WARN emitted and suppressed

- GIVEN the local backend is active OR `MCP_AUTHORITY_URL` is set
- WHEN the resource server starts
- THEN stderr contains exactly one `WARN` line naming the three env vars, OR the line is not emitted.
