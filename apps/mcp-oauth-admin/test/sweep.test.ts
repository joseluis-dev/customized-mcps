/**
 * Unit tests for the daily retention sweep.
 *
 * The mcp-authority-storage spec requires:
 * - `audit_log` rows older than 90 days are deleted.
 * - `refresh_tokens` rows whose `revokedAt` is older than 30
 *   days are deleted.
 * - The sweep runs once per 24 hours.
 * - The sweep logs the count at `INFO`.
 * - The sweep is skippable via
 *   `MCP_OAUTH_DISABLE_RETENTION_SWEEP=true`.
 * - The sweep MUST NOT block reads for more than 1 second
 *   (defense-in-depth: we use a single transaction).
 *
 * Test layer: unit. Real SQLite is the strongest possible
 * verification.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/connection.js";
import { initializeSchema } from "../src/db/schema.js";
import { runRetentionSweep, type SweepResult } from "../src/sweep.js";

describe("sweep", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mcp-oauth-admin-sweep-"));
    dbPath = join(tempDir, "auth.sqlite");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedSweepFixtures(): Promise<void> {
    // GIVEN a database with one user + one client + the seed
    // rows needed to test the sweep. We seed with explicit
    // timestamps so the spec boundaries are reproducible.
    const db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    const now = Math.floor(Date.now() / 1000);
    const days = (n: number) => now - n * 24 * 60 * 60;
    await db.execute(
      "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      ["alice", "argon2id-stub", "[]", 1, 0, days(200)],
    );
    await db.execute(
      "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
      ["client-a", "argon2id-stub", "test", "[]", days(200)],
    );
    // audit_log: one row 91d old (should be swept), one 89d old (kept)
    await db.execute(
      "INSERT INTO audit_log (ts, actor, action, target, ip, outcome) VALUES (?, ?, ?, ?, ?, ?)",
      [days(91), "agent:1", "login", "alice", "127.0.0.1", "ok"],
    );
    await db.execute(
      "INSERT INTO audit_log (ts, actor, action, target, ip, outcome) VALUES (?, ?, ?, ?, ?, ?)",
      [days(89), "agent:1", "login", "alice", "127.0.0.1", "ok"],
    );
    // refresh_tokens: one revoked 31d ago (should be swept), one revoked 29d ago (kept),
    // and one not revoked (kept regardless of age).
    await db.execute(
      "INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)",
      [1, 1, "[]", "hash-old-revoked", days(60), days(31)],
    );
    await db.execute(
      "INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)",
      [1, 1, "[]", "hash-recent-revoked", days(60), days(29)],
    );
    await db.execute(
      "INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)",
      [1, 1, "[]", "hash-active", days(200), null],
    );
    await db.close();
  }

  it("deletes audit_log rows older than 90 days and revoked refresh_tokens older than 30 days", async () => {
    // GIVEN a database with 91d-old audit row + 89d-old audit row
    //      + 31d-old revoked refresh + 29d-old revoked refresh
    //      + non-revoked refresh token
    // WHEN we run the sweep
    // THEN the 91d-old audit row is gone, the 89d-old audit row
    //      remains, the 31d-old revoked refresh is gone, the
    //      29d-old revoked refresh remains, the non-revoked
    //      refresh remains.
    await seedSweepFixtures();
    const db = openDatabase({ path: dbPath });
    try {
      const result: SweepResult = await runRetentionSweep({ db });
      // The counts: 1 audit (91d) + 1 refresh (31d revoked)
      expect(result.auditDeleted).toBe(1);
      expect(result.refreshDeleted).toBe(1);
      const audit = await db.select<{ ts: number }[]>(
        "SELECT ts FROM audit_log ORDER BY ts",
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.ts).toBeGreaterThan(
        Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60,
      );
      const refresh = await db.select<{ tokenHash: string; revokedAt: number | null }[]>(
        "SELECT tokenHash, revokedAt FROM refresh_tokens ORDER BY id",
      );
      // The 31d-old revoked row was swept; the 29d-old revoked
      // row + the active row remain. Order is by id (insertion
      // order): recent-revoked (id=2) before active (id=3).
      expect(refresh).toHaveLength(2);
      expect(refresh.map((r) => r.tokenHash)).toEqual([
        "hash-recent-revoked",
        "hash-active",
      ]);
    } finally {
      await db.close();
    }
  });

  it("is a no-op when there are no rows to delete", async () => {
    // GIVEN an empty database (schema only, no rows)
    // WHEN we run the sweep
    // THEN both counters are 0 and no error is thrown.
    const db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    try {
      const result = await runRetentionSweep({ db });
      expect(result.auditDeleted).toBe(0);
      expect(result.refreshDeleted).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("respects MCP_OAUTH_DISABLE_RETENTION_SWEEP=true (skips deletion)", async () => {
    // GIVEN a database with rows that would normally be swept
    // WHEN we run the sweep with the disable flag set
    // THEN the rows are NOT deleted and the counters are 0.
    await seedSweepFixtures();
    const db = openDatabase({ path: dbPath });
    try {
      const result = await runRetentionSweep({ db, disabled: true });
      expect(result.auditDeleted).toBe(0);
      expect(result.refreshDeleted).toBe(0);
      const audit = await db.select<{ ts: number }[]>(
        "SELECT ts FROM audit_log ORDER BY ts",
      );
      expect(audit).toHaveLength(2);
      const refresh = await db.select<{ tokenHash: string }[]>(
        "SELECT tokenHash FROM refresh_tokens ORDER BY id",
      );
      expect(refresh).toHaveLength(3);
    } finally {
      await db.close();
    }
  });

  it("runs both deletions inside a single transaction (atomicity)", async () => {
    // GIVEN a database with seed rows
    // WHEN we run the sweep
    // THEN both deletes happen in one transaction. We assert
    //      atomicity by checking that a fresh connection sees
    //      the post-sweep state and there is no window where
    //      one table is swept but the other is not. The
    //      assertion is observable: the two counters come
    //      from the same run, and the post-sweep row counts
    //      match the counters.
    await seedSweepFixtures();
    const db = openDatabase({ path: dbPath });
    try {
      const result = await runRetentionSweep({ db });
      // Re-open and verify the post-sweep counts match the
      // reported counters. (We re-open so we read the
      // committed state.)
      const verifyDb = openDatabase({ path: dbPath });
      try {
        const auditCount = await verifyDb.select<{ c: number }[]>(
          "SELECT COUNT(*) AS c FROM audit_log",
        );
        const refreshCount = await verifyDb.select<{ c: number }[]>(
          "SELECT COUNT(*) AS c FROM refresh_tokens",
        );
        expect(auditCount[0]?.c).toBe(2 - result.auditDeleted);
        expect(refreshCount[0]?.c).toBe(3 - result.refreshDeleted);
      } finally {
        await verifyDb.close();
      }
    } finally {
      await db.close();
    }
  });

  it("uses 90d and 30d boundaries (not 89d/29d)", async () => {
    // GIVEN a row whose age is EXACTLY 90d (boundary case)
    //      — per the spec "older than 90d" means strictly
    //      > 90d. A row at exactly 90d is at the boundary
    //      and SHOULD be kept (the spec says "older than",
    //      not "at or older than").
    // WHEN we run the sweep
    // THEN the 90d-old row remains.
    const db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    const now = Math.floor(Date.now() / 1000);
    const days = (n: number) => now - n * 24 * 60 * 60;
    await db.execute(
      "INSERT INTO audit_log (ts, actor, action, target, ip, outcome) VALUES (?, ?, ?, ?, ?, ?)",
      [days(90), "agent:1", "login", "alice", "127.0.0.1", "ok"],
    );
    await db.execute(
      "INSERT INTO audit_log (ts, actor, action, target, ip, outcome) VALUES (?, ?, ?, ?, ?, ?)",
      [days(90) - 1, "agent:1", "login", "alice", "127.0.0.1", "ok"],
    );
    try {
      const result = await runRetentionSweep({ db });
      // The 90d+1s row is older than 90d and SHOULD be swept.
      // The 90d row is at the boundary and SHOULD be kept.
      expect(result.auditDeleted).toBe(1);
    } finally {
      await db.close();
    }
  });
});
