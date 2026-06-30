# Delta for mcp-oauth-authority

## MODIFIED Requirements

### Requirement: RS256 JWT Issuance And JWKS

Sign access tokens with RS256. Keys generated on first start, stored in the `keys` table, exposed only via JWKS. Private keys never leave the process. TTL 3600s; `iat`/`nbf`/`exp` set; `kid` matches the SQLite key id. Newly issued access tokens MUST NOT include a `scope` or `scopes` claim; no wildcard scope value (e.g. `*`) is emitted. The audience (`aud`), issuer (`iss`), and subject (`sub`) claims remain the source of identity.
(Previously: payload included `scope`. Now omitted by design — scope authorization is removed; the access token grants access solely by being a validly issued RS256 JWT for the configured `aud`.)

#### Scenario: Claims and public-only JWKS

- GIVEN a successful grant and one active key
- WHEN the JWT is decoded and `/.well-known/jwks.json` is fetched
- THEN header is `{"alg":"RS256","kid","typ":"JWT"}`; payload has `iss`, `aud=mcp:<app-name>`, `sub`, `iat`, `nbf`, `exp` and MUST NOT contain a `scope` or `scopes` claim
- AND the JWK Set has `kty`, `n`, `e`, `kid`, `use`, `alg` (no private components).

### Requirement: Per-App Audience And No Scope Claims

Every JWT carries `aud=mcp:<app-name>`. The authority MUST NOT assign default scopes to newly registered agents or clients; the `scopes` JSON column on `users` and `clients` is treated as legacy/inert and MAY remain empty or hold pre-existing values from earlier deployments, but those values MUST NOT influence authorization. Elevation via scope grants is removed. The `scopes` table is no longer maintained; if a row exists it is legacy.
(Previously: new agents/clients defaulted to `read:<bound-profile>`, the `scopes` table was the catalog, and admin-driven scope elevation wrote an `audit_log` row. Now: no scope defaulting, no scope grant action.)

#### Scenario: Audience honored, no default scope

- GIVEN `audience=mcp:readonly-sql` and a new client for `bi_catastro`
- WHEN the client is registered and a token is minted
- THEN `aud` is `mcp:readonly-sql` (other apps cannot accept it)
- AND the token payload MUST NOT contain a `scope` or `scopes` claim
- AND the client's stored `scopes` column is empty (or retains any legacy value without being read for authorization).

#### Scenario: Legacy scope column does not authorize

- GIVEN an existing client whose `scopes` column still contains `["read:bi_catastro"]` from a prior deployment
- WHEN the authority mints a token for that client
- THEN the token payload MUST NOT contain a `scope` or `scopes` claim
- AND no read to the `scopes` column is used to make an authorization decision.

### Requirement: Bootstrap Admin And First-Login Rotation

Bootstrap admin reads `MCP_OAUTH_ADMIN_USERNAME` and `MCP_OAUTH_ADMIN_PASSWORD` on first start. Password stored as `argon2id` with `require_change_on_first_login=true`. No tokens until rotated. `WARN` while env vars are set. The bootstrap admin MUST NOT be seeded with a default scope set; the `users.scopes` column for the bootstrap admin is empty after first start.
(Previously: bootstrap seeding wrote default scopes into the admin's `scopes` column. Now: empty.)

#### Scenario: Rotation enforced, argon2id stored, no default scope

- GIVEN `require_change_on_first_login=true`
- WHEN admin authenticates with the env password and the `users` table is inspected
- THEN the response is `400` with a sanitized error, no token is issued, the password column is an `argon2id` hash (no env plaintext in any row)
- AND the bootstrap admin's `scopes` column is empty (`[]`).

### Requirement: State And Consent Flow

`/oauth/authorize` MUST validate `state` on every request and echo it back unchanged on success and on redirect-based errors per RFC 6749 §4.1.1. The flow MUST present a login form (reusing the existing admin session/CSRF helpers) followed by a consent screen. Consent MUST be explicit; the user MUST be authenticated before consent is shown. The consent screen MUST NOT list or request authorization for OAuth scopes because the authority no longer issues or enforces scopes; consent records the user's grant to mint an access token for the requesting client. A previously-issued authorization for the same client/user MAY auto-skip consent.

#### Scenario: state echoed, consent still required, no scope listing

- GIVEN an authorize request with `state=xyz123`
- WHEN the user completes login + consent
- THEN the final redirect includes `state=xyz123`
- AND no `code` is issued before explicit consent
- AND the consent screen does not display a scopes list (the field is omitted from the rendered form).

### Requirement: Audit Log

Append to `audit_log` for every auth attempt, refresh revocation, and admin UI action. Row: `ts`, `actor`, `action`, `target`, `ip`, `outcome`. Rows >90 days deleted daily. No bearer tokens, refresh tokens, password hashes, or client secrets in any audit row. The `action` vocabulary MUST NOT include a `scope` grant action because the authority no longer performs scope grants.
(Previously: `scope` grant actions were logged. Now removed.)

#### Scenario: Logged, swept, no secrets, no scope grant action

- GIVEN an auth attempt and a row whose `ts` is 91 days old
- WHEN the attempt succeeds or fails, and the daily sweep runs
- THEN `audit_log` gets a row with `outcome=ok` or `outcome=denied` and a sanitized reason code; the old row is deleted with an `INFO` log count
- AND no `action` value contains `scope` (e.g. no `agent.set_scopes`, `client.set_scopes`, `scope.grant`).

## ADDED Requirements

### Requirement: Incoming `scope` Request Parameter Is Tolerated

When a client includes a `scope` (or `scopes`) parameter in any of the four grant requests (`/oauth/token` with `grant_type` in `client_credentials`, `password`, `refresh_token`, `authorization_code`), the `/oauth/authorize` request, or the Dynamic Client Registration request, the authority MUST accept and ignore the value. The authority MUST NOT reject the request with `invalid_scope` and MUST NOT include the requested scopes in the issued token, the token response body, the introspection response, or the user-info response.
(Previously: the authority validated, bounded, and resolved the requested scopes per grant. Now: tolerated and ignored.)

#### Scenario: scope parameter on token request is ignored

- GIVEN a `client_credentials` request whose body includes `scope=read:bi_catastro%20list:bi_catastro`
- WHEN the authority issues a token
- THEN the response is `200` with a valid JWT
- AND the JWT payload MUST NOT contain a `scope` or `scopes` claim.

#### Scenario: scope parameter on authorize request is ignored

- GIVEN an `/oauth/authorize` request whose query includes `scope=read:bi_catastro`
- WHEN the operator completes login + consent
- THEN the issued `code` is bound to `clientId`, `agentId`, the exact `redirect_uri`, and the `code_challenge` only
- AND the `code` is not bound to a scope set.

#### Scenario: scope parameter on DCR is ignored

- GIVEN a Dynamic Client Registration request whose body includes `scope=read:bi_catastro`
- WHEN the authority registers the client
- THEN the registration succeeds (`201`)
- AND the new client's `scopes` column is empty (legacy/inert)
- AND no `invalid_scope` error is returned.

### Requirement: Authorization-Code Grant Issues Scope-Free Token

The `authorization_code` branch of `/oauth/token` MUST issue a token that omits the `scope` and `scopes` claims. The `code` MUST NOT carry a scope binding. The token response body MUST NOT include a `scope` field.
(Previously: the response and JWT included the consented scope set.)

#### Scenario: code exchanged, no scope in response or token

- GIVEN a `code` issued from `/oauth/authorize` (with the consent granted) and a valid PKCE `code_verifier`
- WHEN `/oauth/token` is called with `grant_type=authorization_code`
- THEN the response is `200` with a JWT and no `scope` field in the body
- AND the JWT payload has no `scope` or `scopes` claim.
