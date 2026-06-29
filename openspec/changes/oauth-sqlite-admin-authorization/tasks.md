# Tasks: OAuth2 SQLite Admin Authorization

## Review Workload Forecast
- Estimated changed lines: 1700-2500 across 3 PRs.
- 1200-line budget risk: High. Chained PRs recommended: Yes.
- Delivery strategy: auto-forecast. Chain strategy: stacked-to-main (user-selected).
- PR 1 (base: main, blocks on JwksAuthority): skeleton+SQLite+OAuth2+self-probe.
- PR 2 (base: main; lands after PR 1): admin UI (CRUD, sessions, CSRF, audit).
- PR 3 (base: main; lands after PR 2): wire readonly-sql; remove local roster + deploy.

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

## Guard rails
- Authority owns `read:<bound-profile>` defaults, no `*`, elevation audit-logged.
- Resource servers: verified JWT scopes only; fail closed on missing scope.
- Audience `MCP_AUTHORITY_AUDIENCE=mcp:<logical-app-id>` (e.g. `mcp:readonly-sql`).
- No `MCP_MIN_DEFAULT_SCOPES` on resource servers.

## Phase 0: Prerequisite
- [ ] 0.1 BLOCKED — Phase 1b `JwksAuthority` is now implemented, verified, and archived locally in `external-token-authority-verification` (2026-06-29), but it is not committed/merged yet. Evidence now exists in `packages/mcp-http-base/src/authority/jwks.ts`, `packages/mcp-http-base/test/authority/jwks.test.ts`, and `openspec/changes/archive/2026-06-29-external-token-authority-verification/verify-report.md`. PR 1 must not start until this prerequisite is committed and merged.

## Phase 1: App skeleton + SQLite (PR 1)
- [ ] 1.1 Test 7 tables, audit `actor` free-text, FKs ON; knex schema + idempotent migrations.
- [ ] 1.2 Test WAL, single-writer mutex, 5-retry SQLITE_BUSY, `MCP_OAUTH_DB_PATH`; implement.
- [ ] 1.3 Test online backup atomic + `MCP_OAUTH_BACKUP_INTERVAL_S`; implement `backup.ts`.
- [ ] 1.4 Test sweep `audit_log >90d` + revoked `refresh_tokens >30d`; implement `sweep.ts`.

## Phase 2: OAuth2 + self-probe (PR 1)
- [ ] 2.1 Test JWKS (public-only) + OIDC discovery; no `/oauth/authorize`; implement.
- [ ] 2.2 Test RS256 JWT: `iss`, `aud=mcp:<app>`, `sub`, `scope`, `iat/nbf/exp`, `kid`, TTL 3600.
- [ ] 2.3 Implement `oauth/token.ts`; refuse `*` mixed; default new client to `read:<bound-profile>`.
- [ ] 2.4 Test introspect + refresh grant rejects `revokedAt != null`; implement.
- [ ] 2.5 Test `OAuthAdminAuthority.warm()` POSTs introspect; exits non-zero on refuse/5xx; implement.
- [ ] 2.6 Wire `apps/mcp-readonly-sql/src/config/http.ts` to use `OAuthAdminAuthority` when `MCP_AUTHORITY_URL` set.

## Phase 3: Admin UI (PR 2)
- [ ] 3.1 Test session: signed cookie, 32-byte secret, CSRF double-submit 403; implement + rotation.
- [ ] 3.2 Test per-username backoff 5 fails/10m -> 429; not on `/oauth/token`; implement.
- [ ] 3.3 Test agent CRUD: one-time plaintext, `argon2id`, `requireChangeOnFirstLogin`; bootstrap refuses mint; WARN; implement.
- [ ] 3.4 Test client CRUD + scope catalog (refuse delete when assigned); revocation + audit row; implement.
- [ ] 3.5 Test audit viewer paginate, filter, redact; 91d row swept; implement + refactor templates.

## Phase 4: Migrate readonly-sql (PR 3)
- [ ] 4.1 Test: `MCP_AUTHORITY_URL` set, verified JWT scopes authorize only; missing scope denies.
- [ ] 4.2 Wire `apps/mcp-readonly-sql/src/{config/http,transports/http}.ts`; local roster fallback.
- [ ] 4.3 Test `Authority Isolation`: no import/symlink/workspace-dep on `apps/mcp-oauth-admin`.

## Phase 5: Remove local roster + deploy (PR 3)
- [ ] 5.1 Test one-shot WARN naming `MCP_AGENTS_JSON`/`MCP_AGENTS_INLINE`/`MCP_AGENT_HMAC_SECRET`; implement.
- [ ] 5.2 Test `mcp-agent-authorization` deltas: no env widening; remove `mcp-readonly-sql.agents.json`; update `.env.example`.
- [ ] 5.3 Test port 3002 default; reserve 3002; ship systemd + Dockerfile for authority; update nginx + README; verify.
- [ ] 5.4 E2E: authority (3002) + readonly-sql (3001); JWT works, missing scope 401, authority down 503.
