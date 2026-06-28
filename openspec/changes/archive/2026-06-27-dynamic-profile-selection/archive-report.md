# Archive Report: dynamic-profile-selection

**Change**: `dynamic-profile-selection`
**Archived to**: `openspec/changes/archive/2026-06-27-dynamic-profile-selection/`
**Archive date**: 2026-06-27
**Artifact store mode**: hybrid
**SDD cycle status**: complete (propose → spec → design → tasks → apply → verify → archive)

## Executive Summary

The `dynamic-profile-selection` change is archived. The implementation satisfies every scenario in both delta specs (`profiles`, `mcp-tool-surface`), the apply gate remediation (2 MEDIUM findings) was completed in-place, and verification passed end-to-end with **112/112 tests green**, `pnpm build` clean, and `tsc --noEmit` clean. No commits, branches, or PRs were created during apply — the 4-PR stacked-to-main split plan is preserved here as the contract for the commit/PR phase, which is explicitly out of scope for the SDD executor.

## Spec Merge Analysis

The spec merge is a **no-op**. The global source-of-truth specs at:

- `openspec/specs/profiles/spec.md`
- `openspec/specs/mcp-tool-surface/spec.md`

already contain every requirement from the two change-local delta specs. The spec phase produced these global specs as full specs (not as empty stubs to be filled later) because the project's `openspec/specs/` tree was empty when this change started. Every requirement from the delta maps 1:1 to an existing requirement in the global spec:

### `profiles` (delta → global)

| Delta requirement | Global requirement | Status |
|---|---|---|
| Alias Defaulting | Alias Defaulting | Identical (no MODIFIED delta) |
| Alias Validation | Alias Validation | Identical |
| Alias Uniqueness | Alias Uniqueness | Identical |
| Display Metadata | Display Metadata | Identical |
| Secret Reference Resolution | Secret Reference Resolution | Identical |
| Non-Leaking ProfileError | Non-Leaking ProfileError | Identical |
| Backward Compatibility | Backward Compatibility | Identical |

### `mcp-tool-surface` (delta → global)

| Delta requirement | Global requirement | Status |
|---|---|---|
| `list_profiles` Additive Output | `list_profiles` Additive Output | Identical |
| `profile` Argument Resolution | `profile` Argument Resolution | Identical |
| Error Contract | Error Contract | Identical |
| No Dynamic Connection From User Input | No Dynamic Connection From User Input | Identical |

No `MODIFIED`, `REMOVED`, or `RENAMED` blocks were required. The global specs were authored as canonical specs and the deltas record the same content for change-local traceability. **No file write was needed for the spec merge.**

## Specs Synced

| Domain | Action | Details |
|---|---|---|
| `profiles` | **No-op** | Global spec at `openspec/specs/profiles/spec.md` already contains all 7 delta requirements |
| `mcp-tool-surface` | **No-op** | Global spec at `openspec/specs/mcp-tool-surface/spec.md` already contains all 4 delta requirements |

## Source of Truth

The following specs are the canonical post-archive source of truth for the new behavior and require no further updates:

- `openspec/specs/profiles/spec.md`
- `openspec/specs/mcp-tool-surface/spec.md`

## Archive Contents

| File | Status |
|---|---|
| `proposal.md` | ✅ present |
| `specs/profiles/spec.md` | ✅ present (delta) |
| `specs/mcp-tool-surface/spec.md` | ✅ present (delta) |
| `design.md` | ✅ present |
| `tasks.md` | ✅ present (16/16 + 3 gate-remediation tasks all checked) |
| `apply-progress.md` | ✅ present |
| `verify-report.md` | ✅ present (verdict: PASS) |
| `exploration.md` | ✅ present |
| `archive-report.md` | ✅ present (this file) |

The active `openspec/changes/dynamic-profile-selection/` directory has been removed; the change is now only visible at `openspec/changes/archive/2026-06-27-dynamic-profile-selection/`.

## Verification Snapshot

| Check | Result |
|---|---|
| `pnpm test` | **PASS** — 5 files, 112/112 tests |
| `pnpm build` | **PASS** — emits `dist/` (16 source + 3 map files) |
| `pnpm exec tsc -p tsconfig.json --noEmit` | **PASS** — no output, no errors |
| All 16 implementation tasks | ✅ all checked |
| 3 gate-remediation tasks (R-1.1, R-1.2, R-1.3) | ✅ all checked |
| `verify-report.md` verdict | **PASS** |
| CRITICAL issues blocking archive | None |

## Stacked-to-Main PR Split Plan (preserved)

The user chose `delivery_strategy: chained PRs due to actual budget overrun` with `chain_strategy: stacked-to-main`. The apply gate estimated the implementation+tests diff at ~1,473 changed lines, exceeding the 800-line review budget. The following 4-PR split is the contract for the commit/PR phase (out of scope for the SDD executor; no branches or PRs were created in this run).

### PR order

| # | Scope | Files (planned) | Depends on | Verification |
|---|-------|-----------------|------------|--------------|
| **PR 1** | `SecretProvider` foundation + tests | `src/secrets/SecretProvider.ts`, `test/secretRefs.test.ts` | — | `pnpm test` for `secretRefs.test.ts`; `pnpm build`; `tsc --noEmit` |
| **PR 2** | Profile alias/display/capabilities/collisions + tests | `src/types.ts`, `src/config/profiles.ts`, `test/profiles.test.ts` (alias/metadata/collision) | PR 1 | `pnpm test` for `profiles.test.ts`; `pnpm build`; `tsc --noEmit` |
| **PR 3** | Tool surface, strict zod, logging, sanitization + tests | `src/tools/readonlyTools.ts`, `src/security/sanitizeError.ts`, `src/index.ts`, `test/profileAlias.test.ts`, `test/sanitizeError.test.ts` | PR 2 | `pnpm test` (full); `pnpm build`; `tsc --noEmit` |
| **PR 4** | Docs + SDD artifacts / final verification | `README.md`, `.env.example`, `openspec/changes/dynamic-profile-selection/*` | PR 3 | `pnpm test`; `pnpm build`; `tsc --noEmit`; review `list_profiles` backward compat |

### Dependency diagram

```
PR 1 (SecretProvider) ─▶ PR 2 (Profile + Alias) ─▶ PR 3 (Tool Surface) ─▶ PR 4 (Docs)
   │                        │                          │                     │
   └── tests pass            └── tests pass             └── tests pass        └── verify
```

### Stacked-to-main mechanics

- Each PR targets the **previous PR's branch** (or `main` after the previous PR merges).
- Stacked means: until the chain merges, every child PR shows its parents in the diff — reviewers view incremental slices, not the whole stack.
- Once a PR merges, the next one is retargeted to `main` (or the trunk) so its diff is clean.

### Estimated per-PR review budget

Each PR is roughly the size of one work unit (~100-180 LoC), within the 400-line per-PR review budget. The total stack is over budget; that is the entire reason for splitting.

### Commits / branches / PRs created in this run

**None.** This SDD cycle edited files and tests in the working tree only. Commit/PR creation is out of scope for the SDD executor. Verified at archive time:

- `git log --oneline` shows a single commit (`3a464dd Initialize mcp-readonly-sql...`) — no new commits.
- `git branch -a` shows only `main` — no working branches, no remote tracking branches.
- `git remote -v` is empty — no remotes, so no PRs could have been pushed.
- `git status --short` confirms all changes are uncommitted working-tree edits plus untracked files (`openspec/`, `src/secrets/`, 3 new test files).

## OpenSpec Engram Observation Lineage

The change also lives in the Engram persistent store (hybrid mode). Observation IDs for cross-session recovery and traceability:

| Artifact | Engram observation ID | Sync ID |
|---|---|---|
| `sdd/dynamic-profile-selection/explore` | #13 | `obs-f7d04190ec82a866` |
| `sdd/dynamic-profile-selection/proposal` | #14 | `obs-f9cf643ec49ad990` |
| `sdd/dynamic-profile-selection/spec` | #16 | `obs-af1473962ebe5c56` |
| `sdd/dynamic-profile-selection/design` | #19 | `obs-2402b3b112792f40` |
| `sdd/dynamic-profile-selection/tasks` | #20 | `obs-a7dc62b222427e1e` |
| `sdd/dynamic-profile-selection/apply-progress` | #23 | `obs-c0fa20cebd6be1f1` |
| SDD verify PASS for dynamic-profile-selection | #25 | `obs-7ccac4ff9ae7304d` |
| Related decisions / bugfixes | #15, #18, #21, #24 | `obs-885a2fa14e37d23e`, `obs-a0b9e5de8e71fa54`, `obs-db5ecc537dcdd865`, `obs-19c0d6858bf67228` |
| `sdd/dynamic-profile-selection/archive-report` (this report) | #26 | `obs-2c0fffa424dfae24` |

## SDD Cycle Complete

| Phase | Artifact | Status |
|---|---|---|
| Explore | `exploration.md` | ✅ done |
| Propose | `proposal.md` | ✅ done (corrected to additive `ProfileSummary` + safe rollback, see Engram #15) |
| Spec | `specs/profiles/spec.md`, `specs/mcp-tool-surface/spec.md` (deltas) + global specs at `openspec/specs/{profiles,mcp-tool-surface}/spec.md` | ✅ done (spec fix: alias vs operator key identity boundary, see Engram #18) |
| Design | `design.md` | ✅ done (corrected to async secret resolution + `AbortSignal.timeout`, see Engram #21) |
| Tasks | `tasks.md` | ✅ done (16 tasks + 3 gate-remediation tasks) |
| Apply | `apply-progress.md` | ✅ done (strict TDD, 112/112 tests, all tasks checked) |
| Verify | `verify-report.md` | ✅ PASS (no CRITICAL issues) |
| Archive | `archive-report.md` (this file) | ✅ done (no-op merge, folder moved, this report persisted to Engram) |

The change has been fully planned, implemented, verified, and archived. Ready for the next change.
