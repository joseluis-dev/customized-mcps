/**
 * Unit tests for the OAuth client CRUD module.
 *
 * The mcp-admin-ui spec requires:
 * - Pages to list, create, edit, and disable OAuth clients.
 * - Each row shows `clientId`, `label`, `scopes`, `lastUsedAt`.
 * - `createClient` generates a one-time plaintext secret,
 *   stores the `argon2id` hash, and returns the plaintext in
 *   the response.
 * - `rotateSecret` returns a new plaintext; the old secret
 *   returns `401 invalid_client` on the next token request.
 * - `deleteClient` is allowed only when the client has no
 *   outstanding refresh tokens (the spec says "refuses
 *   deletion of a scope currently assigned to any agent or
 *   client with a sanitized error naming the affected count" —
 *   for clients, the analogous rule is "refuses deletion when
 *   refresh tokens are still live").
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
  setClientScopes,
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
      scopes: ["read:bi_catastro"],
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

  it("stores the label, scopes, and createdAt", async () => {
    const r = await createClient(db, {
      clientId: "c1",
      label: "My App",
      scopes: ["read:bi_catastro", "list:bi_catastro"],
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getClientByClientId(db, "c1");
    expect(row?.label).toBe("My App");
    expect(row?.scopes).toEqual(["read:bi_catastro", "list:bi_catastro"]);
    expect(row?.createdAt).toBe(now);
  });

  it("defaults label to empty string and scopes to []", async () => {
    const r = await createClient(db, { clientId: "c1", scopes: [], now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getClientByClientId(db, "c1");
    expect(row?.label).toBe("");
    expect(row?.scopes).toEqual([]);
  });

  it("rejects an empty clientId", async () => {
    const r = await createClient(db, { clientId: "", scopes: [], now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_clientId");
  });

  it("rejects a clientId with invalid characters", async () => {
    // The OAuth2 spec recommends a character set; we accept
    // `[A-Za-z0-9_.-]{1,64}` (the same shape as the agent
    // username, since clients and agents share the
    // identifier grammar).
    const r = await createClient(db, { clientId: "has spaces", scopes: [], now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_clientId");
  });

  it("rejects a duplicate clientId", async () => {
    const r1 = await createClient(db, { clientId: "c1", scopes: [], now });
    expect(r1.ok).toBe(true);
    const r2 = await createClient(db, { clientId: "c1", scopes: [], now });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe("duplicate");
  });

  it("rejects a scope that does not match SCOPE_PATTERN", async () => {
    const r = await createClient(db, {
      clientId: "c1",
      scopes: ["bogus"],
      now,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_scope");
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
      scopes: ["read:bi_catastro"],
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
      scopes: ["read:bi_catastro"],
      // Exactly 16 chars — the minimum.
      plaintextSecret: "abcdefghijklmnop",
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plaintextSecret).toBe("abcdefghijklmnop");
  });

  it("the generated secret is cryptographically random (different on each call)", async () => {
    const r1 = await createClient(db, { clientId: "c1", scopes: [], now });
    const r2 = await createClient(db, { clientId: "c2", scopes: [], now });
    if (!r1.ok || !r2.ok) return;
    expect(r1.plaintextSecret).not.toBe(r2.plaintextSecret);
  });
});

describe("admin/clients — listClients", () => {
  it("returns all clients newest-first", async () => {
    await createClient(db, { clientId: "a", scopes: [], now: now + 0 });
    await createClient(db, { clientId: "b", scopes: [], now: now + 1 });
    await createClient(db, { clientId: "c", scopes: [], now: now + 2 });
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
    const r = await createClient(db, { clientId: "c1", scopes: [], now });
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

describe("admin/clients — setClientScopes", () => {
  it("replaces the scope set with the new value", async () => {
    const r = await createClient(db, { clientId: "c1", scopes: ["read:bi_catastro"], now });
    if (!r.ok) return;
    const ok = await setClientScopes(db, r.client.id, ["read:bi_catastro", "list:bi_catastro"]);
    expect(ok).toBe(true);
    const after = await getClientById(db, r.client.id);
    expect(after?.scopes).toEqual(["read:bi_catastro", "list:bi_catastro"]);
  });

  it("rejects a scope that does not match SCOPE_PATTERN", async () => {
    const r = await createClient(db, { clientId: "c1", scopes: [], now });
    if (!r.ok) return;
    const ok = await setClientScopes(db, r.client.id, ["bogus"]);
    expect(ok).toBe(false);
  });
});

describe("admin/clients — setClientLabel", () => {
  it("replaces the label", async () => {
    const r = await createClient(db, { clientId: "c1", label: "old", scopes: [], now });
    if (!r.ok) return;
    const ok = await setClientLabel(db, r.client.id, "new label");
    expect(ok).toBe(true);
    const after = await getClientById(db, r.client.id);
    expect(after?.label).toBe("new label");
  });

  it("rejects an empty label", async () => {
    const r = await createClient(db, { clientId: "c1", label: "x", scopes: [], now });
    if (!r.ok) return;
    const ok = await setClientLabel(db, r.client.id, "");
    expect(ok).toBe(false);
  });
});

describe("admin/clients — recordClientUsed", () => {
  it("updates the lastUsedAt timestamp", async () => {
    const r = await createClient(db, { clientId: "c1", scopes: [], now });
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
    const r = await createClient(db, { clientId: "c1", scopes: [], now });
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
    const r = await createClient(db, { clientId: "c1", scopes: [], now });
    if (!r.ok) return;
    // Seed a user + a refresh token tied to this client.
    await db.execute(
      `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
       VALUES (?, ?, ?, 1, 0, ?)`,
      ["u1", "argon2id-stub", "[]", now],
    );
    await db.execute(
      `INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [1, r.client.id, "[]", "hash-1", now],
    );
    const result = await deleteClient(db, r.client.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("in_use");
    if (result.reason === "in_use") {
      expect(result.count).toBe(1);
    }
  });

  it("ALLOWS deleting a client whose refresh tokens are all revoked", async () => {
    // GIVEN a client whose only refresh tokens are revoked
    // WHEN we delete it
    // THEN the deletion succeeds (the count query filters
    //      `revokedAt IS NULL`).
    const r = await createClient(db, { clientId: "c1", scopes: [], now });
    if (!r.ok) return;
    await db.execute(
      `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
       VALUES (?, ?, ?, 1, 0, ?)`,
      ["u1", "argon2id-stub", "[]", now],
    );
    await db.execute(
      `INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [1, r.client.id, "[]", "hash-1", now - 100, now - 50],
    );
    const result = await deleteClient(db, r.client.id);
    expect(result.ok).toBe(true);
  });

  it("returns ok=false for an unknown id", async () => {
    const r = await deleteClient(db, 9999);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_found");
  });
});

describe("admin/clients — ClientRecord type carries the spec fields", () => {
  it("the row exposes id, clientId, label, scopes, createdAt, lastUsedAt", async () => {
    const r = await createClient(db, {
      clientId: "c1",
      label: "x",
      scopes: ["read:bi_catastro"],
      now,
    });
    if (!r.ok) return;
    const row: ClientRecord | null = await getClientById(db, r.client.id);
    expect(row).not.toBeNull();
    expect(typeof row?.id).toBe("number");
    expect(typeof row?.clientId).toBe("string");
    expect(typeof row?.label).toBe("string");
    expect(Array.isArray(row?.scopes)).toBe(true);
    expect(typeof row?.createdAt).toBe("number");
    expect(row?.lastUsedAt).toBeNull();
  });
});

describe("admin/clients — type guard for CreateClientResult", () => {
  it("the success shape carries agent + plaintextSecret", async () => {
    const r: CreateClientResult = await createClient(db, { clientId: "c1", scopes: [], now });
    if (r.ok) {
      expect(r.client.clientId).toBe("c1");
      expect(typeof r.plaintextSecret).toBe("string");
    }
  });

  it("the failure shape carries a reason code", async () => {
    const r: CreateClientResult = await createClient(db, { clientId: "", scopes: [], now });
    if (!r.ok) {
      expect(typeof r.reason).toBe("string");
    }
  });

  it("the DeleteClientResult type union is exhaustive", async () => {
    const r: DeleteClientResult = await deleteClient(db, 9999);
    if (!r.ok) {
      expect(r.reason === "not_found" || r.reason === "in_use").toBe(true);
    }
  });
});
