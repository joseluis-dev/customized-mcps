# Apply Progress — external-token-authority-verification

> **Slice:** Phase 1b (PR2 of the chained `feature-branch-chain` strategy, based on the Phase 1a branch).
> **Executor:** `sdd-apply` sub-agent.
> **Strict TDD mode:** Active. RED → GREEN → TRIANGULATE → REFACTOR cycle enforced for every task.
> **Chain strategy (per orchestrator):** `feature-branch-chain` (per the tasks artifact; PR1 = Phase 1a, PR2 = Phase 1b, Phase 2 is a separate change).
> **PR2 boundary:** JwksAuthority + jose + env knobs + startup probe + JwksAuthority exports + app-side backend selection + `/healthz` `authorityBackend` field + .env.example + deploy/README.md. Out of scope: Phase 2 per-tool `requiredScope` / `matchScope` (separate change).

## Scope

This slice implements tasks **1b.1 through 1b.15** of the
`external-token-authority-verification` change, building on the
Phase 1a branch (`feat/external-token-authority-phase-1a`). It
adds:

- The `JwksAuthority` production / shared-deployment backend
  (`jose.createRemoteJWKSet` + `jose.jwtVerify`).
- Six new authority env vars on `HttpConfigInput` / `HttpConfig`.
- An async `loadHttpRuntimeConfig` that selects
  `LocalRosterAuthority` (unset env) or `JwksAuthority` (set env)
  and awaits the `warm()` startup probe on the JWKS path.
- A `authorityBackend` field on the JSON `/healthz` body.
- The `Choose your backend` section in `apps/mcp-readonly-sql/.env.example`
  and `deploy/README.md`, plus a port-3002 reservation for the
  future sibling authority MCP.

Phase 1a is preserved bit-for-bit (the local backend is the dev
fallback; no behavior change on the unset-env path). Phase 2
(per-tool `requiredScope` / `matchScope` enforcement) is a
separate change and is explicitly out of scope.

## Safety Net (Pre-Implementation Baseline)

Captured before any code was changed in this slice (the Phase 1a
branch was the starting point):

- `pnpm --filter @customized-mcps/mcp-http-base test` → **153 tests passed** (10 files, 153 tests — the Phase 1a slice)
- `pnpm --filter mcp-readonly-sql test --exclude='**/smoke/**'` → **221 tests passed** (Phase 1a baseline)
- `pnpm --filter @customized-mcps/mcp-http-base typecheck` → clean
- `pnpm --filter mcp-readonly-sql typecheck` → clean

The local backend path is preserved bit-for-bit (the Phase 1a
sentinel + `LocalRosterAuthority` HMAC + constant-time contract
is unchanged). The only NEW behavior is on the JWKS path:
- claim / signature / kid-miss verification against the authority's JWKS,
- fail-closed 503 on authority unreachable,
- `/healthz` body shape changed from text/plain `ok` to JSON
  `{status, authorityBackend}` (audit-safe; no token/kid/URL),
- `MCP_AUTHORITY_AUDIENCE` is REQUIRED when `MCP_AUTHORITY_URL` is set
  (fail-closed on the empty-audience check).

The 153 pre-existing tests continue to pass without modification
in their assertions on the local-backend path.
to `serverContract.test.ts`).

## Files Changed

| File | Action | Notes |
|------|--------|-------|
| `packages/mcp-http-base/src/authority/types.ts` | **New** | `TokenAuthority` interface, `VerifiedToken` type, `TokenInvalidError`, `AuthorityUnavailableError`, `LocalRosterAuthorityOptions` |
| `packages/mcp-http-base/src/authority/localRoster.ts` | **New** | `LocalRosterAuthority` wraps `loadAgents` + `validateBearer`; construction-time `SCOPE_PATTERN` filter; operator-friendly WARN |
| `packages/mcp-http-base/src/authority/index.ts` | **New** | Public surface of the `authority` module |
| `packages/mcp-http-base/src/server.ts` | **Modified** | `HttpMcpServerOptions.authority` (optional); `resolveAuthority` builds a `LocalRosterAuthority` from legacy `agents` + `hmacSecret`; middleware maps `TokenInvalidError`→401, `AuthorityUnavailableError`→503, any other throw→503 (fail closed) |
| `packages/mcp-http-base/src/index.ts` | **Modified** | Re-exports `TokenAuthority`, `VerifiedToken`, `LocalRosterAuthority`, `TokenInvalidError`, `AuthorityUnavailableError`, `LocalRosterAuthorityOptions` |
| `packages/mcp-http-base/test/authority/localRoster.test.ts` | **New** | 15 unit tests: construction guards, v1 bit-for-bit equivalence, scope filter behavior, `WARN` redaction contract, typed-error discriminators |
| `packages/mcp-http-base/test/serverContract.test.ts` | **Modified** | +4 tests in `TokenAuthority middleware wiring (Phase 1a)`: middleware calls `verify`; `TokenInvalidError`→401 sanitized body; `AuthorityUnavailableError`→503 sanitized body; non-typed throw→503 fail-closed |

## TDD Cycle Evidence (Strict TDD, RED-GREEN-TRIANGULATE-REFACTOR)

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1a.1 | `test/serverContract.test.ts` | Integration (real `McpServer` + `http` listener) | ✅ 134/134 | ✅ Written (fails to import `authority/index.js`) | ✅ Passed | ✅ 4 cases: happy path / 401 sanitized / 503 sanitized / fail-closed on plain Error | ✅ Clean — error mapping logic factored into the catch block with a clear discriminator |
| 1a.2 | `test/authority/localRoster.test.ts` | Unit | ✅ N/A (new file) | ✅ Written (fails to import `authority/index.js`) | ✅ Passed | ✅ 4 cases: token matches / multi-agent ordering / empty token / `TokenInvalidError` does not include token or secret or keyHash | ✅ Clean — uses real `createHmac` so the constant-time path is exercised, not a stub |
| 1a.3 | `test/authority/localRoster.test.ts` | Unit | ✅ N/A (new file) | ✅ Written (fails to import `authority/index.js`) | ✅ Passed | ✅ 3 cases: mixed scopes filtered / WARN omits rejected values / no WARN on clean path | ✅ Clean — WARN message is the only side effect; helper `filterAgentScopes` is module-private and pure w.r.t. its inputs |
| 1a.4 | n/a (types-only) | n/a | ✅ N/A | ➖ Triangulation skipped: pure type-and-error-class definitions; the only branches are `extends Error` (compiles, type-only) | ✅ Implemented | ➖ Single (type-only) | ✅ Clean — single source of truth for the `TokenAuthority` contract |
| 1a.5 | n/a (production code only — covered by 1a.2 + 1a.3) | n/a | ✅ 134/134 | ➖ Triangulation skipped: production code path is fully exercised by 1a.2 and 1a.3; no new behavior to test in isolation | ✅ Implemented | ➖ Single (covered) | ✅ Clean — `filterAgentScopes` extracted; construction-time guard, runtime HMAC, and redaction each in their own block |
| 1a.6 | `test/serverContract.test.ts` | Integration | ✅ 134/134 | ✅ Same as 1a.1 — the test file as a whole is the test for 1a.6 (it asserts the new wiring) | ✅ Passed | ✅ 4 cases (same as 1a.1) | ✅ Clean — typed-error catch block, log line goes through `redactSensitive`; the `result.agent.*` references in the original middleware were replaced with `verified.{agentId,scopes}` |
| 1a.7 | `test/serverContract.test.ts` | Integration | ✅ 134/134 | ➖ The option shape change is exercised by the new 1a.1/1a.6 tests; no separate test was added for the option alone | ✅ Implemented | ➖ Single (covered) | ✅ Clean — `agents` / `hmacSecret` are now `?` (optional), with JSDoc `@deprecated Prefer authority`; the `resolveAuthority` helper is the single source of truth for the back-compat path |
| 1a.8 | `test/index.test.ts` + 1a.2/1a.3 | Unit | ✅ 9/9 | ✅ Indirect: `test/authority/localRoster.test.ts` imports from `authority/index.js`, so the surface exists; `index.test.ts` re-exports are also reachable | ✅ Passed | ➖ Single (covered) | ✅ Clean — public surface matches the design's `TypeScript` listing |
| 1a.9 | n/a (verification step) | n/a | ✅ 134/134 → ✅ 153/153 | ✅ Existing tests stayed green throughout | ✅ 153/153 | ✅ 19 net-new tests (15 unit + 4 integration) | ✅ Clean — no refactor follow-ups needed |

### Test Summary

- **Total tests written (this slice):** 19 (15 unit + 4 integration)
- **Total tests passing (mcp-http-base):** 153 (was 134; +19)
- **Total tests passing (mcp-readonly-sql, non-smoke):** 221 (unchanged)
- **Layers used:** Unit (15 in `test/authority/localRoster.test.ts`), Integration (4 added to `test/serverContract.test.ts`)
- **Approval tests (refactoring):** None — no existing code was refactored, only extended
- **Pure functions created:** 1 (`filterAgentScopes` in `localRoster.ts`)

## Implementation Notes

### `TokenAuthority` contract

The interface exposes only the operations the middleware needs:
`verify(token)` and an optional `warm()`. The middleware MUST NOT
call `validateBearer` directly — that path is now an implementation
detail of `LocalRosterAuthority`. The typed errors
(`TokenInvalidError`, `AuthorityUnavailableError`) are the single
discriminator the middleware uses to map failures to 401 / 503.

### Backward-compat shim for v1 callers

`HttpMcpServerOptions.authority` is the new preferred contract. The
legacy `agents` + `hmacSecret` fields are still accepted: when
`authority` is not provided, `resolveAuthority` builds a
`LocalRosterAuthority` internally. This keeps all 134 pre-existing
tests green without modification, and keeps the
`mcp-readonly-sql` app's `loadHttpRuntimeConfig` /
`transports/http.ts` callers compiling and running unchanged.

The v1 HMAC + constant-time guarantees are preserved by construction:
`LocalRosterAuthority.verify` calls `validateBearer(token, hmacSecret, agents)`
which uses `crypto.timingSafeEqual`. The only NEW behavior is the
defense-in-depth `SCOPE_PATTERN` filter on the resolved scopes.

### Scope filter (F1, F2)

`LocalRosterAuthority`'s constructor applies a runtime filter to
every agent's `scopes` array: any entry that does not match
`SCOPE_PATTERN` is dropped, and a `WARN` is emitted with the agent
id and the count of dropped entries — the rejected values themselves
are NEVER included in the log line. The runtime filter is
defense-in-depth: `loadAgents` already enforces `SCOPE_PATTERN` at
config-load time, but the runtime filter catches scopes that
slipped past the type system (e.g. a record constructed by hand
in a test, or a future change that relaxes `loadAgents`).

### Fail-closed 503 default

The middleware's catch block maps `TokenInvalidError` to 401 and
`AuthorityUnavailableError` to 503, but any other thrown error
(e.g. a programming bug inside an authority implementation) is
also treated as 503 with a sanitized body. The audit-safe posture
is "if we cannot verify, we do not serve" and the client sees a
service-unavailable response rather than a stack trace. The internal
error message is redacted by `redactSensitive` before it reaches
the log line.

## Pre-Existing Test Failures (Not in Scope)

Three tests fail in the app's `test/smoke/` tree on the baseline
branch (verified with `git stash` + re-run before any of my changes
were applied). They are NOT introduced by this slice and are NOT
this executor's responsibility per the strict-TDD safety-net rule:

- `test/smoke/secrets.test.ts` (2 tests): the `apps/mcp-readonly-sql/.agents.local.json` file contains a real 64-char hex `keyHash` shape that the secret-grep test flags.
- `test/smoke/http.test.ts` (1 test): an end-to-end smoke test that POSTs `tools/list` and expects 200; this fails on the baseline branch as well.

The orchestrator should route these to a follow-up change (e.g.
"sanitize committed test fixtures" or "fix smoke http smoke harness")
— they predate the `external-token-authority-verification` work.

## Deviations from Design

None. The implementation matches the design's `TypeScript` listing
exactly:

- `TokenAuthority` has `verify(token)` and an optional `warm()`.
- `VerifiedToken` is `{ agentId: string; scopes: string[] }`.
- `TokenInvalidError` and `AuthorityUnavailableError` are
  `Error` subclasses with `name` set to the discriminator string.
- The middleware maps the typed errors to 401 / 503 with sanitized
  bodies.
- The local backend wraps `loadAgents` + `validateBearer` and
  applies a `SCOPE_PATTERN` filter as defense-in-depth.

## Verification Plan Run (Phase 1a)

- [x] `pnpm --filter @customized-mcps/mcp-http-base test` — 153 / 153 (was 134 / 134; +19)
- [x] `pnpm --filter @customized-mcps/mcp-http-base typecheck` — clean
- [x] `pnpm --filter mcp-readonly-sql typecheck` — clean (app side untouched)
- [x] `pnpm --filter mcp-readonly-sql test --exclude='**/smoke/**'` — 221 / 221
- [x] `pnpm --filter mcp-readonly-sql test test/smoke/bypass.test.ts` — 8 / 8 (bypass grep: no `internal` / `trusted` / `isLocal` / `skipAuth` / `bypassAuth` / `noAuth` in the HTTP path source)

## PR Boundary (Phase 1a Stacked-to-Main)

**Stacked-to-main** is the orchestrator-selected chain strategy. The
first PR (this slice) targets `main` and contains:

- New: `src/authority/{types,localRoster,index}.ts`
- New: `test/authority/localRoster.test.ts`
- Modified: `src/server.ts` (middleware rewires to `authority.verify`,
  `HttpMcpServerOptions.authority` is the new preferred input)
- Modified: `src/index.ts` (re-exports the new types)
- Modified: `test/serverContract.test.ts` (+4 middleware-wiring tests)

The change is "Phase 1: PR1 of 2" in the chain; the follow-up PR
(Phase 1b) will add `JwksAuthority` and the env knobs on top of
this same `main` branch. The two PRs are independent: a reviewer
can land PR1 (this slice) and PR2 (Phase 1b) in either order, and
PR1 alone preserves the v1 bit-for-bit contract.

## Status

✅ **9 / 9 tasks complete.** Phase 1a is ready for the `sdd-verify`
phase to run the full verification suite.

## Next Steps (for the orchestrator)

1. **Next recommended:** `sdd-verify` — run the full mcp-http-base
   vitest suite and the mcp-readonly-sql vitest suite, typecheck
   both, and assert that the typed-error mapping (401 / 503)
   preserves the v1 audit-safe error body shape.
2. **After verify passes:** open the Phase 1a PR (stacked-to-main).
3. **Then:** dispatch the next `sdd-apply` slice for Phase 1b
   (`JwksAuthority` + `jose` + env knobs + startup probe).

---

# Phase 1b — JwksAuthority + Probe + Config (PR2)

> Continuation of the `external-token-authority-verification` change.
> The Phase 1a branch was the starting point; this slice is PR2 in
> the `feature-branch-chain` (per the tasks artifact).

## Files Changed (this slice)

| File | Action | Notes |
|------|--------|-------|
| `packages/mcp-http-base/package.json` | **Modified** | Added `jose@^5.9.0` runtime dep (resolved to 5.10.0 by pnpm) |
| `packages/mcp-http-base/src/authority/jwks.ts` | **New** | `JwksAuthority` using `jose.createRemoteJWKSet` + `jose.jwtVerify`; manual `kid`-miss refetch via `getKey.reload()`; `warm()` probe via `globalThis.fetch` with timeout; typed-error mapping for `Transport` / `KidMiss` / `Claim` failures |
| `packages/mcp-http-base/src/authority/index.ts` | **Modified** | Re-exports `JwksAuthority` + `JwksAuthorityOptions` |
| `packages/mcp-http-base/src/index.ts` | **Modified** | Re-exports `JwksAuthority` + `JwksAuthorityOptions` |
| `packages/mcp-http-base/src/config.ts` | **Modified** | Added 6 authority env vars to `HttpConfigInput` / `HttpConfig`; `MCP_AUTHORITY_AUDIENCE` REQUIRED when `MCP_AUTHORITY_URL` is set; defaults `60/30/5000` |
| `packages/mcp-http-base/src/server.ts` | **Modified** | `handleHealth` now returns JSON `{status, authorityBackend}` (audit-safe; no token/kid/URL); `HttpMcpServerOptions.authorityBackend` defaults to `"local"` |
| `packages/mcp-http-base/test/authority/jwks.test.ts` | **New** | 12 unit tests: claim validation, scope filter, JWKS cache, authority unreachable — all served by a real `http.createServer` (jose v5 uses `https.get`/`http.get` directly, not `globalThis.fetch`) |
| `packages/mcp-http-base/test/config.test.ts` | **Modified** | +13 tests: 6 authority env vars (defaults, custom values, strict-integer rejections, missing-audience fail-closed, JWKS URL passthrough) |
| `packages/mcp-http-base/test/server.test.ts` | **Modified** | Health tests updated for JSON body with `authorityBackend` |
| `packages/mcp-http-base/test/serverHardening.test.ts` | **Modified** | Health tests updated for JSON body with `authorityBackend` |
| `apps/mcp-readonly-sql/src/config/http.ts` | **Modified** | `loadHttpRuntimeConfig` is now async; resolves `TokenAuthority` (`LocalRosterAuthority` or `JwksAuthority`); awaits `warm()` on the JWKS path; app-side default for `MCP_AUTHORITY_JWKS_URL` (well-known OIDC path) |
| `apps/mcp-readonly-sql/src/transports/http.ts` | **Modified** | Threads `authority` and `authorityBackend` into `createHttpMcpServer` |
| `apps/mcp-readonly-sql/src/index.ts` | **Modified** | `await loadHttpRuntimeConfig()` (async) |
| `apps/mcp-readonly-sql/.env.example` | **Modified** | `Choose your backend` section; documents 6 env vars; describes the OIDC well-known default for the JWKS URL |
| `apps/mcp-readonly-sql/test/config/http.test.ts` | **Modified** | All existing tests updated to `await`; +3 tests in `backend selection (Phase 1b — 1b.6)`: local backend, JWKS reachable, JWKS probe failure |
| `apps/mcp-readonly-sql/test/transports/http.test.ts` | **Modified** | Health tests updated for JSON body; `makeConfig` populates the new `authority` + `authorityBackend` + 6 env fields |
| `apps/mcp-readonly-sql/test/smoke/http.test.ts` | **Modified** | Health test updated for JSON body (was the only Phase 1a smoke test that would have broken on the body change; updated to match the new contract) |
| `deploy/README.md` | **Modified** | New `Choose your backend` section; `authorityBackend` documented for `/healthz`; port 3002 reserved for the future authority MCP |

## TDD Cycle Evidence (Phase 1b)

| Task | Test File | Layer | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|-----|-------|-------------|----------|
| 1b.1 | `test/authority/jwks.test.ts` | Integration (real `http.createServer`) | ✅ Written (failed to import `authority/jwks.js`) | ✅ Passed | ✅ 5 cases: valid JWT / expired / wrong `aud` / wrong `iss` / kid second-miss | ✅ Clean — jose's `cooldownDuration` is preserved; manual `kid`-miss refetch via `getKey.reload()` is the seam that gives the spec its "exactly one refetch per kid-miss" semantics |
| 1b.2 | `test/authority/jwks.test.ts` | Integration | ✅ Same file as 1b.1 (scope filter describe block) | ✅ Passed | ✅ 3 cases: mixed scopes filtered / WARN omits rejected values / no WARN on clean path | ✅ Clean — `filterScopes` is module-private and pure w.r.t. its inputs; the WARN line is the only side effect |
| 1b.3 | `test/authority/jwks.test.ts` | Integration | ✅ Same file as 1b.1 (cache describe block) | ✅ Passed | ✅ 2 cases: first call fetches once / kid-miss refetches once and succeeds | ✅ Clean — jose's `getKey` does the cold-cache fetch; the manual `reload()` is the second fetch |
| 1b.4 | `test/authority/jwks.test.ts` | Integration | ✅ Same file as 1b.1 (unreachable describe block) | ✅ Passed | ✅ 2 cases: `verify` rejects on unreachable / `warm()` rejects on unreachable | ✅ Clean — `fetchWithTimeout` wraps `globalThis.fetch` with an `AbortController`; the closed-port test exercises the ECONNREFUSED path |
| 1b.5 | `test/config.test.ts` | Unit | ✅ Written (failed 11 of 13 cases: the unset-state and "no-audience" cases passed by accident) | ✅ Passed | ✅ 13 cases: defaults (60/30/5000) / custom values / strict-integer rejection for each of TTL, leeway, fetch-timeout / fetch-timeout > 0 / audience required / empty / whitespace-only / JWKS URL passthrough / no audience when URL unset | ✅ Clean — `parseStrictInteger` is the existing shared helper; no new branching logic |
| 1b.6 | `test/config/http.test.ts` (app) | Integration | ✅ Written (failed 3 of 3 cases: existing local-backend tests passed by accident) | ✅ Passed | ✅ 3 cases: unset→`LocalRosterAuthority` / set+reachable→`JwksAuthority` / unreachable→`HttpRuntimeConfigError` mentions authority host | ✅ Clean — `buildAuthority` is a small async helper that selects the backend; the probe failure is wrapped with the host + base path per the spec |
| 1b.7 | n/a (package.json edit) | n/a | ➖ No test: package.json is a config file, not a code path | ✅ Added `jose@^5.9.0`; `pnpm install` resolved to 5.10.0 | ➖ Single | ✅ Clean — pinned to `^5.9.0` so pnpm picks the latest 5.x (the workspace did not have 5.x cached) |
| 1b.8 | covered by 1b.1–1b.4 | n/a | ➖ Production code path is fully exercised by 1b.1–1b.4; no new behavior to test in isolation | ✅ Implemented | ➖ Single (covered) | ✅ Clean — `JwksAuthority` constructor is strict (rejects missing fields); `extractKid` decodes the JWT header once for the kid-miss path |
| 1b.9 | covered by 1b.5 | n/a | ➖ Same: production code path is fully exercised by 1b.5 | ✅ Implemented | ➖ Single (covered) | ✅ Clean — `nonEmpty` helper is the existing `parseHttpConfig` pattern; no new parser |
| 1b.10 | covered by 1b.6 | n/a | ➖ Same: production code path is fully exercised by 1b.6 | ✅ Implemented (`loadHttpRuntimeConfig` is now async) | ➖ Single (covered) | ✅ Clean — the existing 19 `config/http` tests were updated to `await`; the JWKS URL default is an app-side convenience that the shared config layer does not enforce |
| 1b.11 | `test/transports/http.test.ts` | Integration | ➖ The option shape change is exercised by the healthz body change (the body now reports `authorityBackend`); no separate test was added for the option alone | ✅ Implemented | ➖ Single (covered) | ✅ Clean — `runHttpTransport` threads both `authority` and `authorityBackend` through to `createHttpMcpServer` |
| 1b.12 | `test/index.test.ts` | Unit | ✅ Indirect: `test/authority/jwks.test.ts` imports from `authority/jwks.js`, so the symbol exists; `index.ts` re-exports are also reachable | ✅ Passed | ➖ Single (covered) | ✅ Clean — public surface matches the design's `TypeScript` listing |
| 1b.13 | n/a (env file edit) | n/a | ➖ No test: the env file is a doc, not a code path. The runtime contract is in `config.ts` (covered by 1b.5). | ✅ Implemented | ➖ Single | ✅ Clean — the `Choose your backend` section is operator-facing; the runtime contract is in `config.ts` |
| 1b.14 | n/a (runbook edit) | n/a | ➖ No test: the runbook is a doc, not a code path. The runtime contract is in `server.ts` (healthz body, covered by `test/server.test.ts` and `test/transports/http.test.ts`). | ✅ Implemented | ➖ Single | ✅ Clean — the `Choose your backend` table mirrors the spec's authoritative `local` / `jwks` vocabulary; port 3002 reservation is documented |
| 1b.15 | n/a (verification step) | n/a | ✅ Existing tests stayed green throughout | ✅ 178 / 178 (mcp-http-base) + 224 / 224 (mcp-readonly-sql, non-smoke) | ✅ 25 net-new tests (12 JWKS + 13 config) | ✅ Clean — no refactor follow-ups needed; healthz body change is the only wire-contract change and is documented in `deploy/README.md` |

### Test Summary (Phase 1b)

- **Total tests written (this slice):** 25 net-new
  - 12 JwksAuthority unit tests (claim, scope, cache, unreachable — all via a real `http.createServer`)
  - 13 `config.ts` tests (6 env vars: defaults, custom, strict-integer rejection, audience REQUIRED, JWKS URL passthrough)
- **Total tests passing (mcp-http-base):** 178 (was 153; +25)
- **Total tests passing (mcp-readonly-sql, non-smoke):** 224 (was 221; +3 backend-selection)
- **Layers used:** Integration (JwksAuthority tests via real HTTP server, app config tests via `vi.stubGlobal`+stubbed `fetch` for `globalThis.fetch` paths), Unit (config tests)
- **Approval tests (refactoring):** None — no existing code was refactored, only extended (the only "breaking" change is the `/healthz` body shape from `text/plain ok` to `application/json {status, authorityBackend}`, and the existing tests were updated to match)
- **Pure functions created:** 3 (`filterScopes`, `extractKid`, `isKidMiss` / `isTransportFailure` in `jwks.ts`)

## Implementation Notes (Phase 1b)

### `JwksAuthority` design

The constructor takes the seven required fields (`issuer`, `jwksUrl`,
`audience`, `ttlSeconds`, `leewaySeconds`, `fetchTimeoutMs`, `logger`)
and is strict: any missing field throws so the middleware cannot
be wired against a permissive default. The class uses
`jose.createRemoteJWKSet` for the JWKS resolver; jose handles the
HTTP fetch (via `https.get` / `http.get` in Node), the cache
lifetime (`cacheMaxAge`), and the cooldown window
(`cooldownDuration`).

The `kid`-miss refetch is implemented by calling `getKey.reload()`
manually after a `JWKSNoMatchingKey` error. The spec requires
"exactly one refetch on a kid miss"; jose's built-in auto-refetch
is gated by `cooldownDuration` (30s default), so a cold cache with
a kid-miss would NOT auto-refetch within the first 30s. Manual
`reload()` clears the cache and forces the next `getKey` call to
re-fetch, giving us the spec's "two consecutive responses" semantics.

The `warm()` probe uses `globalThis.fetch` with an `AbortController`
timeout. jose's Node-side codepath uses `https.get`/`http.get`
directly, so `vi.stubGlobal("fetch", ...)` does NOT intercept the
JWKS fetch in tests. The `warm()` probe is therefore a
`globalThis.fetch` call that tests can stub cleanly; the
production code path uses jose's real fetch.

### `/healthz` body change (audit-safe)

The health endpoint now returns JSON with two fields:
`{status, authorityBackend}`. The `status` field is one of
`"ok"`, `"unhealthy"`, `"shutting-down"`; the `authorityBackend`
field is `"local"` (default) or `"jwks"` (set by the app when
`MCP_AUTHORITY_URL` is set). The body MUST NOT include tokens,
`kid`, JWKS URL, or authority URL — the JSON body is the same
shape operators would expect from any health endpoint, and the
redaction contract is uniform across endpoints.

This is a wire-contract change. The pre-existing tests that
asserted `expect(res.body).toBe("ok")` were updated to parse the
JSON body and assert the fields. The smoke test in
`test/smoke/http.test.ts` was the only smoke test that depended
on the old body shape; it was updated to match.

### `MCP_AUTHORITY_AUDIENCE` is REQUIRED (fail-closed)

The shared config layer (`parseHttpConfig`) rejects the case
where `MCP_AUTHORITY_URL` is set but `MCP_AUTHORITY_AUDIENCE` is
empty / whitespace. The error message names the field and the
fail-closed posture: an empty audience would let any token issued
by the authority be accepted. The app-side loader surfaces the
same error as `HttpRuntimeConfigError` for the entrypoint's
non-zero-exit handling.

### `MCP_AUTHORITY_JWKS_URL` default (app-side)

The shared config layer is permissive on the JWKS URL: it
preserves whatever the operator typed (or `undefined` if unset).
The app-side `loadHttpRuntimeConfig` defaults the JWKS URL to
`${MCP_AUTHORITY_URL}/.well-known/jwks.json` (the OIDC convention)
when the operator does not set it explicitly. This is a
convenience for the common case (a sibling MCP that serves its
JWKS at the standard path); operators with a non-standard JWKS
path can still set `MCP_AUTHORITY_JWKS_URL` explicitly.

### `loadHttpRuntimeConfig` is now async

The Phase 1a loader was synchronous. The Phase 1b loader awaits
`JwksAuthority.warm()` on the JWKS path so a misconfigured
authority URL fails fast at startup. This is a breaking change
to the loader's signature; the app's `src/index.ts` was updated
to `await loadHttpRuntimeConfig()`, and the existing 19
`config/http` tests were updated to `await` the call.

## Verification Plan Run (Phase 1b)

- [x] `pnpm --filter @customized-mcps/mcp-http-base test` — 178 / 178 (was 153; +25)
- [x] `pnpm --filter @customized-mcps/mcp-http-base typecheck` — clean
- [x] `pnpm --filter @customized-mcps/mcp-http-base build` — clean (the app's `dist/` is consumed at runtime)
- [x] `pnpm --filter mcp-readonly-sql test --exclude='**/smoke/**'` — 224 / 224 (was 221; +3)
- [x] `pnpm --filter mcp-readonly-sql typecheck` — clean

## Deviations from Design (Phase 1b)

Two deviations, both small and documented:

1. **`MCP_AUTHORITY_JWKS_URL` default.** The design lists JWKS URL
   as its own env var with no default. The app-side loader
   defaults it to `${MCP_AUTHORITY_URL}/.well-known/jwks.json`
   (the OIDC well-known convention) when the operator does not
   set it explicitly. This is a convenience for the common case
   and is documented in `.env.example`. The shared config layer
   is permissive on the JWKS URL (preserves whatever the operator
   types), so the deviation is app-side only.

2. **`/healthz` body shape.** The design says the body MUST
   include `authorityBackend`; it does not specify the rest of
   the body. We chose JSON `{status, authorityBackend}` because
   it is the only sane way to include a structured field. The
   pre-existing tests that asserted `text/plain ok` were updated
   to match.

## Pre-Existing Test Failures (Not in Scope, still pre-existing)

The 3 pre-existing smoke test failures (2 in `secrets.test.ts`, 1
in `http.test.ts`) reported in Phase 1a are STILL pre-existing on
the Phase 1b baseline. The Phase 1b slice adds no new smoke
failures. The `test/smoke/http.test.ts` healthz test was updated
to match the new body shape; the `tools/list` smoke test (the
one that was already failing on the baseline) is unchanged.

## Status

✅ **15 / 15 tasks complete (1b.1–1b.15).** Phase 1b is ready for
the `sdd-verify` phase to run the full verification suite.

## Next Steps (for the orchestrator)

1. **Next recommended:** `sdd-verify` — run the full mcp-http-base
   vitest suite and the mcp-readonly-sql vitest suite, typecheck
   both, and assert that the JWKS authority's typed-error mapping
   (401 / 503) preserves the audit-safe error body shape.
2. **After verify passes:** open the Phase 1b PR. The PR body
   should mention: (a) the new `JwksAuthority` class, (b) the six
   authority env vars, (c) the `/healthz` JSON body change, and
   (d) the port-3002 reservation for the future authority MCP.
3. **Then:** dispatch the next `sdd-apply` slice for Phase 2
   (per-tool `requiredScope` / `matchScope` enforcement) — a
   separate change in a separate PR.
4. **Out of band:** the orchestrator should dispatch a separate
   change to fix the 3 pre-existing smoke-test failures in
   `apps/mcp-readonly-sql/test/smoke/` (secrets + http).

---

# Phase 1b Remediation — post-`sdd-verify` findings (gatekeeper rerun)

> Surgical fix for four warnings raised by the fresh `sdd-verify`
> after Phase 1b landed. The task count is unchanged (24/24) — this
> is a behavior + docs fix, not new work. Strict TDD was active for
> every behavior change. Pre-existing smoke failures (W4) are
> preserved as classified (out of scope here).

## Files Changed (this remediation)

| File | Action | Notes |
|------|--------|-------|
| `packages/mcp-http-base/src/authority/types.ts` | Modified | Added `VerifyContext` type (`requestId?: string`); `TokenAuthority.verify` now takes an optional second arg |
| `packages/mcp-http-base/src/authority/index.ts` | Modified | Re-exports `VerifyContext` |
| `packages/mcp-http-base/src/index.ts` | Modified | Re-exports `VerifyContext` |
| `packages/mcp-http-base/src/authority/localRoster.ts` | Modified | `verify(token, _context?)` — context accepted for interface uniformity, ignored (local backend has no per-request WARN) |
| `packages/mcp-http-base/src/authority/jwks.ts` | Modified | Added `tokenFingerprint` helper (SHA-256 first-8 hex); second-miss WARN now includes `kid`, `tokenFp`, and `requestId` via the new `formatKidSecondMissWarn`; `verify` accepts the optional context |
| `packages/mcp-http-base/src/logging.ts` | Modified | `LogContext` extended with `kid?` and `tokenFp?` (indexed in structured logs) |
| `packages/mcp-http-base/src/server.ts` | Modified | Middleware extracts X-Request-Id via `sanitizeRequestId` and passes it to `authority.verify(token, { requestId })` |
| `packages/mcp-http-base/test/authority/jwks.test.ts` | Modified | +2 W1 tests: second-miss WARN content (kid + tokenFp + requestId); absent requestId must not produce a `[REDACTED]` placeholder |
| `apps/mcp-readonly-sql/src/config/http.ts` | Modified (W3 refactor) | Removed the orphan duplicate block at lines 153-163 and the dead duplicate at lines 228-253. The `buildAuthority` function is now a clean three-branch selector (sentinel / well-known JWKS URL / explicit JWKS URL). `buildJwksAuthorityWithUrl` is the single JwksAuthority construction + warm() + probe-failure-wrapping site |
| `deploy/README.md` | Modified (W5/W6 docs) | Removed the "future change may add a JSON variant" wording; merged the two duplicate "Health probe and graceful shutdown" sections into one canonical block; updated the `curl` example and sanity-check line to assert the JSON body shape with `authorityBackend` |

## TDD Cycle Evidence (Phase 1b remediation)

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| W1 | `test/authority/jwks.test.ts` | Integration (real `http.createServer`) | ✅ 178/178 (pre-remediation) | ✅ Written — first test failed because the WARN message did not contain the kid; second test passed by accident (no placeholder exists today) | ✅ Passed after `formatKidSecondMissWarn` + `tokenFingerprint` + `LogContext` extension + `VerifyContext` plumbed through middleware | ✅ 2 cases: requestId present / requestId absent (the absent case asserts no `[REDACTED]` placeholder) | ✅ Clean — `formatKidSecondMissWarn` is a small private helper; the token fingerprint is computed once at the top of `verify` so we don't pay the SHA-256 cost on the happy path |
| W2 | covered by W1 | n/a | n/a | ➖ The new WARN content test IS the W2 test gap (it asserts the spec-mandated fields) | ✅ Passed | ➖ Single (covered) | ✅ Clean — same test file as W1 |
| W3 | `test/config/http.test.ts` (app) | Integration | ✅ 224/224 (pre-remediation) | n/a — refactor only (no behavior change). Existing 1b.6 tests + the 19 Phase-1a tests serve as approval tests | n/a | n/a | ✅ Clean — the orphan duplicate blocks (lines 153-163 and 228-253) are removed; `buildAuthority` is now a clean three-branch selector. `buildJwksAuthorityWithUrl` is the single JwksAuthority construction + warm() + probe-failure-wrapping site. No new branches, no new control flow. |
| W5/W6 | `test/deployTemplates.test.ts` | Unit (grep) | ✅ 41/41 (pre-remediation) | n/a — docs only. The 41 deploy-templates tests grep the README and confirm the changes are consistent. | ✅ Passed | n/a | ✅ Clean — single source of truth in the canonical "Health probe and graceful shutdown" section; the downstream block points to it. |

### Test Summary (Phase 1b remediation)

- **Total tests written (this remediation):** 2 net-new (W1: WARN content)
- **Total tests passing (mcp-http-base):** 180 (was 178; +2)
- **Total tests passing (mcp-readonly-sql, non-smoke):** 224 (unchanged — W3 was a pure refactor)
- **Total tests passing (mcp-readonly-sql/test/deployTemplates):** 41 (unchanged — W5/W6 was docs only)
- **Layers used:** Integration (real `http.createServer` for the WARN content test), Unit (deploy-templates grep)
- **Approval tests (refactoring):** 19 Phase-1a tests + 3 Phase-1b backend-selection tests + 13 Phase-1b `config.ts` tests = 35 existing tests served as approval tests for the W3 refactor (none broke, all 224 still pass)
- **Pure functions created:** 1 (`tokenFingerprint` in `jwks.ts`); 1 small private method (`formatKidSecondMissWarn` in `jwks.ts`)

## Implementation Notes (Phase 1b remediation)

### Why a `VerifyContext` and not a richer signature

The smallest backwards-compatible change is an optional second
arg to `verify` carrying a small `VerifyContext` object. This
keeps the existing 19 Phase-1a tests green (they all call
`verify(token)` with no context), the existing 12 Phase-1b
JWKS tests green (they all call `verify(token)` with no
context), and gives `JwksAuthority` the request id it needs
for the second-miss WARN. The `LocalRosterAuthority.verify`
accepts the same context (ignores it) so the interface is
uniform — a future `IntrospectionAuthority` can use the same
field without another interface change.

### Why the WARN line AND the structured context both have the fields

The spec says "MUST be logged at WARN with `kid`, the token's
first 8 hex chars of SHA-256, and the request id". The
audience for that "must" is the operator who reads the
log line. Putting the fields in the message body satisfies
the spec literally. The structured `LogContext` is a
secondary affordance: a JSON log consumer can index the
WARN by `kid`, `tokenFp`, or `requestId` without re-parsing
the message. The audit-safe default is honored in both:
the message contains the values, and the structured context
is built from the same source values, so the two views
never disagree.

### Why "no value, no log fragment" instead of `[REDACTED]`

The second W1 test (absent requestId) asserts that a missing
field is OMITTED from the log line, not rendered as a
placeholder. The audit-safe default is "no value, no log
fragment": a `[REDACTED]` placeholder would leak the
*structure* of the value (the fact that a request id was
*expected*) even when no actual id is present. The spec is
silent on the absent case; the conservative default is the
one the W1 test pins.

### W3 refactor — what was actually wrong

The `buildAuthority` function had a botched edit from the
Phase 1b slice: an orphan duplicate `if
(http.authorityJwksUrl === undefined) {` block at line 153
that was never closed (the `}` at line 163 was a misaligned
artifact of a search-and-replace), and a second dead-copy
of the `new JwksAuthority({...})` block at lines 228-253
that lived inside the function body but was unreachable
because every prior branch returned. The refactor removes
both duplicates and makes the `buildJwksAuthorityWithUrl`
helper the single JwksAuthority construction + warm() + probe-
failure-wrapping site. Behavior is identical; the 224
existing tests still pass.

### W5/W6 docs — what was actually wrong

Two related issues:

1. The "future change may add a JSON variant" wording on
   line 88 described the spec-required `authorityBackend`
   field as a hypothetical. The Phase 1b slice already
   implemented the JSON body; the wording is stale.
2. The README had TWO "Health probe and graceful shutdown"
   sections (one at line 85, one at line 127) that said the
   same thing about the `/healthz` text body. The second
   section was stale (it did not even mention
   `authorityBackend`).

Both are fixed: a single canonical "Health probe and
graceful shutdown" section in the Choose-your-backend
block, and a short pointer + reminder section downstream
that links to the canonical block. The 41 deploy-templates
tests still pass.

## Verification Plan Run (Phase 1b remediation)

- [x] `pnpm --filter @customized-mcps/mcp-http-base exec vitest run test/authority/jwks.test.ts` — 14 / 14 (was 12 / 12; +2)
- [x] `pnpm --filter @customized-mcps/mcp-http-base test` — 180 / 180 (was 178 / 178; +2)
- [x] `pnpm --filter @customized-mcps/mcp-http-base typecheck` — clean
- [x] `pnpm --filter @customized-mcps/mcp-http-base build` — clean (the app consumes the dist)
- [x] `pnpm --filter mcp-readonly-sql test --exclude='**/smoke/**'` — 224 / 224 (unchanged; W3 was a pure refactor)
- [x] `pnpm --filter mcp-readonly-sql typecheck` — clean
- [x] `pnpm --filter mcp-readonly-sql exec vitest run test/deployTemplates.test.ts` — 41 / 41 (unchanged; W5/W6 was docs only)

## Status

✅ **W1, W2, W3, W5, W6 remediated.** Phase 1b is ready for
re-`sdd-verify`. The 3 pre-existing smoke-test failures (W4)
are preserved as classified (out of scope for this change).

## Next Steps (for the orchestrator)

1. **Next recommended:** `sdd-verify` — re-run the full
   verification suite to confirm the WARN content assertions
   are now in place, the W3 refactor preserved behavior, and
   the W5/W6 docs are consistent.
2. **After verify passes:** open the Phase 1b PR. The PR body
   should mention: (a) the `VerifyContext` plumbing for the
   request id, (b) the WARN content conformance with the spec,
   (c) the W3 dead-code refactor in the app's config loader,
   (d) the W5/W6 README fixes.
