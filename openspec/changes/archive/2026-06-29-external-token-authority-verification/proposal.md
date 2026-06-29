# Proposal: external-token-authority-verification

## Intent

Move agent-token verification out of each MCP's local roster. A sibling authority (another MCP/service) issues and validates agent tokens; MCPs in this repo become resource servers that verify, never own the agent roster. New agents onboard at the authority without touching any `.agents.local.json` or restarting any server. HTTP auth stays mandatory; no unauthenticated defaults. The v1 audit-safe, constant-time, fail-closed guarantees are preserved.

## Scope

### In Scope
- `TokenAuthority` interface in `@customized-mcps/mcp-http-base` with `verify(token) -> { agentId, scopes }` (and optional `warm`, `invalidate`)
- `LocalRosterAuthority` (default implementation when MCP_AUTHORITY_URL is unset; bit-for-bit equivalent to v1 `loadAgents` + `validateBearer`)
- `JwksAuthority` (verifies RS256/ES256 JWTs against the authority's JWKS)
- Middleware swap in `server.ts`: `validateBearer(...)` -> `await authority.verify(token)`
- New env knobs: `MCP_AUTHORITY_URL`, `MCP_AUTHORITY_JWKS_URL`, `MCP_AUTHORITY_AUDIENCE`, `MCP_AUTHORITY_JWKS_TTL_S=60`, `MCP_AUTHORITY_LEEWAY_S=30`, `MCP_AUTHORITY_FETCH_TIMEOUT_MS=5000`
- Per-tool scope-tag seam in `readonlyTools.ts` (Phase 2; tool-level `matchScope` wiring)

### Out of Scope
- Building the authority itself (separate change, separate repo per user intent)
- `IntrospectionAuthority` (RFC 7662) — Phase 3, only if user requests per-request freshness
- Migration tooling for the existing local roster (the local backend keeps working)
- New verbs beyond `read`/`list`/`call`; the existing `SCOPE_PATTERN` is reused

## Capabilities

### New Capabilities
- `mcp-token-authority`: resource-server-side contract for the external authority — JWKS fetch + 60s cache, JWT `iss`/`aud`/`exp`/`nbf` validation with 30s leeway, `kid`-miss refetch with cap/logging, fail-closed 503 on authority unreachable, 401 on expired/revoked/deactivated

### Modified Capabilities
- `mcp-agent-authorization`: replace v1-only roster assumption with `TokenAuthority` abstraction; preserve constant-time, fail-closed, audit-safe guarantees; v1 "no JWT" line removed for the external path only
- `mcp-tool-surface`: add a per-tool scope-tag requirement (`<verb>:<resource>` against the existing `SCOPE_PATTERN`) so the wiring is uniform across apps
- `app-independence`: append a "TokenAuthority pluggability" requirement so future apps adopt the same abstraction

## Approach

Default-selection rule: when MCP_AUTHORITY_URL is unset, the runtime picks LocalRosterAuthority (this is the unset-env default, NOT a recommendation). The recommended default for production and shared deployments is JwksAuthority, activated by setting MCP_AUTHORITY_URL.

Interface-first. `TokenAuthority` lives in `mcp-http-base`; `LocalRosterAuthority` (default implementation when MCP_AUTHORITY_URL is unset) and `JwksAuthority` both implement it. Middleware in `server.ts` calls `await authority.verify(token)`. `JwksAuthority` fetches the JWKS, caches it for 60s, validates `iss`+`aud`+`exp`+`nbf` with 30s leeway; on `kid` miss it refetches once, caps, and logs. Authority unreachable maps to 503; expired/revoked/deactivated maps to 401. New agents default to `read:*`, `list:*`, `call:*`; the admin restricts scopes by re-issuing. The `SCOPE_PATTERN` regex `^(read|list|call):(\*|[A-Za-z0-9_.-]+)$` is reused; `loadAgents` parses the authority's `scopes` array so grammar is uniform across both backends. The local HMAC roster is the dev/offline fallback (no production default for shared deployments). If a sibling authority MCP is added to this workspace later, it uses port 3002 per the `mcp-http-transport` Port Allocation Convention (3001 is taken by `mcp-readonly-sql`).

**Chained PR auto-forecast**: the natural split is at the `TokenAuthority` interface boundary. If Phase 1 (interface + local-backend rewire + JWKS backend + middleware swap) exceeds the 800-line review budget, split into:
- **Phase 1a**: `TokenAuthority` interface + `LocalRosterAuthority` + middleware swap (zero behavior change).
- **Phase 1b**: `JwksAuthority` + authority env knobs + startup probe + `.env.example` updates.
- **Phase 2** (separate change): per-tool `matchScope` wiring in `readonlyTools.ts`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/mcp-http-base/src/authority.ts` | New | `TokenAuthority` interface, `VerifiedToken` type |
| `packages/mcp-http-base/src/authority/localRoster.ts` | New | Wraps `loadAgents` + `validateBearer` (v1-equivalent) |
| `packages/mcp-http-base/src/authority/jwks.ts` | New | JWKS fetch + 60s cache + JWT verify with 30s leeway |
| `packages/mcp-http-base/src/auth.ts` | Modified | Move `loadAgents`/`validateBearer`/`matchScope` behind interface; `SCOPE_PATTERN` exported |
| `packages/mcp-http-base/src/server.ts` | Modified | Middleware calls `authority.verify`; 401/503 mapping preserved |
| `packages/mcp-http-base/src/config.ts` | Modified | Authority env knobs (URL, JWKS URL, audience, TTL, leeway, timeout) |
| `packages/mcp-http-base/src/index.ts` | Modified | Export `TokenAuthority` + both implementations |
| `apps/mcp-readonly-sql/src/config/http.ts` | Modified | Pick backend from env; thread authority through |
| `apps/mcp-readonly-sql/src/{index,transports/http}.ts` | Modified | Pass `TokenAuthority` into shared `createHttpMcpServer` |
| `apps/mcp-readonly-sql/src/tools/readonlyTools.ts` | Modified (Phase 2) | Wire `matchScope` per tool |
| `apps/mcp-readonly-sql/.env.example`, `deploy/README.md` | Modified | Document both backends; "Choose your backend" section |
| `openspec/specs/mcp-token-authority/spec.md` | New | New capability spec (wire contract) |
| `openspec/specs/mcp-agent-authorization/spec.md` | Modified | `TokenAuthority` abstraction; preserve v1 guarantees |
| `openspec/specs/mcp-tool-surface/spec.md` | Modified | Per-tool scope-tag requirement |
| `openspec/specs/app-independence/spec.md` | Modified | `TokenAuthority` pluggability |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Authority unreachable in production | Med | Fail-closed 503; local-roster backend stays; startup probe required when `MCP_AUTHORITY_URL` is set |
| Leaked `*` scope token before expiry | Med | Authority issues short-TTL tokens (15-60 min); admin restricts scopes by re-issue, not by waiting for expiry |
| JWKS cache poisoning / `kid` mismatch | Low | Pin issuer via `MCP_AUTHORITY_URL`; validate `iss`+`aud`; refetch once on `kid` miss; cap + log |
| Clock skew breaks first request | Med | Default 30s leeway via `MCP_AUTHORITY_LEEWAY_S`; configurable per deployment |
| Tool-layer scope enforcement still missing | Med | Phase 2 explicitly wires `matchScope` per tool; Phase 1 ships the abstraction only and does not pretend to close the gap |
| Phase 1 exceeds 800-line review budget | Med | Chained PR split at `TokenAuthority` boundary (1a: interface + local rewire, 1b: JWKS backend) |
| Operator confusion between backends | Med | `.env.example` + `deploy/README.md` "Choose your backend" section; local backend marked dev/offline-only |
| Port collision with future authority MCP | Low | Reserve 3002 per `mcp-http-transport` Port Allocation Convention; documented in this change |
| Spec preempts the authority's design | Low | Spec is the *resource-server side* of the contract; authority's side is a separate change in a separate repo |

## Rollback Plan

1. Revert the PR(s) that introduced `TokenAuthority` and the new authority env knobs.
2. Middleware in `server.ts` returns to the v1 `validateBearer(...)` call.
3. Local-roster env vars (MCP_AGENT_HMAC_SECRET, MCP_AGENTS_JSON, MCP_AGENTS_INLINE) remain untouched; they continue to drive the unset-env path on the pre-change code.
4. No data migration: unset `MCP_AUTHORITY_URL` to fall back to the local backend; existing `.agents.local.json` is the source of truth again.
5. `GET /healthz` and graceful shutdown paths are unchanged.
6. Spec deltas revert; `mcp-agent-authorization` returns to the v1 wording for the affected REQUIREMENTs.

## Dependencies

- The authority MCP/service is built and operated by the user; this change consumes its JWKS endpoint and validates its JWTs. The wire contract is owned by the user's authority; the spec for `mcp-token-authority` is the resource-server-side mirror.
- A JWT verification library: `jose` (preferred, ESM-native, modern) or `jsonwebtoken` + `node-jose`. The design phase picks one and pins the version.
- Existing `mcp-readonly-sql` (~210 tests) and `mcp-http-base` (~134 tests) vitest suites must remain green; coverage tooling is not in the repo.

## Success Criteria

- [ ] All existing vitest cases in `mcp-readonly-sql` and `mcp-http-base` pass unchanged.
- [ ] New vitest cases cover `LocalRosterAuthority` (v1-equivalent) and `JwksAuthority` directly (mocked fetch for the latter).
- [ ] With `MCP_AUTHORITY_URL` unset, behavior is bit-for-bit equivalent to v1 (local roster).
- [ ] With `MCP_AUTHORITY_URL` set: a JWT signed by the authority with valid `iss`+`aud`+`exp` is accepted; an expired/revoked/deactivated token returns 401; an unreachable authority returns 503.
- [ ] `kid` miss triggers exactly one refetch and is logged; a second `kid` miss is logged and the request is rejected.
- [ ] `deploy/README.md` and `.env.example` clearly mark which env vars belong to which backend and what the precedence is.
- [ ] Audit-safe error responses preserved: no token, no `keyHash`, no agent id in 401/403/503 bodies (same `sanitizeError` path as v1).
- [ ] Constant-time token comparison preserved on the local-roster path; JWT verify is signature-based on the JWKS path.
- [ ] Tool-layer scope enforcement wired per tool in a follow-up Phase 2 change (not in this change).
