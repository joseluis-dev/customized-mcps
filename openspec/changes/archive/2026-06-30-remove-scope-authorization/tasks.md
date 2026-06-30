# Tasks: Remove Scope Authorization

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~900-1300 (3 packages, ~20 files, 17+ tests) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Stacked-to-main: PR 1 → PR 2 → PR 3 → PR 4 |
| Delivery strategy | auto-chain (forecast-driven) |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Base | Tests |
|------|------|-----------|------|-------|
| 1 | mcp-http-base: drop SCOPE_PATTERN/matchScope; `verify` returns `scopes: []`; `scopes_supported: []` | PR 1 | main | jwks.test.ts, index.test.ts |
| 2 | mcp-readonly-sql: drop scopeCatalog; `requiredScope` decorative | PR 2 | main after PR 1 | scope.test.ts |
| 3 | mcp-oauth-admin/oauth: 4 grants mint scope-free; incoming `scope` ignored; DCR `scope: ""` | PR 3 | main after PR 2 | token.test.ts, oauth-grant.test.ts, introspect.test.ts, register.test.ts |
| 4 | mcp-oauth-admin/admin: remove scope CRUD/edit/nav; remove compat shim; no inert display | PR 4 | main after PR 3 | admin-ui.test.ts + CHANGELOG |

## Phase 1: mcp-http-base Foundation (PR 1)

- [x] 1.1 RED: add `packages/mcp-http-base/test/jwks.test.ts` asserting `verify` returns `scopes: []` and ignores inbound scope claim
- [x] 1.2 RED: add `packages/mcp-http-base/test/index.test.ts` assertion that `SCOPE_PATTERN`/`matchScope`/`isValidScope` are not exported
- [x] 1.3 GREEN: delete `SCOPE_PATTERN`/`isValidScope`/`matchScope`/`Scope` from `packages/mcp-http-base/src/auth.ts`; drop re-exports in `index.ts`
- [x] 1.4 GREEN: drop `extractScopesClaim`/`filterScopes` + WARN in `packages/mcp-http-base/src/authority/jwks.ts`; return `scopes: []`
- [x] 1.5 GREEN: hardcode `scopes_supported: []` in `packages/mcp-http-base/src/server.ts`; drop `scopeCatalog` option
- [x] 1.6 GREEN: update JSDoc in `packages/mcp-http-base/src/authority/types.ts` and `packages/mcp-http-base/src/config.ts`
- [x] 1.7 REFACTOR: `pnpm --filter @customized-mcps/mcp-http-base test` + `pnpm typecheck`

## Phase 2: mcp-readonly-sql Tool Surface (PR 2)

- [x] 2.1 RED: add `apps/mcp-readonly-sql/test/scope.test.ts` asserting metadata `scopes_supported: []` and `requiredScope` never blocks
- [x] 2.2 GREEN: delete `apps/mcp-readonly-sql/src/config/scopeCatalog.ts`; remove closure in `src/index.ts` and `src/transports/http.ts`
- [x] 2.3 GREEN: no-op `requiredScope` enforcement in `apps/mcp-readonly-sql/src/tools/readonlyTools.ts`
- [x] 2.4 REFACTOR: `pnpm --filter mcp-readonly-sql test` + `pnpm typecheck`

## Phase 3: mcp-oauth-admin OAuth Layer (PR 3)

- [x] 3.1 RED: add `apps/mcp-oauth-admin/test/token.test.ts` asserting JWT has no `scope`/`scopes` for all 4 grants
- [x] 3.2 RED: add `apps/mcp-oauth-admin/test/oauth-grant.test.ts` asserting incoming `scope` is ignored
- [x] 3.3 RED: add `apps/mcp-oauth-admin/test/introspect.test.ts` + `register.test.ts` asserting no `scope` in body
- [x] 3.4 GREEN: drop `loadScopePrincipal`/`resolveGrantedScopes` and `scope` from `apps/mcp-oauth-admin/src/oauth/token.ts` (all 4 grants); omit `scope`/`scopes` in `mintAccessToken`
- [x] 3.5 GREEN: drop scope listing in `apps/mcp-oauth-admin/src/oauth/authorize.ts`; remove `scope` from `code` binding
- [x] 3.6 GREEN: drop `boundRegistrationScope` in `apps/mcp-oauth-admin/src/oauth/register.ts`; DCR returns `scope: ""`
- [x] 3.7 GREEN: drop `scope` in `apps/mcp-oauth-admin/src/oauth/introspect.ts`
- [x] 3.8 GREEN: delete `apps/mcp-oauth-admin/src/oauth/scopes.ts`
- [x] 3.9 REFACTOR: rebuild shared dist with `pnpm --filter @customized-mcps/mcp-http-base build`, then `pnpm --filter mcp-oauth-admin test` + `pnpm --filter mcp-oauth-admin typecheck`

## Phase 4: mcp-oauth-admin Admin UI (PR 4)

- [x] 4.1 RED: add `apps/mcp-oauth-admin/test/admin-ui.test.ts` asserting no `scopes` form/column/route and no scope strings rendered
- [x] 4.2 GREEN: delete `apps/mcp-oauth-admin/src/admin/scopes.ts`; unregister scope routes in `src/admin/router.ts`; drop `SCOPE_PATTERN` imports
- [x] 4.3 GREEN: in `apps/mcp-oauth-admin/src/admin/templates.ts` drop `renderScopesList`/`renderScopeError`/scope nav/"Current scopes"/"Edit scopes"/`Scopes` cell in `renderRefreshTokensList`
- [x] 4.4 GREEN: in `apps/mcp-oauth-admin/src/admin/agents.ts` and `clients.ts` drop `setAgentScopes`/`setClientScopes` + `SCOPE_PATTERN`; remove deprecated `SCOPE_PATTERN`/`isValidScope`/`Scope` compat shim from `packages/mcp-http-base/src/auth.ts` and `index.ts`
- [x] 4.5 GREEN: confirm `apps/mcp-oauth-admin/src/db/schema.ts` unchanged (no destructive migration)
- [x] 4.6 REFACTOR: `pnpm test` + `pnpm typecheck` + `pnpm build` at root

## Phase 5: Verification + Docs (PR 4 tail)

- [x] 5.1 Add CHANGELOG: `scope`/`scopes` JWT claim removed
- [x] 5.2 Add upgrade note: legacy `scopes` storage inert; revoke path documented
- [x] 5.3 `pnpm test` + `pnpm typecheck` + `pnpm build` at root
