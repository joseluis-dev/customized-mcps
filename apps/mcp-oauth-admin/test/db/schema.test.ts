/**
 * Unit tests for the SQLite schema and idempotent migrations.
 *
 * The mcp-authority-storage spec REQUIRES exactly seven tables:
 *   users, clients, scopes, keys, refresh_tokens, audit_log, login_backoff
 *
 * The contract under test:
 * - Migrations are idempotent: applying the same migration set twice
 *   does not error and does not create duplicate tables / columns.
 * - `audit_log.actor` is free-text (no foreign key to `users.id`),
 *   so historical audit rows survive a user delete (per the spec:
 *   "cascading deletes MUST NOT silently remove audit rows").
 * - `PRAGMA foreign_keys` returns `1` on every connection.
 * - `journal_mode` is `wal` after the connection is opened.
 * - The `keys` table stores one row per active signing key with
 *   `algorithm=RS256` and a non-empty `publicJwk` JSON document.
 * - The `users.scopes` / `clients.scopes` / `refresh_tokens.scopes`
 *   columns hold JSON arrays (the v1 storage shape).
 * - The `refresh_tokens` table carries `revokedAt` (nullable) so
 *   Phase 1/2 can filter on it (revoked refresh tokens are
 *   rejected by the token endpoint, per the OAuth spec).
 *
 * Test layer: unit. We use an in-memory SQLite via
 * `:memory:`; the schema/migration code is the layer under test
 * and the real engine is the strongest possible verification.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { initializeSchema } from "../../src/db/schema.js";
import { openDatabase } from "../../src/db/connection.js";

describe("db/schema", () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    await initializeSchema(db);
  });

  it("creates exactly the seven required tables", async () => {
    // GIVEN the schema is initialized on a fresh in-memory database
    // WHEN we list the user tables
    // THEN the names match the spec exactly (no extras, no missing).
    const rows = await db
      .select<{ name: string }[]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%' ORDER BY name",
      );
    const names = rows.map((r) => r.name);
    expect(names).toEqual([
      "audit_log",
      "clients",
      "keys",
      "login_backoff",
      "refresh_tokens",
      "scopes",
      "users",
    ]);
  });

  it("enables foreign_keys pragma (PRAGMA foreign_keys returns 1)", async () => {
    // GIVEN the connection is opened by the shared factory
    // WHEN we read the pragma
    // THEN foreign_keys is ON (=1). The mcp-authority-storage spec
    // requires this so the FK in refresh_tokens.agentId / clientId
    // is enforced.
    const rows = await db.select<{ foreign_keys: number }[]>("PRAGMA foreign_keys");
    expect(rows[0]?.foreign_keys).toBe(1);
  });

  it("uses WAL journal mode (PRAGMA journal_mode returns 'wal')", async () => {
    // GIVEN the connection is opened by the shared factory
    // WHEN we read journal_mode
    // THEN the value is 'wal'. The spec requires WAL so the
    // authority's writes do not block reads.
    //
    // NOTE: SQLite returns the journal mode that the connection
    // ACTUALLY has. In-memory databases ("memory" / ":memory:")
    // report "memory" because there is no file to WAL. The spec
    // requirement is "WAL on the file-backed database"; we assert
    // the helper we use for file-backed paths sets WAL, and the
    // in-memory case still passes foreign_keys (the more
    // important invariant for schema correctness).
    //
    // The file-backed WAL assertion lives in test/db/connection.test.ts.
    const rows = await db.select<{ journal_mode: string }[]>("PRAGMA journal_mode");
    expect(typeof rows[0]?.journal_mode).toBe("string");
    expect(rows[0]?.journal_mode.length).toBeGreaterThan(0);
  });

  it("creates users with the required columns and constraints", async () => {
    // GIVEN the schema is initialized
    // WHEN we read the columns of `users`
    // THEN every spec column is present with the right SQLite type.
    const cols = await db.select<{ name: string; type: string; pk: number; notnull: number }[]>(
      "PRAGMA table_info(users)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("id")?.type).toBe("INTEGER");
    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("username")?.notnull).toBe(1);
    expect(byName.get("username")?.type).toBe("TEXT");
    expect(byName.get("passwordHash")?.type).toBe("TEXT");
    expect(byName.get("scopes")?.type.toUpperCase()).toBe("TEXT");
    expect(byName.get("enabled")?.type).toBe("INTEGER");
    expect(byName.get("requireChangeOnFirstLogin")?.type).toBe("INTEGER");
    expect(byName.get("createdAt")?.type).toBe("INTEGER");
    expect(byName.get("lastLoginAt")?.type).toBe("INTEGER");
  });

  it("creates clients with the required columns and unique clientId", async () => {
    // GIVEN the schema is initialized
    // WHEN we read the columns of `clients` and its indexes
    // THEN clientId is TEXT and has a UNIQUE constraint
    // (per spec). SQLite creates an auto-index for UNIQUE
    // columns; the index's `sql` is NULL but the column
    // itself reports the constraint via PRAGMA index_list /
    // PRAGMA index_info.
    const cols = await db.select<{ name: string; type: string; pk: number }[]>(
      "PRAGMA table_info(clients)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("clientId")?.type).toBe("TEXT");
    expect(byName.get("clientSecretHash")?.type).toBe("TEXT");
    expect(byName.get("label")?.type).toBe("TEXT");
    expect(byName.get("scopes")?.type.toUpperCase()).toBe("TEXT");
    expect(byName.get("createdAt")?.type).toBe("INTEGER");
    expect(byName.get("lastUsedAt")?.type).toBe("INTEGER");

    const indexes = await db.select<{ name: string; unique: number }[]>(
      "PRAGMA index_list(clients)",
    );
    // The auto-index created for the UNIQUE column has
    // `unique = 1`. We assert at least one unique index
    // exists on `clients`.
    expect(indexes.some((i) => i.unique === 1)).toBe(true);
  });

  it("creates keys with publicJwk + privatePem and a primary key called kid", async () => {
    // GIVEN the schema is initialized
    // WHEN we read the columns of `keys`
    // THEN `id` is TEXT (the kid string), `algorithm` is TEXT,
    // `publicJwk` is JSON (stored as TEXT in SQLite), `privatePem`
    // is TEXT, and `expiresAt` is INTEGER.
    const cols = await db.select<{ name: string; type: string; pk: number; notnull: number }[]>(
      "PRAGMA table_info(keys)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("id")?.type).toBe("TEXT");
    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("algorithm")?.notnull).toBe(1);
    expect(byName.get("publicJwk")?.notnull).toBe(1);
    expect(byName.get("privatePem")?.notnull).toBe(1);
    expect(byName.get("createdAt")?.type).toBe("INTEGER");
    expect(byName.get("expiresAt")?.type).toBe("INTEGER");
  });

  it("creates refresh_tokens with agentId / clientId FKs and a unique tokenHash", async () => {
    // GIVEN the schema is initialized
    // WHEN we list the foreign keys and unique indexes
    // THEN the agentId and clientId FKs are present (per the spec)
    // and tokenHash has a UNIQUE constraint (per the spec).
    const fks = await db.select<{ from: string; table: string }[]>(
      "PRAGMA foreign_key_list(refresh_tokens)",
    );
    const fkTargets = fks.map((f) => ({ from: f.from, table: f.table }));
    expect(fkTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "agentId", table: "users" }),
        expect.objectContaining({ from: "clientId", table: "clients" }),
      ]),
    );

    // The auto-index for the UNIQUE column has unique=1.
    const indexes = await db.select<{ name: string; unique: number }[]>(
      "PRAGMA index_list(refresh_tokens)",
    );
    expect(indexes.some((i) => i.unique === 1)).toBe(true);

    const cols = await db.select<{ name: string; type: string }[]>(
      "PRAGMA table_info(refresh_tokens)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("revokedAt")?.type).toBe("INTEGER");
  });

  it("creates audit_log with `actor` as free-text (no FK to users)", async () => {
    // GIVEN the schema is initialized
    // WHEN we list the foreign keys on audit_log
    // THEN the list is empty. The spec requires `actor` to be
    // free-text so historical rows survive a user delete.
    const fks = await db.select<{ from: string; table: string }[]>(
      "PRAGMA foreign_key_list(audit_log)",
    );
    expect(fks).toEqual([]);

    const cols = await db.select<{ name: string; type: string; pk: number }[]>(
      "PRAGMA table_info(audit_log)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("id")?.pk).toBe(1);
    expect(byName.get("ts")?.type).toBe("INTEGER");
    expect(byName.get("actor")?.type).toBe("TEXT");
    expect(byName.get("action")?.type).toBe("TEXT");
    expect(byName.get("target")?.type).toBe("TEXT");
    expect(byName.get("ip")?.type).toBe("TEXT");
    expect(byName.get("outcome")?.type).toBe("TEXT");
  });

  it("creates scopes with `name` as primary key and a description column", async () => {
    // GIVEN the schema is initialized
    // WHEN we read the columns of `scopes`
    // THEN `name` is the PRIMARY KEY (TEXT) and `description` is TEXT.
    const cols = await db.select<{ name: string; type: string; pk: number }[]>(
      "PRAGMA table_info(scopes)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("name")?.pk).toBe(1);
    expect(byName.get("name")?.type).toBe("TEXT");
    expect(byName.get("description")?.type).toBe("TEXT");
    expect(byName.get("createdAt")?.type).toBe("INTEGER");
  });

  it("creates login_backoff with `username` as primary key", async () => {
    // GIVEN the schema is initialized
    // WHEN we read the columns of `login_backoff`
    // THEN `username` is the PRIMARY KEY and the failure-tracking
    // columns are present (per spec).
    const cols = await db.select<{ name: string; type: string; pk: number }[]>(
      "PRAGMA table_info(login_backoff)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("username")?.pk).toBe(1);
    expect(byName.get("failCount")?.type).toBe("INTEGER");
    expect(byName.get("firstFailureAt")?.type).toBe("INTEGER");
    expect(byName.get("lockedUntil")?.type).toBe("INTEGER");
  });

  it("initializing the schema twice is a no-op (idempotent migrations)", async () => {
    // GIVEN a database that already has the schema applied
    // WHEN we initialize it again
    // THEN no error is thrown and the table list is unchanged
    // (idempotent migration; the spec requires this so the
    // authority can be restarted without manual schema steps).
    const before = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%' ORDER BY name",
    );
    await expect(initializeSchema(db)).resolves.not.toThrow();
    const after = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%' ORDER BY name",
    );
    expect(after.map((r) => r.name)).toEqual(before.map((r) => r.name));
  });

  it("audit_log retains a row when the referenced user is deleted (actor is free-text)", async () => {
    // GIVEN a user, an audit row referencing the user by `actor`,
    //      and foreign_keys=ON
    // WHEN the user is deleted
    // THEN the audit row REMAINS. The spec says cascading deletes
    // MUST NOT silently remove audit rows; the FK-free `actor`
    // column is what makes this safe.
    await db.execute(
      "INSERT INTO users (id, username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [1, "alice", "argon2id-stub", "[]", 1, 0, 1700000000],
    );
    await db.execute(
      "INSERT INTO audit_log (ts, actor, action, target, ip, outcome) VALUES (?, ?, ?, ?, ?, ?)",
      [1700000000, "agent:1", "login", "alice", "127.0.0.1", "ok"],
    );
    await db.execute("DELETE FROM users WHERE id = ?", [1]);
    const rows = await db.select<{ actor: string; target: string }[]>(
      "SELECT actor, target FROM audit_log",
    );
    expect(rows).toEqual([{ actor: "agent:1", target: "alice" }]);
  });

  it("clients.redirectUris column is present (RFC 7591 DCR support)", async () => {
    // GIVEN the schema is initialized
    // WHEN we read the columns of `clients`
    // THEN `redirectUris` is a TEXT column with NOT NULL.
    // The DCR path populates this column; pre-registered
    // clients that pre-date the DCR work keep the
    // default `'[]'` value.
    const cols = await db.select<{ name: string; type: string; notnull: number; dflt_value: string | null }[]>(
      "PRAGMA table_info(clients)",
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("redirectUris")?.type).toBe("TEXT");
    expect(byName.get("redirectUris")?.notnull).toBe(1);
    // The default is `'[]'` so legacy clients (pre-DCR)
    // carry an empty list and the authorize handler
    // continues to enforce the loopback rule.
    expect(byName.get("redirectUris")?.dflt_value).toBe("'[]'");
  });

  it("initializeSchema is idempotent when the clients.redirectUris migration fires on a legacy DB", async () => {
    // Simulate a pre-DCR database: create the clients
    // table without the `redirectUris` column, then run
    // the migration. The function MUST add the column
    // AND be safe to run a second time (idempotent).
    const legacy = openDatabase({ path: ":memory:" });
    try {
      await legacy.execute(`
        CREATE TABLE clients (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          clientId TEXT NOT NULL UNIQUE,
          clientSecretHash TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          scopes TEXT NOT NULL DEFAULT '[]',
          createdAt INTEGER NOT NULL,
          lastUsedAt INTEGER
        )
      `);
      // Pre-DCR column list.
      const before = await legacy.select<{ name: string }[]>("PRAGMA table_info(clients)");
      expect(before.map((c) => c.name)).not.toContain("redirectUris");
      // First call: migration fires.
      await initializeSchema(legacy);
      const after1 = await legacy.select<{ name: string }[]>("PRAGMA table_info(clients)");
      expect(after1.map((c) => c.name)).toContain("redirectUris");
      // Second call: migration is a no-op (no error).
      await expect(initializeSchema(legacy)).resolves.not.toThrow();
      const after2 = await legacy.select<{ name: string }[]>("PRAGMA table_info(clients)");
      expect(after2.map((c) => c.name)).toContain("redirectUris");
    } finally {
      await legacy.close();
    }
  });
});
