# profiles Specification

## Purpose

Describes how connection profiles are loaded from `DB_<NAME>_*` env vars, validated, and exposed to the MCP tool surface. Profiles are server-side only; agent-facing fields are non-leaking by construction.

## Requirements

### Requirement: Alias Defaulting

The system MUST accept an optional `DB_<NAME>_ALIAS` env var per profile. When unset, the alias MUST default to the operator key (the `<NAME>` segment of `DB_<NAME>_*`). The alias is the canonical MCP-facing identifier; `ProfileSummary.name` MUST equal `alias`. Both `name` and `alias` MUST be exposed in agent-facing outputs, and the operator key MUST NOT appear in either field when it differs from the alias.

#### Scenario: Alias defaults to operator key

- GIVEN a profile loaded from `DB_SQLSERVER_BI_*` with no `DB_SQLSERVER_BI_ALIAS` set
- WHEN the profile summary is built
- THEN the alias equals `"SQLSERVER_BI"`
- AND `name` equals `"SQLSERVER_BI"`
- AND the operator key is not present as a separate field in the summary.

#### Scenario: Explicit alias overrides operator key

- GIVEN `DB_SQLSERVER_BI_ALIAS=bi_catastro`
- WHEN the profile is loaded
- THEN the alias equals `"bi_catastro"`
- AND `name` equals `"bi_catastro"`
- AND the operator key `"SQLSERVER_BI"` stays server-side and does not appear in `name` or `alias`.

### Requirement: Alias Validation

The alias MUST match `^[A-Za-z0-9_]+$` and MUST be 1-64 characters. Any other value MUST fail startup with a non-leaking `ProfileError` that names the field but never the password, host, user, or port.

#### Scenario: Invalid alias rejected

- GIVEN `DB_X_ALIAS=bi-catastro!`
- WHEN the server starts
- THEN startup throws `ProfileError` whose message references the alias field
- AND the value, host, user, password, or port do not appear.

### Requirement: Alias Uniqueness

The system MUST reject startup when two profiles would resolve to the same alias, OR when one profile's alias equals another profile's operator key. Handlers resolve alias first and then fall back to the operator key, so a name that matches both creates ambiguity and MUST be treated as a collision. The error MUST be non-leaking: it names the colliding alias and omits the operator keys of either side.

#### Scenario: Duplicate alias fails closed

- GIVEN two env blocks whose aliases both resolve to `bi_catastro`
- WHEN the server starts
- THEN startup throws `ProfileError("Duplicate alias 'bi_catastro'")`
- AND neither operator key is included in the message.

#### Scenario: Alias collides with another profile's operator key

- GIVEN profile A with alias `bi_catastro` (operator key `STAGING_SQL`) and profile B whose operator key is `bi_catastro`
- WHEN the server starts
- THEN startup throws `ProfileError` that names the colliding alias
- AND neither the colliding operator key nor the other profile's internals appear in the message.

### Requirement: Display Metadata

The system MUST accept optional `DB_<NAME>_DISPLAY_NAME`, `DB_<NAME>_DESCRIPTION`, and `DB_<NAME>_TAGS` (comma list). Tags MUST be trimmed; blank entries MUST be removed. The system SHOULD accept an optional `DB_<NAME>_CAPABILITIES` (comma list); when omitted, the default capability set is `["read-only"]`.

#### Scenario: Tags trimmed and deduped

- GIVEN `DB_X_TAGS="bi, finance, "`
- WHEN the profile loads
- THEN `tags` equals `["bi","finance"]`
- AND empty entries are dropped.

### Requirement: Secret Reference Resolution

Secret-bearing fields (e.g. `DB_<NAME>_PASSWORD`) MUST support a `${secret:file:/abs/path}` prefix. The loader MUST resolve references at startup via a `SecretProvider` interface. Resolved secrets MUST NOT appear in any log, error, or `ProfileSummary`. The interface MUST be extensible for future providers (env, vault, etc.) without breaking the prefix contract.

#### Scenario: File-based secret resolved at startup

- GIVEN `DB_X_PASSWORD=${secret:file:/run/secrets/db_pw}` and the file exists and is readable
- WHEN the profile loads
- THEN the in-memory connection has the file contents
- AND the literal `${secret:file:...}` never appears in any log or error.

#### Scenario: Missing file fails non-leaking

- GIVEN `DB_X_PASSWORD=${secret:file:/missing}` and the file does not exist
- WHEN the profile loads
- THEN startup throws `ProfileError` that names the alias and kind (`file`)
- AND the file path, host, user, password, or port do not appear in the message.

### Requirement: Non-Leaking ProfileError

`ProfileError` messages MUST NOT include `host`, `user`, `password`, `port`, raw secret references, or operator keys distinct from the alias. The error MUST name the alias and a stable, non-sensitive reason code. The existing `sanitizeError` formatter is the single point of masking.

#### Scenario: Connection error masked

- GIVEN a profile whose password fails to authenticate against the database
- WHEN the loader raises the underlying connection error
- THEN the surfaced message is run through `sanitizeError`
- AND `host`, `user`, `port`, and `password` do not appear verbatim in the result.

### Requirement: Backward Compatibility

All new env vars MUST be optional. An existing `.env` containing only legacy `DB_<NAME>_*` connection vars MUST continue to load and serve identical behavior. The tool `profile` argument MUST accept the operator key as a synonym for the alias.

#### Scenario: Legacy env still loads

- GIVEN a `.env` with only `DB_SQLSERVER_BI_*` connection vars and no `ALIAS`
- WHEN the server starts
- THEN the profile loads with alias `SQLSERVER_BI`
- AND `list_profiles` returns one entry with all existing fields populated.
