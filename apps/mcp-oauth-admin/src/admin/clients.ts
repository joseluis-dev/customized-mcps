/**
 * OAuth client CRUD for the admin UI.
 *
 * The mcp-admin-ui spec requires:
 * - The admin can list, create, rotate the secret of, and
 *   delete OAuth clients.
 * - `createClient` generates a one-time plaintext secret,
 *   stores the `argon2id` hash, and returns the plaintext in
 *   the response. The hash is the only thing persisted; the
 *   plaintext is shown to the admin ONCE on the create / rotate
 *   response page.
 * - `rotateClientSecret` returns a new plaintext; the old
 *   secret returns `401 invalid_client` on the next token
 *   request.
 * - `deleteClient` is allowed only when the client has no
 *   outstanding refresh tokens (the spec's "refuses deletion
 *   when in use" rule for clients). The check counts
 *   `refresh_tokens` rows for this client where
 *   `revokedAt IS NULL`.
 *
 * Audit-safety:
 * - The `ClientRecord` shape does NOT include `clientSecretHash`
 *   so the secret hash can never leak through the admin UI.
 * - The `plaintextSecret` is the ONLY place the secret appears
 *   in plaintext form; the caller (the router) is responsible
 *   for showing it once and not persisting it.
 */

import { randomBytes } from "node:crypto";
import { SCOPE_PATTERN } from "@customized-mcps/mcp-http-base";
import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";
import { hashPassword } from "../oauth/passwords.js";

/** The public client record. The shape is the row read from
 *  `clients` with the JSON `scopes` column decoded. We do NOT
 *  include `clientSecretHash` — that is internal state. */
export type ClientRecord = {
  id: number;
  clientId: string;
  label: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
};

export type CreateClientInput = {
  clientId: string;
  label?: string;
  scopes: string[];
  now: number;
};

export type CreateClientResult =
  | { ok: true; client: ClientRecord; plaintextSecret: string }
  | { ok: false; reason: "invalid_clientId" | "invalid_label" | "invalid_scope" | "duplicate" };

export type RotateSecretResult =
  | { ok: true; plaintextSecret: string }
  | { ok: false; reason: "not_found" };

export type DeleteClientResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "in_use"; count: number };

function generateClientSecret(): string {
  // 32 bytes → 43 base64url chars. ~192 bits of entropy.
  return randomBytes(32).toString("base64url");
}

/**
 * Create a new OAuth client. Returns a one-time plaintext
 * secret; the DB row stores only the `argon2id` hash.
 */
export async function createClient(
  db: AuthorityDatabase,
  input: CreateClientInput,
): Promise<CreateClientResult> {
  const clientId = input.clientId.trim();
  if (clientId.length === 0 || clientId.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(clientId)) {
    return { ok: false, reason: "invalid_clientId" };
  }
  const label = (input.label ?? "").trim();
  for (const scope of input.scopes) {
    if (!SCOPE_PATTERN.test(scope)) {
      return { ok: false, reason: "invalid_scope" };
    }
  }
  const plaintext = generateClientSecret();
  const secretHash = await hashPassword(plaintext);
  try {
    const inserted = await withSingleWriter(db, async (trx) => {
      await trx.execute(
        `INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
        [clientId, secretHash, label, JSON.stringify(input.scopes), input.now],
      );
      const rows = await trx.select<{ id: number }>(
        "SELECT id FROM clients WHERE clientId = ?",
        [clientId],
      );
      const id = rows[0]?.id;
      if (typeof id !== "number") {
        throw new Error("createClient: row id not found after insert");
      }
      return id;
    });
    const client: ClientRecord = {
      id: inserted,
      clientId,
      label,
      scopes: [...input.scopes],
      createdAt: input.now,
      lastUsedAt: null,
    };
    return { ok: true, client, plaintextSecret: plaintext };
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      return { ok: false, reason: "duplicate" };
    }
    throw e;
  }
}

/** List clients newest-first. */
export async function listClients(db: AuthorityDatabase): Promise<ClientRecord[]> {
  const rows = await db.select<{
    id: number;
    clientId: string;
    label: string;
    scopes: string;
    createdAt: number;
    lastUsedAt: number | null;
  }>(
    `SELECT id, clientId, label, scopes, createdAt, lastUsedAt
     FROM clients ORDER BY createdAt DESC, id DESC LIMIT 1000`,
  );
  return rows.map(rowToClient);
}

export async function getClientById(
  db: AuthorityDatabase,
  id: number,
): Promise<ClientRecord | null> {
  const rows = await db.select<{
    id: number;
    clientId: string;
    label: string;
    scopes: string;
    createdAt: number;
    lastUsedAt: number | null;
  }>(
    `SELECT id, clientId, label, scopes, createdAt, lastUsedAt
     FROM clients WHERE id = ? LIMIT 1`,
    [id],
  );
  const r = rows[0];
  return r ? rowToClient(r) : null;
}

export async function getClientByClientId(
  db: AuthorityDatabase,
  clientId: string,
): Promise<ClientRecord | null> {
  const rows = await db.select<{
    id: number;
    clientId: string;
    label: string;
    scopes: string;
    createdAt: number;
    lastUsedAt: number | null;
  }>(
    `SELECT id, clientId, label, scopes, createdAt, lastUsedAt
     FROM clients WHERE clientId = ? LIMIT 1`,
    [clientId],
  );
  const r = rows[0];
  return r ? rowToClient(r) : null;
}

/**
 * Rotate a client's secret. Returns a new one-time plaintext;
 * the DB row is updated with the new `argon2id` hash.
 */
export async function rotateClientSecret(
  db: AuthorityDatabase,
  id: number,
  now: number,
): Promise<RotateSecretResult> {
  const existing = await getClientById(db, id);
  if (!existing) return { ok: false, reason: "not_found" };
  const plaintext = generateClientSecret();
  const secretHash = await hashPassword(plaintext);
  await withSingleWriter(db, async (trx) => {
    await trx.execute(
      "UPDATE clients SET clientSecretHash = ? WHERE id = ?",
      [secretHash, id],
    );
  });
  void now;
  return { ok: true, plaintextSecret: plaintext };
}

/**
 * Replace a client's scope set. Each scope MUST match
 * `SCOPE_PATTERN`. An empty array is allowed.
 */
export async function setClientScopes(
  db: AuthorityDatabase,
  id: number,
  scopes: string[],
): Promise<boolean> {
  for (const scope of scopes) {
    if (!SCOPE_PATTERN.test(scope)) return false;
  }
  return withSingleWriter(db, async (trx) => {
    const existing = await trx.select<{ id: number }>(
      "SELECT id FROM clients WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return false;
    await trx.execute("UPDATE clients SET scopes = ? WHERE id = ?", [
      JSON.stringify(scopes),
      id,
    ]);
    return true;
  });
}

/**
 * Set a client's label. Empty / whitespace-only labels are
 * rejected so the admin UI never shows a blank row.
 */
export async function setClientLabel(
  db: AuthorityDatabase,
  id: number,
  label: string,
): Promise<boolean> {
  const trimmed = label.trim();
  if (trimmed.length === 0) return false;
  return withSingleWriter(db, async (trx) => {
    const existing = await trx.select<{ id: number }>(
      "SELECT id FROM clients WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return false;
    await trx.execute("UPDATE clients SET label = ? WHERE id = ?", [trimmed, id]);
    return true;
  });
}

/**
 * Update the `lastUsedAt` timestamp. Called on a successful
 * `client_credentials` grant.
 */
export async function recordClientUsed(
  db: AuthorityDatabase,
  id: number,
  now: number,
): Promise<boolean> {
  return withSingleWriter(db, async (trx) => {
    const existing = await trx.select<{ id: number }>(
      "SELECT id FROM clients WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return false;
    await trx.execute("UPDATE clients SET lastUsedAt = ? WHERE id = ?", [now, id]);
    return true;
  });
}

/**
 * Delete a client. Refused when the client has any
 * outstanding (non-revoked) refresh tokens. The reason
 * `in_use` carries the count so the admin UI can render a
 * sanitized error message ("client has 3 outstanding refresh
 * tokens; revoke them first").
 */
export async function deleteClient(
  db: AuthorityDatabase,
  id: number,
): Promise<DeleteClientResult> {
  return withSingleWriter(db, async (trx) => {
    const existing = await trx.select<{ id: number }>(
      "SELECT id FROM clients WHERE id = ?",
      [id],
    );
    if (existing.length === 0) return { ok: false, reason: "not_found" };
    const tokenRows = await trx.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM refresh_tokens WHERE clientId = ? AND revokedAt IS NULL",
      [id],
    );
    const count = tokenRows[0]?.n ?? 0;
    if (count > 0) {
      return { ok: false, reason: "in_use", count };
    }
    await trx.execute("DELETE FROM refresh_tokens WHERE clientId = ?", [id]);
    await trx.execute("DELETE FROM clients WHERE id = ?", [id]);
    return { ok: true };
  });
}

function rowToClient(r: {
  id: number;
  clientId: string;
  label: string;
  scopes: string;
  createdAt: number;
  lastUsedAt: number | null;
}): ClientRecord {
  return {
    id: r.id,
    clientId: r.clientId,
    label: r.label,
    scopes: parseScopeList(r.scopes),
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
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

function isUniqueConstraintError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as Error & { code?: string };
  if (typeof err.code === "string" && err.code.toUpperCase() === "SQLITE_CONSTRAINT") {
    return /UNIQUE constraint failed/i.test(err.message);
  }
  return /UNIQUE constraint failed/i.test(err.message);
}
