/**
 * Per-username login backoff for the admin UI.
 *
 * The mcp-admin-ui spec requires:
 * - After 5 consecutive failures within 10 minutes, further
 *   attempts return `429`.
 * - Backoff applies ONLY to the admin login form, NOT to
 *   `/oauth/token`. The two paths use different state:
 *   `/oauth/token` does NOT call into this module.
 * - State is persisted in SQLite (`login_backoff` table) so a
 *   process restart does not reset the counter. The 5th attempt
 *   1ms before a restart is still counted after the restart.
 *
 * Implementation notes:
 * - The window is measured from `firstFailureAt`. A failure
 *   recorded AFTER `firstFailureAt + BACKOFF_WINDOW_SECONDS`
 *   starts a fresh window (the row is reset to a count of 1).
 *   The 5-failure threshold is only meaningful within the
 *   window; outside the window, a single failure is the start
 *   of a new window.
 * - The lock is set on the 5th failure within the window. The
 *   lock duration is `LOCK_DURATION_SECONDS` from the
 *   `firstFailureAt` (NOT from the 5th failure) so the lock
 *   window is stable regardless of when the threshold was hit.
 * - The 6th attempt within the lock window is rejected with
 *   `BackoffError` carrying the `lockedUntil` timestamp. The
 *   router maps this to a 429 response.
 *
 * Concurrency: the writes go through `withSingleWriter` so the
 * counter is monotonic. The function is safe to call from
 * multiple concurrent admin-login attempts; the last write wins
 * (which is what we want — the lock check always reads the
 * current row).
 */

import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";

/** 5 consecutive failures within the window trigger the lock. */
export const BACKOFF_THRESHOLD = 5;

/** The 10-minute rolling window. */
export const BACKOFF_WINDOW_SECONDS = 10 * 60;

/** How long the lock holds (also 10 minutes). */
export const LOCK_DURATION_SECONDS = 10 * 60;

export type BackoffState = {
  failCount: number;
  firstFailureAt: number | null;
  lockedUntil: number | null;
};

/**
 * Thrown when a login attempt is rejected because the username
 * is currently locked. The error carries the `lockedUntil`
 * timestamp and the username so the router can shape a 429
 * response with a `Retry-After` header.
 */
export class BackoffError extends Error {
  readonly username: string;
  readonly lockedUntil: number;
  readonly retryAfterSeconds: number;

  constructor(username: string, lockedUntil: number, now: number) {
    super(`Backoff: username "${username}" is locked until ${lockedUntil} (now=${now})`);
    this.name = "BackoffError";
    this.username = username;
    this.lockedUntil = lockedUntil;
    this.retryAfterSeconds = Math.max(0, lockedUntil - now);
  }
}

/**
 * Read the current backoff state for a username. Returns `null`
 * when the username has no recorded failures (the row is absent).
 */
export async function getBackoffState(
  db: AuthorityDatabase,
  username: string,
): Promise<BackoffState | null> {
  const rows = await db.select<{
    failCount: number;
    firstFailureAt: number | null;
    lockedUntil: number | null;
  }>(
    "SELECT failCount, firstFailureAt, lockedUntil FROM login_backoff WHERE username = ?",
    [username],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    failCount: r.failCount,
    firstFailureAt: r.firstFailureAt,
    lockedUntil: r.lockedUntil,
  };
}

/**
 * Check whether the username is currently locked. A username is
 * locked when `lockedUntil > now` (i.e. the lock window has not
 * yet elapsed). When the lock has elapsed, the function returns
 * `false`; the next failure will start a fresh window.
 */
export async function isLocked(
  db: AuthorityDatabase,
  username: string,
  now: number,
): Promise<boolean> {
  const state = await getBackoffState(db, username);
  if (state === null) return false;
  if (state.lockedUntil === null) return false;
  return state.lockedUntil > now;
}

/**
 * Record a login failure for a username. The function:
 * - If no row exists, inserts a new row with `failCount=1`.
 * - If a row exists AND `firstFailureAt` is within the window,
 *   increments `failCount`. When the count reaches the
 *   threshold, sets `lockedUntil = firstFailureAt +
 *   LOCK_DURATION_SECONDS`.
 * - If a row exists AND `firstFailureAt` is OUTSIDE the window,
 *   resets the row to a fresh window (failCount=1,
 *   firstFailureAt=now, lockedUntil=null).
 *
 * The function returns the resulting state.
 */
export async function recordFailure(
  db: AuthorityDatabase,
  username: string,
  now: number,
): Promise<BackoffState> {
  return withSingleWriter(db, async (trx) => {
    const rows = await trx.select<{
      failCount: number;
      firstFailureAt: number | null;
    }>(
      "SELECT failCount, firstFailureAt FROM login_backoff WHERE username = ?",
      [username],
    );
    const existing = rows[0];
    let newCount: number;
    let newFirst: number;
    if (!existing) {
      newCount = 1;
      newFirst = now;
    } else {
      const firstAt = existing.firstFailureAt;
      const withinWindow = firstAt !== null && now - firstAt < BACKOFF_WINDOW_SECONDS;
      if (!withinWindow) {
        newCount = 1;
        newFirst = now;
      } else {
        newCount = existing.failCount + 1;
        newFirst = firstAt;
      }
    }
    const lockedUntil =
      newCount >= BACKOFF_THRESHOLD ? newFirst + LOCK_DURATION_SECONDS : null;
    await trx.execute(
      `INSERT INTO login_backoff (username, failCount, firstFailureAt, lockedUntil)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         failCount = excluded.failCount,
         firstFailureAt = excluded.firstFailureAt,
         lockedUntil = excluded.lockedUntil`,
      [username, newCount, newFirst, lockedUntil],
    );
    return {
      failCount: newCount,
      firstFailureAt: newFirst,
      lockedUntil,
    };
  });
}

/**
 * Clear the backoff state for a username. Called on a successful
 * login (and on admin reset). The function is idempotent: a
 * missing row is fine.
 */
export async function clearFailures(
  db: AuthorityDatabase,
  username: string,
): Promise<void> {
  await withSingleWriter(db, async (trx) => {
    await trx.execute("DELETE FROM login_backoff WHERE username = ?", [username]);
  });
}
