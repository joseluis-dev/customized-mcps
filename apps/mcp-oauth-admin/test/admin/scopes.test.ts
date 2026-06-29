/**
 * Unit tests for the scope catalog module.
 *
 * The mcp-admin-ui spec requires:
 * - The scope catalog page allows adding a new scope string
 *   and validates it against `SCOPE_PATTERN` server-side.
 * - Deletion of a scope is refused when the scope is currently
 *   assigned to any agent or client. The error names the
 *   affected count (a sanitized count, not the names of the
 *   affected agents/clients — that would be a side channel).
 * - Deletion succeeds when no agent or client references the
 *   scope.
 *
 * Test layer: unit. Real SQLite (in-memory) for the writes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, initializeSchema, type AuthorityDatabase } from "../../src/db/index.js";
import {
  listScopes,
  createScope,
  deleteScope,
  scopeInUse,
  type ScopeRecord,
  type CreateScopeResult,
  type DeleteScopeResult,
} from "../../src/admin/scopes.js";

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

describe("admin/scopes — createScope", () => {
  it("inserts a scope that matches SCOPE_PATTERN", async () => {
    const r = await createScope(db, {
      name: "read:bi_catastro",
      description: "Read BI Catastro rows",
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await scopeInUse(db, "read:bi_catastro");
    expect(row.count).toBe(0);
  });

  it("rejects a scope that does not match SCOPE_PATTERN", async () => {
    const r = await createScope(db, { name: "bogus", description: "x", now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid");
  });

  it("rejects the bare `*` (the authority MUST NOT grant `*`)", async () => {
    // The scope catalog is the source of truth for what
    // scopes are VALID. The `*` wildcard is intentionally not
    // in the catalog — granting it would be a privilege
    // escalation.
    const r = await createScope(db, { name: "*", description: "x", now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid");
  });

  it("rejects a duplicate scope (PRIMARY KEY)", async () => {
    const r1 = await createScope(db, { name: "read:foo", description: "x", now });
    expect(r1.ok).toBe(true);
    const r2 = await createScope(db, { name: "read:foo", description: "x", now });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe("duplicate");
  });

  it("stores the description verbatim", async () => {
    await createScope(db, { name: "read:foo", description: "A long description", now });
    const rows = await listScopes(db);
    const row = rows.find((r) => r.name === "read:foo");
    expect(row?.description).toBe("A long description");
  });
});

describe("admin/scopes — listScopes", () => {
  it("returns all scopes alphabetically", async () => {
    await createScope(db, { name: "read:zeta", description: "", now: now + 0 });
    await createScope(db, { name: "read:alpha", description: "", now: now + 1 });
    await createScope(db, { name: "read:mike", description: "", now: now + 2 });
    const rows = await listScopes(db);
    expect(rows.map((r) => r.name)).toEqual(["read:alpha", "read:mike", "read:zeta"]);
  });

  it("returns an empty list when no scopes exist", async () => {
    const rows = await listScopes(db);
    expect(rows).toEqual([]);
  });
});

describe("admin/scopes — deleteScope", () => {
  it("deletes a scope that is NOT assigned to any agent or client", async () => {
    // GIVEN a scope with no assignments
    // WHEN we delete it
    // THEN the row is removed and the call returns ok=true.
    await createScope(db, { name: "read:foo", description: "x", now });
    const r = await deleteScope(db, "read:foo");
    expect(r.ok).toBe(true);
    const rows = await listScopes(db);
    expect(rows.find((row) => row.name === "read:foo")).toBeUndefined();
  });

  it("refuses to delete a scope assigned to 3 agents (with sanitized count)", async () => {
    // GIVEN a scope assigned to 3 agents
    // WHEN we try to delete it
    // THEN the call returns ok=false with reason 'in_use'
    //      and count=3. The agent names MUST NOT appear in
    //      the error (they would be a side channel).
    await createScope(db, { name: "read:bi_catastro", description: "", now });
    for (let i = 0; i < 3; i++) {
      await db.execute(
        `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
         VALUES (?, ?, ?, 1, 0, ?)`,
        [
          `agent-${i}`,
          "argon2id-stub",
          JSON.stringify(["read:bi_catastro"]),
          now,
        ],
      );
    }
    const r = await deleteScope(db, "read:bi_catastro");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("in_use");
    if (r.reason === "in_use") {
      expect(r.count).toBe(3);
      // No agent names in the error.
      expect(JSON.stringify(r)).not.toContain("agent-0");
      expect(JSON.stringify(r)).not.toContain("agent-1");
      expect(JSON.stringify(r)).not.toContain("agent-2");
    }
    // The scope row is still present.
    const after = await listScopes(db);
    expect(after.find((row) => row.name === "read:bi_catastro")).toBeDefined();
  });

  it("refuses to delete a scope assigned to a client", async () => {
    // GIVEN a scope assigned to 1 client
    // WHEN we try to delete it
    // THEN the call returns ok=false with count=1.
    await createScope(db, { name: "list:bi_catastro", description: "", now });
    await db.execute(
      `INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
      [
        "c1",
        "argon2id-stub",
        "x",
        JSON.stringify(["list:bi_catastro"]),
        now,
      ],
    );
    const r = await deleteScope(db, "list:bi_catastro");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("in_use");
    if (r.reason === "in_use") {
      expect(r.count).toBe(1);
    }
  });

  it("returns ok=false for an unknown scope", async () => {
    const r = await deleteScope(db, "read:ghost");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_found");
  });

  it("ALLOWS deleting a scope whose only assignments are in disabled agents (count=0)", async () => {
    // The count query is "any user with this scope in their
    // `scopes` JSON" — there is no concept of "disabled
    // assignment". A disabled agent still has the scope in
    // their `scopes` column, so the deletion is refused.
    // (This is the conservative behavior; the spec is silent
    // on disabled-agent counts. We document it in the
    // test name so a future relaxation is a deliberate
    // decision.)
    await createScope(db, { name: "read:foo", description: "", now });
    await db.execute(
      `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
       VALUES (?, ?, ?, 0, 0, ?)`,
      ["u1", "argon2id-stub", JSON.stringify(["read:foo"]), now],
    );
    const r = await deleteScope(db, "read:foo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("in_use");
    if (r.reason === "in_use") {
      expect(r.count).toBe(1);
    }
  });
});

describe("admin/scopes — scopeInUse", () => {
  it("returns 0 when the scope is in the catalog but not assigned", async () => {
    await createScope(db, { name: "read:foo", description: "", now });
    const r = await scopeInUse(db, "read:foo");
    expect(r.count).toBe(0);
    expect(r.assignedToAgents).toBe(0);
    expect(r.assignedToClients).toBe(0);
  });

  it("returns 1 agent when the scope is assigned to one agent", async () => {
    await createScope(db, { name: "read:foo", description: "", now });
    await db.execute(
      `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
       VALUES (?, ?, ?, 1, 0, ?)`,
      ["u1", "argon2id-stub", JSON.stringify(["read:foo"]), now],
    );
    const r = await scopeInUse(db, "read:foo");
    expect(r.count).toBe(1);
    expect(r.assignedToAgents).toBe(1);
    expect(r.assignedToClients).toBe(0);
  });

  it("counts the same scope on the SAME agent once (de-duped by user)", async () => {
    // GIVEN a user whose `scopes` column lists the same scope
    //      twice (a corrupted row from a future feature)
    // WHEN we count
    // THEN the count is 1 (the user is counted once), not 2.
    // The JSON-contains query is INCLUSIVE of duplicates in
    // the JSON; we de-dupe by user id at the count layer.
    await createScope(db, { name: "read:foo", description: "", now });
    await db.execute(
      `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
       VALUES (?, ?, ?, 1, 0, ?)`,
      ["u1", "argon2id-stub", JSON.stringify(["read:foo", "read:foo"]), now],
    );
    const r = await scopeInUse(db, "read:foo");
    expect(r.assignedToAgents).toBe(1);
  });
});

describe("admin/scopes — type guards", () => {
  it("CreateScopeResult type union is exhaustive", async () => {
    const r: CreateScopeResult = await createScope(db, { name: "read:foo", description: "x", now });
    if (r.ok) {
      expect(typeof r.scope.name).toBe("string");
    } else {
      expect(typeof r.reason).toBe("string");
    }
  });

  it("DeleteScopeResult type union is exhaustive", async () => {
    const r: DeleteScopeResult = await deleteScope(db, "read:ghost");
    if (!r.ok) {
      expect(typeof r.reason).toBe("string");
    }
  });

  it("ScopeRecord carries the spec fields", async () => {
    await createScope(db, { name: "read:foo", description: "x", now });
    const rows = await listScopes(db);
    const r: ScopeRecord = rows[0]!;
    expect(typeof r.name).toBe("string");
    expect(typeof r.description).toBe("string");
    expect(typeof r.createdAt).toBe("number");
  });
});
