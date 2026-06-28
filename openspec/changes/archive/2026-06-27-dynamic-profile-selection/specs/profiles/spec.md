# Delta for profiles

## ADDED Requirements

### Requirement: Alias Defaulting

The system MUST accept an optional `DB_<NAME>_ALIAS` per profile. When unset, the alias MUST default to the operator key. `ProfileSummary.name` MUST equal `alias`. Both fields are agent-facing; the operator key MUST NOT appear in either when distinct from the alias.

#### Scenario: Alias defaults to operator key

- GIVEN `DB_SQLSERVER_BI_*` with no `DB_SQLSERVER_BI_ALIAS`
- WHEN the profile summary is built
- THEN alias equals `"SQLSERVER_BI"`
- AND `name` equals `"SQLSERVER_BI"`
- AND the operator key is not a separate field.

#### Scenario: Explicit alias overrides operator key

- GIVEN `DB_SQLSERVER_BI_ALIAS=bi_catastro`
- WHEN the profile loads
- THEN alias equals `"bi_catastro"`
- AND `name` equals `"bi_catastro"`
- AND the operator key stays server-side.

### Requirement: Alias Validation

The alias MUST match `^[A-Za-z0-9_]+$` and MUST be 1-64 characters. Any other value MUST fail startup with a non-leaking `ProfileError` naming the field.

#### Scenario: Invalid alias rejected

- GIVEN `DB_X_ALIAS=bi-catastro!`
- WHEN the server starts
- THEN `ProfileError` references the alias field
- AND host, user, password, or port do not appear.

### Requirement: Alias Uniqueness

The system MUST reject startup on duplicate aliases OR when one profile's alias equals another profile's operator key. The error MUST be non-leaking: it names the colliding alias and omits operator keys.

#### Scenario: Duplicate alias fails closed

- GIVEN two env blocks whose aliases both resolve to `bi_catastro`
- WHEN the server starts
- THEN `ProfileError("Duplicate alias 'bi_catastro'")`
- AND neither operator key is included.

#### Scenario: Alias collides with another profile's operator key

- GIVEN profile A alias `bi_catastro` (operator key `STAGING_SQL`) and profile B operator key `bi_catastro`
- WHEN the server starts
- THEN `ProfileError` names the colliding alias
- AND neither operator key appears.

### Requirement: Display Metadata

The system MUST accept optional `DB_<NAME>_DISPLAY_NAME`, `DB_<NAME>_DESCRIPTION`, and `DB_<NAME>_TAGS` (comma list). Tags MUST be trimmed; blanks removed. SHOULD accept `DB_<NAME>_CAPABILITIES`; default `["read-only"]`.

#### Scenario: Tags trimmed and deduped

- GIVEN `DB_X_TAGS="bi, finance, "`
- WHEN the profile loads
- THEN `tags` equals `["bi","finance"]`
- AND empty entries are dropped.

### Requirement: Secret Reference Resolution

Secret-bearing fields MUST support `${secret:file:/abs/path}`. The loader MUST resolve at startup via a `SecretProvider` interface. Resolved secrets MUST NOT appear in logs, errors, or `ProfileSummary`.

#### Scenario: File-based secret resolved at startup

- GIVEN `DB_X_PASSWORD=${secret:file:/run/secrets/db_pw}` and the file is readable
- WHEN the profile loads
- THEN the in-memory connection has the file contents
- AND the literal `${secret:file:...}` never appears in any log or error.

#### Scenario: Missing file fails non-leaking

- GIVEN `DB_X_PASSWORD=${secret:file:/missing}` and the file does not exist
- WHEN the profile loads
- THEN `ProfileError` names the alias and kind (`file`)
- AND the file path, host, user, password, or port do not appear.

### Requirement: Non-Leaking ProfileError

`ProfileError` messages MUST NOT include host, user, password, port, raw secret references, or operator keys distinct from the alias. `sanitizeError` is the single masking point.

#### Scenario: Connection error masked

- GIVEN a profile whose password fails to authenticate
- WHEN the loader raises the underlying error
- THEN the message is run through `sanitizeError`
- AND host, user, port, and password do not appear verbatim.

### Requirement: Backward Compatibility

All new env vars MUST be optional. Legacy `.env` files MUST continue to load. The `profile` argument MUST accept the operator key as alias synonym.

#### Scenario: Legacy env still loads

- GIVEN a `.env` with only `DB_SQLSERVER_BI_*` connection vars
- WHEN the server starts
- THEN the profile loads with alias `SQLSERVER_BI`
- AND `list_profiles` returns one entry with all existing fields.
