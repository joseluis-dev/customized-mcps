/**
 * Agent CRUD for the admin UI.
 *
 * The mcp-admin-ui spec requires:
 * - The admin can list, create, disable, and rotate agent
 *   passwords.
 * - `createAgent` generates a one-time plaintext password
 *   (returned in the response), stores the `argon2id` hash,
 *   and persists the `requireChangeOnFirstLogin` flag when set.
 * - The plaintext password is NEVER persisted; the DB row
 *   contains only the hash. The plaintext is shown to the
 *   admin ONCE on the create / rotate response page.
 * - The token endpoint maps `users.enabled = 0` to
 *   `400 account_disabled` (see `src/oauth/token.ts`).
 * - The bootstrap admin's rotation flow clears the
 *   `requireChangeOnFirstLogin` flag so the admin can mint
 *   tokens (see `src/oauth/token.ts` password grant).
 *
 * PR 4 of `remove-scope-authorization`:
 * - The `users.scopes` column is INERT legacy storage. The
 *   `createAgent` / `rotateAgentPassword` paths no longer
 *   validate against the scope-pattern grammar (the column
 *   defaults to `[]` for new rows). The `setAgentScopes`
 *   helper is removed — there is no admin route to call it,
 *   and the catalog that backed it is gone.
 *
 * Audit-safety:
 * - The `verifyAgentPassword` function does NOT log the
 *   supplied password. The caller is responsible for the
 *   audit row (we expose a `verifyAgentPassword` shape that
 *   returns the failure reason so the router can shape the
 *   audit `outcome` field).
 * - The `AgentRecord` shape does NOT include `passwordHash` so
 *   it cannot leak through the admin UI's HTML (the admin
 *   only ever sees the plaintext on a one-time response).
 */

import { randomBytes } from "node:crypto";
import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";
import { hashPassword, verifyPassword } from "../oauth/passwords.js";

/**
 * The public agent record. The shape is the row read from
 * `users` with the JSON `scopes` column decoded. We do NOT
 * include `passwordHash` — that is internal state and MUST
 * NEVER reach the admin UI.
 *
 * The `scopes` field is INERT legacy storage (PR 4 of
 * `remove-scope-authorization`). It is read so the
 * `AgentRecord` shape stays BC-compatible with the
 * `users` table; it is NOT validated, NOT exposed through
 * the admin UI, and NOT surfaced on any rendered page.
 */
export type AgentRecord = {
  id: number;
  username: string;
  scopes: string[];
  enabled: boolean;
  requireChangeOnFirstLogin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
};

/**
 * `CreateAgentInput` no longer carries `scopes`. The agent
 * is created with the inert default `[]`; the column is
 * legacy storage. The field is removed from the public
 * input to make the removal observable at the type level.
 */
export type CreateAgentInput = {
  username: string;
  requireChangeOnFirstLogin?: boolean;
  now: number;
};

export type CreateAgentResult =
  | { ok: true; agent: AgentRecord; plaintextPassword: string }
  | { ok: false; reason: "invalid_username" | "duplicate" };

export type RotatePasswordResult =
  | { ok: true; plaintextPassword: string }
  | { ok: false; reason: "not_found" };

export type ChangeOwnPasswordInput = {
  /** Required when the user's `requireChangeOnFirstLogin` is false. Ignored when true. */
  currentPassword: string | null;
  newPassword: string;
  now: number;
};

export type ChangeOwnPasswordResult =
  | { ok: true; plaintextPassword: string }
  | { ok: false; reason: "not_found" | "invalid_current" | "invalid_new" };

export type VerifyPasswordResult =
  | { ok: true; agent: AgentRecord }
  | { ok: false; reason: "missing" | "invalid" };

/**
 * Generate a random password for a new agent. The format is
 * 24 base64url characters (16 random bytes), which gives
 * ~96 bits of entropy — well above the 64-bit floor most
 * org-wide policies require.
 */
function generatePassword(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Create a new agent. Returns a one-time plaintext password;
 * the DB row stores only the `argon2id` hash.
 *
 * PR 4 of `remove-scope-authorization`: the `scopes` input
 * was removed. The `users.scopes` column is inert legacy
 * storage and defaults to `[]` for new rows. The catalog /
 * pattern validation that used to gate agent creation is
 * gone.
 *
 * Validation:
 * - `username` must be non-empty, ≤ 64 chars, and contain only
 *   `[A-Za-z0-9_.-]` (the same shape we accept in the auth
 *   module's `keyHash`/`id` fields).
 */
export async function createAgent(
  db: AuthorityDatabase,
  input: CreateAgentInput,
): Promise<CreateAgentResult> {
  const username = input.username.trim();
  if (username.length === 0 || username.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(username)) {
    return { ok: false, reason: "invalid_username" };
  }
  const plaintext = generatePassword();
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(plaintext);
  } catch (e) {
    throw new Error(
      `createAgent: hashPassword failed: ${(e as Error).message}`,
    );
  }
  const requireChange = input.requireChangeOnFirstLogin === true ? 1 : 0;
  try {
    const inserted = await withSingleWriter(db, async (trx) => {
      const result = await trx.execute(
        `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
         VALUES (?, ?, '[]', 1, ?, ?)`,
        [
          username,
          passwordHash,
          requireChange,
          input.now,
        ],
      );
      // The `sqlite3` driver returns a `Statement` from
      // `run()` whose `lastID` is the new row's id. We
      // re-SELECT the row to return the canonical shape.
      const rows = await trx.select<{ id: number }>(
        "SELECT id FROM users WHERE username = ?",
        [username],
      );
      const id = rows[0]?.id;
      if (typeof id !== "number") {
        throw new Error("createAgent: row id not found after insert");
      }
      return id;
    });
    const agent: AgentRecord = {
      id: inserted,
      username,
      scopes: [],
      enabled: true,
      requireChangeOnFirstLogin: input.requireChangeOnFirstLogin === true,
      createdAt: input.now,
      lastLoginAt: null,
    };
    return { ok: true, agent, plaintextPassword: plaintext };
  } catch (e) {
    // UNIQUE constraint on `username` — surfaced as
    // `duplicate` so the router can render a sanitized
    // error page. Any other error is rethrown so the
    // router does not silently swallow a real failure.
    if (isUniqueConstraintError(e)) {
      return { ok: false, reason: "duplicate" };
    }
    throw e;
  }
}

/**
 * List agents newest-first. The query is bounded by the
 * `LIMIT` so a runaway DB cannot OOM the operator's
 * browser. The cap is generous (1000) — the admin UI is a
 * small-scale tool, not a directory service.
 */
export async function listAgents(db: AuthorityDatabase): Promise<AgentRecord[]> {
  const rows = await db.select<{
    id: number;
    username: string;
    scopes: string;
    enabled: number;
    requireChangeOnFirstLogin: number;
    createdAt: number;
    lastLoginAt: number | null;
  }>(
    `SELECT id, username, scopes, enabled, requireChangeOnFirstLogin, createdAt, lastLoginAt
     FROM users ORDER BY createdAt DESC, id DESC LIMIT 1000`,
  );
  return rows.map(rowToAgent);
}

/**
 * Read a single agent by id. Returns `null` when the id is
 * unknown.
 */
export async function getAgentById(
  db: AuthorityDatabase,
  id: number,
): Promise<AgentRecord | null> {
  const rows = await db.select<{
    id: number;
    username: string;
    scopes: string;
    enabled: number;
    requireChangeOnFirstLogin: number;
    createdAt: number;
    lastLoginAt: number | null;
  }>(
    `SELECT id, username, scopes, enabled, requireChangeOnFirstLogin, createdAt, lastLoginAt
     FROM users WHERE id = ? LIMIT 1`,
    [id],
  );
  const r = rows[0];
  return r ? rowToAgent(r) : null;
}

/**
 * Read a single agent by username. Returns `null` when the
 * username is unknown. Used by the admin login form.
 */
export async function getAgentByUsername(
  db: AuthorityDatabase,
  username: string,
): Promise<AgentRecord | null> {
  const rows = await db.select<{
    id: number;
    username: string;
    scopes: string;
    enabled: number;
    requireChangeOnFirstLogin: number;
    createdAt: number;
    lastLoginAt: number | null;
  }>(
    `SELECT id, username, scopes, enabled, requireChangeOnFirstLogin, createdAt, lastLoginAt
     FROM users WHERE username = ? LIMIT 1`,
    [username],
  );
  const r = rows[0];
  return r ? rowToAgent(r) : null;
}

/**
 * Read a single agent by id INCLUDING the password hash.
 * Internal use only — the public `getAgentById` strips the
 * hash. The router never calls this directly; it is exported
 * for the auth flow (login) which needs to verify the hash.
 */
async function getAgentByIdWithHash(
  db: AuthorityDatabase,
  id: number,
): Promise<(AgentRecord & { passwordHash: string }) | null> {
  const rows = await db.select<{
    id: number;
    username: string;
    scopes: string;
    enabled: number;
    requireChangeOnFirstLogin: number;
    createdAt: number;
    lastLoginAt: number | null;
    passwordHash: string;
  }>(
    `SELECT id, username, scopes, enabled, requireChangeOnFirstLogin, createdAt, lastLoginAt, passwordHash
     FROM users WHERE id = ? LIMIT 1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return { ...rowToAgent(r), passwordHash: r.passwordHash };
}

/**
 * Enable or disable an agent. Returns `true` when the row was
 * updated, `false` when the id is unknown.
 */
export async function setAgentEnabled(
  db: AuthorityDatabase,
  id: number,
  enabled: boolean,
): Promise<boolean> {
  return withSingleWriter(db, async (trx) => {
    // SQLite's `run` callback does not return the rowcount in
    // a Promise-friendly way; we use `select` to confirm the
    // row exists and `execute` to update. The pattern is
    // safe because the trx is serialized.
    const existing = await trx.select<{ id: number }>(
      "SELECT id FROM users WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return false;
    await trx.execute("UPDATE users SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
    return true;
  });
}

/**
 * Rotate an agent's password. Returns a new one-time
 * plaintext. The DB row is updated with the new
 * `argon2id` hash, and `requireChangeOnFirstLogin` is
 * cleared (the rotation flow is the operator's signal that
 * the bootstrap admin can now mint tokens).
 */
export async function rotateAgentPassword(
  db: AuthorityDatabase,
  id: number,
  now: number,
): Promise<RotatePasswordResult> {
  const existing = await getAgentByIdWithHash(db, id);
  if (!existing) return { ok: false, reason: "not_found" };
  const plaintext = generatePassword();
  const passwordHash = await hashPassword(plaintext);
  await withSingleWriter(db, async (trx) => {
    await trx.execute(
      "UPDATE users SET passwordHash = ?, requireChangeOnFirstLogin = 0 WHERE id = ?",
      [passwordHash, id],
    );
  });
  void now;
  return { ok: true, plaintextPassword: plaintext };
}

/**
 * Self-service password rotation. Used by the admin UI's
 * "change my password" form. The behavior depends on the
 * user's `requireChangeOnFirstLogin` flag:
 * - When the flag is `true` (bootstrap case), the
 *   `currentPassword` argument is IGNORED. The admin just
 *   submitted the env password to log in; they do not need
 *   to re-type it.
 * - When the flag is `false` (normal case), the
 *   `currentPassword` argument is REQUIRED. The function
 *   verifies it against the stored hash before updating.
 *
 * On success, the function clears the
 * `requireChangeOnFirstLogin` flag so the admin can mint
 * tokens after a bootstrap rotation.
 *
 * The `newPassword` is the LITERAL plaintext the operator
 * chose. Unlike `createAgent` / `rotateAgentPassword`,
 * which generate a random secret, self-rotation accepts
 * any string the operator types that meets a minimum
 * length (8 chars). The minimum is a defensive default;
 * the spec does not pin a specific floor.
 */
export async function changeOwnPassword(
  db: AuthorityDatabase,
  id: number,
  input: ChangeOwnPasswordInput,
): Promise<ChangeOwnPasswordResult> {
  const newPassword = input.newPassword;
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return { ok: false, reason: "invalid_new" };
  }
  const existing = await getAgentByIdWithHash(db, id);
  if (!existing) return { ok: false, reason: "not_found" };
  // When the flag is set, the operator is completing the
  // bootstrap rotation — no current-password check.
  if (!existing.requireChangeOnFirstLogin) {
    if (typeof input.currentPassword !== "string" || input.currentPassword.length === 0) {
      return { ok: false, reason: "invalid_current" };
    }
    const ok = await verifyPassword(existing.passwordHash, input.currentPassword);
    if (!ok) return { ok: false, reason: "invalid_current" };
  }
  const newHash = await hashPassword(newPassword);
  await withSingleWriter(db, async (trx) => {
    await trx.execute(
      "UPDATE users SET passwordHash = ?, requireChangeOnFirstLogin = 0 WHERE id = ?",
      [newHash, id],
    );
  });
  void input.now;
  return { ok: true, plaintextPassword: newPassword };
}

/**
 * Update the `lastLoginAt` timestamp. Called on a successful
 * admin login. Returns `true` on success, `false` when the
 * id is unknown.
 */
export async function recordAgentLogin(
  db: AuthorityDatabase,
  id: number,
  now: number,
): Promise<boolean> {
  return withSingleWriter(db, async (trx) => {
    const existing = await trx.select<{ id: number }>(
      "SELECT id FROM users WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return false;
    await trx.execute("UPDATE users SET lastLoginAt = ? WHERE id = ?", [now, id]);
    return true;
  });
}

/**
 * Verify an admin's password. The function is audit-safe:
 * the supplied password is NEVER logged, the failure
 * reasons are normalized (`missing` for an unknown /
 * disabled user, `invalid` for a wrong password) so an
 * operator cannot enumerate valid usernames.
 */
export async function verifyAgentPassword(
  db: AuthorityDatabase,
  username: string,
  plaintext: string,
): Promise<VerifyPasswordResult> {
  const rows = await db.select<{
    id: number;
    username: string;
    scopes: string;
    enabled: number;
    requireChangeOnFirstLogin: number;
    createdAt: number;
    lastLoginAt: number | null;
    passwordHash: string;
  }>(
    `SELECT id, username, scopes, enabled, requireChangeOnFirstLogin, createdAt, lastLoginAt, passwordHash
     FROM users WHERE username = ? LIMIT 1`,
    [username],
  );
  const r = rows[0];
  if (!r) return { ok: false, reason: "missing" };
  if (r.enabled !== 1) return { ok: false, reason: "missing" };
  const ok = await verifyPassword(r.passwordHash, plaintext);
  if (!ok) return { ok: false, reason: "invalid" };
  return { ok: true, agent: rowToAgent(r) };
}

function rowToAgent(r: {
  id: number;
  username: string;
  scopes: string;
  enabled: number;
  requireChangeOnFirstLogin: number;
  createdAt: number;
  lastLoginAt: number | null;
}): AgentRecord {
  return {
    id: r.id,
    username: r.username,
    // INERT legacy column — read for BC shape, never validated
    // or surfaced through the admin UI.
    scopes: parseScopeList(r.scopes),
    enabled: r.enabled === 1,
    requireChangeOnFirstLogin: r.requireChangeOnFirstLogin === 1,
    createdAt: r.createdAt,
    lastLoginAt: r.lastLoginAt,
  };
}

function parseScopeList(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/**
 * Detect a SQLite UNIQUE-constraint error. The `sqlite3`
 * driver sets `err.code = "SQLITE_CONSTRAINT"` and the
 * message contains "UNIQUE constraint failed". We use a
 * defense-in-depth check on the message so a future driver
 * change cannot silently break duplicate detection.
 */
function isUniqueConstraintError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as Error & { code?: string };
  if (typeof err.code === "string" && err.code.toUpperCase() === "SQLITE_CONSTRAINT") {
    return /UNIQUE constraint failed/i.test(err.message);
  }
  return /UNIQUE constraint failed/i.test(err.message);
}
