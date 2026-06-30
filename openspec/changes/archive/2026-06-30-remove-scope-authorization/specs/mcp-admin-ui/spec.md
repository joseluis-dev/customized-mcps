# Delta for mcp-admin-ui

## MODIFIED Requirements

### Requirement: Agent And Client CRUD

Pages to list, create, edit, and disable agents AND OAuth clients. Each row shows `enabled` / `createdAt` / `lastLoginAt` (agents) or `clientId` / `label` / `lastUsedAt` (clients). UI generates a one-time plaintext password/secret on create and rotate, displays it once, stores only the `argon2id` hash. The legacy `scopes` column is no longer surfaced through the admin UI: no row, column, field, or detail view is required to display it, and no edit affordance is required. The admin UI MUST NOT add a new detail page, column, or field whose purpose is to display the inert `scopes` value. Legacy `scopes` values remain in storage; operators inspect them via the SQLite file or another low-level path that is outside the admin UI.
(Previously: row showed `scopes` and an inline edit form. Now: no `scopes` display is required in the admin UI; legacy values remain in storage only.)

#### Scenario: One-time secret and disable/rotate, no scope surface in the UI

- GIVEN the admin submits "create agent"/"create client", clicks "disable" on an agent, OR clicks "rotate secret" on a client
- WHEN the form posts
- THEN the response shows the plaintext in a one-time block with a `WARN` log, OR `enabled` is `false` and token requests return `400 account_disabled`, OR a new secret is hashed and shown once and the old secret returns `401 invalid_client`
- AND the page does not render a "set scopes" form, an "edit scopes" button, a `POST .../scopes` action, OR a `scopes` column, cell, or field.

## REMOVED Requirements

### Requirement: Scope Catalog Management

(Reason: scope authorization is removed; the `scopes` table is legacy/inert. The admin scope list page, create-scope form, and delete-scope form are removed.)
(Migration: agents and clients retain `scopes` JSON columns as inert storage; admin UI is not required to expose them. The 400 `invalid_scope` token error and `SCOPE_PATTERN` validation are removed from this surface.)

### Requirement: Agent And Client Scope Editing

(Reason: scope editing from the admin UI is removed. `POST /admin/agents/:id/scopes` and `POST /admin/clients/:id/scopes` are no longer routed; the `setAgentScopes()` / `setClientScopes()` helpers are no longer called. The `agent.set_scopes` / `client.set_scopes` audit_log action values are no longer emitted.)
(Migration: the routes return `404` (or are not registered). Existing `audit_log` rows with those action values remain in storage; no new rows are appended. The audit log viewer is not required to display them.)

### Requirement: Scope Usage Display

(Reason: the `inUse` count for each scope is no longer computed or displayed because the scope list page is removed.)
(Migration: none - the `scopeInUse()` helper may remain in source as a legacy export but is not wired to any admin route or template.)

## ADDED Requirements

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
