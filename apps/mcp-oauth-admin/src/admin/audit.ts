/**
 * Audit log writer and redaction helper.
 *
 * The mcp-admin-ui spec requires:
 * - Every admin UI action (login success/failure, agent CRUD,
 *   client CRUD, scope delete, refresh-token revoke) appends an
 *   `audit_log` row.
 * - The row shape is `(ts, actor, action, target, ip, outcome)`.
 * - Audit-safety: the `target` and `ip` columns MUST NOT contain
 *   bearer tokens, password hashes (64-char hex), or any value
 *   that could leak a secret. The `auditAppend` helper rejects
 *   such values BEFORE the write so they never reach the
 *   database.
 *
 * The redaction helper (`redactAuditValue`) is the viewer-side
 * rendering function: when the audit viewer displays a row, it
 * redacts the `target` / `ip` columns in the HTML so an operator
 * reading the page over the shoulder does not see a secret. The
 * database itself stores the (sanitized) value as written.
 *
 * Audit-safety contract:
 * - `auditAppend` validates the `target` and `ip` fields. A
 *   Bearer token (the canonical `Bearer <jwt>` shape) or a
 *   64-char hex string (the canonical `argon2id` or `sha256`
 *   hash) is rejected with a `RangeError`. The function never
 *   writes the offending row.
 * - `redactAuditValue` is a pure function: it returns `***` for
 *   any value matching the redaction pattern, and the value
 *   itself otherwise. The viewer HTML escapes the result before
 *   embedding it in a page.
 */

import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";

/** The audit row shape — both for the `auditAppend` input and the `listAuditRows` output. */
export type AuditEntry = {
  ts: number;
  actor: string;
  action: string;
  target?: string | null;
  ip?: string | null;
  outcome: string;
};

export type AuditRow = {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  ip: string | null;
  outcome: string;
};

const HEX64_PATTERN = /^[a-fA-F0-9]{64}$/;
const BEARER_PATTERN = /^Bearer\s+\S+/i;

/**
 * Append an audit row. The function validates the `target` and
 * `ip` fields against the redaction patterns; a value that
 * matches is rejected with a `RangeError` (the operator's
 * caller is mis-using the helper; we never want to write the
 * value).
 *
 * The `actor` and `action` fields are also length-checked so
 * the row shape stays predictable. We accept any printable
 * string; the caller is responsible for picking a sensible
 * action key (e.g. `agent.create`, `client.rotate`).
 */
export async function auditAppend(
  db: AuthorityDatabase,
  entry: AuditEntry,
): Promise<void> {
  // Validate the actor / action.
  if (typeof entry.actor !== "string" || entry.actor.length === 0 || entry.actor.length > 256) {
    throw new RangeError(
      `auditAppend: actor must be a non-empty string up to 256 chars; got ${entry.actor}`,
    );
  }
  if (typeof entry.action !== "string" || entry.action.length === 0 || entry.action.length > 256) {
    throw new RangeError(
      `auditAppend: action must be a non-empty string up to 256 chars; got ${entry.action}`,
    );
  }
  if (typeof entry.outcome !== "string" || entry.outcome.length === 0 || entry.outcome.length > 64) {
    throw new RangeError(
      `auditAppend: outcome must be a non-empty string up to 64 chars; got ${entry.outcome}`,
    );
  }
  // Reject secrets in target / ip BEFORE we touch the database.
  if (entry.target !== undefined && entry.target !== null) {
    assertSafeAuditField("target", entry.target);
  }
  if (entry.ip !== undefined && entry.ip !== null) {
    assertSafeAuditField("ip", entry.ip);
  }
  await withSingleWriter(db, async (trx) => {
    await trx.execute(
      `INSERT INTO audit_log (ts, actor, action, target, ip, outcome)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.ts, entry.actor, entry.action, entry.target ?? null, entry.ip ?? null, entry.outcome],
    );
  });
}

/**
 * Validate that a value is safe to persist in an audit column.
 * Throws `RangeError` when the value matches a known-secret
 * pattern (Bearer token, 64-char hex hash). The message names
 * the field and the offending pattern; the actual value is
 * NEVER included in the error message (audit-safety).
 */
function assertSafeAuditField(field: string, value: string): void {
  if (BEARER_PATTERN.test(value)) {
    throw new RangeError(
      `auditAppend: ${field} looks like a Bearer token; refusing to write. ` +
        `The audit log MUST NOT contain tokens.`,
    );
  }
  if (HEX64_PATTERN.test(value)) {
    throw new RangeError(
      `auditAppend: ${field} is a 64-char hex value (likely a hash); refusing to write. ` +
        `The audit log MUST NOT contain password hashes or token hashes.`,
    );
  }
}

/**
 * Redact a value for display in the audit viewer. Pure
 * function: same input → same output. Returns `null` /
 * `undefined` / `""` passthrough so the caller can embed the
 * result in a template without a null check.
 */
export function redactAuditValue(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (value.length === 0) return value;
  if (BEARER_PATTERN.test(value)) return "***";
  // Match a 64-char hex value, optionally with surrounding context.
  // The replacement keeps the surrounding context and replaces the
  // hex run with ***.
  if (HEX64_PATTERN.test(value)) return "***";
  const match = value.match(/[a-fA-F0-9]{64}/);
  if (match) {
    return value.replace(/[a-fA-F0-9]{64}/, "***");
  }
  return value;
}

/** The filter shape for `listAuditRows` / `countAuditRows`. */
export type AuditFilter = {
  limit: number;
  offset: number;
  actor?: string;
  action?: string;
  fromTs?: number;
  toTs?: number;
};

/**
 * List audit rows newest-first with optional filters. The
 * pagination contract is `(limit, offset)` with `limit` rows
 * starting at `offset` (DESC by `ts`, then by `id` to break
 * ties on rows with the same `ts`).
 */
export async function listAuditRows(
  db: AuthorityDatabase,
  filter: AuditFilter,
): Promise<AuditRow[]> {
  const { sql, params } = buildAuditQuery(filter, /* count */ false);
  const rows = await db.select<{
    id: number;
    ts: number;
    actor: string;
    action: string;
    target: string | null;
    ip: string | null;
    outcome: string;
  }>(sql, params);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    action: r.action,
    target: r.target,
    ip: r.ip,
    outcome: r.outcome,
  }));
}

/**
 * Count audit rows matching the filter (ignores `limit` and
 * `offset`). Used by the viewer's pagination footer.
 */
export async function countAuditRows(
  db: AuthorityDatabase,
  filter?: Omit<AuditFilter, "limit" | "offset">,
): Promise<number> {
  const { sql, params } = buildAuditQuery(
    { limit: 0, offset: 0, ...(filter ?? {}) },
    /* count */ true,
  );
  const rows = await db.select<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

function buildAuditQuery(
  filter: AuditFilter,
  count: boolean,
): { sql: string; params: unknown[] } {
  const wheres: string[] = [];
  const params: unknown[] = [];
  if (filter.actor) {
    wheres.push("actor = ?");
    params.push(filter.actor);
  }
  if (filter.action) {
    wheres.push("action = ?");
    params.push(filter.action);
  }
  if (typeof filter.fromTs === "number") {
    wheres.push("ts >= ?");
    params.push(filter.fromTs);
  }
  if (typeof filter.toTs === "number") {
    wheres.push("ts <= ?");
    params.push(filter.toTs);
  }
  const where = wheres.length === 0 ? "" : `WHERE ${wheres.join(" AND ")}`;
  if (count) {
    return { sql: `SELECT COUNT(*) AS n FROM audit_log ${where}`, params };
  }
  const limit = Math.max(0, Math.min(filter.limit, 1000));
  const offset = Math.max(0, filter.offset);
  // DESC by ts; tie-break on id DESC so pagination is stable.
  return {
    sql: `SELECT id, ts, actor, action, target, ip, outcome FROM audit_log ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    params: [...params, limit, offset],
  };
}
