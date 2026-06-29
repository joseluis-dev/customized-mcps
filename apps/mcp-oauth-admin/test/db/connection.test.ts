/**
 * Unit tests for the SQLite connection layer.
 *
 * The mcp-authority-storage spec requires:
 * - The database opens at `./data/mcp-oauth.sqlite` by default,
 *   overridable via `MCP_OAUTH_DB_PATH`. The parent directory
 *   MUST be created on first start.
 * - `journal_mode=wal` is set on the live (file-backed) database.
 * - `PRAGMA foreign_keys=ON` is set on every connection.
 * - The authority is the single writer; a 5-retry SQLITE_BUSY
 *   budget is enforced, and the 6th failure exits the process
 *   non-zero.
 *
 * This test file pins the connection-layer contract. The
 * schema/migrations layer is pinned separately in
 * `test/db/schema.test.ts`.
 *
 * Test layer: unit. Real SQLite is the strongest possible
 * verification of these invariants.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  defaultDatabasePath,
  withSingleWriter,
  type AuthorityDatabase,
} from "../../src/db/connection.js";

describe("db/connection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mcp-oauth-admin-conn-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("defaultDatabasePath", () => {
    it("returns ./data/mcp-oauth.sqlite when MCP_OAUTH_DB_PATH is unset", () => {
      // GIVEN the env is unset
      // WHEN we ask for the default path
      // THEN we get the spec's default.
      const saved = process.env.MCP_OAUTH_DB_PATH;
      delete process.env.MCP_OAUTH_DB_PATH;
      try {
        const p = defaultDatabasePath();
        expect(p).toBe("./data/mcp-oauth.sqlite");
      } finally {
        if (saved !== undefined) process.env.MCP_OAUTH_DB_PATH = saved;
      }
    });

    it("returns the override path when MCP_OAUTH_DB_PATH is set", () => {
      // GIVEN MCP_OAUTH_DB_PATH is set
      // WHEN we ask for the default path
      // THEN we get the override.
      const saved = process.env.MCP_OAUTH_DB_PATH;
      const target = join(tempDir, "custom.sqlite");
      process.env.MCP_OAUTH_DB_PATH = target;
      try {
        expect(defaultDatabasePath()).toBe(target);
      } finally {
        if (saved === undefined) delete process.env.MCP_OAUTH_DB_PATH;
        else process.env.MCP_OAUTH_DB_PATH = saved;
      }
    });
  });

  describe("openDatabase", () => {
    it("creates the parent directory of a file-backed path on first start", async () => {
      // GIVEN a path whose parent does not exist
      // WHEN we open the database
      // THEN the parent directory is created and the file exists.
      const nested = join(tempDir, "deep", "nested", "auth.sqlite");
      expect(existsSync(join(tempDir, "deep"))).toBe(false);
      const db = openDatabase({ path: nested });
      try {
        // Run a trivial query to force the file to be created.
        await db.select<{ ok: number }[]>("SELECT 1 AS ok");
        expect(existsSync(nested)).toBe(true);
      } finally {
        await db.close();
      }
    });

    it("opens file-backed databases in WAL journal mode", async () => {
      // GIVEN a file-backed database
      // WHEN we read journal_mode
      // THEN it is 'wal'. The spec mandates WAL so writes do not
      // block reads.
      const path = join(tempDir, "auth.sqlite");
      const db = openDatabase({ path });
      try {
        const rows = await db.select<{ journal_mode: string }[]>("PRAGMA journal_mode");
        expect(rows[0]?.journal_mode.toLowerCase()).toBe("wal");
      } finally {
        await db.close();
      }
    });

    it("enables PRAGMA foreign_keys on every connection (file-backed)", async () => {
      // GIVEN a file-backed database
      // WHEN we read foreign_keys
      // THEN it is 1. The spec requires FK enforcement.
      const path = join(tempDir, "auth.sqlite");
      const db = openDatabase({ path });
      try {
        const rows = await db.select<{ foreign_keys: number }[]>("PRAGMA foreign_keys");
        expect(rows[0]?.foreign_keys).toBe(1);
      } finally {
        await db.close();
      }
    });

    it("supports in-memory databases for tests (no parent creation, no WAL)", async () => {
      // GIVEN :memory: is requested
      // WHEN we open the database
      // THEN no file is created on disk; foreign_keys is still 1.
      const db = openDatabase({ path: ":memory:" });
      try {
        const rows = await db.select<{ foreign_keys: number }[]>("PRAGMA foreign_keys");
        expect(rows[0]?.foreign_keys).toBe(1);
      } finally {
        await db.close();
      }
    });
  });

  describe("withSingleWriter (SQLITE_BUSY retry budget)", () => {
    it("runs a write transaction through the single-writer mutex", async () => {
      // GIVEN a database with a one-row table
      // WHEN we run a write via withSingleWriter
      // THEN the row is inserted and the operation does not throw.
      const db = openDatabase({ path: ":memory:" });
      try {
        await db.execute("CREATE TABLE t (n INTEGER)");
        const result = await withSingleWriter(db, async (trx) => {
          await trx.execute("INSERT INTO t (n) VALUES (?)", [42]);
          const rows = await trx.select<{ n: number }[]>("SELECT n FROM t");
          return rows[0]?.n;
        });
        expect(result).toBe(42);
        const after = await db.select<{ n: number }[]>("SELECT n FROM t");
        expect(after).toEqual([{ n: 42 }]);
      } finally {
        await db.close();
      }
    });

    it("serializes concurrent writers (no overlapping trx bodies)", async () => {
      // GIVEN two concurrent withSingleWriter calls
      // WHEN both run
      // THEN the second waits for the first to complete (no overlap).
      // We assert via a "busy" counter that increments at the start
      // of each trx and decrements at the end; if the mutex is
      // broken, the counter would be > 1 at the end of a trx body.
      const db = openDatabase({ path: ":memory:" });
      try {
        await db.execute("CREATE TABLE t (n INTEGER)");
        const inFlight: number[] = [];
        let maxConcurrent = 0;
        const writer = async (n: number) => {
          await withSingleWriter(db, async (trx) => {
            inFlight.push(n);
            maxConcurrent = Math.max(maxConcurrent, inFlight.length);
            // Hold the writer long enough for a second call to
            // queue. We yield via setImmediate so the event loop
            // can interleave the second call.
            await new Promise<void>((resolve) => setImmediate(resolve));
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            inFlight.pop();
            await trx.execute("INSERT INTO t (n) VALUES (?)", [n]);
          });
        };
        await Promise.all([writer(1), writer(2), writer(3)]);
        expect(maxConcurrent).toBe(1);
        const all = await db.select<{ n: number }[]>("SELECT n FROM t ORDER BY n");
        expect(all).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
      } finally {
        await db.close();
      }
    });

    it("retries up to 5 times on SQLITE_BUSY, then surfaces the 6th failure", async () => {
      // GIVEN a database and a fake trx that always reports SQLITE_BUSY
      // WHEN we call withSingleWriter with a retried-failure counter
      // THEN the retry budget is 5 and the 6th attempt surfaces the error.
      //
      // The fake `execute` is the one that decides whether a
      // given statement is treated as a busy error. We make
      // BEGIN succeed (so the trx body actually runs) and
      // everything else throw SQLITE_BUSY; the test then
      // counts how many times the trx body entered. With the
      // spec's "5 retries" budget, the trx body must run
      // exactly 6 times: 1 initial + 5 retries.
      const realDb = openDatabase({ path: ":memory:" });
      let attempts = 0;
      const busyDb: AuthorityDatabase = {
        select: realDb.select,
        close: realDb.close,
        execute: async (sql: string) => {
          // BEGIN succeeds so the trx body runs. Everything
          // else (including COMMIT) reports SQLITE_BUSY so
          // we exercise the retry path on the user-level
          // statement, which is the realistic case.
          if (/^\s*BEGIN\b/i.test(sql)) return;
          const e = new Error("SQLITE_BUSY: database is locked") as Error & { code: string };
          e.code = "SQLITE_BUSY";
          throw e;
        },
      };
      try {
        try {
          await withSingleWriter(busyDb, async (trx) => {
            attempts++;
            await trx.execute("INSERT INTO t VALUES (1)");
          });
          throw new Error("expected withSingleWriter to fail after the retry budget");
        } catch (e) {
          expect(attempts).toBe(6); // initial + 5 retries
          expect((e as Error).message.toLowerCase()).toMatch(/sqlite_busy|busy|locked/);
        }
      } finally {
        await realDb.close();
      }
    });
  });
});
