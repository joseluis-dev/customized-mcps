# Exploration: oauth-sqlite-admin-authorization

> Outcome-oriented. Replace the static HMAC + JSON agent roster with a real
> OAuth2 Authorization Server backed by SQLite. One admin authority owns
> agents, clients, and scopes. MCP apps become pure resource servers that
> validate OAuth access tokens + scopes. Operators manage state through a
> web admin UI, not by editing JSON files or restarting processes. New
> agents onboard with minimum scopes; elevation requires admin action.
> Phased so the project does not need to be completed in one session.

## Quick path

1. Today the shared `@customized-mcps/mcp-http-base` package exposes a
   `TokenAuthority` interface (`mcp-token-authority` spec) with one
   implementation, `LocalRosterAuthority`, that wraps the v1 HMAC +
   JSON roster path. The planned `JwksAuthority` (Phase 1b of
   `external-token-authority-verification`) is not yet built; the
   `.agents.local.json` file shipped at
   `apps/mcp-readonly-sql/mcp-readonly-sql.agents.json` is the de
   facto authority.
2. Introduce a new app, `apps/mcp-oauth-admin`, that IS the authority:
   it issues OAuth2 tokens (authorization-code + client-credentials),
   persists agents/clients/scopes in SQLite, and exposes a web admin
   UI for CRUD on those rows. It speaks the same JWKS contract the
   `JwksAuthority` verifier on the resource side already expects.
3. Add a second `TokenAuthority` implementation,
   `OAuthAdminAuthority` (or extend `JwksAuthority` with a non-remote
   keyset option), that fetches keys from the admin app and validates
   the issued JWTs. The `mcp-readonly-sql` app's
   `loadHttpRuntimeConfig` picks this backend when the
   `MCP_AUTHORITY_URL` env points at the admin app.
4. Default scopes become minimum: a newly registered client gets
   `read:<own-profile>` for each profile it is bound to; the admin
   raises or lowers scopes from the UI. The static `MCP_AGENTS_JSON`
   / `MCP_AGENTS_INLINE` env vars are deprecated; the local HMAC
   roster is removed once Phase 4 ships.
5. Strict TDD, strict fail-closed, audit-safe 401/403/503 bodies, and
   the v1 constant-time HMAC guarantees on the local path are all
   preserved. New failure modes (admin DB locked, admin unreachable,
   admin TLS cert invalid) map to typed errors that the middleware
   already handles.

## Why now

The user already accepted that a separate authority is the right
shape (the `external-token-authority-verification` change ships the
resource-server-side seam). The remaining pain is on the authority
side: the v1 dev backend is a hand-edited JSON file, and the
planned JWKS backend needs an authority to exist. The user wants to
stop adding roster entries by hand, stop regenerating HMAC keyHashes,
stop restarting servers, and stop shipping tokens in `.env`-mounted
JSON files. A SQLite-backed authority with a web admin UI turns
"onboard a new agent" from a four-step per-MCP chore into one
operator action in a browser. State belongs in a database the admin
app owns, not in config files the operator hand-maintains.

## Current state

Verified facts about the codebase (this exploration re-reads the
post-Phase-1a state on `feat/external-token-authority-phase-1a`,
commit `9cc023c` on `main` after PR #1 merge):

- **Shared HTTP base** (`packages/mcp-http-base/`): ships the
  `TokenAuthority` interface, `VerifiedToken` type, and two typed
  errors (`TokenInvalidError`, `AuthorityUnavailableError`) in
  `src/authority/types.ts`. `LocalRosterAuthority` lives in
  `src/authority/localRoster.ts` and wraps the v1 `loadAgents` +
  `validateBearer` HMAC path with a defense-in-depth `SCOPE_PATTERN`
  filter. `JwksAuthority` does NOT exist yet — the
  `src/authority/jwks.ts` file is not present, and
  `index.ts` does not export a `JwksAuthority` symbol. Phase 1a
  shipped the seam; Phase 1b is the unbuilt follow-up.
- **Middleware** (`packages/mcp-http-base/src/server.ts`):
  `handleMcpRequest` calls `await authority.verify(token)` and maps
  `TokenInvalidError`→401, `AuthorityUnavailableError`→503, any
  other throw→503 (fail closed). The legacy `agents` + `hmacSecret`
  options on `HttpMcpServerOptions` are still accepted as back-compat
  inputs that build a `LocalRosterAuthority` internally via
  `resolveAuthority(...)`. The middleware keeps `auth.{clientId,
  scopes}` on the request object so tool handlers can enforce
  per-call scope checks (Phase 2 of the existing change).
- **App config glue** (`apps/mcp-readonly-sql/src/config/http.ts`):
  reads `MCP_AGENT_HMAC_SECRET`, `MCP_AGENTS_JSON`, and
  `MCP_AGENTS_INLINE`; builds an `AgentRecord[]`; returns a
  `HttpRuntimeConfig`. When `MCP_AUTHORITY_URL` is set (Phase 1b),
  the loader is expected to instantiate a `JwksAuthority` and call
  `warm()`. The branch is not coded yet — the current loader still
  always builds the local backend.
- **App transport** (`apps/mcp-readonly-sql/src/transports/http.ts`):
  threads `agents` and `hmacSecret` into the shared
  `createHttpMcpServer`. Will need to thread `authority` (the seam
  is already there per Phase 1a).
- **Spec / governance**:
  - `openspec/specs/mcp-agent-authorization/spec.md` (v1) defines
    the per-agent identity record, opaque-HMAC bearer, scope
    enforcement, and audit-safe error contract. v1 has a
    "OAuth2 flows, JWT signature verification, and any third-party
    identity provider integration are explicitly OUT of scope for
    v1" line that this change removes.
  - `openspec/changes/external-token-authority-verification/specs/`
    holds the four deltas shipped in Phase 1 (and queued for
    archive): `mcp-token-authority` (new), `mcp-agent-authorization`
    (modified), `mcp-tool-surface` (modified), `app-independence`
    (modified). The new `mcp-token-authority` spec is the
    resource-server side of the OAuth contract; the authority side
    is not yet specified.
  - `mcp-http-transport` "Port Allocation Convention": 3001 is taken
    by `mcp-readonly-sql`; the existing change reserves 3002 for
    the future authority MCP. The admin app will claim 3002.
  - `mcp-deployment-templates` spec: env-var lint, systemd unit,
    Dockerfile, nginx example, and runbook already exist for
    `mcp-readonly-sql`. The new admin app ships its own copy of
    each template.
- **Workspace shape**:
  - pnpm monorepo, `apps/*` and `packages/*`, strict TDD, vitest
    2.1, no ESLint/Prettier, no coverage tooling.
  - `pnpm --filter mcp-readonly-sql {test,build,typecheck}` is the
    canonical per-app command set; the new admin app gets the same
    shape.
  - Workspace root is non-deployable; apps are self-contained.
  - `@customized-mcps/mcp-http-base` v0.1.0 (post-Phase 1a) is the
    only shared package. It has zero `dependencies` apart from the
    MCP SDK; no `jose`, no SQLite driver.
- **Tool surface** (`openspec/specs/mcp-tool-surface/spec.md`):
  the five read-only SQL tools are documented; Phase 2 of the
  existing change is a per-tool `requiredScope` tag table. The new
  change does NOT touch tool surface, but it does affect how the
  `auth.scopes` array on a request is populated (admin-issued JWT
  vs. local roster) and that is the Phase 2 seam.
- **Audit-safe posture** (`mcp-agent-authorization` "Audit-Safe
  Error Responses"): 401/403/503 bodies MUST NOT include the token,
  agent id, keyHash, HMAC secret, list of valid agents, or list of
  valid scopes. The new admin app's own responses (login, token
  endpoint, admin UI API) are NOT covered by that spec — they have
  their own audit contract (no password in logs, no client_secret
  in error bodies, no admin session token echoed back).
- **Test surface** (measured from the
  `external-token-authority-verification` apply-progress):
  ~153 tests in `mcp-http-base` (post-Phase 1a), ~221 tests in
  `mcp-readonly-sql` (non-smoke), 4 smoke files (bypass, http,
  secrets, stdio). Strict TDD is enforced; every code task in the
  existing tasks.md has a paired vitest task.

## Affected areas

- **New app** `apps/mcp-oauth-admin/`
  - Manifest (`package.json`), wire entrypoint, server factory,
    tools (admin CRUD: list agents, create agent, rotate secret,
    grant/revoke scope, register OAuth client, introspect token,
    revoke token), env, tests, README.
  - SQLite schema migrations, query layer (use the same
    `knex` + `sqlite3` the `mcp-readonly-sql` app already
    pulls in, or add `better-sqlite3` if a synchronous driver is
    preferred; default to the existing `knex` + `sqlite3` to avoid
    a new transitive dep).
  - Web admin UI: lightweight server-rendered HTML (no SPA, no
    build step) or a minimal SPA that consumes JSON endpoints.
    The exploration prefers server-rendered HTML with progressive
    enhancement to keep deploy templates simple. The
    `mcp-deployment-templates` spec says "no JS build step in
    `apps/`"; the same rule should apply to the admin app.
  - OAuth endpoints: `/oauth/authorize`,
    `/oauth/token`, `/oauth/jwks.json`, `/oauth/introspect`
    (RFC 7662), `/oauth/revoke` (RFC 7009). The contract surface
    is owned by the `mcp-oauth-authority` spec the change
    introduces.
  - Admin API (separate from OAuth): `/admin/agents`,
    `/admin/clients`, `/admin/scopes`, with cookie-based session
    auth (the bootstrap admin's session is the only thing
    that can rotate an admin's own password).
  - Bootstrap admin: a `bootstrap_admin` env var
    (`MCP_OAUTH_BOOTSTRAP_ADMIN_USERNAME` /
    `MCP_OAUTH_BOOTSTRAP_ADMIN_PASSWORD`) seeds the first admin
    on first run; the password MUST be rotated on first login and
    the file MUST be deleted from the env (the app refuses to
    start with a non-rotated bootstrap password after the first
    successful login). The contract is "first-run migration
    risk" — the proposal locks the exact behavior.
  - Deploy templates: `deploy/systemd/mcp-oauth-admin.service`,
    `deploy/docker/Dockerfile` (multi-stage, same shape),
    `deploy/nginx/mcp-admin.conf` (TLS, same hardening), and
    `deploy/README.md` runbook sections for the admin app.
- **`packages/mcp-http-base/src/authority/jwks.ts`** (new file):
  builds on the planned `JwksAuthority`. The exploration assumes
  Phase 1b ships first as a prerequisite; if it is not yet
  available, the change pulls in the JWKS verifier inline (one
  file, ~150 LoC, mocked-fetch tests) so the OAuth path is not
  blocked.
- **`packages/mcp-http-base/src/authority/oauthAdmin.ts`** (new
  file): a `TokenAuthority` that pairs `JwksAuthority` with a
  startup `warm()` that ALSO calls `/oauth/introspect` against a
  self-issued probe token. The probe proves the admin app can mint
  and verify its own tokens; the spec names the failure mode
  (probe fails → fail-closed, exit non-zero at startup).
- **`packages/mcp-http-base/src/config.ts`**: adds
  `MCP_AUTHORITY_URL`, `MCP_AUTHORITY_JWKS_URL`,
  `MCP_AUTHORITY_AUDIENCE`, plus three optional knobs
  (`MCP_AUTHORITY_JWKS_TTL_S=60`,
  `MCP_AUTHORITY_LEEWAY_S=30`,
  `MCP_AUTHORITY_FETCH_TIMEOUT_MS=5000`). The current
  `HttpConfig` does not have these fields; the existing
  `mcp-token-authority` spec already lists them but no code
  consumes them yet. The change ships the env wiring and the
  parsing rules.
- **`apps/mcp-readonly-sql/src/config/http.ts`**: picks the
  authority backend from `MCP_AUTHORITY_URL`. When set, builds an
  `OAuthAdminAuthority` (or `JwksAuthority` directly if the admin
  app's JWKS URL is configured) and calls `warm()`; on probe
  failure, exits non-zero with a stderr message that names the
  authority's host + base path only.
- **`apps/mcp-readonly-sql/src/transports/http.ts`**: threads the
  `authority` instance into the shared `createHttpMcpServer`
  options (the seam already exists from Phase 1a).
- **`apps/mcp-readonly-sql/.env.example` and `apps/mcp-readonly-sql/.env`**: 
  - Document `MCP_AUTHORITY_URL`,
    `MCP_AUTHORITY_JWKS_URL`, `MCP_AUTHORITY_AUDIENCE` as the
    default.
  - Mark `MCP_AGENT_HMAC_SECRET`, `MCP_AGENTS_JSON`,
    `MCP_AGENTS_INLINE` as `MCP_AUTHORITY_URL unset` fallback
    (dev/offline only) and stamp a "DEPRECATED in oauth-sqlite-admin-authorization"
    banner.
- **`apps/mcp-readonly-sql/mcp-readonly-sql.agents.json`**: the
  committed JSON file is removed in Phase 4 (the final phase of
  this change). Until then it stays as the local-roster seed.
- **`apps/mcp-readonly-sql/test/{serverFactory,deployTemplates,
  monorepoStructure,serverFactory,profiles,sqlGuard,
  describeSchema}.test.ts`**: tests that read
  `mcp-readonly-sql.agents.json` directly get a fixture
  migration; tests that assert on `MCP_AGENT_HMAC_SECRET` get
  re-pointed at the new env vars.
- **`openspec/specs/mcp-agent-authorization/spec.md`**: MODIFIED —
  replace the v1-only roster assumption with the
  `TokenAuthority` abstraction (already done by the previous
  change in `external-token-authority-verification/specs/...`);
  add a `Minimum-Default-Scopes` REQUIREMENT that says the
  default scope on a newly registered OAuth client is
  `read:<bound-profile>` per profile, with no `*` wildcard
  without explicit admin action.
- **New spec** `openspec/specs/mcp-oauth-authority/spec.md`:
  authority-side contract — OAuth2 endpoints, SQLite schema,
  bootstrap admin flow, JWKS format, scope grammar
  (re-uses `SCOPE_PATTERN`), token TTLs, refresh flow,
  revocation semantics, audit contract for admin actions.
- **New spec** `openspec/specs/mcp-admin-ui/spec.md`: web admin
  UI contract — login, agent CRUD, client CRUD, scope
  assignment, audit log viewer, password rotation, session
  lifecycle. Server-rendered HTML with progressive
  enhancement; no JS build step in the workspace.
- **New spec** `openspec/specs/mcp-authority-storage/spec.md`:
  SQLite schema, migrations, row-level access policy (admin-only
  writes; tool handlers never read this DB), backup story
  (file copy is enough; WAL is the journal mode), and the
  multi-process constraint (SQLite + many readers is fine; many
  writers is single-writer — the admin app is the only writer).
- **`openspec/specs/app-independence/spec.md`**: append a
  "Authority isolation" requirement — the admin app is a
  sibling MCP that the resource-server apps depend on at
  runtime, but the resource-server apps MUST NOT import the
  admin app's source, build artifact, or DB schema. They only
  consume the OAuth + JWKS contract.
- **`openspec/specs/mcp-http-transport/spec.md`**: bump the
  Port Allocation Convention from "future authority MCP" to
  "the authority MCP is `mcp-oauth-admin` on port 3002". The
  `mcp-deployment-templates` for the admin app follow the same
  shape.
- **`openspec/specs/mcp-deployment-templates/spec.md`**: the
  existing single-app shape becomes a multi-app shape — the
  templates are per-app (a `deploy/<app>/` directory), the
  runbook (`deploy/README.md`) is an index that links to a
  per-app runbook. The lint test that greps
  `apps/<one-app>/.env.example` is updated to iterate over
  every deployed app.
- **`deploy/README.md`**: a top-level index that links to
  `deploy/mcp-readonly-sql/README.md` and
  `deploy/mcp-oauth-admin/README.md`. The port table,
  TLS termination section, and roll-back section get per-app
  sub-headings.
- **`.github/` or CI** (if present): the `deployTemplates.test.ts`
  env-var lint runs for every app; the smoke test that greps
  the runbook for secrets runs per runbook. The change updates
  the test fixtures to scan both apps.
- **`.agents.local.json`** is no longer committed at
  `apps/mcp-readonly-sql/mcp-readonly-sql.agents.json` in Phase
  4; the file is moved to a private ops-only path or
  removed entirely (preferred: remove + rely on the admin
  app).

## Architecture Recommendation

The user-supplied recommendation is the right one. Concretely:

1. **One Authorization Server / admin authority backed by
   SQLite.** A new sibling app, `apps/mcp-oauth-admin`, owns
   the SQLite DB (`./data/mcp-oauth.sqlite` by default;
   configurable via `MCP_OAUTH_DB_PATH`). SQLite is the
   right choice: the workload is operator-driven CRUD with
   low concurrency (admin web UI is the only writer; tool
   handlers never touch this DB; one process is enough for
   the v1 deployment shape). Multi-writer scaling is a
   future change that swaps SQLite for Postgres without
   changing the OAuth contract.
2. **MCP apps act as Resource Servers.** `mcp-readonly-sql`
   (and any future resource-server app) becomes a pure
   resource server: it validates OAuth access tokens + scopes
   against the admin app's JWKS, attaches the resolved
   `agentId` + `scopes` to the request, and never owns the
   agent roster. The middleware seam is already in place
   from Phase 1a; the change plugs in an `OAuthAdminAuthority`
   implementation that wraps the planned `JwksAuthority` and
   adds a startup self-probe.
3. **Admin UI and scope DB live outside individual MCP apps.**
   `mcp-oauth-admin` is its own app, its own port (3002), its
   own systemd unit, its own reverse-proxy config, its own
   runbook. Resource-server apps do not import from it; they
   only know its URL. The SQLite file lives next to the admin
   app's `dist/`, not in any resource-server app's directory.
4. **Default agents/clients get minimum scopes.** When an
   admin creates a new OAuth client in the UI, the default
   scope set is `read:<bound-profile>` for each profile the
   client is bound to, with NO `*` wildcard. The
   `MCPOAuthAdminClientService.create()` method rejects an
   empty scope list and an unscoped `*` wildcard. Elevation
   is an explicit admin action in the UI ("Grant
   `list:*`") and is audit-logged. The audit log row
   captures `actorAdminId`, `targetClientId`, `scopeAdded`,
   `scopeRemoved`, `at`, and a SHA-256 of the actor's session
   token prefix (never the full token).
5. **Bootstrap admin and first-run migration risk.** A
   single bootstrap admin is seeded from
   `MCP_OAUTH_BOOTSTRAP_ADMIN_USERNAME` /
   `MCP_OAUTH_BOOTSTRAP_ADMIN_PASSWORD` on first run. The
   bootstrap credentials are `require-change-on-first-login`
   — the admin app refuses to mint tokens for the bootstrap
   admin until the password is rotated, and a `WARN` line
   is logged on every startup that the bootstrap env is set
   (so the operator sees the migration risk at deploy time).
   Once the password is rotated, the env vars can be removed
   from the env file. The change ships a
   `tests/migration.test.ts` that simulates a fresh
   SQLite file → bootstrap admin seeded → password rotated
   → env vars removed → app restarts → tokens minted →
   resource server validates a token.

The five bullets above are the recommendation. The exploration
locks the seams and proposes the phases below; the proposal
must confirm before any code lands.

## Approach comparison

| # | Approach | Pros | Cons | Effort |
|---|----------|------|------|--------|
| 1 | **OAuth2 + SQLite + admin UI (the recommended path).** New app `mcp-oauth-admin`; SQLite-backed; server-rendered admin UI; resource-server apps use the planned `JwksAuthority` plus a self-probe. | Standard OAuth2 contract; SQLite is enough for the workload; one source of truth; admin UI is a real tool; the `mcp-token-authority` spec already defines the resource side; the planned `JwksAuthority` is the only new code on the resource side. | New app to operate (systemd unit, Dockerfile, nginx config, runbook, password rotation, DB backup, admin session lifecycle); OWASP-style threats to think through (CSRF, session fixation, password hashing, brute-force protection, password-reset flow); spec gets longer. | High (new app, new spec, JWKS verifier on resource side, deploy templates, audit log). |
| 2 | **Same shape, but use Postgres instead of SQLite.** | Multi-writer is free; existing `pg` driver in `mcp-readonly-sql`; backups via `pg_dump`. | New infra dependency (Postgres server); the workload doesn't justify it; v1 is one admin process and a handful of resource-server processes, so SQLite is enough. | High (same as 1 plus a Postgres instance to operate). |
| 3 | **Keep the local HMAC roster, add a tiny admin web app on top.** No OAuth; the admin app just writes the JSON files. | Smallest delta; no JWKS work; no new spec. | Doesn't actually remove the JSON-roster problem (just moves the writer); no token rotation; no revocation; no real OAuth semantics. Doesn't meet the user's "implement OAuth" intent. | Medium-Low. |
| 4 | **OAuth2 with an external SaaS (e.g., Auth0, Keycloak).** | Industry-standard IdP; no SQLite; no admin UI to build. | External dependency; new vendor surface; keys and clients live outside the repo; the user's framing (one authority, in this repo) doesn't fit. | High (vendor integration). |

### Recommended: Approach 1 (SQLite + admin UI).

The user explicitly asked for OAuth + SQLite + admin UI. Approach 1
is the literal expression of that, scoped to the v1 deployment
shape (single admin process, a handful of resource servers,
operator-driven CRUD). The other approaches are recorded for
completeness but do not match the user's intent.

The risk surface (CSRF, session fixation, brute force, audit log
retention, password hashing, bootstrap rotation) is the dominant
workload. The design phase (sdd-design) MUST produce a threat
model and pick a session strategy (signed-cookie session with
`SameSite=Strict` + `Secure` is the recommended default; a small
session table in SQLite is fine; no Redis in v1). The deploy
phase MUST ship a runbook section that names the rotation,
backup, and incident-response procedures.

### Sketch of the seam (not final)

```ts
// apps/mcp-oauth-admin/src/authority/db.ts
export type AgentRow = {
  id: string;            // stable, opaque
  display_name: string;
  created_at: string;    // ISO-8601
  disabled_at: string | null;
};
export type ClientRow = {
  id: string;            // public client_id
  hashed_secret: string; // argon2id, never plaintext
  agent_id: string;      // FK to AgentRow
  scopes: string[];      // SCOPE_PATTERN-validated
  created_at: string;
  rotated_at: string;
  disabled_at: string | null;
};

// apps/mcp-oauth-admin/src/oauth/token.ts
// RFC 6749 token endpoint. mints RS256 JWTs, scope claim = granted,
// aud claim = MCP_AUTHORITY_AUDIENCE, exp = now + MCP_OAUTH_TTL_S (default 3600).
// Returns { access_token, token_type: "Bearer", expires_in, scope }.

// apps/mcp-oauth-admin/src/oauth/jwks.ts
// RFC 7517 JWKS endpoint. serves the admin's current public key set
// (rotated keys kept for `MCP_OAUTH_KID_RETENTION_S` to avoid race with
// in-flight tokens; old keys dropped after retention window).

// packages/mcp-http-base/src/authority/oauthAdmin.ts
export class OAuthAdminAuthority implements TokenAuthority {
  constructor(opts: { issuer: string; jwksUrl: string; audience: string; ttlSeconds?: number; leewaySeconds?: number; fetchTimeoutMs?: number; logger: Logger; }) { ... }
  async verify(token: string): Promise<VerifiedToken> {
    // delegates to jose.jwtVerify with the issuer's JWKS, validates
    // iss/aud/exp/nbf, maps the JWT's `scope` claim to the v1
    // SCOPE_PATTERN-filtered string[].
  }
  async warm(): Promise<void> {
    // calls /oauth/introspect on a self-issued probe token. probe
    // failure → throw AuthorityUnavailableError; the app's
    // loadHttpRuntimeConfig maps that to a non-zero exit.
  }
}
```

The middleware in `server.ts` does not change (the
`TokenAuthority` interface is the seam). The app config loader
picks `OAuthAdminAuthority` when `MCP_AUTHORITY_URL` is set; the
legacy `agents` + `hmacSecret` fields are still accepted for
back-compat (the previous change's contract).

## Product constraints (recap from the user)

- **Replace static bearer-token / local JSON roster.** The
  `MCP_AGENTS_JSON` / `MCP_AGENTS_INLINE` env vars and the
  `mcp-readonly-sql.agents.json` file are deprecated at the
  end of this change.
- **Remove manual JSON entries and unnecessary hot reload.**
  No more editing JSON, no more HMAC rehash, no more
  process restart. The admin UI is the single onboarding
  surface.
- **Assign minimum scopes by default.** A new OAuth client
  gets `read:<bound-profile>` per profile, never `*`. Wildcard
  elevation is an explicit admin action and is audit-logged.
- **Expose a web admin application to modify scopes.** The
  admin app is a real web UI; login, agent CRUD, client CRUD,
  scope assignment, audit log viewer, password rotation.
- **Manage state in SQLite instead of config files.** One
  SQLite file in the admin app's data dir; WAL mode; a
  documented backup procedure (file copy is enough).
- **Phased refactor.** The work is split into 5-6 small
  phases (see the "Proposed Phases" section) so each phase
  ships in its own session / PR and the repo keeps a green
  build at the end of every phase.

## OpenSpec placement

- **New domain** `mcp-oauth-authority`: authority-side contract
  — OAuth2 endpoints, SQLite schema, bootstrap admin flow,
  JWKS format, scope grammar (re-uses `SCOPE_PATTERN` from
  `mcp-agent-authorization`), token TTLs, refresh, revocation,
  audit contract.
- **New domain** `mcp-admin-ui`: web admin UI contract —
  login, agent CRUD, client CRUD, scope assignment, audit log
  viewer, password rotation, session lifecycle, CSRF
  protection.
- **New domain** `mcp-authority-storage`: SQLite schema,
  migrations, row-level access policy, backup story, the
  multi-process constraint (admin is the only writer; reads
  are tool-handler-free).
- **MODIFIED** `mcp-agent-authorization`: add a
  "Minimum-Default-Scopes" REQUIREMENT, add a
  "OAuth Resource Server" REQUIREMENT (the resource side
  validates JWTs from the authority, not opaque tokens; the
  audit-safe 401/403/503 contract is preserved), remove the
  v1 "OAuth2 / JWT out of scope" line. The opaque-HMAC path
  stays as the dev/offline fallback until Phase 4.
- **MODIFIED** `mcp-tool-surface`: add a per-tool
  `requiredScope` table (Phase 2 of the existing change
  ship-now; the new change does not own it).
- **MODIFIED** `app-independence`: add an "Authority
  isolation" REQUIREMENT (the admin app is a sibling MCP
  the resource servers depend on at runtime, but resource
  servers MUST NOT import the admin app's source, build
  artifact, or DB schema).
- **MODIFIED** `mcp-http-transport`: bump the Port
  Allocation Convention from "future authority" to
  "mcp-oauth-admin is the authority, default port 3002".
- **MODIFIED** `mcp-deployment-templates`: the existing
  per-app shape becomes multi-app (a `deploy/<app>/`
  directory per app; a `deploy/README.md` index that links
  to per-app runbooks; the env-var lint scans every
  deployed app).

## Proposed phases (small enough for separate sessions / PRs)

The user explicitly asked for a phased refactor so the project
does not need to be completed in one session. Each phase ends
in a green build, a mergeable PR, and a running system. Phases
2-5 may be combined if a session has time; the strict TDD
budget per phase is the 1200-line review cap this change
sets.

### Phase 0 — Prerequisite: ship `JwksAuthority` (Phase 1b of the existing change)

- Land the planned `JwksAuthority` from the
  `external-token-authority-verification` change first. This
  is the resource-server-side seam the new authority plugs
  into.
- Why first: every later phase assumes the resource server
  can verify a JWT against a remote JWKS. Without it, the
  admin app's tokens are unverifiable and the system
  regresses to the local-roster path.
- Estimated changed lines: ~400-600 (the existing Phase 1b
  forecast).
- Test command: `pnpm --filter @customized-mcps/mcp-http-base
  test` plus a new `test/authority/jwks.test.ts` with
  mocked fetch.

### Phase 1 — SQLite schema + DB layer (no HTTP, no auth)

- New package `apps/mcp-oauth-admin/src/db/schema.ts` (the
  initial migration: `agents`, `clients`, `client_scopes`,
  `admin_users`, `admin_sessions`, `audit_log`).
- New package `apps/mcp-oauth-admin/src/db/queries.ts` (pure
  query layer; the only writer; transactional helpers).
- New tests under `apps/mcp-oauth-admin/test/db/` (vitest;
  one in-memory SQLite per test; assertions on the row
  shapes, unique constraints, cascade behavior).
- The schema migration is the unit of work; the test
  command is `pnpm --filter mcp-oauth-admin test`. No HTTP
  wiring yet. The change ships the SQLite file in
  `./data/mcp-oauth.sqlite` and the new app's
  `.gitignore` excludes it.
- Estimated changed lines: ~500-700 (schema + queries +
  tests + the new app skeleton: `package.json`,
  `tsconfig.json`, `vitest.config.ts`, the workspace
  `pnpm-workspace.yaml` does not need to change because
  `apps/*` is already a glob).

### Phase 2 — OAuth2 endpoints (token, jwks, introspect, revoke)

- New endpoints in `apps/mcp-oauth-admin/src/oauth/`:
  - `/oauth/token` (client_credentials + refresh_token;
    RFC 6749 §4.4 + §6).
  - `/oauth/jwks.json` (RFC 7517).
  - `/oauth/introspect` (RFC 7662).
  - `/oauth/revoke` (RFC 7009).
  - `/oauth/authorize` + `/oauth/login` (authorization_code
    for human-in-the-loop flows; the first cut is
    client_credentials only and Phase 2 ships the same
    minimum-viable shape; `authorize` is a Phase 5 follow-up
    if the user wants browser-based flows).
- JWT mint: RS256, key rotation, `kid` claim,
  `iss` = `MCP_OAUTH_ISSUER` (default
  `MCP_AUTHORITY_URL`), `aud` = the audience the resource
  server declares (`MCP_AUTHORITY_AUDIENCE`), `exp` =
  `now + MCP_OAUTH_TTL_S` (default 3600), `scope` =
  space-separated per RFC 8693.
- The authority's public key is the JWKS; the resource
  server's `JwksAuthority` consumes it. End-to-end test:
  the resource server mints a probe token, the admin app
  introspects it, the resource server validates the
  introspected shape.
- Estimated changed lines: ~800-1100 (the new endpoints +
  the key-rotation + the cross-process integration test).
  Likely crosses the 1200-line cap; split at the
  "token endpoint" boundary if so.

### Phase 3 — Admin web UI (login, agent CRUD, client CRUD, scope assignment, audit log)

- Server-rendered HTML (no JS build step) using the same
  `node:http` server pattern the shared base already uses.
  Progressive enhancement: a tiny inline script handles
  form submit, but the page works without JS.
- Routes: `GET /admin/login`, `POST /admin/login`,
  `GET /admin/logout`, `GET /admin/agents`,
  `POST /admin/agents`, `POST /admin/agents/:id/rotate-secret`,
  `POST /admin/agents/:id/disable`, `GET /admin/clients`,
  `POST /admin/clients`, `POST /admin/clients/:id/scopes`,
  `GET /admin/audit`.
- Session: signed cookie (`SameSite=Strict; Secure;
  HttpOnly`) backed by a `admin_sessions` row; the cookie
  payload is the session id only. The session id is a
  CSPRNG-generated 256-bit value, base64url encoded.
- Password hashing: argon2id
  (`MCP_OAUTH_ARGON2_TIME_COST=3`,
  `MCP_OAUTH_ARGON2_MEMORY_KIB=65536`,
  `MCP_OAUTH_ARGON2_PARALLELISM=4`; tunable per hardware).
- Brute-force protection: per-username exponential
  backoff (1s, 2s, 4s, 8s, 16s, locked after 10 failures
  for 1 hour).
- CSRF: per-form double-submit token backed by the
  session.
- Estimated changed lines: ~1000-1400 (a non-trivial
  amount of HTML + handler code). Almost certainly
  crosses the 1200-line cap; split at the
  "agent CRUD vs client CRUD" boundary.

### Phase 4 — Migrate `mcp-readonly-sql` to OAuth; remove local roster

- Add `MCP_AUTHORITY_URL` to the default
  `.env.example`. Mark `MCP_AGENT_HMAC_SECRET`,
  `MCP_AGENTS_JSON`, `MCP_AGENTS_INLINE` as DEPRECATED.
- `loadHttpRuntimeConfig` builds an `OAuthAdminAuthority`
  when `MCP_AUTHORITY_URL` is set. `warm()` runs at startup;
  probe failure → non-zero exit.
- Tests that read `mcp-readonly-sql.agents.json` directly
  get a fixture migration; tests that assert on
  `MCP_AGENT_HMAC_SECRET` get re-pointed at the new env
  vars.
- Estimated changed lines: ~300-500 (config + tests +
  fixtures).

### Phase 5 — Remove the local roster; enforce minimum-default-scopes policy

- Delete `LocalRosterAuthority` (or keep it as a test
  helper but not exported). Delete
  `apps/mcp-readonly-sql/mcp-readonly-sql.agents.json`.
  Update the middleware so the `agents` + `hmacSecret`
  options on `HttpMcpServerOptions` are gone (the seam
  collapses to `authority` only).
- The audit log on the admin app records the
  migration: which agents existed in the local roster
  at the cutover time, which were migrated, which were
  dropped.
- Estimated changed lines: ~200-400 (the deletion +
  the migration script + the audit-log backfill).

### Phase 6 (optional) — Authorization-code flow for browser-based clients

- Add `/oauth/authorize` + `/oauth/login` for the
  authorization_code grant (RFC 6749 §4.1). PKCE
  (RFC 7636) is required for public clients. This is
  the path a future web-based agent UI would use.
- Skip this phase unless the user asks for it; the
  client_credentials grant covers the current
  MCP-host use case.

The strict-TDD budget per phase: 1200 changed lines, with
`auto-forecast` chained PRs when the forecast says so. Phase 2
and Phase 3 are the highest-risk phases; the `sdd-tasks`
forecaster will probably split them at the seams named above.

## Open questions (for the proposal, not blockers)

- **Bootstrap admin password storage.** The env-var path
  (`MCP_OAUTH_BOOTSTRAP_ADMIN_PASSWORD`) is the simplest
  but means the password lives in the env file until the
  admin rotates it. Alternative: a one-time password
  printed to the operator's console on first start (the
  app refuses to start without the operator acknowledging
  it). The proposal should confirm.
- **Resource-server audience.** `MCP_AUTHORITY_AUDIENCE` —
  is one audience string enough, or does each resource
  server need its own (e.g. `mcp-readonly-sql` vs
  `mcp-write-audit`)? The proposal should pick one. The
  exploration assumes one audience per authority (the
  default `mcp-readonly-sql`); per-app audience is a
  Phase 6 follow-up.
- **Token revocation strategy.** JWTs are stateless; the
  admin app's `revoke` endpoint has to push the revoked
  `jti` into a deny-list the resource server checks on
  every verify. The latency tradeoff is real. The
  proposal should pick: short TTLs + no deny list (the
  default) vs. deny list with a TTL (RFC 7009 is the
  spec). The exploration assumes short TTLs (default
  3600s) for Phase 2; deny list is a Phase 6 follow-up.
- **Token endpoint auth for the resource server itself.**
  Phase 2 needs the resource server to authenticate to
  the admin's `/oauth/token` endpoint with its own
  client_id + client_secret. Where do those live? The
  proposal should confirm: `MCP_OAUTH_RESOURCE_CLIENT_ID` /
  `MCP_OAUTH_RESOURCE_CLIENT_SECRET` in the resource
  server's `.env` is the simplest path; mutual TLS is
  overkill for v1.
- **Audit log retention.** The audit log grows; an
  operator-driven prune job is needed. The proposal
  should pick a default (90 days) and document the
  operator procedure.
- **CSRF strategy for the admin UI.** Per-form
  double-submit tokens are the simplest. Origin / Referer
  checks are an alternative. The proposal should pick
  one; the exploration assumes double-submit tokens.
- **Where does the admin app's SQLite file live in
  production?** The current
  `apps/mcp-readonly-sql/data/` pattern is per-app.
  The proposal should confirm: `./data/mcp-oauth.sqlite`
  relative to the admin app's working directory is the
  default; an absolute path via `MCP_OAUTH_DB_PATH` is
  the override.
- **Phase 0 dependency.** Phase 1b of
  `external-token-authority-verification` is the
  prerequisite. If it is not yet merged when this change
  starts, the change ships a tiny inline `JwksAuthority`
  in Phase 2 (one file, ~150 LoC) and replaces it with
  the imported one in a follow-up commit. The proposal
  should confirm the dependency order.

## Risks

- **Authority as a hard dependency** (LIKELIHOOD MED). When
  `MCP_AUTHORITY_URL` is set, every resource server fails
  to start if the admin app is unreachable. The
  `warm()` probe mitigates this at startup; the
  in-flight `AuthorityUnavailableError` → 503 mapping
  mitigates this during operation. The local roster
  stays as the dev/offline fallback until Phase 5.
- **Bootstrap admin compromise** (LOW). The first
  account is the highest-value target. Mitigations:
  require password rotation on first login; refuse to
  mint tokens for the bootstrap admin until the password
  is rotated; log a `WARN` on every startup that the
  bootstrap env is set; the `MCP_OAUTH_BOOTSTRAP_ADMIN_*`
  env vars MUST be removed from the env file after
  rotation. The `tests/migration.test.ts` simulates the
  whole path.
- **CSRF / session fixation** (MED for the admin UI). The
  session is a signed cookie; the session id is a
  CSPRNG; the cookie is `SameSite=Strict; Secure;
  HttpOnly`; per-form double-submit CSRF tokens. Threat
  model is in the design phase.
- **Brute force on the admin login** (MED). Per-username
  exponential backoff + lockout. The lockout is
  observable in the audit log; an operator can unlock
  via the SQLite CLI or a future `/admin/unlock` route.
- **SQLite as a single-writer bottleneck** (LOW for the
  v1 workload). The admin app is the only writer; reads
  are tool-handler-free. WAL mode lets one writer
  coexist with many readers; a future multi-admin UI
  swap to Postgres is a Phase 6 follow-up.
- **JWT `kid` rotation race** (LOW). A token issued
  just before a key rotation may reference a `kid` the
  resource server no longer trusts. Mitigations: the
  authority keeps rotated keys for
  `MCP_OAUTH_KID_RETENTION_S` (default 7 days); the
  resource server caches JWKS for
  `MCP_AUTHORITY_JWKS_TTL_S` (default 60s) and refetches
  on `kid` miss once. Same pattern as the planned
  `JwksAuthority` from the previous change.
- **Phase 0 / Phase 1b coupling** (MED). This change
  depends on `JwksAuthority` being merged first. If the
  dependency order slips, the change ships a thin inline
  verifier in Phase 2 and replaces it in a follow-up
  commit. The proposal must lock the order.
- **Phase budget (1200 lines)** (HIGH for Phase 2 and
  Phase 3). Both phases are likely to need chained PRs.
  The forecast step in `sdd-tasks` decides; the
  recommended split points are named above.
- **Audit log retention** (LOW for v1). The audit log
  grows; an operator-driven prune is the v1 answer; a
  real retention policy is a Phase 6 follow-up.
- **Spec preempts the admin UI's design** (LOW). The
  new `mcp-admin-ui` spec is the contract; the
  implementation is a follow-up. The same posture as
  `mcp-token-authority` for the resource side.
- **Token revocation freshness** (LOW for v1). JWTs
  are stateless; a revoked token is still valid until
  it expires. Short TTLs (default 3600s) bound the
  blast radius. A real deny list is a Phase 6 follow-up
  (see open question above).

## Ready for proposal

**Yes, with a clear handoff to the user.** The exploration
answers the core question: ship a SQLite-backed OAuth2
admin app as a new sibling MCP, plug the resource servers
into its JWKS via the planned `JwksAuthority`, expose a
web admin UI for agent/client/scope CRUD, default to
minimum scopes, and split the work into 5-6 small phases
so each one ships in its own session / PR. The next phase
(`sdd-propose`) MUST resolve the open questions above
(bootstrap password storage, resource-server audience,
token revocation strategy, resource-server token-endpoint
auth, audit log retention, CSRF strategy, SQLite path,
Phase 0 dependency order) before locking the spec for
`mcp-oauth-authority`, `mcp-admin-ui`, and
`mcp-authority-storage`.

Suggested next steps:

- `sdd-propose` — write `proposal.md` with intent,
  scope, approach (new app `mcp-oauth-admin` + SQLite +
  admin UI; resource servers use the planned
  `JwksAuthority` via a new `OAuthAdminAuthority`
  wrapper), affected areas (above), a clear "out of
  scope: Phase 6 authorization-code flow unless the
  user asks for it" line, and a phased rollout
  matching the "Proposed phases" section.
- `sdd-spec` — write three new domain specs
  (`mcp-oauth-authority`, `mcp-admin-ui`,
  `mcp-authority-storage`) and the four deltas to the
  existing specs (`mcp-agent-authorization`,
  `mcp-tool-surface`, `app-independence`,
  `mcp-http-transport`, `mcp-deployment-templates`).
  The Phase 0 dependency on
  `external-token-authority-verification` Phase 1b
  should be called out in each spec's Purpose section.
- `sdd-design` — design the `OAuthAdminAuthority`
  wrapper, the SQLite schema, the OAuth endpoints,
  the admin UI threat model, the bootstrap admin
  flow, the key-rotation strategy, the session
  lifecycle, the audit-log shape, the deploy
  templates for the new app, the per-app runbook
  shape, the env-var lint update for the multi-app
  case.
- `sdd-tasks` — forecast each phase against the
  1200-line review cap; chained PRs recommended
  for Phase 2 and Phase 3; the chain strategy is
  the same `stacked-to-main` pattern the previous
  change used. Each phase ends in a green build and
  a mergeable PR.
- `sdd-apply` — Strict TDD. Phase 1 first (DB layer,
  no HTTP, no auth). Phase 2 next (OAuth endpoints,
  end-to-end probe). Phase 3 next (admin UI).
  Phase 4 next (resource-server migration). Phase
  5 last (local-roster removal). The
  `sdd-archive` step at the end of each phase
  syncs the delta specs into the main specs; the
  open archive of `external-token-authority-verification`
  and the new change's archive are merged in the
  same commit.
- `sdd-verify` — confirm every phase's vitest suite
  is green, typecheck is clean, the deploy-template
  lint passes, the secret-grep test passes, and
  the new env-var lint scans every deployed app.
- `sdd-archive` — sync the deltas into the main
  specs (`mcp-agent-authorization`,
  `mcp-tool-surface`, `app-independence`,
  `mcp-http-transport`, `mcp-deployment-templates`)
  AND add the three new domains
  (`mcp-oauth-authority`, `mcp-admin-ui`,
  `mcp-authority-storage`).
