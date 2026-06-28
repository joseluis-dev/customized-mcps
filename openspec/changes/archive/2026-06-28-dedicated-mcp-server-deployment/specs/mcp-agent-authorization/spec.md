# mcp-agent-authorization Specification

## Purpose

Defines the per-agent identity, token validation, and scope enforcement that every HTTP-served MCP in this workspace MUST apply. Authorization runs in middleware before the request reaches the MCP transport, so unauthorized traffic never reaches a tool handler. Stdio traffic is unaffected.

## Requirements

### Requirement: Per-Agent Identity Records

The app MUST load per-agent records at startup from `MCP_AGENTS_JSON` (path to a JSON file) or `MCP_AGENTS_INLINE` (raw JSON string in env). When both are set, `MCP_AGENTS_JSON` wins. Each record MUST include `id` (stable string, opaque to the agent), `keyHash` (server-side HMAC of the agent's bearer token, hex-encoded), and `scopes` (array of strings). The plaintext bearer token MUST never be persisted on the server; only its HMAC is stored. The format MUST support third-party agents as ordinary records (no special "first-party" class) so any agent — including ones the operator does not control — can be onboarded by adding a record.

#### Scenario: Third-party agent onboards

- GIVEN an operator adds a record `{ "id": "third-party-x", "keyHash": "<hmac-of-token>", "scopes": ["read:bi_catastro"] }` to `MCP_AGENTS_JSON`
- WHEN `third-party-x` sends a request with a valid bearer token
- THEN the request is accepted
- AND the request is denied only on the rules that apply to that agent's scopes.

#### Scenario: Missing agent config fails closed

- GIVEN no `MCP_AGENTS_JSON` and no `MCP_AGENTS_INLINE`
- WHEN the app starts in HTTP mode
- THEN the process exits non-zero
- AND stderr explains that at least one agent must be configured.

#### Scenario: Malformed agent config fails closed

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



Clients MUST present credentials as `Authorization: Bearer <token>` on every request. Tokens are opaque to the client (no embedded claims, no JWT) and are compared server-side as `HMAC(secret, token) === keyHash` in constant time. The HMAC secret MUST be loaded from `MCP_AGENT_HMAC_SECRET` and MUST be at least 32 bytes of entropy. A missing or short secret MUST cause the process to exit non-zero at startup. The middleware MUST run before `transport.handleRequest` so unauthorized requests never reach the MCP transport.

#### Scenario: Valid token accepted

- GIVEN a request with a bearer token whose HMAC matches an agent's `keyHash`
- WHEN the middleware validates it
- THEN the request is forwarded to the MCP transport
- AND the agent's scopes are attached to the request context.

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

#### Scenario: Constant-time comparison

- GIVEN the validation code path
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

### Requirement: Out Of Scope For V1

OAuth2 flows, JWT signature verification, and any third-party identity provider integration are explicitly OUT of scope for v1. A future change MAY introduce them; v1 is opaque HMAC + scopes only. The spec MUST NOT preempt that decision.
