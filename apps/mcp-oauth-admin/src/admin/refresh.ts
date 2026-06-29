/**
 * Refresh-token revocation for the admin UI.
 *
 * The mcp-admin-ui spec requires:
 * - The refresh-token revocation page lists active refresh
 *   tokens with `agentId`, `clientId`, `issuedAt`, and a
 *   "revoke" action.
 * - The form sets `revokedAt` to now, appends an `audit_log`
 *   row, and returns the admin to the list with the row
 *   marked revoked.
 *
 * The `listRefreshTokens` query joins `users` and `clients`
 * to expose the human-readable `agentUsername` and
 * `clientId` / `clientLabel` fields. The internal numeric
 * ids (`agentId`, `clientInternalId`) are kept for the
 * admin UI's row actions; the `revokeRefreshToken` function
 * is keyed by the `refresh_tokens.id` column.
 *
 * Audit-safety:
 * - The audit row's `target` field is `refresh:<id>` — a
 *   sanitized reference, never a token hash. The `auditAppend`
 *   helper would reject a 64-char hex value, so the
 *   `target` field MUST be a small structured id.
 * - The `actor` field is the admin's username (or
 *   `system:rotate` for any future automated revocations).
 * - The `ip` field is the request's remote address (or
 *   `null` for internal revocations).
 */

import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";
import { auditAppend } from "./audit.js";

export type RefreshTokenRow = {
  id: number;
  agentId: number;
  agentUsername: string;
  clientInternalId: number;
  clientId: string;
  clientLabel: string;
  scopes: string[];
  issuedAt: number;
  revokedAt: number | null;
};

export type ListRefreshOptions = {
  limit: number;
  offset: number;
  onlyActive?: boolean;
};

export type RevokeResult =
  | { ok: true; row: RefreshTokenRow }
  | { ok: false; reason: "not_found" | "already_revoked" };

/**
 * List refresh tokens newest-first, with the agent username
 * and client clientId joined in. The internal `clientId`
 * column on `refresh_tokens` is the row id (a numeric FK
 * to `clients.id`); we surface the OAuth `clientId` string
 * from the join.
 */
export async function listRefreshTokens(
  db: AuthorityDatabase,
  options: ListRefreshOptions,
): Promise<RefreshTokenRow[]> {
  const limit = Math.max(0, Math.min(options.limit, 1000));
  const offset = Math.max(0, options.offset);
  const where = options.onlyActive === true ? "WHERE rt.revokedAt IS NULL" : "";
  const rows = await db.select<{
    id: number;
    agentId: number;
    agentUsername: string;
    clientInternalId: number;
    clientId: string;
    clientLabel: string;
    scopes: string;
    issuedAt: number;
    revokedAt: number | null;
  }>(
    `SELECT
       rt.id           AS id,
       rt.agentId      AS agentId,
       u.username      AS agentUsername,
       rt.clientId     AS clientInternalId,
       c.clientId      AS clientId,
       c.label         AS clientLabel,
       rt.scopes       AS scopes,
       rt.issuedAt     AS issuedAt,
       rt.revokedAt    AS revokedAt
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.agentId
     JOIN clients c ON c.id = rt.clientId
     ${where}
     ORDER BY rt.issuedAt DESC, rt.id DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentUsername: r.agentUsername,
    clientInternalId: r.clientInternalId,
    clientId: r.clientId,
    clientLabel: r.clientLabel,
    scopes: parseScopeList(r.scopes),
    issuedAt: r.issuedAt,
    revokedAt: r.revokedAt,
  }));
}

/**
 * Count refresh tokens. When `onlyActive` is true, only
 * non-revoked tokens are counted.
 */
export async function countRefreshTokens(
  db: AuthorityDatabase,
  options?: { onlyActive?: boolean },
): Promise<number> {
  const where = options?.onlyActive === true ? "WHERE revokedAt IS NULL" : "";
  const rows = await db.select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM refresh_tokens ${where}`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * Revoke a refresh token. Sets `revokedAt` to `now` and
 * appends an `audit_log` row. The function is idempotent
 * guard: an already-revoked token returns
 * `ok=false, reason='already_revoked'` and does NOT append
 * a duplicate audit row.
 *
 * The function is wrapped in `withSingleWriter` so the
 * `revokedAt` update and the audit-log insert are
 * atomic with respect to other writers.
 */
export async function revokeRefreshToken(
  db: AuthorityDatabase,
  id: number,
  now: number,
  actor: string,
  ip: string | null,
): Promise<RevokeResult> {
  return withSingleWriter(db, async (trx) => {
    const rows = await trx.select<{
      id: number;
      agentId: number;
      agentUsername: string;
      clientInternalId: number;
      clientId: string;
      clientLabel: string;
      scopes: string;
      issuedAt: number;
      revokedAt: number | null;
    }>(
      `SELECT
         rt.id           AS id,
         rt.agentId      AS agentId,
         u.username      AS agentUsername,
         rt.clientId     AS clientInternalId,
         c.clientId      AS clientId,
         c.label         AS clientLabel,
         rt.scopes       AS scopes,
         rt.issuedAt     AS issuedAt,
         rt.revokedAt    AS revokedAt
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.agentId
       JOIN clients c ON c.id = rt.clientId
       WHERE rt.id = ?
       LIMIT 1`,
      [id],
    );
    const r = rows[0];
    if (!r) return { ok: false, reason: "not_found" as const };
    if (r.revokedAt !== null) {
      return { ok: false, reason: "already_revoked" as const };
    }
    await trx.execute(
      "UPDATE refresh_tokens SET revokedAt = ? WHERE id = ?",
      [now, id],
    );
    // Append the audit row inside the same trx so the
    // revoking action and the audit row are committed
    // together.
    await auditAppendInTrx(trx, {
      ts: now,
      actor,
      action: "refresh.revoke",
      target: `refresh:${id}`,
      ip,
      outcome: "ok",
    });
    const row: RefreshTokenRow = {
      id: r.id,
      agentId: r.agentId,
      agentUsername: r.agentUsername,
      clientInternalId: r.clientInternalId,
      clientId: r.clientId,
      clientLabel: r.clientLabel,
      scopes: parseScopeList(r.scopes),
      issuedAt: r.issuedAt,
      revokedAt: now,
    };
    return { ok: true, row };
  });
}

/**
 * Audit-log writer that uses the trx's connection (not the
 * outer `db`). We inline a thin wrapper here so the
 * `withSingleWriter` discipline is preserved: the audit row
 * and the `revokedAt` update share a single SQLite write
 * transaction.
 */
async function auditAppendInTrx(
  trx: AuthorityDatabase,
  entry: Parameters<typeof auditAppend>[1],
): Promise<void> {
  // Validate (defense in depth — the auditAppend helper also
  // validates, but we want to fail BEFORE the trx is in a
  // half-committed state).
  if (typeof entry.target === "string" && /[a-fA-F0-9]{64}/.test(entry.target)) {
    throw new RangeError("refresh.revoke: target looks like a hash; refusing to write");
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
