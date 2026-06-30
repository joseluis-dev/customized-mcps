## Exploration: Unified OAuth Authentication & Admin Refinements

### Current State

The workspace has two TypeScript apps and one shared package forming an OAuth2 architecture:

**Authority** (`apps/mcp-oauth-admin`, port 3002):
- Full OAuth2 AS with `client_credentials`, `password`, `refresh_token` grants
- RS256 JWT signing via auto-generated keys, exposed via `/.well-known/jwks.json`
- OIDC discovery via `/.well-known/openid-configuration` (no `authorization_endpoint` in v1)
- Token introspection via `POST /oauth/introspect`
- Admin UI at `/admin/` with server-rendered HTML (session cookies, CSRF, agents/clients/scopes CRUD, audit log, refresh token revocation)
- Scope catalog (`scopes` table) with create/list/delete; scope validation via `SCOPE_PATTERN = /^(read|list|call):(\*|[A-Za-z0-9_.-]+)$/i`
- Bootstrap admin with first-login rotation, per-username login backoff
- SQLite persistence with 7 tables (users, clients, scopes, keys, refresh_tokens, audit_log, login_backoff)

**Resource Server** (`apps/mcp-readonly-sql`, port 3001):
- MCP Streamable HTTP transport via shared `@customized-mcps/mcp-http-base`
- Token verification via `OAuthAdminAuthority` (extends `JwksAuthority`): validates RS256 JWTs against the authority's JWKS cache + startup introspect probe
- Serves only `/mcp` (MCP protocol) and `/healthz`
- Requires `Authorization: Bearer <token>` on every request; 401 on missing/invalid token

**Shared Package** (`packages/mcp-http-base`):
- Server: `createHttpMcpServer()` — HTTP listener, bearer token check, session management, body limits, health endpoint
- Errors: `unauthorizedError()` — returns 401 JSON-RPC body but NO `WWW-Authenticate` header
- Auth: `SCOPE_PATTERN`, `matchScope`, `isValidScope` grammar
- Authorities: `TokenAuthority` interface, `JwksAuthority`, `OAuthAdminAuthority`
- Config: `parseHttpConfig()` — reads `MCP_AUTHORITY_URL`, audience, JWKS, etc.

### Key Gaps

1. **No OAuth resource server metadata**: The resource server serves NO `/.well-known/` endpoints. OpenCode's `opencode mcp auth <server>` cannot discover the authority.
2. **No `WWW-Authenticate` header**: The 401 response from `unauthorizedError()` sends a JSON-RPC body but no `WWW-Authenticate: Bearer realm=...` header per RFC 6750/ RFC 9728. MCP OAuth clients discover the authority URL from this header.
3. **No authorization code grant**: The authority explicitly omits `authorization_endpoint` (Phase 6). OpenCode's interactive `mcp auth` browser flow requires this. `client_credentials` works but is non-interactive.
4. **No scope editing UI**: `setAgentScopes()` and `setClientScopes()` exist but are NOT wired into the admin router. Scopes are set at creation time only.
5. **Light theme only**: All CSS in `templates.ts` is light-themed with hardcoded colors.
6. **No Dynamic Client Registration (DCR)**: Not supported.

### Approaches

#### Area 1: OAuth Discovery for OpenCode compat

**1A. Add WWW-Authenticate + `.well-known/oauth-protected-resource` (Minimum Viable)**
- Add `WWW-Authenticate: Bearer realm="mcp", scope="...", authorization_uri="http://auth:3002/oauth/authorize"` header to the 401 response in `errors.ts` (or `server.ts`)
- Add `GET /.well-known/oauth-protected-resource` endpoint to `server.ts` that returns the MCP OAuth protected resource metadata (points to authority endpoints)
- Optional: Add `GET /.well-known/oauth-authorization-server` that redirects to the authority's `openid-configuration`
- Pros: Enables OpenCode's `mcp auth` discovery path; enables client_credentials flow (already works); ~50-100 LOC
- Cons: Interactive browser auth still requires the auth-code grant (deferred)
- Effort: Low

**1B. Add Authorization Code Grant + PKCE (Full Flow)**
- Add `GET /oauth/authorize` endpoint on the authority
- Implement login form, consent, redirect_uri validation, state, PKCE (S256)
- Add `authorization_code` to `grant_types_supported` in OIDC discovery, remove the explicit "Phase 6" omission
- Wire the token endpoint for `authorization_code` grant
- Pros: Full interactive OAuth flow; OpenCode `mcp auth` works end-to-end
- Cons: Significant implementation (~500+ LOC); login form duplicates admin UI login; PKCE verification; redirect_uri whitelisting; state management
- Effort: High

**1C. Hybrid: Discovery + document client_credentials workflow**
- Implement 1A for discovery
- Document that operators should create clients via admin UI and configure OpenCode with `oauth.clientId`/`oauth.clientSecret` (non-interactive path)
- Pros: Minimum viable; unblocks OpenCode for pre-configured clients
- Cons: Interactive `opencode mcp auth` browser flow still wont work
- Effort: Low

#### Area 2: Scope Administration

**2A. Wire existing scope editing functions into admin UI**
- Add routes: `POST /admin/agents/:id/scopes` calling `setAgentScopes()`
- Add routes: `POST /admin/clients/:id/scopes` calling `setClientScopes()`
- Update agent/client list templates to show editable scope fields (inline or modal form)
- Add audit_log entries for scope changes
- Pros: Functions already exist; small code change; audit safety built-in
- Cons: UI needs new form components and validation
- Effort: Low-Medium

**2B. Add scope usage display**
- Show `scopeInUse()` count on the scopes list page (how many agents/clients use each scope)
- Show assigned scopes inline on agent/client detail pages
- Pros: Immediate visibility for operators
- Cons: Extra DB queries per page render
- Effort: Low (add to existing `renderScopesList`)

#### Area 3: Dark-Only Theme

**3A. Replace CSS color values in templates.ts**
- Replace light colors with dark equivalents
- Add `<meta name="color-scheme" content="dark">` in `renderLayout`
- Key changes: background (#1a1a1a → #0d1117 or similar), text (#fff → #e6edf3), borders, button colors, warning/error boxes
- Pros: Explicit, no unexpected visual side effects
- Cons: Manual color mapping
- Effort: Low

**3B. CSS filter approach**
- Keep current colors but add `html { filter: invert(1) hue-rotate(180deg); }` plus re-invert of images
- Pros: One-liner
- Cons: Unpredictable rendering; images invert twice; harder to maintain
- Effort: Very Low but Not Recommended

### Recommendation

**Phase 1 (Minimum Viable — this change):**
- **Area 1**: Approach 1C — Add `WWW-Authenticate` header + `/.well-known/oauth-protected-resource` to enable discovery + document client_credentials workflow
- **Area 2**: Approach 2A + 2B — Wire scope editing routes and add scope usage display
- **Area 3**: Approach 3A — Dark-only theme via direct CSS replacement

**Phase 2 (Future):**
- Full authorization code grant + PKCE when interactive browser flow is needed
- Dynamic Client Registration (DCR) if operator self-service is required

### Risks

- **Discovery without auth-code**: `opencode mcp auth <server>` in interactive mode will fail at the browser step until Phase 2. The user must use the `oauth.clientId`/`oauth.clientSecret` config path. This MUST be clearly documented.
- **Scope editing without constraint enforcement**: Agents/clients that have scopes removed mid-session will continue to hold valid JWTs with the old scope set until token expiry (1h). Operators must understand this and coordinate token expiry or revocation.
- **Dark theme accessibility**: Ensure sufficient contrast ratios (WCAG AA) with the chosen dark palette. Avoid pure black backgrounds.
- **WWW-Authenticate header content**: The header includes `authorization_uri`. If the auth-code endpoint is unimplemented, OpenCode may show a confusing error to the user. Consider omitting `authorization_uri` or pointing it to a placeholder that returns a clear "not implemented" response.

### Affected Areas

- `packages/mcp-http-base/src/server.ts` — Add `/.well-known/oauth-protected-resource` handler; modify 401 response to include `WWW-Authenticate` header
- `packages/mcp-http-base/src/errors.ts` — Add `WWW-Authenticate` to the `unauthorizedError()` envelope
- `packages/mcp-http-base/src/index.ts` — Export new well-known handler types
- `apps/mcp-oauth-admin/src/admin/router.ts` — Wire `setAgentScopes`/`setClientScopes` routes; add scope usage endpoints
- `apps/mcp-oauth-admin/src/admin/templates.ts` — Dark theme CSS replacement; scope editing forms; scope usage display
- `apps/mcp-oauth-admin/src/admin/agents.ts` — `setAgentScopes` already exists (verify exports)
- `apps/mcp-oauth-admin/src/admin/clients.ts` — `setClientScopes` already exists (verify exports)
- `apps/mcp-oauth-admin/src/admin/scopes.ts` — `scopeInUse` already exists
- `apps/mcp-oauth-admin/src/index.ts` — No changes needed (authority already has well-known endpoints)
- `apps/mcp-readonly-sql/.env.example` — Potentially update docs with the new OAuth discovery info

### Tests/Spec Areas That Must Be Updated

- `packages/mcp-http-base/test/server.test.ts` — Tests for `/.well-known/oauth-protected-resource` and WWW-Authenticate header on 401
- `packages/mcp-http-base/test/errors.test.ts` — Test that `unauthorizedError()` includes the header
- `apps/mcp-oauth-admin/test/admin/router.test.ts` — Tests for new scope editing routes
- `apps/mcp-oauth-admin/test/admin/templates.test.ts` — Snapshot/baseline updates for dark theme
- `apps/mcp-oauth-admin/test/admin/scopes.test.ts` — Tests for `scopeInUse` counts (if enhanced)
- `apps/mcp-oauth-admin/test/admin/agents.test.ts` — `setAgentScopes` tests
- `apps/mcp-oauth-admin/test/admin/clients.test.ts` — `setClientScopes` tests
- `openspec/specs/mcp-token-authority/spec.md` — Add requirement for OAuth discovery metadata
- `openspec/specs/mcp-oauth-authority/spec.md` — Add `authorization_uri` to discovery spec
- `openspec/specs/mcp-admin-ui/spec.md` — Add scope editing requirement

### Ready for Proposal

Yes. The exploration is complete. The orchestrator can tell the user:

"Exploration complete. The minimum viable change covers: (1) OAuth resource server discovery so OpenCode can authenticate via client_credentials path (adds WWW-Authenticate header + `/.well-known/oauth-protected-resource`), (2) wiring scope editing into the admin UI (the functions exist but are not routed), (3) switching the admin UI to dark-only theme. Full authorization-code flow and DCR are deferred to a follow-up change. 14 files affected across 3 packages. Ready for proposal phase."
