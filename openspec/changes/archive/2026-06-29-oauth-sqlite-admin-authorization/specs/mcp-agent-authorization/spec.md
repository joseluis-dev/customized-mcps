# Delta for mcp-agent-authorization

## Purpose

Drop the v1 "no JWT" line; the JWKS backend in `external-token-authority-verification` Phase 1b is the recommended production backend. Add `Resource Server Scope Claims Are Authoritative` (no env-var widening). Local-roster env vars remain the dev/offline fallback until Phase 5.

## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: Out Of Scope For V1 Boundaries

JWT signature verification and the `mcp-oauth-authority` endpoints (token, introspect, JWKS) are IN scope through the JWKS backend. OAuth2 client_credentials and password grants are IN scope at the authority but OUT of scope for the resource server. Local HMAC roster is the dev/offline fallback until Phase 5. Authorization-code flow (Phase 6) and third-party IdPs remain OUT of scope.

(Previously: the v1 wording forbade JWT and OAuth2; the external path is now in scope. The local backend's HMAC-only rule is preserved until Phase 5.)

#### Scenario: Local is HMAC-only; JWKS is signature-based

- GIVEN the local backend OR the JWKS backend is active
- WHEN the app validates a token
- THEN the token is opaque (HMAC + constant time) OR the JWT is verified against the authority's JWKS per `mcp-token-authority`.

## REMOVED Requirements

### Requirement: Out Of Scope For V1

(Reason: replaced by the modified `Out Of Scope For V1 Boundaries` requirement above.)
