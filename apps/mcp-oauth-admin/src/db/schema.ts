/**
 * SQLite schema and idempotent migrations for the OAuth2 authority.
 *
 * The mcp-authority-storage spec REQUIRES exactly seven tables:
 *   users, clients, scopes, keys, refresh_tokens, audit_log, login_backoff
 *
 * The contract under test (in test/db/schema.test.ts):
 * - All seven tables exist after `initializeSchema` runs.
 * - `PRAGMA foreign_keys=1` (enforced by openDatabase).
 * - `audit_log.actor` is free-text (NO FK to users.id), so a
 *   user delete cannot cascade-remove historical audit rows.
 * - `keys.id` is the `kid` string (TEXT PK).
 * - `users.username`, `clients.clientId`, `login_backoff.username`
 *   are UNIQUE / PRIMARY KEYs.
 * - `refresh_tokens.agentId` and `clientId` are FKs; `tokenHash`
 *   is UNIQUE.
 * - Re-running `initializeSchema` is a no-op.
 *
 * The schema is applied as raw SQL. The migration set is small
 * enough (one file) that we do not need a knex migrations
 * directory; `initializeSchema` is the single source of truth.
 * The CREATE TABLE statements use `IF NOT EXISTS` so the
 * function is idempotent on a re-run.
 */

import type { AuthorityDatabase } from "./connection.js";

/**
 * Apply the schema. The function is idempotent: it uses
 * `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
 * so re-running it on a populated database is a no-op.
 */
export async function initializeSchema(db: AuthorityDatabase): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.execute(statement);
  }
}

/**
 * The full schema, expressed as a sequence of `CREATE ... IF
 * NOT EXISTS` statements. The order matters: tables with FKs
 * (refresh_tokens, login_backoff) MUST come after the tables
 * they reference (users, clients).
 *
 * Types are SQLite-native:
 * - `INTEGER` for booleans (0/1) and timestamps (unix seconds).
 * - `TEXT` for everything else; JSON columns are stored as TEXT
 *   and validated at the application layer (knex-style TEXT
 *   columns are the standard SQLite idiom for JSON).
 *
 * `audit_log.actor` is deliberately `TEXT` with no FK: the spec
 * requires that audit rows survive a user delete.
 */
const SCHEMA_STATEMENTS: string[] = [
  // users — agents + admin. JSON `scopes` column holds the
  // granted scope set as a string array.
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    requireChangeOnFirstLogin INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    lastLoginAt INTEGER
  )`,

  // clients — OAuth2 client_id + client_secret hash + scopes.
  `CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clientId TEXT NOT NULL UNIQUE,
    clientSecretHash TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    scopes TEXT NOT NULL DEFAULT '[]',
    createdAt INTEGER NOT NULL,
    lastUsedAt INTEGER
  )`,

  // scopes — the scope catalog. `name` is the primary key and
  // follows the SCOPE_PATTERN grammar (validated at the
  // application layer).
  `CREATE TABLE IF NOT EXISTS scopes (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL
  )`,

  // keys — signing keys. `id` is the kid string; `publicJwk`
  // is the public JWK document (no private material); the
  // private key is held in `privatePem` and NEVER leaves the
  // process.
  `CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    algorithm TEXT NOT NULL DEFAULT 'RS256',
    publicJwk TEXT NOT NULL,
    privatePem TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER
  )`,

  // refresh_tokens — agentId / clientId are FKs; tokenHash is
  // unique (we store the SHA-256 of the plaintext token, never
  // the plaintext). `revokedAt` is non-null when an admin or
  // rotation flow revoked the token.
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agentId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clientId INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    scopes TEXT NOT NULL DEFAULT '[]',
    tokenHash TEXT NOT NULL UNIQUE,
    issuedAt INTEGER NOT NULL,
    revokedAt INTEGER
  )`,

  // audit_log — append-only audit trail. `actor` is FREE TEXT
  // (no FK), so a user delete cannot cascade-remove historical
  // rows. The Phase 1/2 retention sweep deletes rows older than
  // 90 days (per spec).
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    outcome TEXT NOT NULL
  )`,

  // login_backoff — per-username failure counter. `username` is
  // the PRIMARY KEY; the admin login form checks `lockedUntil`
  // before authenticating (5 fails / 10m → 429).
  `CREATE TABLE IF NOT EXISTS login_backoff (
    username TEXT PRIMARY KEY,
    failCount INTEGER NOT NULL DEFAULT 0,
    firstFailureAt INTEGER,
    lockedUntil INTEGER
  )`,

  // Helpful indexes for the hot read paths. These are idempotent
  // (CREATE INDEX IF NOT EXISTS) so re-running the schema is
  // safe.
  `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_agent ON refresh_tokens(agentId)`,
  `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_client ON refresh_tokens(clientId)`,
  `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_revokedAt ON refresh_tokens(revokedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor)`,
];
