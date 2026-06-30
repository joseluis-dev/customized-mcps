# Delta for mcp-oauth-authority

## MODIFIED Requirements

### Requirement: OAuth2 Endpoints And Resource Server Self-Probe

Expose `/oauth/token` (client_credentials, password, refresh_token, AND authorization_code with PKCE S256), `/oauth/introspect`, `/oauth/authorize` (GET + POST), `/.well-known/openid-configuration`, and `/.well-known/jwks.json` via `node:http`. OIDC discovery MUST advertise `authorization_endpoint` = `<issuer>/oauth/authorize`, include `authorization_code` in `grant_types_supported`, and `code_challenge_methods_supported: ["S256"]`. The startup introspect probe MUST still exit non-zero on connection refused, TLS error, 5xx, or unexpected body.
(Previously: no `authorization_endpoint`, no auth-code grant, `/oauth/authorize` returned `404`.)

#### Scenario: Endpoints, probe, and authorization_code grant

- GIVEN `MCP_AUTHORITY_URL` is set and the authority is up, OR down, OR unreachable after a successful start
- WHEN the resource server introspects, posts client_credentials, posts authorization_code with valid `code_verifier`, requests `GET /oauth/authorize`, or starts
- THEN `200` returns a JWT; introspect returns `{"active": true|false}`; auth-code returns a JWT and consumes the `code`; the probe succeeds, OR the process exits non-zero (stderr names `MCP_AUTHORITY_URL`), OR fresh-introspection requests return `503`.

## ADDED Requirements

### Requirement: Loopback Redirect URI Validation

`/oauth/authorize` and the `authorization_code` branch of `/oauth/token` MUST accept `redirect_uri` only when it matches RFC 8252 §7.3 loopback forms: `http://127.0.0.1:*`, `http://[::1]:*`, or `http://localhost:*` with a non-empty port. Non-loopback URIs MUST be rejected with a sanitized `400 invalid_request` (authorize) or `400 invalid_redirect_uri` (token). The `code` MUST be bound to the exact `redirect_uri` from the authorize request and the token exchange MUST verify that match.

#### Scenario: Loopback accepted, non-loopback rejected

- GIVEN authorize/token requests with `redirect_uri`
- WHEN the URI is `http://127.0.0.1:8080/cb`
- THEN the handler proceeds and the `code` is bound to that exact URI
- WHEN the URI is `https://attacker.example/cb`
- THEN the response is `400` with a sanitized error and no `code` is issued or redirected to the hostile URI.

### Requirement: State And Consent Flow

`/oauth/authorize` MUST validate `state` on every request and echo it back unchanged on success and on redirect-based errors per RFC 6749 §4.1.1. The flow MUST present a login form (reusing the existing admin session/CSRF helpers) followed by a consent screen listing the requested scopes. Consent MUST be explicit; the user MUST be authenticated before consent is shown. A previously-granted scope set for the same client/user MAY auto-skip consent.

#### Scenario: state echoed, consent required

- GIVEN an authorize request with `state=xyz123`
- WHEN the user completes login + consent
- THEN the final redirect includes `state=xyz123`
- AND no `code` is issued before explicit consent.

### Requirement: One-Time Code Lifecycle

The authority MUST persist one-time `code`s in a short-lived in-memory map keyed by a server-generated secret (≥32 bytes entropy). Each `code` MUST be single-use, bound to `clientId`, `agentId`, the exact `redirect_uri`, and the `code_challenge` (S256), and MUST expire within `60` seconds. Expired or consumed codes MUST be rejected with `400 invalid_grant`. In-memory loss on restart is acceptable because codes are short-lived and clients retry.

#### Scenario: single-use and expiry

- GIVEN an issued `code`
- WHEN `/oauth/token` is called twice with that `code`
- THEN the first returns a JWT and the second returns `400 invalid_grant`
- AND any call after `60` seconds also returns `400 invalid_grant`.

### Requirement: Sanitized OAuth Error Responses

`/oauth/authorize` and `/oauth/token` MUST return errors in OAuth2 error format (`{"error": "...", "error_description": "..."}`) and MUST NOT leak secrets, stack traces, authority URLs, JWKS URLs, or token contents. Redirect-based errors on `/oauth/authorize` MUST place `error` and `error_description` in the redirect query string ONLY when `redirect_uri` is validated as loopback; otherwise the error renders as a sanitized HTML page.

#### Scenario: error body is sanitized

- GIVEN an invalid `grant_type=authorization_code` request
- WHEN `/oauth/token` is called
- THEN the response is `400` with `{"error": "invalid_grant", "error_description": "..."}` and no internal detail.

### Requirement: Typecheck Gate

`pnpm --filter mcp-oauth-admin typecheck` MUST exit `0` after the changes are applied.

#### Scenario: Typecheck passes

- GIVEN the new authorize, token, and discovery changes
- WHEN `pnpm --filter mcp-oauth-admin typecheck` runs
- THEN it exits `0`.
