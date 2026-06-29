# mcp-oauth-authority Specification

## Purpose

OAuth2 AS on port 3002 (`apps/mcp-oauth-admin`) mints RS256 JWTs validated by `JwksAuthority`. Doubles as the bootstrap identity store for the admin UI; owns minimum default scopes for newly registered agents and clients.

## Requirements

### Requirement: OAuth2 Endpoints And Resource Server Self-Probe

Expose `/oauth/token` (client_credentials + password), `/oauth/introspect`, `/.well-known/openid-configuration`, `/.well-known/jwks.json` via `node:http`; no auth-code in v1. `OAuthAdminAuthority` calls `/oauth/introspect` against `MCP_AUTHORITY_URL` before the listener accepts requests; exits non-zero on connection refused, TLS error, 5xx, or unexpected body. No requests until the probe succeeds.

#### Scenario: Endpoints, probe, no auth-code

- GIVEN `MCP_AUTHORITY_URL` is set and the authority is up at start, OR the authority is down at start, OR the authority becomes unreachable after a successful start
- WHEN the resource server calls `/oauth/introspect`, posts `grant_type=client_credentials`, requests `/oauth/authorize`, or starts
- THEN `200` returns a JWT (`expires_in=3600`, `iss`, `aud`, `scope`); introspect returns `{"active": true, ...}` or `{"active": false}`; `/oauth/authorize` returns `404`; the probe returns success, OR the process exits non-zero (stderr names `MCP_AUTHORITY_URL`), OR fresh-introspection requests return `503`.

### Requirement: RS256 JWT Issuance And JWKS

Sign access tokens with RS256. Keys generated on first start, stored in the `keys` table, exposed only via JWKS. Private keys never leave the process. TTL 3600s; `iat`/`nbf`/`exp` set; `kid` matches the SQLite key id.

#### Scenario: Claims and public-only JWKS

- GIVEN a successful grant and one active key
- WHEN the JWT is decoded and `/.well-known/jwks.json` is fetched
- THEN header is `{"alg":"RS256","kid","typ":"JWT"}`; payload has `iss`, `aud=mcp:<app-name>`, `sub`, `scope`, `iat`, `nbf`, `exp`; the JWK Set has `kty`, `n`, `e`, `kid`, `use`, `alg` (no private components).

### Requirement: Bootstrap Admin And First-Login Rotation

Bootstrap admin reads `MCP_OAUTH_ADMIN_USERNAME` and `MCP_OAUTH_ADMIN_PASSWORD` on first start. Password stored as `argon2id` with `require_change_on_first_login=true`. No tokens until rotated. `WARN` while env vars are set.

#### Scenario: Rotation enforced and argon2id stored

- GIVEN `require_change_on_first_login=true`
- WHEN admin authenticates with the env password and the `users` table is inspected
- THEN the response is `400` with a sanitized error, no token is issued, and the password column is an `argon2id` hash (no env plaintext in any row).

### Requirement: Per-App Audience, Scopes, And Default-Scope Assignment

Every JWT carries `aud=mcp:<app-name>`. A `scopes` table holds `SCOPE_PATTERN` values; grants only use them. Mixing `*` with specific scopes is rejected. New agents/clients default to `read:<bound-profile>` (no `*`); elevated scopes need an admin action and an `audit_log` row.

(Previously: defaults were not specified at the authority; resource servers must not widen authorization from env vars or deployment defaults.)

#### Scenario: Audience, default scope, and elevation

- GIVEN `audience=mcp:readonly-sql`, `scopes` lacks `delete:foo`, a new client for `bi_catastro`, and an admin granting `list:bi_catastro`
- WHEN the token is minted, the new client is registered, and the elevation is applied
- THEN `aud` is `mcp:readonly-sql` (other apps cannot accept it), OR `400 invalid_scope`; the new client's initial `scopes` is `["read:bi_catastro"]` (no `*`); the elevated `scopes` is `["read:bi_catastro", "list:bi_catastro"]` with an `audit_log` row.

### Requirement: Refresh Token Revocation

Refresh tokens persisted in `refresh_tokens` with `agentId`, `clientId`, `scopes`, `issuedAt`, `revokedAt`. Non-null `revokedAt` is rejected with `400 invalid_grant`. Admin UI exposes revocation.

#### Scenario: Revoked refresh fails

- GIVEN a refresh token with `revokedAt` set
- WHEN `grant_type=refresh_token` is posted
- THEN the response is `400 invalid_grant` with no token in the body.

### Requirement: Audit Log

Append to `audit_log` for every auth attempt, scope grant, refresh revocation, and admin UI action. Row: `ts`, `actor`, `action`, `target`, `ip`, `outcome`. Rows >90 days deleted daily. No bearer tokens, refresh tokens, password hashes, or client secrets in any audit row.

#### Scenario: Logged, swept, no secrets

- GIVEN an auth attempt and a row whose `ts` is 91 days old
- WHEN the attempt succeeds or fails, and the daily sweep runs
- THEN `audit_log` gets a row with `outcome=ok` or `outcome=denied` and a sanitized reason code; the old row is deleted with an `INFO` log count.
