# mcp-admin-ui Specification

## Purpose

Server-rendered web admin UI alongside the OAuth2 endpoints in `apps/mcp-oauth-admin`. Operators manage agents, OAuth clients, refresh-token revocations, and inspect the audit log from a browser. Scope management is removed; scope values on agents/clients are inert legacy storage. Thin layer over the same SQLite store.

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

Pages to list, create, edit, and disable agents AND OAuth clients. Each row shows `enabled` / `createdAt` / `lastLoginAt` (agents) or `clientId` / `label` / `lastUsedAt` (clients). UI generates a one-time plaintext password/secret on create and rotate, displays it once, stores only the `argon2id` hash. The legacy `scopes` column is no longer surfaced through the admin UI: no row, column, field, or detail view is required to display it, and no edit affordance is required. The admin UI MUST NOT add a new detail page, column, or field whose purpose is to display the inert `scopes` value. Legacy `scopes` values remain in storage; operators inspect them via the SQLite file or another low-level path that is outside the admin UI.
(Previously: row showed `scopes` and an inline edit form. Now: no `scopes` display is required in the admin UI; legacy values remain in storage only.)

#### Scenario: One-time secret and disable/rotate, no scope surface in the UI

- GIVEN the admin submits "create agent"/"create client", clicks "disable" on an agent, OR clicks "rotate secret" on a client
- WHEN the form posts
- THEN the response shows the plaintext in a one-time block with a `WARN` log, OR `enabled` is `false` and token requests return `400 account_disabled`, OR a new secret is hashed and shown once and the old secret returns `401 invalid_client`
- AND the page does not render a "set scopes" form, an "edit scopes" button, a `POST .../scopes` action, OR a `scopes` column, cell, or field.

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

### Requirement: Dark-Only Color Scheme

The admin UI layout (`renderLayout`) MUST emit `<meta name="color-scheme" content="dark">` and the HTML root element MUST declare `color-scheme: dark` so browsers render native controls in dark mode. All CSS in `apps/mcp-oauth-admin/src/admin/templates.ts` MUST use a dark palette (background, text, borders, focus rings, form controls, warning/error boxes) and MUST NOT include a light theme or theme toggle. Class names MUST remain unchanged. Text vs. background contrast MUST meet WCAG AA (4.5:1 for normal text, 3:1 for large text).

#### Scenario: color-scheme declared, palette dark

- GIVEN any admin page
- WHEN the page renders
- THEN the HTML includes `color-scheme: dark` declaration
- AND no light theme rules remain in the styles.

### Requirement: Typecheck Gate

`pnpm --filter mcp-oauth-admin typecheck` MUST exit `0` after the changes are applied.

#### Scenario: Typecheck passes

- GIVEN the admin UI changes are in `apps/mcp-oauth-admin`
- WHEN `pnpm --filter mcp-oauth-admin typecheck` is run
- THEN the command exits `0`.

### Requirement: Scope UI Hidden

The admin UI MUST NOT render any active control, link, button, or form whose purpose is to create, edit, delete, or assign OAuth scopes (scope catalog page, "new scope" / "delete scope" forms, inline "set scopes" forms, `inUse` count column, scope nav entry). The admin UI MUST NOT render a `scopes` column, cell, field, or section whose purpose is to display the legacy `scopes` value on the agent list, client list, agent detail, or client detail. The rendered HTML MUST NOT contain any `POST .../scopes` form action, nor a `<td>` / `<th>` / `<div>` whose labeled purpose is to display the legacy `scopes` value. Legacy scope values remain in storage and MAY be exposed through low-level DB/export/debug paths; the admin UI is not required to display them.
(Previously: scope management was active and legacy `scopes` was shown as a read-only field. Now: scope management is hidden and the admin UI does not display legacy `scopes` at all.)

#### Scenario: No active scope controls in the UI

- GIVEN the admin UI templates and routes
- WHEN an operator inspects any rendered page (list, detail, new, edit) and greps the HTML and the router
- THEN no `<form method="POST" action=".../scopes">` element exists
- AND no link/button labeled "set scopes", "edit scopes", "new scope", "delete scope", or "scope catalog" is rendered
- AND the navigation does not link to a scope list page.

#### Scenario: No scopes column or field rendered in the admin UI

- GIVEN the admin UI templates for the agent list, client list, agent detail, and client detail
- WHEN an operator inspects the rendered HTML
- THEN no row, cell, field, or section labels the legacy `scopes` value
- AND the templates do not read `agent.scopes` or `client.scopes` for display purposes
- AND no scope string (e.g. `read:bi_catastro`) is rendered as inert text in any admin page.
