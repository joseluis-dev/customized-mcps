# Tasks: Unified MCP OAuth, Admin Auth, and Dark-Only UI

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 1700-2200 (2 pkgs + 1 app, 8+ src, 4+ test) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 4 chained PRs: PR1 Foundation → PR2 Auth-Code → PR3 Admin/UI → PR4 Wiring+Docs |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | PR | Notes |
|------|------|----|-------|
| 1 | RFC 9728 + WWW-Authenticate + scopeCatalog option in mcp-http-base | PR 1 | Base: main. Self-tests only. |
| 2 | Auth Code + PKCE in mcp-oauth-admin (authorize + token + OIDC) | PR 2 | Base: main. No contract deps on PR 1. |
| 3 | Admin scope-edit routes + dark theme + scopeInUse | PR 3 | Base: main. |
| 4 | mcp-readonly-sql scopeCatalog wiring + .env.example + cross-pkg verify | PR 4 | Base: main. Final integration. |

## Phase 1: Resource Server Discovery (mcp-http-base) — PR 1

- [x] 1.1 Add `MCP_RESOURCE_SERVER_URL` to `packages/mcp-http-base/src/config.ts`; expose `resourceServerUrl` on `HttpConfig`; fallback to request `Host` + `x-forwarded-proto`.
- [x] 1.2 TDD `test/config.test.ts` (env + host fallback); implement.
- [x] 1.3 TDD `test/server.test.ts` 401 emits `WWW-Authenticate: Bearer resource_metadata="<resource-server-base>/.well-known/oauth-protected-resource"`, 503 does NOT.
- [x] 1.4 In `server.ts` `respond()`, set header only when `statusCode === 401`; use resource server base URL (NOT authority issuer).
- [x] 1.5 TDD `test/server.test.ts` `GET /.well-known/oauth-protected-resource` returns RFC 9728 JSON (`resource`, `authorization_servers`=[`MCP_AUTHORITY_URL`], `bearer_methods_supported: ["header"]`, `scopes_supported`).
- [x] 1.6 Add well-known handler + `scopeCatalog?: () => string[]` in `server.ts`; export `ProtectedResourceMetadata` from `index.ts`.
- [x] 1.7 Verify: `pnpm --filter mcp-http-base typecheck && test` green.

## Phase 2: Authorization Code + PKCE (mcp-oauth-admin) — PR 2

- [x] 2.1 TDD `test/oauth/jwks.test.ts` discovery adds `authorization_endpoint`, `authorization_code`, `code_challenge_methods_supported: ["S256"]`; update `src/oauth/jwks.ts`.
- [x] 2.2 TDD new `test/oauth/authorize.test.ts` covers loopback accepted, non-loopback 400, state echoed, consent required, happy path 302+code.
- [x] 2.3 Create `src/oauth/authorize.ts` `createAuthorizeHandler(deps)`; loopback validator (RFC 8252 §7.3); CSRF + session reuse; in-memory `Map<code, CodeRecord>` (60s TTL, single-use); code = `crypto.randomBytes(32).toString("base64url")`; `CodeRecord` binds `clientId`+`agentId`+`redirectUri`+`codeChallenge`.
- [x] 2.4 TDD: code single-use (2nd call 400 `invalid_grant`) + expiry (60s+1 400 `invalid_grant`) — both unit (TTL helper) and integration (token endpoint).
- [x] 2.5 TDD `test/oauth/token.test.ts` `authorization_code` branch: PKCE S256 (`base64url(sha256(verifier)) === challenge`), `redirect_uri` byte-equal, expired/replayed → 400 sanitized; add branch to `src/oauth/token.ts`; `sub=user:<agentId>`.
- [x] 2.6 Mount `createAuthorizeHandler(deps)` in `src/index.ts`; pass `activeKey` + `defaultScope`.
- [x] 2.7 Verify: `pnpm --filter mcp-oauth-admin typecheck && test` green.

## Phase 3: Admin Scope Editing + Dark UI (mcp-oauth-admin) — PR 3

- [x] 3.1 TDD `test/admin/router.test.ts` `POST /admin/agents/:id/scopes` updates via `setAgentScopes`, writes `audit_log` row `agent.set_scopes`, invalid scope → 400 no DB write.
- [x] 3.2 Add route in `src/admin/router.ts`; validate `SCOPE_PATTERN`; call `auditAppend`.
- [x] 3.3 Symmetric `POST /admin/clients/:id/scopes` + audit `client.set_scopes` (TDD).
- [x] 3.4 TDD `serveScopesList` passes `inUse` count; call `scopeInUse` per scope; pass to `renderScopesList`.
- [x] 3.5 TDD `renderLayout` emits `<meta name="color-scheme" content="dark">`, `:root { color-scheme: dark }`, no light palette tokens.
- [x] 3.6 Replace CSS in `src/admin/templates.ts` with dark palette; class names unchanged.
- [x] 3.7 TDD inline scope-edit forms on `renderAgentsList` + `renderClientsList`; submit to POST routes; re-render.
- [x] 3.8 Verify: `pnpm --filter mcp-oauth-admin typecheck && test` green.

## Phase 4: Wiring + Docs — PR 4

- [x] 4.1 In `apps/mcp-readonly-sql/src/`, derive `scopes_supported` as `read:<alias>`+`list:<alias>` per profile OR read new `MCP_RESOURCE_SCOPES` env; pass as `scopeCatalog` (do NOT assume `Profile.scope === OAuth scope`).
- [x] 4.2 TDD `apps/mcp-readonly-sql/test/` asserts metadata returns expected scopes; typecheck green.
- [x] 4.3 Update `apps/mcp-oauth-admin/.env.example` with `MCP_AUTHORITY_URL`, `/oauth/authorize`, `MCP_RESOURCE_SERVER_URL`.
- [x] 4.4 Update `apps/mcp-readonly-sql/.env.example` with `MCP_AUTHORITY_URL`, `MCP_RESOURCE_SERVER_URL`, `MCP_RESOURCE_SCOPES`, well-known URL.
- [x] 4.5 Cross-package green: `pnpm --filter mcp-oauth-admin test && pnpm --filter mcp-readonly-sql test && pnpm --filter mcp-http-base test`; typecheck all three.
