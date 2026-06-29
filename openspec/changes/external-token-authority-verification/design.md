# Design: External Token Authority Verification

> Phase 1 delivers the `TokenAuthority` abstraction with two backends. Phase 2 (separate change) adds per-tool scope enforcement.

## Architecture Decisions

| # | Choice | Rejected | Rationale |
|---|--------|----------|-----------|
| 1 | `TokenAuthority` interface with `verify(token): Promise<{agentId, scopes}>` | Middleware calling different backends inline | Interface-removes coupling; apps see one surface. Follows existing `McpServerFactory` pattern in server.ts. |
| 2 | `jose` (ESM-native) for JWT/JWKS | `jsonwebtoken` + `node-jose` | `jose` is modern, maintained by panva, aligns with repo's ESM-only design. No CJS shim needed. |
| 3 | `MCP_AUTHORITY_URL` unset → local roster; set → JWKS | Separate `MCP_AUTHORITY_MODE` flag | One env var as the signal: presence means "use the authority." No orthogonal state bugs. |
| 4 | Typed errors (`TokenInvalidError`, `AuthorityUnavailableError`) in server.ts catch | Returning discriminated unions from `verify` | Errors compose naturally with existing `sendJsonError` path. Server.ts catch already maps exceptions to 503. |
| 5 | `/healthz` reports `authorityBackend` field | Separate `/healthz/authority` endpoint | One probe endpoint for operators. Existing `handleHealth` already returns 200/503 text; add JSON field. |

## Data Flow

```
request → server.ts middleware
  │
  ├─ Bearer extracted → authority.verify(token)
  │   ├─ LocalRosterAuthority: loadAgents(JSON) → validateBearer(token, secret, agents)
  │   │   └─ HMAC constant-time compare → {agentId, scopes} | TokenInvalidError
  │   └─ JwksAuthority: fetch JWKS (60s cache) → jwtVerify(token, JWKS, {iss, aud})
  │       ├─ kid miss → refetch once → reject on second miss
  │       └─ {agentId: sub, scopes} | TokenInvalidError | AuthorityUnavailableError
  │
  ├─ TokenInvalidError → 401 (sanitized body, existing path)
  ├─ AuthorityUnavailableError → 503 (sanitized body, existing path)
  └─ Success → req.auth = {clientId, scopes} → transport.handleRequest
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/mcp-http-base/src/authority/types.ts` | **New** | `TokenAuthority` interface, `VerifiedToken` type, `TokenInvalidError`, `AuthorityUnavailableError` |
| `packages/mcp-http-base/src/authority/localRoster.ts` | **New** | `LocalRosterAuthority` wrapping existing `loadAgents` + `validateBearer` |
| `packages/mcp-http-base/src/authority/jwks.ts` | **New** | `JwksAuthority` using `jose.createRemoteJWKSet` + `jose.jwtVerify` |
| `packages/mcp-http-base/src/config.ts` | Modify | Add authority env knobs to `HttpConfigInput`: `MCP_AUTHORITY_URL`, `MCP_AUTHORITY_JWKS_URL`, `MCP_AUTHORITY_AUDIENCE`, `MCP_AUTHORITY_JWKS_TTL_S`, `MCP_AUTHORITY_LEEWAY_S`, `MCP_AUTHORITY_FETCH_TIMEOUT_MS` |
| `packages/mcp-http-base/src/server.ts` | Modify | Replace `validateBearer(token, hmacSecret, agents)` with `await authority.verify(token)`. Add `authority: TokenAuthority` to `HttpMcpServerOptions`. Keep `agents`/`hmacSecret` as `LocalRosterAuthority` inputs. |
| `packages/mcp-http-base/src/index.ts` | Modify | Export `TokenAuthority`, `LocalRosterAuthority`, `JwksAuthority`, `TokenInvalidError`, `AuthorityUnavailableError` |
| `packages/mcp-http-base/package.json` | Modify | Add `jose` dependency (latest v5) |
| `apps/mcp-readonly-sql/src/config/http.ts` | Modify | `loadHttpRuntimeConfig` instantiates and returns the `TokenAuthority`. Unset `MCP_AUTHORITY_URL` → `LocalRosterAuthority`; set → `JwksAuthority`. HMAC secret required ONLY when local backend selected. |
| `apps/mcp-readonly-sql/src/transports/http.ts` | Modify | Thread `authority` through to `createHttpMcpServer` options |
| `apps/mcp-readonly-sql/.env.example` | Modify | Add "Choose your backend" section documenting `MCP_AUTHORITY_URL` and related knobs. Mark local as dev/offline fallback. |
| `deploy/README.md` | Modify | Add `authorityBackend` to `/healthz` response docs. "Choose your backend" section. |
| `packages/mcp-http-base/test/authority/localRoster.test.ts` | **New** | Verify bit-for-bit equivalence with v1 `validateBearer` |
| `packages/mcp-http-base/test/authority/jwks.test.ts` | **New** | Mocked `fetch`; test JWKS cache, claim validation, kid-miss refetch, error mapping |

## Interfaces / Contracts

```typescript
// packages/mcp-http-base/src/authority/types.ts
export type VerifiedToken = { agentId: string; scopes: string[] };

export interface TokenAuthority {
  verify(token: string): Promise<VerifiedToken>;
  warm?(): Promise<void>;
}

export class TokenInvalidError extends Error {
  constructor(message: string) { super(message); this.name = "TokenInvalidError"; }
}
export class AuthorityUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "AuthorityUnavailableError"; }
}
```

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit: `LocalRosterAuthority` | Bit-for-bit v1 equivalence | Reuse `auth.test.ts` patterns: real `createHmac`, real `loadAgents`. Assert `verify` returns same results as `validateBearer`. |
| Unit: `JwksAuthority` | Signature validation, caching, kid-miss | Mock `fetch` via vitest. Test: valid JWT accepted, expired rejected, wrong `aud` rejected, `kid` miss refetched once, second miss logged+rejected. Use `jose.SignJWT` to produce test tokens. |
| Integration: server.ts | Middleware swap preserves 401/503/200 | Reuse `serverContract.test.ts` patterns. Replace real HTTP servers with existing test infra. Assert local backend path unchanged; authority-backed path returns 401 on invalid JWT. |
| Integration: `loadHttpRuntimeConfig` | Backend selection | Test unset env → `LocalRosterAuthority`; set `MCP_AUTHORITY_URL` → `JwksAuthority`; startup probe exits non-zero on unreachable authority. |

## Migration / Rollout

- **No data migration.** Unset `MCP_AUTHORITY_URL` → local backend works identically.
- `.agents.local.json` files remain valid. New agents onboard at the authority without touching local files.
- Phase 2 (per-tool scope wiring) is a separate, subsequent change.
- Rollback: revert to `validateBearer` call in middleware + remove authority option from `createHttpMcpServer`.

## Open Questions

- [ ] Should `JwksAuthority` expose the `warm()` lifecycle method for startup probe, or should the app's `loadHttpRuntimeConfig` handle that before passing the authority to the transport? The spec says "probe at startup by calling `warm()`" — design makes `warm()` optional on the interface, called by the app-side config loader.
