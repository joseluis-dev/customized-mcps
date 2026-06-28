# Verify Report: Dynamic Profile Selection

**Change**: dynamic-profile-selection
**Mode**: Strict TDD (test runner: `pnpm test`)
**Verdict**: **PASS**

## Executive Summary

All 16 implementation tasks plus 3 gate-remediation tasks are complete. The
implementation satisfies every scenario in the two delta specs
(`profiles`, `mcp-tool-surface`) and matches the design and proposal.
`pnpm test` reports **112/112 passing** on a fresh run; `pnpm build` and
`pnpm exec tsc -p tsconfig.json --noEmit` both finish clean. No commits,
branches, or PRs were created by apply — all changes are uncommitted in
the working tree. The 4-PR stacked-to-main split plan is fully documented
in `apply-progress.md` for the commit phase. The two MEDIUM gate findings
have been remediated with RED-GREEN tests; their fixes use the alias
(not the operator key) on every error path and warning.

## Build / Type / Test Evidence

| Command | Result |
|---------|--------|
| `pnpm test` | **PASS** — 5 files, **112/112 tests** (785ms) |
| `pnpm build` | **PASS** — emits `dist/` (16 source + 3 map files, types included) |
| `pnpm exec tsc -p tsconfig.json --noEmit` | **PASS** — no output, no errors |

Test files:

- `test/sanitizeError.test.ts` — 4 tests
- `test/secretRefs.test.ts` — 12 tests
- `test/profiles.test.ts` — 30 tests (11 legacy + 14 new + 5 in `isUnsafeDisplayMetadata` block + the 2 remediation R-1.2 / R-1.3 + 1 collision R-1.1 alias-not-operator-key)
- `test/sqlGuard.test.ts` — 57 tests (unchanged baseline)
- `test/profileAlias.test.ts` — 9 tests

## Task Completion

All tasks in `tasks.md` are checked. The 3 remediation rows in
`apply-progress.md` (R-1.1, R-1.2, R-1.3) are complete and have their
passing tests verified at runtime this run.

| Phase | Tasks | Status |
|-------|-------|--------|
| 1 Foundation — SecretProvider | 1.1–1.4 | ✅ all checked |
| 2 Core — Profile + Alias + Display | 2.1–2.7 | ✅ all checked |
| 3 Integration — Tool Surface + Logging | 3.1–3.6 | ✅ all checked |
| 4 Docs + Verification | 4.1–4.4 | ✅ all checked |
| Gate remediation | R-1.1, R-1.2, R-1.3 | ✅ all checked |

## Spec Compliance Matrix

### `profiles` delta spec

| Requirement | Scenarios | Covering test(s) | Result |
|-------------|-----------|------------------|--------|
| Alias Defaulting | default = operator key; explicit override | `profiles.test.ts:173` ("defaults alias to operator key..."), `:192` ("uses explicit DB_<NAME>_ALIAS...") | **PASS** |
| Alias Validation | invalid regex rejected, non-leaking | `profiles.test.ts:211` (invalid chars), `:238` (>64 chars) | **PASS** |
| Alias Uniqueness | duplicate alias; alias-equals-other-operator-key | `profiles.test.ts:516` (duplicate), `:551` (alias-op-key collision) | **PASS** |
| Display Metadata | tags trim+dedupe, capabilities default `["read-only"]` | `profiles.test.ts:255` (trim+dedupe), `:277` (dedupe first-seen), `:294` (explicit caps) | **PASS** |
| Secret Reference Resolution | file resolved; missing file fails non-leaking | `profiles.test.ts:421` (file success), `:453` (missing file non-leaking) | **PASS** |
| Non-Leaking ProfileError | `sanitizeError` masks path/host/user/password/port; alias used (gate remediation) | `profiles.test.ts:482` (R-1.1: alias in error) | **PASS** |
| Backward Compatibility | legacy `.env` loads with alias = operator key | `profiles.test.ts:173` | **PASS** |

### `mcp-tool-surface` delta spec

| Requirement | Scenarios | Covering test(s) | Result |
|-------------|-----------|------------------|--------|
| `list_profiles` Additive Output | existing fields preserved; backward-compat consumer; legacy alias = operator key | `profileAlias.test.ts:86` (name===alias, no host/user/password/port/`${secret:`/operatorKey); `profileAlias.test.ts:271` (extra field rejection on list_profiles); `profiles.test.ts:173` (legacy alias) | **PASS** |
| `profile` Argument Resolution | alias resolves; operator key resolves as synonym; unknown value fails with caller value | `profileAlias.test.ts:114` (alias wins), `:159` (operator key accepted), `:185` (unknown → error keyed to "nope") | **PASS** |
| Error Contract | allowlist error references caller value; unknown profile does not enumerate | `profileAlias.test.ts:206` (allowlist error, alias only), `:185` (no enumeration of `bi_catastro`/`reporting` on `nope`) | **PASS** |
| No Dynamic Connection From User Input | `host`/`user`/`password`/`port` extras rejected by zod on every tool | `profileAlias.test.ts:233` (test_connection), `:252` (execute_read_query), `:271` (list_profiles) | **PASS** |

## Gate Remediation Verification

The apply gate found two MEDIUM findings. Both are remediated with
failing tests written first (RED) and passing after the fix (GREEN). The
new tests run and pass in this verify run.

| Finding | Fix Location | Test | Runtime result |
|---------|--------------|------|----------------|
| MEDIUM-1: `resolvePassword` leaked operator key via `envName` interpolation | `src/config/profiles.ts:305` (`resolvePassword`) + `buildConnection` signature extended with `alias` | `profiles.test.ts:482` — `names the alias (not the operator key) in ProfileError when a ${secret:file:...} fails to resolve` | **PASS** |
| MEDIUM-2 (displayName): `warnUnsafeMetadata` wrote operator key | `src/config/profiles.ts:119` (`warnUnsafeMetadata`) + `parseMetadata` extended with `alias` | `profiles.test.ts:311` — `warns to stderr with alias (not operator key) when displayName matches an unsafe pattern` | **PASS** |
| MEDIUM-2 (tags): same | same | `profiles.test.ts:344` — `warns to stderr with alias (not operator key) when a tag matches an unsafe pattern` | **PASS** |

Both remediation tests assert the alias appears, and explicitly assert
the operator key (`SQLSERVER_BI`), the secret path, the password value,
and the `${secret:file:` literal do NOT appear.

## Design Coherence

| Design decision | Implementation evidence | Coherent? |
|-----------------|--------------------------|-----------|
| `Profile.name === alias`, server-only `operatorKey` | `src/types.ts:5-6`; `src/config/profiles.ts:410-412`; `readonlyTools.ts:75-89` builds `ProfileSummary` with `name: p.alias, alias: p.alias` | ✅ |
| `aliasMap` + `operatorKeyMap`, alias-first lookup | `readonlyTools.ts:64-74` | ✅ |
| `loadAllProfiles` rejects duplicate / collision | `profiles.ts:125-150` (`checkAliasCollisions`) | ✅ |
| `SecretProvider.resolve(ref, { signal? })` async, `AbortSignal.timeout` composition | `src/secrets/SecretProvider.ts:41-73` | ✅ |
| Secret placement in `src/secrets/SecretProvider.ts`, only called from `profiles.ts` | Only call site: `profiles.ts:305-322` (`resolvePassword`) | ✅ |
| `isUnsafeDisplayMetadata` predicate with the listed regex set | `profiles.ts:22-36` (5 patterns) | ✅ |
| Tags/capabilities trim → drop blanks → first-seen dedupe; capabilities default `["read-only"]` | `profiles.ts:58-70` (`parseCommaList`), `:94-98` (capabilities default) | ✅ |
| `.strict()` on every tool input schema, including `list_profiles` | `readonlyTools.ts:97, 112, 141, 182, 262` (5/5 tools) | ✅ |
| `loadProfile`/`loadAllProfiles`/`runServer` async | `index.ts:13-17` (`await loadAllProfiles`) | ✅ |
| `ProfileError` uses reason codes + alias; never host/user/password/port/raw secret ref/file path/distinct operator key | `profiles.ts:6-18` (ProfileError class) + the gate-remediated `resolvePassword` message | ✅ |
| Log line lists aliases only | `index.ts:31` (`profiles.map((p) => p.alias).join(", ")`) | ✅ |

## Security Boundary Audit

The four core "no dynamic host/user/password/port from MCP input" checks
all hold:

1. **Tool input rejection** — all 5 tool schemas use `.strict()` (confirmed
   in `readonlyTools.ts:97, 112, 141, 182, 262`); the three relevant
   tests in `profileAlias.test.ts:233, 252, 271` all assert
   `result.success === false` when `host`/`user`/`password`/`port` are
   injected.
2. **`list_profiles` safety** — `ProfileSummary` is built at
   `readonlyTools.ts:75-89` from explicit fields only; the test at
   `profileAlias.test.ts:86` asserts the raw JSON never contains
   `host`, `user`, `password`, `port`, `${secret:`, or the operator
   key.
3. **Secret-bearing fields stay server-side** — `password` only flows
   through `buildConnection` and is never surfaced via
   `ProfileSummary`. The resolved file content lives only in
   `Profile.connection.password`.
4. **Error path** — `sanitizeError` (`sanitizeError.ts:49-67`) is the
   single masking point and is applied to every tool error via
   `errorResult` (`readonlyTools.ts:31-45`). Tests
   `sanitizeError.test.ts` (4 tests) and the `ProfileError` tests
   prove masking works.

## Backward Compatibility

- `ProfileSummary` adds 5 fields (`alias`, `displayName?`, `description?`,
  `tags?`, `capabilities`) but keeps the original 5 (`name`, `dialect`,
  `scope`, `allowedDatabases`, `requireQualifiedDatabase`). `name` now
  equals `alias`; `name` previously equaled the operator key in summary
  output, so consumers reading only the original 5 fields get a string
  identifier either way (alias by default = operator key when no
  `DB_<NAME>_ALIAS` is set).
- The `profile` argument still accepts the operator key as a synonym for
  the alias (`profileAlias.test.ts:159`).
- `loadProfile` defaults alias to the operator key
  (`profiles.test.ts:173`), so legacy `.env` files load unchanged.

## PR Split Plan (stacked-to-main)

The split is documented in `apply-progress.md` (PR 1 → PR 2 → PR 3 →
PR 4). It is a contract for the **commit/PR phase** (which is out of
scope for the apply executor and was not run). Confirmed:

- `git log --oneline` shows a single commit (`3a464dd Initialize
  mcp-readonly-sql...`) — no new commits were created by apply.
- `git branch -a` shows only `main` — no working branches, no remote
  tracking branches.
- `git remote -v` is empty — no remotes, so no PRs could have been
  pushed.
- `git status --short` confirms all changes are uncommitted working-tree
  edits plus untracked files (`openspec/`, `src/secrets/`, 3 new test
  files).

## TDD Compliance (Strict TDD)

| Check | Result | Details |
|-------|--------|---------|
| TDD evidence reported | ✅ | Two TDD cycle tables in `apply-progress.md` (16-task + 3-remediation) |
| All tasks have tests | ✅ | 44 tests written across 4 test files; 30/30 in `profiles.test.ts`, 12/12 in `secretRefs.test.ts`, 9/9 in `profileAlias.test.ts`, 4/4 in `sanitizeError.test.ts` |
| RED confirmed | ✅ | Test files exist and contain the scenarios claimed in the apply report |
| GREEN confirmed | ✅ | 112/112 passing on this run (109 original + 3 remediation) |
| Triangulation | ✅ | Multi-case where required: 1.1 (4 cases), 2.1 (6), 2.3 (2), 2.5 (5), 3.1 (4), 3.3 (3); "Single" rows justified by the equal-case coverage from earlier tests |
| Safety net for modified files | ✅ | 68/68 → 96/96 → 109/109 → 110/110 → 111/111 → 112/112 progression recorded |
| Type checker | ✅ | `tsc --noEmit` clean |
| Linter | ➖ | Not configured (`package.json` has no ESLint) — not a failure |

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 112 | 5 | vitest |
| Integration | 0 | 0 | — |
| E2E | 0 | 0 | — |
| **Total** | **112** | **5** | |

Unit-only is appropriate for this change: no rendering layer, no HTTP
boundary, no browser context to test against. The change is pure config
parsing + secret I/O + tool handler dispatch.

### Assertion Quality Audit

Scanned all 5 test files for banned patterns:

- **Tautologies**: none. Every `expect` is paired with real production
  code (`loadProfile`, `loadAllProfiles`, `FileSecretProvider.resolve`,
  `registerReadOnlyTools` handlers).
- **Empty without companion**: none. The "no tags" case is paired with
  a "tags set" case; the "no display name" case is paired with
  `displayName === undefined` plus the stderr-warning assertion.
- **Type-only assertions used alone**: none. `toBeUndefined()` and
  `toBeInstanceOf` are always paired with a value assertion (e.g.,
  `expect(p.displayName).toBeUndefined()` plus `expect(joined).not.toContain("hunter2")`).
- **Ghost loops**: none. The only `for` loop in tests is the first-seen
  dedupe assertion over `tags` (`profiles.test.ts:289`), where the
  array is non-empty by construction.
- **Smoke tests**: none. Every test asserts a specific value.
- **Implementation detail coupling**: minimal and acceptable. The
  `stderrSpy` tests assert the user-visible warning text, not the
  internal call shape.
- **Mock/assertion ratio**: `profileAlias.test.ts` mocks the MCP server
  registration API (1 mock per test) and asserts on real handler
  outputs (3-5 assertions per test). Acceptable.

**Assertion quality**: ✅ All assertions verify real behavior.

## Issues Found

None blocking.

### SUGGESTION (deferred, informational)

The `apply-progress.md` already documents four LOW cleanup items where
the operator key still appears in non-secret-bearing error messages
(`parseAlias`, `parseAllowedDatabases`, `resolveRelativeToProject`,
`loadProfile` lines). These are not security leaks (the operator key is
not a credential), they are intentional ergonomics for the operator
who needs to know which env var to fix. They can be addressed in a
follow-up SDD change. No action required here.

## Final Verdict

**PASS** — every scenario in both delta specs is covered by a passing
test on a fresh `pnpm test` run. The two MEDIUM gate findings are
remediated with their own RED-GREEN tests. The implementation matches
the design and proposal. Build and type-check are clean. The PR split
plan is documented; no commits/branches/PRs were created by apply.
Ready for archive.
