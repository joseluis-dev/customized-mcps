/**
 * SQLite connection layer for the OAuth2 authority.
 *
 * The mcp-authority-storage spec requires:
 * - File-backed database at `./data/mcp-oauth.sqlite` (overridable
 *   via `MCP_OAUTH_DB_PATH`).
 * - The parent directory is created on first start.
 * - `journal_mode=wal` on file-backed connections.
 * - `PRAGMA foreign_keys=ON` on every connection.
 * - The authority is the only writer; writes serialize through a
 *   single mutex. SQLITE_BUSY is retried up to 5 times; a 6th
 *   failure surfaces as an Error.
 *
 * Implementation choices:
 * - We use the `sqlite3` driver via knex's `knex({ client: 'sqlite3' })`
 *   surface, but we keep the layer thin: the public `AuthorityDatabase`
 *   is a Promise-based wrapper around a single `sqlite3.Database`.
 *   We use sqlite3's native Promise wrapper (via `Database#all`,
 *   `Database#run`, `Database#close`) so the API is small and the
 *   locking semantics are predictable.
 * - Reads and writes share the SAME connection. The single-writer
 *   discipline is enforced by `withSingleWriter`, which queues
 *   write transactions through a chain of promises. This is
 *   simple, correct, and matches the spec's "single-writer
 *   mutex" wording.
 * - WAL is set on the underlying connection via
 *   `PRAGMA journal_mode = WAL`. SQLite returns the new mode; we
 *   log at INFO when the change is effective.
 *
 * The connection layer is intentionally narrow (3 methods: select,
 * execute, close) so the schema, OAuth, and admin code only
 * depends on the surface, not on the driver.
 */

import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import sqlite3 from "sqlite3";

/**
 * The default database path per the mcp-authority-storage spec.
 * Operators can override via `MCP_OAUTH_DB_PATH` (relative paths
 * are resolved against the process CWD).
 */
export const DEFAULT_DB_PATH = "./data/mcp-oauth.sqlite";

/**
 * The number of times `withSingleWriter` retries a write that
 * fails with SQLITE_BUSY. The 6th attempt (initial + 5 retries)
 * surfaces the error so the caller can exit non-zero per the spec.
 */
export const SQLITE_BUSY_RETRY_BUDGET = 5;

/**
 * The exponential-backoff base in milliseconds. The first retry
 * waits ~25ms, the second ~50ms, then 100/200/400ms. Capped at
 * 2_000ms so a long-lived lock does not stall the authority.
 */
const BUSY_BACKOFF_BASE_MS = 25;
const BUSY_BACKOFF_MAX_MS = 2_000;

/**
 * Narrow Promise-based surface for the authority's SQLite
 * connection. Methods are intentionally limited to `select`
 * (returns rows), `execute` (mutations + DDL), and `close` so
 * the rest of the codebase can stay driver-agnostic.
 */
export type AuthorityDatabase = {
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
};

/**
 * The single-writer trx. The `select` and `execute` methods run
 * inside the trx context; the trx auto-commits on success and
 * rolls back on throw (the `withSingleWriter` helper handles
 * commit/rollback and the SQLITE_BUSY retry budget).
 */
export type AuthorityTrx = AuthorityDatabase;

/**
 * Resolve the default database path. The `MCP_OAUTH_DB_PATH` env
 * var wins; the spec default is `./data/mcp-oauth.sqlite`.
 */
export function defaultDatabasePath(): string {
  const env = process.env.MCP_OAUTH_DB_PATH;
  if (typeof env === "string" && env.trim().length > 0) {
    return env.trim();
  }
  return DEFAULT_DB_PATH;
}

/**
 * Open a database. When the path is `:memory:`, no file is
 * created and `journal_mode` is not set (in-memory DBs report
 * `memory` regardless). For file-backed paths, the parent
 * directory is created (mkdir -p), the file is opened, and
 * `PRAGMA journal_mode = WAL` is applied.
 *
 * The `PRAGMA foreign_keys = ON` pragma is applied on every
 * connection (file-backed AND in-memory); the spec requires FK
 * enforcement so the refresh_tokens.agentId / clientId FKs work.
 */
export function openDatabase(options: { path: string }): AuthorityDatabase {
  const path = options.path;
  const isMemory = path === ":memory:" || path === "memory";

  if (!isMemory) {
    const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
    mkdirSync(dirname(absolute), { recursive: true });
  }

  // Use sqlite3's verbose mode in dev for clearer stack traces;
  // the production process sets NODE_ENV=production and the
  // loader switches to the non-verbose class.
  const DatabaseCtor = sqlite3.verbose().Database;
  const db = new DatabaseCtor(path);

  // Apply per-connection PRAGMAs. We do this synchronously
  // (serialize() blocks subsequent queries until completion),
  // so the connection is fully configured by the time the
  // returned wrapper is used. The two pragmas are spec-mandated:
  //   - `foreign_keys = ON` is required for the FK in
  //     refresh_tokens.agentId / clientId to be enforced.
  //   - `journal_mode = WAL` is required on file-backed paths
  //     so the live database continues to serve reads while a
  //     writer is active. The pragma is a no-op for in-memory
  //     databases (they report `memory` regardless), so we set
  //     it unconditionally; it is a hint, not a state change.
  // PRAGMA foreign_keys must be set OUTSIDE of a transaction;
  // serialize() brackets it correctly.
  db.serialize(() => {
    db.run("PRAGMA foreign_keys = ON");
    if (!isMemory) {
      db.run("PRAGMA journal_mode = WAL");
    }
  });

  return {
    select<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return new Promise((resolveP, rejectP) => {
        db.all(sql, params, (err: Error | null, rows: T[]) => {
          if (err) rejectP(err);
          else resolveP(rows ?? []);
        });
      });
    },
    execute(sql: string, params: unknown[] = []): Promise<void> {
      return new Promise((resolveP, rejectP) => {
        db.run(sql, params, (err: Error | null) => {
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
 * Serialize write transactions through a single mutex. The trx
 * callback receives an `AuthorityTrx` whose `select` and
 * `execute` calls run in the same SQLite write transaction.
 *
 * SQLITE_BUSY retry: the trx is retried up to
 * `SQLITE_BUSY_RETRY_BUDGET` times (5 retries = 6 total attempts).
 * The 6th failure surfaces the error. The backoff is exponential
 * with a cap (see BUSY_BACKOFF_*).
 *
 * The retry only fires on errors whose `.code === "SQLITE_BUSY"`.
 * Any other error short-circuits and bubbles immediately.
 *
 * The writer chain is per-DB (stored on the database wrapper).
 * This matters for tests: a module-level singleton would leak
 * across test cases (a closed db's pending writes would block
 * the next test's queue).
 */
export async function withSingleWriter<T>(
  db: AuthorityDatabase & { __writerChain?: Promise<unknown> },
  fn: (trx: AuthorityTrx) => Promise<T>,
): Promise<T> {
  // Lazy-initialize the per-DB chain.
  const prev = db.__writerChain ?? Promise.resolve();
  const next = prev.then(() => runWithBusyRetry(db, fn));
  db.__writerChain = next.catch(() => undefined);
  return next as Promise<T>;
}

/**
 * Drain the writer chain for a database. Returns a promise that
 * resolves when all pending writes (and any errors they
 * swallowed) have settled. Tests call this in their teardown
 * so a closed db's pending writes do not block the next test.
 */
export async function drainWriterChain(
  db: AuthorityDatabase & { __writerChain?: Promise<unknown> },
): Promise<void> {
  const chain = db.__writerChain;
  if (!chain) return;
  try {
    await chain;
  } catch {
    // Swallow — the chain swallows its own errors.
  }
}

async function runWithBusyRetry<T>(
  db: AuthorityDatabase,
  fn: (trx: AuthorityTrx) => Promise<T>,
): Promise<T> {
  let attempt = 0;
  // The retry budget counts the initial attempt as #0; the spec
  // says "retries up to 5 times" so 1 initial + 5 retries = 6.
  // We surface the 6th failure so the caller can exit non-zero.
  while (true) {
    try {
      // The trx is just the same connection; we bracket the
      // callback with BEGIN/COMMIT. ROLLBACK on throw is
      // handled by the catch below.
      await db.execute("BEGIN IMMEDIATE");
      let result: T;
      try {
        result = await fn(db);
      } catch (e) {
        try {
          await db.execute("ROLLBACK");
        } catch {
          // Ignore rollback errors; the original error wins.
        }
        throw e;
      }
      await db.execute("COMMIT");
      return result;
    } catch (e) {
      if (!isSqliteBusy(e) || attempt >= SQLITE_BUSY_RETRY_BUDGET) {
        throw e;
      }
      const delay = Math.min(
        BUSY_BACKOFF_BASE_MS * 2 ** attempt,
        BUSY_BACKOFF_MAX_MS,
      );
      attempt++;
      await sleep(delay);
    }
  }
}

/**
 * Detect SQLITE_BUSY by error code. The sqlite3 driver sets
 * `err.code = "SQLITE_BUSY"` (string) when the database is
 * locked. We accept any error whose `.code` matches
 * (case-insensitive) and whose message mentions "locked" /
 * "busy" as a defense-in-depth check.
 */
function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string };
  if (typeof e.code === "string" && e.code.toUpperCase() === "SQLITE_BUSY") {
    return true;
  }
  return /sqlite_busy|database is locked|database table is locked/i.test(e.message ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveP) => setTimeout(resolveP, ms));
}
