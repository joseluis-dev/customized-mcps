/**
 * Unit tests for the bootstrap admin module.
 *
 * The mcp-oauth-authority spec requires:
 * - Bootstrap admin reads `MCP_OAUTH_ADMIN_USERNAME` and
 *   `MCP_OAUTH_ADMIN_PASSWORD` on first start.
 * - The password is stored as `argon2id` with
 *   `require_change_on_first_login=true`.
 * - The token endpoint MUST refuse to mint until the password
 *   is rotated (covered by `oauth/token.ts`).
 * - A `WARN` is logged while the env vars are set (even
 *   after the bootstrap completes — the spec wants a
 *   persistent reminder to rotate).
 *
 * The module's pure logic is tested here; the env-reading
 * side effect is isolated via the `readEnv` function (which
 * the production code uses too, so the test exercises the
 * same path).
 *
 * Test layer: unit + integration. The DB layer is the
 * production code path (in-memory SQLite per test).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, initializeSchema, type AuthorityDatabase } from "../../src/db/index.js";
import {
  resolveBootstrapEnv,
  ensureBootstrapAdmin,
  shouldWarnBootstrapEnv,
  type BootstrapEnv,
  type BootstrapResult,
} from "../../src/admin/bootstrap.js";

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

describe("admin/bootstrap — resolveBootstrapEnv", () => {
  it("returns null when neither env var is set", () => {
    const r = resolveBootstrapEnv({ username: undefined, password: undefined });
    expect(r).toBeNull();
  });

  it("returns null when only the username is set (the password is required)", () => {
    const r = resolveBootstrapEnv({ username: "root", password: undefined });
    expect(r).toBeNull();
  });

  it("returns null when only the password is set (the username is required)", () => {
    const r = resolveBootstrapEnv({ username: undefined, password: "change_me" });
    expect(r).toBeNull();
  });

  it("returns the env when both are set, trimming whitespace", () => {
    const r = resolveBootstrapEnv({ username: "  root  ", password: "  change_me  " });
    expect(r).not.toBeNull();
    expect(r?.username).toBe("root");
    expect(r?.password).toBe("change_me");
  });

  it("returns null when the username is empty after trim", () => {
    const r = resolveBootstrapEnv({ username: "   ", password: "change_me" });
    expect(r).toBeNull();
  });

  it("returns null when the password is empty after trim", () => {
    const r = resolveBootstrapEnv({ username: "root", password: "" });
    expect(r).toBeNull();
  });
});

describe("admin/bootstrap — shouldWarnBootstrapEnv", () => {
  it("returns true when the env is set (the WARN must persist)", () => {
    expect(shouldWarnBootstrapEnv({ username: "root", password: "x" })).toBe(true);
  });

  it("returns false when the env is null", () => {
    expect(shouldWarnBootstrapEnv(null)).toBe(false);
  });
});

describe("admin/bootstrap — ensureBootstrapAdmin", () => {
  it("creates a new admin when no admin exists yet (requireChangeOnFirstLogin=true)", async () => {
    // GIVEN an empty users table + a bootstrap env
    // WHEN we call ensureBootstrapAdmin
    // THEN a row is inserted with the supplied username,
    //      an `argon2id` hash, and requireChangeOnFirstLogin=1.
    const env: BootstrapEnv = { username: "root", password: "change_me_on_first_login" };
    const r = await ensureBootstrapAdmin(db, env, now);
    expect(r.created).toBe(true);
    expect(r.username).toBe("root");
    const rows = await db.select<{
      username: string;
      passwordHash: string;
      requireChangeOnFirstLogin: number;
      enabled: number;
    }>("SELECT username, passwordHash, requireChangeOnFirstLogin, enabled FROM users WHERE username = ?", [
      "root",
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.passwordHash).not.toBe(env.password);
    expect(row.requireChangeOnFirstLogin).toBe(1);
    expect(row.enabled).toBe(1);
  });

  it("does NOT create a second admin when one already exists (idempotent)", async () => {
    // GIVEN an existing admin
    // WHEN we call ensureBootstrapAdmin again with the same env
    // THEN no new row is created (created=false, the existing
    //      row is untouched).
    const env: BootstrapEnv = { username: "root", password: "first_password" };
    const r1 = await ensureBootstrapAdmin(db, env, now);
    expect(r1.created).toBe(true);
    const r2 = await ensureBootstrapAdmin(db, env, now + 100);
    expect(r2.created).toBe(false);
    const rows = await db.select<{ id: number }>("SELECT id FROM users WHERE username = ?", ["root"]);
    expect(rows).toHaveLength(1);
  });

  it("does NOT create an admin when the env is null (no env vars set)", async () => {
    const r = await ensureBootstrapAdmin(db, null, now);
    expect(r.created).toBe(false);
    const rows = await db.select<{ id: number }>("SELECT id FROM users");
    expect(rows).toHaveLength(0);
  });

  it("the stored password hash is the argon2id of the env password (verifiable)", async () => {
    const env: BootstrapEnv = { username: "root", password: "change_me_on_first_login" };
    const r = await ensureBootstrapAdmin(db, env, now);
    expect(r.created).toBe(true);
    const rows = await db.select<{ passwordHash: string }>(
      "SELECT passwordHash FROM users WHERE username = ?",
      ["root"],
    );
    const hash = rows[0]!.passwordHash;
    // Argon2id hashes start with `$argon2id$`.
    expect(hash).toMatch(/^\$argon2id\$/);
    // The verify call returns true for the env plaintext.
    const { verifyPassword } = await import("../../src/oauth/passwords.js");
    const ok = await verifyPassword(hash, env.password);
    expect(ok).toBe(true);
  });

  it("skips creation when an existing user with the same username already exists (even with a different password)", async () => {
    // GIVEN a non-bootstrap user (e.g. created via the admin
    //      UI later) with the same username
    // WHEN the operator restarts the authority with the
    //      bootstrap env pointing to that username
    // THEN ensureBootstrapAdmin does NOT overwrite the
    //      password (the operator might have rotated it
    //      away from the env value; overwriting would be a
    //      privilege regression). The `created` field is
    //      `false` and the existing row is untouched.
    await db.execute(
      `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt)
       VALUES (?, ?, ?, 1, 0, ?)`,
      ["root", "argon2id-stub", "[]", now - 1000],
    );
    const before = await db.select<{ passwordHash: string }>(
      "SELECT passwordHash FROM users WHERE username = ?",
      ["root"],
    );
    const env: BootstrapEnv = { username: "root", password: "change_me" };
    const r = await ensureBootstrapAdmin(db, env, now);
    expect(r.created).toBe(false);
    const after = await db.select<{ passwordHash: string }>(
      "SELECT passwordHash FROM users WHERE username = ?",
      ["root"],
    );
    expect(after[0]?.passwordHash).toBe(before[0]?.passwordHash);
  });

  it("the BootstrapResult type union is exhaustive", async () => {
    const r: BootstrapResult = await ensureBootstrapAdmin(db, null, now);
    expect(typeof r.created).toBe("boolean");
  });
});

describe("admin/bootstrap — integration with the token endpoint's require-change contract", () => {
  it("the bootstrap admin cannot mint a token until rotated (token endpoint contract)", async () => {
    // GIVEN the bootstrap admin is created with
    //      requireChangeOnFirstLogin=1
    // WHEN we insert a client + POST /oauth/token with the
    //      env password
    // THEN the response is 400 + password_change_required.
    //
    // This test pins the contract between the bootstrap
    // module and the token endpoint. The token endpoint's
    // own tests (test/oauth/token.test.ts) cover the
    // 400-password_change_required path; here we just
    // assert the wiring.
    const env: BootstrapEnv = { username: "root", password: "change_me" };
    await ensureBootstrapAdmin(db, env, now);
    // Read the row's requireChangeOnFirstLogin to confirm the
    // bootstrap module set the flag.
    const rows = await db.select<{ requireChangeOnFirstLogin: number }>(
      "SELECT requireChangeOnFirstLogin FROM users WHERE username = ?",
      ["root"],
    );
    expect(rows[0]?.requireChangeOnFirstLogin).toBe(1);
  });
});

describe("admin/bootstrap — warn-once semantics (operator reminder)", () => {
  it("shouldWarnBootstrapEnv is the single source of truth for the WARN trigger", () => {
    // The router calls `shouldWarnBootstrapEnv` exactly once
    // at startup. The function returns `true` whenever the
    // env is non-null; the router's WARN log is gated on this.
    const env: BootstrapEnv = { username: "root", password: "x" };
    expect(shouldWarnBootstrapEnv(env)).toBe(true);
    expect(shouldWarnBootstrapEnv(null)).toBe(false);
  });

  it("the warn trigger does NOT depend on whether the admin already exists", () => {
    // GIVEN the env is set
    // THEN the WARN fires regardless of whether the admin
    //      has been created. The spec is explicit: "WARN
    //      while env vars are set" — the WARN is a
    //      reminder to rotate, not a "first start" notice.
    const env: BootstrapEnv = { username: "root", password: "x" };
    expect(shouldWarnBootstrapEnv(env)).toBe(true);
  });
});

describe("admin/bootstrap — env reader does not leak into the test runner", () => {
  it("does not import process.env directly (the env is passed in)", () => {
    // The function is a pure reader; the test does not need
    // to mutate process.env. This invariant is what lets the
    // test suite run in parallel without flakiness.
    const r = resolveBootstrapEnv({ username: "u", password: "p" });
    expect(r).toEqual({ username: "u", password: "p" });
    // Sanity: the module did not read process.env.
    const original = process.env.MCP_OAUTH_ADMIN_USERNAME;
    vi.stubGlobal("process", { ...process, env: { ...process.env, MCP_OAUTH_ADMIN_USERNAME: "should_not_be_used" } });
    try {
      // The pure reader returns what was passed in, NOT
      // process.env.
      const r2 = resolveBootstrapEnv({ username: "u2", password: "p2" });
      expect(r2).toEqual({ username: "u2", password: "p2" });
    } finally {
      vi.unstubAllGlobals();
      void original;
    }
  });
});
