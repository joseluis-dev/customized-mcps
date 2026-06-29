/**
 * Bootstrap admin module.
 *
 * The mcp-oauth-authority spec requires:
 * - Bootstrap admin reads `MCP_OAUTH_ADMIN_USERNAME` and
 *   `MCP_OAUTH_ADMIN_PASSWORD` on first start.
 * - The password is stored as `argon2id` with
 *   `require_change_on_first_login=true`.
 * - The token endpoint MUST refuse to mint until the password
 *   is rotated (the `requireChangeOnFirstLogin` check in
 *   `src/oauth/token.ts` is the source of truth; the
 *   `ensureBootstrapAdmin` function only sets the flag).
 * - A `WARN` is logged while the env vars are set — the spec
 *   is explicit that the WARN is a REMINDER to rotate, not a
 *   "first start" notice. The WARN fires on every startup as
 *   long as the env vars are present.
 *
 * Idempotency:
 * - The module is safe to call on every startup. If the
 *   `users` table already has a row with the supplied
 *   username, the function does NOT overwrite the row. The
 *   operator might have rotated the password away from the
 *   env value; an overwrite would be a privilege regression.
 *
 * Audit-safety:
 * - The function NEVER logs the env password. The WARN log
 *   (if the operator enables it) names the env vars but
 *   NEVER their values. The audit row written at the end of
 *   the create flow records `actor=system:bootstrap`,
 *   `action=agent.create`, `target=root` — a sanitized id
 *   reference, not the password or its hash.
 */

import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";
import { hashPassword } from "../oauth/passwords.js";
import { auditAppend } from "./audit.js";

/**
 * The shape of the env-derived bootstrap credentials. The
 * fields are plain strings (no Buffer, no file path) — the
 * env is the source of truth at startup, the DB is the
 * source of truth after that.
 */
export type BootstrapEnv = {
  username: string;
  password: string;
};

/**
 * The result of an `ensureBootstrapAdmin` call. `created` is
 * `true` when the function inserted a new row, `false` when
 * the username was already present (no-op). The `username`
 * field is echoed back so the caller can log a sanitized
 * "created admin <username>" line.
 */
export type BootstrapResult = {
  created: boolean;
  username: string | null;
};

/**
 * Pure reader for the bootstrap env. The function is split
 * from `ensureBootstrapAdmin` so the test suite can drive
 * the env without mutating `process.env` (mutating
 * `process.env` from inside vitest leaks into the rest of
 * the suite). The production caller reads the env at the
 * top of the entrypoint and passes the values in.
 *
 * The function returns `null` when either field is missing
 * or empty (after trim). The spec says BOTH env vars are
 * required to trigger bootstrap.
 */
export function resolveBootstrapEnv(input: {
  username: string | undefined;
  password: string | undefined;
}): BootstrapEnv | null {
  const username = (input.username ?? "").trim();
  const password = (input.password ?? "").trim();
  if (username.length === 0 || password.length === 0) return null;
  return { username, password };
}

/**
 * The trigger for the WARN log. The router calls this at
 * startup; the WARN is emitted exactly once per process
 * start. The function returns `true` whenever the env is
 * non-null (regardless of whether the admin already
 * exists). The spec is explicit: the WARN is a REMINDER,
 * not a "first start" notice.
 */
export function shouldWarnBootstrapEnv(env: BootstrapEnv | null): boolean {
  return env !== null;
}

/**
 * Idempotent insert. If the supplied username is already
 * present, the function does NOTHING (no overwrite, no
 * audit row). The behavior is documented in the
 * `ensureBootstrapAdmin does NOT create a second admin`
 * test in `test/admin/bootstrap.test.ts`.
 */
export async function ensureBootstrapAdmin(
  db: AuthorityDatabase,
  env: BootstrapEnv | null,
  now: number,
): Promise<BootstrapResult> {
  if (env === null) {
    return { created: false, username: null };
  }
  // Check for an existing user with this username. We do
  // this OUTSIDE the trx (a SELECT is cheap, and the trx
  // adds a write lock that we don't need for the
  // existence check).
  const existing = await db.select<{ id: number }>(
    "SELECT id FROM users WHERE username = ?",
    [env.username],
  );
  if (existing.length > 0) {
    return { created: false, username: env.username };
  }
  // Hash the password. The argon2id hash is what we
  // persist — the plaintext is dropped on the floor after
  // the hash returns.
  const passwordHash = await hashPassword(env.password);
  // Insert the row + audit log inside a single trx so
  // the two writes commit atomically.
  await withSingleWriter(db, async (trx) => {
    await trx.execute(
      `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
       VALUES (?, ?, ?, 1, 1, ?)`,
      [env.username, passwordHash, "[]", now],
    );
    await auditAppendInTrx(trx, {
      ts: now,
      actor: "system:bootstrap",
      action: "agent.create",
      target: env.username,
      outcome: "ok",
    });
  });
  return { created: true, username: env.username };
}

/**
 * Audit-log writer that uses the trx's connection. The
 * helper is duplicated here (rather than reusing
 * `auditAppend` directly) so the trx is the source of
 * the connection — the row + audit are committed
 * together.
 */
async function auditAppendInTrx(
  trx: AuthorityDatabase,
  entry: Parameters<typeof auditAppend>[1],
): Promise<void> {
  if (typeof entry.target === "string" && /[a-fA-F0-9]{64}/.test(entry.target)) {
    throw new RangeError("bootstrap: target looks like a hash; refusing to write");
  }
  await trx.execute(
    `INSERT INTO audit_log (ts, actor, action, target, ip, outcome)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.ts,
      entry.actor,
      entry.action,
      entry.target ?? null,
      entry.ip ?? null,
      entry.outcome,
    ],
  );
}
