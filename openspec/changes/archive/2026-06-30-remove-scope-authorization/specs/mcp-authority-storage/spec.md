# Delta for mcp-authority-storage

## MODIFIED Requirements

### Requirement: Schema

The schema MUST include the tables below. Foreign keys enforced; cascading deletes MUST NOT silently remove audit rows.

| Table | Key columns (type) | Notes |
|-------|-------------------|-------|
| `users` | `id` PK, `username` UNIQUE, `passwordHash`, `scopes` JSON (legacy/inert), `enabled` 0/1, `requireChangeOnFirstLogin` 0/1, `createdAt`, `lastLoginAt` | Agents + admin. The `scopes` column is retained for backward compatibility; the runtime MUST NOT use it for authorization. |
| `clients` | `id` PK, `clientId` UNIQUE, `clientSecretHash`, `label`, `scopes` JSON (legacy/inert), `createdAt`, `lastUsedAt` | OAuth clients. The `scopes` column is retained for backward compatibility; the runtime MUST NOT use it for authorization. |
| `scopes` | `name` PK, `description`, `createdAt` | **Legacy/inert.** Retained for backward compatibility; the authority MUST NOT write new rows and MUST NOT consult this table for authorization. |
| `keys` | `id` PK = `kid`, `algorithm=RS256`, `publicJwk` JSON, `privatePem`, `createdAt`, `expiresAt` | Signing keys |
| `refresh_tokens` | `id` PK, `agentId` FK, `clientId` FK, `scopes` JSON (legacy/inert), `tokenHash` UNIQUE, `issuedAt`, `revokedAt` | Refresh tokens. The `scopes` column is retained for backward compatibility; the authority MUST NOT use its value when minting a new access token — the new access token omits the `scope` and `scopes` claims regardless of what is stored. |
| `audit_log` | `id` PK AUTOINCREMENT, `ts`, `actor`, `action`, `target`, `ip`, `outcome` | Audit trail |
| `login_backoff` | `username` PK, `failCount`, `firstFailureAt`, `lockedUntil` | Per-username backoff |

(Previously: the `scopes` column on each table and the `scopes` table were authoritative. Now: legacy/inert, retained for compatibility.)

#### Scenario: Schema applied and audit survives delete

- GIVEN a fresh database file OR an agent is deleted
- WHEN the authority starts OR the operator inspects `audit_log`
- THEN all seven tables exist with `PRAGMA foreign_keys=1`, and historical `actor=agent:<id>` rows remain with `audit_log.actor` as free-text, not a FK.

#### Scenario: Legacy scopes columns and table are inert

- GIVEN an existing database with rows in `users.scopes`, `clients.scopes`, `refresh_tokens.scopes`, and `scopes`
- WHEN the authority starts and serves traffic
- THEN the legacy values are not read to make any authorization decision
- AND the schema is unchanged (no destructive migration has been applied)
- AND the same database file is still readable by the next version of the authority.

## ADDED Requirements

### Requirement: No Destructive Migration For Scope Columns

The authority MUST NOT ship a migration that drops the `scopes` JSON columns on `users`, `clients`, or `refresh_tokens`, and MUST NOT drop the `scopes` table. The columns and table are retained as legacy/inert storage. Any future removal of these artifacts is a separate change that requires its own SDD cycle and operator opt-in.
(Previously: the proposal noted destructive migrations as out of scope. This requirement enforces that boundary explicitly.)

#### Scenario: No DROP COLUMN / DROP TABLE in migrations

- GIVEN the authority's migration files
- WHEN the operator greps the migrations for `DROP COLUMN` or `DROP TABLE` on `scopes`
- THEN no match exists
- AND a fresh `pnpm install && start` against an existing database file works without manual SQL.

#### Scenario: Existing refresh token with stored scopes mints full-access token

- GIVEN a refresh token row whose `scopes` column contains `["read:bi_catastro"]` from a prior deployment
- WHEN `grant_type=refresh_token` is exchanged
- THEN the response is `200` with a new JWT whose payload MUST NOT include a `scope` or `scopes` claim
- AND the resulting access token grants access to any tool subject only to the non-scope safety controls
- AND the `scopes` value stored on the refresh token row is not used to gate the new access token (this is the intended post-change policy).
