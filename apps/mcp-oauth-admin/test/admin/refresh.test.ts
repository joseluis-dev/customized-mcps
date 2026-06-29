/**
 * Unit tests for the refresh-token revocation module.
 *
 * The mcp-admin-ui spec requires:
 * - The refresh-token revocation page lists active refresh
 *   tokens with `agentId`, `clientId`, `issuedAt`, and a
 *   "revoke" action.
 * - The form sets `revokedAt` to now, appends an `audit_log`
 *   row, and returns the admin to the list with the row
 *   marked revoked.
 *
 * Test layer: unit. Real SQLite (in-memory) for the writes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, initializeSchema, type AuthorityDatabase } from "../../src/db/index.js";
import {
  listRefreshTokens,
  revokeRefreshToken,
  countRefreshTokens,
  type RefreshTokenRow,
  type RevokeResult,
} from "../../src/admin/refresh.js";
import { auditAppend, listAuditRows } from "../../src/admin/audit.js";

let db: AuthorityDatabase;
let now: number;
let seedCounter: number;

beforeEach(async () => {
  db = openDatabase({ path: ":memory:" });
  await initializeSchema(db);
  now = 1_700_000_000;
  seedCounter = 0;
});

afterEach(async () => {
  await db.close();
});

/**
 * Seed an agent + a client + a refresh token. Returns the
 * row ids so the test can refer to them. Each call produces
 * a unique username / clientId / tokenHash so multiple
 * `seedToken` calls in the same test do not collide on
 * UNIQUE constraints.
 */
async function seedToken(opts: {
  revokedAt?: number | null;
  issuedAt?: number;
  scopes?: string[];
}): Promise<{ userId: number; clientInternalId: number; clientId: string; refreshId: number; agentUsername: string; clientLabel: string }> {
  seedCounter += 1;
  const username = `agent-${seedCounter}`;
  const clientId = `client-${seedCounter}`;
  const clientLabel = `Client ${seedCounter}`;
  await db.execute(
    `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
     VALUES (?, ?, ?, 1, 0, ?)`,
    [username, "argon2id-stub", JSON.stringify(["read:bi_catastro"]), now],
  );
  await db.execute(
    `INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt)
     VALUES (?, ?, ?, ?, ?)`,
    [clientId, "argon2id-stub", clientLabel, JSON.stringify(["read:bi_catastro"]), now],
  );
  const userRows = await db.select<{ id: number }>("SELECT id FROM users WHERE username = ?", [username]);
  const clientRows = await db.select<{ id: number }>("SELECT id FROM clients WHERE clientId = ?", [clientId]);
  const userId = userRows[0]!.id;
  const clientInternalId = clientRows[0]!.id;
  const tokenHash = `hash-${seedCounter}-${Math.random().toString(36).slice(2, 10)}`;
  await db.execute(
    `INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      clientInternalId,
      JSON.stringify(opts.scopes ?? ["read:bi_catastro"]),
      tokenHash,
      opts.issuedAt ?? now,
      opts.revokedAt ?? null,
    ],
  );
  const tokenRows = await db.select<{ id: number }>(
    "SELECT id FROM refresh_tokens WHERE tokenHash = ?",
    [tokenHash],
  );
  return {
    userId,
    clientInternalId,
    clientId,
    refreshId: tokenRows[0]!.id,
    agentUsername: username,
    clientLabel,
  };
}

describe("admin/refresh — listRefreshTokens", () => {
  it("returns rows with agent username, client clientId, and scopes", async () => {
    // GIVEN one refresh token
    // WHEN we list
    // THEN the row carries the joined agent username + client
    //      clientId (not the internal numeric ids).
    const seeded = await seedToken({});
    const rows = await listRefreshTokens(db, { limit: 10, offset: 0 });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.agentUsername).toBe(seeded.agentUsername);
    expect(r.clientId).toBe(seeded.clientId);
    expect(r.clientLabel).toBe(seeded.clientLabel);
    expect(r.scopes).toEqual(["read:bi_catastro"]);
    expect(r.revokedAt).toBeNull();
  });

  it("orders rows newest-first (by issuedAt DESC, then id DESC)", async () => {
    // GIVEN 3 tokens at different times
    // WHEN we list
    // THEN the order is DESC by issuedAt.
    await seedToken({ issuedAt: now + 0 });
    await seedToken({ issuedAt: now + 1 });
    await seedToken({ issuedAt: now + 2 });
    const rows = await listRefreshTokens(db, { limit: 10, offset: 0 });
    expect(rows.length).toBe(3);
    // Newest first.
    expect(rows[0]!.issuedAt).toBe(now + 2);
    expect(rows[1]!.issuedAt).toBe(now + 1);
    expect(rows[2]!.issuedAt).toBe(now + 0);
  });

  it("respects limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      await seedToken({ issuedAt: now + i });
    }
    const page1 = await listRefreshTokens(db, { limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.issuedAt).toBe(now + 4);
    const page2 = await listRefreshTokens(db, { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);
    expect(page2[0]!.issuedAt).toBe(now + 2);
  });

  it("filters by onlyActive=true (excludes revoked tokens)", async () => {
    await seedToken({ revokedAt: null });
    await seedToken({ revokedAt: now - 100 });
    const active = await listRefreshTokens(db, { limit: 10, offset: 0, onlyActive: true });
    expect(active).toHaveLength(1);
    expect(active[0]!.revokedAt).toBeNull();
  });

  it("returns an empty list when no tokens exist", async () => {
    const rows = await listRefreshTokens(db, { limit: 10, offset: 0 });
    expect(rows).toEqual([]);
  });
});

describe("admin/refresh — countRefreshTokens", () => {
  it("returns the total count", async () => {
    await seedToken({});
    await seedToken({});
    await seedToken({});
    expect(await countRefreshTokens(db)).toBe(3);
  });

  it("applies the onlyActive filter", async () => {
    await seedToken({ revokedAt: null });
    await seedToken({ revokedAt: now - 100 });
    expect(await countRefreshTokens(db, { onlyActive: true })).toBe(1);
  });
});

describe("admin/refresh — revokeRefreshToken", () => {
  it("sets revokedAt to now and returns ok=true", async () => {
    // GIVEN an active refresh token
    // WHEN we revoke it
    // THEN the row's revokedAt is set to now AND the call
    //      returns ok=true.
    const seeded = await seedToken({});
    const r = await revokeRefreshToken(db, seeded.refreshId, now + 50, "root", "127.0.0.1");
    expect(r.ok).toBe(true);
    const rows = await db.select<{ revokedAt: number | null }>(
      "SELECT revokedAt FROM refresh_tokens WHERE id = ?",
      [seeded.refreshId],
    );
    expect(rows[0]?.revokedAt).toBe(now + 50);
  });

  it("appends an audit_log row with the action 'refresh.revoke' and outcome 'ok'", async () => {
    // GIVEN an active refresh token
    // WHEN we revoke it (with the actor + ip)
    // THEN an audit_log row is appended.
    const seeded = await seedToken({});
    const r = await revokeRefreshToken(db, seeded.refreshId, now + 50, "root", "127.0.0.1");
    expect(r.ok).toBe(true);
    const auditRows = await listAuditRows(db, { limit: 10, offset: 0 });
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0]!;
    expect(row.action).toBe("refresh.revoke");
    expect(row.actor).toBe("root");
    expect(row.outcome).toBe("ok");
  });

  it("refuses to revoke an already-revoked token (idempotent guard)", async () => {
    // GIVEN a token that was already revoked (revokedAt IS NOT NULL)
    // WHEN we try to revoke it
    // THEN the call returns ok=false with reason 'already_revoked'.
    const seeded = await seedToken({ revokedAt: now - 100 });
    const r = await revokeRefreshToken(db, seeded.refreshId, now, "root", "127.0.0.1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("already_revoked");
    // The audit log has NO new row.
    const auditRows = await listAuditRows(db, { limit: 10, offset: 0 });
    expect(auditRows).toHaveLength(0);
  });

  it("returns ok=false for an unknown id", async () => {
    const r = await revokeRefreshToken(db, 9999, now, "root", "127.0.0.1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_found");
  });
});

describe("admin/refresh — RefreshTokenRow type", () => {
  it("carries the spec fields: id, agentUsername, clientId, scopes, issuedAt, revokedAt", async () => {
    await seedToken({});
    const rows = await listRefreshTokens(db, { limit: 1, offset: 0 });
    const r: RefreshTokenRow = rows[0]!;
    expect(typeof r.id).toBe("number");
    expect(typeof r.agentUsername).toBe("string");
    expect(typeof r.clientId).toBe("string");
    expect(Array.isArray(r.scopes)).toBe(true);
    expect(typeof r.issuedAt).toBe("number");
    expect(r.revokedAt).toBeNull();
  });

  it("RevokeResult type union is exhaustive", async () => {
    const r: RevokeResult = await revokeRefreshToken(db, 9999, now, "root", "127.0.0.1");
    if (!r.ok) {
      expect(typeof r.reason).toBe("string");
    }
  });
});

describe("admin/refresh — audit log does NOT leak the token hash", () => {
  it("the audit row's target is a sanitized id reference, NOT a hash", async () => {
    const seeded = await seedToken({});
    const r = await revokeRefreshToken(db, seeded.refreshId, now + 50, "root", "127.0.0.1");
    expect(r.ok).toBe(true);
    const auditRows = await listAuditRows(db, { limit: 10, offset: 0 });
    const target = auditRows[0]?.target ?? "";
    // The target is `refresh:<id>` — never a 64-char hex hash.
    expect(target).toBe(`refresh:${seeded.refreshId}`);
    expect(target).not.toMatch(/^[a-f0-9]{64}$/);
  });
});
