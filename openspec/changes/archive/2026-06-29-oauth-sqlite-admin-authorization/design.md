# Design: OAuth2 SQLite Admin Authorization

## Technical Approach

`apps/mcp-oauth-admin` (port 3002) is a standalone `node:http` process — OAuth2 AS, SQLite store, and server-rendered admin UI in one binary. Resource servers wire `OAuthAdminAuthority` (extends Phase 0 `JwksAuthority`) when `MCP_AUTHORITY_URL` is set. No Express, no SPA. The contract is strict: **the authority owns default-scope assignment**; resource servers **never widen** from env/config.

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| DB driver | `knex` + `sqlite3` (async, WAL) | Reuses existing dep; single `better-sqlite3`-style serialized writer via mutex + 5-retry SQLITE_BUSY backoff |
| Migrations | Raw SQL files (`src/migrations/`) applied by knex programmatically on first start | No CLI tool needed; idempotent; already the knex pattern |
| OAuth library | `jose` (JWK/JWT sign/verify) + `argon2` (password hash) | Proposal-mandated; `node:crypto` JWK export for JWKS endpoint |
| Admin UI rendering | String-template HTML, `node:http` inline router | No Express/SPA per spec; matches the shared base's zero-dep discipline |
| Session secret | `node:crypto.randomBytes(32)`, regenerated on restart (invalidates all sessions) | Simple, no persistent key needed; admin re-logs in on restart |
| Self-probe | `OAuthAdminAuthority.warm()` calls `/oauth/introspect`, exits non-zero on failure | Extends `JwksAuthority.warm()`; same lifecycle pattern as `TokenAuthority` |

## Data Flow

```
Resource Server ──Bearer──▶ node:http middleware ──▶ OAuthAdminAuthority.verify()
        │                                                    │
        │                           ┌────────────────────────┘
        │                           ▼
        │              JwksAuthority (JWKS cache, 60s TTL)
        │                           │
        │              ┌────────────┘ (kid miss)
        │              ▼
        │    GET {MCP_AUTHORITY_URL}/.well-known/jwks.json
        │              │
        ▼              ▼
  token valid? ──▶ { agentId, scopes } ──▶ tool handler
  token bad?   ──▶ 401          unreachable? ──▶ 503
```

Admin UI shares the same `node:http` listener on `/admin/*`. Session cookie (`HttpOnly; SameSite=Strict; Secure` when not loopback) gates all admin routes. Double-submit CSRF: hidden form input + `X-CSRF-Token` header checked server-side.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `apps/mcp-oauth-admin/package.json` | Create | Dependencies: `jose`, `argon2`, `knex`, `sqlite3`, `@customized-mcps/mcp-http-base` |
| `apps/mcp-oauth-admin/src/index.ts` | Create | Entrypoint: DB init → migrations → OAuth routes → admin routes → listen |
| `apps/mcp-oauth-admin/src/db/schema.ts` | Create | Knex schema builder — 7 tables per spec |
| `apps/mcp-oauth-admin/src/db/migrations/` | Create | Idempotent SQL files, applied on startup |
| `apps/mcp-oauth-admin/src/oauth/token.ts` | Create | `/oauth/token` (client_credentials + password), RS256 sign via `jose` |
| `apps/mcp-oauth-admin/src/oauth/introspect.ts` | Create | `/oauth/introspect`, validates + decodes JWT |
| `apps/mcp-oauth-admin/src/oauth/jwks.ts` | Create | `/.well-known/jwks.json` + `openid-configuration` |
| `apps/mcp-oauth-admin/src/admin/router.ts` | Create | Server-rendered CRUD pages, CSRF, session |
| `apps/mcp-oauth-admin/src/admin/session.ts` | Create | Signed-cookie session + per-username backoff in SQLite |
| `apps/mcp-oauth-admin/src/sweep.ts` | Create | Daily retention sweep (audit 90d, revoked refresh 30d) |
| `apps/mcp-oauth-admin/src/backup.ts` | Create | SQLite online backup API, atomic file replacement |
| `packages/mcp-http-base/src/authority/oauthAdmin.ts` | Create | `OAuthAdminAuthority` — extends `JwksAuthority`, adds self-probe |
| `packages/mcp-http-base/src/authority/index.ts` | Modify | Export `OAuthAdminAuthority` |
| `apps/mcp-readonly-sql/src/config/http.ts` | Modify | Wire `MCP_AUTHORITY_URL` → `OAuthAdminAuthority`; local roster fallback |
| `deploy/systemd/mcp-oauth-admin.service` | Create | Per-app systemd unit |
| `deploy/docker/Dockerfile.mcp-oauth-admin` | Create | Multi-stage, non-root, HEALTHCHECK |
| `deploy/nginx/mcp.conf` | Modify | Add port 3002 upstream |
| `deploy/README.md` | Modify | Multi-app indexed runbook |

## Key Contracts

```typescript
// OAuthAdminAuthority (packages/mcp-http-base)
class OAuthAdminAuthority extends JwksAuthority {
  constructor(opts: { authorityUrl: string; audience: string; jwksTtlMs?: number; logger: Logger });
  async warm(): Promise<void>; // POST /oauth/introspect self-probe; exits non-zero on fail
  // verify() inherited from JwksAuthority — JWKS-backed RS256 validation, 60s cache
}

// Resource-server env contract (no new env vars for scope widening)
MCP_AUTHORITY_URL=http://127.0.0.1:3002    // triggers OAuthAdminAuthority
MCP_AUTHORITY_AUDIENCE=mcp:readonly-sql     // per-app audience claim
// No MCP_MIN_DEFAULT_SCOPES — the authority owns defaults
```

## Testing Strategy

| Layer | What | How |
|-------|------|-----|
| Unit | Schema migrations, `jose` sign/verify, CSRF token generation, backoff counter, scope validation | Vitest, in-memory SQLite (`sqlite3` `:memory:`) per test |
| Unit | OAuth endpoint handlers (token, introspect) | Mock DB layer, assert JWT claims + error shapes |
| Integration | Full OAuth flow: register → token → introspect → refresh → revoke | Real SQLite (`:memory:`), real `node:http` listener via random port |
| Integration | Admin UI: login → create agent → CRUD → audit log visible | Real SQLite, cookie jar in test |
| Integration | Self-probe: authority down → exit non-zero; authority up → warm() succeeds | Subprocess or simulated connection refused |
| E2E | `OAuthAdminAuthority` wired into `mcp-readonly-sql` against a running authority | Start both processes; agent gets JWT → calls tool → 200 |

## Migration / Rollout

Phases 0 (JwksAuthority prerequisite) through 5 (remove local roster) as defined in the proposal. Resource servers read `MCP_AUTHORITY_URL` → pick `OAuthAdminAuthority`; unset → `LocalRosterAuthority` fallback. Rollback: unset URL, restore local roster JSON. Per-app deploy templates ship in Phase 4.

## Open Questions

- None; all exploration questions locked at proposal stage.
