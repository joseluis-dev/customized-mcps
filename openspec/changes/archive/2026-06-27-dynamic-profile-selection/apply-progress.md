# Apply Progress: Dynamic Profile Selection

**Change**: dynamic-profile-selection
**Mode**: Strict TDD
**Status**: All 4 phases complete (16/16 tasks) + gate remediation pass (3 new tests)

## Delivery Decision

- **Strategy**: chained PRs (stacked-to-main)
- **Rationale**: implementation+tests diff exceeded the 800-line review budget; tasks.md forecast flipped from Low → High in the post-apply gate.
- **Chain strategy**: stacked-to-main
- **No commits, branches, or PRs were created in this run** — chain plan documented only.

### PR Split Plan (stacked-to-main)

Each PR targets the previous PR's branch (or `main` after the previous merges). Order is dependency-driven.

| PR | Scope | Files (planned) | Depends on | Verification |
|----|-------|-----------------|------------|--------------|
| **PR 1** | SecretProvider foundation + tests | `src/secrets/SecretProvider.ts`, `test/secretRefs.test.ts` | — | `pnpm test` for `secretRefs.test.ts`; `pnpm build`; `tsc --noEmit` |
| **PR 2** | Profile alias/display/capabilities/collisions + tests | `src/types.ts`, `src/config/profiles.ts`, `test/profiles.test.ts` (alias/metadata/collision) | PR 1 | `pnpm test` for `profiles.test.ts`; `pnpm build`; `tsc --noEmit` |
| **PR 3** | Tool surface, strict zod, logging, sanitization + tests | `src/tools/readonlyTools.ts`, `src/security/sanitizeError.ts`, `src/index.ts`, `test/profileAlias.test.ts`, `test/sanitizeError.test.ts` | PR 2 | `pnpm test` (full); `pnpm build`; `tsc --noEmit` |
| **PR 4** | Docs + SDD artifacts / final verification | `README.md`, `.env.example`, `openspec/changes/dynamic-profile-selection/*` | PR 3 | `pnpm test`; `pnpm build`; `tsc --noEmit`; review `list_profiles` backward compat |

### Dependency diagram

```
PR 1 (SecretProvider) ─▶ PR 2 (Profile + Alias) ─▶ PR 3 (Tool Surface) ─▶ PR 4 (Docs)
   │                        │                          │                     │
   └── tests pass            └── tests pass             └── tests pass        └── verify
```

📍 This apply batch implemented every PR's content monolithically (no separate branches) so verify and archive can run end-to-end. The split is documented for when commits are carved out for review.

## Gate Remediation (post-apply)

Fresh apply gate found **PASS WITH WARNINGS**. Two MEDIUM findings remediated; LOW cleanup deferred per orchestrator instruction ("Do not over-expand scope; prioritize the two MEDIUM findings").

### TDD Cycle Evidence (remediation)

| Task | Test File | Layer | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|-----|-------|-------------|----------|
| R-1.1 (MEDIUM-1) | `test/profiles.test.ts` | Unit | ✅ Written | ✅ Passed | ➖ Single case | ✅ Clean (signature change minimal) |
| R-1.2 (MEDIUM-2 displayName) | `test/profiles.test.ts` | Unit | ✅ Written | ✅ Passed | ➖ Single case | ✅ Clean |
| R-1.3 (MEDIUM-2 tags) | `test/profiles.test.ts` | Unit | ✅ Written | ✅ Passed | ➖ Same predicate | ✅ Clean |

**Test Summary (remediation)**:
- Total new tests: 3 (all passing)
- Total passing after remediation: 112/112 (was 109/109)
- Layers: Unit only
- Triangulation: skipped per "Single case" — the existing alias-falls-back-to-operator-key test (alias === operator key) already covered the equal case; the new tests cover the distinct case
- Pure functions touched: `resolvePassword`, `parseMetadata`, `warnUnsafeMetadata` (all remained pure / no side effects beyond stderr.write)

### MEDIUM-1 Remediation: `resolvePassword` uses alias

**Before**: `resolvePassword(envName, profileName, ...)` — the `profileName` parameter was actually the **operator key** (e.g., `SQLSERVER_BI`). The `ProfileError` message interpolated `${envName}` (which embeds the operator key via `DB_<OPERATOR_KEY>_PASSWORD`) and set `alias: profileName`.

**After**: `resolvePassword(envName, alias, ...)`. Threaded the computed `alias` from `loadProfile` through `buildConnection(name, alias, ...)`. `ProfileError.alias` now carries the alias. The message no longer interpolates `envName` (which was the secondary leak vector: the env var name itself contains the operator key). New message: `Profile "bi_catastro": could not resolve the connection password (file kind)`.

**Files changed**:
- `src/config/profiles.ts` — `buildConnection` signature extended with `alias`; `resolvePassword` parameter renamed and re-typed; `loadProfile` passes the computed `alias` to both.

**Test added** (R-1.1): `names the alias (not the operator key) in ProfileError when a ${secret:file:...} fails to resolve` — uses `DB_SQLSERVER_BI_*` with `DB_SQLSERVER_BI_ALIAS=bi_catastro` and a missing secret file. Asserts `ProfileError.alias === "bi_catastro"`, message contains `bi_catastro`, and message does NOT contain `SQLSERVER_BI`, the missing path, `localhost`, `readonly`, or `${secret:file:`.

### MEDIUM-2 Remediation: `warnUnsafeMetadata` uses alias

**Before**: `parseMetadata(name)` called `warnUnsafeMetadata(name, "displayName" | "description" | "tags")` where `name` is the operator key. Stderr warning read e.g. `Profile "SQLSERVER_BI": omitted unsafe displayName (...)`.

**After**: `parseMetadata(name, alias)` accepts the computed alias. `warnUnsafeMetadata(alias, field)` writes the alias to stderr. New warning: `Profile "bi_catastro": omitted unsafe displayName (...)`.

**Files changed**:
- `src/config/profiles.ts` — `parseMetadata` signature extended; `warnUnsafeMetadata` parameter renamed; `loadProfile` passes `alias`.

**Tests added**:
- R-1.2 (displayName): `warns to stderr with alias (not operator key) when displayName matches an unsafe pattern` — uses `DB_SQLSERVER_BI_DISPLAY_NAME=Server=db;password=hunter2;` with alias `bi_catastro`. Asserts `p.displayName === undefined` (unsafe value dropped) AND stderr captures contain `bi_catastro`, NOT `SQLSERVER_BI`, NOT `hunter2`, NOT `password=`.
- R-1.3 (tags): `warns to stderr with alias (not operator key) when a tag matches an unsafe pattern` — uses `DB_SQLSERVER_BI_TAGS=bi,password=hunter2` with alias `bi_catastro`. Asserts `p.tags === ["bi"]` AND stderr contains `bi_catastro`, NOT `SQLSERVER_BI`, NOT `hunter2`.

Both tests use `vi.spyOn(process.stderr, "write")` to capture and assert on stderr output without polluting test output.

### LOW cleanup (deferred)

Per orchestrator instruction "Do not over-expand scope", the LOW cleanup was NOT attempted. Outstanding operator-key-leak vectors still present in the same file (informational rather than secret-bearing, no env var name embedded in security context):

- `parseAlias` (line ~44/52): `Profile "${name}": alias exceeds / alias must match ...` — `name` is operator key. Intentional ergonomics: the operator sees which env var to fix. Could be improved by including the alias attempt.
- `parseAllowedDatabases` (line ~330/341/347): `Profile "${name}": DB_${name}_ALLOWED_DATABASES is required / must list at least one / invalid database identifier "${p}"` — `DB_${name}_ALLOWED_DATABASES` embeds the operator key. Same pattern as MEDIUM-1; same low-risk fix.
- `resolveRelativeToProject` (line ~203/209/216): `Profile "${profileName}": SQLite filename ...` — `profileName` is operator key.
- `loadProfile` (line ~372/379): `Invalid profile name: ${name}` and `Unsupported dialect for profile ${name}: ${dialect}`.

These can be addressed in a follow-up SDD change if desired.

## TDD Cycle Evidence (original 16 tasks — preserved from prior apply)

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1 | `test/secretRefs.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 4 cases | ✅ Clean |
| 1.2 | `test/secretRefs.test.ts` | Unit | N/A (new) | ✅ Written | ✅ Passed | ➖ Same file | ✅ Clean |
| 1.3 | `test/profiles.test.ts` | Unit | ✅ 68/68 baseline | ✅ Written | ✅ Passed | ✅ 2 cases | ✅ Clean |
| 1.4 | `test/profiles.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ➖ N/A | ✅ Clean |
| 2.1 | `test/profiles.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ✅ 6 cases | ✅ Clean |
| 2.2 | `test/profiles.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ➖ N/A | ✅ Clean |
| 2.3 | `test/profiles.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ✅ 2 cases | ✅ Clean |
| 2.4 | `test/profiles.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ➖ N/A | ✅ Clean |
| 2.5 | `test/profiles.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ✅ 5 cases | ✅ Clean |
| 2.6 | `test/profiles.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ➖ N/A | ✅ Clean |
| 2.7 | n/a | n/a | n/a | n/a | n/a | n/a | ✅ 96/96 |
| 3.1 | `test/profileAlias.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ✅ 4 cases | ✅ Clean |
| 3.2 | `test/profileAlias.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ➖ N/A | ✅ Clean |
| 3.3 | `test/sanitizeError.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ✅ 3 cases | ✅ Clean |
| 3.4 | `test/sanitizeError.test.ts` | Unit | n/a | ✅ Written | ✅ Passed | ➖ N/A | ✅ Clean |
| 3.5 | `src/index.ts` | Integration | ✅ 96/96 | ✅ Written | ✅ Passed | ➖ N/A | ✅ Clean |
| 3.6 | n/a | n/a | n/a | n/a | n/a | n/a | ✅ 109/109 |
| R-1.1 | `test/profiles.test.ts` | Unit | ✅ 109/109 | ✅ Written | ✅ Passed | ➖ Single | ✅ Clean |
| R-1.2 | `test/profiles.test.ts` | Unit | ✅ 110/110 | ✅ Written | ✅ Passed | ➖ Single | ✅ Clean |
| R-1.3 | `test/profiles.test.ts` | Unit | ✅ 111/111 | ✅ Written | ✅ Passed | ➖ Single | ✅ Clean |

## Test Summary (cumulative)

- **Total tests written**: 44 (41 original + 3 remediation)
- **Total tests passing**: 112/112
- **Layers used**: Unit (112), Integration (0), E2E (0)
- **Approval tests** (refactoring): 0
- **Pure functions created**: `parseSecretRef`, `isUnsafeDisplayMetadata`, `parseAlias`, `parseCommaList`, `parseMetadata`, `resolvePassword`, `checkAliasCollisions`

## Files Changed (cumulative)

| File | Action | What Was Done |
|------|--------|---------------|
| `src/types.ts` | Modified | Added `alias`, `operatorKey`, `displayName?`, `description?`, `tags?[]`, `capabilities` to `Profile`; extended `ProfileSummary` additively |
| `src/config/profiles.ts` | Modified | Async `loadProfile`/`loadAllProfiles`; alias/display/capabilities parsing; case-insensitive collision check; unsafe-metadata predicate; `${secret:file:...}` resolution with masked `ProfileError`; **(remediation) threaded computed `alias` through `buildConnection`→`resolvePassword` and into `parseMetadata`→`warnUnsafeMetadata`** |
| `src/secrets/SecretProvider.ts` | Created | Async `SecretProvider` interface; `FileSecretProvider` using `node:fs/promises.readFile` with `AbortSignal.timeout` composition |
| `src/tools/readonlyTools.ts` | Modified | `aliasMap`+`operatorKeyMap`; `name===alias`; `.strict()` zod schemas; alias-keyed error messages |
| `src/security/sanitizeError.ts` | Modified | Mask `${secret:...}` literals, DSN-style credential pairs, `user:pass@` URI fragments |
| `src/index.ts` | Modified | `await loadAllProfiles`; log aliases only |
| `test/profiles.test.ts` | Modified | All 11 existing tests async; 14 new tests for alias/display/collisions/secrets; **3 new tests for MEDIUM-1/2 remediation** (alias-not-operator-key on secret failure and unsafe metadata warning) |
| `test/secretRefs.test.ts` | Created | 12 tests for `FileSecretProvider` and `parseSecretRef` |
| `test/profileAlias.test.ts` | Created | 9 tests for tool surface (summary shape, lookup, strict schemas) |
| `test/sanitizeError.test.ts` | Created | 4 tests for sanitization |
| `README.md` | Modified | Alias vs operator key; safe summaries; `${secret:file:...}` pattern; default `capabilities` |
| `.env.example` | Modified | New env vars documented; one `${secret:file:...}` example |

## Deviations from Design

- **`.strict()` on `list_profiles`**: Implemented — extra fields rejected.
- **Case-insensitive alias/operator-key collision**: Implemented case-insensitive comparison.
- **`ProfileError` `kind`/`alias` fields**: Added for diagnostics; message is still sanitized.
- **(Remediation) `resolvePassword` message drops `envName`**: Design said ProfileError must not include distinct operator keys. The env var name `DB_<OPERATOR_KEY>_PASSWORD` embeds the operator key, so it was removed. Message is now `Profile "${alias}": could not resolve the connection password (${kind} kind)` — non-leaking and operator-actionable.
- **(Remediation) `warnUnsafeMetadata` uses alias**: Design said warnings name alias + field only. Parameter renamed from `operatorKey` to `alias`; `parseMetadata` takes the computed alias and passes it through.

## Issues Found

None — remediation completed without regression. All 109 pre-existing tests still pass.

## Remaining Tasks

None for this change. Verify and archive phases follow.

## Workload / PR Boundary

- **Mode**: chained PR (stacked-to-main) — planned split documented above
- **Current work unit**: full change delivered monolithically in this apply run; the PR split plan is the contract for splitting into reviewable slices later
- **Boundary**: 4-PR chain per the split table above
- **Estimated review budget impact per PR**: each PR is roughly the size of one work unit (~100-180 LoC), within the 400-line per-PR budget. Total stack is over budget; that is the entire reason for splitting.
- **No commits, branches, or PRs were created in this run.** This apply run only edited files and tests; commit/PR creation is out of scope for the executor.

## Final Verification

- `pnpm test`: 112/112 passing (109 baseline + 3 remediation)
- `pnpm build`: clean
- `pnpm exec tsc -p tsconfig.json --noEmit`: clean
- Legacy `.env` (no `DB_*_ALIAS`): loads with `alias === operatorKey` (still covered by `defaults alias to operator key when DB_<NAME>_ALIAS is not set` test)
- `list_profiles` backward compatibility: original 5 fields preserved, new fields additive
- Remediation evidence: MEDIUM-1 and MEDIUM-2 gate findings remediated with new RED-GREEN tests
