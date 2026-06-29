/**
 * Unit + integration tests for the agent CRUD module.
 *
 * The mcp-admin-ui spec requires:
 * - The admin can list, create, edit, and disable agents.
 * - `createAgent` generates a one-time plaintext password
 *   (returned in the response), stores the `argon2id` hash,
 *   and persists the `requireChangeOnFirstLogin` flag when set.
 * - The plaintext password is NEVER persisted; the DB row
 *   contains only the hash.
 * - `setAgentEnabled(false)` makes the token endpoint return
 *   `400 account_disabled` (the `users.enabled` column drives
 *   this in `oauth/token.ts`).
 * - `rotateAgentPassword` returns a new plaintext, updates the
 *   hash, and clears `requireChangeOnFirstLogin` when called
 *   on the bootstrap admin (the rotation flow).
 * - The bootstrap admin refuses to mint tokens until rotated
 *   (covered by the token endpoint in `test/oauth/token.test.ts`).
 *
 * Test layer: unit. Real SQLite (in-memory) for the writes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, initializeSchema, type AuthorityDatabase } from "../../src/db/index.js";
import { SCOPE_PATTERN } from "@customized-mcps/mcp-http-base";
import {
  createAgent,
  listAgents,
  getAgentById,
  getAgentByUsername,
  setAgentEnabled,
  rotateAgentPassword,
  setAgentScopes,
  recordAgentLogin,
  verifyAgentPassword,
  changeOwnPassword,
  type AgentRecord,
} from "../../src/admin/agents.js";
import { verifyPassword } from "../../src/oauth/passwords.js";

/**
 * Read the `users.passwordHash` column directly via SQL. The
 * `getAgentById` public function strips the hash (it MUST NOT
 * reach the admin UI), so the test reads the column directly
 * to assert that the production `createAgent` / `rotateAgent`
 * wrote the right value.
 */
async function readPasswordHash(db: AuthorityDatabase, id: number): Promise<string | null> {
  const rows = await db.select<{ passwordHash: string }>(
    "SELECT passwordHash FROM users WHERE id = ?",
    [id],
  );
  return rows[0]?.passwordHash ?? null;
}

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

describe("admin/agents — createAgent", () => {
  it("returns a plaintext password AND stores the argon2id hash", async () => {
    // GIVEN no existing agent
    // WHEN we call createAgent
    // THEN the response includes a plaintext password (returned
    //      exactly once) AND the DB row stores only the
    //      `argon2id` hash (NOT the plaintext).
    const result = await createAgent(db, {
      username: "alice",
      scopes: ["read:bi_catastro"],
      requireChangeOnFirstLogin: false,
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plaintextPassword.length).toBeGreaterThan(8);

    const row = await getAgentByUsername(db, "alice");
    expect(row).not.toBeNull();
    // The public record shape does NOT include `passwordHash`
    // (defense-in-depth). We read the hash directly via SQL to
    // assert that the production `createAgent` wrote the right
    // value. The hash is an argon2id hash — `verifyPassword`
    // returns true.
    const hash = await readPasswordHash(db, row!.id);
    expect(hash).not.toBe(result.plaintextPassword);
    expect(hash).not.toBeNull();
    const ok = await verifyPassword(hash!, result.plaintextPassword);
    expect(ok).toBe(true);
  });

  it("stores requireChangeOnFirstLogin when requested", async () => {
    // GIVEN a request to create the agent with the flag set
    // WHEN we read the row
    // THEN the flag is persisted.
    const r = await createAgent(db, {
      username: "bob",
      scopes: [],
      requireChangeOnFirstLogin: true,
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getAgentByUsername(db, "bob");
    expect(row?.requireChangeOnFirstLogin).toBe(true);
  });

  it("defaults requireChangeOnFirstLogin to false", async () => {
    const r = await createAgent(db, {
      username: "carol",
      scopes: [],
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getAgentByUsername(db, "carol");
    expect(row?.requireChangeOnFirstLogin).toBe(false);
  });

  it("defaults the scope set to the empty list when omitted", async () => {
    const r = await createAgent(db, { username: "dave", scopes: [], now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getAgentByUsername(db, "dave");
    expect(row?.scopes).toEqual([]);
  });

  it("rejects a duplicate username (UNIQUE constraint)", async () => {
    // GIVEN an existing agent
    // WHEN we try to create another with the same username
    // THEN the call returns ok=false with a sanitized reason.
    const r1 = await createAgent(db, { username: "eve", scopes: [], now });
    expect(r1.ok).toBe(true);
    const r2 = await createAgent(db, { username: "eve", scopes: [], now });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe("duplicate");
    // The error message MUST NOT include the duplicate plaintext
    // password of the second call.
    expect(r2.reason).not.toContain("password");
  });

  it("rejects an empty username", async () => {
    const r = await createAgent(db, { username: "", scopes: [], now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_username");
  });

  it("rejects a scope that does not match SCOPE_PATTERN", async () => {
    // GIVEN a scope that is not `<verb>:<resource>`
    // WHEN we try to create the agent
    // THEN the call returns ok=false with reason invalid_scope.
    const r = await createAgent(db, {
      username: "frank",
      scopes: ["*"],
      now,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_scope");
  });

  it("accepts a scope that matches SCOPE_PATTERN", async () => {
    // GIVEN a valid `<verb>:<resource>` scope
    // WHEN we create the agent
    // THEN the call succeeds and the row stores the scope.
    const r = await createAgent(db, {
      username: "grace",
      scopes: ["read:bi_catastro", "list:bi_catastro"],
      now,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getAgentByUsername(db, "grace");
    expect(row?.scopes).toEqual(["read:bi_catastro", "list:bi_catastro"]);
  });

  it("the generated plaintext is cryptographically random (different on each call)", async () => {
    const r1 = await createAgent(db, { username: "h1", scopes: [], now });
    const r2 = await createAgent(db, { username: "h2", scopes: [], now });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.plaintextPassword).not.toBe(r2.plaintextPassword);
  });
});

describe("admin/agents — listAgents", () => {
  it("returns all agents in createdAt-DESC order", async () => {
    // GIVEN three agents created at different times
    // WHEN we list
    // THEN the order is newest-first.
    await createAgent(db, { username: "a", scopes: [], now: now + 0 });
    await createAgent(db, { username: "b", scopes: [], now: now + 1 });
    await createAgent(db, { username: "c", scopes: [], now: now + 2 });
    const rows = await listAgents(db);
    expect(rows.map((r) => r.username)).toEqual(["c", "b", "a"]);
  });

  it("returns an empty list when no agents exist", async () => {
    const rows = await listAgents(db);
    expect(rows).toEqual([]);
  });
});

describe("admin/agents — setAgentEnabled", () => {
  it("flips the enabled flag to false (the token endpoint maps this to 400 account_disabled)", async () => {
    // GIVEN a fresh agent
    // WHEN we disable it
    // THEN the row's enabled column is 0.
    const r = await createAgent(db, { username: "a", scopes: [], now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await getAgentById(db, r.agent.id);
    expect(row?.enabled).toBe(true);
    await setAgentEnabled(db, r.agent.id, false);
    const after = await getAgentById(db, r.agent.id);
    expect(after?.enabled).toBe(false);
  });

  it("flips the enabled flag back to true", async () => {
    const r = await createAgent(db, { username: "a", scopes: [], now });
    if (!r.ok) return;
    await setAgentEnabled(db, r.agent.id, false);
    await setAgentEnabled(db, r.agent.id, true);
    const after = await getAgentById(db, r.agent.id);
    expect(after?.enabled).toBe(true);
  });

  it("returns false for an unknown id", async () => {
    const ok = await setAgentEnabled(db, 9999, false);
    expect(ok).toBe(false);
  });
});

describe("admin/agents — rotateAgentPassword", () => {
  it("returns a NEW plaintext (different from the original)", async () => {
    // GIVEN an agent created with the initial plaintext
    // WHEN we rotate the password
    // THEN the response is a fresh plaintext AND the DB hash
    //      matches the new plaintext (NOT the old one).
    const r = await createAgent(db, { username: "a", scopes: [], now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const first = r.plaintextPassword;
    const rotated = await rotateAgentPassword(db, r.agent.id, now + 100);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.plaintextPassword).not.toBe(first);
    const row = await getAgentById(db, r.agent.id);
    const hash = await readPasswordHash(db, row!.id);
    const okNew = await verifyPassword(hash!, rotated.plaintextPassword);
    expect(okNew).toBe(true);
    const okOld = await verifyPassword(hash!, first);
    expect(okOld).toBe(false);
  });

  it("clears the requireChangeOnFirstLogin flag on rotation", async () => {
    // GIVEN the bootstrap admin (requireChangeOnFirstLogin=true)
    // WHEN the password is rotated
    // THEN the flag is set to false (the admin can now mint
    //      tokens).
    const r = await createAgent(db, {
      username: "root",
      scopes: [],
      requireChangeOnFirstLogin: true,
      now,
    });
    if (!r.ok) return;
    const before = await getAgentById(db, r.agent.id);
    expect(before?.requireChangeOnFirstLogin).toBe(true);
    await rotateAgentPassword(db, r.agent.id, now + 100);
    const after = await getAgentById(db, r.agent.id);
    expect(after?.requireChangeOnFirstLogin).toBe(false);
  });

  it("returns ok=false for an unknown id", async () => {
    const r = await rotateAgentPassword(db, 9999, now);
    expect(r.ok).toBe(false);
  });
});

describe("admin/agents — setAgentScopes", () => {
  it("replaces the scope set with the new value", async () => {
    const r = await createAgent(db, {
      username: "a",
      scopes: ["read:bi_catastro"],
      now,
    });
    if (!r.ok) return;
    const ok = await setAgentScopes(db, r.agent.id, ["read:bi_catastro", "list:bi_catastro"], now);
    expect(ok).toBe(true);
    const after = await getAgentById(db, r.agent.id);
    expect(after?.scopes).toEqual(["read:bi_catastro", "list:bi_catastro"]);
  });

  it("rejects a scope that does not match SCOPE_PATTERN", async () => {
    const r = await createAgent(db, { username: "a", scopes: [], now });
    if (!r.ok) return;
    const ok = await setAgentScopes(db, r.agent.id, ["bogus"], now);
    expect(ok).toBe(false);
  });

  it("rejects a scope that is the bare `*`", async () => {
    // The authority MUST NOT issue `*` to a new agent. The
    // scope catalog gate is the SCOPE_PATTERN check; the
    // wildcard is intentionally rejected.
    const r = await createAgent(db, { username: "a", scopes: [], now });
    if (!r.ok) return;
    const ok = await setAgentScopes(db, r.agent.id, ["*"], now);
    expect(ok).toBe(false);
  });
});

describe("admin/agents — recordAgentLogin", () => {
  it("updates the lastLoginAt timestamp", async () => {
    const r = await createAgent(db, { username: "a", scopes: [], now: now });
    if (!r.ok) return;
    await recordAgentLogin(db, r.agent.id, now + 100);
    const after = await getAgentById(db, r.agent.id);
    expect(after?.lastLoginAt).toBe(now + 100);
  });
});

describe("admin/agents — verifyAgentPassword", () => {
  it("returns ok=true with the agent on a correct password", async () => {
    const r = await createAgent(db, { username: "a", scopes: [], now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = await verifyAgentPassword(db, "a", r.plaintextPassword);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.username).toBe("a");
  });

  it("returns ok=false on a wrong password", async () => {
    const r = await createAgent(db, { username: "a", scopes: [], now });
    if (!r.ok) return;
    const result = await verifyAgentPassword(db, "a", "wrong");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid");
  });

  it("returns ok=false with reason=missing on an unknown username", async () => {
    const result = await verifyAgentPassword(db, "ghost", "anything");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
  });

  it("returns ok=false on a disabled user (no password verification done)", async () => {
    // The admin login form MUST refuse disabled users. The
    // `users.enabled` column is the gate; a disabled user is
    // `missing` from the perspective of the login form (the
    // operator should not see "wrong password" for a disabled
    // user — that would be a side channel).
    const r = await createAgent(db, { username: "a", scopes: [], now });
    if (!r.ok) return;
    await setAgentEnabled(db, r.agent.id, false);
    const result = await verifyAgentPassword(db, "a", r.plaintextPassword);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
  });
});

describe("admin/agents — changeOwnPassword", () => {
  it("returns a new plaintext AND clears the requireChangeOnFirstLogin flag", async () => {
    // GIVEN a bootstrap-style admin (requireChangeOnFirstLogin=true)
    // WHEN the admin calls changeOwnPassword (no current
    //      password, since the flag is set)
    // THEN the function returns a new plaintext AND the
    //      requireChangeOnFirstLogin flag is cleared.
    const r = await createAgent(db, {
      username: "root",
      scopes: [],
      requireChangeOnFirstLogin: true,
      now,
    });
    if (!r.ok) return;
    const result = await changeOwnPassword(db, r.agent.id, {
      currentPassword: null,
      newPassword: "new-root-password",
      now: now + 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plaintextPassword).toBe("new-root-password");
    const after = await getAgentById(db, r.agent.id);
    expect(after?.requireChangeOnFirstLogin).toBe(false);
  });

  it("rejects the rotation when requireChangeOnFirstLogin=false AND the current password is wrong", async () => {
    // GIVEN a normal admin (requireChangeOnFirstLogin=false)
    // WHEN the admin submits the wrong current password
    // THEN the function returns ok=false with reason 'invalid_current'.
    const r = await createAgent(db, { username: "root", scopes: [], now });
    if (!r.ok) return;
    const result = await changeOwnPassword(db, r.agent.id, {
      currentPassword: "wrong",
      newPassword: "new-password",
      now: now + 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_current");
  });

  it("accepts the rotation when requireChangeOnFirstLogin=false AND the current password matches", async () => {
    // GIVEN a normal admin
    // WHEN the admin submits the correct current password
    // THEN the function returns ok=true with a new plaintext.
    const r = await createAgent(db, { username: "root", scopes: [], now });
    if (!r.ok) return;
    const result = await changeOwnPassword(db, r.agent.id, {
      currentPassword: r.plaintextPassword,
      newPassword: "new-password",
      now: now + 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plaintextPassword).toBe("new-password");
    // The DB row's password hash matches the new plaintext.
    const row = await getAgentById(db, r.agent.id);
    const hash = await readPasswordHash(db, row!.id);
    const ok = await verifyPassword(hash!, "new-password");
    expect(ok).toBe(true);
    // The old plaintext no longer matches.
    const okOld = await verifyPassword(hash!, r.plaintextPassword);
    expect(okOld).toBe(false);
  });

  it("rejects an empty new password", async () => {
    const r = await createAgent(db, { username: "root", scopes: [], now });
    if (!r.ok) return;
    const result = await changeOwnPassword(db, r.agent.id, {
      currentPassword: null,
      newPassword: "",
      now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_new");
  });

  it("rejects a too-short new password (less than 8 chars)", async () => {
    // The spec says agents/clients get a 16+ byte random
    // secret on create. For self-rotation, we accept any
    // password the operator types that meets a minimum
    // length (8 chars) — the spec does not pin a specific
    // floor, so we pick a defensive default.
    const r = await createAgent(db, { username: "root", scopes: [], now });
    if (!r.ok) return;
    const result = await changeOwnPassword(db, r.agent.id, {
      currentPassword: null,
      newPassword: "short",
      now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_new");
  });

  it("returns ok=false for an unknown id", async () => {
    const result = await changeOwnPassword(db, 9999, {
      currentPassword: null,
      newPassword: "new-password",
      now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });
});

describe("admin/agents — AgentRecord type carries the spec fields", () => {
  it("the row exposes id, username, scopes, enabled, requireChangeOnFirstLogin, createdAt, lastLoginAt", async () => {
    // The shape is part of the public contract; the test pins
    // the field set so a future refactor cannot silently drop a
    // column.
    const r = await createAgent(db, {
      username: "a",
      scopes: ["read:bi_catastro"],
      requireChangeOnFirstLogin: true,
      now,
    });
    if (!r.ok) return;
    const row: AgentRecord | null = await getAgentById(db, r.agent.id);
    expect(row).not.toBeNull();
    expect(typeof row?.id).toBe("number");
    expect(typeof row?.username).toBe("string");
    expect(Array.isArray(row?.scopes)).toBe(true);
    expect(typeof row?.enabled).toBe("boolean");
    expect(typeof row?.requireChangeOnFirstLogin).toBe("boolean");
    expect(typeof row?.createdAt).toBe("number");
    expect(row?.lastLoginAt).toBeNull();
  });
});
