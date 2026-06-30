/**
 * Unit tests for the OAuth client CRUD module.
 *
 * The mcp-admin-ui spec requires:
 * - Pages to list, create, edit, and disable OAuth clients.
 * - Each row shows `clientId`, `label`, `lastUsedAt`. The
 *   legacy `scopes` column is NOT surfaced through the UI
 *   (PR 4 of `remove-scope-authorization`).
 * - `createClient` generates a one-time plaintext secret,
 *   stores the `argon2id` hash, and returns the plaintext in
 *   the response.
 * - `rotateSecret` returns a new plaintext; the old secret
 *   returns `401 invalid_client` on the next token request.
 * - `deleteClient` is allowed only when the client has no
 *   outstanding refresh tokens.
 *
 * PR 4 of `remove-scope-authorization`:
 * - The `scopes` input was removed from `createClient`. The
 *   `clients.scopes` column is INERT legacy storage and
 *   defaults to `[]` for new rows.
 * - The `setClientScopes` helper was removed (no admin route
 *   to call it; the catalog that backed it is gone).
 *
 * Test layer: unit. Real SQLite (in-memory) for the writes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, initializeSchema, type AuthorityDatabase } from "../../src/db/index.js";
import {
  createClient,
  listClients,
  getClientById,
  getClientByClientId,
  rotateClientSecret,
  setClientLabel,
  recordClientUsed,
  deleteClient,
  type ClientRecord,
  type CreateClientResult,
  type DeleteClientResult,
} from "../../src/admin/clients.js";
import { verifyPassword } from "../../src/oauth/passwords.js";

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

async function readClientSecretHash(db: AuthorityDatabase, id: number): Promise<string | null> {
  const rows = await db.select<{ clientSecretHash: string }>(
    "SELECT clientSecretHash FROM clients WHERE id = ?",
    [id],
  );
  return rows[0]?.clientSecretHash ?? null;
}

describe("admin/clients — createClient", () => {
  it("returns a plaintext secret AND stores the argon2id hash", async () => {
    // GIVEN no existing client
    // WHEN we create one
    // THEN the response includes a plaintext secret (returned
    //      exactly once) AND the DB row stores only the
    //      `argon2id` hash.
    const r = await createClient(db, {
      clientId: "bi-catastro-client",
      label: "BI Catastro app",
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plaintextSecret.length).toBeGreaterThan(8);
    const row = await getClientByClientId(db, "bi-catastro-client");
    expect(row).not.toBeNull();
    const hash = await readClientSecretHash(db, row!.id);
    expect(hash).not.toBe(r.plaintextSecret);
    const ok = await verifyPassword(hash!, r.plaintextSecret);
    expect(ok).toBe(true);
  });

  it("stores the label and createdAt (no scopes field on input — PR 4 contract)", async () => {
    const r = await createClient(db, {
      clientId: "c1",
      label: "My App",
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getClientByClientId(db, "c1");
    expect(row?.label).toBe("My App");
    expect(row?.scopes).toEqual([]);
    expect(row?.createdAt).toBe(now);
  });

  it("defaults label to empty string and scopes to []", async () => {
    const r = await createClient(db, { clientId: "c1", now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getClientByClientId(db, "c1");
    expect(row?.label).toBe("");
    expect(row?.scopes).toEqual([]);
  });

  it("rejects an empty clientId", async () => {
    const r = await createClient(db, { clientId: "", now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_clientId");
  });

  it("rejects a clientId with invalid characters", async () => {
    // The OAuth2 spec recommends a character set; we accept
    // `[A-Za-z0-9_.-]{1,64}` (the same shape as the agent
    // username, since clients and agents share the
    // identifier grammar).
    const r = await createClient(db, { clientId: "has spaces", now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_clientId");
  });

  it("rejects a duplicate clientId", async () => {
    const r1 = await createClient(db, { clientId: "c1", now });
    expect(r1.ok).toBe(true);
    const r2 = await createClient(db, { clientId: "c1", now });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe("duplicate");
  });

  it("rejects a caller-supplied plaintextSecret shorter than MIN_PLAINTEXT_SECRET_LENGTH", async () => {
    // The pre-PR review found that `createClient`
    // accepted a caller-supplied plaintext of any
    // length. The fix enforces a minimum (16 chars)
    // so a weak injected secret is rejected before it
    // ever reaches the `argon2id` hash. The DCR
    // handler's pre-generated value (32+ chars) is
    // always above the minimum, so the production
    // path is unaffected.
    const r = await createClient(db, {
      clientId: "c1",
      // 6 chars — well under the 16-char floor.
      plaintextSecret: "s3cret",
      now,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_secret");
  });

  it("accepts a 16-char caller-supplied plaintextSecret (boundary)", async () => {
    // 16 chars is the documented minimum. The
    // helper accepts the value and stores its hash.
    const r = await createClient(db, {
      clientId: "c1",
      // Exactly 16 chars — the minimum.
      plaintextSecret: "abcdefghijklmnop",
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plaintextSecret).toBe("abcdefghijklmnop");
  });

  it("the generated secret is cryptographically random (different on each call)", async () => {
    const r1 = await createClient(db, { clientId: "c1", now });
    const r2 = await createClient(db, { clientId: "c2", now });
    if (!r1.ok || !r2.ok) return;
    expect(r1.plaintextSecret).not.toBe(r2.plaintextSecret);
  });
});

describe("admin/clients — listClients", () => {
  it("returns all clients newest-first", async () => {
    await createClient(db, { clientId: "a", now: now + 0 });
    await createClient(db, { clientId: "b", now: now + 1 });
    await createClient(db, { clientId: "c", now: now + 2 });
    const rows = await listClients(db);
    expect(rows.map((r) => r.clientId)).toEqual(["c", "b", "a"]);
  });

  it("returns an empty list when no clients exist", async () => {
    const rows = await listClients(db);
    expect(rows).toEqual([]);
  });
});

describe("admin/clients — rotateClientSecret", () => {
  it("returns a NEW plaintext (different from the original) AND the old secret is invalid", async () => {
    // GIVEN a client with the initial plaintext
    // WHEN we rotate the secret
    // THEN the response is a fresh plaintext AND the DB hash
    //      matches the new plaintext (NOT the old one).
    const r = await createClient(db, { clientId: "c1", now });
    if (!r.ok) return;
    const first = r.plaintextSecret;
    const rotated = await rotateClientSecret(db, r.client.id, now + 100);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.plaintextSecret).not.toBe(first);
    const row = await getClientById(db, r.client.id);
    const hash = await readClientSecretHash(db, row!.id);
    const okNew = await verifyPassword(hash!, rotated.plaintextSecret);
    expect(okNew).toBe(true);
    const okOld = await verifyPassword(hash!, first);
    expect(okOld).toBe(false);
  });

  it("returns ok=false for an unknown id", async () => {
    const r = await rotateClientSecret(db, 9999, now);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_found");
  });
});

describe("admin/clients — setClientScopes is REMOVED (PR 4 of remove-scope-authorization)", () => {
  it("the public surface does NOT export setClientScopes", async () => {
    const mod = (await import("../../src/admin/clients.js")) as Record<string, unknown>;
    expect(mod.setClientScopes).toBeUndefined();
  });
});

describe("admin/clients — setClientLabel", () => {
  it("replaces the label", async () => {
    const r = await createClient(db, { clientId: "c1", label: "old", now });
    if (!r.ok) return;
    const ok = await setClientLabel(db, r.client.id, "new label");
    expect(ok).toBe(true);
    const after = await getClientById(db, r.client.id);
    expect(after?.label).toBe("new label");
  });

  it("rejects an empty label", async () => {
    const r = await createClient(db, { clientId: "c1", label: "x", now });
    if (!r.ok) return;
    const ok = await setClientLabel(db, r.client.id, "");
    expect(ok).toBe(false);
  });
});

describe("admin/clients — recordClientUsed", () => {
  it("updates the lastUsedAt timestamp", async () => {
    const r = await createClient(db, { clientId: "c1", now });
    if (!r.ok) return;
    await recordClientUsed(db, r.client.id, now + 50);
    const after = await getClientById(db, r.client.id);
    expect(after?.lastUsedAt).toBe(now + 50);
  });
});

describe("admin/clients — deleteClient", () => {
  it("deletes a client with no refresh tokens", async () => {
    // GIVEN a client with no refresh tokens
    // WHEN we delete it
    // THEN the row is removed.
    const r = await createClient(db, { clientId: "c1", now });
    if (!r.ok) return;
    const result = await deleteClient(db, r.client.id);
    expect(result.ok).toBe(true);
    const after = await getClientById(db, r.client.id);
    expect(after).toBeNull();
  });

  it("refuses to delete a client with outstanding (non-revoked) refresh tokens", async () => {
    // GIVEN a client with an outstanding refresh token
    // WHEN we try to delete it
    // THEN the call returns ok=false with reason 'in_use'
    //      and the affected count.
    const r = await createClient(db, { clientId: "c1", now });
    if (!r.ok) return;
    // Insert a non-revoked refresh token. We need a user
    // first because `refresh_tokens.agentId` is a FK to
    // `users.id`.
    await db.execute(
      `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
       VALUES (?, 'argon2id-stub', '[]', 1, 0, ?)`,
      ["agent-for-rt", now],
    );
    const userRows = await db.select<{ id: number }>(
      "SELECT id FROM users WHERE username = ?",
      ["agent-for-rt"],
    );
    const agentId = userRows[0]?.id ?? 0;
    await db.execute(
      `INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt)
       VALUES (?, ?, '[]', ?, ?, NULL)`,
      [agentId, r.client.id, "h-active", now],
    );
    const result = await deleteClient(db, r.client.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("in_use");
    expect(result.count).toBe(1);
  });

  it("deletes a client whose only refresh tokens are revoked", async () => {
    // GIVEN a client with ONLY revoked refresh tokens
    // WHEN we delete it
    // THEN the row is removed (the count of outstanding
    //      tokens is 0).
    const r = await createClient(db, { clientId: "c1", now });
    if (!r.ok) return;
    // Insert a user (FK prerequisite) + a revoked refresh
    // token.
    await db.execute(
      `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
       VALUES (?, 'argon2id-stub', '[]', 1, 0, ?)`,
      ["agent-for-rt-revoked", now],
    );
    const userRows = await db.select<{ id: number }>(
      "SELECT id FROM users WHERE username = ?",
      ["agent-for-rt-revoked"],
    );
    const agentId = userRows[0]?.id ?? 0;
    await db.execute(
      `INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt)
       VALUES (?, ?, '[]', ?, ?, ?)`,
      [agentId, r.client.id, "h-revoked", now - 100, now - 50],
    );
    const result = await deleteClient(db, r.client.id);
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with reason=not_found for an unknown id", async () => {
    const result = await deleteClient(db, 9999);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });
});

describe("admin/clients — ClientRecord type carries the spec fields", () => {
  it("the row exposes id, clientId, label, scopes (INERT), createdAt, lastUsedAt", async () => {
    // The shape is part of the public contract; the test pins
    // the field set so a future refactor cannot silently drop a
    // column. The `scopes` field is INERT legacy storage
    // (PR 4 of `remove-scope-authorization`).
    const r = await createClient(db, { clientId: "c1", label: "My App", now });
    if (!r.ok) return;
    const row: ClientRecord | null = await getClientByClientId(db, "c1");
    expect(row).not.toBeNull();
    expect(typeof row?.id).toBe("number");
    expect(typeof row?.clientId).toBe("string");
    expect(typeof row?.label).toBe("string");
    expect(Array.isArray(row?.scopes)).toBe(true);
    expect(row?.scopes).toEqual([]);
    expect(typeof row?.createdAt).toBe("number");
    expect(row?.lastUsedAt).toBeNull();
  });
});

// Mark the imported type aliases as used so vitest doesn't
// fail on a noUnusedLocals check (some configs enable it).
void (null as unknown as CreateClientResult);
void (null as unknown as DeleteClientResult);
