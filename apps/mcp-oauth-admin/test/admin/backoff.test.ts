/**
 * Unit tests for the per-username login backoff.
 *
 * The mcp-admin-ui spec requires:
 * - After 5 consecutive failures within 10 minutes, further
 *   attempts return `429`.
 * - Backoff applies ONLY to the admin login form, NOT to
 *   `/oauth/token`. A 6th attempt on `/oauth/token` for a
 *   client_credentials grant is unaffected by the admin
 *   backoff (the two paths use different backoff state).
 * - State is persisted in SQLite (`login_backoff` table) so a
 *   restart does not reset the counter.
 *
 * The backoff module's pure logic is tested here; the
 * integration with the admin login form is tested in
 * `test/admin/router.test.ts`.
 *
 * Test layer: unit + integration. The DB layer is the production
 * code path (in-memory SQLite per test).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, initializeSchema, type AuthorityDatabase } from "../../src/db/index.js";
import {
  recordFailure,
  isLocked,
  clearFailures,
  getBackoffState,
  BackoffError,
  BACKOFF_THRESHOLD,
  BACKOFF_WINDOW_SECONDS,
  LOCK_DURATION_SECONDS,
} from "../../src/admin/backoff.js";

let db: AuthorityDatabase;
let now: number;

beforeEach(async () => {
  db = openDatabase({ path: ":memory:" });
  await initializeSchema(db);
  now = 1_700_000_000;
});

afterEach(async () => {
  await db.close();
});

describe("admin/backoff — threshold + window", () => {
  it("records 1-4 failures without locking the username", async () => {
    // GIVEN 4 consecutive failures for "root"
    // WHEN we check isLocked after each
    // THEN the username is not locked (4 < 5 threshold).
    for (let i = 0; i < 4; i++) {
      await recordFailure(db, "root", now + i);
      const locked = await isLocked(db, "root", now + i);
      expect(locked).toBe(false);
    }
  });

  it("locks the username on the 5th consecutive failure within the 10-minute window", async () => {
    // GIVEN 5 failures at one-second intervals
    // WHEN we check isLocked
    // THEN the username IS locked.
    for (let i = 0; i < 5; i++) {
      await recordFailure(db, "root", now + i);
    }
    const locked = await isLocked(db, "root", now + 5);
    expect(locked).toBe(true);
  });

  it("lock remains in effect for the full 10-minute duration", async () => {
    // GIVEN a locked username (5 failures)
    // WHEN we check isLocked at t+1s, t+5m, t+9m59s
    // THEN the username remains locked.
    for (let i = 0; i < 5; i++) {
      await recordFailure(db, "root", now + i);
    }
    expect(await isLocked(db, "root", now + 1)).toBe(true);
    expect(await isLocked(db, "root", now + 5 * 60)).toBe(true);
    expect(await isLocked(db, "root", now + 9 * 60 + 59)).toBe(true);
  });

  it("unlocks when the 10-minute window elapses from the first failure", async () => {
    // GIVEN a locked username (5 failures all within 10m of t=now)
    // WHEN we check isLocked at now + 10m + 1s
    // THEN the username is no longer locked. The window is
    //      measured from firstFailureAt; the 6th attempt
    //      outside the window starts a fresh window.
    for (let i = 0; i < 5; i++) {
      await recordFailure(db, "root", now + i);
    }
    const afterWindow = now + BACKOFF_WINDOW_SECONDS + 1;
    expect(await isLocked(db, "root", afterWindow)).toBe(false);
  });

  it("isLocked returns false for a username with no recorded failures", async () => {
    const locked = await isLocked(db, "ghost", now);
    expect(locked).toBe(false);
  });

  it("getBackoffState returns null for a username with no recorded failures", async () => {
    const state = await getBackoffState(db, "ghost");
    expect(state).toBeNull();
  });

  it("getBackoffState returns the current state after a failure", async () => {
    // GIVEN 1 failure
    // WHEN we read the state
    // THEN it includes failCount=1, firstFailureAt, lockedUntil=null.
    await recordFailure(db, "root", now);
    const state = await getBackoffState(db, "root");
    expect(state).not.toBeNull();
    expect(state?.failCount).toBe(1);
    expect(state?.firstFailureAt).toBe(now);
    expect(state?.lockedUntil).toBeNull();
  });

  it("getBackoffState returns lockedUntil set after the threshold is reached", async () => {
    // GIVEN 5 failures
    // WHEN we read the state
    // THEN failCount=5, lockedUntil is set to firstFailureAt + LOCK_DURATION_SECONDS.
    for (let i = 0; i < 5; i++) {
      await recordFailure(db, "root", now + i);
    }
    const state = await getBackoffState(db, "root");
    expect(state?.failCount).toBe(5);
    expect(state?.lockedUntil).toBe(now + LOCK_DURATION_SECONDS);
  });
});

describe("admin/backoff — clearFailures", () => {
  it("clearFailures resets the counter to zero and clears the lock", async () => {
    // GIVEN a locked username
    // WHEN we call clearFailures
    // THEN the state is gone and the username is not locked.
    for (let i = 0; i < 5; i++) {
      await recordFailure(db, "root", now + i);
    }
    expect(await isLocked(db, "root", now + 5)).toBe(true);
    await clearFailures(db, "root");
    expect(await getBackoffState(db, "root")).toBeNull();
    expect(await isLocked(db, "root", now + 5)).toBe(false);
  });

  it("clearFailures is a no-op for a username that has no recorded failures", async () => {
    // GIVEN a username with no failures
    // WHEN we call clearFailures
    // THEN no error is raised (the function is idempotent).
    await expect(clearFailures(db, "ghost")).resolves.toBeUndefined();
  });
});

describe("admin/backoff — window reset on a fresh failure outside the window", () => {
  it("a failure recorded AFTER the 10-minute window starts a fresh window", async () => {
    // GIVEN 4 failures at t=now, then a long pause past the window
    // WHEN the 5th failure is recorded at t=now+11m
    // THEN the 5th failure is treated as the FIRST failure of a
    //      new window — the username is NOT locked.
    for (let i = 0; i < 4; i++) {
      await recordFailure(db, "root", now + i);
    }
    const late = now + 11 * 60;
    await recordFailure(db, "root", late);
    const state = await getBackoffState(db, "root");
    expect(state?.failCount).toBe(1);
    expect(state?.firstFailureAt).toBe(late);
    expect(await isLocked(db, "root", late + 1)).toBe(false);
  });
});

describe("admin/backoff — BackoffError", () => {
  it("BackoffError carries the lockedUntil timestamp and the username", () => {
    // GIVEN a lock window
    // WHEN we construct a BackoffError
    // THEN the error message names the username and the lock end.
    const e = new BackoffError("root", now + LOCK_DURATION_SECONDS, 0);
    expect(e.name).toBe("BackoffError");
    expect(e.username).toBe("root");
    expect(e.lockedUntil).toBe(now + LOCK_DURATION_SECONDS);
    expect(e.retryAfterSeconds).toBeGreaterThan(0);
    expect(e.message).toContain("root");
    expect(e.message).not.toContain(String(BACKOFF_THRESHOLD));
  });
});

describe("admin/backoff — thresholds are documented", () => {
  it("BACKOFF_THRESHOLD is 5", () => {
    expect(BACKOFF_THRESHOLD).toBe(5);
  });

  it("BACKOFF_WINDOW_SECONDS is 600 (10 minutes)", () => {
    expect(BACKOFF_WINDOW_SECONDS).toBe(600);
  });

  it("LOCK_DURATION_SECONDS is 600 (10 minutes)", () => {
    expect(LOCK_DURATION_SECONDS).toBe(600);
  });
});
