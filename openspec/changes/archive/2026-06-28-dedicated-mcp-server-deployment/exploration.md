# Exploration: dedicated-mcp-server-deployment

> Outcome-oriented. Make the MCP reachable on a dedicated server so several
> agents can share one process, and make the same deployment model reusable
> for every future MCP in this monorepo. Stdio stays supported for local
> desktop clients.

## Quick path

1. Add a **Streamable HTTP transport** to `apps/mcp-readonly-sql` alongside the
   existing `StdioServerTransport`. Transport is selected by env
   (`MCP_TRANSPORT=streamableHttp|stdio`, default `stdio`).
2. Extract the HTTP glue into a new shared workspace package
   `packages/mcp-http-base/` (transport setup, bearer-token auth, request
   logger, `/healthz`, graceful shutdown). Add `packages/*` to
   `pnpm-workspace.yaml`.
3. Keep app-independence intact: each app owns its tool set and config; the
   base package is an opt-in dependency.
4. Authenticate every HTTP request with a bearer token (header
   `Authorization: Bearer <MCP_HTTP_BEARER_TOKEN>`); reject the request
   before it reaches the MCP transport. TLS is terminated upstream
   (reverse proxy).
5. Stdio transport, read-only safety contract, the five tools, the
   `ProfileSummary` shape, and the `mcp-tool-surface` "Launch Path"
   requirement (stdios entrypoint) are unchanged.
6. Add new domain spec `mcp-http-transport` describing the HTTP contract;
   extend `app-independence` with a "transport pluggability" clause.
7. Defer Dockerfile / systemd / nginx configs to a follow-up change so
   this PR stays reviewable. Provide a one-paragraph reverse-proxy
   example in the app README.

## Why now

The user will develop a series of MCPs in this workspace and wants each
one deployable on a dedicated server with multiple agents sharing one
process. The current `StdioServerTransport` requires one child process
per agent (Claude Desktop, Cursor, etc.). That works for local desktop
hosts but does not satisfy the new requirement, and it forces every
agent host to have direct network reach to the database servers. A
single long-lived HTTP server per MCP app is the right shape.

## Current state

Verified facts about the codebase:

- **App layout**: `apps/mcp-readonly-sql/` is the only deployable app.
  It is a TypeScript ESM package (`type: "module"`, Node `>=20`),
  `bin: mcp-readonly-sql -> dist/index.js`.
- **Entrypoint** (`apps/mcp-readonly-sql/src/index.ts`, 61 lines): one
  `runServer()` that loads `.env`, builds profiles, builds
  `ConnectionManager`, builds one `McpServer`, registers five read-only
  tools, and connects via `new StdioServerTransport()` from
  `@modelcontextprotocol/sdk/server/stdio.js`. Logging goes to stderr.
- **Tool registration** is decoupled from transport: the
  `registerReadOnlyTools(server, { profiles, limits, connections })`
  function in `src/tools/readonlyTools.ts` is transport-agnostic and
  only depends on the `McpServer` instance. Reuse is straightforward.
- **Reusable safety machinery**: `sqlGuard`, `sanitizeError`,
  `knexFactory`, `profiles`, `resultNormalizer`, `SecretProvider` are
  all pure modules with no transport coupling.
- **SDK**: `@modelcontextprotocol/sdk@^1.29.0`. The SDK exposes
  `NodeStreamableHTTPServerTransport` (in
  `@modelcontextprotocol/sdk/server/streamableHttp.js`) and a
  `StreamableHTTPClientTransport` on the client side. The SDK's own
  docs (verified via Context7) show it pairing with `node:http` or
  `express` and configuring `sessionIdGenerator` for stateful sessions
  or `undefined` for stateless.
- **Workspace scaffold**: pnpm + uv monorepo, root is non-deployable,
  `apps/<app>/` is the deployable unit, no cross-app imports. This is
  the post-`monorepo-mcp-workspace` state.
- **OpenSpec specs in place**: `app-independence`, `mcp-tool-surface`
  (defines stdio launch path), `monorepo-workspace`, `profiles`.
- **Repo state**: local-only, 3 commits, no git remote, working tree
  clean. Strict TDD, vitest 2.1, no integration/E2E, no coverage tool
  wired.

## Affected areas

These files / paths will move or change when this change is applied.

- `apps/mcp-readonly-sql/src/index.ts` — split into
  `runStdio()` / `runHttp()`; add a tiny dispatcher keyed on
  `MCP_TRANSPORT`. Keep all five tool registrations, profile loading,
  and `ConnectionManager` setup unchanged.
- `apps/mcp-readonly-sql/src/httpServer.ts` (new) — wire
  `NodeStreamableHTTPServerTransport` to a Node `http.Server`, apply
  bearer-token middleware, expose `GET /healthz`, handle graceful
  shutdown. Reuses the same `McpServer` factory.
- `apps/mcp-readonly-sql/src/config/env.ts` — add reads for
  `MCP_TRANSPORT`, `MCP_HTTP_PORT`, `MCP_HTTP_HOST`,
  `MCP_HTTP_PATH`, `MCP_HTTP_BEARER_TOKEN`, `MCP_HTTP_STATELESS`,
  `MCP_HTTP_REQUIRED_SCOPE`, `MCP_LOG_FORMAT`.
- `apps/mcp-readonly-sql/test/` — new tests:
  `transportSelection.test.ts` (env-driven dispatch),
  `httpAuth.test.ts` (bearer allow/deny, missing header, malformed
  token), `httpSession.test.ts` (stateful vs stateless behavior).
- `apps/mcp-readonly-sql/package.json` — add `start:http` script;
  ensure the SDK already lists the Streamable HTTP transport
  (it does; no new runtime deps).
- `apps/mcp-readonly-sql/README.md` — new "HTTP transport" section
  documenting the env vars, a one-paragraph reverse-proxy example
  (nginx or Caddy), and the auth contract.
- `apps/mcp-readonly-sql/.env.example` — add the new env vars with
  sane defaults (`MCP_TRANSPORT=stdio`).
- `packages/mcp-http-base/` (new) — small workspace package
  exporting `createHttpMcpServer({ serverFactory, port, path,
  bearerToken, stateless, logger, health })`. Owns auth middleware,
  request logging, `/healthz`, and shutdown hooks.
- `pnpm-workspace.yaml` — add `packages/*` next to `apps/*`.
- `tsconfig.base.json` — no change (new package extends it).
- `openspec/config.yaml` — `apply.test_command` / `verify.*` may need
  to also target the new package if it ships unit tests; no change
  otherwise.
- `openspec/specs/mcp-tool-surface/spec.md` — keep the stdio
  "Launch Path" requirement; add a pointer that HTTP is covered by
  `mcp-http-transport`.
- `openspec/specs/mcp-http-transport/spec.md` (new) — define the
  HTTP contract: endpoint path, methods, auth header, session mode,
  env vars, error contract (401 missing/invalid token, 503 on
  shutdown), and concurrency model.
- `openspec/specs/app-independence/spec.md` — append a
  "Transport Pluggability" requirement so future apps adopt the same
  base.
- `README.md` (root) — short "Deployment" section pointing to the
  app README and to the new spec.
- `.gitignore` — no change required for the HTTP work; future
  Docker artifacts would extend this.

## Approach comparison

| # | Approach | Pros | Cons | Effort |
|---|----------|------|------|--------|
| 1 | **Keep stdio only, deploy per-agent process** | Zero new code; well-trodden path; per-process isolation. | Does not meet the requirement: N agents = N processes = N copies of the DB connection pool; DB secrets propagate to every agent host. | **None** (status quo). |
| 2 | **Add Streamable HTTP transport to `mcp-readonly-sql` only** | Minimal blast radius; preserves stdio for local clients; the same `McpServer` + tool registration is reused; matches the immediate need. | Future MCPs must each re-implement the HTTP glue; no standardization of auth, logging, or shutdown across apps. | **Medium** (~200-400 LoC + tests + spec updates). |
| 3 | **Shared HTTP base package `packages/mcp-http-base/` consumed by `mcp-readonly-sql` and all future apps** | Solves both "now" and "all future MCPs"; one place for auth, request logging, `/healthz`, shutdown; clean architectural boundary between transport and domain. | First time the workspace adds a `packages/` member; new package needs its own spec, design, and tests; must not violate `app-independence`. | **Medium-High** (~300-500 LoC base + 1 app wired + new spec). |
| 4 | **Container / systemd / reverse-proxy packaging (Dockerfile, unit file, nginx/Caddy example)** | Makes "deployable on a dedicated server" concrete; gives operators a runbook; future-proof. | The user did not name Docker/systemd yet; the repo has no git remote so a multi-PR plan is moot; better as a follow-up change. | **Low-Medium** per app once the base package exists (~100-200 LoC of infra files). |

### Recommended: Approach 2 + 3 hybrid

Introduce `packages/mcp-http-base/` (Approach 3) and have
`apps/mcp-readonly-sql` consume it (Approach 2). That gives the current
app HTTP support now and gives every future MCP the same capability by
importing the base, with no new code in each app beyond the call into
the base. Defer Approach 4 (Docker, systemd, nginx) to a follow-up
change so this PR stays inside the 800-line review budget and inside
the user's stated request ("deployable on a dedicated server"; the
deployment artifacts come later).

Rationale:

- **Solves the immediate ask** with the smallest possible change to the
  app: split the entrypoint dispatcher, call into the base package.
- **Honors the "this is the model for all future MCPs" hint** by
  centralizing the HTTP glue in a workspace package. Python MCPs (when
  they appear) will not consume the TS package, but the spec
  (`mcp-http-transport`) and the contract (auth header, error code,
  health path) can be ported to a Python shim or mirrored by FastMCP.
- **Keeps app-independence intact** because the base package is an
  opt-in dependency; the app still owns its tool set, profile loader,
  `.env`, and wire entrypoint. `app-independence` gets a new
  "Transport Pluggability" requirement to make the pattern explicit.
- **Does not lock in ops tooling** (Docker, systemd, Caddy) the user
  did not request. A short README section plus the new spec is enough
  to make the deployment model clear without preempting those choices.
- **YAGNI for a full reverse-proxy** until a real server is in place;
  documenting the one-paragraph nginx/Caddy example is sufficient for
  the proposal to land.
- **No git remote** is a constraint: keep the work in a single PR until
  the user adds a remote. `sdd-tasks` will re-evaluate the chain
  strategy.

### Sketch of the dispatcher and base package

```ts
// apps/mcp-readonly-sql/src/index.ts (sketch, not final)
import { runStdio } from "./transports/stdio.js";
import { runHttp } from "./transports/http.js";
import { readTransport } from "./config/env.js";
import { buildMcpServer } from "./server.js";

const transport = readTransport(); // "stdio" | "streamableHttp"
if (transport === "stdio") {
  await runStdio(buildMcpServer);
} else {
  await runHttp(buildMcpServer);
}
```

```ts
// packages/mcp-http-base/src/createHttpMcpServer.ts (sketch)
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from
  "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function createHttpMcpServer(opts: {
  serverFactory: () => Promise<McpServer>;
  port: number;
  host?: string;
  path?: string;          // default "/mcp"
  bearerToken?: string;   // when set, Authorization header is required
  stateless?: boolean;    // default false (stateful sessions)
  logger?: (line: string) => void;
  onShutdown?: () => Promise<void>;
}): Promise<{ close: () => Promise<void> }> {
  // ... wire http.Server, auth middleware, /healthz, session handling.
}
```

### OpenSpec placement

- New domain: `mcp-http-transport`. Single new file:
  `openspec/changes/dedicated-mcp-server-deployment/specs/mcp-http-transport/spec.md`.
- Modify: `mcp-tool-surface` to add a "HTTP transport" pointer, and
  `app-independence` to add a "Transport Pluggability" requirement.
- OpenSpec `config.yaml` `apply` / `verify` blocks stay per-app
  (`pnpm --filter mcp-readonly-sql test`) plus, if the base package
  ships tests, a new filter for the package.

## Risks

- **Multi-agent concurrency on one `ConnectionManager`**: the pool is
  single-process; long-running queries from one agent can starve
  another. Need a per-profile concurrency cap and a queue or a per-call
  timeout (already capped by `QUERY_TIMEOUT_MS_HARD_LIMIT`). Document
  the concurrency model in the new spec.
- **Auth model is thin**: bearer token via header is a starting point.
  Threat model must be explicit: TLS is terminated upstream; the
  bearer token is the only client identity; token rotation strategy
  (out of scope, but the spec should require rotation-friendly
  deployment notes). The 5xx error contract and a 401 for missing or
  invalid token must be in the spec.
- **Process working directory**: `data/demo.sqlite` is resolved against
  `process.cwd()`; on a dedicated server, the cwd is the systemd
  working directory, not the app dir. Mitigation: the HTTP entrypoint
  must `process.chdir()` to the app dir at startup, or
  `.env.example` must use absolute paths for SQLite. This is a small
  but real deployment pitfall.
- **Stdio logs vs HTTP logs**: today the app logs human-readable lines
  to stderr. HTTP servers typically want structured JSON to a
  collector. Add `MCP_LOG_FORMAT=json|text` (default `text`) so
  operators can opt in. The new spec should require that logging
  never goes to stdout when `MCP_TRANSPORT=streamableHttp`.
- **`mcp-tool-surface` "Launch Path" requirement** currently pins the
  path to stdio. We need a new requirement for the HTTP path; the
  existing stdio requirement stays unchanged. Avoid a destructive
  delta.
- **No git remote**: chained PR plan is moot. Keep this as a single
  PR until the user adds a remote and the `sdd-tasks` phase re-runs
  the forecast.
- **Future Python MCPs will not consume the TS base package**: the
  contract (auth, health, error code) must be language-agnostic so a
  Python app can implement the same surface (FastMCP, Starlette, etc.).
  Document the contract in the new spec, not in TS internals.
- **Stateful sessions vs stateless**: the MCP SDK supports both. The
  default SHOULD be stateful (`sessionIdGenerator: () => randomUUID()`)
  for multi-agent correctness, but a `MCP_HTTP_STATELESS=true` switch
  is needed for scaling. The spec should pin the default and document
  the trade-off.
- **Review budget**: a 300-500 LoC base + ~200-400 LoC app wiring +
  new spec + README updates is on the edge of the 800-line budget.
  `sdd-tasks` will re-forecast; if it overruns, split into two PRs:
  one for the base package, one for app wiring.
- **OpenSpec "apply.test_command" assumes one app**: the new base
  package's tests will need their own filter or be merged into the
  app's vitest run. Avoid a new top-level "run all" command; this
  would violate the "Per-App Command Surface" requirement.

## Open questions (for the proposal, not blockers)

- **Auth method**: bearer token only, or also `Basic` for local
  debugging? Recommend bearer only; local debug is handled by
  `MCP_HTTP_BEARER_TOKEN=` (empty = no auth, dev only).
- **Scope / claims**: do we want an OAuth-style scope claim in the
  bearer token (e.g. `<profile_alias>:<read>`), or is a single static
  token sufficient for v1? Recommend single static token; per-profile
  scopes can land later.
- **Default port**: 3000 is the SDK example. The app should read
  `MCP_HTTP_PORT` (default 3000) and `MCP_HTTP_HOST` (default
  `127.0.0.1`, requires explicit override to bind `0.0.0.0`).
- **Reverse proxy**: nginx vs Caddy? Out of scope for the code change;
  a one-paragraph example in the README is enough. The user can pick.
- **Containerization**: should the new spec mention Docker as a
  recommended packaging, or stay neutral? Recommend neutral; the
  follow-up change owns that decision.
- **Per-app port allocation**: when several MCPs share one host, ports
  must not collide. `MCP_HTTP_PORT` per app is the natural knob;
  document a convention (e.g. `mcp-readonly-sql` -> 3001, future
  apps -> 3002, ...).

## Ready for proposal

**Yes.** The exploration answers the core question: add a Streamable
HTTP transport to `mcp-readonly-sql` via a new shared workspace
package `packages/mcp-http-base/`, keep stdio as the default, and
authenticate every HTTP request with a bearer token. The next phase
(`sdd-propose`) MUST resolve the open questions above (auth method,
default port, scope model, follow-up split) and lock the spec for
`mcp-http-transport`.

Suggested next steps:

- `sdd-propose` — write `proposal.md` with intent, scope, approach
  (Approach 2 + 3 hybrid), affected areas (above), and a clear
  "out of scope: Docker / systemd / nginx configs" line.
- `sdd-spec` — write `mcp-http-transport` domain spec and the
  `mcp-tool-surface` / `app-independence` deltas.
- `sdd-design` — design the `createHttpMcpServer` API, the dispatcher
  in `apps/mcp-readonly-sql/src/index.ts`, the auth middleware, and
  the structured logging hook.
- `sdd-tasks` — re-forecast against the 800-line budget; if high,
  split into a `mcp-http-base` PR and a `mcp-readonly-sql` PR.
- `sdd-apply` — implement Strict TDD (RED-GREEN-REFACTOR) for the
  base package first, then the app wiring.
- `sdd-verify` — confirm transport-selection tests, auth tests, and
  session tests pass; confirm stdio path still works end-to-end
  (Inspector + read-only tool smoke test); confirm 130+ tests still
  green.
- `sdd-archive` — merge deltas into main specs.
