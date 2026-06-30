# Design: Unified MCP OAuth, Admin Auth, and Dark-Only UI

## Technical Approach

Wire RFC 9728 protected-resource metadata into `mcp-http-base` and a minimal Authorization Code + PKCE handler into `mcp-oauth-admin` so `opencode mcp auth <server>` completes an interactive login against a pre-registered client. Reuse the existing admin session/CSRF helpers for the authorize login + consent screens and the existing `setAgentScopes` / `setClientScopes` / `scopeInUse` helpers for the admin scope-edit UI. The resource server's `WWW-Authenticate` header and `/.well-known/oauth-protected-resource` response point at the resource server's OWN base URL, not the authority issuer URL. No DB schema change. All one-time codes live in a short-lived in-memory map; in-use counts use the existing `scopeInUse` SQL.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Resource server base URL | New `MCP_RESOURCE_SERVER_URL` env var; fall back to request `Host` + scheme | Hardcode to authority | Spec forbids pointing `resource_metadata` at the authority; loopback needs host fallback |
| Where to set `WWW-Authenticate` | In `respond()` callback in `server.ts` before `sendJsonError` | Extend `ErrorEnvelope` with `headers` | Local to the 401 path; envelope's audit-safe body contract stays unchanged |
| Auth-code flow layout | New `oauth/authorize.ts` + `authorization_code` branch in `token.ts` | One file | Mirrors existing `jwks.ts` + `token.ts` split |
| One-time code store | Module-level `Map<code, CodeRecord>` with 60s TTL | SQLite table | Codes are ≤60s and never reused; table adds schema + cleanup for no durable value; restart loss is acceptable (clients retry) |
| Authorize login | Reuse admin session cookie + CSRF + backoff helpers | New login surface for `/oauth/authorize` | Single login surface; per-username backoff already enforced |
| Loopback validation | URL parse + hostname in `{127.0.0.1, localhost, ::1}` + non-empty port | Whitelist regex | Spec mandates RFC 8252 §7.3; `URL` handles `[::1]` and the three host forms |
| PKCE | Require `code_challenge_method=S256`; `base64url(sha256(verifier)) === challenge` | Plain challenge | S256 is the spec's only acceptable method; `plain` is forbidden by OAuth 2.1 |
| Scope edit form | Inline per-row form on agent/client list pages | Detail pages | Mirrors existing inline enable/disable + rotate forms; no new template; no new JS |
| `scopeInUse` display | Router calls `scopeInUse` per scope, passes `inUse` count into `renderScopesList` | SQL join in `listScopes` | Existing helper already returns `{count, assignedToAgents, assignedToClients}` |
| Dark theme | Direct CSS color replacement in `templates.ts`; `<meta name="color-scheme" content="dark">` + `:root { color-scheme: dark }` | CSS filter invert | Filter inverts images and breaks contrast; class names unchanged per spec |
| Audience in OIDC discovery | Compute from request host (matches `jwks.ts:deriveIssuer` pattern) | Reuse `tokenDeps.issuer` | Single source of truth; behind-proxy hosts already handled |

## Data Flow

```
                           opencode client
                                |
        (1) GET /mcp (no token) | (2) POST /oauth/authorize
                                v
+-------------------+     +-------------------+
| mcp-readonly-sql  |     | mcp-oauth-admin   |
|  server.ts        |     |  oauth/authorize  |
|  401 + WWW-Auth   |     |   login + consent |
|  -> resource URL  |     |   -> one-time code|
+--------+----------+     +---------+---------+
         | (3) GET /.well-known/      |
         |     oauth-protected-resource|
         v                              v
+--------------------+         +-------------------+
|  well-known        |         |  in-memory code   |
|  -> auth_servers   |         |  map (60s TTL)    |
|  = MCP_AUTHORITY_URL         |                   |
+--------------------+         +---------+---------+
                                         | (4) POST /oauth/token
                                         |     grant=authorization_code
                                         |     + code_verifier
                                         v
                                +-------------------+
                                |  oauth/token.ts   |
                                |  PKCE S256 verify |
                                |  -> JWT (RS256)   |
                                +-------------------+
```

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/mcp-http-base/src/config.ts` | Modify | Add `MCP_RESOURCE_SERVER_URL`; expose `resourceServerUrl` on `HttpConfig` |
| `packages/mcp-http-base/src/server.ts` | Modify | Resolve base URL in `requestHandler`; add `/.well-known/oauth-protected-resource` handler; set `WWW-Authenticate` header in 401 `respond`; add `scopeCatalog?: () => string[]` option |
| `packages/mcp-http-base/src/index.ts` | Modify | Export `ProtectedResourceMetadata` type |
| `packages/mcp-http-base/test/{server,errors,index}.test.ts` | Modify | 401 header, well-known body shape, host-fallback base URL |
| `apps/mcp-oauth-admin/src/oauth/authorize.ts` | Create | `createAuthorizeHandler(deps)`: GET (login + consent), POST (login submit), loopback validation, `state` echo, code issuance; in-memory `Map<code, CodeRecord>` with 60s expiry |
| `apps/mcp-oauth-admin/src/oauth/token.ts` | Modify | Add `authorization_code` branch: PKCE S256 verify, `redirect_uri` exact match, single-use, bind to `clientId`/`agentId` |
| `apps/mcp-oauth-admin/src/oauth/jwks.ts` | Modify | Discovery doc adds `authorization_endpoint`, `authorization_code` in `grant_types_supported` |
| `apps/mcp-oauth-admin/src/index.ts` | Modify | Mount `createAuthorizeHandler(deps)`; pass `activeKey` + `defaultScope` |
| `apps/mcp-oauth-admin/src/admin/router.ts` | Modify | `POST /admin/agents/:id/scopes` + `POST /admin/clients/:id/scopes`; `scopeInUse` per row in `serveScopesList`; audit rows `agent.set_scopes` / `client.set_scopes` |
| `apps/mcp-oauth-admin/src/admin/templates.ts` | Modify | Dark palette in `renderLayout`; inline scope-edit form on `renderAgentsList` / `renderClientsList`; `inUse` column on `renderScopesList` |
| `apps/mcp-oauth-admin/test/oauth/authorize.test.ts` | Create | Happy path (loopback + PKCE), non-loopback reject, missing `state`, code replay, code expiry, login failure |
| `apps/mcp-oauth-admin/test/{oauth/token,admin/router,admin/templates}.test.ts` | Modify | auth-code grant, scope-edit POST + audit, `color-scheme: dark` present, light palette absent |
| `apps/{mcp-oauth-admin,mcp-readonly-sql}/.env.example` | Modify | Document new env vars + `/oauth/authorize` path |

## Interfaces / Contracts

RFC 9728 protected-resource metadata (the only new wire contract on the resource server):

```json
{
  "resource": "https://mcp.example.com",
  "authorization_servers": ["http://127.0.0.1:3002"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["read:bi_catastro", "list:bi_catastro"]
}
```

`scopes_supported` is supplied by the app via the new `scopeCatalog?: () => string[]` option on `HttpMcpServerOptions`; `mcp-readonly-sql` enumerates its own profile / scope config — no shared catalog DB.

The in-memory code record (private to the authority module):

```ts
type CodeRecord = { clientId: string; agentId: number; redirectUri: string;
  codeChallenge: string; scopes: string[]; expiresAt: number; };
```

The token endpoint reads `code` from the map, verifies single-use (delete on read), verifies the `code_verifier` with `crypto.createHash("sha256")`, verifies `redirect_uri` byte-equal, verifies `expiresAt > now()`, then mints the JWT with the consented `scopes` and `sub = user:<agentId>`.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | PKCE S256 verify, loopback regex, code TTL eviction, `SCOPE_PATTERN` guard, dark CSS presence | vitest in `mcp-http-base/test` and `mcp-oauth-admin/test` |
| Integration | Authorize happy path: GET -> login POST -> consent POST -> 302 with `code`; token exchange -> JWT | Mount full listener on `:0`, drive with `fetch` (mirrors `test/oauth/token.test.ts` pattern) |
| Integration | Resource server: 401 with `WWW-Authenticate` header; well-known metadata; loopback / non-loopback / unknown-client cases | Extend `server.test.ts` with the new path |
| E2E (manual only) | `opencode mcp auth mcp-readonly-sql` against a pre-registered client | Documented in `.env.example`; not in vitest |
| Typecheck | All three packages | `pnpm --filter <pkg> typecheck` MUST exit 0 |

## Migration / Rollout

No migration. No DB schema change. The in-memory code map resets on authority restart (clients retry the authorize round-trip). Operators with pre-registered clients only need to restart the authority + resource server.

## Open Questions

- [ ] Should `authorization_code` mint a refresh token? Spec's success criteria only mention a JWT. **Proposed:** skip refresh for v1; document the trade-off.
- [ ] Consent auto-skip rule: "A previously-granted scope set for the same client/user MAY auto-skip consent" — we do not currently persist a per-(client, user) grant record. **Proposed:** always require explicit consent in v1; add a `grants` table in a follow-up.
- [ ] `scopes_supported` in RFC 9728 metadata: where does the resource server get the list? **Proposed:** the resource server reads its own profile / scope config; `mcp-readonly-sql` already enumerates scopes in `config/profiles.ts`. App-side wiring only; no shared catalog DB.
