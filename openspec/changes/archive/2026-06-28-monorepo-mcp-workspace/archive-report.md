# Archive Report: monorepo-mcp-workspace

**Change**: `monorepo-mcp-workspace`
**Archived to**: `openspec/changes/archive/2026-06-28-monorepo-mcp-workspace/`
**Archive date**: 2026-06-28
**Artifact store mode**: hybrid
**SDD cycle status**: complete (explore → propose → spec → design → tasks → apply → verify → archive)

## Executive Summary

The `monorepo-mcp-workspace` change is archived. The migration from a single-package TypeScript repo to a pnpm + uv monorepo is complete: `mcp-readonly-sql` is now an independent app under `apps/mcp-readonly-sql/`, the workspace root is non-deployable, all commands resolve to a single app via per-app filters, and the MCP host launch path is now `<abs>/apps/mcp-readonly-sql/dist/index.js`. Verification is **PASS** with **130/130 tests green** (118 baseline + 12 new structural), `tsc --noEmit` clean, build produces the entrypoint at the new path, and the stdio server boots successfully. Two new domain specs (`monorepo-workspace`, `app-independence`) are now part of the global source of truth, and the `Launch Path` requirement has been merged into `mcp-tool-surface`. No commits, branches, or PRs were created during apply; the single-PR strategy is the contract for the commit/PR phase, which is explicitly out of scope for the SDD executor.

## Task Completion Gate

| Check | Result |
| ----- | ------ |
| Persisted tasks artifact exists | ✅ `openspec/changes/archive/2026-06-28-monorepo-mcp-workspace/tasks.md` |
| Implementation tasks total | 12 |
| Implementation tasks checked `[x]` | 12 |
| Unchecked implementation tasks | 0 |
| Gate status | **PASS** — archive permitted |

## Spec Merge Analysis

The spec merge is a **real merge** (not a no-op). Two new full specs are added to the global source of truth, and one delta requirement is appended to an existing spec while preserving all existing requirements.

### Delta → global mapping

| Delta spec | Delta requirement(s) | Global target | Action |
| ---------- | -------------------- | ------------- | ------ |
| `monorepo-workspace/spec.md` | Workspace Root Scaffold | `openspec/specs/monorepo-workspace/spec.md` | **Created** (new full spec, 5 requirements, 9 scenarios) |
| `monorepo-workspace/spec.md` | Per-App Command Surface | `openspec/specs/monorepo-workspace/spec.md` | **Created** (same file) |
| `monorepo-workspace/spec.md` | OpenSpec Per-App Filters | `openspec/specs/monorepo-workspace/spec.md` | **Created** (same file) |
| `monorepo-workspace/spec.md` | Workspace Root Is Not Deployable | `openspec/specs/monorepo-workspace/spec.md` | **Created** (same file) |
| `monorepo-workspace/spec.md` | Source Layout Boundary | `openspec/specs/monorepo-workspace/spec.md` | **Created** (same file) |
| `app-independence/spec.md` | App Self-Containment | `openspec/specs/app-independence/spec.md` | **Created** (new full spec, 4 requirements, 8 scenarios) |
| `app-independence/spec.md` | Independent Install, Test, Build | `openspec/specs/app-independence/spec.md` | **Created** (same file) |
| `app-independence/spec.md` | Independent Deployability | `openspec/specs/app-independence/spec.md` | **Created** (same file) |
| `app-independence/spec.md` | No Cross-App Code Paths | `openspec/specs/app-independence/spec.md` | **Created** (same file) |
| `mcp-tool-surface/spec.md` (delta) | Launch Path (ADDED) | `openspec/specs/mcp-tool-surface/spec.md` | **Appended** after the existing `No Dynamic Connection From User Input` requirement |

No `MODIFIED`, `REMOVED`, or `RENAMED` blocks were required. The existing 4 requirements in `mcp-tool-surface` are preserved verbatim.

## Specs Synced

| Domain | Action | Details |
| ------ | ------ | ------- |
| `monorepo-workspace` | **Created** | 5 new requirements, 9 new scenarios — copied from `openspec/changes/monorepo-mcp-workspace/specs/monorepo-workspace/spec.md` to `openspec/specs/monorepo-workspace/spec.md` |
| `app-independence` | **Created** | 4 new requirements, 8 new scenarios — copied from `openspec/changes/monorepo-mcp-workspace/specs/app-independence/spec.md` to `openspec/specs/app-independence/spec.md` |
| `mcp-tool-surface` | **Appended** | 1 new requirement (`Launch Path`, 3 scenarios) added; existing 4 requirements preserved unchanged |

## Source of Truth

The following specs are the canonical post-archive source of truth for the new behavior:

- `openspec/specs/monorepo-workspace/spec.md` (new)
- `openspec/specs/app-independence/spec.md` (new)
- `openspec/specs/mcp-tool-surface/spec.md` (updated — Launch Path appended)

Pre-existing specs not touched by this change:

- `openspec/specs/profiles/spec.md` (unchanged)

## Archive Contents

| File | Status |
| ---- | ------ |
| `proposal.md` | ✅ present |
| `exploration.md` | ✅ present |
| `specs/monorepo-workspace/spec.md` | ✅ present (delta) |
| `specs/app-independence/spec.md` | ✅ present (delta) |
| `specs/mcp-tool-surface/spec.md` | ✅ present (delta) |
| `design.md` | ✅ present |
| `tasks.md` | ✅ present (12/12 checked) |
| `apply-progress.md` | ✅ present |
| `verify-report.md` | ✅ present (verdict: PASS) |
| `archive-report.md` | ✅ present (this file) |

The active `openspec/changes/monorepo-mcp-workspace/` directory has been removed; the change is now only visible at `openspec/changes/archive/2026-06-28-monorepo-mcp-workspace/`.

## Verification Snapshot

| Check | Result |
| ----- | ------ |
| `pnpm --filter mcp-readonly-sql test` | **PASS** — 130/130 tests across 7 files (848ms) |
| `pnpm --filter mcp-readonly-sql typecheck` | **PASS** — clean (no errors) |
| `pnpm --filter mcp-readonly-sql build` | **PASS** — produces `apps/mcp-readonly-sql/dist/index.js` (+ declarations + sourcemaps) |
| `node apps/mcp-readonly-sql/dist/index.js` | **PASS** — stdio server boots, waits for JSON-RPC input |
| All 12 implementation tasks | ✅ all checked |
| `verify-report.md` verdict | **PASS** |
| CRITICAL issues blocking archive | None |
| WARNING issues blocking archive | None |
| Deferred scenarios | 3 (all Python-app related, in-scope deferral per proposal "Out of Scope") |

## Deviations Preserved in the Audit Trail

These deviations are documented in `apply-progress.md` and `verify-report.md` and do not affect the archive verdict:

1. **`.gitignore` does not include `**/data`** — only `**/data/*.sqlite*` etc. Preserves `apps/mcp-readonly-sql/data/.gitkeep` trackability. Spec text is preserved verbatim.
2. **No `uv` command was executed** — `uv` is not on the host PATH. The `[tool.uv.workspace]` scaffold is in place and waits for the first Python app (explicitly out of scope for this change).
3. **Root `README.md` was replaced** — old 275-line content preserved verbatim in `apps/mcp-readonly-sql/README.md`. New root README is a concise workspace overview.

## Commits / Branches / PRs Created in This Run

**None.** This SDD cycle edited files and tests in the working tree only. Commit/PR creation is out of scope for the SDD executor. The single-PR strategy documented in `tasks.md` (auto-forecast, no chain) is the contract for the commit/PR phase.

## OpenSpec Engram Observation Lineage

The change also lives in the Engram persistent store (hybrid mode). Observation IDs for cross-session recovery and traceability:

| Artifact | Engram observation ID | Sync ID |
| -------- | --------------------- | ------- |
| `sdd/monorepo-mcp-workspace/explore` | #36 | `obs-1cc76eb6b2c7785e` |
| `sdd/monorepo-mcp-workspace/proposal` | #39 | `obs-99aeb25375b6d7e1` |
| `sdd/monorepo-mcp-workspace/spec` | #40 | `obs-65bbe91f773dd714` |
| `sdd/monorepo-mcp-workspace/design` | #41 | `obs-dcf1c8e0daef8ad9` |
| `sdd/monorepo-mcp-workspace/tasks` | #43 | `obs-24abf30527a04222` |
| `sdd/monorepo-mcp-workspace/apply-progress` | #48 | `obs-5dd6ee8609de5c80` |
| `sdd/monorepo-mcp-workspace/verify-report` | #52 | `obs-36b5859117cdbdd2` |
| Decisions / discoveries / session summaries | #37, #42, #44, #45, #46, #47, #50 | `obs-4848600d45bd25ce`, `obs-c964ef58da08258e`, `obs-bf1e268939b8889e`, `obs-488bfdb2e4bde7c1`, `obs-c6d3cb0dc92c22e5`, `obs-8d98080d6010f8f5`, `obs-a5c6ac6fcfebe9d2` |
| `sdd/monorepo-mcp-workspace/archive-report` (this report) | (new — recorded below) | (returned by `mem_save`) |

## SDD Cycle Complete

| Phase | Artifact | Status |
| ----- | -------- | ------ |
| Explore | `exploration.md` | ✅ done |
| Propose | `proposal.md` | ✅ done |
| Spec | `specs/{monorepo-workspace,app-independence,mcp-tool-surface}/spec.md` (deltas) | ✅ done |
| Design | `design.md` | ✅ done |
| Tasks | `tasks.md` | ✅ done (12 tasks, all checked) |
| Apply | `apply-progress.md` | ✅ done (Strict TDD, 130/130 tests, single PR strategy) |
| Verify | `verify-report.md` | ✅ PASS (no CRITICAL issues, 3 deferred scenarios in-scope) |
| Archive | `archive-report.md` (this file) | ✅ done (2 new full specs created, 1 delta appended, folder moved, this report persisted to Engram) |

The change has been fully planned, implemented, verified, and archived. Ready for the next change.
