# Upgrade Guide — `remove-scope-authorization`

## Overview

`remove-scope-authorization` is a **breaking change** that makes OAuth2 scope authorization inert across the customized-mcps workspace. The change is end-to-end: shared base (`mcp-http-base`), resource server (`mcp-readonly-sql`), OAuth authority (`mcp-oauth-admin`), and the admin UI all drop their scope-based authorization surface.

The change is safe at the **tool layer** — `matchScope()` had zero production callers; the policy is enforced at the spec level, not at the code level. Existing refresh tokens continue to mint scope-free access tokens.

## For Operators

### Pre-Deploy

1. **Inventory external consumers of the `scope` JWT claim.** Any client that decodes an access token and inspects the `scope` field will see it gone. The pre-change behavior was to read the granted scope set from the claim; the post-change behavior is to treat every authenticated agent as fully authorized.
2. **Decide on a hard cutover.** Per policy, post-deploy every existing refresh token is full-access. If you require a hard cutover (i.e., revoke every existing refresh token at the moment of deploy), schedule the deploy with a follow-up SQL query against the SQLite database to set `revokedAt = datetime('now')` on every row in `refresh_tokens` where `revokedAt IS NULL`. The admin UI lists at most 200 refresh tokens per page; a bulk SQL path is the only reliable mechanism for a full cutover with large token populations.

### Deploy

1. **Deploy the new admin image.** Existing refresh tokens continue to issue access tokens; new tokens are scope-free. No operator action is required.
2. **Optional hard cutover:** revoke every active refresh token via the admin UI. The UI's `Revoke` form on `/admin/refresh-tokens` continues to work; only the scope-related routes are removed.
3. **External consumers MUST be updated.** A consumer that depended on the `scope` claim MUST be retrained to treat every authenticated agent as fully authorized. The legacy `agents.scopes` and `clients.scopes` columns are inert storage (always `[]` for new rows); they MUST NOT be consulted as a substitute for authorization.

### Rollback

The change is fully reversible by a `git revert` of the four PR commits (PR 1 + PR 2 + PR 3 + PR 4) + a redeploy. The DB schema is unchanged across the chain, so rollback does not require a migration. The cross-slice compat shim from PR 3 (`SCOPE_PATTERN` / `isValidScope` / `Scope`) was re-added to `packages/mcp-http-base/src/auth.ts` and `index.ts` in PR 3 to keep the admin module compiling; PR 4 removed it. A future maintainer who needs to retain the legacy scope support can re-introduce the shim and the admin's `setAgentScopes` / `setClientScopes` helpers.

## For Developers

### Local

- The `--scope` flag on `pnpm --filter mcp-oauth-admin create:client` is removed. The CLI no longer accepts scope input; the persisted `scopes` column is `[]` (legacy / inert).
- The `mcp-http-base` re-exports `matchScope` is gone (was removed in PR 1); `SCOPE_PATTERN`, `isValidScope`, and `Scope` are gone (removed in PR 4). Any code that imported these from `@customized-mcps/mcp-http-base` will fail to typecheck.
- The `AgentRecord.scopes` and `ClientRecord.scopes` fields are still present in the type so the legacy DB shape is preserved; the values are `[]` for new rows. The field is read-only on the type and not surfaced on any admin UI page.
- The `RefreshTokenRow.scopes` field is still present; the templates' `RefreshTokenView` projection omits it (the column is INERT legacy storage and is not rendered on the refresh-tokens list).

### Tests

- All 394 mcp-oauth-admin tests pass under `pnpm --filter mcp-oauth-admin test`.
- All 164 mcp-http-base tests pass under `pnpm --filter @customized-mcps/mcp-http-base test`.
- mcp-readonly-sql has 14 pre-existing infrastructure test failures (docker, JWKS fetch from a real authority); these are unchanged from the PR 3 baseline and are not part of this change.
- The new end-to-end admin UI test (`test/admin-ui.test.ts`) pins the PR 4 contract: no scope forms, no scope columns, no scope strings, no scope routes, and the cross-slice compat shim is fully removed.
