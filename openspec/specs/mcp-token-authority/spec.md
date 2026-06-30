# mcp-token-authority Specification

## Purpose

Defines the resource-server-side contract that every MCP app in this workspace MUST follow when it delegates agent-token verification to an external authority (a sibling MCP or third-party identity provider). The local HMAC roster remains the dev/offline fallback; the JWKS-backed authority is the recommended default for production and shared deployments. The authority implementation itself is OUT of scope — this spec covers only the resource-server side of the contract.

## Requirements

### Requirement: TokenAuthority Interface

`@customized-mcps/mcp-http-base` MUST export a `TokenAuthority` interface with `verify(token: string) -> Promise<{ agentId: string; scopes: string[] }>`. Optional lifecycle methods `warm()` and `invalidate()` MAY exist. A successful `verify` MUST return the verified `agentId` and a `scopes` array that is always empty (`[]`); the value is retained for backward compatibility with downstream consumers but MUST NOT be used for authorization. A failure MUST throw a typed error (`TokenInvalidError` or `AuthorityUnavailableError`) that the HTTP middleware maps to `401` or `503` respectively. The middleware MUST NOT call `validateBearer` directly; that function is now an implementation detail of `LocalRosterAuthority`. The `SCOPE_PATTERN` regex is deprecated and MUST NOT be used to validate `scopes` on either backend.
(Previously: `verify` returned the granted `scopes`; the array was the basis of authorization. Now: `scopes` is always `[]` and is decorative.)

#### Scenario: Valid token returns identity with empty scopes

- GIVEN a `TokenAuthority` implementation
- WHEN `verify` is called with a valid token
- THEN the resolved promise contains `agentId` and `scopes: []`
- AND no entry in `scopes` is ever used to decide whether a tool call proceeds.

#### Scenario: Invalid token throws typed error

- GIVEN a `TokenAuthority` implementation
- WHEN `verify` is called with a malformed or expired token
- THEN the rejected error is a `TokenInvalidError`
- AND the HTTP middleware maps it to `401`.

### Requirement: JWKS Fetch And Cache

The `JwksAuthority` MUST fetch the JWKS from `MCP_AUTHORITY_JWKS_URL`, MUST cache keys for `MCP_AUTHORITY_JWKS_TTL_S` seconds (default `60`), and MUST time out each fetch at `MCP_AUTHORITY_FETCH_TIMEOUT_MS` (default `5000`). A fetch failure (network, timeout, non-2xx) MUST throw `AuthorityUnavailableError`, which the middleware maps to `503`.

#### Scenario: First request fetches JWKS once

- GIVEN a cold cache and a reachable `MCP_AUTHORITY_JWKS_URL`
- WHEN `JwksAuthority.verify` is called for the first time
- THEN the JWKS is fetched exactly once
- AND the parsed key set is reused for subsequent verifications until the TTL expires.

#### Scenario: Authority unreachable returns 503

- GIVEN `MCP_AUTHORITY_JWKS_URL` unreachable within `MCP_AUTHORITY_FETCH_TIMEOUT_MS`
- WHEN `verify` is called
- THEN the rejected error is `AuthorityUnavailableError`
- AND the HTTP middleware responds `503` with a sanitized body.

### Requirement: JWT Claim Validation

`JwksAuthority` MUST validate the JWT's `iss` (must equal `MCP_AUTHORITY_URL`), `aud` (must equal `MCP_AUTHORITY_AUDIENCE`), `exp`, and `nbf` with leeway `MCP_AUTHORITY_LEEWAY_S` seconds (default `30`). A claim failure MUST be mapped to `401`. The `scopes` claim (string or array), if present, MUST be ignored entirely: it MUST NOT be extracted, normalized, filtered, returned, or logged. The `SCOPE_PATTERN` regex is not applied. The returned `scopes` is always `[]`.
(Previously: the `scopes` claim was normalized to `string[]` and filtered against `SCOPE_PATTERN`; invalid entries were dropped and warned. Now: the claim is ignored.)

#### Scenario: Valid iss/aud/exp accepted; scopes ignored

- GIVEN a JWT signed by the authority with correct `iss`, `aud`, and `exp` and a `scopes` claim of any shape
- WHEN `verify` is called
- THEN the promise resolves with the JWT subject as `agentId` and `scopes: []`
- AND the `scopes` claim (if present) is not parsed, not filtered, and not logged.

#### Scenario: Audience mismatch rejected

- GIVEN a JWT whose `aud` does not equal `MCP_AUTHORITY_AUDIENCE`
- WHEN `verify` is called
- THEN the rejected error is `TokenInvalidError`
- AND the response is `401`.

#### Scenario: Expired token rejected

- GIVEN a JWT whose `exp` is in the past beyond `MCP_AUTHORITY_LEEWAY_S`
- WHEN `verify` is called
- THEN the rejected error is `TokenInvalidError`
- AND the response is `401`.

### Requirement: kid Miss Refetch With Cap

If the token's `kid` is not in the cached JWKS, `JwksAuthority` MUST refetch the JWKS exactly once. A second consecutive `kid` miss (kid absent from two consecutive JWKS responses) MUST be logged at `WARN` with `kid`, the token's first 8 hex chars of SHA-256, and the request id, and MUST be rejected with `401`. The refetch itself is per-miss and uncapped across requests.

#### Scenario: kid miss refetches once

- GIVEN a token whose `kid` is not in the cached JWKS
- WHEN `verify` is called
- THEN the JWKS is refetched
- AND the token is verified against the fresh JWKS if the `kid` is now present.

#### Scenario: Repeated kid miss is rejected and logged

- GIVEN a token whose `kid` is absent from two consecutive JWKS responses
- WHEN `verify` is called
- THEN a structured `WARN` log line includes `kid`, token fingerprint prefix, and request id
- AND the response is `401`.

### Requirement: Audit-Safe Error Mapping

`JwksAuthority` errors MUST be mapped by the HTTP middleware to sanitized `401`/`503` responses. Bodies MUST NOT include the token, the `kid`, the JWKS URL, the authority URL, the resolved `agentId`, or any stack trace. The middleware MUST reuse the `sanitizeError` path from `mcp-agent-authorization` so the same guarantees that protect DB credentials also protect auth state.

#### Scenario: 401 body is minimal

- GIVEN a `TokenInvalidError`
- WHEN the middleware writes the response
- THEN the body matches the existing audit-safe shape from `mcp-agent-authorization`
- AND contains no token, `kid`, agent id, authority URL, or JWKS URL.

#### Scenario: 503 body is minimal

- GIVEN an `AuthorityUnavailableError`
- WHEN the middleware writes the response
- THEN the body is a sanitized `service unavailable` JSON-RPC error
- AND no authority URL, JWKS URL, or stack trace is included.

### Requirement: Startup Probe

When `MCP_AUTHORITY_URL` is set, the app MUST probe the authority at startup by calling `warm()`. A probe failure MUST cause the process to exit non-zero with a stderr message that names the authority's host and base path (not the token path or any query string).

#### Scenario: Probe success

- GIVEN `MCP_AUTHORITY_URL` set and reachable
- WHEN the app starts
- THEN `warm()` succeeds
- AND HTTP traffic is accepted.

#### Scenario: Probe failure exits non-zero

- GIVEN `MCP_AUTHORITY_URL` set and unreachable
- WHEN the app starts
- THEN the process exits non-zero
- AND stderr names the authority host and base path only.

### Requirement: Health Endpoint Reports Backend

`GET /healthz` MUST include an `authorityBackend` field whose value is `"local"` (when `MCP_AUTHORITY_URL` is unset) or `"jwks"` (when set). The value MUST reflect the selected backend deterministically and MUST NOT include tokens, `kid`, JWKS URL, or authority URL.

#### Scenario: Local backend reported

- GIVEN no `MCP_AUTHORITY_URL`
- WHEN `GET /healthz` is called
- THEN the body contains `authorityBackend: "local"`
- AND no token, `kid`, or authority URL is present.

#### Scenario: JWKS backend reported

- GIVEN `MCP_AUTHORITY_URL` set
- WHEN `GET /healthz` is called
- THEN the body contains `authorityBackend: "jwks"`
- AND the JWKS URL itself is not echoed in the body.

### Requirement: Port Reservation For Future Authority MCP

If a sibling authority MCP is added to this workspace later, it MUST use port `3002` per the `mcp-http-transport` Port Allocation Convention (port `3001` is taken by `mcp-readonly-sql`). The reservation MUST be reflected in the authority MCP's `.env.example` and `deploy/README.md`.

#### Scenario: Authority port documented

- GIVEN the future authority MCP
- WHEN an operator reads its `.env.example` and `deploy/README.md`
- THEN `MCP_HTTP_PORT=3002` is the documented default
- AND the doc links to the `mcp-http-transport` Port Allocation Convention.

### Requirement: Resource Server Public Base URL

`@customized-mcps/mcp-http-base` MUST read a public base URL for the resource server (e.g. `MCP_RESOURCE_SERVER_URL` or an equivalent config) used to build absolute URLs for resource metadata. When unset, the server MUST fall back to the request's `Host` header (and matching scheme) to construct the base URL. The base URL MUST NOT default to `MCP_AUTHORITY_URL` because the resource server and authorization server are separate origins.

#### Scenario: Explicit base URL honored

- GIVEN `MCP_RESOURCE_SERVER_URL=https://mcp.example.com`
- WHEN the resource server builds the `resource_metadata` URL or the protected resource metadata `resource` field
- THEN the value uses the configured base URL.

#### Scenario: Fallback to request host

- GIVEN no explicit `MCP_RESOURCE_SERVER_URL`
- WHEN a metadata URL is built for an incoming request
- THEN the URL uses the request's `Host` header and matching scheme.

### Requirement: RFC 9728 Protected Resource Metadata

`GET /.well-known/oauth-protected-resource` MUST return JSON with at least `resource`, `authorization_servers`, `bearer_methods_supported: ["header"]`, and `scopes_supported: []` per RFC 9728. The `scopes_supported` array MUST be the empty array regardless of any legacy `scopes` table, agent scopes, or environment variable — the field is retained for spec compliance but is no longer a source of authorization. `authorization_servers` MUST contain the `mcp-oauth-admin` issuer URL (from `MCP_AUTHORITY_URL`), NOT the resource server's own base URL. The `resource` field MUST be the resource server's own public base URL.
(Previously: `scopes_supported` was derived from a non-empty scope catalog. Now: always `[]`.)

#### Scenario: Happy path discovery with empty scopes_supported

- GIVEN the resource server is up and `MCP_AUTHORITY_URL` is set
- WHEN a client calls `GET /.well-known/oauth-protected-resource`
- THEN the response is `200` JSON with `resource` = the resource server's public base URL
- AND `authorization_servers` = `["<MCP_AUTHORITY_URL>"]`
- AND `bearer_methods_supported` = `["header"]`
- AND `scopes_supported` = `[]`.

#### Scenario: Legacy catalog does not change scopes_supported

- GIVEN a `scopes` table that still contains rows from a prior deployment (e.g. `read:bi_catastro`)
- WHEN the resource server serves `/.well-known/oauth-protected-resource`
- THEN `scopes_supported` is still `[]`
- AND the legacy catalog rows are not enumerated in any field.

### Requirement: WWW-Authenticate Resource Metadata on 401

Every `401` returned by the resource server for an unauthenticated or invalid-token request MUST include a `WWW-Authenticate: Bearer resource_metadata="<url>"` header per RFC 6750 §3 and RFC 9728 §5.1. The `resource_metadata` URL MUST be the resource server's own protected resource metadata URL (e.g. `<resource-server-base>/.well-known/oauth-protected-resource`), NOT the authorization server issuer URL. The header MAY also include `scope` per RFC 6750 §3. The 401 body MUST remain sanitized per the existing audit-safe contract.

#### Scenario: 401 includes resource_metadata header

- GIVEN a request to a protected resource with no/invalid bearer token
- WHEN the resource server responds `401`
- THEN the response includes `WWW-Authenticate: Bearer resource_metadata="<resource-server-base>/.well-known/oauth-protected-resource"`
- AND the `resource_metadata` URL points to the resource server itself, not the authority.

#### Scenario: 401 body remains audit-safe

- GIVEN a `401` response
- WHEN the response body is inspected
- THEN it matches the existing sanitized `401` shape (no token, no `kid`, no agent id, no authority URL, no JWKS URL).

### Requirement: Typecheck Gate

`pnpm --filter mcp-http-base typecheck` and `pnpm --filter mcp-readonly-sql typecheck` MUST both exit `0` after the changes are applied.

#### Scenario: Typecheck passes

- GIVEN the new resource metadata, base URL, and `WWW-Authenticate` changes
- WHEN `pnpm --filter mcp-http-base typecheck` and `pnpm --filter mcp-readonly-sql typecheck` are run
- THEN both commands exit `0`.
