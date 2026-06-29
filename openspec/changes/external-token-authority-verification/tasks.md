# Tasks: External Token Authority Verification

## Review Workload Forecast

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High
800-line budget risk: Medium
Estimated changed lines (Phase 1, both PRs): ~1050
Delivery strategy: auto-forecast

### Work Units

| Unit | Goal | PR | Base |
|------|------|----|------|
| 1a | Interface + LocalRosterAuthority + middleware swap | PR1 | `feature/token-authority` tracker |
| 1b | JwksAuthority + jose + env knobs + warm probe | PR2 | PR1 branch |
| 2 | Per-tool `requiredScope` + matchScope | Phase 2 (separate) | main |

Dependency: PR1 → PR2 → (Phase 2). 📍 Current focus: Phase 1a.

## Phase 1a: TokenAuthority Interface + Local Backend (PR1)

> Strict TDD. Gate findings F1 (scope filter), F2 (verb tests), F3 (`warm()`) reflected.

- [x] 1a.1 RED — `serverContract.test.ts`: middleware calls `authority.verify`; `TokenInvalidError`→401; `AuthorityUnavailableError`→503.
- [x] 1a.2 RED — `test/authority/localRoster.test.ts`: bit-for-bit v1 equivalence; rejects on mismatch.
- [x] 1a.3 RED — Local authority filters scopes via `SCOPE_PATTERN`; invalid dropped, WARN omits value (F1+F2).
- [x] 1a.4 GREEN — `src/authority/types.ts`: `TokenAuthority` (opt. `warm()`), `VerifiedToken`, errors (F3).
- [x] 1a.5 GREEN — `src/authority/localRoster.ts`: wraps `loadAgents`+`validateBearer`; applies `SCOPE_PATTERN`.
- [x] 1a.6 GREEN — `server.ts`: middleware takes `authority`; replace `validateBearer(...)` with `await authority.verify(token)`.
- [x] 1a.7 GREEN — `HttpMcpServerOptions`: add `authority`; keep `agents`/`hmacSecret` private.
- [x] 1a.8 GREEN — `index.ts` exports: `TokenAuthority`, `LocalRosterAuthority`, errors.
- [x] 1a.9 REFACTOR — Re-run `mcp-http-base` (134) and `mcp-readonly-sql` (~210) suites; v1 path bit-for-bit.

## Phase 1b: JwksAuthority + Probe + Config (PR2)

> All 1a tests stay green. `jose` added as runtime dep. `fetch` mocked via vitest.

- [ ] 1b.1 RED — `JwksAuthority.verify`: accept valid JWT; reject expired/wrong-`aud`/wrong-`iss`/`kid` second-miss (F2+F3).
- [ ] 1b.2 RED — JWKS authority filters `scopes` via `SCOPE_PATTERN`; invalid dropped, WARN omits value (F1).
- [ ] 1b.3 RED — First call fetches JWKS once; cache reused for `MCP_AUTHORITY_JWKS_TTL_S` (60); refetch on `kid` miss.
- [ ] 1b.4 RED — Unreachable within `MCP_AUTHORITY_FETCH_TIMEOUT_MS` (5000) → `AuthorityUnavailableError`; `warm()` fails same way.
- [ ] 1b.5 RED — `config.test.ts`: 6 authority env vars (defaults, bad integers, missing audience).
- [ ] 1b.6 RED — `config/http.test.ts`: unset→local; set+reachable→JWKS; unreachable→probe exits non-zero.
- [ ] 1b.7 GREEN — Add `jose@^5` to `packages/mcp-http-base/package.json`; `pnpm install`.
- [ ] 1b.8 GREEN — `src/authority/jwks.ts`: `JwksAuthority` ({issuer, jwksUrl, audience, ttlSeconds, leewaySeconds, fetchTimeoutMs, logger}); `jose.createRemoteJWKSet`+`jwtVerify`; `kid`-miss refetch; `warm()` prefetch.
- [ ] 1b.9 GREEN — Extend `HttpConfigInput`/`HttpConfig` with 6 authority env vars; defaults `60/30/5000`.
- [ ] 1b.10 GREEN — `loadHttpRuntimeConfig`: instantiate `TokenAuthority` (unset→local, set→JWKS); await `warm()`; exit non-zero on probe fail.
- [ ] 1b.11 GREEN — `transports/http.ts`: thread `authority` into `createHttpMcpServer`.
- [ ] 1b.12 GREEN — `index.ts` exports: `JwksAuthority`.
- [ ] 1b.13 GREEN — `apps/mcp-readonly-sql/.env.example`: `Choose your backend` (local=dev/offline, JWKS=prod); document 6 env vars.
- [ ] 1b.14 GREEN — `deploy/README.md`: `authorityBackend` in `/healthz`; backend section; port 3002 reserved.
- [ ] 1b.15 REFACTOR — Full vitest; `/healthz` `authorityBackend` correct; 401/503 bodies omit token/`kid`/agentId/URL.

## Out of Scope

- [ ] Phase 2 — per-tool `requiredScope` in `readonlyTools.ts` + `matchScope` 403. Tracked in follow-up SDD.
