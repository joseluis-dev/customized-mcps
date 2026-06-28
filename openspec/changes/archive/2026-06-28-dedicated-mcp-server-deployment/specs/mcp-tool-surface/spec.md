# Delta for mcp-tool-surface

## ADDED Requirements

### Requirement: HTTP Transport Pointer

The tool surface (the five read-only tools, their argument shape, output shape, and error contract) is unchanged by this change. The HTTP transport path that exposes these tools over the network — including endpoint path, methods, session mode, env vars, and HTTP error contract — is defined in `mcp-http-transport`. The per-agent identity, token validation, and scope enforcement that protects the HTTP path is defined in `mcp-agent-authorization`. The deployment artifacts (systemd unit, Dockerfile, reverse proxy example, runbook) for the first MCP are defined in `mcp-deployment-templates`. The stdio "Launch Path" requirement in this spec continues to be the canonical local launch path; HTTP is an additional launch path that operators opt into via `MCP_TRANSPORT=streamableHttp`.

#### Scenario: Stdio is still the default launch path

- GIVEN an MCP host configured with `mcpServers.<name>.args = <abs>/apps/mcp-readonly-sql/dist/index.js`
- WHEN the host starts the server with no env overrides
- THEN the stdio transport is used
- AND the five read-only tools respond identically to the pre-change behavior.

#### Scenario: HTTP launch path is documented elsewhere

- GIVEN an operator reads the spec index
- WHEN they look up "HTTP transport"
- THEN they are directed to `mcp-http-transport`
- AND the per-agent auth contract to `mcp-agent-authorization`
- AND the operational templates to `mcp-deployment-templates`.

#### Scenario: Tool surface is unchanged

- GIVEN any tool call (read or write attempt) on the HTTP path
- WHEN the request is processed
- THEN the tool's argument shape, output shape, and error contract match this spec exactly
- AND no new tool is added or removed by this change.
