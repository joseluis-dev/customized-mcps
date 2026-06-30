## Exploration: Remove Scope Authorization

### Current State

The monorepo has scope authorization logic embedded across all three packages, but the system is in an **incomplete state**: scopes are issued, parsed, transmitted, and stored — but never actually enforced at the tool layer.

**What scopes DO today:**

1. **Token verification** (`packages/mcp-http-base/`): `JwksAuthority.verify()` extracts the `scopes` claim from the JWT, filters against `SCOPE_PATTERN`, and returns `{agentId, scopes}` in `VerifiedToken`. The server middleware attaches `{clientId, scopes}` to `req.auth`. The well-known metadata endpoint advertises `scopes_supported`.

2. **Token issuance** (`apps/mcp-oauth-admin/`): All four OAuth grants (`client_credentials`, `password`, `refresh_token`, `authorization_code`) resolve scopes via `resolveGrantedScopes()`. The JWT is minted with `scope` and `scopes` claims. Introspection returns the scopes.

3. **Scope management** (`apps/mcp-oauth-admin/`): Admin UI has full scope catalog CRUD (`scopes` table), agent scope assignment (`users.scopes` JSON column), client scope assignment (`clients.scopes` JSON column). DCR registration bounds requested scopes against the catalog.

4. **Scope catalog for metadata** (`apps/mcp-readonly-sql/`): `scopeCatalog.ts` builds a scope catalog from profile aliases (`read:<alias>`, `list:<alias>`) or `MCP_RESOURCE_SCOPES` env override. This is used ONLY for the `/.well-known/oauth-protected-resource` metadata endpoint.

**What scopes do NOT do today:**

- `apps/mcp-readonly-sql/src/tools/readonlyTools.ts` does NOT call `matchScope()` or check `req.auth` / `agentId` at the tool layer. Scope enforcement was **spec-ed but never implemented** in the tool handlers. The E2E tests use permissive assertions that tolerate any non-success response (the error comes from a missing SQLite demo DB, not from scope enforcement).
- The `Profile.scope` field ("server" | "database") is a DB-level concept (connection scope), NOT an OAuth authorization scope. It is explicitly not used as an OAuth scope.
- `matchScope()` from `auth.ts` is never called in any runtime path.

### Real safety controls that MUST remain

These are independent of scope authorization and must be kept:
- **SQL read-only guard** (`sqlGuard.ts`): AST-level rejection of write/DDL statements
- **Profile/database allowlists**: `DB_<name>_ALLOWED_DATABASES` per profile
- **Body size limits**: `maxBodyBytes` in shared base
- **TLS/reverse proxy posture**: loopback-only binding, `behindProxy` flag
- **JWT signature/issuer/audience validation**: `JwksAuthority` already validates these independently of scopes
- **Admin session security**: signed cookies, CSRF, backoff
- **Refresh-token revocation**: `refresh_tokens.revokedAt` column
- **Agent authentication**: password hashing (argon2id), enable/disable, rotation
- **Client authentication**: client_secret verification for all grants
- **Authorization code + PKCE**: loopback redirect, S256 challenge
- **Audit logging**: `audit_log` table for all state-changing operations

### Affected Areas

#### Must modify

| File | Why affected |
|------|-------------|
| `packages/mcp-http-base/src/auth.ts` | `SCOPE_PATTERN`, `isValidScope`, `matchScope` — the grammar and matcher. These become no-ops or can be simplified to always-allow. |
| `packages/mcp-http-base/src/authority/types.ts` | `VerifiedToken.scopes` — the scopes array in the verification result. Can be removed or set to a constant full-access sentinel. |
| `packages/mcp-http-base/src/authority/jwks.ts` | `extractScopesClaim()`, `filterScopes()` — the scope extraction/filtering from JWT payloads. Should be removed or made into a no-op. |
| `packages/mcp-http-base/src/server.ts` | Attaches `scopes` to `req.auth` (line 591-594). Can drop the scopes array. `scopeCatalog` option for well-known can be removed/simplified. |
| `packages/mcp-http-base/src/index.ts` | Public exports of `SCOPE_PATTERN`, `isValidScope`, `matchScope`, `Scope` type. These are the public API surface. |
| `packages/mcp-http-base/test/scope.test.ts` | Tests for scope grammar/matching — needs removal or simplification. |

#### Must modify (oauth-admin)

| File | Why affected |
|------|-------------|
| `apps/mcp-oauth-admin/src/oauth/scopes.ts` | The entire scope resolution engine (`resolveGrantedScopes`, `loadScopePrincipal`, `boundRegistrationScope`, `parseJsonStringArray`, `joinScopeList`). The biggest removal surface. |
| `apps/mcp-oauth-admin/src/oauth/token.ts` | All four grant handlers resolve scopes and include `scope`/`scopes` in JWT claims and response. |
| `apps/mcp-oauth-admin/src/oauth/authorize.ts` | Code record stores `scopes`; consent handler resolves scopes. |
| `apps/mcp-oauth-admin/src/oauth/introspect.ts` | Filters scopes in introspect response. |
| `apps/mcp-oauth-admin/src/oauth/register.ts` | DCR scope bounding against catalog. |
| `apps/mcp-oauth-admin/src/admin/scopes.ts` | Scope catalog CRUD — the `scopes` table management. Can be made read-only or removed. |
| `apps/mcp-oauth-admin/src/admin/agents.ts` | `setAgentScopes`, `createAgent` validates scopes via `SCOPE_PATTERN`, agent record includes `scopes` field. |
| `apps/mcp-oauth-admin/src/admin/clients.ts` | `setClientScopes`, `createClient` validates scopes via `SCOPE_PATTERN`, client record includes `scopes` field. |
| `apps/mcp-oauth-admin/src/admin/router.ts` | Admin UI routes for scope management (CRUD endpoints, agent/client scope editing). |
| `apps/mcp-oauth-admin/src/admin/templates.ts` | UI templates that display/edit scopes on agent, client, scope-catalog, and refresh-token pages. |
| `apps/mcp-oauth-admin/src/db/schema.ts` | `scopes` table, `users.scopes` column, `clients.scopes` column, `refresh_tokens.scopes` column. |
| `apps/mcp-oauth-admin/src/admin/bootstrap.ts` | Seeds the bootstrap admin with scopes. |
| `apps/mcp-oauth-admin/src/admin/refresh.ts` | Refresh token record includes `scopes`. |
| `apps/mcp-oauth-admin/src/index.ts` | Wires scope-related handlers. |

#### Must modify (readonly-sql)

| File | Why affected |
|------|-------------|
| `apps/mcp-readonly-sql/src/config/scopeCatalog.ts` | The scope catalog builder — purely for metadata, can be removed or made into a no-op. |
| `apps/mcp-readonly-sql/src/transports/http.ts` | Forwards `scopeCatalog` to shared base. |
| `apps/mcp-readonly-sql/src/index.ts` | Builds and wires `scopeCatalog` closure. |

#### Tests that need updates

| File | Why affected |
|------|-------------|
| `packages/mcp-http-base/test/scope.test.ts` | Tests `SCOPE_PATTERN`, `isValidScope`, `matchScope` — needs removal/simplification. |
| `packages/mcp-http-base/test/serverContract.test.ts` | Asserts `req.auth` shape including `scopes`. |
| `packages/mcp-http-base/test/server.test.ts` | May reference scopes in test context. |
| `packages/mcp-http-base/test/authority/jwks.test.ts` | Tests scope extraction/filtering in JwksAuthority. |
| `apps/mcp-oauth-admin/test/oauth/scopes.test.ts` | The largest scope test file (406 lines) — tests `resolveGrantedScopes` and `boundRegistrationScope`. |
| `apps/mcp-oauth-admin/test/oauth/token.test.ts` | Tests scope resolution per grant. |
| `apps/mcp-oauth-admin/test/oauth/authorize.test.ts` | Tests scope in authorization code flow. |
| `apps/mcp-oauth-admin/test/oauth/introspect.test.ts` | Tests scope in introspect response. |
| `apps/mcp-oauth-admin/test/oauth/register.test.ts` | Tests DCR scope bounding. |
| `apps/mcp-oauth-admin/test/admin/scopes.test.ts` | Tests scope catalog CRUD. |
| `apps/mcp-oauth-admin/test/admin/agents.test.ts` | Tests `setAgentScopes`. |
| `apps/mcp-oauth-admin/test/admin/clients.test.ts` | Tests `setClientScopes`. |
| `apps/mcp-oauth-admin/test/admin/router.test.ts` | Tests admin UI scope routes. |
| `apps/mcp-readonly-sql/test/config/scopeCatalog.test.ts` | Tests scope catalog builder. |
| `apps/mcp-readonly-sql/test/authorityE2E.test.ts` | Has "Missing scope denies" E2E test that needs updating. |
| `apps/mcp-readonly-sql/test/transports/http.test.ts` | Tests well-known metadata including `scopes_supported`. |

### Approaches

1. **Minimal — make scopes inert (recommended)** — Keep all DB columns/tables as inert/legacy, remove runtime authorization decisions around scopes, simplify token issuance to always include a fixed set or omit the claim.
   - Pros: No destructive migrations, minimal disruption to operators, easy rollback
   - Cons: Leaves dead columns in DB, UI still shows scope fields (they become irrelevant)
   - Effort: Medium

2. **Full removal** — Drop `scopes` table, remove `scopes` columns from `users`, `clients`, `refresh_tokens`, purge from admin UI entirely.
   - Pros: Cleanest result, no dead code
   - Cons: Destructive data migration, risk of operator confusion, breaking change for any API consumer reading scopes
   - Effort: High

3. **Layered — inert first, cleanup later** — Phase 1: make scopes inert (approach 1). Phase 2 (separate change): cleanup DB/API.
   - Pros: Safest migration, operators can validate at each step, reversible
   - Cons: Two changes to track
   - Effort: Medium (split across two changes)

### Recommendation

**Approach 1 — Minimal/Make inert.** Reasons:

1. The spec already recommends treating existing DB columns as legacy/inert. No destructive migration means existing SQLite databases continue to work without schema changes.
2. The admin UI can keep showing scope fields but they become decorative — the user intent says "remove authorization", not "clean up every vestige immediately."
3. The JWT `scope`/`scopes` claims can be replaced with a constant sentinel (e.g. `read:* list:* call:*`) or omitted entirely, depending on whether any external consumers read those claims.
4. The `matchScope()` function already has zero callers in runtime code, so removing it has no behavioral impact.
5. The E2E tests already prove scope enforcement was never wired at the tool layer — the test assertions are permissive enough to pass without it.

**Key design decisions:**
- DB columns (`users.scopes`, `clients.scopes`, `refresh_tokens.scopes`, `scopes` table): Keep, mark as inert/legacy. No migration needed.
- Token issuance: Remove scope resolution from all four grants. Issue JWT with `scope: "*"` or omit `scope`/`scopes` claims entirely. The `sub` claim (`user:<id>` / `client:<id>`) remains the authentication identity.
- Token verification (`JwksAuthority`): Stop extracting/filtering `scopes` from JWT. `VerifiedToken` can drop `scopes` or set it to `["*"]`.
- Admin UI: Remove scope edit forms and scope catalog pages. The scope-related fields on agent/client detail pages become read-only (display existing values but no edit capability).
- `scopes_supported` in well-known metadata: Remove or set to `[]`.
- `matchScope()` / `SCOPE_PATTERN` / `isValidScope`: Remove from public API or deprecate.
- DCR registration: Remove scope bounding. Newly registered clients get all-access by default.
- Introspect endpoint: Remove `scope` from RFC 7662 response or set to `"*"`.

### Risks

- **Operator confusion**: Operators who currently manage scopes in the admin UI will find scope features removed. This is a breaking UX change. Must be documented in upgrade notes.
- **API breaking for external token consumers**: If any external system reads the `scope`/`scopes` claims from the issued JWT, changing these values could break that consumer. Need to verify no external consumers before this change.
- **Refresh token stored scopes**: Existing refresh tokens in the DB have `scopes` JSON columns. The refresh token handler currently re-resolves scopes against the principal intersection. Without scope resolution, the behavior changes (would grant full access instead). This could be a privilege escalation for tokens that were previously scope-bound — need to carefully handle this to avoid security regression.
- **Introspect endpoint breaking**: External systems that call `/oauth/introspect` and read the `scope` field in the response may break if the value changes.
- **well-known metadata consumers**: MCP clients that read `scopes_supported` from `/.well-known/oauth-protected-resource` to decide which scopes to request may be affected.
- **E2E test "Missing scope denies"**: The test at `authorityE2E.test.ts:646` expects a "missing scope" error. Removing scopes would break this test — it needs to be rewritten.

### Ready for Proposal

**Yes.** The exploration identified the full scope surface and all affected files. The orchestrator should proceed to `sdd-propose` with the minimal/make-inert approach.

Key points for the proposal:
- Change is **backward-incompatible** for admin UI users (scope management removed) and for any external consumer of `scope`/`scopes` JWT claims or introspect `scope` field. It is **backward-compatible** for resource-server tool calls (scopes were never enforced at the tool layer).
- The JWT `scope` claim strategy (constant `"*"` vs. omit) needs a design decision in the proposal phase.
- DB schema changes are intentionally NOT part of this change — existing columns become inert/legacy.
