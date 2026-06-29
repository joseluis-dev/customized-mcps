# Apply Progress: oauth-sqlite-admin-authorization

## Batch
- PR 1 (stacked-to-main, commit `3d62472`): skeleton + SQLite + OAuth2 + self-probe
- PR 2 (stacked-to-main, uncommitted): admin UI (CRUD, sessions, CSRF, audit) + W1 entrypoint remediation

## Status
PR 1: complete (10/10 tasks done, verified, archived by the PR 1 verify report).
PR 2: complete (5/5 tasks done — Phase 3.1 through 3.5 — plus W1 entrypoint). 17/17 tasks total across both PRs. Phase 4-5 (6 tasks) remain for PR 3.

## Completed Tasks
### Phase 1 (App skeleton + SQLite) — PR 1
- [x] 1.1 Test 7 tables, audit `actor` free-text, FKs ON; knex schema + idempotent migrations.
- [x] 1.2 Test WAL, single-writer mutex, 5-retry SQLITE_BUSY, `MCP_OAUTH_DB_PATH`; implement.
- [x] 1.3 Test online backup atomic + `MCP_OAUTH_BACKUP_INTERVAL_S`; implement `backup.ts`.
- [x] 1.4 Test sweep `audit_log >90d` + revoked `refresh_tokens >30d`; implement `sweep.ts`.

### Phase 2 (OAuth2 + self-probe) — PR 1
- [x] 2.1 Test JWKS (public-only) + OIDC discovery; no `/oauth/authorize`; implement.
- [x] 2.2 Test RS256 JWT: `iss`, `aud=mcp:<app>`, `sub`, `scope`, `iat/nbf/exp`, `kid`, TTL 3600.
- [x] 2.3 Implement `oauth/token.ts`; refuse `*` mixed; default new client to `read:<bound-profile>`.
- [x] 2.4 Test introspect + refresh grant rejects `revokedAt != null`; implement.
- [x] 2.5 Test `OAuthAdminAuthority.warm()` POSTs introspect; exits non-zero on refuse/5xx; implement.
- [x] 2.6 Wire `apps/mcp-readonly-sql/src/config/http.ts` to use `OAuthAdminAuthority` when `MCP_AUTHORITY_URL` set.

### Phase 3 (Admin UI) — PR 2
- [x] 3.1 Test session: signed cookie, 32-byte secret, CSRF double-submit 403; implement + rotation.
- [x] 3.2 Test per-username backoff 5 fails/10m -> 429; not on `/oauth/token`; implement.
- [x] 3.3 Test agent CRUD: one-time plaintext, `argon2id`, `requireChangeOnFirstLogin`; bootstrap refuses mint; WARN; implement.
- [x] 3.4 Test client CRUD + scope catalog (refuse delete when assigned); revocation + audit row; implement.
- [x] 3.5 Test audit viewer paginate, filter, redact; 91d row swept; implement + refactor templates.

## Files Created
### PR 1 (committed in `3d62472`) — 10 source files, 6 test files
See PR 1 verify report for the full list. The new modules live under
`apps/mcp-oauth-admin/src/{db,oauth,backup,sweep}.ts` and
`packages/mcp-http-base/src/authority/oauthAdmin.ts`.

### PR 2 (uncommitted) — 11 source files, 11 test files
#### New admin modules under `apps/mcp-oauth-admin/src/admin/`
- `src/admin/session.ts` — 32-byte secret, HMAC-SHA256 sign/verify,
  CSRF token generation, constant-time comparison, signed-cookie
  set-Cookie builder. (241 lines)
- `src/admin/backoff.ts` — per-username 5-fail/10-min lock; the
  `BackoffError` carries `lockedUntil` + `retryAfterSeconds`.
  (189 lines)
- `src/admin/audit.ts` — `auditAppend` (refuses tokens + 64-char
  hex in `target`/`ip`), `redactAuditValue`, `listAuditRows` with
  filter, `countAuditRows`. (239 lines)
- `src/admin/agents.ts` — agent CRUD: `createAgent` (one-time
  plaintext + `argon2id` hash + `requireChangeOnFirstLogin`),
  `setAgentEnabled`, `rotateAgentPassword`, `changeOwnPassword`
  (self-service rotation), `verifyAgentPassword`, `setAgentScopes`.
  (508 lines)
- `src/admin/clients.ts` — client CRUD: `createClient` (one-time
  secret + `argon2id` hash), `rotateClientSecret`, `setClientScopes`,
  `setClientLabel`, `deleteClient` (refused when refresh tokens
  are live). (339 lines)
- `src/admin/scopes.ts` — scope catalog: `createScope` (validates
  `SCOPE_PATTERN`, refuses `*`), `deleteScope` (refused when
  assigned to any agent or client, with sanitized count).
  `scopeInUse` uses `json_each` for accurate JSON-array matching.
  (183 lines)
- `src/admin/refresh.ts` — refresh-token revocation: list with
  joins, `revokeRefreshToken` (idempotent guard, audit row in the
  same trx as the `revokedAt` update). (248 lines)
- `src/admin/bootstrap.ts` — env-based bootstrap admin: reads
  `MCP_OAUTH_ADMIN_USERNAME` / `MCP_OAUTH_ADMIN_PASSWORD`,
  `ensureBootstrapAdmin` (idempotent), `shouldWarnBootstrapEnv`
  (persistent WARN while env is set). (170 lines)
- `src/admin/templates.ts` — server-rendered HTML pages (login,
  dashboard, agents/clients/scopes/refresh-tokens/audit viewers,
  one-time-secret pages, error page). All dynamic values are
  HTML-escaped. (532 lines)
- `src/admin/router.ts` — the `node:http` router: login + CSRF +
  session + all CRUD endpoints. Form body is read once per
  request to avoid the body-consumed-twice hang. (1168 lines)

#### New entrypoint — W1 remediation
- `src/index.ts` — composition root: opens DB, initializes schema,
  sets the active signing key, runs the bootstrap admin, starts
  the backup loop + retention sweep, mounts the admin UI router
  + OAuth endpoints, wires SIGTERM/SIGINT to shutdown. (235 lines)
- The `bin` (`mcp-oauth-admin → dist/index.js`), `dev` (tsx
  watch src/index.ts), and `start` (node dist/index.js) scripts
  in `package.json` are now bootable. The `pnpm build` produces
  `dist/index.js` (10K).

#### Modified in PR 2
- `src/db/connection.ts` — `withSingleWriter` is now per-DB (the
  module-level singleton leaked across tests, blocking close).
  Added `drainWriterChain` for test teardown.
- `src/db/index.ts` — export `drainWriterChain`.
- `src/sweep.ts` — `startSweepLoop` accepts `onError`.

#### New tests in `apps/mcp-oauth-admin/test/admin/` — 11 files
- `test/admin/session.test.ts` — 21 tests (secret + CSRF + cookies)
- `test/admin/backoff.test.ts` — 15 tests (threshold + window + lock)
- `test/admin/audit.test.ts` — 22 tests (append + redact + pagination + filter)
- `test/admin/agents.test.ts` — 32 tests (CRUD + `changeOwnPassword` + verify)
- `test/admin/clients.test.ts` — 25 tests (CRUD + delete-with-revoked)
- `test/admin/scopes.test.ts` — 18 tests (catalog + in-use refusal)
- `test/admin/refresh.test.ts` — 14 tests (list + revoke + audit row)
- `test/admin/bootstrap.test.ts` — 18 tests (env reading + idempotent create + WARN)
- `test/admin/templates.test.ts` — 35 tests (HTML shape + XSS escape)
- `test/admin/router.test.ts` — 21 tests (integration: session, CSRF, backoff, CRUD, audit)
- `test/index.test.ts` — 7 tests (W1 remediation: entrypoint exists, exports `main`)

## TDD Cycle Evidence (cumulative across PR1 + PR2)

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
| 3.1 | `test/admin/session.test.ts` | Unit | N/A (new) | ✅ Written (21) | ✅ 21/21 | ✅ tampering + wrong-secret + malformed | ✅ Clean |
| 3.1 | `test/admin/router.test.ts` | Integration | N/A (new) | ✅ Written (8) | ✅ 8/8 | ✅ HttpOnly + SameSite + 403 on missing CSRF | ✅ Clean |
| 3.2 | `test/admin/backoff.test.ts` | Unit | N/A (new) | ✅ Written (15) | ✅ 15/15 | ✅ window reset + 5th vs 6th attempt | ✅ Clean |
| 3.2 | `test/admin/router.test.ts` | Integration | N/A (new) | ✅ Written (2) | ✅ 2/2 | ✅ 5 fails → 429 + correct password also rejected | ✅ Clean |
| 3.3 | `test/admin/agents.test.ts` | Unit | N/A (new) | ✅ Written (32) | ✅ 32/32 | ✅ 16-byte + 8-byte min + invalid_scope + dup | ✅ Clean |
| 3.3 | `test/admin/bootstrap.test.ts` | Unit | N/A (new) | ✅ Written (18) | ✅ 18/18 | ✅ env + idempotent + WARN + never overwrite | ✅ Clean |
| 3.3 | `test/admin/router.test.ts` | Integration | N/A (new) | ✅ Written (3) | ✅ 3/3 | ✅ create agent + disable + rotation flow | ✅ Clean |
| 3.4 | `test/admin/clients.test.ts` | Unit | N/A (new) | ✅ Written (25) | ✅ 25/25 | ✅ invalid + dup + rotate + delete-with-tokens | ✅ Clean |
| 3.4 | `test/admin/scopes.test.ts` | Unit | N/A (new) | ✅ Written (18) | ✅ 18/18 | ✅ in-use refusal with count + `*` rejection | ✅ Clean |
| 3.4 | `test/admin/refresh.test.ts` | Unit | N/A (new) | ✅ Written (14) | ✅ 14/14 | ✅ audit row target + idempotent guard | ✅ Clean |
| 3.4 | `test/admin/router.test.ts` | Integration | N/A (new) | ✅ Written (3) | ✅ 3/3 | ✅ create + scope delete refused + refresh revoke | ✅ Clean |
| 3.5 | `test/admin/audit.test.ts` | Unit | N/A (new) | ✅ Written (22) | ✅ 22/22 | ✅ pagination + filter + redact + refuse token | ✅ Clean |
| 3.5 | `test/admin/templates.test.ts` | Unit | N/A (new) | ✅ Written (35) | ✅ 35/35 | ✅ XSS escape + pagination + one-time page | ✅ Clean |
| 3.5 | `test/admin/router.test.ts` | Integration | N/A (new) | ✅ Written (3) | ✅ 3/3 | ✅ filter by actor + redact + paginate | ✅ Clean |
| W1 | `test/index.test.ts` | Smoke | N/A (new) | ✅ Written (7) | ✅ 7/7 | ✅ file exists + bin + dev + start scripts | ✅ Clean |

## Commands Run
- `pnpm --filter mcp-oauth-admin test` — 274/274 pass (PR1: 46 + PR2 new: 228; 17 test files)
- `pnpm --filter mcp-oauth-admin typecheck` — clean
- `pnpm --filter mcp-oauth-admin build` — produces `dist/index.js` (10K)
- `pnpm --filter @customized-mcps/mcp-http-base test` — 185/185 pass
- `pnpm --filter mcp-readonly-sql test` — 248/251 pass; 3 pre-existing baseline failures (reproduce on `b85ae37`, classified out-of-scope in PR 1 verify report)
- `pnpm -r --workspace-concurrency=1 run typecheck` — all 3 packages pass strict typecheck

## Deviations

1. **Per-DB writer chain (replaces module-level singleton).** The PR 1 `withSingleWriter` was a module-level `let writerChain: Promise<unknown>` that leaked across tests — a closed db's pending writes blocked the next test's queue. PR 2 makes the chain per-DB (stored on the db wrapper) and exports `drainWriterChain` for test teardown. No production behavior change; the production code path is a single db, so per-DB and module-level are equivalent at runtime.
2. **Form body read once per request.** The router's first pass read the body in `verifyCsrfForRequest` AND in the dispatched handler, which hung the second read (Node.js `IncomingMessage` streams the body once). Fixed by reading the body once in the main router and passing the parsed `URLSearchParams` to the handler. Login is the only exception (it does its own read because the CSRF check is bypassed for the login form).
3. **JSON-encoded scope lookup uses `json_each` instead of `LIKE`.** The first pass used a `LIKE '%"name"%'` substring search, which broke for scope names with `_` (the LIKE wildcard) — the `escapeLike` helper added a backslash escape that SQLite's LIKE did not honor without an `ESCAPE` clause. Switched to `json_each(users.scopes)` for exact value matching. Behavior is more correct; performance is comparable.
4. **PR2 line count exceeds the 1200-line review budget.** The PR 2 diff is ~7800 net new lines (10 admin modules + 11 test files + entrypoint). This is roughly 6x the budget. The chain strategy is `stacked-to-main` per the orchestrator's preflight; the orchestrator should decide whether to accept a `size:exception` for PR 2, or split further. See the Risks section.
5. **Admin UI change-password GET handler returns `currentRequired: true` always.** A future refinement could read the user's `requireChangeOnFirstLogin` flag from the DB and pass it to the template (so the bootstrap rotation case hides the `current_password` input). This is a one-line change deferred to PR 3 polish.

## Issues Found
- The npm `sqlite3` JSON1 extension (`json_each`) is enabled in this build; verified by direct query in PR 2 scope test.
- `parseCookies` originally used the WHATWG `Headers` API (`headers.get`); the router's `IncomingHttpHeaders` is a plain object, so the original signature would have crashed every request. The signature was widened to accept any `{ get(name) }` shape plus a string passthrough.
- argon2id hashing takes ~100-300ms per call. The router integration tests do 3-4 hashes per login, so they need a 30s test timeout (vs the 5s default). The default timeout was too tight; the test file documents this.
- `noUncheckedIndexedAccess: true` in `tsconfig.base.json` required `db.select<T>` calls to use the inner row type (not `T[]` wrapping) to avoid double-array inference. PR 2 inherits this.

## Workload / PR boundary
- **Mode**: stacked-to-main (per orchestrator preflight)
- **Current work unit**: PR 2 — admin UI CRUD + sessions + CSRF + audit + W1 entrypoint
- **Boundary**: starts after local PR1 commit `3d62472`; ends with tasks 3.1-3.5 + W1 completed, tests/typecheck/build passing, tasks updated.
- **Estimated review budget impact**: PR 2 is ~7800 net new lines, roughly 6x the 1200-line budget. The PR 1 size:exception was PR1-specific per the orchestrator; PR 2 should be reviewed against the same standard. The chain is already split (Phase 3 is its own PR). The orchestrator should decide whether to accept a `size:exception` for PR 2, or further split. **Recommendation**: accept a `size:exception` because the admin UI is a single coherent unit (splitting the router / templates / tests would produce false-work-unit PRs that don't make sense in isolation).

## PR 2 gate remediation (W2 + W3)
The PR 2 verify gate flagged two cheap warnings to correct before
verification. The orchestrator authorized `size:exception` for PR 2 and
asked for these two fixes. **Strict TDD** was active.

### W2: CSRF header coverage/behavior
**Spec wording** (`specs/mcp-admin-ui/spec.md`):
> "every state-changing form has a hidden CSRF token input AND
>  the matching `X-CSRF-Token` header on fetch requests; the
>  server rejects requests missing either."

**Pre-remediation behavior** (`src/admin/router.ts`):
The router's `verifyCsrfFromBody` only checked the form's `_csrf`
input (or a `csrf_token_header` form field as a fallback). It did
NOT validate the `X-CSRF-Token` HTTP header that fetch-style
clients send. The spec requires either-or semantics: accept the
header when present, fall back to the form's hidden input when not,
reject when BOTH are missing. The orchestrator's note: "Preserve
normal form POST behavior if the UI currently relies on form
submission without custom headers; apply the spec distinction
carefully."

**Fix** (TDD cycle, see table below):
- Read the `X-CSRF-Token` HTTP header in the main router.
- If the header is present, validate it against the session
  (header takes precedence; a mismatched header rejects the
  request even if the form's hidden input is valid — this
  prevents a downgrade attack).
- If the header is absent, fall back to the form's `_csrf`
  input (preserves the existing form-based POST flow).
- Removed the dead `csrf_token_header` form field workaround.

### W3: token test coverage
**Spec wording** (`mcp-oauth-authority` + bootstrap flow):
The `password` grant MUST return `400 password_change_required`
when the user's `requireChangeOnFirstLogin=1` — even with the
correct password. The implementation in `src/oauth/token.ts`
already does this (lines 164-166) but the test suite did not
cover it. W3 added a direct integration test in
`test/oauth/token.test.ts`.

**No code change** — the test was an approval/regression test
that confirmed the existing behavior is correct.

### TDD evidence (PR 2 gate remediation)

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| W2 | `test/admin/router.test.ts` (5 new) | Integration | ✅ 274/274 | ✅ 2 failed (header-accept + header-mismatch precedence); 3 passed (the rejected-cases) | ✅ 5/5 pass | ✅ header present + header mismatched + form-only fallback + both valid + mismatched header w/ valid form | ✅ Clean (single helper, no magic strings) |
| W3 | `test/oauth/token.test.ts` (1 new) | Integration | ✅ 274/274 | ✅ Test passed on first run (the implementation was already correct; test added as regression coverage) | ✅ 1/1 pass | ✅ Single case (the only spec scenario) | ✅ N/A — no code change |

### Commands run
- `pnpm --filter mcp-oauth-admin test` → 280/280 pass (was 274 + 6 new: 5 W2 + 1 W3)
- `pnpm --filter mcp-oauth-admin test test/oauth/token.test.ts -t "password_change_required"` → 1/1 pass
- `pnpm --filter mcp-oauth-admin test test/admin/router.test.ts -t "CSRF header"` → 5/5 pass
- `pnpm --filter mcp-oauth-admin typecheck` → clean
- `pnpm --filter mcp-oauth-admin build` → clean (`dist/index.js` produced)
- `pnpm --filter @customized-mcps/mcp-http-base test` → 185/185 pass (no regressions)
- `pnpm -r --workspace-concurrency=1 run typecheck` → all 3 packages clean

### Files changed (remediation)
- `apps/mcp-oauth-admin/src/admin/router.ts` — added `readCsrfHeader` + `verifyCsrfForRequest` (header takes precedence; form `_csrf` is fallback). Removed dead `verifyCsrfForRequest` (async stub) and dead `verifyCsrfFromBody` (the old name that used the form field workaround).
- `apps/mcp-oauth-admin/test/admin/router.test.ts` — added 5 tests in a new `describe("admin/router — CSRF header for fetch-style requests (gate W2 remediation)")` block.
- `apps/mcp-oauth-admin/test/oauth/token.test.ts` — added 1 test in the `oauth/token (RS256 + claims + TTL)` describe block for `requireChangeOnFirstLogin=1 → 400 password_change_required`.

### Deviation note
- The old `verifyCsrfForRequest` (async) and the old `verifyCsrfFromBody` (sync, with the `csrf_token_header` form-field fallback) are removed. The new `verifyCsrfForRequest` is sync and signature `(session, body, headerToken)`. The old name is fully replaced; the only caller was the main router.

## Remaining Tasks
- Phase 4 (PR 3): migrate readonly-sql fully + Authority Isolation test — 3 tasks
- Phase 5 (PR 3): remove local roster + deploy templates + E2E — 4 tasks

## Next Recommended Phase
`sdd-verify` for PR 2. The work unit is autonomous: 280/280 tests pass on `mcp-oauth-admin`, typecheck is clean across all 3 packages, the entrypoint builds, the W2/W3 gate warnings are resolved with covering tests. Pre-existing test failures in `mcp-readonly-sql` smoke tests are unrelated (reproduce on `b85ae37`).
