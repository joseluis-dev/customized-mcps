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

> All 1a tests stay green. `jose` added as runtime dep. JWKS end-to-end
> served by a real `http.createServer` (jose v5 uses `https.get`/`http.get`
> directly, not `globalThis.fetch`).

- [x] 1b.1 RED — `JwksAuthority.verify`: accept valid JWT; reject expired/wrong-`aud`/wrong-`iss`/`kid` second-miss (F2+F3).
- [x] 1b.2 RED — JWKS authority filters `scopes` via `SCOPE_PATTERN`; invalid dropped, WARN omits value (F1).
- [x] 1b.3 RED — First call fetches JWKS once; cache reused for `MCP_AUTHORITY_JWKS_TTL_S` (60); refetch on `kid` miss.
- [x] 1b.4 RED — Unreachable within `MCP_AUTHORITY_FETCH_TIMEOUT_MS` (5000) → `AuthorityUnavailableError`; `warm()` fails same way.
- [x] 1b.5 RED — `config.test.ts`: 6 authority env vars (defaults, bad integers, missing audience).
- [x] 1b.6 RED — `config/http.test.ts`: unset→local; set+reachable→JWKS; unreachable→probe exits non-zero.
- [x] 1b.7 GREEN — Add `jose@^5` to `packages/mcp-http-base/package.json`; `pnpm install` (jose@5.10.0 resolved).
- [x] 1b.8 GREEN — `src/authority/jwks.ts`: `JwksAuthority` ({issuer, jwksUrl, audience, ttlSeconds, leewaySeconds, fetchTimeoutMs, logger}); `jose.createRemoteJWKSet`+`jwtVerify`; `kid`-miss refetch (manual `reload()` after first miss); `warm()` probe via `globalThis.fetch` with timeout.
- [x] 1b.9 GREEN — Extend `HttpConfigInput`/`HttpConfig` with 6 authority env vars; defaults `60/30/5000`; `MCP_AUTHORITY_AUDIENCE` REQUIRED when `MCP_AUTHORITY_URL` is set.
- [x] 1b.10 GREEN — `loadHttpRuntimeConfig` is now async; instantiates `TokenAuthority` (unset→local, set→JWKS); awaits `warm()`; exits non-zero on probe fail. App-side defaults `MCP_AUTHORITY_JWKS_URL` to the well-known OIDC path when unset.
- [x] 1b.11 GREEN — `transports/http.ts`: threads `authority` and `authorityBackend` into `createHttpMcpServer`.
- [x] 1b.12 GREEN — `packages/mcp-http-base/src/index.ts` re-exports `JwksAuthority` and `JwksAuthorityOptions`.
- [x] 1b.13 GREEN — `apps/mcp-readonly-sql/.env.example`: `Choose your backend` section (local=dev/offline, JWKS=prod); documents 6 env vars; describes OIDC well-known default for the JWKS URL.
- [x] 1b.14 GREEN — `deploy/README.md`: `authorityBackend` in `/healthz`; new `Choose your backend` section; port 3002 reserved for the future authority MCP.
- [x] 1b.15 REFACTOR — Full mcp-http-base vitest: **178 tests passing** (was 153; +25 net-new: 12 JWKS unit + 13 config). Full mcp-readonly-sql vitest: **224 tests passing** (was 221; +3 backend-selection). `/healthz` returns JSON `{status, authorityBackend}` (audit-safe; no token/kid/URL). 401/503 bodies unchanged (already sanitized by `sanitizeError` in Phase 1a). `jose` is a runtime dep of `mcp-http-base`. Typecheck clean on both packages.

## Out of Scope

> The Phase 2 work (per-tool `requiredScope` in `readonlyTools.ts` +
> `matchScope` 403) is **deliberately not part of this change**. It is
> tracked as a follow-up SDD (separate proposal, separate PR). It is
> listed here as a plain note, not as a task checkbox, so the native
> dispatcher does not count it as pending work for this change.
