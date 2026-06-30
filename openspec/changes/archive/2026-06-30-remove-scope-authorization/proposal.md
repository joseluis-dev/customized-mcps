# Proposal: Remove Scope Authorization

## Intent

Scope authorization was designed but never wired at the tool layer — `matchScope()` has zero runtime callers. Removing scope gating eliminates dead code across auth, tokens, tools, and admin UI while preserving all non-scope controls (sqlGuard, allowlists, auth).

## Scope

### In Scope
- Remove scope-based authorization from tool invocation
- Remove scope resolution from all 4 OAuth grants
- Remove scope extraction/filtering from JWT verification
- Hide/remove scope catalog CRUD and agent/client scope editing in admin UI
- `scopes_supported` → `[]` in OIDC and protected-resource metadata
- Remove scope catalog builder and `scopes_supported` env override
- Tolerate and ignore incoming `scope` request parameters (no rejection)
- Keep DB schema unchanged (legacy/inert columns and tables)
- Keep all non-scope controls unchanged

### Out of Scope
- Destructive DB migrations
- Admin UI read-only display cleanup of legacy scope values
- `Profile.scope` concept — not an OAuth scope

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `mcp-oauth-authority`: Remove scope from token issuance, consent, introspection, DCR. JWTs omit `scope`/`scopes`. Tolerate and ignore incoming `scope`.
- `mcp-agent-authorization`: Remove scope enforcement. Agent `scopes` decorative. `SCOPE_PATTERN` not enforced at runtime.
- `mcp-token-authority`: Remove scope extraction. `verify()` returns empty `scopes[]`. `scopes_supported` → `[]`.
- `mcp-tool-surface`: Remove scope-gated tool invocation. `requiredScope` preserved as decorative metadata — always passes.
- `mcp-admin-ui`: Remove scope catalog CRUD, agent/client scope editing, scope usage display. Scope pages/forms hidden.
- `mcp-authority-storage`: `scopes` columns and `scopes` table become legacy/inert. No destructive migration.
- `mcp-http-transport`: Remove per-request scope context from stateless scenario description.
- `app-independence`: Remove scope-based authorization requirement for future HTTP apps.

## Approach

Make scope authorization inert. Omit `scope`/`scopes` from JWTs (not wildcards). All grants stop resolving scopes. JWT verification returns empty `[]`. Admin UI hides scope pages. Incoming `scope` parameters tolerated and ignored. DB columns remain legacy storage. Backward-incompatible for admin UX and JWT claim consumers; compatible at tool layer (scopes were never enforced).

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| External consumers reading `scope` JWT claim | Medium | Omit claim entirely; document breaking change in CHANGELOG |
| Existing refresh tokens become full-access | High (security) | Intended per policy change; operators can revoke active tokens pre/post deploy for hard cutover |
| Admin scope UI removal confusion | Medium | Document in upgrade notes; values remain readable in DB |
| Test breakage | Medium | Update all scope-resolution test assertions |

## Rollback Plan

Revert the commit. DB schema untouched (no migrations), so rollback is `git revert` + redeploy. Old JWTs become valid again after JwksAuthority restoration.

## Dependencies

None.

## Success Criteria

- [ ] Every authenticated agent calls any tool regardless of scopes
- [ ] New JWTs omit `scope`/`scopes` claims
- [ ] `scopes_supported` returns `[]` in OIDC and protected-resource metadata
- [ ] Admin UI scope editing removed (forms/pages hidden)
- [ ] Existing SQLite DB continues without migration
- [ ] All non-scope safety controls still pass tests
- [ ] TypeScript strict mode passes across all packages
