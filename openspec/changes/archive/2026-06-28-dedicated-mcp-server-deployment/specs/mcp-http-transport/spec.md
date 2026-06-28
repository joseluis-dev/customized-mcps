# mcp-http-transport Specification

## Purpose

Defines the HTTP transport contract that every MCP app in this workspace MUST satisfy when exposing tools over the network. Stdio is preserved unchanged; HTTP is opt-in via env and is the only path that lets multiple agents share one process.

## Requirements

### Requirement: Transport Selection By Environment

The app MUST select transport from the `MCP_TRANSPORT` env var. Allowed values: `stdio` (default) and `streamableHttp`. Any other value MUST cause the process to exit non-zero with a clear stderr message listing the allowed values. The default MUST remain `stdio` so existing desktop hosts keep working without configuration changes.

#### Scenario: Default is stdio

- GIVEN no `MCP_TRANSPORT` is set
- WHEN the app starts
- THEN the stdio transport is used
- AND the read-only tool set is reachable over stdio.

#### Scenario: HTTP selected explicitly

- GIVEN `MCP_TRANSPORT=streamableHttp`
- WHEN the app starts
- THEN the HTTP transport is used
- AND the same read-only tool set is reachable over HTTP.

#### Scenario: Unknown value fails fast

- GIVEN `MCP_TRANSPORT=tcp`
- WHEN the app starts
- THEN the process exits non-zero
- AND stderr names the allowed values (`stdio`, `streamableHttp`).

### Requirement: HTTP Listener Configuration

The HTTP transport MUST read `MCP_HTTP_HOST` (default `127.0.0.1`), `MCP_HTTP_PORT` (default `3000`), and `MCP_HTTP_PATH` (default `/mcp`) from the env. The server MUST bind to the configured host and port, MUST route MCP traffic to `MCP_HTTP_PATH`, and MUST also expose `GET /healthz` for liveness probes.

#### Scenario: Loopback bind by default

- GIVEN `MCP_TRANSPORT=streamableHttp` and no HTTP host/port/path overrides
- WHEN the app starts
- THEN the server binds `127.0.0.1:3000`
- AND the listener does not accept external interfaces.

#### Scenario: Custom path and port

- GIVEN `MCP_HTTP_PATH=/mcp-readonly-sql` and `MCP_HTTP_PORT=3100`
- WHEN the app starts
- THEN MCP requests to `/mcp-readonly-sql` are handled
- AND `GET /healthz` is still served.

### Requirement: Loopback-Only Default With Explicit Opt-In

The default `MCP_HTTP_HOST` MUST be `127.0.0.1`. The app MUST refuse to bind a non-loopback address unless one of the following env vars is set to `true`: `MCP_HTTP_BEHIND_PROXY` (production path; TLS terminated upstream by an existing reverse proxy) or `MCP_HTTP_ALLOW_INSECURE_BIND` (dev/staging opt-in; explicitly acknowledges no TLS in the app). When the second opt-in is used, the app MUST write a prominent warning to stderr stating that TLS is the operator's responsibility. The legacy `MCP_HTTP_ALLOW_INSECURE_LOOPBACK` flag is accepted as a deprecated alias of `MCP_HTTP_ALLOW_INSECURE_BIND` to avoid breaking existing operator configs.

#### Scenario: Production behind proxy

- GIVEN `MCP_HTTP_HOST=127.0.0.1` and `MCP_HTTP_BEHIND_PROXY=true`
- WHEN the app starts
- THEN it binds the configured address
- AND no insecure-loopback warning is printed.

#### Scenario: Dev/staging with loud warning

- GIVEN `MCP_HTTP_HOST=0.0.0.0` and `MCP_HTTP_ALLOW_INSECURE_LOOPBACK=true`
- WHEN the app starts
- THEN it binds the requested address
- AND a prominent warning is written to stderr noting TLS is the operator's responsibility.

#### Scenario: Non-loopback without opt-in fails

- GIVEN `MCP_HTTP_HOST=0.0.0.0` and no opt-in env var
- WHEN the app starts
- THEN the process exits non-zero
- AND stderr instructs the operator to set `MCP_HTTP_BEHIND_PROXY=true` or `MCP_HTTP_ALLOW_INSECURE_LOOPBACK=true`.

### Requirement: Streamable HTTP Wire Methods

The endpoint at `MCP_HTTP_PATH` MUST be served by `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk@^1.29` paired with `node:http` (no `express`). `POST` MUST carry JSON-RPC requests and return the standard JSON-RPC response envelope. `GET` MUST open the SSE stream for server-to-client notifications. The transport MUST surface the SDK's standard error envelope on malformed bodies. All MCP traffic MUST be authenticated per `mcp-agent-authorization`; the auth middleware MUST run before the request reaches the transport's `handleRequest`.

#### Scenario: POST JSON-RPC succeeds

- GIVEN a valid agent bearer token
- WHEN the client sends `POST /mcp` with a valid `tools/call` body
- THEN the response status is `200`
- AND the body is a JSON-RPC result envelope.

#### Scenario: GET opens SSE stream

- GIVEN a valid agent bearer token
- WHEN the client sends `GET /mcp` with `Accept: text/event-stream`
- THEN the response status is `200` with the correct SSE content type
- AND the server can push notifications to that stream.

#### Scenario: Malformed body

- GIVEN a valid agent bearer token
- WHEN the client sends `POST /mcp` with a non-JSON body
- THEN the response is a JSON-RPC error envelope (`-32700` parse error or equivalent)
- AND the response status reflects the error class.

#### Scenario: Missing Content-Length on a chunked POST

- GIVEN a valid agent bearer token
- WHEN the client sends `POST /mcp` without a `Content-Length` header (e.g. a chunked transfer-encoded body)
- AND the operator has NOT set `MCP_HTTP_ALLOW_UNBOUNDED_BODY=true`
- THEN the response is `411 Length Required`
- AND the body is a sanitized JSON-RPC error envelope (no body fragment).

#### Scenario: Chunked POST with the opt-in

- GIVEN a valid agent bearer token
- WHEN the client sends `POST /mcp` without a `Content-Length` header
- AND the operator HAS set `MCP_HTTP_ALLOW_UNBOUNDED_BODY=true`
- THEN the request reaches the SDK transport
- AND the app logs a one-shot warning that the operator is responsible for the body cap at the reverse proxy.

### Requirement: Session Mode (Stateless Default)

The HTTP transport MUST support two session modes selected by `MCP_HTTP_STATELESS` (`true` or `false`, default `true`). When `true` (stateless, the v1 default), the transport MUST be instantiated per request with `sessionIdGenerator: undefined`; the factory MUST be called per authenticated request, and the transport MUST be closed at the end of the request. The per-request scope is the only safe multi-agent shape in v1 because the SDK 1.29 transport keeps a single `sessionId` per transport instance, so a single cached transport would otherwise let any authenticated request with that session id share the transport surface with a different agent. When `false` (stateful), the transport MUST use `sessionIdGenerator: () => randomUUID()` and MUST register `onsessioninitialized` / `onsessionclosed` callbacks to track active sessions per process. The stateful mode is the documented opt-in and is single-agent only in v1: a single cached `StreamableHTTPServerTransport` shares one session id, so operators MUST NOT use `MCP_HTTP_STATELESS=false` when multiple distinct agents are configured. Operators that need horizontally scaled multi-agent deployments MUST use the default stateless mode on every node.

#### Scenario: Stateless default isolates each request's transport

- GIVEN `MCP_TRANSPORT=streamableHttp` and no `MCP_HTTP_STATELESS`
- WHEN two distinct agents send requests concurrently
- THEN each request gets its own transport instance
- AND the per-agent scopes and identity observed by tool handlers are the ones attached to the request that just arrived, not any prior request.

#### Scenario: Stateful opt-in (single-agent only)

- GIVEN `MCP_TRANSPORT=streamableHttp` and `MCP_HTTP_STATELESS=false` and exactly one agent in `MCP_AGENTS_JSON`
- WHEN that agent sends a `tools/call`
- THEN the server processes the request with the cached transport
- AND a second concurrent request from the same agent shares the session id.

#### Scenario: Stateless opt-in still works for legacy configs

- GIVEN `MCP_TRANSPORT=streamableHttp` and `MCP_HTTP_STATELESS=true`
- WHEN a client sends a `tools/call`
- THEN the server processes the request without persisting a session
- AND a second concurrent client does not see the first client's events.

### Requirement: Health Endpoint

The server MUST expose `GET /healthz` outside the authenticated request path so external load balancers and orchestrators can probe it without credentials. While the process is healthy and accepting new sessions, the response MUST be `200` with body `ok`. After the process receives SIGTERM or SIGINT and is draining, the response MUST be `503` with body `shutting-down`.

#### Scenario: Health up

- GIVEN the app is running
- WHEN an unauthenticated `GET /healthz` is sent
- THEN the response is `200` with body `ok`.

#### Scenario: Health down on shutdown

- GIVEN the app received SIGTERM and is draining
- WHEN `GET /healthz` is sent
- THEN the response is `503` with body `shutting-down`.

### Requirement: Stdio Preservation

The app MUST keep `MCP_TRANSPORT=stdio` fully functional. The read-only tool set, JSON-RPC wire format, read-only safety contract from `mcp-tool-surface`, and the entrypoint path `apps/mcp-readonly-sql/dist/index.js` MUST remain unchanged. Adding HTTP MUST NOT alter stdio tool registration, error contract, or launch path.

#### Scenario: Stdio smoke test

- GIVEN `MCP_TRANSPORT=stdio`
- WHEN the MCP Inspector connects and lists tools
- THEN the same read-only tools are listed
- AND `execute_read_query` still enforces the read-only contract.

### Requirement: Graceful Shutdown

On SIGTERM or SIGINT, the HTTP server MUST stop accepting new connections, respond to new requests with `503`, drain in-flight requests up to `MCP_HTTP_SHUTDOWN_TIMEOUT_MS` (default `10000`), and only then close the `ConnectionManager` and exit. The `/healthz` endpoint MUST start returning `503` immediately after the shutdown signal is received.

#### Scenario: SIGTERM drains in-flight

- GIVEN an in-flight `tools/call` request
- WHEN SIGTERM arrives
- THEN the server stops accepting new requests with `503`
- AND the in-flight request completes
- AND the process exits `0` within the timeout.

#### Scenario: Shutdown timeout exceeded

- GIVEN an in-flight request that exceeds `MCP_HTTP_SHUTDOWN_TIMEOUT_MS`
- WHEN the timeout elapses
- THEN the request is forcibly closed
- AND the process exits non-zero with a stderr log naming the timed-out request.

### Requirement: Structured Logging For HTTP

The app MUST support `MCP_LOG_FORMAT=json|text` (default `text`). When `json`, every log line MUST be a single-line JSON object with at least `ts`, `level`, `msg`, and optional `requestId` / `agentId` fields. The app MUST never write log lines to `stdout` when `MCP_TRANSPORT=streamableHttp`; `stdout` is reserved for the transport protocol. Bearer tokens, raw agent keys, and DB credentials MUST NEVER appear in any log line regardless of format.

#### Scenario: JSON logs in HTTP mode

- GIVEN `MCP_TRANSPORT=streamableHttp` and `MCP_LOG_FORMAT=json`
- WHEN the server logs a request
- THEN the log line is a single JSON object written to stderr
- AND `stdout` contains only the transport stream.

#### Scenario: Token never logged

- GIVEN any log line emitted by the server
- WHEN an inspector greps the log for the bearer token
- THEN no match is found.

### Requirement: Port Allocation Convention

To avoid collisions when several MCPs share one host, each app MUST document a default port in its `.env.example` and `README.md`. `mcp-readonly-sql` MUST default to `MCP_HTTP_PORT=3001`. Future apps MUST pick distinct ports (e.g., `3002`, `3003`); the chosen port MUST be reflected in the deploy templates for that app.

#### Scenario: No collision across apps

- GIVEN two apps with `MCP_HTTP_PORT=3001` and `MCP_HTTP_PORT=3002` respectively
- WHEN both are started on the same host
- THEN both bind successfully
- AND no `EADDRINUSE` error is logged.
