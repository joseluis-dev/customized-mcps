# Design: Dedicated MCP Server Deployment

## Technical Approach

Add an opt-in Streamable HTTP path while preserving the current stdio default. A new TypeScript workspace package, `packages/mcp-http-base/`, owns reusable HTTP transport, auth, health, logging, and shutdown glue. `apps/mcp-readonly-sql` keeps owning profiles, tools, SQL safety, and the executable entrypoint; it only adds a transport dispatcher and thin HTTP adapter. This maps to `mcp-http-transport`, `mcp-agent-authorization`, and `mcp-deployment-templates` without changing the five-tool surface.

## Architecture Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Shared HTTP base | Create `packages/mcp-http-base/src/{server.ts,auth.ts,config.ts,logging.ts,shutdown.ts,errors.ts,index.ts}` with package name `@db/mcp-http-base`. | Put HTTP code inside the app only. | Future TS MCPs need the same contract; app remains responsible for domain tools only. |
| Transport dispatch | Keep `apps/mcp-readonly-sql/src/index.ts` as executable dispatcher; add `serverFactory.ts`, `transports/stdio.ts`, `transports/http.ts`. | Create a new binary. | Existing `dist/index.js` launch path remains stable and `MCP_TRANSPORT` selects behavior. |
| HTTP implementation | Use SDK `NodeStreamableHTTPServerTransport` with `node:http`; no Express. | Add Express/Fastify. | Proposal requires no new runtime deps; SDK supports node HTTP directly. |
| Sessions | Default **stateless** per-request; `MCP_HTTP_STATELESS=false` opts in to a single-cached stateful transport. The stateful opt-in is documented as single-agent only in v1 because the SDK 1.29 transport keeps one `sessionId` per transport instance. | Default stateful. | PR1 re-review found that a single cached transport shared its session id across all authenticated agents, a multi-agent isolation bug. The safe v1 default is per-request stateless; stateful remains the documented opt-in for single-agent deployments. |
| Auth | Opaque bearer token, server-side HMAC hash, `crypto.timingSafeEqual`, scopes `read|list|call:<profile|*>`. | OAuth2/JWT/IdP or a global shared token. | Meets third-party per-agent constraints without owning IdP complexity in v1. |
| TLS | App serves HTTP only; production uses existing reverse proxy with `MCP_HTTP_BEHIND_PROXY=true`. | Embed TLS cert handling in app. | Keeps cert lifecycle out of app; dev/staging non-loopback requires explicit insecure opt-in warning. |

## Data Flow

```text
agent ──HTTP /mcp──> auth middleware ──> SDK transport ──> buildMcpServer()
                         │                       │              │
                         ├── scopes/context       └── sessions    └── tools/sqlGuard/ConnectionManager
health probe ──/healthz──┘
```

Stdio flow stays: host -> `dist/index.js` -> `StdioServerTransport` -> same `buildMcpServer()`.

## File Changes

| File | Action | Description |
|---|---|---|
| `pnpm-workspace.yaml` | Modify | Add `packages/*`. |
| `packages/mcp-http-base/package.json`, `tsconfig.json`, `src/*.ts` | Create | Shared `createHttpMcpServer`, auth, logging, shutdown, config, sanitized errors. |
| `apps/mcp-readonly-sql/src/index.ts` | Modify | Dispatch `stdio` default vs `streamableHttp`; fail fast on unknown values. |
| `apps/mcp-readonly-sql/src/serverFactory.ts` | Create | Builds `McpServer`, loads profiles/limits, registers tools, returns shutdown hooks. |
| `apps/mcp-readonly-sql/src/transports/{stdio,http}.ts` | Create | Thin adapters around existing stdio and shared HTTP base. |
| `apps/mcp-readonly-sql/src/config/http.ts` | Create | Reads HTTP env and agent config using existing env style. |
| `apps/mcp-readonly-sql/.env.example`, `README.md`, `package.json` | Modify | Document env source of truth and add `start:http`. |
| `deploy/{systemd/mcp-readonly-sql.service,docker/Dockerfile,nginx/mcp.conf,README.md}` | Create | Operational templates and runbook. |
| `apps/mcp-readonly-sql/test/*.test.ts` | Create/Modify | Vitest coverage for dispatch, auth, HTTP, templates. |

## Interfaces / Contracts

`createHttpMcpServer(options)` accepts: `serverFactory`, `host`, `port`, `path`, `agents`, `hmacSecret`, `sessionMode`, `logger`, `shutdownTimeoutMs`, `onShutdown`. It returns `{ start(): Promise<void>; stop(): Promise<void>; url: string }`.

Agent records are loaded from `MCP_AGENTS_JSON` or `MCP_AGENTS_INLINE`:

```ts
type AgentRecord = { id: string; keyHash: string; scopes: string[] };
type AgentScope = `${"read" | "list" | "call"}:${string | "*"}`;
```

`401`, `403`, and `503` responses use minimal JSON-RPC-style sanitized failures and never include tokens, ids, hashes, valid profiles, or valid scopes. Tool/profile checks happen before tool execution where possible; `sqlGuard` and profile allowlists always win.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | env parsing, host opt-ins, HMAC validation, constant-time compare, scope matcher, logger redaction | New Vitest files under `apps/mcp-readonly-sql/test/`; no new runner. |
| Integration | stdio default, HTTP auth-before-transport, `/healthz`, stateful/stateless sessions, graceful shutdown `503` | Node `http` client tests against ephemeral ports; mock server factory where DB is unnecessary. |
| Structural | package layout, workspace includes `packages/*`, templates reference only `.env.example` vars | Extend structural Vitest tests; optional template commands documented for manual/operator verification. |

## Migration / Rollout

No data migration required. Roll out by building the app, setting `MCP_TRANSPORT=streamableHttp`, configuring agents, and deploying behind the existing proxy. Roll back by setting `MCP_TRANSPORT=stdio` or reverting the additive package/templates. Review budget risk is medium-high; `sdd-tasks` should split PRs: base package/app wiring first, operational templates/docs second.

## Open Questions

- [ ] None blocking. Operator-specific proxy domain/cert paths remain deployment-time values in templates.
