# mcp-admin-ui Specification

## Purpose

Server-rendered web admin UI alongside the OAuth2 endpoints in `apps/mcp-oauth-admin`. Operators manage agents, OAuth clients, scopes, refresh-token revocations, and inspect the audit log from a browser. Thin layer over the same SQLite store.

## Requirements

### Requirement: Server-Rendered Pages Over Node HTTP

Served by `node:http` (no express, no SPA). Server-rendered HTML, form-post interaction. Lives at `/admin/...`, shares the authority's `MCP_HTTP_HOST` and `MCP_HTTP_PORT` (default `127.0.0.1:3002`). NOT reachable on non-loopback without `MCP_HTTP_BEHIND_PROXY=true`.

#### Scenario: Loopback default and proxy opt-in

- GIVEN no opt-in env var OR `MCP_HTTP_BEHIND_PROXY=true`
- WHEN the operator starts the authority
- THEN the UI is reachable on `http://127.0.0.1:3002/admin/` (and NOT on the external interface) OR binds the configured host with no insecure-loopback warning.

### Requirement: Session Cookie And CSRF Protection

Session cookie on admin login: `HttpOnly`, `SameSite=Strict`, `Secure` (when not loopback), signed with a server-side secret. Double-submit CSRF: every state-changing form has a hidden CSRF token input AND the matching `X-CSRF-Token` header on fetch requests; the server rejects requests missing either. CSRF token rotates on login and on privilege change.

#### Scenario: Cookie and double-submit

- GIVEN the admin logs in OR a state-changing POST lacks the `X-CSRF-Token` header
- WHEN the response is generated OR the form posts
- THEN `Set-Cookie` includes `HttpOnly`, `SameSite=Strict`, `Secure` (when not loopback) and a signed value, OR the server returns `403` and no mutation occurs.

### Requirement: Agent And Client CRUD

Pages to list, create, edit, and disable agents AND OAuth clients. Each row shows identifying fields plus `enabled` / `scopes` / `createdAt` / `lastLoginAt` (agents) or `clientId` / `label` / `scopes` / `lastUsedAt` (clients). UI generates a one-time plaintext password (agents) or client secret (clients) on create and rotate, displays it once, and stores only the `argon2id` hash.

#### Scenario: One-time secret and disable/rotate

- GIVEN the admin submits "create agent"/"create client", clicks "disable" on an agent, OR clicks "rotate secret" on a client
- WHEN the form posts
- THEN the response shows the plaintext in a one-time block with a `WARN` log, OR `enabled` is `false` and token requests return `400 account_disabled`, OR a new secret is hashed and shown once and the old secret returns `401 invalid_client`.

### Requirement: Scope Catalog Management

Page that lists the `scopes` table. Allows adding a new scope string and validates against `SCOPE_PATTERN` server-side. Refuses deletion of a scope currently assigned to any agent or client with a sanitized error naming the affected count.

#### Scenario: Delete blocked when in use

- GIVEN `read:bi_catastro` is assigned to 3 agents
- WHEN the admin submits "delete read:bi_catastro"
- THEN the server returns a sanitized error naming the count and no deletion occurs.

### Requirement: Refresh Token Revocation Page

Lists active refresh tokens with `agentId`, `clientId`, `issuedAt`, and a "revoke" action. The form sets `revokedAt` to now, appends an `audit_log` row, and returns the admin to the list with the row marked revoked.


#### Scenario: Revoke refresh token

- GIVEN the admin clicks "revoke"
- WHEN the form posts
- THEN `revokedAt` is set, the row is annotated as revoked, and `audit_log` records the action.

### Requirement: Audit Log Viewer And Login Backoff

Audit viewer paginates `audit_log` rows newest-first, filterable by `actor`, `action`, and date range. Displays `ts`, `actor`, `action`, `target`, `ip`, `outcome`. A `secretColumn: true` flag renders the value as `***`. Per-username login backoff: after 5 consecutive failures within 10 minutes, further attempts return `429`; state persisted in SQLite. Backoff applies only to the admin login form, not to `/oauth/token`.

#### Scenario: Secrets redacted and backoff scoped

- GIVEN an audit row whose `target` looks like a token, 5 failed admin logins for `root` in 10 minutes, OR backoff engaged for `root`
- WHEN the page renders, a 6th attempt arrives, OR a client posts to `/oauth/token`
- THEN the value is `***`, OR the response is `429`, OR a normal access token is returned.
