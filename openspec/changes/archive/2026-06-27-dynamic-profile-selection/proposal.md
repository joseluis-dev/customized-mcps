# Proposal: Dynamic Profile Selection

## Intent

Today MCP clients pass the operator-side env key (e.g. `SQLSERVER_BI`) as `profile`, exposing operator naming and giving no way to source `PASSWORD` from a file or secret store. The agent also has no human-friendly way to choose among profiles by role/purpose. Add an **MCP-facing alias** plus display metadata; keep connection fields server-side; add opt-in secret references. Existing `.env` setups keep working unchanged.

## Scope

### In Scope
- New optional env vars per profile: `DB_<NAME>_ALIAS`, `DB_<NAME>_DISPLAY_NAME`, `DB_<NAME>_DESCRIPTION`, `DB_<NAME>_TAGS` (comma list).
- `ProfileSummary` is **additive**: keep `name`, `dialect`, `scope`, `allowedDatabases`, `requireQualifiedDatabase`; add `alias`, `displayName?`, `description?`, `tags?[]`, `capabilities?` (e.g. `["read-only"]`). `alias` defaults to the operator key; `name` retained for backward compatibility.
- `SecretProvider` interface + `EnvSecretProvider` (default, no prefix) + `FileSecretProvider` (`${secret:file:/abs/path}`); loader detects prefix on secret-bearing fields; non-leaking `ProfileError` on failure.
- Tool inputs (`test_connection`, `list_databases`, `execute_read_query`, `describe_schema`) accept the **alias OR the operator key**; regex unchanged. Errors reference the value the caller sent.
- Startup: alias regex `^[A-Za-z0-9_]+$` (1-64); alias uniqueness across all profiles.
- TDD coverage in `test/profiles.test.ts` + new `test/profileAlias.test.ts` + `test/secretRefs.test.ts`. README + `.env.example` updated.

### Out of Scope
- Dynamic runtime connection from user-supplied `host`/`user`/`password` (security policy).
- File-based config (`profiles.json`/YAML), `select_profile` tool, session default, live rotation, RBAC, audit, telemetry, billing.
- Removing or renaming any existing `ProfileSummary` field; deprecating any current behavior.

## Capabilities

### New Capabilities
- `profiles`: alias + display metadata + opt-in secret references + alias uniqueness + alias-referenced error contract.
- `mcp-tool-surface`: additive `ProfileSummary` fields; `profile` argument accepts alias or operator key.

### Modified Capabilities
- None (no spec exists in `openspec/specs/` yet).

## Approach

Parse new env vars in `loadProfile`; `ProfileSummary` builder enriches each profile with `alias` (default = operator key) and optional display/tags/capabilities. Secret-bearing field reader wraps `readString` with a prefix detector that delegates to `SecretProvider.resolve`. Profile resolution in tool handlers tries alias first, then operator key. Errors keyed on the value the caller sent. All `ProfileSummary` fields (existing + new) are safe to surface; raw connection fields, secret references, and operator keys (when distinct from alias) stay server-side.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/config/profiles.ts` | Modified | Parse new env vars; alias default; secret-ref detection in `buildConnection`. |
| `src/secrets/SecretProvider.ts` | New | Interface + `EnvSecretProvider` + `FileSecretProvider`. |
| `src/types.ts` | Modified | `Profile` + `ProfileSummary` gain alias/display/tags/capabilities (additive). |
| `src/tools/readonlyTools.ts` | Modified | Enriched summaries; alias-or-key resolution; alias-keyed errors. |
| `src/index.ts` | Modified | Log line lists aliases. |
| `src/security/sanitizeError.ts` | Modified | Extend sensitive-key list. |
| Tests, README, `.env.example`, `openspec/specs/` | New/Modified | New vitest cases; docs; two new spec files. |

## Risks

| Risk | Lik | Mitigation |
|------|-----|------------|
| Operator key leaks via display fields | Low-Med | Loader warns when `displayName`/`description` match the password regex. |
| Alias collision at startup | Low | Duplicate-alias check; non-leaking `ProfileError`. |
| Secret ref hangs at startup | Low | Per-resolve timeout; masked `ProfileError`. |
| Backward compat with existing `.env` | Low | All new fields optional; `alias` defaults to operator key; tool inputs accept operator key. |
| Secret ref literal in error/log | Low | Single formatter; scrub in `sanitizeError`. |

## Rollback Plan

1. Revert the merge commit; existing `.env` files keep working because all new fields are optional and `alias` defaults to the operator key.
2. **No flag re-exposes operator keys or secret fields** — the security boundary holds even during rollback.
3. TDD coverage flags regressions in CI; revert PR is the single-step recovery.

## Dependencies

- None external; stdlib (`node:fs/promises`, `node:path`), existing `dotenv`; `vitest` 2.1 (devDep). Estimated 300-500 LoC, single chainable PR (well under 800-line review budget).

## Success Criteria

- [ ] `list_profiles` exposes `name`, `dialect`, `scope`, `allowedDatabases`, `requireQualifiedDatabase` PLUS `alias`, `displayName?`, `description?`, `tags?[]`, `capabilities?`; never `host`/`user`/`password`/`port`/raw secret refs.
- [ ] Tool inputs accept alias OR operator key (default = operator key); errors reference the caller's value; duplicate alias fails non-leaking.
- [ ] `${secret:file:/abs/path}` resolved at startup; literal never appears in logs or errors.
- [ ] `pnpm test`, `pnpm build`, `tsc --noEmit` pass; README + `.env.example` document new vars and `${secret:...}` with one example per pattern.
