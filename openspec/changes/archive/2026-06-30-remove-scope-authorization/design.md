# Design: Remove Scope Authorization

## Technical Approach

Make scope authorization inert end-to-end. Stop emitting `scope` / `scopes` JWT claims; stop extracting/filtering the claim on the resource server; stop resolving scopes in all four OAuth grants; hide all admin UI scope controls. Preserve every non-scope safety control. DB `scopes` columns + `scopes` table stay legacy/inert — no destructive migration. Existing refresh tokens continue to mint scope-free access tokens; operators can revoke for a hard cutover. The proposal + 8 corrected delta specs are the source of truth.

## Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| JWT scope claim | Omit `scope` + `scopes` | Wildcard is real; omit is the only fail-closed path. |
| `verify()` returns `scopes: []` | Keep field, hardcode empty | BC; dropping forces a typed-API break. |
| `SCOPE_PATTERN` | Delete from `auth.ts` + exports | Zero production callers. |
| Admin scope UI | Hard-remove routes + templates | A read-only display re-injects scope noise. |
| SQLite `scopes` table + columns | Keep inert; no DROP | Destructive migrations break operator DBs. |
| Incoming `scope` param | Tolerate + ignore | Rejecting is a contract break. |
| `requiredScope` on tools | Optional decorative | `readonlyTools.ts` never calls `matchScope`. |

## Data Flow

    grant ──► token.ts (no scope resolve)
              ▼ mintAccessToken: iss/aud/sub/iat/nbf/exp only
    JWT ──► JwksAuthority.verify
              ▼ payload.scopes (if present) → ignored
              │ returns { agentId, scopes: [] }
    middleware: req.auth = { clientId: agentId, scopes: [] }
              ▼ tool handler: sqlGuard + allowlist authorize

## File Changes

**`packages/mcp-http-base`**: `auth.ts` deletes `SCOPE_PATTERN` / `isValidScope` / `matchScope` / `Scope`; `index.ts` drops re-exports; `authority/types.ts` JSDoc `scopes` always `[]`; `authority/jwks.ts` drops `extractScopesClaim` + `filterScopes` + WARN; `server.ts` drops `scopeCatalog` and hardcodes `scopes_supported: []`; `config.ts` documents `scopes_supported: []`.

**`apps/mcp-readonly-sql`**: delete `config/scopeCatalog.ts`; drop catalog closure in `index.ts`; drop `scopeCatalog` in `transports/http.ts`. `tools/readonlyTools.ts` no-op.

**`apps/mcp-oauth-admin`**: delete `oauth/scopes.ts` and `admin/scopes.ts`. `oauth/token.ts` drops `loadScopePrincipal` / `resolveGrantedScopes` in all 4 grants, drops `scope` from response, drops `scope` + `scopes` claims in `mintAccessToken`. `oauth/authorize.ts` drops scope resolution in `handleConsent` and the consent-form "scopes" listing. `oauth/register.ts` drops `boundRegistrationScope`; DCR `scope: ""`. `oauth/introspect.ts` drops `scope`. `admin/router.ts` unregisters scope routes + handlers; drops `SCOPE_PATTERN` + scope-admin imports. `admin/templates.ts` drops `renderScopesList`, `renderScopeError`, scope nav, "Current scopes" / "Edit scopes" columns, `Scopes` cell in `renderRefreshTokensList`. `admin/agents.ts` drops `setAgentScopes` + `SCOPE_PATTERN`. `admin/clients.ts` drops `setClientScopes` + `SCOPE_PATTERN`. `db/schema.ts` no-op.

**Tests** (~17): replace SCOPE_PATTERN assertions with `scopes: []`; drop `matchScope` / `resolveGrantedScopes` tests; assert JWT has no `scope` / `scopes` claim.

## Interfaces / Contracts

- `TokenAuthority.verify(token)` → `{ agentId: string; scopes: [] }`.
- JWT: `iss`, `aud=mcp:<app>`, `sub`, `iat`, `nbf`, `exp`. No `scope` / `scopes`.
- `/.well-known/oauth-protected-resource`: `scopes_supported: []` always.
- Token response: `access_token`, `token_type`, `expires_in`. No `scope`.
- Introspection: `active`, `sub`, `aud`, `iss`, `iat`, `exp`. No `scope`.
- DCR response: `scope: ""`.
- Incoming `scope` on `/oauth/authorize|token|register`: ignored, no `invalid_scope`.
- `req.auth`: `{ clientId: string; scopes: [] }`.
- `HttpMcpServerOptions`: drop `scopeCatalog`.
- `requiredScope` on a tool: optional, never read.

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit (shared) | `verify` returns `scopes: []`; ignores claims | jose JWTs in `jwks.test.ts`. |
| Unit (admin) | `mintAccessToken` w/o `scope` / `scopes`; no `scope` in body | Decode JWT in `token.test.ts` + `introspect.test.ts`. |
| Unit (admin) | Incoming `scope` on token / authorize / DCR tolerated | 3 small tests. |
| Unit (admin) | `createAgent` / `createClient` ignore `scopes` | Drop scope-shape assertions. |
| Unit (admin) | Well-known returns `scopes_supported: []` | String search on JSON. |
| Integration | Full grant → tool call | Extend `oauth-grant.test.ts`. |
| Integration | Admin UI hides scope controls | `grep -F "scopes"` on HTML. |
| E2E | Fresh install against existing DB | Smoke `migrate-from-pre-scope-removal.test.ts`. |
| E2E | Existing refresh w/ scopes mints scope-free token | Existing E2E flow. |

## Migration / Rollout

No schema migration. All seven tables and columns unchanged.

1. Deploy new admin image. Existing refresh tokens continue to issue access tokens; new tokens are scope-free. No operator action.
2. Optional hard cutover: revoke every active refresh token via `/admin/refresh-tokens`.
3. CHANGELOG: `scope` JWT claim is absent.
4. Rollback: `git revert` + redeploy. Tokens minted under this change remain valid under the old verifier (it drops the claim on filter). Rotate JWKS for exact pre-change behavior.

## Open Questions

- [ ] `(req as ...).auth.scopes` — `readonly []` literal vs. `readonly string[]`? Recommend the latter + JSDoc.
- [ ] `AgentRecord` / `ClientRecord` (TS) `scopes: string[]` — keep with `[]` default, or drop? Recommend keep-with-`[]` for BC.
- [ ] `renderRefreshTokensList` `Scopes` column — drop the column; keep `RefreshTokenRow.scopes` in the read.
- [ ] Future HTTP-served MCP apps (per `app-independence`) use `TokenAuthority`; out of scope here.
