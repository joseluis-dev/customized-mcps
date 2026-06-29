# Exploration: external-token-authority-verification

> Outcome-oriented. Move agent-token verification out of each MCP app's
> local config so a separate authority (another MCP/service) issues and
> validates tokens. Resource servers in this repo only verify — they
> never own the agent roster. New agents onboard without touching any
> MCP's `.agents.local.json` or restarting any server. HTTP
> authentication stays mandatory; no unauthenticated defaults.

## Quick path

1. Today each MCP loads a per-agent roster from
   `MCP_AGENTS_JSON` / `MCP_AGENTS_INLINE`, hashes the bearer token with
   a local HMAC secret, and compares against each `keyHash`. The
   roster is the source of truth, and adding a new agent means editing
   a file and reloading the process.
2. Introduce a `TokenAuthority` interface in `@customized-mcps/mcp-http-base`
   with one method: `verify(token) -> { agentId, scopes } | error`. The
   current local HMAC roster is the first implementation. Every existing
   test still passes; the wiring does not change.
3. Add a second implementation (external authority) that calls out to a
   sibling MCP/service over HTTP, or that verifies a JWT against a JWKS
   the authority publishes. The middleware in `server.ts` swaps the
   `validateBearer` call for `authority.verify`.
4. New agents get registered at the authority; the authority issues a
   token. MCP apps never see the roster — they just see
   `Authorization: Bearer <token>` and an `agentId` + scope list.
5. The v1 contract (opaque tokens, scope shape, audit-safe 401/403/503,
   constant-time, fail-closed) is preserved. The only new failure mode
   is "authority unreachable" — treated like an HMAC misconfiguration
   (fail closed, sanitized 401/503).

## Why now

Today, onboarding a new agent is a four-step per-MCP chore: write
`{id, keyHash, scopes}` into the JSON, regenerate the HMAC, ship the
file (or volume-mount it), reload every process. With several MCPs
and a steady flow of new agents, the chore compounds. The user wants
a single source of truth for agent identity and a way to onboard a new
agent in one place without restarting any MCP. The existing
`mcp-agent-authorization` spec explicitly left room for this evolution
("OAuth2 / JWT / IdP integration is OUT of scope for v1 — a future
change MAY introduce them").

## Current state

Verified facts about the codebase:

- **Per-agent roster, local file or env**: `apps/mcp-readonly-sql/src/config/http.ts`
  reads `MCP_AGENTS_JSON` (path) or `MCP_AGENTS_INLINE` (raw JSON).
  `packages/mcp-http-base/src/auth.ts` parses the array, validates each
  record (`id`, `keyHash` = 64 hex chars, `scopes` = `<verb>:<resource>`),
  and exposes `loadAgents(json) -> AgentRecord[]`. Current sample
  roster lives at `apps/mcp-readonly-sql/.agents.local.json`.
- **Opaque HMAC bearer, validated in-process**:
  `validateBearer(token, hmacSecret, agents)` in
  `packages/mcp-http-base/src/auth.ts` computes
  `createHmac("sha256", hmacSecret).update(token).digest("hex")` and
  compares against each `keyHash` with `crypto.timingSafeEqual` (see
  `matchesToken` and `constantTimeEqualString`).
- **Middleware placement**: `server.ts` `handleMcpRequest` calls
  `validateBearer(...)` *before* `enforceBodyLimit` and *before*
  `activeTransport.handleRequest`, so unauthorized traffic never
  reaches the SDK transport. The handler attaches
  `(req as { auth?: ... }).auth = { clientId, scopes }` so the SDK can
  forward it to tool handlers (tool handlers do not currently read
  `auth`; scope enforcement is opt-in for now).
- **Scope enforcement today is partial**: `matchScope(agentScopes, required)`
  is exported and used in tests, but the production tool handlers in
  `apps/mcp-readonly-sql/src/tools/readonlyTools.ts` do not call it.
  The spec for `mcp-agent-authorization` lists the contract; the
  tool-level scope gate is still a TODO. The `mcp-readonly-sql` tool
  set is *de facto* available to any authenticated agent — the only
  per-call guard is the profile allowlist, which is server-side and
  applies to all agents equally. **Scope enforcement is mostly
  missing at the tool layer.**
- **Config contract**: `packages/mcp-http-base/src/config.ts` reads
  `MCP_AGENT_HMAC_SECRET` (>=32 bytes), `MCP_AGENTS_JSON`,
  `MCP_AGENTS_INLINE`. Spec (`mcp-agent-authorization`) requires the
  secret at startup; missing/short causes non-zero exit.
- **App config glue**: `apps/mcp-readonly-sql/src/config/http.ts`
  wraps the shared `parseHttpConfig` + `loadAgents` and surfaces a
  single `HttpRuntimeConfig`. The agents list is the only piece that
  varies per environment.
- **Spec / governance**:
  `openspec/specs/mcp-agent-authorization/spec.md` defines the v1
  contract; the v1 spec explicitly says "OAuth2 flows, JWT signature
  verification, and any third-party identity provider integration are
  OUT of scope for v1 — a future change MAY introduce them."
- **OpenSpec mode for this change**: `artifact_store: both` (Engram +
  OpenSpec). This exploration persists to both stores.
- **Test surface** (measured via `vitest list --json`, subject to drift):
  ~248 tests in `mcp-readonly-sql`; ~134 tests in `mcp-http-base`
  (auth, config, errors, server, serverContract, serverHardening,
  shutdown). Strict TDD, vitest 2.1.x, no coverage/lint tooling, no
  integration/e2e layer. The exact count shifts as tests are added;
  the safe phrase for downstream phases is "the existing vitest
  suite" rather than a pinned number.
- **Recent history**: the previous
  `2026-06-28-dedicated-mcp-server-deployment` change shipped the v1
  per-agent HMAC roster as a deliberate stepping stone. That change's
  `proposal.md` lists "OAuth2 / IdP" under Out of Scope.

## Affected areas

- `packages/mcp-http-base/src/auth.ts` — `loadAgents`,
  `validateBearer`, `matchScope` move behind a `TokenAuthority`
  interface. `AgentRecord` shape stays for backward compatibility.
- `packages/mcp-http-base/src/server.ts` — `handleMcpRequest` calls
  `authority.verify(token)` instead of `validateBearer`. Error shape
  is preserved (401 missing/invalid, 503 on authority failure).
- `packages/mcp-http-base/src/config.ts` — adds env knobs for the
  authority backend (URL, JWKS URL, audience, cache TTL, timeout).
  Old `MCP_AGENT_HMAC_SECRET` / `MCP_AGENTS_JSON` /
  `MCP_AGENTS_INLINE` remain valid for the "local" backend.
- `packages/mcp-http-base/src/index.ts` — exports the new
  `TokenAuthority` type and the two implementations
  (`LocalRosterAuthority`, `ExternalHttpAuthority` /
  `JwksAuthority`).
- `apps/mcp-readonly-sql/src/config/http.ts` — picks the backend
  based on env. No app-level behavior change; config loader is
  refactored to thread the chosen authority through.
- `apps/mcp-readonly-sql/src/index.ts` and
  `apps/mcp-readonly-sql/src/transports/http.ts` — pass the
  `TokenAuthority` instance into the shared `createHttpMcpServer`
  options.
- `apps/mcp-readonly-sql/src/tools/readonlyTools.ts` — opportunistically
  wire `matchScope` calls so the v1 scope grammar is actually enforced
  per tool (not just specified). The tools accept a `matchScope`
  helper from the new scope-check seam.
- `apps/mcp-readonly-sql/.env.example` / `.env` — document the new
  authority env vars. Keep the local-roster env vars documented as
  the "single-process dev" fallback.
- `apps/mcp-readonly-sql/.agents.local.json` — still works (local
  backend); no delete needed.
- `openspec/specs/mcp-agent-authorization/spec.md` — MODIFIED: replace
  the v1-only roster assumption with a "TokenAuthority" abstraction;
  add REQUIREMENTs for authority reachability / cache / TTL / failure
  mode. The opaque-token, constant-time, fail-closed, audit-safe
  guarantees from v1 stay.
- New spec `openspec/specs/mcp-token-authority/spec.md` (proposed
  domain name) — the wire contract for an external authority:
  verification request/response shape, status codes, scope shape,
  audience claim, JWKS rotation, cache TTL, authority-down
  semantics.
- `openspec/specs/mcp-tool-surface/spec.md` — add a scope-tag
  requirement per tool (so the wiring can be uniform across apps).
  Today tools are tagged with profile-scope and allowlist; the new
  tag is `<verb>:<resource>`.
- `openspec/specs/app-independence/spec.md` — append a
  "TokenAuthority pluggability" requirement so future apps adopt
  the same authority abstraction.
- `deploy/README.md` and `.env.example` — add a one-paragraph
  walkthrough of the external authority mode (URL, audience,
  rotation) and the operator failover (local roster as offline
  fallback).

## Approach comparison

| # | Approach | Pros | Cons | Effort |
|---|----------|------|------|--------|
| 1 | **Introspection call per request (RFC 7662 / OAuth2 style)** | Stateless servers; authority is the only place that knows the roster; revocation is immediate; standards-based. | Latency on every request (typically 5-50ms RTT); authority becomes a hard dependency; cache is a tradeoff vs revocation freshness; operator runs an extra service. | Medium-High (new HTTP client, retry/timeout, cache, in-flight TTL, authority-down handling). |
| 2 | **JWKS / JWT verification with short-lived tokens** | Fast verification (no network per request when JWKS is cached); standards-based; the authority is offline for the hot path; the resource server's public-key trust is asymmetric (no shared secret). | Token revocation is best-effort (short TTL is the lever); JWKS cache TTL is its own clock skew problem; first request after rotation pays a fetch cost; operator runs the authority. | Medium (JWKS fetcher with TTL, issuer/audience/expiry validation, key cache, kid mismatch recovery). |
| 3 | **Shared HMAC verifier (single secret across all MCPs + a sibling authority that is just a provisioning service)** | Smallest delta from v1; one env var to change; no network in the hot path; existing v1 tests stay green. | Secret compromise affects every MCP at once; rotation is a coordinated multi-MCP operation; the authority is still "just a JSON file" unless a sibling MCP/service hosts the provisioning UI; does not match the user's intent (the authority should validate, not just provision). | Low (config + factory swap; the hard parts of authority hosting are out of scope). |
| 4 | **Cached introspection (request when no cached result, otherwise use cache for TTL seconds)** | Combines the revocation freshness of (1) with most of the speed of (2); cache hit hides network; cache miss can be in parallel with request validation. | Cache is shared per process (one event loop, but many concurrent requests); still a hard dependency on the authority at startup and on every TTL miss; revocation is best-effort inside the cache window. | Medium-High (cache + invalidation + first-call blocking). |

### Recommended: Approach 2 (JWKS) as the target, Approach 3 as the smallest first change

Build the abstraction in a way that supports both. The first PR
introduces the `TokenAuthority` interface in `mcp-http-base` and
wires the local-roster implementation as the default (zero behavior
change; the existing vitest suite still green). The second PR adds the
`JwksAuthority` implementation. A follow-up PR (only if the user
wants per-request freshness) adds the `IntrospectionAuthority`.

Rationale:

- **Interface-first lets the spec stabilize before the
  implementation changes.** The spec can define the authority
  contract (request shape, response shape, failure semantics, cache
  contract) without committing to a wire format on day one.
- **JWKS is the standard answer** for resource-server fan-out: every
  MCP verifies locally with a cached public key, the authority
  publishes a JSON Web Key Set, and revocation is bounded by the
  token's TTL. The user already wants "new agents start with all
  scopes; the admin reduces scopes later" — short-lived tokens +
  per-scope re-issue is a clean fit.
- **Local roster stays as the offline / single-process fallback**
  so dev / air-gapped deployments still work. The v1 spec
  requirement that every MCP must be able to run behind a single
  bearer token is preserved.
- **Approach 1 (introspection) is real-time but expensive**;
  Approach 4 (cache + introspection) is its cache-fronted version.
  JWKS is the same idea, but the "verify locally" half is
  fundamentally cheaper than a network call per request. Save
  introspection for the rare case where the operator actually needs
  per-request freshness and is willing to host a hot dependency.
- **Approach 3 alone is not enough.** The user explicitly said the
  authority should *validate* tokens, not just provision them. A
  shared HMAC verifier shifts the problem from "every MCP has its
  own roster" to "every MCP shares a secret" — that is a real
  improvement (single roster), but it still makes each MCP
  responsible for the validation decision. The user wants to move
  that decision out.
- **The repo is already on origin/main (synced).** The orchestrator
  preflight requests a chained-PR auto-forecast against the 800-line
  review budget; the abstraction in this change is the natural split
  point between the interface + local-backend rewire (Phase 1) and
  the JWKS backend (Phase 2).

### Sketch of the seam (not final)

```ts
// packages/mcp-http-base/src/authority.ts (new file)
export type VerifiedToken = {
  agentId: string;
  scopes: string[];
  /** Authority-supplied expiry (epoch ms); undefined if the backend does not track it. */
  expiresAt?: number;
};

export type TokenAuthority = {
  /** Pure verify; throws on invalid / expired / missing. Never throws on transient authority errors. */
  verify(token: string): Promise<VerifiedToken>;
  /** Optional: prefetch / warm caches. Idempotent. */
  warm?(): Promise<void>;
  /** Optional: drop cached state for a specific agent (revocation hint). */
  invalidate?(agentId: string): void;
};

// packages/mcp-http-base/src/authority/localRoster.ts
// Wraps the existing validateBearer + loadAgents. Default backend.
// Behavior is bit-for-bit identical to the v1 path.

// packages/mcp-http-base/src/authority/jwks.ts
// Fetches JWKS from the authority's well-known endpoint, verifies a
// JWT (RS256/ES256), checks iss/aud/exp/nbf. Caches the JWKS for
// `MCP_AUTHORITY_JWKS_TTL_S` seconds; on `kid` miss, refetches once.
```

The middleware changes from:

```ts
const result = validateBearer(token, options.hmacSecret, options.agents);
```

to:

```ts
const verified = await options.authority.verify(token);
// 401 on throw, 503 on authority-unreachable.
(req as { auth?: { clientId: string; scopes: string[] } }).auth = {
  clientId: verified.agentId,
  scopes: verified.scopes,
};
```

### OpenSpec placement

- New domain: `mcp-token-authority` (proposed name; could be
  `mcp-external-token-authority`). Single new file:
  `openspec/changes/external-token-authority-verification/specs/mcp-token-authority/spec.md`.
- Modify: `mcp-agent-authorization` (replace v1-only roster
  assumption with the `TokenAuthority` abstraction; preserve all
  audit-safe / constant-time / fail-closed guarantees); add a scope
  enforcement requirement to `mcp-tool-surface`; add a
  "TokenAuthority pluggability" requirement to `app-independence`.
- Apply/verify commands stay per-app
  (`pnpm --filter mcp-readonly-sql test`) plus a new
  `pnpm --filter @customized-mcps/mcp-http-base test` target for
  the new authority tests.

## Product constraints (recap from the user)

- New agents default to all scopes (`read:* list:* call:*`) when they
  register at the authority. The admin later reduces scopes per
  agent. The authority's onboarding flow is out of scope for this
  change (the user will build the authority separately); the
  resource-server side just has to *enforce* whatever the authority
  hands back.
- No unauthenticated defaults. HTTP must keep returning 401 when the
  bearer is missing or invalid, and 503 when the authority is
  unreachable. The v1 fail-closed semantics are preserved.
- New agents onboard without touching any MCP's
  `.agents.local.json` or restarting any server. The
  local-roster backend still works (single-process dev), but the
  external authority backend is the default for shared/production.

## Smallest safe first change vs later phases

Phase 1 (this change, ~200-400 LoC): introduce the `TokenAuthority`
interface, ship the local-roster implementation behind it, wire the
middleware through it, and ship the JWKS implementation. No app
config change is mandatory; the app keeps using the local backend
unless `MCP_AUTHORITY_URL` is set. Tests: every existing
`httpAuth.test.ts` case still passes; new tests cover
`LocalRosterAuthority` and `JwksAuthority` directly (mocked fetch
for the latter).

Phase 2 (follow-up, ~150-300 LoC): wire `matchScope` calls into the
five read-only tools in `mcp-readonly-sql/src/tools/readonlyTools.ts`
so the v1 scope grammar is actually enforced per call. This change
was always a TODO; the authority abstraction makes the scope list
authoritative, so it is the natural moment to wire it.

Phase 3 (optional, future change): add the `IntrospectionAuthority`
backend for the rare case where the operator wants per-request
freshness. Skip unless the user asks for it.

## Risks

- **Authority as a hard dependency**: when `MCP_AUTHORITY_URL` is set
  the MCP will not start if the authority is unreachable. The local
  roster stays as the offline fallback. The spec must state the
  fail-closed policy explicitly.
- **JWKS cache TTL vs revocation**: revocation is bounded by
  `min(token TTL, JWKS TTL)`. The user's "new agent default to all
  scopes" rule cuts both ways: onboarding is fast, but a leaked
  token with `*` scopes is dangerous until the token expires. The
  authority should issue tokens with a short TTL (e.g. 15-60 min)
  and rely on the agent to refresh.
- **Authority clock skew**: the JWT `exp`/`nbf` checks must allow
  `MCP_AUTHORITY_LEEWAY_S` (default 30s) of skew. Bigger leeway is a
  footgun; smaller breaks the first request after a clock-step.
- **Tool-layer scope enforcement is still missing**: the
  `TokenAuthority` abstraction is necessary but not sufficient. The
  second risk is that this change ships the interface and the
  middleware update, but the tools still do not call `matchScope`.
  Phase 2 closes the gap. The change MUST NOT pretend the
  abstraction closes the gap on its own.
- **Chained-PR split point**: the 800-line review budget can be hit
  by Phase 1 alone (interface + local backend rewire + JWKS
  implementation). `sdd-tasks` should re-forecast against the live
  diff; if Phase 1 is over budget, split at the `TokenAuthority`
  interface boundary — Phase 1a = interface + local backend rewire,
  Phase 1b = JWKS implementation.
- **Secret hygiene regression risk**: the JWKS verifier does not
  read the HMAC secret, so `MCP_AGENT_HMAC_SECRET` can be relaxed
  or deprecated for the JWKS path. The spec must say "required
  unless `MCP_AUTHORITY_URL` is set" so operators are not left
  with a stale env.
- **Per-app port collision**: a future "authority" MCP will also
  live in `apps/`, so the `mcp-http-transport` "Port Allocation
  Convention" (3001, 3002, 3003, ...) applies. Document the
  authority's port in `.env.example` and `deploy/README.md`.
- **Cache poisoning / kid mismatch**: a malicious or compromised
  authority could publish a JWKS that pins to an attacker-controlled
  key. Mitigations: pin the issuer URL via `MCP_AUTHORITY_URL`,
  validate `iss` and `aud`, refetch JWKS on `kid` miss but cap
  refetches, and log the miss. Same protections as every other
  JWKS consumer; the change does not invent new cryptography.
- **Operator confusion**: the `.env.example` MUST clearly mark
  which env vars belong to which backend and what the
  precedence/precedence-fallback is. A short "Choose your backend"
  section in the README is the cheapest way to keep this
  un-surprising.
- **The spec must not preempt the authority's design**: the user
  is building the authority separately. This change is the
  *resource-server side* — verify tokens, do not invent the
  authority's API. The wire contract is what the user
  publishes; the spec for `mcp-token-authority` is the local
  contract *for that wire format*, written after the user
  publishes the format. The first PR MUST leave a clear seam
  for that wire format; the second PR MAY add a specific
  implementation once the user pins the format.

## Open questions (for the proposal, not blockers)

- **Authority wire format**: the user said "another MCP/service
  will generate and validate agent tokens" but did not pin the
  protocol. Options are: OAuth2 introspection (RFC 7662), JWT
  (RFC 7519) with JWKS, MCP-over-HTTP (i.e. the authority *is*
  an MCP that exposes a `verify_token` tool), or a custom JSON
  contract. The exploration assumes JWT+JWKS as the default
  because it is the lowest-friction path; the proposal must
  confirm with the user before locking the spec.
- **Token format**: opaque (current v1) or JWT? The v1 spec
  explicitly forbade JWT in v1. This change MAY allow JWT for
  the external authority path; the proposal must decide.
- **Scope tag for the tools**: today the five read-only tools are
  described in the `mcp-tool-surface` spec but they are not
  tagged with the scope each one requires. Phase 2 needs a
  per-tool scope mapping (`list_profiles` → `list:*`,
  `execute_read_query` → `read:<profile-alias>`, etc.). The
  proposal should ask the user to confirm the mapping or accept
  a default.
- **Cache TTL defaults**: 60s for JWKS, 30s clock-skew leeway,
  5s for the HTTP fetch timeout. The proposal should confirm
  these or accept defaults.
- **Authority port**: if the authority is an MCP in this same
  workspace, which port gets it? The proposal should pick a
  port consistent with the `mcp-http-transport` "Port Allocation
  Convention" (3001 already taken by `mcp-readonly-sql`).
- **What the authority returns when the agent has been
  deactivated**: 200 with `active: false`? 401? 410 Gone? The
  exploration does not pin this; the proposal MUST.
- **Per-tool scope mapping must remain compatible with the existing
  scope grammar regex** in
  `packages/mcp-http-base/src/auth.ts` line 122:
  `^(read|list|call):(\*|[A-Za-z0-9_.-]+)$/i` (the exported
  `SCOPE_PATTERN`). Phase 2's per-tool tag table (e.g.
  `list_profiles` → `list:*`, `execute_read_query` →
  `read:<profile-alias>`) MUST be validated against this pattern
  at design time, and the external authority's `scopes` array MUST
  be parsed by the same `loadAgents` validator so the grammar is
  uniform across both backends. New verbs (e.g. `admin`, `write`)
  require a regex update and a v2 of `SCOPE_PATTERN`; the
  exploration does not introduce a second pattern.
- **Operator failover**: if the authority is down, should the
  MCP fail-closed (no auth) or fail-open (accept cached
  tokens)? The user's "no unauthenticated defaults" implies
  fail-closed; the proposal should confirm.

## Ready for proposal

**Yes, with a clear handoff to the user.** The exploration answers
the core question: introduce a `TokenAuthority` interface in
`@customized-mcps/mcp-http-base`, ship the local-roster backend as
the default, add a JWKS backend, and update the middleware to
verify through the interface. The next phase (`sdd-propose`) MUST
resolve the open questions above (authority wire format, token
format, per-tool scope mapping, cache defaults, authority port,
deactivation semantics, failover policy) before locking the spec
for `mcp-token-authority`. The user is also building the
authority itself, so the spec is the *resource-server side* of the
contract — the authority's side is a separate change outside this
repo.

Suggested next steps:

- `sdd-propose` — write `proposal.md` with intent, scope,
  approach (TokenAuthority interface + LocalRosterAuthority as
  default + JwksAuthority as the external backend), affected
  areas (above), and a clear "out of scope: building the
  authority itself" line.
- `sdd-spec` — write the new `mcp-token-authority` domain spec
  and the `mcp-agent-authorization` / `mcp-tool-surface` /
  `app-independence` deltas.
- `sdd-design` — design the `TokenAuthority` interface, the
  `JwksAuthority` implementation, the cache + clock-skew
  handling, the failure-mode mapping (authority unreachable →
  503), and the middleware swap in `server.ts`.
- `sdd-tasks` — re-forecast against the 800-line budget; if
  high, split into Phase 1 (interface + local backend
  rewire) and Phase 2 (JWKS backend) chained PRs.
- `sdd-apply` — Strict TDD. The first failing test should be
  `TokenAuthority.verify` rejects on missing token; the second
  should be `JwksAuthority.verify` accepts a signed JWT and
  rejects an expired one. Wire the middleware in the
  `RED-GREEN-REFACTOR` order.
- `sdd-verify` — confirm the existing vitest suite still passes
  (both `@customized-mcps/mcp-http-base` and `mcp-readonly-sql`);
  confirm the new authority tests pass; confirm stdio path is
  unaffected; confirm `GET /healthz` and graceful shutdown
  still work.
- `sdd-archive` — merge deltas into main specs
  (`mcp-agent-authorization`, `mcp-tool-surface`,
  `app-independence`).
