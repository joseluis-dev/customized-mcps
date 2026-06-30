# Delta for mcp-token-authority

## MODIFIED Requirements

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
