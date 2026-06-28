# Delta for mcp-tool-surface

## ADDED Requirements

### Requirement: Launch Path

The MCP server entrypoint MUST be located at `apps/mcp-readonly-sql/dist/index.js` relative to the repository root. The MCP host `mcpServers.<name>.args` configuration MUST point to that absolute path. The tool set, JSON-RPC wire format, and read-only safety contract from the existing requirements are unchanged.

#### Scenario: MCP host wires the new path

- GIVEN a fresh clone of the repository after migration
- WHEN the operator configures `mcpServers.<name>.args` as `<abs>/apps/mcp-readonly-sql/dist/index.js`
- THEN the server starts and registers the 5 tools
- AND each tool behaves identically to the pre-migration implementation.

#### Scenario: Pre-migration path fails fast

- GIVEN the same clone
- WHEN the operator leaves `mcpServers.<name>.args` at `<abs>/dist/index.js`
- THEN the MCP host reports a missing-file error
- AND no tool registers.

#### Scenario: Wire format and read-only safety preserved

- GIVEN a tool call against the new entrypoint
- WHEN the server receives `execute_read_query`
- THEN the read-only safety contract from the existing `mcp-tool-surface` requirements still applies
- AND the JSON-RPC envelope shape is unchanged.
