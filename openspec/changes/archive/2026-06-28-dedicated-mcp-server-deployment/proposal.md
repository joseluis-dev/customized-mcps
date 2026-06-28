# Proposal: Dedicated MCP Server Deployment

## Intent

Deploy MCPs on a dedicated server so several agents — including **third-party agents** — share one process per MCP. Today `mcp-readonly-sql` is `stdio`-only, forcing a child process per agent and leaking DB credentials to every host. Add **Streamable HTTP** with **per-agent authorization** (own identity, scopes) and ship **operational templates** (systemd, Docker, reverse proxy). Production TLS terminates upstream by an existing proxy; the app binds `127.0.0.1` in prod and documents the dev/staging path clearly.

## Scope

### In Scope
- `packages/mcp-http-base/` (new): transport, auth middleware, request
  log, `/healthz`, graceful shutdown.
- `apps/mcp-readonly-sql` HTTP transport via
  `MCP_TRANSPORT=streamableHttp|stdio` (default `stdio`).
- Per-agent keys loaded from `MCP_AGENTS_JSON`; scopes per agent
  (`read:<profile-alias>`, etc.). `401` missing/invalid, `403` scope
  denial, `503` on shutdown.
- Operational templates: `deploy/systemd/mcp-readonly-sql.service`,
  `deploy/docker/Dockerfile`, `deploy/nginx/mcp.conf`, `deploy/README.md`.

### Out of Scope
- Embedded TLS in the app (upstream proxy job).
- OAuth2 / JWT signature verification (opaque HMAC-signed tokens in v1).
- Persistent audit log store; new MCP apps in this change.
- Per-profile concurrency cap and query queuing (follow-up change).

## Capabilities

### New Capabilities
- `mcp-http-transport`: HTTP wire contract (path, methods, session
  mode, env vars, error contract) reusable by every future MCP.
- `mcp-agent-authorization`: per-agent identity, scopes, and
  authorization decisions for HTTP requests.
- `mcp-deployment-templates`: systemd, Docker, and reverse-proxy
  contract for the first MCP and a model future apps adopt.

### Modified Capabilities
- `mcp-tool-surface`: keep the stdio "Launch Path" requirement; add a
  pointer that the HTTP launch path and agent auth live in the new
  specs.
- `app-independence`: append a "Transport Pluggability and Agent
  Authorization" requirement so future apps adopt the same pattern
  (shared base package, per-agent auth, env-driven transport switch).

## Approach

- `packages/mcp-http-base` exposes
  `createHttpMcpServer({ serverFactory, port, host, path, agentConfig,
  sessionMode, logger, onShutdown })`. Wires
  `NodeStreamableHTTPServerTransport` (SDK 1.29) to `node:http`, runs
  the auth middleware **before** the MCP transport, exposes
  `GET /healthz`, and handles SIGTERM/SIGINT with in-flight drain.
- `apps/mcp-readonly-sql` splits `src/index.ts` into
  `transports/stdio.ts` + `transports/http.ts`, dispatched by
  `MCP_TRANSPORT`. HTTP reuses the same `buildMcpServer` factory. The
  five tools, the `ProfileSummary` shape, and the read-only safety
  contract are unchanged.
- Auth: load `{ id, keyHash, scopes[] }` records from
  `MCP_AGENTS_JSON` (or `MCP_AGENTS_INLINE` for dev). Tokens are
  opaque, HMAC-signed by the server, compared in constant time.
  Server-side profile allowlist and `sqlGuard` always win over scopes.
  Default host is `127.0.0.1`; `MCP_HTTP_ALLOW_INSECURE_LOOPBACK` is
  the explicit opt-in that lets dev/staging bind without a proxy and
  prints a loud warning.
- Templates: systemd unit runs `node dist/index.js` with an
  `EnvironmentFile=/etc/mcp/mcp-readonly-sql.env`; multi-stage
  `node:20-alpine` Dockerfile; nginx example terminates TLS and does
  `proxy_pass http://127.0.0.1:3001`, preserving the `Authorization`
  header. `deploy/README.md` is the operator runbook and states
  explicitly that production TLS is the proxy's job.

## Affected Areas

| Area | Impact |
|------|--------|
| `packages/mcp-http-base/` (new) | Shared HTTP + auth + health + shutdown helper |
| `apps/mcp-readonly-sql/src/{index.ts,transports/,config/}` | New + modified (env reads, agent loader, dispatcher) |
| `apps/mcp-readonly-sql/test/` | New: transport, auth, session, agent tests |
| `apps/mcp-readonly-sql/{README.md,.env.example,package.json}` | HTTP docs, env vars, `start:http` script |
| `pnpm-workspace.yaml` | Add `packages/*` next to `apps/*` |
| `deploy/{systemd,docker,nginx,README.md}` | New operational templates and runbook |
| `openspec/specs/mcp-{http-transport,agent-authorization,deployment-templates}/spec.md` | New specs |
| `openspec/specs/{mcp-tool-surface,app-independence}/spec.md` | Deltas: HTTP pointer + transport pluggability + agent auth |
| Root `README.md` + `openspec/config.yaml` | Deployment link, per-app filter rules |

## Risks

| Risk | Lik | Mitigation |
|------|-----|------------|
| Per-agent model grows into OAuth2 / IdP mid-change | Med | Spec pins v1 = opaque HMAC + scopes; IdP integration is a future change. |
| Shared `ConnectionManager` starves one agent | Med | Keep `QUERY_TIMEOUT_MS_HARD_LIMIT`; document concurrency model; per-profile cap is a follow-up. |
| Templates drift from the server's env contract | Med | `.env.example` is the single source of truth; CI lint checks templates reference only documented vars. |
| Dev/staging runs without TLS and leaks tokens | Med | Default `MCP_HTTP_HOST=127.0.0.1`; `MCP_HTTP_ALLOW_INSECURE_LOOPBACK` opt-in; loud README + runbook warning. |
| Templates bloat the PR past the 800-line review budget | Med | PR1 = base + app + specs; PR2 = templates + README; `sdd-tasks` re-forecasts. |
| Future Python MCPs cannot consume the TS base package | Med | New specs are language-agnostic; a Python shim is a follow-up. |
| Shutdown race with in-flight queries | Low | Stop accepting new sessions, drain in-flight, then close the pool. |

## Rollback Plan

Revert the change commit. `MCP_TRANSPORT=stdio` is the default; a
one-line env revert (`/etc/mcp/mcp-readonly-sql.env`) restores the
pre-change behavior. The base package is opt-in — removing
`@db/mcp-http-base` and reverting `src/index.ts` to the previous
shape restores the prior app in one commit. `deploy/` files are
additive; deleting them does not affect the stdio path. New specs
are not merged into main specs until `sdd-archive`, so archiving a
blocked change leaves `openspec/specs/` untouched.

## Dependencies

- `@modelcontextprotocol/sdk@^1.29.0` (already present; exposes
  `NodeStreamableHTTPServerTransport`).
- No new runtime deps in `mcp-readonly-sql`.
- `packages/mcp-http-base` depends only on the SDK, `node:http`, and
  `node:crypto`.
- External: an existing reverse proxy in production for TLS
  termination (documented in `deploy/README.md`).

## Success Criteria

- [ ] All 130+ existing tests still green; new transport, auth,
  session, and agent tests pass.
- [ ] `MCP_TRANSPORT=stdio` works unchanged (Inspector smoke test).
- [ ] HTTP: valid agent key → tools respond; missing/invalid key →
  `401`; insufficient scope → `403`; shutdown → `503`.
- [ ] `GET /healthz` returns `200` when up and `503` during shutdown.
- [ ] `deploy/` artifacts parse: `systemd-analyze verify` on the
  unit, `docker build` succeeds, `nginx -t` accepts the example.
- [ ] Deltas for `mcp-tool-surface` and `app-independence` reviewed
  and consistent with the new specs.
