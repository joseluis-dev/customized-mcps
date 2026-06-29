# Proposal: oauth-sqlite-admin-authorization

## Intent

Replace the static HMAC + JSON agent roster with a real OAuth2 Authorization Server backed by SQLite, plus a web admin UI. MCP apps become pure resource servers validating OAuth tokens + scopes; operators manage state from a browser.

## Scope

**In:** `apps/mcp-oauth-admin` (port 3002) — OAuth2 AS, SQLite store, server-rendered web admin UI, per-app deploy templates; `OAuthAdminAuthority` wrapping `JwksAuthority` with startup self-probe; `MCP_AUTHORITY_URL` / `MCP_AUTHORITY_JWKS_URL` / `MCP_AUTHORITY_AUDIENCE` env wiring; three new + four modified specs; local-roster env vars deprecated.

**Out:** authorization-code grant (Phase 6); multi-writer storage; third-party IdP.

## Capabilities

**New:** `mcp-oauth-authority` (OAuth2 AS endpoints, RS256, bootstrap admin; default scope assignment: `read:<bound-profile>`, no `*`, elevation audit-logged); `mcp-admin-ui` (server-rendered admin, CRUD, audit log, CSRF); `mcp-authority-storage` (SQLite, WAL, single-writer, backup).

**Modified:** `mcp-agent-authorization` (drop v1 "no JWT" line; verified JWT scopes authoritative, no env/local widening); `app-independence` (append `Authority Isolation`); `mcp-http-transport` (port 3002 → `mcp-oauth-admin`); `mcp-deployment-templates` (multi-app, indexed runbook).

## Approach

`apps/mcp-oauth-admin` (port 3002) IS the authority: persists agents, clients, scopes, audit log in SQLite (WAL, `./data/mcp-oauth.sqlite`), exposes OAuth2 endpoints + server-rendered admin UI. Resource servers pick `OAuthAdminAuthority` when `MCP_AUTHORITY_URL` set; wrapper self-probes via `/oauth/introspect`; exits non-zero on unreachable.

### Locked defaults
- Bootstrap admin: env creds; `require-change-on-first-login`; WARN log while env set
- Per-app audience `mcp:<app-name>`; 3600s access tokens; refresh revocation in SQLite
- Audit retention 90d; CSRF: signed cookie (`SameSite=Strict; Secure; HttpOnly`) + double-submit

## Phase Split

- **0**: Ship `JwksAuthority` (from `external-token-authority-verification`)
- **1**: App skeleton + SQLite schema + DB layer
- **2**: OAuth2 endpoints + self-probe
- **3**: Web admin UI
- **4**: Migrate `mcp-readonly-sql` to OAuth; deprecate local-roster vars
- **5**: Remove local roster; authority owns default scope policy
- **6 (opt)**: Authorization-code flow with PKCE

## Affected Areas

| Area | Impact |
|------|--------|
| `apps/mcp-oauth-admin/` | New |
| `packages/mcp-http-base/src/authority/oauthAdmin.ts` | New |
| `apps/mcp-readonly-sql/src/{config/http,transports/http}.ts` | Modified |
| `apps/mcp-readonly-sql/.env.example` + `mcp-readonly-sql.agents.json` | Modified/Removed (Phase 5) |
| `packages/mcp-http-base/src/config.ts` | Modified |
| `deploy/README.md` | Modified |
| OpenSpec specs | New/Modified (3 new + 4 modified) |

## Risks

Authority unreachable → fail-closed 503 + startup self-probe. Bootstrap admin compromise → `require-change-on-first-login` + WARN. CSRF / brute force → signed cookie + SameSite + double-submit + per-username backoff. Phase 0: inline JWKS fallback. Phase 2/3: chained PRs.

## Rollback

Revert `mcp-oauth-admin` PRs, unset `MCP_AUTHORITY_URL`, restore `mcp-readonly-sql.agents.json` from git, revert spec deltas, delete new domain specs.

## Dependencies

`JwksAuthority` from `external-token-authority-verification` Phase 1b. New: `jose`, `argon2`. Reuse: `knex` + `sqlite3`.

## Success Criteria

Green build per phase; `MCP_AUTHORITY_URL` unset → local roster, set → JWTs validated (audit-safe 401/503); default scopes `read:<profile>` (no `*`); bootstrap admin refuses mint until rotated; resource servers don't import admin app; per-app deploy templates.
