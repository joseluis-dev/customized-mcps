# Proposal: Unified MCP OAuth, Admin Auth, and Dark-Only UI

## Intent

Enable OpenCode-style clients (`opencode mcp auth <server>`) to discover every resource server via `mcp-oauth-admin` and complete the standard interactive Authorization Code + PKCE flow against pre-registered OAuth clients. Expose scope edits and `scopeInUse` counts in the admin UI. Switch the admin UI to dark-only.

## Scope

### In Scope
- **Resource-server discovery (RFC 9728):** every `401` from `mcp-http-base` MUST emit `WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource"` (with optional `scope` per RFC 6750 §3). Add `GET /.well-known/oauth-protected-resource` returning `{ resource, authorization_servers, bearer_methods_supported, scopes_supported }` per RFC 9728.
- **Auth-server metadata:** extend `/.well-known/openid-configuration` to advertise the standard `authorization_endpoint`, add `authorization_code` to `grant_types_supported`, keep `code_challenge_methods_supported: ["S256"]`.
- **Authorization Code + PKCE (pre-registered clients only):** implement `GET /oauth/authorize` (login form, consent, one-time `code`) and the `authorization_code` branch on `/oauth/token` with `code_verifier` S256 verification. Reuse the existing `users` table for login, existing session/CSRF helpers for the form, and the existing `clients` table. Restrict `redirect_uri` to loopback (`http://127.0.0.1:*`, `http://[::1]:*`, `http://localhost:*`) per RFC 8252 §7.3 — no schema change required.
- **Scope administration:** wire existing `setAgentScopes()` / `setClientScopes()` into the admin router; inline scope editing on agent/client pages; show `scopeInUse()` counts; write an `audit_log` row per change.
- **Dark-only admin UI:** replace light CSS in `apps/mcp-oauth-admin/src/admin/templates.ts` with a dark palette; declare `color-scheme: dark` in `renderLayout`. Class names unchanged.
- **Docs:** update both apps' `.env.example` files for the discovery endpoints and the new client path.

### Out of Scope (deferred)
- Dynamic Client Registration (DCR) — pre-registered clients only.
- Non-loopback `redirect_uri` registration — operators who need public web clients must add a `redirectUris` column in a follow-up.
- Light theme or theme toggle, broad UI redesign, unrelated grants.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `mcp-token-authority`: resource server MUST emit `WWW-Authenticate: Bearer resource_metadata="<url>"` on every 401; MUST serve `GET /.well-known/oauth-protected-resource` with RFC 9728 metadata.
- `mcp-oauth-authority`: OIDC discovery MUST advertise the standard `authorization_endpoint`; MUST add `authorization_code` to `grant_types_supported`; MUST implement `GET /oauth/authorize` (login form, consent, one-time `code`); `/oauth/token` MUST accept `grant_type=authorization_code` with `code_verifier` (PKCE S256).
- `mcp-admin-ui`: agent/client pages MUST allow editing the assigned scope set; scopes list MUST show `inUse` counts; rendered HTML MUST declare `color-scheme: dark` and use the dark palette.

## Approach

- **Discovery:** add the well-known handler in `packages/mcp-http-base/src/server.ts`; thread the authority URL through `parseHttpConfig()` (`MCP_AUTHORITY_URL` already exists); have the 401 path emit the `resource_metadata` header.
- **Auth-code grant:** add `GET/POST /oauth/authorize` in `apps/mcp-oauth-admin/src/oauth/authorize.ts`; add the `authorization_code` branch to `oauth/token.ts`; persist one-time `code`s in a short-lived in-memory map. Reuse `users` for login and the existing session/CSRF for the form. Loopback-only `redirect_uri` validation lives in the authorize handler.
- **Scope admin:** re-use existing `setAgentScopes` / `setClientScopes` / `scopeInUse`; add `POST /admin/agents/:id/scopes` and `POST /admin/clients/:id/scopes`; templates only.
- **Theme:** direct CSS color replacement in `templates.ts`; class names unchanged.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/mcp-http-base/src/{server,errors,index,config}.ts` | Modified | `/.well-known/oauth-protected-resource` handler, `resource_metadata` header, exports |
| `apps/mcp-oauth-admin/src/oauth/{jwks,authorize,token}.ts` | Modified | OIDC discovery adds `authorization_endpoint` + `authorization_code`; new authorize handler; auth-code branch in token handler |
| `apps/mcp-oauth-admin/src/index.ts` | Modified | Mount `/oauth/authorize` on the same listener |
| `apps/mcp-oauth-admin/src/admin/{router,templates}.ts` | Modified | Scope edit routes, dark theme CSS, scope usage display |
| `apps/mcp-oauth-admin/src/admin/{agents,clients,scopes}.ts` | Modified | Wire existing helpers (no new functions) |
| `apps/{mcp-oauth-admin,mcp-readonly-sql}/.env.example` | Modified | Document discovery + new client path |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Loopback-only `redirect_uri` blocks non-loopback public clients. | Med | Documented; follow-up adds a `redirectUris` column. |
| `WWW-Authenticate` change trips clients that don't ignore unknown params. | Low | Header is additive per RFC 6750; clients ignore unknown auth-params. |
| Scope edit leaves stale JWTs valid until `exp`. | Med | Admin warning; recommend revoke + re-issue. |
| Dark theme fails WCAG AA. | Med | Verified GitHub-dark tokens; templates test. |
| In-memory `code` map loses pending codes on restart. | Low | Codes are short-lived (≤60s); clients retry the authorize round-trip. |

## Rollback Plan

Revert commit. All changes are additive: well-known endpoints, the `WWW-Authenticate` header, `/oauth/authorize`, scope-edit routes, and the dark CSS are all removable without DB schema change. No migration.

## Dependencies

`OAuthAdminAuthority`, `setAgentScopes`, `setClientScopes`, `scopeInUse`, `auditAppend`, session/CSRF helpers, and `SCOPE_PATTERN` are all already in place. Loopback-only validation removes the need for a new schema column.

## Success Criteria

- [ ] Unauthenticated `GET /mcp` returns `401` with `WWW-Authenticate: Bearer resource_metadata="..."`.
- [ ] `GET /.well-known/oauth-protected-resource` returns RFC 9728 metadata with `authorization_servers`.
- [ ] OIDC discovery advertises `authorization_endpoint`, `authorization_code`, and `code_challenge_methods_supported: ["S256"]`.
- [ ] `opencode mcp auth <server>` completes against a pre-registered client: login, consent, redirect with `code`, token exchange with `code_verifier` succeeds.
- [ ] Loopback `redirect_uri` is accepted; non-loopback is rejected with a sanitized error.
- [ ] Admin can edit an agent's / client's scope set; `audit_log` records the change.
- [ ] Scopes list shows in-use count per scope.
- [ ] Admin pages render dark; `color-scheme: dark` declared in `renderLayout`.
- [ ] `pnpm --filter mcp-http-base test`, `pnpm --filter mcp-oauth-admin test`, `pnpm --filter mcp-readonly-sql test` pass.
- [ ] `pnpm --filter mcp-readonly-sql typecheck` passes.
