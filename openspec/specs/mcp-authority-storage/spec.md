# mcp-authority-storage Specification

## Purpose

SQLite storage layer backing `apps/mcp-oauth-admin`. Persists agents, OAuth clients, scopes, signing keys, refresh tokens, and the audit log. Uses WAL mode, single-writer (the authority process), and ships a backup story.

## Requirements

### Requirement: SQLite Database Location

Single SQLite file at `./data/mcp-oauth.sqlite` relative to the authority's working directory. Path overridable via `MCP_OAUTH_DB_PATH`. Parent directory created on first start. Opened in WAL journal mode with `foreign_keys=ON` per connection.

#### Scenario: Paths and pragmas

- GIVEN no `MCP_OAUTH_DB_PATH` OR `MCP_OAUTH_DB_PATH=/var/lib/mcp/auth.sqlite`
- WHEN the authority starts
- THEN the database is `./data/mcp-oauth.sqlite` OR the override path, the parent is created if missing, `journal_mode=wal`, and `PRAGMA foreign_keys` returns `1`.

### Requirement: Schema

The schema MUST include the tables below. Foreign keys enforced; cascading deletes MUST NOT silently remove audit rows.

| Table | Key columns (type) | Notes |
|-------|-------------------|-------|
| `users` | `id` PK, `username` UNIQUE, `passwordHash`, `scopes` JSON, `enabled` 0/1, `requireChangeOnFirstLogin` 0/1, `createdAt`, `lastLoginAt` | Agents + admin |
| `clients` | `id` PK, `clientId` UNIQUE, `clientSecretHash`, `label`, `scopes` JSON, `createdAt`, `lastUsedAt` | OAuth clients |
| `scopes` | `name` PK, `description`, `createdAt` | Scope catalog |
| `keys` | `id` PK = `kid`, `algorithm=RS256`, `publicJwk` JSON, `privatePem`, `createdAt`, `expiresAt` | Signing keys |
| `refresh_tokens` | `id` PK, `agentId` FK, `clientId` FK, `scopes` JSON, `tokenHash` UNIQUE, `issuedAt`, `revokedAt` | Refresh tokens |
| `audit_log` | `id` PK AUTOINCREMENT, `ts`, `actor`, `action`, `target`, `ip`, `outcome` | Audit trail |
| `login_backoff` | `username` PK, `failCount`, `firstFailureAt`, `lockedUntil` | Per-username backoff |

#### Scenario: Schema applied and audit survives delete

- GIVEN a fresh database file OR an agent is deleted
- WHEN the authority starts OR the operator inspects `audit_log`
- THEN all seven tables exist with `PRAGMA foreign_keys=1`, and historical `actor=agent:<id>` rows remain with `audit_log.actor` as free-text, not a FK.

### Requirement: Single-Writer Discipline

The authority is the only process that opens the SQLite file in write mode. Resource servers MUST NOT open this file. The authority uses a single connection (or a small pool with a serialized writer) and serializes all write transactions through one mutex. Read transactions MAY use a separate connection. Detects `SQLITE_BUSY` and retries up to 5 times with exponential backoff; a 6th failure exits non-zero.

#### Scenario: Single-writer enforcement and retry budget

- GIVEN a resource server with `MCP_AUTHORITY_URL` set OR the 5 retries all fail
- WHEN the operator inspects its imports OR the 6th attempt is made
- THEN the resource server does not import `better-sqlite3` or `sqlite3` and does not open the authority's SQLite file, OR the process exits non-zero and stderr names the SQL operation and the busy timeout.

### Requirement: Backup Story

Backup mode triggered by `MCP_OAUTH_BACKUP_TARGET`. When set, the authority uses SQLite's online backup API to copy the live database to the target path while the database remains in use. Backup is atomic at the file level; a partial backup MUST NOT be visible. Backup runs at startup and at every `MCP_OAUTH_BACKUP_INTERVAL_S` (default `86400`) thereafter. Target directory created if missing.

#### Scenario: Online backup and atomic replacement

- GIVEN `MCP_OAUTH_BACKUP_TARGET=/var/backups/mcp-oauth.sqlite`
- WHEN the authority starts
- THEN the live database is copied via the online backup API, the live database continues to serve traffic, and a partial file is never observed at the target.

### Requirement: Retention Sweep

Daily retention sweep deletes `audit_log` rows older than 90 days and `refresh_tokens` rows whose `revokedAt` is older than 30 days. Runs once per 24 hours, logged at `INFO`, and MUST NOT block reads for more than 1 second. Skippable via `MCP_OAUTH_DISABLE_RETENTION_SWEEP=true`.

#### Scenario: Daily sweep and disable

- GIVEN an audit row whose `ts` is 91 days old OR `MCP_OAUTH_DISABLE_RETENTION_SWEEP=true`
- WHEN the daily sweep runs OR 24 hours elapse
- THEN the row is deleted with an `INFO` log count, OR the sweep does not run.
