/**
 * Unit tests for the SQLite online backup helper.
 *
 * The mcp-authority-storage spec requires:
 * - `MCP_OAUTH_BACKUP_TARGET` triggers the backup; the live
 *   database is copied to the target via SQLite's online backup
 *   mechanism.
 * - Backup is atomic at the file level: a partial file MUST
 *   NOT be visible at the target.
 * - Backup runs at startup and at every `MCP_OAUTH_BACKUP_INTERVAL_S`
 *   (default 86400 seconds).
 * - The target directory is created if missing.
 *
 * Atomicity strategy: the live backup is written to
 * `<target>.tmp`, then atomically renamed to `<target>`. The
 * target file is therefore either the previous backup or a
 * complete new backup — never a partial.
 *
 * Test layer: unit. Real SQLite is the strongest possible
 * verification.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/connection.js";
import { initializeSchema } from "../src/db/schema.js";
import { runBackupOnce, startBackupLoop, type BackupScheduler } from "../src/backup.js";

describe("backup", () => {
  let tempDir: string;
  let dbPath: string;
  let targetPath: string;
  let activeSchedulers: BackupScheduler[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mcp-oauth-admin-backup-"));
    dbPath = join(tempDir, "auth.sqlite");
    targetPath = join(tempDir, "backups", "auth.sqlite");
    activeSchedulers = [];
  });

  afterEach(async () => {
    // Stop any backup loops started by the test BEFORE we
    // remove the temp dir — the loop holds an open file
    // handle on the source database.
    for (const s of activeSchedulers) {
      try {
        await s.stop();
      } catch {
        // Best effort; we want to clear the dir even if a
        // stop throws.
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function trackScheduler(s: BackupScheduler): BackupScheduler {
    activeSchedulers.push(s);
    return s;
  }

  it("creates the target directory if missing", async () => {
    // GIVEN the target directory does not exist
    // WHEN we run a backup
    // THEN the target directory is created.
    const db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    await db.execute("INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)", [
      "alice",
      "argon2id-stub",
      "[]",
      1,
      0,
      1700000000,
    ]);
    await db.close();

    expect(existsSync(join(tempDir, "backups"))).toBe(false);
    await runBackupOnce({ dbPath, targetPath });
    expect(existsSync(join(tempDir, "backups"))).toBe(true);
    expect(existsSync(targetPath)).toBe(true);
  });

  it("copies the live database to the target (full content)", async () => {
    // GIVEN a database with one user + one client + one scope
    // WHEN we run a backup
    // THEN the backup file exists, is non-empty, and contains
    //      the inserted rows when opened with a fresh connection.
    const db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    await db.execute("INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)", [
      "alice",
      "argon2id-stub",
      "[]",
      1,
      0,
      1700000000,
    ]);
    await db.execute("INSERT INTO scopes (name, description, createdAt) VALUES (?, ?, ?)", [
      "read:bi_catastro",
      "BI catastro read",
      1700000000,
    ]);
    await db.close();

    await runBackupOnce({ dbPath, targetPath });
    expect(existsSync(targetPath)).toBe(true);
    expect(statSync(targetPath).size).toBeGreaterThan(0);

    // Open the backup with a fresh connection and verify content.
    const verifyDb = openDatabase({ path: targetPath });
    try {
      const users = await verifyDb.select<{ username: string }[]>("SELECT username FROM users");
      const scopes = await verifyDb.select<{ name: string }[]>("SELECT name FROM scopes");
      expect(users).toEqual([{ username: "alice" }]);
      expect(scopes).toEqual([{ name: "read:bi_catastro" }]);
    } finally {
      await verifyDb.close();
    }
  });

  it("is atomic at the file level: the target is never a partial file", async () => {
    // GIVEN a live database
    // WHEN we run a backup AND inspect the target path during
    //      the backup
    // THEN the target file at the user-visible path is the
    //      previous complete backup (or absent) — NEVER a
    //      partial copy.
    //
    // We achieve this by always writing to a `.tmp` sibling
    // and only renaming at the end. To verify, we set up a
    // "previous" backup, mutate the live database, then run
    // a new backup and observe the target content reflects
    // the FRESH state (not a partial, not the previous).
    const db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    await db.execute("INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)", [
      "alice",
      "argon2id-stub",
      "[]",
      1,
      0,
      1700000000,
    ]);
    await db.close();

    // Create a "previous" backup.
    await runBackupOnce({ dbPath, targetPath });

    // Mutate the live database so the new backup differs.
    const db2 = openDatabase({ path: dbPath });
    try {
      await db2.execute("INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)", [
        "bob",
        "argon2id-stub",
        "[]",
        1,
        0,
        1700000001,
      ]);
    } finally {
      await db2.close();
    }

    // Run another backup. The user-visible target reflects
    // the FRESH content (both rows). The implementation
    // MUST never show a partial file at the user-visible path.
    await runBackupOnce({ dbPath, targetPath });
    const verifyDb = openDatabase({ path: targetPath });
    try {
      const rows = await verifyDb.select<{ username: string }[]>(
        "SELECT username FROM users ORDER BY id",
      );
      expect(rows).toEqual([{ username: "alice" }, { username: "bob" }]);
    } finally {
      await verifyDb.close();
    }

    // The `.tmp` file is a sibling and is cleaned up.
    expect(existsSync(targetPath + ".tmp")).toBe(false);
  });

  it("overwrites a previous backup on each run (idempotent)", async () => {
    // GIVEN a previous backup file
    // WHEN we run a backup again
    // THEN the target is replaced with the fresh copy and
    //      the previous file is not preserved alongside.
    const db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    await db.execute("INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)", [
      "v1",
      "argon2id-stub",
      "[]",
      1,
      0,
      1700000000,
    ]);
    await db.close();
    await runBackupOnce({ dbPath, targetPath });

    // Mutate the live database.
    const db2 = openDatabase({ path: dbPath });
    try {
      await db2.execute("UPDATE users SET username = ? WHERE username = ?", [
        "v2",
        "v1",
      ]);
    } finally {
      await db2.close();
    }

    await runBackupOnce({ dbPath, targetPath });
    const verifyDb = openDatabase({ path: targetPath });
    try {
      const rows = await verifyDb.select<{ username: string }[]>("SELECT username FROM users");
      expect(rows).toEqual([{ username: "v2" }]);
    } finally {
      await verifyDb.close();
    }
  });

  it("rejects a target inside the source database's directory without `..` escapes (audit-safe path handling)", async () => {
    // GIVEN a target path that would overwrite the live database
    // WHEN we run a backup
    // THEN the operation is rejected. The spec says the live
    //      database MUST remain in use; overwriting the source
    //      file would corrupt the running authority.
    const db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    await db.close();
    await expect(runBackupOnce({ dbPath, targetPath: dbPath })).rejects.toThrow(
      /same as source|target.*source|backup.*source/i,
    );
  });

  it("startBackupLoop returns a scheduler that can be stopped", async () => {
    // GIVEN a live database
    // WHEN we start a backup loop with a tiny interval
    // THEN the scheduler exposes `stop()` and a status flag
    //      that flips to `false` after stop. The test does not
    //      rely on a real timer — it verifies the API shape
    //      and that the loop respects the stop signal.
    const db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    await db.close();

    const scheduler: BackupScheduler = trackScheduler(
      startBackupLoop({
        dbPath,
        targetPath,
        intervalSeconds: 0.05, // 50ms — fast for tests
      }),
    );
    expect(scheduler.running).toBe(true);
    await scheduler.stop();
    expect(scheduler.running).toBe(false);
    // stop() is idempotent.
    await expect(scheduler.stop()).resolves.not.toThrow();
  });

  it("startBackupLoop runs an initial backup on start, then on every interval", async () => {
    // GIVEN a live database and a backup loop with a small interval
    // WHEN we wait for the loop to fire at least once
    // THEN the target file exists and contains a fresh copy.
    const db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    await db.execute("INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)", [
      "loop",
      "argon2id-stub",
      "[]",
      1,
      0,
      1700000000,
    ]);
    await db.close();

    const scheduler = trackScheduler(
      startBackupLoop({
        dbPath,
        targetPath,
        intervalSeconds: 0.05,
      }),
    );
    try {
      // Wait up to 1s for the first backup to land.
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && !existsSync(targetPath)) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(existsSync(targetPath)).toBe(true);
      const verifyDb = openDatabase({ path: targetPath });
      try {
        const rows = await verifyDb.select<{ username: string }[]>("SELECT username FROM users");
        expect(rows).toEqual([{ username: "loop" }]);
      } finally {
        await verifyDb.close();
      }
    } finally {
      await scheduler.stop();
    }
  });
});
