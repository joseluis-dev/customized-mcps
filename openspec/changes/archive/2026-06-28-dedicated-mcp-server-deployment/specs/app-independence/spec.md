# Delta for app-independence

## ADDED Requirements

### Requirement: Transport Pluggability And Agent Authorization

Apps in this workspace MUST be transport-agnostic at the domain layer. A TypeScript app MUST be able to expose the same tool set over stdio AND Streamable HTTP by selecting transport via `MCP_TRANSPORT` env var, with the default being `stdio`. The HTTP wiring (listener, session management, health endpoint, graceful shutdown) MUST be delegated to a shared workspace package — `packages/mcp-http-base/` for TypeScript, or an equivalent for Python — so each app does not re-implement transport glue. The shared package MUST be an opt-in dependency; apps MUST still own their tool set, profile loader, `.env`, and wire entrypoint.

Apps that serve HTTP MUST also implement the per-agent authorization contract from `mcp-agent-authorization`: per-agent identity records, opaque HMAC-signed bearer tokens, scope-based authorization, audit-safe error responses, and equal treatment of third-party agents. Apps MUST NOT introduce a "trusted agent" code path that bypasses any of these requirements. Future MCPs in this workspace (TypeScript or Python) MUST adopt the same transport + authorization shape so the operational templates and runbook remain valid across the workspace.

#### Scenario: App adopts the shared base package

- GIVEN `apps/mcp-readonly-sql` depends on `@db/mcp-http-base`
- WHEN the operator starts the app with `MCP_TRANSPORT=streamableHttp`
- THEN the HTTP transport, auth middleware, `/healthz`, and shutdown are provided by the shared package
- AND the app's own `src/transports/http.ts` is a thin call into the base.

#### Scenario: Future Python app follows the same shape

- GIVEN a future `apps/mcp-write-audit` Python app
- WHEN the operator reads its `README.md` and the workspace's `mcp-http-transport` / `mcp-agent-authorization` specs
- THEN the Python app implements the same wire contract (path, methods, health, error codes, scopes)
- AND the systemd / Docker / reverse-proxy templates from `mcp-deployment-templates` are applicable with only the `ExecStart` / `ENTRYPOINT` / `proxy_pass` target changed.

#### Scenario: No "trusted agent" bypass

- GIVEN any app in the workspace
- WHEN the operator greps its source for `trusted`, `internal`, or `isLocal` flags that skip auth
- THEN no such bypass exists in the HTTP path.

#### Scenario: App still owns its entrypoint

- GIVEN any app adopting the shared base
- WHEN the operator inspects the app's `src/` (or `src/<app>/`)
- THEN the wire entrypoint (the file pointed at by the bin / `[project.scripts]`) lives inside the app's own directory
- AND no entrypoint is re-exported by the shared package.
