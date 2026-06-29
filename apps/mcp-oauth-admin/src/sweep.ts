/**
 * Daily retention sweep for the authority.
 *
 * The mcp-authority-storage spec requires:
 * - `audit_log` rows older than 90 days are deleted.
 * - `refresh_tokens` rows whose `revokedAt` is older than 30
 *   days are deleted.
 * - The sweep runs once per 24 hours.
 * - The sweep is skippable via
 *   `MCP_OAUTH_DISABLE_RETENTION_SWEEP=true`.
 * - The sweep MUST NOT block reads for more than 1 second
 *   (defense-in-depth: we use a single write transaction).
 *
 * The sweep is a one-shot function. The authority's main
 * loop is responsible for scheduling it once per 24h (via
 * `setInterval` or a `setTimeout` chain) and for honoring
 * the disable flag.
 *
 * Boundary semantics: the spec says "older than 90 days",
 * which means STRICTLY greater than 90 days. A row whose
 * `ts` is exactly 90 days old is at the boundary and is
 * KEPT. The same applies to the 30-day refresh-token
 * boundary.
 *
 * What we never delete:
 * - Non-revoked refresh tokens, regardless of age. The spec
 *   scopes the refresh-token sweep to the `revokedAt` column.
 * - Audit rows whose `ts` is within the last 90 days. The
 *   retention is the operator's audit window.
 */

import type { AuthorityDatabase } from "./db/connection.js";
import { withSingleWriter } from "./db/connection.js";

/**
 * The retention window for `audit_log`, in seconds. The spec
 * says "90 days"; we pre-compute the seconds so the SQL is
 * pure (no `datetime('now', '-90 day')`).
 */
export const AUDIT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * The retention window for revoked `refresh_tokens`, in
 * seconds. The spec says "30 days from revokedAt".
 */
export const REVOKED_REFRESH_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * The result of a single sweep run. Both counters are
 * observable; the caller (the authority's main loop) can log
 * them at INFO per the spec.
 */
export type SweepResult = {
  auditDeleted: number;
  refreshDeleted: number;
  ranAt: number;
};

/**
 * Run the retention sweep. The two deletions happen inside
 * a single write transaction so the sweep is atomic — no
 * window where one table is swept and the other is not.
 *
 * The `disabled` flag (driven by
 * `MCP_OAUTH_DISABLE_RETENTION_SWEEP=true`) short-circuits
 * the function. The caller (the scheduler) is responsible
 * for NOT calling this function when the flag is set; the
 * flag is accepted here too as a defense-in-depth measure so
 * a misconfigured scheduler cannot accidentally bypass the
 * safety.
 */
export async function runRetentionSweep(options: {
  db: AuthorityDatabase;
  nowSeconds?: number;
  disabled?: boolean;
}): Promise<SweepResult> {
  if (options.disabled === true) {
    return { auditDeleted: 0, refreshDeleted: 0, ranAt: 0 };
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const auditCutoff = now - AUDIT_RETENTION_SECONDS;
  const refreshCutoff = now - REVOKED_REFRESH_RETENTION_SECONDS;

  // The sweep runs inside the single-writer mutex so it does
  // not block reads. The two DELETEs are wrapped in a single
  // BEGIN/COMMIT so the sweep is atomic (either both deletions
  // happen or neither does).
  return withSingleWriter(options.db, async (trx) => {
    // Count first, then delete. The COUNT and DELETE happen
    // inside the same trx so the count is exact: the trx
    // has not committed yet, so concurrent writes are
    // blocked by the single-writer mutex.
    const auditCountRows = await trx.select<{ c: number }>(
      "SELECT COUNT(*) AS c FROM audit_log WHERE ts < ?",
      [auditCutoff],
    );
    const refreshCountRows = await trx.select<{ c: number }>(
      "SELECT COUNT(*) AS c FROM refresh_tokens WHERE revokedAt IS NOT NULL AND revokedAt < ?",
      [refreshCutoff],
    );
    const auditDeleted = auditCountRows[0]?.c ?? 0;
    const refreshDeleted = refreshCountRows[0]?.c ?? 0;
    if (auditDeleted > 0) {
      await trx.execute("DELETE FROM audit_log WHERE ts < ?", [auditCutoff]);
    }
    if (refreshDeleted > 0) {
      await trx.execute(
        "DELETE FROM refresh_tokens WHERE revokedAt IS NOT NULL AND revokedAt < ?",
        [refreshCutoff],
      );
    }
    return {
      auditDeleted,
      refreshDeleted,
      ranAt: now,
    };
  });
}

/**
 * Schedule the retention sweep to run once per 24 hours. The
 * returned scheduler exposes `running` and `stop()` so the
 * authority's main loop can stop scheduling on SIGTERM.
 *
 * The disable flag is honored at scheduler construction
 * time: when `MCP_OAUTH_DISABLE_RETENTION_SWEEP=true`, the
 * scheduler is constructed but no sweep ever runs (the
 * `stop()` method is still safe to call).
 */
export type SweepScheduler = {
  running: boolean;
  stop(): Promise<void>;
};

export function startSweepLoop(options: {
  db: AuthorityDatabase;
  intervalSeconds?: number;
  disabled?: boolean;
  onError?: (err: Error) => void;
}): SweepScheduler {
  const intervalMs = (options.intervalSeconds ?? 24 * 60 * 60) * 1000;
  let inFlight: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  const state: SweepScheduler = {
    running: true,
    async stop() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      state.running = false;
      await inFlight.catch(() => undefined);
    },
  };
  if (options.disabled === true) {
    // Honor the disable flag: no sweep runs. The scheduler
    // is still alive so the caller's `stop()` is safe.
    return state;
  }
  const fire = (): void => {
    if (!state.running) return;
    inFlight = runRetentionSweep({ db: options.db }).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      if (options.onError) {
        options.onError(err);
      } else {
        process.stderr.write(
          `[mcp-oauth-admin] sweep loop error: ${err.message}\n`,
        );
      }
    });
    if (state.running) {
      timer = setTimeout(fire, intervalMs);
    }
  };
  // Run an initial sweep on start, then schedule the next
  // run for 24h later. The spec says "runs once per 24
  // hours" — we interpret that as "an initial run at start
  // plus one every 24h". Operators that want the sweep to
  // wait for the first interval can wrap the scheduler
  // with their own logic.
  fire();
  return state;
}
