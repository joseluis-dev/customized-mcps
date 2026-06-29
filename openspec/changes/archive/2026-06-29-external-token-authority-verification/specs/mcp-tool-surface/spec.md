# Delta for mcp-tool-surface

## Purpose

Add a per-tool scope-tag requirement so the tool layer can wire `matchScope` uniformly across apps. The tag MUST be compatible with the existing `SCOPE_PATTERN` grammar. Phase 2 wires the per-tool enforcement in `readonlyTools.ts`; this change defines the contract the wiring must honor. The five public tools (`list_profiles`, `test_connection`, `list_databases`, `execute_read_query`, `describe_schema`), their argument shape, output shape, and error contract remain unchanged.

## ADDED Requirements

### Requirement: Per-Tool Scope Tag

Every public tool exposed by an MCP app MUST declare a `requiredScope` tag on its definition. The tag MUST be a single string of the form `<verb>:<resource>`, where `<verb>` is one of `read`, `list`, `call`, and `<resource>` is either `*` or an identifier matching `[A-Za-z0-9_.-]+`. The tag MUST match `SCOPE_PATTERN` `^(read|list|call):(\*|[A-Za-z0-9_.-]+)$` exactly. A tool whose tag does not match MUST fail to register at startup, and the process MUST exit non-zero with a stderr message naming the offending tool and the offending tag.

#### Scenario: Valid scope tag registers

- GIVEN a tool declared with `requiredScope: "read:bi_catastro"`
- WHEN the app starts
- THEN the tool is registered
- AND its tag matches `SCOPE_PATTERN`.

#### Scenario: Tool with no scope tag fails closed

- GIVEN a tool declared without a `requiredScope` tag
- WHEN the app starts
- THEN the process exits non-zero
- AND stderr names the offending tool.

#### Scenario: Malformed scope tag fails closed

- GIVEN a tool declared with `requiredScope: "delete:bi_catastro"`
- WHEN the app starts
- THEN the process exits non-zero
- AND stderr names the offending tool and the offending tag.

#### Scenario: Verb is restricted to read/list/call

- GIVEN a tool declared with `requiredScope: "write:bi_catastro"`
- WHEN the app starts
- THEN the process exits non-zero
- AND stderr notes that verbs are restricted to `read`/`list`/`call`.

### Requirement: Scope Check At Tool Invocation

For each tool invocation, the runtime MUST compare the authenticated agent's `scopes` against the tool's `requiredScope` and MUST reject the call with `403` when no scope matches. The check MUST happen after authentication (per `mcp-agent-authorization`) and before any side effect (DB connect, query parse). A wildcard scope `read:*` MUST match any `read:<resource>` tag; a literal scope MUST match only the same literal. Server-side profile allowlists and the read-only safety contract (`sqlGuard`) MUST still win over scopes per the existing `mcp-agent-authorization` rule.

#### Scenario: Matching scope runs the tool

- GIVEN an agent with scopes `["read:bi_catastro"]` and a tool tagged `read:bi_catastro`
- WHEN the agent invokes the tool
- THEN the tool runs.

#### Scenario: Insufficient scope returns 403

- GIVEN an agent with scopes `["read:reporting"]` and a tool tagged `read:bi_catastro`
- WHEN the agent invokes the tool
- THEN the response status is `403`
- AND the body is a sanitized error that does not enumerate valid scopes or profiles.

#### Scenario: Wildcard scope matches any resource

- GIVEN an agent with scopes `["read:*"]`
- WHEN the agent invokes a tool tagged `read:bi_catastro`
- THEN the scope check passes
- AND the server-side allowlist still applies.

#### Scenario: Server-side allowlist still wins

- GIVEN an agent with scope `["read:bi_catastro"]` and a profile whose allowlist excludes the requested database
- WHEN the agent invokes `execute_read_query` against a non-allowlisted database
- THEN the call is rejected with the standard allowlist error
- AND scope is not a factor in the decision.

### Requirement: Sanitized 403 Body

The 403 body returned for an insufficient-scope failure MUST be a minimal JSON-RPC error. It MUST NOT enumerate the agent's actual scopes, the tool's `requiredScope`, other tools' tags, or any profile. The body MUST be emitted through the existing `sanitizeError` path from `mcp-agent-authorization`.

#### Scenario: 403 body is minimal

- GIVEN a scope mismatch
- WHEN the response is generated
- THEN the body explains the failure category only
- AND does not list the agent's actual scopes or any other agent's scopes.

#### Scenario: 403 body does not echo the tag

- GIVEN a tool tagged `read:bi_catastro` and a scope mismatch
- WHEN the response is generated
- THEN the body does NOT contain the literal `read:bi_catastro`
- AND does not name other tools or profiles.

## MODIFIED Requirements

None.

## REMOVED Requirements

None.
