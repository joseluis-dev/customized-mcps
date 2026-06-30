# Delta for mcp-tool-surface

## MODIFIED Requirements

### Requirement: Per-Tool Scope Tag

A `requiredScope` field on a tool definition is OPTIONAL decorative metadata. It MAY be present for documentation and operator clarity. When present, it MUST be a string of the form `<verb>:<resource>`, where `<verb>` is one of `read`, `list`, `call`, and `<resource>` is either `*` or an identifier matching `[A-Za-z0-9_.-]+`. The runtime MUST NOT use `requiredScope` (present, absent, malformed, or with a verb outside the documented set) to make an access decision. The runtime MUST NOT validate `requiredScope` against any pattern, MUST NOT normalize it, and MUST NOT emit a `WARN` because of it. The runtime MUST NOT refuse to register a tool because `requiredScope` is missing, malformed, or uses a verb outside the documented set. The runtime MUST NOT exit non-zero at startup because of any `requiredScope` value. Tools are NOT required to declare `requiredScope`; existing tools that declare one MAY keep it as inert metadata, and new tools MAY omit it entirely. Implementers MUST NOT add `requiredScope` tags to tool definitions solely to satisfy this requirement.
(Previously: tools MUST declare `requiredScope`; missing or malformed tags failed startup. Now: optional decorative metadata, never validated, never read for authorization.)

#### Scenario: Optional scope tag registers and is decorative

- GIVEN a tool declared with `requiredScope: "read:bi_catastro"` (an existing tool, no change required)
- WHEN the app starts and a request is processed
- THEN the tool is registered
- AND the tag is preserved on the tool definition as-is
- AND the tag is not compared to any agent scope to make an access decision.

#### Scenario: Tool with no scope tag registers normally

- GIVEN a tool declared without a `requiredScope` tag (a new or existing tool)
- WHEN the app starts
- THEN the process starts successfully
- AND the tool is registered
- AND no stderr message names the tool as missing a tag.

#### Scenario: Malformed scope tag does not fail closed

- GIVEN a tool declared with `requiredScope: "delete:bi_catastro"` (a verb outside the documented set)
- WHEN the app starts
- THEN the process starts successfully
- AND the tool is registered with the tag preserved as-is
- AND no `WARN` is logged for the malformed tag.

#### Scenario: Verb is not restricted to read/list/call

- GIVEN a tool declared with `requiredScope: "write:bi_catastro"` (a verb outside the documented set)
- WHEN the app starts
- THEN the process starts successfully
- AND the tool is registered with the tag preserved as-is
- AND no stderr message names the verb as out of range.

### Requirement: Sanitized 403 Body

The `403` status code MUST NOT be produced by scope enforcement because scope authorization is removed. Tool handlers MAY still return a `403` from non-scope paths (e.g. profile allowlist mismatches); those responses continue to use the existing allowlist error contract. The previous contract for the sanitized scope-mismatch `403` body is removed.
(Previously: a sanitized 403 body was defined for scope-mismatch failures. Now: not produced by scope enforcement.)

#### Scenario: No 403 from scope enforcement

- GIVEN an authenticated request
- WHEN the tool handler runs
- THEN the response status is not `403` due to a scope mismatch
- AND any non-auth failure (e.g. allowlist, sqlGuard) returns its existing sanitized error shape.

## REMOVED Requirements

### Requirement: Scope Check At Tool Invocation

(Reason: scope authorization is removed. Any authenticated agent MAY call any tool subject to the non-scope safety controls (sqlGuard, profile/database allowlists, body caps, host/proxy posture). The runtime MUST NOT compare the authenticated agent's `scopes` against the tool's `requiredScope`; a `403` MUST NOT be returned for a scope mismatch.)
(Migration: tool handlers and middleware MUST NOT consult `req.auth.scopes` (which is always `[]`) or the tool's `requiredScope` (which is decorative or absent) when deciding whether to run. Existing allowlist and sqlGuard checks remain authoritative and unchanged.)

## RENAMED Requirements

None.
