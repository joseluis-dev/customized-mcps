# mcp-tool-surface Specification

## Purpose

Defines the public MCP tool contracts for `list_profiles`, `test_connection`, `list_databases`, `execute_read_query`, and `describe_schema` — including argument shape, output shape, and error contract.

## Requirements

### Requirement: `list_profiles` Additive Output

`list_profiles` MUST return `ProfileSummary` objects. Each summary MUST include `name`, `dialect`, `scope`, `allowedDatabases`, `requireQualifiedDatabase`, and MUST add `alias`, plus optional `displayName?`, `description?`, `tags?[]`, `capabilities?`. `ProfileSummary.name` MUST equal `alias`; together they are the canonical MCP-facing identifier. The summary MUST NOT include `host`, `user`, `password`, `port`, raw secret references, or the operator key — and the operator key MUST NOT be listed when it differs from the alias.

#### Scenario: Existing fields preserved

- GIVEN a profile with `alias=bi_catastro` and `displayName="Catastro BI"`
- WHEN the agent calls `list_profiles`
- THEN each entry contains `name`, `dialect`, `scope`, `allowedDatabases`, `requireQualifiedDatabase`, `alias`, `displayName`
- AND `name` equals `alias`
- AND none of `host`, `user`, `password`, `port`, or `${secret:...}` literals appear
- AND the operator key `SQLSERVER_BI` does not appear.

#### Scenario: Backward-compatible consumer

- GIVEN a consumer that reads only the original five fields
- WHEN the consumer calls `list_profiles`
- THEN it parses without error
- AND ignores any new fields.

#### Scenario: Legacy alias equals operator key

- GIVEN a profile loaded from `DB_SQLSERVER_BI_*` with no `DB_SQLSERVER_BI_ALIAS` set
- WHEN the agent calls `list_profiles`
- THEN each entry has `name` equal to `alias` equal to `SQLSERVER_BI`
- AND the operator key is not surfaced as a separate field distinct from `name`/`alias`.

### Requirement: `profile` Argument Resolution

Tools that accept a `profile` argument MUST accept either the alias or the operator key. The handler MUST resolve alias first, then operator key. When the value resolves to a profile, the tool proceeds; otherwise it returns an error keyed on the caller's value.

#### Scenario: Alias resolves

- GIVEN a profile with alias `bi_catastro` and operator key `SQLSERVER_BI`
- WHEN the agent calls `test_connection({ profile: "bi_catastro" })`
- THEN the tool runs against that profile.

#### Scenario: Operator key resolves (backward compat)

- GIVEN the same profile
- WHEN the agent calls `test_connection({ profile: "SQLSERVER_BI" })`
- THEN the tool runs against the same profile (operator key accepted as synonym).

#### Scenario: Unknown value fails

- GIVEN no profile with alias or operator key `nope`
- WHEN the agent calls `test_connection({ profile: "nope" })`
- THEN the tool returns an error whose message contains `nope`
- AND no other identifying value appears.

### Requirement: Error Contract

Tool errors MUST echo the caller-supplied `profile` value verbatim. They MUST NOT include the resolved operator key when it differs from the alias, MUST NOT include `host`/`user`/`password`/`port`/raw secret references, and MUST NOT enumerate valid profiles.

#### Scenario: Allowlist error references caller value

- GIVEN profile `bi_catastro` with allowlist `["catastral"]`
- WHEN the agent calls `execute_read_query({ profile: "bi_catastro", database: "other", sql: "..." })`
- THEN the error message is `Database "other" is not in the allowlist for profile "bi_catastro"`
- AND the operator key `SQLSERVER_BI` does not appear.

#### Scenario: Unknown profile does not enumerate

- GIVEN profiles `bi_catastro` and `reporting`
- WHEN the agent calls with `profile: "nope"`
- THEN the error mentions only `nope`
- AND neither `bi_catastro` nor `reporting` is listed.

### Requirement: No Dynamic Connection From User Input

The MCP MUST NOT accept `host`, `user`, `password`, or `port` from any tool input. All connection parameters MUST come from server-side `Profile` configuration resolved at startup. The zod input schemas MUST reject extra keys on every tool.

#### Scenario: Tool input rejected

- GIVEN any tool that takes a `profile` argument
- WHEN the agent calls it with extra `host`/`user`/`password`/`port` fields
- THEN the zod schema rejects the call as invalid
- AND no connection is opened using the supplied values.

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
