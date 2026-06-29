# Verify Report — external-token-authority-verification (re-verify after remediation)

> **Slice:** Phase 1a + Phase 1b (full change verification, post-remediation rerun).
> **Mode:** Strict TDD (active, runner available).
> **Persistence:** hybrid (OpenSpec file + Engram).
> **Re-verification scope:** W1, W2, W3, W5, W6 (remediated in this pass); W4 (pre-existing smoke failures, classified as Baseline / Out-of-Scope — preserved, not hidden); spec, design, and task completeness re-validated.

## Skill Resolution

- `skills/sdd-verify/SKILL.md` — loaded.
- `skills/sdd-verify/strict-tdd-verify.md` — loaded.
- Section A `skill_resolution`: **paths-injected** (both files read; strict TDD mode honored).

## Verdict

Verdict: PASS

All in-scope binding spec requirements, runtime evidence, typecheck, design coherence, TDD cycle evidence, and assertion quality are green. The previously identified in-scope WARNINGs (W1, W2, W3, W5, W6) are all RESOLVED. **Archive is allowed.**

The only remaining observation — **W4** (3 pre-existing smoke-test failures on the merge-commit baseline) — is a **Baseline / Out-of-Scope Note** that pre-dates this change. It is preserved here for traceability but does NOT count against this change's in-scope verdict and does NOT block archive. It is the responsibility of a separate follow-up change, per the orchestrator's explicit instructions.

## Executive Summary

| Dimension | Result | Note |
|---|---|---|
| **In-scope verdict** | **✅ PASS** | All binding spec requirements met; all in-scope WARNINGs resolved |
| Completeness (24/24 tasks) | ✅ pass | tasks.md is fully checked (15 for 1b, 9 for 1a) |
| Build / typecheck | ✅ pass | both packages clean; `pnpm --filter mcp-readonly-sql build` emits dist |
| Test runtime evidence (mcp-http-base) | ✅ 180/180 | was 178; +2 net-new (W1: WARN content) |
| Test runtime evidence (mcp-readonly-sql non-smoke) | ✅ 224/224 | unchanged (W3 was a pure refactor; 35 existing tests served as approval tests) |
| Test runtime evidence (deployTemplates) | ✅ 41/41 | unchanged (W5/W6 was docs only) |
| Targeted JWKS suite (re-run) | ✅ 14/14 | was 12; +2 W1 tests |
| Spec compliance | ✅ pass | kid second-miss WARN now includes `kid`, token fingerprint prefix, and request id (per spec) |
| Design coherence | ✅ pass | two documented design deviations carried forward from prior verify |
| Assertion quality | ✅ pass | no tautologies, no ghost loops, no smoke-test-only assertions; W2 test gap closed |
| TDD evidence | ✅ pass | apply-progress has full TDD cycle tables for both phases plus the remediation; test files exist, tests pass |
| Artifacts | ✅ pass | proposal + 4 specs + design + tasks + apply-progress all present |
| Code quality | ✅ pass | `apps/mcp-readonly-sql/src/config/http.ts` refactored (W3) — clean three-branch selector, no orphan blocks |
| Baseline / Out-of-Scope (W4) | ⚠️ note | 3 pre-existing smoke failures on the merge baseline — see "Baseline / Out-of-Scope Note" section. **Not blocking.** |

## Remediation Status (the gatekeeper's pass)

| # | Prior Issue | Status | Evidence |
|---|---|---|---|
| **W1** | Spec deviation on kid second-miss WARN content | ✅ **RESOLVED** | `packages/mcp-http-base/src/authority/jwks.ts:353-372` — `formatKidSecondMissWarn` now produces a message that contains `kid`, `tokenFp` (first 8 hex chars of SHA-256), and `requestId` (when present). The structured context is `{ kid, tokenFp, requestId? }`. |
| **W2** | Test coverage gap: kid-miss WARN content not asserted | ✅ **RESOLVED** | `packages/mcp-http-base/test/authority/jwks.test.ts:292-341` — new test "W1: the kid-second-miss WARN log line includes the kid, the token fingerprint prefix, and the request id" asserts (a) the WARN body contains the kid, (b) the WARN body contains the first 8 hex chars of `createHash("sha256").update(token).digest("hex").slice(0, 8)`, (c) the WARN body contains the request id. |
| **W2b** | Absent requestId must not produce a placeholder | ✅ **RESOLVED** | `packages/mcp-http-base/test/authority/jwks.test.ts:343-371` — second new test asserts `expect(kidMissWarn).not.toMatch(/requestId\s*=\s*(undefined\|\[REDACTED\])/)`. The implementation (jwks.ts:365) uses `(context?.requestId ? \` requestId=${context.requestId}\` : "")` — absent context is omitted, not rendered as a placeholder. |
| **W3** | Code duplication in `apps/mcp-readonly-sql/src/config/http.ts` | ✅ **RESOLVED** | `apps/mcp-readonly-sql/src/config/http.ts:126-226` — `buildAuthority` is now a clean three-branch selector (sentinel / well-known JWKS URL / explicit JWKS URL). `buildJwksAuthorityWithUrl` (lines 179-226) is the single JwksAuthority construction + warm() + probe-failure-wrapping site. No orphan blocks; no function-hoisting reliance. 35 existing tests served as approval tests; all 224 still pass. |
| **W5** | Stale "future change may add a JSON variant" wording | ✅ **RESOLVED** | `deploy/README.md:88` — the "future" wording is gone. The text now reads: "The `authorityBackend` field is the audit-safe label that lets operators and orchestrators confirm the selected backend without grepping the env file. The body MUST NOT include the authority URL, the JWKS URL, the token, or the `kid` — only the `status` + `authorityBackend` pair." This matches the spec's audit-safe body contract. |
| **W6** | Duplicate `## Health probe and graceful shutdown` section | ✅ **RESOLVED (functional)** | `deploy/README.md:127-131` — the downstream section is now a single pointer sentence ("The full health-probe contract ... is documented in the [Health probe and graceful shutdown] section above. The block here is a short reminder that the probe is unauthenticated and drains on SIGTERM.") + a one-line bullet. The staleness about the old `text/plain ok` body is gone. The heading is still duplicated (a minor doc-cosmetic issue, see S4 below) but the content is a minimal pointer, not a full duplicate. Acceptable. |
| **W4** | Pre-existing smoke-test failures | ⚠️ **BASELINE / OUT-OF-SCOPE NOTE** | 3 failures confirmed pre-existing on the merge commit (2 in `secrets.test.ts`, 1 in `http.test.ts`); 1 of the 2 secrets failures is caused by an untracked `apps/mcp-readonly-sql/mcp-readonly-sql.agents.json` listed by the orchestrator as unrelated. Not in this change's scope; tracked for a follow-up change. **Does NOT count against the in-scope PASS verdict.** |

## Baseline / Out-of-Scope Note (W4) — Preserved, Not Hidden

The following 3 smoke-test failures exist on the bare merge commit `9cc023c` (verified by `git stash` against the pre-change working tree). They are NOT introduced by this change, NOT in scope for this change, and do NOT block the in-scope PASS verdict. They are recorded here for full traceability, with the explicit classification required by the orchestrator.

| Test | Pre-existing? | Source |
|---|---|---|
| `test/smoke/secrets.test.ts` > `the application source tree (apps/) contains no committed secrets` | ✅ yes | The committed `apps/mcp-readonly-sql/.env` file contains a 64+ char `MCP_AGENT_HMAC_SECRET` value that the secret-grep test flags. Predates this change. |
| `test/smoke/secrets.test.ts` > `no file anywhere in the committed tree contains a 64-char hex keyHash shape` | ⚠️ untracked-file only | Triggered by the untracked `apps/mcp-readonly-sql/mcp-readonly-sql.agents.json` (which contains a 64-char hex `keyHash`). Listed as "unrelated" by the orchestrator; not introduced by Phase 1b. |
| `test/smoke/http.test.ts` > `POST /mcp auth contract > returns 200 with a JSON-RPC success envelope when the bearer is valid and the body is tools/list` | ✅ yes | The smoke harness expects 200 for `tools/list`; the current behavior is 401. Predates this change. |

**Why W4 does not block this change:**

1. The orchestrator's instructions explicitly classify W4 as out-of-scope: "W4: pre-existing smoke failures remain out-of-scope; classify, do not hide."
2. None of the 3 failures are caused by code or tests in this change.
3. The `git stash` baseline (merge commit `9cc023c`) reproduces all 3 failures without any of the Phase 1a / Phase 1b / remediation changes applied.
4. The binding spec requirements of `mcp-token-authority`, `mcp-agent-authorization`, and `app-independence` are all met; the smoke tests are a Phase 4 cross-PR verification step, not a spec contract.
5. The non-smoke test suites (mcp-http-base 180/180, mcp-readonly-sql non-smoke 224/224, deployTemplates 41/41) are all green — these cover the binding contracts end-to-end.

**Recommended follow-up (not in scope here):** track W4 in a separate change to (a) sanitize the committed `.env` fixture, (b) fix the smoke http harness for the `tools/list` 200 case.

## Artifacts Verified

| Path | Exists | Status |
|---|---|---|
| `openspec/changes/external-token-authority-verification/proposal.md` | ✅ | done |
| `openspec/changes/external-token-authority-verification/design.md` | ✅ | done |
| `openspec/changes/external-token-authority-verification/tasks.md` | ✅ | 24/24 checked |
| `openspec/changes/external-token-authority-verification/apply-progress.md` | ✅ | Phase 1a + 1b + remediation reported done |
| `openspec/changes/external-token-authority-verification/specs/app-independence/spec.md` | ✅ | done |
| `openspec/changes/external-token-authority-verification/specs/mcp-agent-authorization/spec.md` | ✅ | done |
| `openspec/changes/external-token-authority-verification/specs/mcp-token-authority/spec.md` | ✅ | done |
| `openspec/changes/external-token-authority-verification/specs/mcp-tool-surface/spec.md` | ✅ | done (out-of-scope for Phase 1; per Phase 2 plan) |

## Command Evidence (re-run after remediation)

| Command | Exit | Outcome | Detail |
|---|---|---|---|
| `pnpm --filter @customized-mcps/mcp-http-base test` | 0 | **180/180 passed (11 files)** | was 178; +2 net-new (W1: WARN content) |
| `pnpm --filter @customized-mcps/mcp-http-base typecheck` | 0 | clean | `tsc -p tsconfig.json --noEmit` |
| `pnpm --filter @customized-mcps/mcp-http-base exec vitest run test/authority/jwks.test.ts` | 0 | **14/14 passed** | was 12; +2 W1 tests (kid + tokenFp + requestId, and the absent-requestId regression test) |
| `pnpm --filter mcp-readonly-sql test --exclude='**/smoke/**'` | 0 | **224/224 passed (13 files)** | unchanged; 22 config/http + 10 transports/http + 41 deploy templates + the rest. W3 was a pure refactor; 35 existing tests served as approval tests |
| `pnpm --filter mcp-readonly-sql typecheck` | 0 | clean | `tsc -p tsconfig.json --noEmit` |
| `pnpm --filter mcp-readonly-sql build` | 0 | dist emitted | The `dist/config/http.js` output is regenerated and reflects the W3 refactor |
| `pnpm --filter mcp-readonly-sql exec vitest run test/deployTemplates.test.ts` | 0 | **41/41 passed** | unchanged; W5/W6 was docs only |
| `pnpm --filter mcp-readonly-sql test test/smoke/` | 1 | 24/27 passed | 3 failures: see W4 Baseline / Out-of-Scope Note above |

## Spec Compliance Matrix

| Spec | Requirement | Implementation | Test | Status |
|---|---|---|---|---|
| mcp-token-authority | TokenAuthority interface (verify, optional warm, optional context) | `packages/mcp-http-base/src/authority/types.ts:73-92` | `localRoster.test.ts:279-296` (interface compliance) | ✅ |
| mcp-token-authority | Valid token returns {agentId, scopes} matching SCOPE_PATTERN | `authority/jwks.ts:328-340` + `authority/localRoster.ts:109-128` | `localRoster.test.ts:104-128`; `jwks.test.ts:201-222` | ✅ |
| mcp-token-authority | Invalid/expired token → TokenInvalidError | `authority/jwks.ts:261-266, 318-322` | `jwks.test.ts:224-270` | ✅ |
| mcp-token-authority | JWKS fetch + 60s cache + 5s timeout | `authority/jwks.ts:168-172` (jose `cacheMaxAge` + `timeoutDuration`) | `jwks.test.ts:453-471` (cache reuse) | ✅ |
| mcp-token-authority | Authority unreachable → AuthorityUnavailableError | `authority/jwks.ts:206-214, 256-260, 287-291` | `jwks.test.ts:497-528` | ✅ |
| mcp-token-authority | iss / aud / exp / nbf validated with leeway | `authority/jwks.ts:177-182` (jose verifyOptions) | `jwks.test.ts:201-270` | ✅ |
| mcp-token-authority | Scope claim normalized (string or array) | `authority/jwks.ts:489-498` | `jwks.test.ts:374-393` (mixed scopes) | ✅ |
| mcp-token-authority | Scopes filtered by SCOPE_PATTERN; invalid dropped, WARN omits value | `authority/jwks.ts:506-516, 334-339` | `jwks.test.ts:374-449` (drop + WARN redaction) | ✅ |
| mcp-token-authority | kid miss refetched exactly once | `authority/jwks.ts:267-291` (manual `getKey.reload()` + second verify) | `jwks.test.ts:272-290, 473-493` | ✅ |
| mcp-token-authority | **kid second-miss: WARN with kid + fingerprint + request id, reject 401** | `authority/jwks.ts:293-316` + `formatKidSecondMissWarn` lines 353-372 — **WARN now includes all three fields** | `jwks.test.ts:292-341` (W1 test asserts all three) | ✅ **W1 RESOLVED** |
| mcp-token-authority | 401/503 bodies omit token, kid, JWKS URL, authority URL, agentId, stack trace | `errors.ts:44-90` (fixed factories); `server.ts:511-522` (typed-error catch) | `serverContract.test.ts` (sanitized bodies) | ✅ |
| mcp-token-authority | Startup probe (warm) — non-zero exit on failure | `apps/mcp-readonly-sql/src/config/http.ts:210-225` (warm + catch with host-only message) | `apps/mcp-readonly-sql/test/config/http.test.ts:363-401` | ✅ |
| mcp-token-authority | /healthz includes authorityBackend (no token/kid/URL) | `packages/mcp-http-base/src/server.ts:644-674` (JSON body with status + authorityBackend) | `server.test.ts:117-141`; `serverHardening.test.ts:142-165, 479-586`; `transports/http.test.ts:165-221`; `smoke/http.test.ts:265-283` | ✅ |
| mcp-token-authority | Port 3002 reserved for future authority MCP | `deploy/README.md:91-93` (documented); no MCP_AUTHORITY_JWKS_URL change needed in this change | not applicable (purely documentary) | ✅ |
| mcp-agent-authorization | Middleware calls authority.verify, no direct validateBearer | `packages/mcp-http-base/src/server.ts:511-522` (await authority.verify) | `serverContract.test.ts` | ✅ |
| mcp-agent-authorization | Backend selection: unset env → Local; set env → JWKS | `apps/mcp-readonly-sql/src/config/http.ts:130-166` (buildAuthority three-branch) | `apps/mcp-readonly-sql/test/config/http.test.ts:313-401` | ✅ |
| mcp-agent-authorization | Local backend documented as dev/offline; JWKS recommended for prod | `apps/mcp-readonly-sql/.env.example:174-215`; `deploy/README.md:70-83` | not applicable (purely documentary) | ✅ |
| mcp-agent-authorization | MCP_AUTHORITY_AUDIENCE REQUIRED when MCP_AUTHORITY_URL is set | `packages/mcp-http-base/src/config.ts:160-169` (fail-closed) | `config.test.ts:391-426` (4 cases: set, missing, empty, whitespace) | ✅ |
| mcp-agent-authorization | 6 authority env vars with defaults 60/30/5000 | `packages/mcp-http-base/src/config.ts:170-190` | `config.test.ts:312-368` (defaults + custom + strict-integer) | ✅ |
| mcp-agent-authorization | LocalRosterAuthority bit-for-bit equivalent to v1 | `packages/mcp-http-base/src/authority/localRoster.ts:109-128` (validateBearer wrapped) | `localRoster.test.ts:94-183` (HMAC + constant-time equivalence) | ✅ |
| mcp-agent-authorization | Constant-time comparison on local backend | `packages/mcp-http-base/src/authority/localRoster.ts:116` (validateBearer uses timingSafeEqual) | covered transitively by `auth.test.ts` (Phase 1a) | ✅ |
| app-independence | TokenAuthority pluggability (no app-local verify function) | `apps/mcp-readonly-sql/src/index.ts` and `transports/http.ts` import from shared base; no app-local validateBearer | covered by code inspection | ✅ |
| mcp-tool-surface | (per-tool requiredScope) | n/a | n/a | ➖ out of scope (Phase 2) |

### Spec Compliance: 22 of 22 binding requirements met (W1 deviation now closed).

## Correctness Table

| Check | Source | Status | Note |
|---|---|---|---|
| Tokens never included in 401 body | `errors.ts:44-90` (fixed factory) | ✅ | `message: "unauthorized"` — no token echo |
| Tokens never included in 503 body | `errors.ts:78-90` (fixed factory) | ✅ | `message: "shutting-down"` — no token echo |
| kid IS included in WARN log (per spec) | `authority/jwks.ts:360, 367` | ✅ **W1 RESOLVED** | WARN body: `JwksAuthority: token kid "${kid}" not present in JWKS...` |
| Token fingerprint (8 hex SHA-256) IS included in WARN | `authority/jwks.ts:358, 361, 368` | ✅ **W1 RESOLVED** | `Token fingerprint (sha256:8) = ${fingerprint}`; structured context `tokenFp` |
| Request id IS included in WARN (when present) | `authority/jwks.ts:365, 370` | ✅ **W1 RESOLVED** | Appended as ` requestId=${context.requestId}`; structured context `requestId` |
| Absent requestId is OMITTED (no `[REDACTED]` placeholder) | `authority/jwks.ts:365` | ✅ **W2b RESOLVED** | Ternary `(context?.requestId ? \` requestId=${context.requestId}\` : "")` |
| Rejected scope values never included in WARN | `authority/jwks.ts:320-325, 334-339`; `localRoster.ts:155-166` | ✅ | tests in `jwks.test.ts:395-423`; `localRoster.test.ts:210-251` |
| JWKS URL never in /healthz body | `server.ts:644-674` | ✅ | body is `{status, authorityBackend}` |
| Authority URL never in /healthz body | `server.ts:644-674` | ✅ | same |
| Stack trace never in 401/503 | `errors.ts:44-90` (no `.stack` exposure); `server.ts:511-522` | ✅ | fixed envelope |
| agentId never in 401/503 body | `errors.ts:44-90` | ✅ | fixed message |
| Startup probe stderr names host + base path only | `apps/mcp-readonly-sql/src/config/http.ts:218-224` | ✅ | `Authority probe failed for ${url.host}${basePath}: ...` — no JWKS path or query string |
| HMAC secret length check | `localRoster.ts:78-83`; `config.ts:144-150` | ✅ | both 32-byte minimum |
| Backend selection is deterministic | `apps/mcp-readonly-sql/src/config/http.ts:126-166` | ✅ | clean three-branch selector (post-W3 refactor); tests `config/http.test.ts:313-401` |
| `config/http.ts` no orphan code blocks | `apps/mcp-readonly-sql/src/config/http.ts:126-226` | ✅ **W3 RESOLVED** | Single `buildAuthority` (3 branches) + single `buildJwksAuthorityWithUrl` (JwksAuthority construction + warm() + probe-failure-wrapping). No function-hoisting reliance. |
| Deploy README no stale "future JSON variant" wording | `deploy/README.md:88` | ✅ **W5 RESOLVED** | Text now describes the current (Phase 1b) state with `authorityBackend` |
| Deploy README no stale duplicate health-probe content | `deploy/README.md:127-131` | ✅ **W6 RESOLVED (functional)** | Downstream section is a one-sentence pointer + a one-line reminder; staleness about the old `text/plain ok` body is gone |

## Design Coherence

| Design Decision | Implementation | Status |
|---|---|---|
| `TokenAuthority` interface with `verify(token, context?)` + optional `warm()` | `types.ts:73-92` | ✅ |
| `VerifyContext` for the request id (added in remediation) | `types.ts:57-75` | ✅ |
| `jose` v5 for JWT/JWKS | `authority/jwks.ts:60-67`; `package.json` (jose@^5.9.0 → 5.10.0) | ✅ |
| One env var (`MCP_AUTHORITY_URL`) as the backend-selection signal | `config.ts:160-169`; `config/http.ts:130-166` | ✅ |
| Typed errors → 401/503 with sanitized bodies | `server.ts:511-522`; `errors.ts` | ✅ |
| `/healthz` reports `authorityBackend` | `server.ts:644-674` | ✅ |
| `jwksUrl` env var has no default (per design) | shared config layer preserves operator input (`config.ts:205`); app-side defaults to OIDC well-known | ⚠️ design deviation (documented in apply-progress) |
| `LocalRosterAuthority` wraps v1 `loadAgents` + `validateBearer` | `localRoster.ts:64-129` | ✅ |
| 6 authority env vars: defaults 60/30/5000 | `config.ts:170-190` | ✅ |
| `loadHttpRuntimeConfig` is async + awaits `warm()` | `config/http.ts:251-366` | ✅ |
| jose's `cooldownDuration: 30_000` | `authority/jwks.ts:171` | ✅ |
| JSON body for `/healthz` (because `authorityBackend` is a structured field) | `server.ts:663-673` | ⚠️ design deviation (documented; compatible with spec) |
| **Kid-second-miss WARN includes kid + tokenFp + requestId** (per spec) | `jwks.ts:353-372` | ✅ **W1 RESOLVED** |
| **Token fingerprint is the first 8 hex chars of SHA-256** (per spec) | `jwks.ts:428-430` | ✅ **W1 RESOLVED** |
| **No `[REDACTED]` placeholder for absent requestId** (audit-safe default) | `jwks.ts:365` | ✅ **W2b RESOLVED** |
| **Clean three-branch `buildAuthority` + single `buildJwksAuthorityWithUrl`** (post-W3) | `config/http.ts:126-226` | ✅ **W3 RESOLVED** |

## TDD Compliance

| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | ✅ | apply-progress has TDD Cycle Evidence tables for Phase 1a (1a.1–1a.9), Phase 1b (1b.1–1b.15), and the remediation (W1, W2, W3, W5/W6) |
| All tasks have tests | ✅ | 24/24 tasks have a covering test; remediation added 2 net-new W1 tests |
| RED confirmed (tests exist) | ✅ | All listed test files exist on disk; verified by `glob` and `read` |
| GREEN confirmed (tests pass) | ✅ | 180/180 mcp-http-base; 224/224 mcp-readonly-sql non-smoke; 41/41 deployTemplates; 14/14 jwks suite; both green on the current run |
| Triangulation adequate | ✅ **W2 RESOLVED** | The kid second-miss path now has 4 cases: (1) TokenInvalidError + 2 fetches, (2) **WARN body contains kid + tokenFp + requestId**, (3) **absent requestId → no `[REDACTED]` placeholder**, (4) redaction contract (token/kid/agentId not in error message) |
| Safety Net for modified files | ✅ | Pre-existing 134/134 mcp-http-base + 221/221 mcp-readonly-sql tests all stayed green; W3 refactor: 35 existing tests served as approval tests; W5/W6: 41 deployTemplates tests stayed green |

**TDD Compliance: 6/6 checks pass** (W2 triangulation gap closed).

## Test Layer Distribution

| Layer | Tests | Files | Tools |
|---|---|---|---|
| Unit | ~16 | 2 (config.test.ts, parts of jwks.test.ts for scope filter + warn) | vitest |
| Integration (real `http.createServer` / `McpServer` / `StreamableHTTPServerTransport`) | ~24 | 4 (authority/jwks.test.ts, authority/localRoster.test.ts, serverContract.test.ts, serverHardening.test.ts) | vitest |
| E2E | 0 | 0 | n/a |
| App-side integration (stubbed `globalThis.fetch` for the JWKS probe) | 3 | 1 (apps/.../config/http.test.ts backend selection) | vitest |
| **Total** | **180 (mcp-http-base) + 224 (mcp-readonly-sql non-smoke) = 404** | 11 + 13 | |

## Changed File Coverage

Coverage tool is NOT in the repo (`pnpm test` runs vitest with no `--coverage` config). Per the strict-tdd-verify.md directive: "Coverage analysis skipped — no coverage tool detected" — informational, not blocking.

## Assertion Quality Audit

Scanned all test files added/modified by this change: `localRoster.test.ts`, `jwks.test.ts`, `config.test.ts`, `config/http.test.ts`, `serverContract.test.ts`, `serverHardening.test.ts`, `server.test.ts`, `transports/http.test.ts`, `smoke/http.test.ts`. Plus the remediation additions: 2 new tests in `jwks.test.ts` (W1 WARN content, W2b no-placeholder).

| Issue | Severity | Detail |
|---|---|---|
| None of: tautologies (`expect(true).toBe(true)`), ghost loops (assertions over possibly-empty collection), smoke-test-only (`render() + toBeInTheDocument()`), or implementation-detail coupling (CSS classes, mock call counts without behavioral assertion) | ✅ pass | All assertions verify real behavior |
| Mock/assertion ratio | ✅ pass | JwksAuthority tests use a real `http.createServer` harness, not vi.mock. The one stub is `globalThis.fetch` for the `warm()` probe, which is the documented test seam. |
| Triangulation quality | ✅ pass **W2 RESOLVED** | The kid second-miss path now has 4 cases. The WARN content test computes the expected prefix via `createHash("sha256").update(token).digest("hex").slice(0, 8)` (independent of internal implementation); the no-placeholder test uses `expect(kidMissWarn).not.toMatch(/requestId\s*=\s*(undefined\|\[REDACTED\])/)` to pin the absent-field behavior. |
| Redaction contract tests | ✅ pass | Both backends have a test that the WARN log line does NOT contain the rejected values. localRoster: 210-251. JwksAuthority: 395-423. |
| W1 WARN content (kid, tokenFp, requestId) | ✅ pass | The new test asserts the WARN body contains all three values. |
| W2b absent-requestId regression | ✅ pass | The new test asserts no `[REDACTED]` placeholder leaks when the field is absent. |

**Assertion quality: 0 CRITICAL, 0 WARNING** (W2 triangulation gap closed).

## Quality Metrics

**Linter**: Not in the repo (no `.eslintrc*`, no lint script in `package.json`). Skipped — not a failure, not available.

**Type Checker**: ✅ clean on both packages. `pnpm --filter @customized-mcps/mcp-http-base typecheck` and `pnpm --filter mcp-readonly-sql typecheck` both exit 0.

**Build**: ✅ `pnpm --filter mcp-readonly-sql build` emits `dist/` cleanly (the W3 refactor compiled).

## In-Scope Issues (CRITICAL / WARNING)

### CRITICAL

None.

### WARNING (in-scope)

None. All previously in-scope WARNINGs (W1, W2, W3, W5, W6) are RESOLVED. The only remaining observation is **W4**, which is classified as a **Baseline / Out-of-Scope Note** above and does not count as an in-scope WARNING.

## SUGGESTIONS (informational, not blocking)

| # | Note | Severity |
|---|---|---|
| S1 | Coverage tooling absent. `mcp-http-base` and `mcp-readonly-sql` use vitest; the repo has no `@vitest/coverage-v8` or equivalent. Per the strict-tdd-verify.md directive, this is informational, not a failure. | SUGGESTION |
| S2 | The `algorithms: ["RS256", "ES256", "HS256"]` allowlist in `jwks.ts:181` includes `HS256` for "sibling-MCP scenarios". The design document calls out RS256/ES256. HS256 with a shared secret is a less-typical choice for JWKS (the secret would be stored in the JWK and visible to the resource server). | SUGGESTION |
| S3 | The `kidMissWarnedAt: Map<string, number>` cooldown in `jwks.ts:126, 308-313` is a per-process state that grows with each unique kid seen. The 30s eviction is a soft cap; the map is never garbage-collected. | SUGGESTION |
| S4 | Minor doc-cosmetic: `deploy/README.md:127` has a duplicate `## Health probe and graceful shutdown` heading. The content below is now a single-sentence pointer (functionally correct), so this is a heading-level only issue, not a content issue. | SUGGESTION |

## Recommended Next Steps (for the orchestrator / user)

1. **Archive this change** — all in-scope requirements are met; the in-scope verdict is **PASS**.
2. **Track W4 in a separate follow-up change** — sanitize the committed `.env` fixture and fix the http smoke harness for the `tools/list` 200 case. Out of scope for this change.
3. **Optional: S4 cosmetic** — rename the duplicate `## Health probe and graceful shutdown` heading in `deploy/README.md:127`. Out of scope for this change.

## Final In-Scope Verdict

**PASS** — archive is allowed.

## Next Recommended Phase

**`next_recommended` for the orchestrator: `archive`**
