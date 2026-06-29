/**
 * Scope catalog CRUD for the admin UI.
 *
 * The mcp-admin-ui spec requires:
 * - The catalog lists every scope the authority is willing to
 *   grant. The page allows adding a new scope string and
 *   validates against `SCOPE_PATTERN` server-side.
 * - Deletion is refused when the scope is currently assigned
 *   to any agent or client; the error names the affected
 *   count (a sanitized count, not the names of the affected
 *   agents/clients — that would be a side channel).
 *
 * The catalog is the source of truth for which scopes exist.
 * The `users.scopes` and `clients.scopes` JSON columns can
 * hold any value, but the admin UI only allows catalogued
 * scopes to be assigned (the `agents.createAgent` and
 * `clients.createClient` paths validate against
 * `SCOPE_PATTERN`, which is the catalog's grammar).
 *
 * Audit-safety: the error shape on `in_use` includes the
 * count but NOT the list of affected user/client names. A
 * name leak would let an operator enumerate the agent list
 * through the delete form.
 */

import { SCOPE_PATTERN } from "@customized-mcps/mcp-http-base";
import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";

export type ScopeRecord = {
  name: string;
  description: string;
  createdAt: number;
};

export type CreateScopeInput = {
  name: string;
  description?: string;
  now: number;
};

export type CreateScopeResult =
  | { ok: true; scope: ScopeRecord }
  | { ok: false; reason: "invalid" | "duplicate" };

export type DeleteScopeResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "in_use"; count: number };

export type ScopeUsage = {
  count: number;
  assignedToAgents: number;
  assignedToClients: number;
};

/**
 * Insert a scope into the catalog. The name MUST match
 * `SCOPE_PATTERN`; bare `*` is rejected (the authority MUST
 * NOT grant `*`).
 */
export async function createScope(
  db: AuthorityDatabase,
  input: CreateScopeInput,
): Promise<CreateScopeResult> {
  const name = input.name.trim();
  if (!SCOPE_PATTERN.test(name)) {
    return { ok: false, reason: "invalid" };
  }
  const description = (input.description ?? "").trim();
  try {
    await withSingleWriter(db, async (trx) => {
      await trx.execute(
        "INSERT INTO scopes (name, description, createdAt) VALUES (?, ?, ?)",
        [name, description, input.now],
      );
    });
    return { ok: true, scope: { name, description, createdAt: input.now } };
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      return { ok: false, reason: "duplicate" };
    }
    throw e;
  }
}

/** List scopes alphabetically by name. */
export async function listScopes(db: AuthorityDatabase): Promise<ScopeRecord[]> {
  const rows = await db.select<{ name: string; description: string; createdAt: number }>(
    "SELECT name, description, createdAt FROM scopes ORDER BY name ASC",
  );
  return rows.map((r) => ({ name: r.name, description: r.description, createdAt: r.createdAt }));
}

/**
 * Count how many agents / clients reference the given scope.
 * The `users.scopes` and `clients.scopes` columns are JSON
 * arrays; we use SQLite's `json_each` to project the array
 * into a relational table and filter by exact value match.
 * This is more correct than a `LIKE` substring search (which
 * would have to deal with the `_` and `%` LIKE wildcards
 * inside valid scope names like `bi_catastro`).
 *
 * `json_each` is part of the JSON1 extension that ships with
 * SQLite by default; the npm `sqlite3` build exposes it.
 */
export async function scopeInUse(
  db: AuthorityDatabase,
  name: string,
): Promise<ScopeUsage> {
  const agentRows = await db.select<{ n: number }>(
    `SELECT COUNT(DISTINCT users.id) AS n
     FROM users, json_each(users.scopes)
     WHERE json_each.value = ?`,
    [name],
  );
  const clientRows = await db.select<{ n: number }>(
    `SELECT COUNT(DISTINCT clients.id) AS n
     FROM clients, json_each(clients.scopes)
     WHERE json_each.value = ?`,
    [name],
  );
  const assignedToAgents = agentRows[0]?.n ?? 0;
  const assignedToClients = clientRows[0]?.n ?? 0;
  return {
    count: assignedToAgents + assignedToClients,
    assignedToAgents,
    assignedToClients,
  };
}

/**
 * Delete a scope from the catalog. Refused when the scope
 * is currently assigned to any agent or client. The
 * `DeleteScopeResult` carries the count so the admin UI
 * can render "scope is assigned to 3 rows; revoke or rotate
 * first".
 */
export async function deleteScope(
  db: AuthorityDatabase,
  name: string,
): Promise<DeleteScopeResult> {
  return withSingleWriter(db, async (trx) => {
    const existing = await trx.select<{ name: string }>(
      "SELECT name FROM scopes WHERE name = ?",
      [name],
    );
    if (existing.length === 0) return { ok: false, reason: "not_found" };
    const usage = await scopeInUseInTrx(trx, name);
    if (usage > 0) {
      return { ok: false, reason: "in_use", count: usage };
    }
    await trx.execute("DELETE FROM scopes WHERE name = ?", [name]);
    return { ok: true };
  });
}

async function scopeInUseInTrx(
  trx: AuthorityDatabase,
  name: string,
): Promise<number> {
  const agentRows = await trx.select<{ n: number }>(
    `SELECT COUNT(DISTINCT users.id) AS n
     FROM users, json_each(users.scopes)
     WHERE json_each.value = ?`,
    [name],
  );
  const clientRows = await trx.select<{ n: number }>(
    `SELECT COUNT(DISTINCT clients.id) AS n
     FROM clients, json_each(clients.scopes)
     WHERE json_each.value = ?`,
    [name],
  );
  return (agentRows[0]?.n ?? 0) + (clientRows[0]?.n ?? 0);
}

function isUniqueConstraintError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as Error & { code?: string };
  if (typeof err.code === "string" && err.code.toUpperCase() === "SQLITE_CONSTRAINT") {
    return /UNIQUE constraint failed/i.test(err.message);
  }
  return /PRIMARY KEY constraint failed|UNIQUE constraint failed/i.test(err.message);
}
