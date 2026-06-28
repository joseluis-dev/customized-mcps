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
