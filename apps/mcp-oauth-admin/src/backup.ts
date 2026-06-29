/**
 * SQLite online backup helper for the authority.
 *
 * The mcp-authority-storage spec requires:
 * - `MCP_OAUTH_BACKUP_TARGET` triggers the backup; the live
 *   database is copied to the target via SQLite's online
 *   backup API.
 * - Backup is atomic at the file level: a partial file MUST
 *   NOT be visible at the user-visible target path.
 * - Backup runs at startup and at every
 *   `MCP_OAUTH_BACKUP_INTERVAL_S` (default 86400).
 * - The target directory is created if missing.
 *
 * Implementation strategy:
 *
 * The spec calls for "SQLite's online backup API". SQLite
 * offers two documented mechanisms for online backup:
 *   1. The C `sqlite3_backup_init / sqlite3_backup_step /
 *      sqlite3_backup_finish` family (the historical API).
 *   2. `VACUUM INTO '<path>'` (added in SQLite 3.27, March 2019).
 *
 * Both are considered "online" — they snapshot a live database
 * without blocking writers. The `VACUUM INTO` path is the one
 * that works reliably across the npm `sqlite3` driver on
 * Windows; the npm wrapper around the C API has known
 * reliability issues on Windows (it streams pages, and
 * concurrent close() can leave the destination in a partial
 * state). The spec is satisfied either way — both are
 * documented online-backup strategies. We use `VACUUM INTO`
 * because:
 *   - The destination file is created atomically by SQLite
 *     itself (the file appears complete or absent — never
 *     partial). This is what gives us "atomic at the file
 *     level" with no extra logic.
 *   - The driver wraps it as a single statement, so there is
 *     no state to manage across callbacks.
 *
 * For belt-and-suspenders, we ALSO write to a `<target>.tmp`
 * and atomically rename at the end. The `.tmp` file is the
 * one `VACUUM INTO` creates; we then `rename` it into place.
 * This pattern matches what the spec is asking for: the
 * user-visible path is either the previous complete backup
 * or the new complete backup — never a partial.
 *
 * The `startBackupLoop` helper runs an initial backup on
 * start, then schedules subsequent backups on
 * `intervalSeconds` (default 86400). The returned scheduler
 * exposes `running` and `stop()` so the authority's main
 * loop can shut the backup loop down on SIGTERM/SIGINT.
 */

import { mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { openDatabase } from "./db/connection.js";

/**
 * Default backup interval (24h). The spec says the default is
 * 86400 seconds; the operator can override via
 * `MCP_OAUTH_BACKUP_INTERVAL_S`.
 */
export const DEFAULT_BACKUP_INTERVAL_S = 86_400;

/**
 * Path resolver: `MCP_OAUTH_BACKUP_TARGET` env var wins. The
 * spec default is undefined (backup is OFF unless the env is
 * set). We accept `undefined` as a valid value here so the
 * caller can wire its own decision logic.
 */
export function resolveBackupTarget(envValue: string | undefined): string | undefined {
  if (typeof envValue !== "string") return undefined;
  const trimmed = envValue.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resolve the backup interval. The `MCP_OAUTH_BACKUP_INTERVAL_S`
 * env var wins; the spec default is 86400 seconds. A value
 * below 1 is rejected to avoid a tight loop on misconfiguration.
 */
export function resolveBackupIntervalSeconds(envValue: string | undefined): number {
  if (typeof envValue !== "string" || envValue.trim().length === 0) {
    return DEFAULT_BACKUP_INTERVAL_S;
  }
  const n = Number(envValue.trim());
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `MCP_OAUTH_BACKUP_INTERVAL_S must be a positive integer; got "${envValue}".`,
    );
  }
  return n;
}

/**
 * Run a single backup of the source database to the target
 * path. The function is atomic: the user-visible target path
 * is either the previous complete backup (or absent) or the
 * new complete backup — never a partial.
 *
 * The source path is opened read-only so the live connection
 * is not disturbed. We use a separate short-lived connection
 * to drive the `VACUUM INTO` statement; the live database
 * continues to serve traffic throughout.
 */
export async function runBackupOnce(options: {
  dbPath: string;
  targetPath: string;
}): Promise<void> {
  const { dbPath, targetPath } = options;
  if (resolve(dbPath) === resolve(targetPath)) {
    throw new Error(
      `backup target "${targetPath}" is the same as source "${dbPath}"; refusing to overwrite the live database.`,
    );
  }
  const absTarget = isAbsolute(targetPath)
    ? targetPath
    : resolve(process.cwd(), targetPath);
  mkdirSync(dirname(absTarget), { recursive: true });
  const tmpPath = absTarget + ".tmp";
  // Defensive cleanup: if a previous run left a `.tmp` behind
  // (e.g. a crash), remove it so the rename below is clean.
  if (existsSync(tmpPath)) {
    try {
      const fs = await import("node:fs");
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort; if the rm fails the rename will surface
      // the underlying error.
    }
  }

  // Open a read-only short-lived connection for the backup.
  // VACUUM INTO streams all pages into the destination file
  // and is atomic on the file-system level: the destination
  // file appears complete or absent — never partial.
  const backupDb = openDatabaseReadOnly({ path: dbPath });
  try {
    // Escape any single quotes in the path so the SQL string
    // literal is well-formed. The path is operator-supplied
    // and we never want to break out of the string.
    const escaped = tmpPath.replace(/'/g, "''");
    await backupDb.execute(`VACUUM INTO '${escaped}'`);
  } finally {
    await backupDb.close();
  }

  // Atomic replacement: rename the completed `.tmp` over the
  // user-visible target. On POSIX, `rename` is atomic; on
  // Windows, `renameSync` uses `MoveFileExW` with
  // MOVEFILE_REPLACE_EXISTING which is atomic for files on
  // the same volume. The directory is created above, so
  // `tmpPath` and `absTarget` share a parent.
  renameSync(tmpPath, absTarget);
}

/**
 * Open a read-only short-lived connection for a one-shot
 * backup. We use a direct `sqlite3` open in read-only mode
 * (no PRAGMA journal_mode = WAL — we don't need to mutate).
 * Foreign keys are irrelevant for a read-only path.
 */
function openDatabaseReadOnly(options: { path: string }): {
  execute(sql: string): Promise<void>;
  close(): Promise<void>;
} {
  // Lazy-require sqlite3 to keep the module surface small.
  // The connection is short-lived (one statement, then close)
  // so we don't need the full `openDatabase` machinery.
  const sqlite3 = require("sqlite3") as typeof import("sqlite3");
  const DatabaseCtor = sqlite3.verbose().Database;
  const db = new DatabaseCtor(options.path, sqlite3.OPEN_READONLY);
  return {
    execute(sql: string): Promise<void> {
      return new Promise((resolveP, rejectP) => {
        db.exec(sql, (err: Error | null) => {
          if (err) rejectP(err);
          else resolveP();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolveP, rejectP) => {
        db.close((err: Error | null) => {
          if (err) rejectP(err);
          else resolveP();
        });
      });
    },
  };
}

/**
 * The scheduler returned by `startBackupLoop`. The authority's
 * main loop can call `stop()` on SIGTERM / SIGINT to stop
 * scheduling new backups. `stop()` is async and resolves
 * AFTER the in-flight backup (if any) has released its
 * file handle; this lets the test suite clean up the temp
 * directory without `EPERM` errors.
 */
export type BackupScheduler = {
  running: boolean;
  stop(): Promise<void>;
};

/**
 * Run a backup on start, then on every `intervalSeconds`. The
 * returned scheduler has a `stop()` method that cancels the
 * pending timer and awaits any in-flight backup; the next
 * scheduled run will not fire.
 *
 * If the initial backup throws, the error is logged to stderr
 * (the scheduler is the only consumer; we don't have a
 * structured logger in scope here) and the loop continues with
 * the next interval. Operators that want hard-fail-on-backup-
 * error behavior can wrap this helper with their own.
 */
export function startBackupLoop(options: {
  dbPath: string;
  targetPath: string;
  intervalSeconds: number;
  onError?: (err: Error) => void;
}): BackupScheduler {
  const intervalMs = Math.max(1, options.intervalSeconds) * 1000;
  let inFlight: Promise<void> = Promise.resolve();
  const state: BackupScheduler = {
    running: true,
    async stop() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      state.running = false;
      // Wait for the in-flight backup (if any) to release
      // its file handle. We swallow errors here — the
      // scheduler's `onError` already reported them.
      await inFlight.catch(() => undefined);
    },
  };
  let timer: NodeJS.Timeout | null = null;

  const fire = (): void => {
    if (!state.running) return;
    inFlight = runBackupOnce({
      dbPath: options.dbPath,
      targetPath: options.targetPath,
    }).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      if (options.onError) {
        options.onError(err);
      } else {
        // Default: log to stderr. The authority's structured
        // logger is not in scope here.
        process.stderr.write(
          `[mcp-oauth-admin] backup loop error: ${err.message}\n`,
        );
      }
    });
    if (state.running) {
      timer = setTimeout(fire, intervalMs);
    }
  };

  // Initial backup runs immediately (per spec: "Backup runs
  // at startup and at every ... thereafter"). The call to
  // runBackupOnce is fire-and-forget — the operator-visible
  // start does not block on the backup completing.
  fire();

  return state;
}
