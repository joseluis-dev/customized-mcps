# Archive Report: Dedicated MCP Server Deployment

**Change**: `dedicated-mcp-server-deployment`
**Archived**: 2026-06-28
**Mode**: hybrid (OpenSpec filesystem + Engram)
**Verdict**: FINAL PASS — 0 critical issues

---

## Change Summary

Ship the first dedicated MCP server deployment pattern for the workspace: a shared HTTP transport + auth foundation (`@db/mcp-http-base`), the `mcp-readonly-sql` app wired to it (stdio + Streamable HTTP, per-agent HMAC bearer auth, scope-based authorization), and operational templates (systemd unit, multi-stage Dockerfile, nginx reverse proxy example, runbook) so future TS and Python MCPs can adopt the same shape.

## Completeness

| Metric | Value |
|---|---|
| Tasks total | 70 |
| Tasks complete | **70/70 (100%)** |
| Phase 1 (PR1 base) | 12/12 `[x]` |
| Phase 2 (PR2 app wiring) | 12/12 `[x]` |
| Phase 3 (PR3 deploy templates) | 5/5 `[x]` |
| Phase 4 (Cross-PR verification) | 4/4 `[x]` |
| Phase 5 (PR1 remediation #1) | 15/15 `[x]` (R1–R15) |
| Phase 6 (PR1 remediation #2) | 15/15 `[x]` (B1–B3 + C4–C8 + W9–W15) |
| Phase 8 (PR2-WARN remediation) | 7/7 `[x]` |
| Tests | **382/382 passed** (134 `@db/mcp-http-base` + 248 `mcp-readonly-sql`) |
| Typecheck | Clean (recursive) |
| Build | Clean (recursive) |
| CRITICAL issues | 0 |
| Blocking warnings | 0 |

## Synced Specs

| Domain | Action | Source |
|---|---|---|
| `mcp-http-transport` | **Created** (215 lines, 11 requirements) | full delta spec |
| `mcp-agent-authorization` | **Created** (170 lines, 9 requirements) | full delta spec |
| `mcp-deployment-templates` | **Created** (172 lines, 9 requirements) | full delta spec |
| `app-independence` | **Appended** "Transport Pluggability And Agent Authorization" requirement (4 scenarios) | delta `ADDED Requirements` |
| `mcp-tool-surface` | **Appended** "HTTP Transport Pointer" requirement (3 scenarios) | delta `ADDED Requirements` |

All other main specs (`monorepo-workspace`, `profiles`) UNCHANGED.

## Archive Location

```
openspec/changes/archive/2026-06-28-dedicated-mcp-server-deployment/
├── archive-report.md       (this file)
├── design.md
├── exploration.md
├── proposal.md
├── tasks.md                (all 70 tasks [x])
├── verify-report.md        (FINAL PASS, 0 critical, 382/382 tests)
└── specs/
    ├── app-independence/spec.md         (delta: ADDED 1 requirement)
    ├── mcp-agent-authorization/spec.md (full new spec)
    ├── mcp-deployment-templates/spec.md (full new spec)
    ├── mcp-http-transport/spec.md       (full new spec)
    └── mcp-tool-surface/spec.md         (delta: ADDED 1 requirement)
```

## Engram Observation Trace

| ID | Title | Type |
|---|---|---|
| #62 | `sdd/dedicated-mcp-server-deployment/tasks` | architecture |
| #63 | Chose stacked-to-main for MCP deployment PRs | decision |
| #64 | `sdd/dedicated-mcp-server-deployment/apply-progress` (Phase 4 final, Rev 8) | architecture |
| #66 | Applied MCP HTTP base PR1 | architecture |
| #73 | Reviewed MCP HTTP base PR1 blockers | discovery |
| #77 | Re-reviewed MCP HTTP base PR1 security | discovery |
| #82 | Re-review found MCP HTTP PR1 remaining blockers | discovery |
| #83 | Session summary: db | session_summary |
| #88 | Re-review found stateless resource leak CRITICAL | discovery |
| #94 | Session summary: db | session_summary |

## Key Outcomes

1. **Shared transport foundation** — `packages/mcp-http-base` (134 tests) provides `node:http` + `NodeStreamableHTTPServerTransport` + auth middleware + `/healthz` + SIGTERM drain, opt-in via `@db/mcp-http-base: workspace:*`.
2. **Multi-agent auth** — per-agent HMAC bearer tokens (`MCP_AGENTS_JSON` or `MCP_AGENTS_INLINE`), scopes `<verb>:<resource|*>`, `crypto.timingSafeEqual` constant-time compare, audit-safe error envelopes.
3. **Stateless default** — `MCP_HTTP_STATELESS=true` default isolates per-request transports; the only safe multi-agent shape in v1 because SDK 1.29 transport shares `sessionId` per instance.
4. **Operational templates** — systemd unit (16 hardening directives), multi-stage `node:20-alpine` Dockerfile (non-root + `HEALTHCHECK`), nginx example (TLS termination + `client_max_body_size 1m` + `Authorization` preserved), runbook covering prod / dev-staging / rotation / rollback.
5. **Cross-PR smoke verification** — Phase 4 added 27 end-to-end tests (HTTP smoke, stdio smoke, secret-grep, bypass-grep) against the real built `dist/index.js`; 0 secrets, 0 bypass flags, 0 TLS code in app.

## Documented v1 Deviations (non-blocking, acknowledged in verify report)

- **Scope enforcement at tool layer, not HTTP wire layer** — auth-gated by identity, scope checked by tools (v1.1 candidate for wire-level scope).
- **Shutdown lifecycle on Windows** — `child_process.kill` on Windows maps to forced kill (no SIGTERM primitive), so the smoke test accepts "503 | closed | other"; 503-during-drain itself is covered by `serverHardening.test.ts`.

## SDD Cycle Status

**COMPLETE.** The change is part of the deployed baseline. Future MCPs (TypeScript or Python) adopt the same transport + auth + deployment shape per the workspace specs.
