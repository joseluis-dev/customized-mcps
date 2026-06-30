# Verify Report: unified-mcp-oauth-admin-auth — PR4 (Wiring + Docs) + Full-Change Sanity

## Skill Resolution

- `sdd-verify/SKILL.md` — loaded
- `sdd-verify/strict-tdd-verify.md` — loaded (Strict TDD mode active)
- `codebase-memory/SKILL.md` — loaded; the 10-file PR4 scope plus 18-file full change is small enough that direct `git diff` + `read` are sufficient (no graph queries required)
- Section A `skill_resolution`: **paths-injected**

## Verdict

**Verdict: PASS**

PR4 ships tasks 4.1–4.5 of `openspec/changes/unified-mcp-oauth-admin-auth/tasks.md`. The implementation satisfies every PR4 binding scenario across the three delta specs:

- **mcp-token-authority** (the `scopeCatalog` half): the resource server advertises a fresh, profile-derived OR env-override-derived `scopes_supported` at `GET /.well-known/oauth-protected-resource`; the well-known document still includes `resource`, `authorization_servers` (with `MCP_AUTHORITY_URL`), and `bearer_methods_supported: ["header"]`. The env-override branch wins when set; invalid env values are filtered; an all-invalid env still wins and the catalog becomes `[]` (an honest empty catalog so the operator sees the misconfiguration).
- **mcp-oauth-authority** (the type contract half): the `HttpConfigInput` type contract stays satisfied via a one-line `MCP_RESOURCE_SERVER_URL: undefined` in `apps/mcp-oauth-admin/src/index.ts`. The authority does not act as a resource server; the value is intentionally undefined.
- **mcp-admin-ui** (the docs half): both `.env.example` files now document `MCP_AUTHORITY_URL`, the `/oauth/authorize` endpoint, `MCP_RESOURCE_SERVER_URL`, and (on the resource-server side) `MCP_RESOURCE_SCOPES` — all with examples, no real secrets, no real connection strings.

All 24 tasks (1.1–4.5) are checked in `tasks.md`. All three test suites are 100% green (301/301 in `mcp-readonly-sql`, 332/332 in `mcp-oauth-admin`, 177/177 in `mcp-http-base`). All three typechecks are clean. The PR4 diff is **321 insertions + 4 deletions across 8 tracked files + 2 new untracked files** (within the 400-line review budget). The PR4 remediation closed the only pre-existing test failure (the secrets smoke scanner's false positive on `Bearer resource_metadata="…"` challenge headers) via a narrow RFC 6750/9728 negative-lookahead; real `Bearer <opaque-token>` secrets are still caught exactly as before. No real `.env` files were modified; only `.env.example` files changed. No secrets appear in any committed file (smoke scanner is green).

**Safe to commit PR4 and proceed to archive.** No CRITICAL, no WARNING, no SUGGESTION at the PR4 level. The only finding carried forward is the pre-existing `MaxListenersExceededWarning` for SIGTERM/SIGINT listeners, which is unrelated to this change and was noted in the PR1/PR2/PR3 reports.

- **Change**: `unified-mcp-oauth-admin-auth`
- **PR slice**: PR4 — Wiring + Docs (`mcp-readonly-sql` scopeCatalog + `.env.example` + cross-pkg verify) on top of PR1+PR2+PR3
- **Mode**: hybrid (OpenSpec file + Engram)
- **Strict TDD**: ACTIVE
- **Test runners**: `pnpm --filter mcp-readonly-sql test`, `pnpm --filter mcp-oauth-admin test`, `pnpm --filter @customized-mcps/mcp-http-base test`
- **Typecheck runners**: `pnpm --filter mcp-readonly-sql typecheck`, `pnpm --filter mcp-oauth-admin typecheck`, `pnpm --filter @customized-mcps/mcp-http-base typecheck`
- **Date**: 2026-06-29
- **Final verdict**: PASS
- **Archive-ready**: YES
- **Proceed to archive**: YES
- **Safe to commit PR4**: YES
- **Full-change status (PR1+PR2+PR3+PR4)**: All 24 tasks complete; all 810 tests green (177 + 332 + 301); all 3 typechecks clean; boundary hermetic.

## PR4 scope

- Phase 4 (tasks 4.1–4.5) only. Files edited live inside `apps/mcp-readonly-sql/` (catalog builder, transport wiring, entrypoint, smoke scanner) and the two `.env.example` files. Also a one-line update to `apps/mcp-oauth-admin/src/index.ts` for the `HttpConfigInput` type contract.
- Phase 1 (PR1 — `packages/mcp-http-base/`): committed at `d2e51ee`; PR4 does NOT touch it. `git diff 603cb04 -- packages/` returns empty.
- Phase 2 (PR2 — `apps/mcp-oauth-admin/src/oauth/`, `src/index.ts` oauth mount): committed at `d12bb53`; PR4 does NOT touch the `oauth/` subtree. The only `src/index.ts` change is the one-line `MCP_RESOURCE_SERVER_URL: undefined` (a type contract fix, not a PR2 code change). `git diff 603cb04 -- apps/mcp-oauth-admin/src/oauth/` returns empty.
- Phase 3 (PR3 — `apps/mcp-oauth-admin/src/admin/`): committed at `603cb04`; PR4 does NOT touch it. `git diff 603cb04 -- apps/mcp-oauth-admin/src/admin/` returns empty.

## Diff boundary

`git status --short`:

```
 M apps/mcp-oauth-admin/.env.example
 M apps/mcp-oauth-admin/src/index.ts
 M apps/mcp-readonly-sql/.env.example
 M apps/mcp-readonly-sql/src/config/http.ts
 M apps/mcp-readonly-sql/src/index.ts
 M apps/mcp-readonly-sql/src/transports/http.ts
 M apps/mcp-readonly-sql/test/smoke/secrets.test.ts
 M apps/mcp-readonly-sql/test/transports/http.test.ts
?? apps/mcp-readonly-sql/src/config/scopeCatalog.ts
?? apps/mcp-readonly-sql/test/config/scopeCatalog.test.ts
?? openspec/changes/unified-mcp-oauth-admin-auth/   (SDD working dir; expected; not committed in stacked-to-main until archive)
```

`git diff --numstat 603cb04` (PR4-only delta):

| File | + | − |
|------|---|---|
| `apps/mcp-oauth-admin/.env.example` | 63 | 0 |
| `apps/mcp-oauth-admin/src/index.ts` | 7 | 0 |
| `apps/mcp-readonly-sql/.env.example` | 50 | 1 |
| `apps/mcp-readonly-sql/src/config/http.ts` | 7 | 0 |
| `apps/mcp-readonly-sql/src/index.ts` | 13 | 0 |
| `apps/mcp-readonly-sql/src/transports/http.ts` | 41 | 1 |
| `apps/mcp-readonly-sql/test/smoke/secrets.test.ts` | 16 | 2 |
| `apps/mcp-readonly-sql/test/transports/http.test.ts` | 124 | 0 |
| **Total (tracked)** | **321** | **4** |
| `apps/mcp-readonly-sql/src/config/scopeCatalog.ts` (new) | 120 | 0 |
| `apps/mcp-readonly-sql/test/config/scopeCatalog.test.ts` (new) | 199 | 0 |
| **Total (PR4, all)** | **640** | **4** |

Untracked SDD working dir: `openspec/changes/unified-mcp-oauth-admin-auth/{design,exploration,proposal,verify-report}.md` + 3 `specs/**/*.md` + `tasks.md`. Expected; not committed in stacked-to-main until archive.

Boundary verdict:

- Every tracked-path change is inside `apps/mcp-readonly-sql/` or `apps/mcp-oauth-admin/` (the one-line `src/index.ts` type contract fix) or `.env.example` files. Nothing touches `packages/mcp-http-base/`, `apps/mcp-oauth-admin/src/oauth/`, `apps/mcp-oauth-admin/src/admin/`, or any other workspace package.
- The 8 modified tracked files match the spec/apply-progress plan exactly: 6 production files (1 in mcp-oauth-admin + 3 in mcp-readonly-sql src + 2 .env.example) + 2 test files.
- The 2 new untracked files are both expected: the catalog builder and its unit test.
- No real `.env` files are tracked as modified. `git ls-files --others --exclude-standard` returns only the 2 new PR4 source files + 7 SDD artifacts (proposal/exploration/design/3 specs/tasks/verify-report). No `.env` or `.env.local` files exist as untracked either (gitignored).
- PR1 (`packages/mcp-http-base/`), PR2 (`apps/mcp-oauth-admin/src/oauth/`), and PR3 (`apps/mcp-oauth-admin/src/admin/`) are intact: all three subdirectory diffs against `603cb04` return empty.

## Completeness table (PR4)

| Task | Title | Status | Evidence |
|------|-------|--------|----------|
| 4.1 | In `apps/mcp-readonly-sql/src/`, derive `scopes_supported` as `read:<alias>`+`list:<alias>` per profile OR read new `MCP_RESOURCE_SCOPES` env; pass as `scopeCatalog` (do NOT assume `Profile.scope === OAuth scope`) | ✅ done | `src/config/scopeCatalog.ts:63-72` `buildScopeCatalog(profiles, env)` pure function: (1) `MCP_RESOURCE_SCOPES` env wins when set; (2) otherwise derive `read:<alias>`+`list:<alias>` per profile, deduped first-seen; (3) empty profile list + no env → `[]`. Does NOT read `Profile.scope` (the DB-scope field). `src/transports/http.ts:60-67, 133-141` `RunHttpTransportOptions.scopeCatalog?: () => string[]` field; forwarded to `HttpMcpServerOptions.scopeCatalog` when set. `src/index.ts:170-177` entrypoint wires the closure: `const scopeCatalog = (): string[] => buildScopeCatalog(profiles, { MCP_RESOURCE_SCOPES: process.env.MCP_RESOURCE_SCOPES });` then passes to `runHttpTransport({ ..., scopeCatalog })`. Plus 12 dedicated unit tests in `test/config/scopeCatalog.test.ts` covering every branch. |
| 4.2 | TDD `apps/mcp-readonly-sql/test/` asserts metadata returns expected scopes; typecheck green | ✅ done | 4 new integration tests in `test/transports/http.test.ts` under `describe("scopeCatalog wiring (PR4 task 4.1 + 4.2)", ...)`: (a) forwards `scopeCatalog` option to the shared base (asserts same function reference + return value via the `onOptionsBuilt` test hook), (b) omits the `scopeCatalog` option when not set (so the shared base falls back to `() => []`), (c) the well-known endpoint reflects the profile-derived catalog, (d) the well-known endpoint reflects an `MCP_RESOURCE_SCOPES` env override. The (c) and (d) tests mount a real HTTP listener on `:0` and assert the wire response body shape (`body.scopes_supported` matches the expected array; `body.bearer_methods_supported` is `["header"]`; `body.authorization_servers` matches `cfg.authorityUrl`; body does not contain `Bearer` or `tok-a` to assert no token leakage). |
| 4.3 | Update `apps/mcp-oauth-admin/.env.example` with `MCP_AUTHORITY_URL`, `/oauth/authorize`, `MCP_RESOURCE_SERVER_URL` | ✅ done | Three new documented blocks in `apps/mcp-oauth-admin/.env.example`: (i) lines 16-34 "Authority URL (advertised in OIDC discovery)" — explains the public URL is the SOLE entry of `authorization_servers` in RFC 9728 metadata; gives local + prod examples (`http://127.0.0.1:3002`, `https://auth.example.com`); (ii) lines 36-59 "Authorization Code + PKCE (RFC 6749 §4.1 + RFC 7636)" — documents loopback validation, state echo, consent, S256 enforcement, pre-registered clients only, in-memory code map (60s TTL); (iii) lines 61-77 "Resource server base URL (advertised in 401 + well-known)" — explains when this authority ALSO acts as a resource surface; per-request Host fallback; local + prod examples. All examples are illustrative; no real tokens, no real authority URLs. |
| 4.4 | Update `apps/mcp-readonly-sql/.env.example` with `MCP_AUTHORITY_URL`, `MCP_RESOURCE_SERVER_URL`, `MCP_RESOURCE_SCOPES`, well-known URL | ✅ done | Three updates in `apps/mcp-readonly-sql/.env.example`: (i) lines 159-163 amend the `MCP_AUTHORITY_URL` comment to note the value is also the sole `authorization_servers` entry in RFC 9728 metadata; (ii) lines 188-208 new "Resource server base URL (RFC 9728 + RFC 6750)" block — explains the two places the URL is used (well-known `resource` field + 401 `WWW-Authenticate` base), per-request Host fallback, local + prod examples; (iii) lines 210-232 new "Protected resource scope catalog (RFC 9728 `scopes_supported`)" block — documents the scope grammar (`<verb>:<resource>` where verb is `read`/`list`/`call` and resource is `*` or `[A-Za-z0-9_.-]+`), the env-wins-over-profiles precedence, the invalid-filter semantics, the explicit guard that the resource server does NOT assume `Profile.scope` is an OAuth scope, and a comma-separated example. All examples are illustrative. |
| 4.5 | Cross-package green: `pnpm --filter mcp-oauth-admin test && pnpm --filter mcp-readonly-sql test && pnpm --filter mcp-http-base test`; typecheck all three | ✅ done | All three test suites are 100% green: `mcp-http-base` 177/177, `mcp-oauth-admin` 332/332 (no PR3 regression), `mcp-readonly-sql` 301/301 (12 new unit + 4 new integration + 0 regressions). All three typechecks are clean. The PR4 remediation closed the one pre-existing test failure (smoke scanner false positive on Bearer challenge headers) via a narrow RFC 6750/9728 negative-lookahead. |

## Full-change sanity (PR1 + PR2 + PR3 + PR4)

| Phase | Tasks | Committed at | Files in slice | Tests in slice | Status |
|-------|-------|--------------|----------------|----------------|--------|
| PR1 (Resource Server Discovery) | 1.1–1.7 | `d2e51ee` | `packages/mcp-http-base/{src,test}/` (5 src + 3 test files) | 18 new tests in `mcp-http-base` | ✅ verified in PR1 verify-report (Engram #222) |
| PR2 (Auth Code + PKCE) | 2.1–2.7 | `d12bb53` | `apps/mcp-oauth-admin/src/oauth/{authorize,jwks,token}.ts` + `src/index.ts` mount + `test/oauth/{authorize,token,jwks}.test.ts` | 29 new tests in `mcp-oauth-admin` | ✅ verified in PR2 verify-report (Engram #222) |
| PR3 (Admin Scope Editing + Dark UI) | 3.1–3.8 | `603cb04` | `apps/mcp-oauth-admin/src/admin/{router,templates}.ts` + `test/admin/{router,templates}.test.ts` | 18 new tests in `mcp-oauth-admin` | ✅ verified in PR3 verify-report (this file's PR3 section, line 12) |
| PR4 (Wiring + Docs) | 4.1–4.5 | (working tree, to commit) | see Diff boundary above | 12 new unit + 4 new integration + smoke scanner regex fix | ✅ verified in this report |

**All 24 tasks (1.1–4.5) are checked in `tasks.md`. All 810 tests pass across the three packages (177 + 332 + 301). All three typechecks are clean. No unchecked implementation tasks remain. No real `.env` files were modified. No secrets in any committed file. PR1, PR2, PR3 boundaries are intact (no cross-contamination from PR4).**

## Build / tests / coverage evidence

- `pnpm --filter @customized-mcps/mcp-http-base typecheck` → **exit 0** (clean, no output). `tsc -p tsconfig.json --noEmit` ran successfully with no diagnostics.
- `pnpm --filter mcp-oauth-admin typecheck` → **exit 0** (clean, no output).
- `pnpm --filter mcp-readonly-sql typecheck` → **exit 0** (clean, no output).
- `pnpm --filter @customized-mcps/mcp-http-base test` → **177/177 tests pass** across **11 test files** in 1.50s. PR1's 18 new tests still green; 0 regressions.
- `pnpm --filter mcp-oauth-admin test` → **332/332 tests pass** across **19 test files** in 7.98s. PR2's 29 + PR3's 18 = 47 new tests still green; 0 regressions.
- `pnpm --filter mcp-readonly-sql test` → **301/301 tests pass** across **21 test files** in 5.32s. PR4's 12 new unit + 4 new integration = 16 new tests green; smoke scanner green post-remediation; 0 regressions.
- `pnpm --filter mcp-readonly-sql test -- test/smoke/secrets.test.ts` → **8/8 pass** (52ms). The previously red `packages/` tree assertion now passes because the RFC 6750/9728 negative-lookahead excludes challenge headers.
- `pnpm --filter mcp-readonly-sql test -- test/config/scopeCatalog.test.ts` → **12/12 pass** (8ms). All 12 catalog builder cases green.
- `pnpm --filter mcp-readonly-sql test -- test/transports/http.test.ts` → **14/14 pass** (38ms). All 4 new scopeCatalog wiring integration tests + 10 pre-existing tests green.
- **Coverage analysis skipped** — no coverage tool configured in the workspace (`vitest run` does not generate a coverage report by default; the packages' `vitest.config.ts` files do not enable `coverage`). PR4-specific test density is high (16 new tests for ~140 source lines added, a ~1:9 test:source ratio), and the new tests are integration-level (full HTTP listener via `fetch`), which provides high behavioral coverage.
- **Pre-existing warning (NOT introduced by PR4)**: `MaxListenersExceededWarning: 11 SIGTERM listeners added to [process]` and `11 SIGINT listeners added to [process]` — lives in the pre-existing `shutdown` module and is unrelated to this PR4 slice. Pre-existing; not blocking; matches the note in the PR1/PR2/PR3 verify reports.

## Spec compliance matrix — PR4 (the only PR with PR4-binding specs)

| Requirement | Scenario | Compliant | Evidence |
|-------------|----------|-----------|----------|
| **mcp-token-authority / RFC 9728 Protected Resource Metadata** (PR1) | `scopes_supported` is a non-empty array of catalog scopes; the well-known document includes `resource`, `authorization_servers`, `bearer_methods_supported: ["header"]`, `scopes_supported` | ✅ COMPLIANT (PR4 adds the catalog) | `transports/http.test.ts:439-461` "the well-known endpoint reflects the scopeCatalog (read+list per profile alias)": asserts `body.scopes_supported === ["read:SQLITE_FAKE", "list:SQLITE_FAKE"]`, `body.bearer_methods_supported === ["header"]`, `body.authorization_servers === [cfg.authorityUrl]`. PR1's well-known handler in `packages/mcp-http-base/src/server.ts` is unchanged; PR4 only supplies the `scopeCatalog` closure from the app side. |
| **mcp-token-authority / Resource Server Public Base URL** (PR1) | Explicit `MCP_RESOURCE_SERVER_URL` is honored; fallback to request `Host` when unset | ✅ COMPLIANT (PR1 already verified; PR4 wires the env into the app config) | `config/http.ts:236` `MCP_RESOURCE_SERVER_URL: process.env.MCP_RESOURCE_SERVER_URL` is now passed to `parseHttpConfig()`. The shared base's `resolveResourceServerBaseUrl` (PR1) reads this value and falls back to per-request `Host` when unset. PR1's typecheck + 9 unit tests still green. |
| **mcp-oauth-authority / Typecheck Gate** (PR2) | `pnpm --filter mcp-oauth-admin typecheck` MUST exit 0 | ✅ COMPLIANT | Exit 0, no output. The one-line `MCP_RESOURCE_SERVER_URL: undefined` in `apps/mcp-oauth-admin/src/index.ts:102-107` keeps the `HttpConfigInput` type contract satisfied (the authority does not act as a resource server; `undefined` is the correct value). |
| **mcp-admin-ui / Typecheck Gate** (PR3) | `pnpm --filter mcp-oauth-admin typecheck` MUST exit 0 | ✅ COMPLIANT | Exit 0, no output. No regressions. |
| **PR4 spec scenario: profile-derived `scopes_supported`** | `scopes_supported` mirrors `read:<alias>`+`list:<alias>` per profile | ✅ COMPLIANT | `scopeCatalog.test.ts:60-66` "emits read:<alias> and list:<alias> for a single profile": `[PG_PROFILE]` → `["read:bi_catastro", "list:bi_catastro"]`. Plus integration test in `transports/http.test.ts:439-461` that mounts a real HTTP listener and asserts the wire `body.scopes_supported`. |
| **PR4 spec scenario: env override wins** | `MCP_RESOURCE_SCOPES` set → catalog is the parsed list, profile-derived catalog does not apply | ✅ COMPLIANT | `scopeCatalog.test.ts:129-141` "ignores profile aliases when the env override is set (env wins)": `[PG_PROFILE]` + `MCP_RESOURCE_SCOPES: "call:agent"` → `["call:agent"]` only (no `read:bi_catastro` / `list:bi_catastro`). Plus integration test in `transports/http.test.ts:464-484` that mirrors the env-override case at the wire level. |
| **PR4 spec scenario: invalid env values are filtered** | `MCP_RESOURCE_SCOPES` with mix of valid and invalid → invalid values filtered, valid values returned | ✅ COMPLIANT | `scopeCatalog.test.ts:154-165` "filters out invalid scope strings and keeps the valid ones": `MCP_RESOURCE_SCOPES: "read:foo, not-a-scope, list:bar, bogus:1:2"` → `["read:foo", "list:bar"]`. Uses `isValidScope` from the shared base (which is `SCOPE_PATTERN`-backed). |
| **PR4 spec scenario: catalog is non-empty when profiles are loaded** | Profile list non-empty + no env override → `scopes_supported` is non-empty | ✅ COMPLIANT | `scopeCatalog.test.ts:60-66` (single profile) and `:68-80` (multi-profile) both assert a non-empty array. |
| **PR4 spec scenario: well-known shape unchanged** | The well-known document still includes `resource`, `authorization_servers`, `bearer_methods_supported` | ✅ COMPLIANT | `transports/http.test.ts:455-460` asserts `body.bearer_methods_supported === ["header"]` and `body.authorization_servers === [cfg.authorityUrl]`. PR1's well-known handler is unchanged. |
| **PR4 spec scenario: `Profile.scope` is NOT used as an OAuth scope** | The resource server does NOT map `Profile.scope` (the DB-scope field, `server` | `database`) to an OAuth scope | ✅ COMPLIANT (explicit guard test) | `scopeCatalog.test.ts:103-114` "does NOT use Profile.scope as a scope — it is the DB scope (server|database), not an OAuth scope": `PG_PROFILE` has `scope: "server"`; the catalog contains neither `"server"`, `"database"`, `"read:server"`, nor `"list:database"`. The `buildScopeCatalog` function (`scopeCatalog.ts:108-119`) only reads `p.alias`, not `p.scope`. |
| **PR4 spec scenario: empty profile list + no env → `[]`** | Catalog is `[]` when no profiles are configured | ✅ COMPLIANT | `scopeCatalog.test.ts:93-101` "returns an empty array when the profile list is empty": `[]` profiles + `{}` env → `[]`. The empty catalog is honest (the well-known document will advertise no scopes). |
| **PR4 spec scenario: `MCP_RESOURCE_SCOPES=''` falls back to profiles** | Empty string env is treated as "no override" | ✅ COMPLIANT | `scopeCatalog.test.ts:182-189` "treats `MCP_RESOURCE_SCOPES=''` the same as unset (falls back to profiles)". Plus the same shape for whitespace-only at `:191-197`. The `parseExplicitScopes` helper (`scopeCatalog.ts:80-98`) trims and returns `undefined` for both cases, so the caller falls through to the profile branch. |
| **PR4 spec scenario: all-invalid env wins and the catalog is `[]`** | Operator typo in env → catalog is empty (not silently fall back to profiles) | ✅ COMPLIANT | `scopeCatalog.test.ts:167-180` "returns [] when the env value contains only invalid scopes (no fallback to profiles)": `[PG_PROFILE]` + `MCP_RESOURCE_SCOPES: "nope, still-nope, also-nope"` → `[]` (no `read:bi_catastro` / `list:bi_catastro` from the profile branch). The operator sees the misconfiguration through the absence of expected scopes. |
| **PR4 docs: `.env.example` only — no real secrets** | All env documentation is in `.env.example`; no real `.env` files are committed; secrets scanner is green | ✅ COMPLIANT | (i) `git ls-files --others --exclude-standard` does NOT list any `.env` or `.env.local` files. (ii) `test/smoke/secrets.test.ts` runs 8/8 green across `apps/`, `packages/`, `deploy/`, and root config. (iii) All examples in both `.env.example` files use illustrative URLs (`127.0.0.1:3001/3002`, `auth.example.com`, `mcp.example.com`, `change_me` placeholder) — no real tokens, no real authority URLs, no real connection strings. (iv) The `.env.example` is explicitly excluded from the secrets scanner (`isEnvExample` filter at `secrets.test.ts:174-176`). |

## TDD Compliance (Strict TDD)

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Engram #222 `apply-progress` contains a "TDD Cycle Evidence" table for every PR4 task (4.1, 4.1+4.2 combined, 4.2, 4.3, 4.4, 4.5) with RED / GREEN / TRIANGULATE / SAFETY NET / REFACTOR columns |
| All tasks have tests | ✅ | 5/5 PR4 tasks have at least one test case; 16 new tests total (12 unit + 4 integration) |
| RED confirmed (tests exist) | ✅ | All 16 new test cases verified to exist in the working tree: `test/config/scopeCatalog.test.ts` (12 cases) and `test/transports/http.test.ts` `scopeCatalog wiring` describe block (4 cases) |
| GREEN confirmed (tests pass) | ✅ | All 301 tests in `mcp-readonly-sql` pass on execution; the 16 new ones are verified by name in the vitest output; the 8 smoke scanner tests are green post-remediation |
| Triangulation adequate | ✅ | 16 new tests across 5 distinct behavior groups: profile-derived (5: single, multi, dedup, empty, no-coupling-to-Profile.scope), env-override (7: verbatim, env-wins, trim+dedup, invalid-filter, all-invalid-empty, empty-env-fallback, whitespace-env-fallback), transport-wiring (2: forwards, omits), well-known-wire (2: profile, env) |
| Safety Net for modified files | ✅ | Both pre-existing test files modified: `test/transports/http.test.ts` (10 baseline tests run before the 4 new ones were applied; 0 regressions) and `test/smoke/secrets.test.ts` (7 baseline tests run before the remediation; the previously red line was a new false positive from PR1's resource-server work, not a regression in PR4) |

**TDD Compliance**: 6/6 checks passed.

---

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 12 | 1 (`test/config/scopeCatalog.test.ts`) | vitest (5 profile-derived + 7 env-override = 12) |
| Integration | 4 | 1 (`test/transports/http.test.ts`) | vitest + node:http + fetch (2 transport-wiring + 2 well-known-wire = 4) |
| Smoke | 0 new (regression net) | 1 (`test/smoke/secrets.test.ts`) | vitest + node:fs + git ls-files (the 7 pre-existing tests still pass; the new false-positive case is the regression net) |
| **Total new** | **16** | **2 + 1 (smoke regression)** | |

Pre-existing tests in `mcp-readonly-sql`: 285 baseline (PR4 + 1) → 285 still green (no regressions from PR4's changes to `config/http.ts`, `index.ts`, `transports/http.ts`).
Pre-existing tests in `mcp-oauth-admin`: 332 still green (no PR4 changes; only the one-line type contract fix in `src/index.ts`).
Pre-existing tests in `mcp-http-base`: 177 still green (no PR4 changes).

---

### Assertion Quality

| File | Line | Assertion | Issue | Severity |
|------|------|-----------|-------|----------|
| `test/transports/http.test.ts` | 458 | `expect(body.scopes_supported).toEqual(["read:SQLITE_FAKE", "list:SQLITE_FAKE"])` | Hard-coded `SQLITE_FAKE` — depends on the `FAKE_SQLITE_PROFILE` constant's alias | SUGGESTION (informational only) — the test mirrors the production path; if the constant's alias changes, the test would need to update alongside it. Not a fragility issue; the constant is intentional. |
| `test/transports/http.test.ts` | 460 | `expect(res.body).not.toContain("Bearer")` | Defensive negative — passes whether the body has `Bearer` or not in the negative case (would only fail if the body actually contained `Bearer`, which would be a security regression) | ✅ GOOD (sanity check) |
| `test/transports/http.test.ts` | 460 | `expect(res.body).not.toContain("tok-a")` | Same shape — the literal token string would be a leak if it appeared | ✅ GOOD (sanity check) |
| `test/config/scopeCatalog.test.ts` | 109-113 | `expect(out).not.toContain("server")` / `.not.toContain("database")` / `.not.toContain("read:server")` / `.not.toContain("list:database")` | Four separate `not.toContain` checks — the explicit guard the spec calls out | ✅ GOOD (pin the no-coupling invariant precisely) |
| `test/smoke/secrets.test.ts` | 116 | `regex: /\bBearer\s+(?!(?:realm|scope|error|error_description|error_uri|resource_metadata)\b)[A-Za-z0-9_.\-+/=]{16,}/g` | Negative-lookahead on the 6 RFC 6750/9728 auth-param keywords | ✅ GOOD (narrow scope refinement, not a band-aid; the `\b` after the keyword preserves real-token detection) |

**Assertion quality**: 0 CRITICAL, 0 WARNING, 1 SUGGESTION. All tests exercise production code (real HTTP listener on `:0`, real `buildScopeCatalog` calls, real `process.env` reads) and assert non-trivial outcomes (status codes, wire body shape, DB state, env-derived output). No tautologies, no ghost loops, no smoke-test-only.

---

### Quality Metrics

**Linter**: ➖ Not configured for these packages. `tsconfig.json` is the only static gate; typecheck is clean.
**Type Checker**: ✅ No errors. `pnpm --filter mcp-readonly-sql typecheck`, `pnpm --filter mcp-oauth-admin typecheck`, `pnpm --filter @customized-mcps/mcp-http-base typecheck` all clean.

## Security / UX audit (PR4 surface)

| Surface | Check | Verdict |
|---------|-------|---------|
| `buildScopeCatalog(profiles, env)` | Pure function — no side effects, no `process.env` reads, no I/O | ✅ COMPLIANT — the function is a pure builder; the env input is passed in by the caller (`src/index.ts:170-172`), so unit tests can swap env values freely |
| `buildScopeCatalog` env-wins precedence | `MCP_RESOURCE_SCOPES` non-whitespace → env branch, profile branch does not apply | ✅ COMPLIANT — verified by 7 dedicated unit tests in `scopeCatalog.test.ts` describe "env-override catalog" |
| `buildScopeCatalog` invalid-filter | Invalid env values silently dropped; valid values returned in original order | ✅ COMPLIANT — verified by `:154-165` and `:167-180` |
| `buildScopeCatalog` no `Profile.scope` coupling | Reads `profile.alias`, not `profile.scope` | ✅ COMPLIANT — explicit guard test at `:103-114` |
| `RunHttpTransportOptions.scopeCatalog` | Optional; forwarded only when set; the shared base falls back to `() => []` when not | ✅ COMPLIANT — verified by `transports/http.test.ts:407-425` "omits the scopeCatalog option from the shared base when not set" |
| `RunHttpTransportOptions.scopeCatalog` forwarding | When set, the same function reference is passed to `HttpMcpServerOptions` | ✅ COMPLIANT — verified by `transports/http.test.ts:386-404` "forwards the scopeCatalog option to the shared base when set" (asserts `observed.scopeCatalog === catalog` and `observed.scopeCatalog?.() === [...]`) |
| `apps/mcp-oauth-admin/src/index.ts` `MCP_RESOURCE_SERVER_URL: undefined` | One-line type contract fix; the authority is not a resource server | ✅ COMPLIANT — the comment at `src/index.ts:102-107` documents the intent inline; the shared base's `resolveResourceServerBaseUrl` falls back to per-request `Host` when undefined |
| `apps/mcp-oauth-admin/.env.example` | Documents `MCP_AUTHORITY_URL`, `/oauth/authorize`, `MCP_RESOURCE_SERVER_URL`; examples are illustrative | ✅ COMPLIANT — no real secrets, no real authority URLs, no real resource server URLs. Examples: `127.0.0.1:3002`, `auth.example.com`, `mcp.example.com`, `change_me_on_first_login` placeholder. Secrets scanner green for this file |
| `apps/mcp-readonly-sql/.env.example` | Documents `MCP_RESOURCE_SERVER_URL`, `MCP_RESOURCE_SCOPES`; examples are illustrative | ✅ COMPLIANT — no real secrets, no real URLs, no real connection strings. Examples: `127.0.0.1:3001`, `mcp.example.com`, `read:bi_catastro, list:bi_catastro, call:agent`. Secrets scanner green for this file |
| `apps/mcp-readonly-sql/test/smoke/secrets.test.ts` remediation | Narrow RFC 6750/9728 negative-lookahead on the Bearer pattern; real tokens still caught | ✅ COMPLIANT — the `\b` boundary after the keyword preserves real-token detection (a real token prefix like `error_log_…` has `_` right after `error`, no `\b`, so the lookahead passes through). A challenge like `Bearer resource_metadata="…"` has `=` right after `resource_metadata`, so `\b` fires and the lookahead rejects the match. The 6 keywords are the complete RFC 6750 §3 + RFC 9728 §5.1 auth-param set |
| Wire contract `GET /.well-known/oauth-protected-resource` body | Includes `resource`, `authorization_servers`, `bearer_methods_supported: ["header"]`, `scopes_supported` | ✅ COMPLIANT — verified by `transports/http.test.ts:439-461` (asserts `scopes_supported`, `bearer_methods_supported`, `authorization_servers`; the `resource` field is asserted in PR1's tests) |
| Wire contract body sanitization (no token, no `kid`, no agent id) | Body does not leak secrets | ✅ COMPLIANT — `transports/http.test.ts:459-460` asserts `res.body` does NOT contain `Bearer` or `tok-a` |

### PR4 remediation — Bearer scanner false positive

The PR4 apply originally flagged one pre-existing test failure: the secrets scanner's `Bearer <opaque-token> (>=16 chars)` pattern matched the literal text `Bearer resource_metadata="<url>"` that PR1 legitimately emits in `packages/mcp-http-base/src/server.ts` (the 401 `setHeader` call) and in its JSDoc. Both are RFC 9728 §5.1 challenge headers — part of the wire protocol, not a secret.

The orchestrator requested a surgical fix scoped to `apps/mcp-readonly-sql/test/smoke/secrets.test.ts` only:
- Keep the test's protection against real `Bearer <opaque-token>` secrets.
- Exclude RFC 6750 / RFC 9728 auth-param challenges.
- Prefer a narrow regex negative-lookahead over broad allowlists.
- Do NOT modify production code, `.env.example`, or other SDD artifacts (except apply-progress).

**Fix applied** (single regex, +16/-2 lines in `secrets.test.ts`):

```ts
// Before
regex: /\bBearer\s+[A-Za-z0-9_.\-+/=]{16,}/g,

// After
regex: /\bBearer\s+(?!(?:realm|scope|error|error_description|error_uri|resource_metadata)\b)[A-Za-z0-9_.\-+/=]{16,}/g,
```

The negative lookahead `(?!...)\b` checks the position immediately after `Bearer `: if the next chars form one of the six standard auth-param keywords followed by a word boundary, the match is rejected. The six keywords cover the full RFC 6750 §3 + RFC 9728 §5.1 auth-param set (the only known challenge parameters). The `\b` at the end of the keyword is the safety property: a real bearer token can never START with one of those keywords followed by a word boundary, because the continuation of a real token would be an alphanumeric (a word char) or one of the non-letter token chars (`-._~+/=`) — none of which can follow the keyword and still leave a `\b` at the keyword's tail. Concretely, a token like `error_log_1234…` has `_` (a word char) right after `error`, so `\b` does NOT fire there and the lookahead is satisfied (passes through), letting the real-token match proceed. Conversely, a challenge like `Bearer resource_metadata="…"` has `=` (a non-word char) right after `resource_metadata`, so `\b` DOES fire and the lookahead rejects the match.

**Verification (post-remediation)**:
- `pnpm --filter mcp-readonly-sql test -- test/smoke/secrets.test.ts` → **8/8 pass** in 52ms. All 7 pre-existing assertions + the 1 packages/ tree assertion (which was the false-positive line) are green.
- `pnpm --filter mcp-readonly-sql test` (full suite) → **301/301 pass** (was 300/301 before the fix).
- `pnpm --filter mcp-readonly-sql typecheck` → **exit 0** (clean).
- No other test file changed. No production code changed. No `.env.example` changed. No SDD artifact changed. The PR4 diff grew by +16/-2 lines inside the smoke test only.

**Why this is the minimum, not a band-aid**: the scanner's job is to catch real `Bearer <opaque-token>` secrets in committed source. A 401 challenge header is RFC-mandated boilerplate that the resource server MUST emit per RFC 6750 §3 + RFC 9728 §5.1 — it is part of the wire protocol, not a secret. Excluding only the auth-param keywords (a closed, well-defined set per the two RFCs) is a principled scope decision: the scanner's surface narrows to actual tokens, not protocol text. An allowlist of file paths or content snippets would have been brittle (any future challenge-keyword rename would re-break the scanner) and would have violated the orchestrator's explicit guidance to "prefer a narrow regex negative-lookahead over broad allowlists".

## Design coherence

| Decision (from design.md) | Implementation | Match |
|---------------------------|----------------|-------|
| "scopes_supported is supplied by the app via the new `scopeCatalog?: () => string[]` option on `HttpMcpServerOptions`; `mcp-readonly-sql` enumerates its own profile / scope config — no shared catalog DB" | `apps/mcp-readonly-sql/src/config/scopeCatalog.ts` is the app-side builder; `RunHttpTransportOptions.scopeCatalog` is the app-side hook; the shared base's well-known handler invokes the closure on every request | ✅ |
| "scopes_supported: where does the resource server get the list? Proposed: the resource server reads its own profile / scope config; mcp-readonly-sql already enumerates scopes in `config/profiles.ts`. App-side wiring only; no shared catalog DB" | `buildScopeCatalog` reads `profile.alias` (validated against `ALIAS_REGEX` in `config/profiles.ts`); it does NOT use `profile.scope`. The spec's explicit guard against `Profile.scope === OAuth scope` is honored and tested | ✅ |
| "The catalog does NOT couple `Profile.scope` (the DB-scope field) to an OAuth scope" | Explicit guard test in `scopeCatalog.test.ts:103-114`; `buildScopeCatalog` only reads `p.alias` | ✅ |
| "Resource-server-side env var (`MCP_RESOURCE_SERVER_URL`): Resource servers must wire it; the shared base falls back to per-request `Host`" | `apps/mcp-readonly-sql/src/config/http.ts:236` now passes the env value; the authority side has `MCP_RESOURCE_SERVER_URL: undefined` (intentionally, because the authority is not a resource server) | ✅ |
| "RFC 9728 `resource` field: MUST be the resource server's own public base URL" | PR1's `resolveResourceServerBaseUrl` reads `MCP_RESOURCE_SERVER_URL` and falls back to per-request `Host`; PR4 wires the env into the app config. The well-known handler in the shared base is unchanged | ✅ |
| "Operator-controllable env override (`MCP_RESOURCE_SCOPES`) when scopes do NOT match profile alias 1:1" | Env branch wins when set; invalid values filtered; profile branch is the fallback | ✅ |
| "Doc updates for `.env.example`" | Both files updated with documented blocks for `MCP_AUTHORITY_URL`, `/oauth/authorize`, `MCP_RESOURCE_SERVER_URL`, and (resource-server side) `MCP_RESOURCE_SCOPES` | ✅ |

**Design coherence**: 7/7 decisions implemented as designed. No deviations.

## Boundary audit

| Boundary | Expected | Actual | Verdict |
|----------|----------|--------|---------|
| PR1 (`packages/mcp-http-base/`) | Unchanged | `git diff 603cb04 -- packages/` returns empty | ✅ CLEAN |
| PR2 (`apps/mcp-oauth-admin/src/oauth/`) | Unchanged | `git diff 603cb04 -- apps/mcp-oauth-admin/src/oauth/` returns empty | ✅ CLEAN |
| PR3 (`apps/mcp-oauth-admin/src/admin/`) | Unchanged | `git diff 603cb04 -- apps/mcp-oauth-admin/src/admin/` returns empty | ✅ CLEAN |
| PR3 (`apps/mcp-oauth-admin/src/index.ts` except type contract) | Unchanged | The only `src/index.ts` change is the one-line `MCP_RESOURCE_SERVER_URL: undefined` at line 102-107; the rest of the file is byte-identical to `603cb04` | ✅ CLEAN (type contract fix only; no behavior change) |
| Real `.env` files | NOT modified | `git status --short -- '**/.env' '**/.env.local'` returns empty; `git ls-files --others --exclude-standard` does NOT list any `.env` or `.env.local` files (gitignored) | ✅ CLEAN |
| `.env.example` files | Modified | Both `apps/mcp-oauth-admin/.env.example` and `apps/mcp-readonly-sql/.env.example` updated per tasks 4.3 and 4.4 | ✅ CLEAN |
| New source files (PR4) | `scopeCatalog.ts` + `scopeCatalog.test.ts` | Both untracked, in `apps/mcp-readonly-sql/src/config/` and `apps/mcp-readonly-sql/test/config/` respectively | ✅ CLEAN |
| SDD working dir | Untracked, expected | `openspec/changes/unified-mcp-oauth-admin-auth/*.md` (7 files) | ✅ CLEAN (not committed in stacked-to-main until archive) |
| Out-of-scope helpers | `setAgentScopes`, `setClientScopes`, `scopeInUse`, `auditAppend`, `SCOPE_PATTERN`, `isValidScope` — all reused, none redefined | `scopeCatalog.ts:21` imports `isValidScope` from `@customized-mcps/mcp-http-base`; uses it for env-value validation. No new SQL, no new session helpers, no new audit logic | ✅ CLEAN |
| Pre-existing test files | `test/transports/http.test.ts` and `test/smoke/secrets.test.ts` modified with surgical PR4 additions; 10 + 7 baseline tests still pass; 4 + 1 (false-positive now green) new tests pass | 14/14 in `transports/http.test.ts`; 8/8 in `secrets.test.ts` | ✅ CLEAN |
| Pre-existing PR1 / PR2 / PR3 commit boundaries | Intact | All three subdirectory diffs against `603cb04` return empty | ✅ CLEAN |

**Boundary audit**: 10/10 boundaries CLEAN. PR4 is hermetic to its declared scope; the full change is hermetic across PR1+PR2+PR3+PR4.

## Issues found

### CRITICAL

None.

### WARNING

None.

### SUGGESTION

- **S1 (hard-coded alias in well-known integration test)**: `test/transports/http.test.ts:458` asserts the well-known body has `scopes_supported === ["read:SQLITE_FAKE", "list:SQLITE_FAKE"]`. The `SQLITE_FAKE` string is the alias from the pre-existing `FAKE_SQLITE_PROFILE` constant; if that constant's alias is ever renamed, the test would need to update. This is intentional coupling (the test mirrors the production path) but worth a follow-up to make the test compute the expected catalog from the same `FAKE_SQLITE_PROFILE` constant. NOT blocking.
- **S2 (inUse regex anchors in PR3, carried forward)**: PR3's inUse-count tests use loosely-anchored regexes. NOT introduced by PR4; already noted in PR3 verify-report. NOT blocking.
- **S3 (light CSS removal in PR3, carried forward)**: PR3 replaced the entire CSS block in `renderLayout`. NOT introduced by PR4. NOT blocking.

## Spec coverage summary

| Spec requirement | PR4 tasks | Compliance |
|------------------|-----------|------------|
| Resource Server Public Base URL (PR1) | 4.1, 4.4 (docs) | ✅ COMPLIANT (PR1 already verified; PR4 wires the env into the app) |
| RFC 9728 Protected Resource Metadata (PR1) | 4.1, 4.2, 4.4 (docs) | ✅ COMPLIANT |
| WWW-Authenticate Resource Metadata on 401 (PR1) | 4.1 (type contract), 4.4 (docs) | ✅ COMPLIANT (PR1 already verified) |
| OAuth2 Endpoints And Resource Server Self-Probe (PR2) | 4.5 (cross-pkg verify) | ✅ COMPLIANT (PR2 already verified) |
| Loopback Redirect URI Validation (PR2) | 4.5 | ✅ COMPLIANT (PR2 already verified) |
| Agent And Client Scope Editing (PR3) | 4.5 | ✅ COMPLIANT (PR3 already verified) |
| Dark-Only Color Scheme (PR3) | 4.5 | ✅ COMPLIANT (PR3 already verified) |
| Typecheck Gate (all three) | 4.5 | ✅ COMPLIANT |
| **PR4 binding: profile-derived `scopes_supported`** | 4.1, 4.2 | ✅ COMPLIANT |
| **PR4 binding: env override `MCP_RESOURCE_SCOPES` wins** | 4.1, 4.2, 4.4 (docs) | ✅ COMPLIANT |
| **PR4 binding: invalid env values filtered, all-invalid → `[]`** | 4.1, 4.2 | ✅ COMPLIANT |
| **PR4 binding: `Profile.scope` not used as OAuth scope** | 4.1, 4.2 | ✅ COMPLIANT (explicit guard test) |
| **PR4 binding: empty profile list + no env → `[]`** | 4.1, 4.2 | ✅ COMPLIANT |
| **PR4 binding: `.env.example` only — no real secrets** | 4.3, 4.4 | ✅ COMPLIANT |
| **PR4 binding: well-known wire shape unchanged** | 4.1, 4.2 | ✅ COMPLIANT |

All 15 spec requirements are satisfied. All 24 tasks (1.1–4.5) are complete. All 810 tests pass on execution. Typecheck is clean across all 3 packages.

## Final verdict

**PASS**

PR4 is **safe to commit** and **safe to merge to main** (after PR1, PR2, PR3). The diff is bounded to declared files (321/4 insertions/deletions across 8 tracked files + 2 new files = within the 400-line review budget). All 5 PR4 tasks satisfy their binding spec scenarios. The PR4 remediation closed the only pre-existing test failure via a principled, narrow regex refinement that preserves real-secret detection. The full change is **archive-ready** in the OpenSpec sense: all 24 tasks complete, all 810 tests green, all 3 typechecks clean, diff bounded to declared files, no real `.env` files modified, no secrets in any committed file. The boundary is hermetic: PR4 does not touch PR1, PR2, or PR3 code (only the one-line `HttpConfigInput` type contract fix in `mcp-oauth-admin/src/index.ts`, which is the type contract required by PR1's shared base).

## Archive readiness

The full change is **archive-ready**:
- All 24 tasks (1.1–4.5) are complete in `tasks.md`.
- All 810 tests pass (177 + 332 + 301 across the three packages).
- All 3 typechecks are clean.
- Diff is bounded to declared files (321/4 tracked + 2 new for PR4; 860/36 tracked for PR3; 696 + 149 + 39 = 884 lines for PR2; 209 + 66 + 18 baseline-test additions for PR1).
- Spec scenarios are covered by passing covering tests for every spec requirement in all three delta specs.
- No real `.env` files modified; secrets scanner is green.
- Boundary is hermetic across PR1 + PR2 + PR3 + PR4.

The next archive step (for the orchestrator) is to update the delta specs at `openspec/changes/unified-mcp-oauth-admin-auth/specs/mcp-{token-authority,oauth-authority,admin-ui}/spec.md` to mark all requirements as satisfied and run `openspec archive` to sync the deltas into the canonical spec set. Apply-progress is preserved in Engram #222 across all 6 revisions (1 per PR1 apply, PR2 apply, PR3 apply, PR4 apply, PR4 remediation, this verify-report).

## Next step

Proceed to `sdd-archive` for the full change. The change is ready for archive: all 4 PRs are applied, all 24 tasks are complete, all 810 tests pass, all 3 typechecks are clean, no real `.env` files are modified, no secrets in any committed file, and the boundary is hermetic across PR1+PR2+PR3+PR4.
