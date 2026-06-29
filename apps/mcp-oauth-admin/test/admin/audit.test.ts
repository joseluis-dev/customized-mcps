/**
 * Unit tests for the audit_log writer and redaction helper.
 *
 * The mcp-admin-ui spec requires:
 * - Every admin UI action (login success/failure, agent
 *   create/disable/rotate, client create/rotate/delete, scope
 *   delete, refresh revoke) appends an `audit_log` row.
 * - An `audit_log` row whose `target` looks like a token is
 *   redacted to `***` in the viewer (the redaction happens at
 *   the RENDER step, not at the write step — the database
 *   stores the actual value so the operator can audit
 *   behaviour; the VIEWER masks the column when the row is
 *   marked `secretColumn: true`).
 * - Bearer tokens, password hashes (64-char hex), and any
 *   `Bearer <token>` shape are NEVER persisted in `target` or
 *   `ip`. The `auditAppend` helper enforces this.
 *
 * Test layer: unit. Real SQLite (in-memory) for the writes; the
 * redaction is a pure function.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, initializeSchema, type AuthorityDatabase } from "../../src/db/index.js";
import {
  auditAppend,
  redactAuditValue,
  listAuditRows,
  countAuditRows,
  type AuditEntry,
  type AuditRow,
} from "../../src/admin/audit.js";

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

describe("admin/audit — auditAppend", () => {
  it("writes a row with the spec fields (ts, actor, action, target, ip, outcome)", async () => {
    // GIVEN an audit entry
    // WHEN we append it
    // THEN the row is persisted with the same shape.
    const entry: AuditEntry = {
      ts: now,
      actor: "root",
      action: "agent.create",
      target: "user:42",
      ip: "127.0.0.1",
      outcome: "ok",
    };
    await auditAppend(db, entry);
    const rows = await listAuditRows(db, { limit: 10, offset: 0 });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.ts).toBe(now);
    expect(r.actor).toBe("root");
    expect(r.action).toBe("agent.create");
    expect(r.target).toBe("user:42");
    expect(r.ip).toBe("127.0.0.1");
    expect(r.outcome).toBe("ok");
  });

  it("writes a row with null target / ip when omitted", async () => {
    // GIVEN an entry with no target / ip
    // WHEN we append it
    // THEN the row has nulls in those columns (we never write
    //      empty strings; null is the canonical "absent" value).
    await auditAppend(db, {
      ts: now,
      actor: "root",
      action: "agent.list",
      outcome: "ok",
    });
    const rows = await listAuditRows(db, { limit: 10, offset: 0 });
    expect(rows[0]?.target).toBeNull();
    expect(rows[0]?.ip).toBeNull();
  });

  it("refuses to persist a Bearer token in the target field", async () => {
    // GIVEN a target that looks like a Bearer token
    // WHEN we append it
    // THEN the write is REJECTED (the row is NOT written). The
    //      redaction happens BEFORE the SQL — a token NEVER
    //      reaches the database.
    await expect(
      auditAppend(db, {
        ts: now,
        actor: "root",
        action: "agent.create",
        target: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig",
        outcome: "ok",
      }),
    ).rejects.toThrow(/token/i);
    // And the row was not written.
    const count = await countAuditRows(db);
    expect(count).toBe(0);
  });

  it("refuses to persist a 64-char hex hash in the target field", async () => {
    // GIVEN a target that looks like a password hash
    // WHEN we append it
    // THEN the write is REJECTED.
    const fakeHash = "a".repeat(64);
    await expect(
      auditAppend(db, {
        ts: now,
        actor: "root",
        action: "agent.create",
        target: fakeHash,
        outcome: "ok",
      }),
    ).rejects.toThrow(/hash|hex/i);
  });

  it("refuses to persist a token in the ip field", async () => {
    await expect(
      auditAppend(db, {
        ts: now,
        actor: "root",
        action: "agent.create",
        ip: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig",
        outcome: "ok",
      }),
    ).rejects.toThrow(/token/i);
  });
});

describe("admin/audit — redactAuditValue", () => {
  it("redacts a 64-char hex value to '***'", () => {
    expect(redactAuditValue("a".repeat(64))).toBe("***");
    expect(redactAuditValue("0123456789abcdef".repeat(4))).toBe("***");
  });

  it("redacts a 'Bearer <token>' shape to '***'", () => {
    expect(redactAuditValue("Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig")).toBe("***");
  });

  it("redacts a 64-char hex embedded in a longer string (defense in depth)", () => {
    // The secret is NEVER in a `target` (auditAppend refuses
    // it). This case covers a future schema where the secret
    // might appear as a suffix; the viewer still redacts it.
    const payload = "agent.create:hash=" + "a".repeat(64);
    expect(redactAuditValue(payload)).toContain("***");
  });

  it("leaves a non-sensitive value alone", () => {
    expect(redactAuditValue("user:42")).toBe("user:42");
    expect(redactAuditValue("read:bi_catastro")).toBe("read:bi_catastro");
  });

  it("returns null / undefined passthrough", () => {
    expect(redactAuditValue(null)).toBeNull();
    expect(redactAuditValue(undefined)).toBeUndefined();
  });

  it("returns empty string for an empty string", () => {
    expect(redactAuditValue("")).toBe("");
  });
});

describe("admin/audit — listAuditRows pagination", () => {
  it("returns rows newest-first", async () => {
    // GIVEN 5 rows at increasing ts
    // WHEN we list
    // THEN the order is DESC by ts.
    for (let i = 0; i < 5; i++) {
      await auditAppend(db, {
        ts: now + i,
        actor: "root",
        action: `action.${i}`,
        outcome: "ok",
      });
    }
    const rows = await listAuditRows(db, { limit: 10, offset: 0 });
    expect(rows.map((r) => r.ts)).toEqual([now + 4, now + 3, now + 2, now + 1, now + 0]);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await auditAppend(db, {
        ts: now + i,
        actor: "root",
        action: `action.${i}`,
        outcome: "ok",
      });
    }
    const rows = await listAuditRows(db, { limit: 3, offset: 0 });
    expect(rows).toHaveLength(3);
    expect(rows[0]?.ts).toBe(now + 9);
  });

  it("respects the offset parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await auditAppend(db, {
        ts: now + i,
        actor: "root",
        action: `action.${i}`,
        outcome: "ok",
      });
    }
    const rows = await listAuditRows(db, { limit: 3, offset: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[0]?.ts).toBe(now + 6);
    expect(rows[2]?.ts).toBe(now + 4);
  });

  it("countAuditRows returns the total count", async () => {
    for (let i = 0; i < 7; i++) {
      await auditAppend(db, {
        ts: now + i,
        actor: "root",
        action: `action.${i}`,
        outcome: "ok",
      });
    }
    expect(await countAuditRows(db)).toBe(7);
  });
});

describe("admin/audit — listAuditRows filter", () => {
  beforeEach(async () => {
    // 6 rows: 3 with actor=root, 2 with actor=alice, 1 with actor=bob.
    // 3 with action=agent.create, 2 with action=client.create, 1 with action=scope.delete.
    await auditAppend(db, { ts: now + 0, actor: "root", action: "agent.create", outcome: "ok" });
    await auditAppend(db, { ts: now + 1, actor: "root", action: "agent.create", outcome: "ok" });
    await auditAppend(db, { ts: now + 2, actor: "root", action: "client.create", outcome: "ok" });
    await auditAppend(db, { ts: now + 3, actor: "alice", action: "agent.create", outcome: "denied" });
    await auditAppend(db, { ts: now + 4, actor: "alice", action: "client.rotate", outcome: "ok" });
    await auditAppend(db, { ts: now + 5, actor: "bob", action: "scope.delete", outcome: "denied" });
  });

  it("filters by actor", async () => {
    const rows = await listAuditRows(db, { limit: 100, offset: 0, actor: "root" });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.actor === "root")).toBe(true);
  });

  it("filters by action", async () => {
    const rows = await listAuditRows(db, { limit: 100, offset: 0, action: "agent.create" });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.action === "agent.create")).toBe(true);
  });

  it("filters by both actor and action", async () => {
    const rows = await listAuditRows(db, {
      limit: 100,
      offset: 0,
      actor: "alice",
      action: "agent.create",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe("alice");
  });

  it("filters by date range (from inclusive)", async () => {
    const rows = await listAuditRows(db, {
      limit: 100,
      offset: 0,
      fromTs: now + 2,
    });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.ts >= now + 2)).toBe(true);
  });

  it("filters by date range (to inclusive)", async () => {
    const rows = await listAuditRows(db, {
      limit: 100,
      offset: 0,
      toTs: now + 2,
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ts <= now + 2)).toBe(true);
  });

  it("countAuditRows applies the same filters", async () => {
    const count = await countAuditRows(db, { actor: "root" });
    expect(count).toBe(3);
  });
});

describe("admin/audit — AuditRow type shape", () => {
  it("AuditRow carries the spec fields", async () => {
    await auditAppend(db, {
      ts: now,
      actor: "root",
      action: "agent.create",
      target: "user:42",
      ip: "10.0.0.1",
      outcome: "ok",
    });
    const rows = await listAuditRows(db, { limit: 1, offset: 0 });
    const r: AuditRow = rows[0]!;
    // Type-level: the field is non-null when the column is non-null.
    expect(r.target).toBe("user:42");
    expect(r.ip).toBe("10.0.0.1");
  });
});
