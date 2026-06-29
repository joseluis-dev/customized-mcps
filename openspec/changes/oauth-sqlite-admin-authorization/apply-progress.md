# Apply Progress: oauth-sqlite-admin-authorization

## Batch
PR 1 (stacked-to-main): skeleton + SQLite + OAuth2 + self-probe

## Status
Complete. 10/10 assigned tasks done. 22 tasks remain (Phase 3-5, out of scope for this batch).

## Completed Tasks
### Phase 1 (App skeleton + SQLite)
- [x] 1.1 Test 7 tables, audit `actor` free-text, FKs ON; knex schema + idempotent migrations.
- [x] 1.2 Test WAL, single-writer mutex, 5-retry SQLITE_BUSY, `MCP_OAUTH_DB_PATH`; implement.
- [x] 1.3 Test online backup atomic + `MCP_OAUTH_BACKUP_INTERVAL_S`; implement `backup.ts`.
- [x] 1.4 Test sweep `audit_log >90d` + revoked `refresh_tokens >30d`; implement `sweep.ts`.

### Phase 2 (OAuth2 + self-probe)
- [x] 2.1 Test JWKS (public-only) + OIDC discovery; no `/oauth/authorize`; implement.
- [x] 2.2 Test RS256 JWT: `iss`, `aud=mcp:<app>`, `sub`, `scope`, `iat/nbf/exp`, `kid`, TTL 3600.
- [x] 2.3 Implement `oauth/token.ts`; refuse `*` mixed; default new client to `read:<bound-profile>`.
- [x] 2.4 Test introspect + refresh grant rejects `revokedAt != null`; implement.
- [x] 2.5 Test `OAuthAdminAuthority.warm()` POSTs introspect; exits non-zero on refuse/5xx; implement.
- [x] 2.6 Wire `apps/mcp-readonly-sql/src/config/http.ts` to use `OAuthAdminAuthority` when `MCP_AUTHORITY_URL` set.

## Files Created
### New app: `apps/mcp-oauth-admin/`
- `package.json` — deps: jose ^5.9, argon2 ^0.44, knex ^3, sqlite3 ^5, @customized-mcps/mcp-http-base workspace
- `tsconfig.json`, `vitest.config.ts`
- `.env.example` — port 3002 default, MCP_OAUTH_DB_PATH, MCP_OAUTH_BACKUP_TARGET, MCP_OAUTH_DISABLE_RETENTION_SWEEP
- `src/db/connection.ts` — `openDatabase`, `withSingleWriter`, `SQLITE_BUSY_RETRY_BUDGET=5`
- `src/db/schema.ts` — 7 tables, idempotent `IF NOT EXISTS`
- `src/db/index.ts` — barrel
- `src/oauth/keys.ts` — RS256 key generation + `setActiveSigningKey`, `importSigningPrivateKey`
- `src/oauth/jwks.ts` — `createJwksHandler` (public-only), `createOidcDiscoveryHandler` (no `authorization_endpoint`)
- `src/oauth/passwords.ts` — argon2id wrapper
- `src/oauth/token.ts` — `createTokenHandler` (client_credentials, password, refresh_token; refuses `*` mixed; default `read:<bound-profile>`)
- `src/oauth/introspect.ts` — `createIntrospectHandler` (RFC 7662 shape, always 200)
- `src/backup.ts` — `runBackupOnce` (VACUUM INTO + atomic rename), `startBackupLoop` with async stop()
- `src/sweep.ts` — `runRetentionSweep` (single-writer trx, 90d audit / 30d revoked), `startSweepLoop`

### New tests in `apps/mcp-oauth-admin/test/`
- `test/db/schema.test.ts` — 12 tests (tables, FKs, columns, audit survives delete, idempotent)
- `test/db/connection.test.ts` — 9 tests (WAL, foreign_keys, defaultDatabasePath, withSingleWriter, SQLITE_BUSY retry budget=6)
- `test/backup.test.ts` — 7 tests (target dir creation, full content, atomicity via content check, ref-overwrite, target!=source, scheduler stop, loop fires)
- `test/sweep.test.ts` — 5 tests (audit + refresh sweep, no-op empty, disabled flag, atomicity, 90d boundary)
- `test/oauth/jwks.test.ts` — 4 tests (public-only JWK Set, empty JWK Set, OIDC discovery, no /oauth/authorize)
- `test/oauth/token.test.ts` — 9 tests (client_credentials claims/TTL, password grant, wrong password, refuse `*` mixed, default scope, refresh revoked, refresh success, introspect active, introspect inactive)

### Modified
- `packages/mcp-http-base/src/authority/oauthAdmin.ts` — NEW: `OAuthAdminAuthority` extends `JwksAuthority`; warm() probes JWKS then POSTs `/oauth/introspect`; rejects on connection refused / 5xx / non-JSON / missing `active` field
- `packages/mcp-http-base/src/authority/index.ts` — export `OAuthAdminAuthority` + `OAuthAdminAuthorityOptions`
- `packages/mcp-http-base/src/index.ts` — re-export from root
- `packages/mcp-http-base/src/server.ts` — `authorityBackend` type widens to `"local" | "jwks" | "oauth"`
- `packages/mcp-http-base/package.json` — exposes `./auth.js` for SCOPE_PATTERN access
- `apps/mcp-readonly-sql/src/config/http.ts` — wires `OAuthAdminAuthority` when `MCP_AUTHORITY_URL` is set; `authorityBackend` now `"local" | "oauth" | "jwks"`
- `apps/mcp-readonly-sql/test/config/http.test.ts` — updates the JWKS selection test to assert `OAuthAdminAuthority` is constructed and that BOTH the JWKS URL and the introspect URL are probed

### New tests in `packages/mcp-http-base/test/`
- `test/authority/oauthAdmin.test.ts` — 5 tests (warm POSTs introspect with token=, 5xx rejects, non-JSON body rejects, connection refused rejects, missing `active` field rejects)

## TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1 | `test/db/schema.test.ts` | Unit | N/A (new) | ✅ Written (12) | ✅ 12/12 | ✅ 3+ cases per behavior | ✅ Clean |
| 1.2 | `test/db/connection.test.ts` | Unit | N/A (new) | ✅ Written (9) | ✅ 9/9 | ✅ 4 cases on retry budget | ✅ Clean |
| 1.3 | `test/backup.test.ts` | Unit | N/A (new) | ✅ Written (7) | ✅ 7/7 | ✅ atomicity via content, ref-overwrite | ✅ Clean |
| 1.4 | `test/sweep.test.ts` | Unit | N/A (new) | ✅ Written (5) | ✅ 5/5 | ✅ boundary at exactly 90d | ✅ Clean |
| 2.1 | `test/oauth/jwks.test.ts` | Unit | N/A (new) | ✅ Written (4) | ✅ 4/4 | ✅ empty JWK Set, no /oauth/authorize | ✅ Clean |
| 2.2 | `test/oauth/token.test.ts` | Unit | N/A (new) | ✅ Written (9) | ✅ 9/9 | ✅ happy + wrong password + claims/TTL | ✅ Clean |
| 2.3 | `test/oauth/token.test.ts` | Unit | (same) | (same) | (same) | ✅ refuse `*` mixed + default `read:<profile>` | ✅ Clean |
| 2.4 | `test/oauth/token.test.ts` | Unit | (same) | (same) | (same) | ✅ revoked vs non-revoked | ✅ Clean |
| 2.5 | `test/authority/oauthAdmin.test.ts` | Unit | N/A (new) | ✅ Written (5) | ✅ 5/5 | ✅ 5xx, non-JSON, missing `active`, connection refused | ✅ Clean |
| 2.6 | `apps/mcp-readonly-sql/test/config/http.test.ts` | Unit | ✅ N/A (replacement of existing test) | ✅ Written (1) | ✅ 1/1 | ✅ Stubbed fetch verifies JWKS + introspect probe URLs | ✅ Clean |

## Commands Run
- `pnpm install` — added argon2 + jose + knex + sqlite3 to mcp-oauth-admin
- `pnpm --filter @customized-mcps/mcp-http-base build` — re-built the package so apps see `OAuthAdminAuthority` from the dist
- `pnpm --filter mcp-oauth-admin test` — 46/46 pass
- `pnpm --filter @customized-mcps/mcp-http-base test` — 185/185 pass
- `pnpm --filter mcp-readonly-sql test` — 248/251 pass; 3 failures are pre-existing (reproduce on `b85ae37` with changes stashed: 2 in `smoke/secrets.test.ts` and 1 in `smoke/http.test.ts`)
- `pnpm -r --workspace-concurrency=1 run typecheck` — all four packages pass strict typecheck (`noUncheckedIndexedAccess` + `noImplicitOverride`)

## Deviations
1. **Backup via `VACUUM INTO` + atomic rename instead of `db.backup()` (sqlite3 npm wrapper).** The npm `sqlite3` package's `Database#backup` is unreliable on Windows in this workspace (destination file can remain 0 bytes and close can fail with `SQLITE_BUSY: unfinalized backup`). The implementation uses SQLite's documented `VACUUM INTO` online-backup mechanism and writes to `<target>.tmp` before atomic rename.
2. **`argon2` package required native-binding installation.** The package ships win32-x64 prebuilt binaries in this environment.
3. **`authorityBackend` enum widened to `"local" | "jwks" | "oauth"`.** Required for OAuth-backed authority reporting; backwards compatible with existing local/JWKS behavior.

## Issues Found
- npm `sqlite3` backup API unreliable on Windows; worked around with `VACUUM INTO` + atomic rename.
- npm `sqlite3` type definitions do not expose `Database#backup`; avoided by using `VACUUM INTO` exclusively.
- `noUncheckedIndexedAccess: true` required several `db.select<T>` calls to use the inner row type to avoid double-array inference.

## Remaining Tasks
- Phase 3 (PR 2): admin UI (CRUD, sessions, CSRF, audit) — 5 tasks
- Phase 4 (PR 3): migrate readonly-sql fully + Authority Isolation test — 3 tasks
- Phase 5 (PR 3): remove local roster + deploy templates + E2E — 4 tasks

## Next Recommended Phase
`sdd-verify` for PR 1 after the review-budget decision. The work unit is autonomous: tests pass, typecheck passes, and PR1 tasks are marked done. Pre-existing test failures in `mcp-readonly-sql` smoke tests are unrelated to this change and reproduce on `b85ae37`.
