# Apply Progress — external-token-authority-verification

> **Slice:** Phase 1a (PR1 of the chained `stacked-to-main` strategy).
> **Executor:** `sdd-apply` sub-agent.
> **Strict TDD mode:** Active. RED → GREEN → TRIANGULATE → REFACTOR cycle enforced for every task.
> **Chain strategy (per orchestrator):** `stacked-to-main` (overrides the tasks artifact's suggested `feature-branch-chain`).

## Scope

This slice implements tasks **1a.1 through 1a.9** of the
`external-token-authority-verification` change. It introduces the
`TokenAuthority` abstraction and the `LocalRosterAuthority` (dev/offline
fallback) backend, and rewires the shared base's HTTP middleware to call
`authority.verify(token)` instead of `validateBearer(...)` directly.

Out of scope for this slice: Phase 1b (`JwksAuthority` + `jose` +
authority env knobs) and Phase 2 (per-tool `requiredScope` /
`matchScope` enforcement).

## Safety Net (Pre-Implementation Baseline)

Captured before any code was changed:

- `pnpm --filter @customized-mcps/mcp-http-base test` → **134 tests passed** (9 files, 134 tests)
- `pnpm --filter @customized-mcps/mcp-http-base typecheck` → clean

The local backend path is preserved bit-for-bit (the v1
`loadAgents` + `validateBearer` HMAC compare is wrapped, not replaced),
and the 134 existing tests continue to pass without modification
(except the four new `TokenAuthority` middleware-wiring tests added
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
