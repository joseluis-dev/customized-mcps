# Changelog

All notable changes to the customized-mcps workspace.

## [Unreleased] — `remove-scope-authorization`

### Breaking Changes

- **`scope` / `scopes` JWT claim removed.** The `remove-scope-authorization` change makes scope authorization inert end-to-end. New JWTs no longer carry a `scope` or `scopes` claim; existing refresh tokens continue to mint scope-free access tokens. External consumers that read the `scope` claim MUST be updated to either omit the claim check or pin to a hardcoded value. See the `mcp-oauth-authority` spec for the wire contract.
- **Admin UI scope controls hidden.** The `/admin/scopes`, `/admin/scopes/create`, `/admin/scopes/:name/delete`, `/admin/agents/:id/scopes`, and `/admin/clients/:id/scopes` routes are no longer registered. A request to any of these URLs returns `404 not_found`. The admin UI does not render a `Scopes` / `Current scopes` / `Edit scopes` column, a `scopes` form input, or a link to a scope catalog page.
- **`@customized-mcps/mcp-http-base` no longer exports `SCOPE_PATTERN`, `isValidScope`, `Scope`, or `matchScope`.** The shared base's public surface is now scope-free.

### Operator Notes

- **DB schema is unchanged.** Legacy `scopes` columns on `users`, `clients`, and `refresh_tokens`, plus the `scopes` table itself, remain inert storage. No destructive migration is applied.
- **Existing refresh tokens are full-access.** Per policy, this change makes all scope authorization inert. A pre-existing refresh token, when exchanged, now mints a scope-free access token. Operators that require a hard cutover can revoke every active refresh token via `/admin/refresh-tokens` (the admin UI is unchanged for refresh-token revocation).
- **DCR `scope` response field is `""`.** Dynamic Client Registration continues to return a `scope` field for RFC 7591 compliance; the value is the empty string. Incoming `scope` on `/oauth/register`, `/oauth/authorize`, and `/oauth/token` is tolerated and ignored (no `invalid_scope` error).
- **Audit log rows.** Historical `agent.set_scopes` / `client.set_scopes` / `scope.create` / `scope.delete` rows in `audit_log` remain in storage. No new rows with these action values are emitted. The audit log viewer renders `action` and `target` columns which may display these legacy action strings when viewing older entries; new entries use the remaining actions (agent/client create/delete/enable/disable, session login/logout, etc.).

### Internal Changes

- `mcp-http-base`: `SCOPE_PATTERN`, `isValidScope`, `Scope`, and `matchScope` are removed from `auth.ts` and `index.ts` (was a `@deprecated` cross-slice compat shim in PR 3).
- `mcp-readonly-sql`: `scopeCatalog.ts` deleted; `requiredScope` is decorative metadata (the tool surface never enforced it).
- `mcp-oauth-admin`:
  - OAuth layer (PR 3): all 4 grants mint scope-free tokens; `introspect` and `register` omit the `scope` field; DCR returns `scope: ""`.
  - Admin layer (PR 4): `admin/scopes.ts` deleted; the scope-catalog CRUD, scope-edit, and scope-list routes are unregistered; the `setAgentScopes` / `setClientScopes` helpers are removed; the `scopes` input is removed from `createAgent` / `createClient`; the agents / clients / refresh-tokens templates no longer render a `Scopes` / `Current scopes` / `Edit scopes` column; the dashboard nav no longer links to a scope catalog page; the operator CLI `pnpm create:client` no longer accepts `--scope`.
  - Token responses no longer carry a `scope` field. Introspection no longer carries a `scope` field.
