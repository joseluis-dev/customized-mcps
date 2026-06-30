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
 * PR 4 of `remove-scope-authorization`:
 * - The `clients.scopes` column is INERT legacy storage. The
 *   `createClient` path no longer validates against the
 *   scope-pattern grammar (the column defaults to `[]` for
 *   new rows). The `setClientScopes` helper is removed —
 *   there is no admin route to call it, and the catalog
 *   that backed it is gone.
 *
 * Audit-safety:
 * - The `ClientRecord` shape does NOT include `clientSecretHash`
 *   so the secret hash can never leak through the admin UI.
 * - The `plaintextSecret` is the ONLY place the secret appears
 *   in plaintext form; the caller (the router) is responsible
 *   for showing it once and not persisting it.
 */

import { randomBytes } from "node:crypto";
import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";
import { hashPassword } from "../oauth/passwords.js";

/** The public client record. The shape is the row read from
 *  `clients` with the JSON `scopes` + `redirectUris` columns
 *  decoded. We do NOT include `clientSecretHash` — that is
 *  internal state. The `redirectUris` list is `[]` for
 *  pre-registered clients that pre-date the DCR work; the
 *  authorize handler treats the empty list as "use the
 *  loopback-only rule" (RFC 8252 §7.3). The DCR path is the
 *  only path that populates the list with one or more entries.
 *
 *  The `scopes` field is INERT legacy storage (PR 4 of
 *  `remove-scope-authorization`). It is read so the
 *  `ClientRecord` shape stays BC-compatible with the
 *  `clients` table; it is NOT validated, NOT exposed through
 *  the admin UI, and NOT surfaced on any rendered page. */
export type ClientRecord = {
  id: number;
  clientId: string;
  label: string;
  scopes: string[];
  redirectUris: string[];
  createdAt: number;
  lastUsedAt: number | null;
};

/**
 * `CreateClientInput` no longer carries `scopes`. The client
 * is created with the inert default `[]`; the column is
 * legacy storage. The field is removed from the public
 * input to make the removal observable at the type level.
 */
export type CreateClientInput = {
  clientId: string;
  label?: string;
  /** Optional: DCR-supplied redirect URI list. Empty when the
   *  client is pre-registered (the admin UI does not surface
   *  this field). Each URI MUST satisfy the loopback rule
   *  (RFC 8252 §7.3); the caller validates the list before
   *  passing it in. */
  redirectUris?: string[];
  /** Optional: caller-supplied plaintext secret. When
   *  present, the helper stores the `argon2id` hash of
   *  the supplied value (the plaintext is NOT
   *  regenerated). When absent, a fresh secret is
   *  generated. The DCR handler passes its
   *  pre-generated secret here so the value returned
   *  in the registration response is the same one
   *  whose hash is persisted. */
  plaintextSecret?: string;
  now: number;
};

export type CreateClientResult =
  | { ok: true; client: ClientRecord; plaintextSecret: string }
  | { ok: false; reason: "invalid_clientId" | "invalid_label" | "invalid_secret" | "duplicate" };

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
 * The minimum acceptable length for a caller-supplied
 * `plaintextSecret`. The auto-generated secret is 43
 * base64url chars (32 random bytes); the minimum allows
 * for a caller that generates a slightly shorter but
 * still strong secret while rejecting obvious mistakes
 * (empty string, single word, etc.). 16 chars is the
 * floor for ≈ 128 bits at typical printable-ASCII
 * entropy; a caller that knows the right answer will
 * pass the auto-generated value.
 *
 * When the caller-supplied value is too short, the helper
 * returns `{ ok: false, reason: "invalid_secret" }` so
 * the DCR / admin router can surface a sanitized 400.
 * The constant is exported so tests can pin the contract
 * without duplicating the magic number.
 */
export const MIN_PLAINTEXT_SECRET_LENGTH = 16;

/**
 * Create a new OAuth client. Returns a one-time plaintext
 * secret; the DB row stores only the `argon2id` hash.
 *
 * PR 4 of `remove-scope-authorization`: the `scopes` input
 * was removed. The `clients.scopes` column is inert legacy
 * storage and defaults to `[]` for new rows.
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
  // Sanity-check a caller-supplied plaintext secret. The
  // check fires only when the caller passed a value
  // (the DCR handler / admin UI's auto-generated path
  // omits the field; the check is silent on that path).
  // The `invalid_secret` reason is a stable code (the
  // router / DCR handler map it to a sanitized 400); the
  // response body NEVER echoes the supplied value.
  if (typeof input.plaintextSecret === "string" &&
      input.plaintextSecret.length < MIN_PLAINTEXT_SECRET_LENGTH) {
    return { ok: false, reason: "invalid_secret" };
  }
  const plaintext = input.plaintextSecret ?? generateClientSecret();
  const secretHash = await hashPassword(plaintext);
  const redirectUris = input.redirectUris ?? [];
  try {
    const inserted = await withSingleWriter(db, async (trx) => {
      await trx.execute(
        `INSERT INTO clients (clientId, clientSecretHash, label, scopes, redirectUris, createdAt)
         VALUES (?, ?, ?, '[]', ?, ?)`,
        [clientId, secretHash, label, JSON.stringify(redirectUris), input.now],
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
      scopes: [],
      redirectUris: [...redirectUris],
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
    redirectUris: string;
    createdAt: number;
    lastUsedAt: number | null;
  }>(
    `SELECT id, clientId, label, scopes, redirectUris, createdAt, lastUsedAt
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
    redirectUris: string;
    createdAt: number;
    lastUsedAt: number | null;
  }>(
    `SELECT id, clientId, label, scopes, redirectUris, createdAt, lastUsedAt
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
    redirectUris: string;
    createdAt: number;
    lastUsedAt: number | null;
  }>(
    `SELECT id, clientId, label, scopes, redirectUris, createdAt, lastUsedAt
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
  redirectUris?: string;
  createdAt: number;
  lastUsedAt: number | null;
}): ClientRecord {
  return {
    id: r.id,
    clientId: r.clientId,
    label: r.label,
    // INERT legacy column — read for BC shape, never validated
    // or surfaced through the admin UI.
    scopes: parseScopeList(r.scopes),
    redirectUris: parseScopeList(r.redirectUris ?? "[]"),
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
