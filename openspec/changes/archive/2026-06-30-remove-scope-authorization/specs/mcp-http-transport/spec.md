# Delta for mcp-http-transport

## MODIFIED Requirements

### Requirement: Session Mode (Stateless Default)

The HTTP transport MUST support two session modes selected by `MCP_HTTP_STATELESS` (`true` or `false`, default `true`). When `true` (stateless, the v1 default), the transport MUST be instantiated per request with `sessionIdGenerator: undefined`; the factory MUST be called per authenticated request, and the transport MUST be closed at the end of the request. The per-request transport is the only safe multi-agent shape in v1 because the SDK 1.29 transport keeps a single `sessionId` per transport instance, so a single cached transport would otherwise let any authenticated request with that session id share the transport surface with a different agent. When `false` (stateful), the transport MUST use `sessionIdGenerator: () => randomUUID()` and MUST register `onsessioninitialized` / `onsessionclosed` callbacks to track active sessions per process. The stateful mode is the documented opt-in and is single-agent only in v1: a single cached `StreamableHTTPServerTransport` shares one session id, so operators MUST NOT use `MCP_HTTP_STATELESS=false` when multiple distinct agents are configured. Operators that need horizontally scaled multi-agent deployments MUST use the default stateless mode on every node.

The per-agent identity observed by tool handlers is `{ agentId, scopes: [] }`. The `scopes` field on the request context is always `[]` and MUST NOT be used to make an access decision; tool handlers MUST NOT consult it to gate the per-request transport. The per-agent identity is therefore exclusively `agentId`-keyed, not scope-keyed.
(Previously: the scenario referenced "per-agent scopes" — the contract now describes the per-agent `agentId` only, because `scopes` is always empty and decorative.)

#### Scenario: Stateless default isolates each request's transport

- GIVEN `MCP_TRANSPORT=streamableHttp` and no `MCP_HTTP_STATELESS`
- WHEN two distinct agents send requests concurrently
- THEN each request gets its own transport instance
- AND the per-agent `agentId` observed by tool handlers is the one attached to the request that just arrived, not any prior request
- AND no scope comparison is performed.

#### Scenario: Stateful opt-in (single-agent only)

- GIVEN `MCP_TRANSPORT=streamableHttp` and `MCP_HTTP_STATELESS=false` and exactly one agent in `MCP_AGENTS_JSON`
- WHEN that agent sends a `tools/call`
- THEN the server processes the request with the cached transport
- AND a second concurrent request from the same agent shares the session id
- AND the per-agent `scopes` value on `req.auth` (always `[]`) is not consulted.

#### Scenario: Stateless opt-in still works for legacy configs

- GIVEN `MCP_TRANSPORT=streamableHttp` and `MCP_HTTP_STATELESS=true`
- WHEN a client sends a `tools/call`
- THEN the server processes the request without persisting a session
- AND a second concurrent client does not see the first client's events
- AND no scope-based authorization check is applied to either request.
