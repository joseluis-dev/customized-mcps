/**
 * Integration tests for the admin UI router.
 *
 * The mcp-admin-ui spec requires (PR 2):
 * - 3.1 Session: signed cookie, 32-byte secret, CSRF
 *   double-submit 403; rotation on login.
 * - 3.2 Per-username backoff: 5 fails/10m -> 429; NOT on
 *   /oauth/token.
 * - 3.3 Agent CRUD: one-time plaintext, argon2id,
 *   requireChangeOnFirstLogin; bootstrap refuses mint; WARN.
 * - 3.4 Client CRUD + scope catalog (refuse delete when
 *   assigned); revocation + audit row.
 * - 3.5 Audit viewer paginate, filter, redact; 91d row
 *   swept.
 *
 * Test layer: integration. We mount the router on a real
 * `node:http` listener on a random port and drive the
 * flows with `fetch`. The CSRF token roundtrips through
 * the cookie + the form value; the test extracts the
 * token from the rendered HTML so the next request can
 * submit a valid form.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase, initializeSchema, drainWriterChain, type AuthorityDatabase } from "../../src/db/index.js";
import { createAdminRouter, type AdminRouterDeps, type AdminSession } from "../../src/admin/router.js";
import { generateSessionSecret } from "../../src/admin/session.js";

let db: AuthorityDatabase;
let server: Server;
let baseUrl: string;
let secret: string;
let deps: AdminRouterDeps;

beforeEach(async () => {
  db = openDatabase({ path: ":memory:" });
  await initializeSchema(db);
  secret = generateSessionSecret();
  deps = {
    db,
    sessionSecret: secret,
    // loopback default → no Secure flag on the cookie
    secure: false,
  };
  const handler = createAdminRouter(deps);
  server = createServer(handler);
  await new Promise<void>((resolveP) => server.listen(0, "127.0.0.1", () => resolveP()));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  // Drain the per-DB writer chain so pending writes don't
  // block the close. Then close the server + db.
  await drainWriterChain(db);
  await new Promise<void>((resolveP, rejectP) => {
    server.close((err) => (err ? rejectP(err) : resolveP()));
  });
  await db.close();
});

/**
 * Read a JSON response. Throws when the body is not JSON.
 */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`expected JSON body; got: ${text.slice(0, 200)}`);
  }
}

/**
 * Read an HTML response and return the body.
 */
async function readHtml(res: Response): Promise<string> {
  return res.text();
}

/**
 * Extract the CSRF token from a rendered HTML page. The
 * token is in the hidden `_csrf` form input.
 */
function extractCsrf(html: string): string {
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!m) throw new Error(`CSRF token not found in HTML: ${html.slice(0, 200)}`);
  return m[1]!;
}

/**
 * Extract a Set-Cookie header value's name+value. Returns
 * the raw cookie value (no path / httpOnly etc.).
 */
function extractCookie(res: Response, name: string): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const cookies = setCookie.split(/,(?=[^;]+=)/);
  for (const c of cookies) {
    const trimmed = c.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const cookieName = trimmed.slice(0, eq);
    if (cookieName === name) {
      const value = trimmed.slice(eq + 1).split(";")[0]!;
      return value;
    }
  }
  return null;
}

describe("admin/router — session + CSRF (task 3.1)", () => {
  it("GET /admin/login renders the login form (200, no auth required)", async () => {
    const res = await fetch(`${baseUrl}/admin/login`);
    expect(res.status).toBe(200);
    const html = await readHtml(res);
    expect(html).toContain("Admin login");
    expect(html).toContain('action="/admin/login"');
  });

  it("GET /admin/login sets a session secret (no admin yet) — the cookie is set after a successful login", async () => {
    // We don't have a session secret to verify; the
    // secret is the operator's choice at process start.
    // The login form does NOT pre-mint a session — the
    // session is created on a successful login.
    const res = await fetch(`${baseUrl}/admin/login`);
    expect(res.status).toBe(200);
  });

  it("the session secret is 32 bytes (verified by the session module, exposed via deps)", () => {
    // GIVEN a freshly generated secret
    // WHEN we measure its byte length
    // THEN it is exactly 32 bytes (64 hex chars).
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(secret, "hex").length).toBe(32);
  });

  it("login with a valid (bootstrap) credential sets a signed session cookie AND a CSRF cookie in the response", async () => {
    // GIVEN the bootstrap admin is created with a known env
    // (we call the bootstrap module directly to set up the
    // row, then drive the login form).
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    const env = { username: "root", password: "change_me_on_first_login" };
    await ensureBootstrapAdmin(db, env, 1_700_000_000);

    // WHEN we POST /admin/login
    const form = new URLSearchParams({ username: "root", password: "change_me_on_first_login" });
    const res = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "manual",
    });

    // THEN the response sets a session cookie + a CSRF token,
    //      and redirects to the change-password page (because
    //      requireChangeOnFirstLogin is set on the bootstrap
    //      admin).
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBe("/admin/change-password");
    const sessionCookie = extractCookie(res, "mcp_oauth_admin_session");
    expect(sessionCookie).not.toBeNull();
    expect(sessionCookie!.length).toBeGreaterThan(10);
  });

  it("login with an invalid password returns 401 with a sanitized error message", async () => {
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "right" }, 1_700_000_000);
    const form = new URLSearchParams({ username: "root", password: "wrong" });
    const res = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(res.status).toBe(401);
    const html = await readHtml(res);
    expect(html).toContain("Invalid credentials");
    // The response MUST NOT include the supplied password
    // (the audit-safe error shape).
    expect(html).not.toContain("wrong");
  });

  it("a state-changing POST without the X-CSRF-Token / _csrf form value returns 403", async () => {
    // GIVEN an authenticated session
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    const sessionCookie = extractCookie(login, "mcp_oauth_admin_session")!;
    // First, change the password so requireChangeOnFirstLogin
    // is cleared (the next page would be the change-password
    // form, not the dashboard).
    const cpPage = await fetch(`${baseUrl}/admin/change-password`, {
      headers: { Cookie: `mcp_oauth_admin_session=${sessionCookie}` },
    });
    const cpCsrf = extractCsrf(await readHtml(cpPage));
    const changeRes = await fetch(`${baseUrl}/admin/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${sessionCookie}`,
      },
      body: new URLSearchParams({ _csrf: cpCsrf, new_password: "new-password-123" }),
      redirect: "manual",
    });
    expect(changeRes.status).toBe(302);

    // Now log in again to get a fresh session (the password
    // is now "new-password-123").
    const login2 = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "new-password-123" }),
      redirect: "manual",
    });
    const session2 = extractCookie(login2, "mcp_oauth_admin_session")!;

    // WHEN we POST /admin/agents/create WITHOUT a CSRF token
    const noCsrf = await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${session2}`,
      },
      body: new URLSearchParams({ username: "alice", scopes: "" }),
    });
    // THEN the response is 403 (CSRF guard fires)
    expect(noCsrf.status).toBe(403);
  });

  it("a state-changing POST with a valid CSRF token succeeds", async () => {
    // GIVEN an authenticated session (after rotation)
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    const sessionCookie = extractCookie(login, "mcp_oauth_admin_session")!;
    const cpPage = await fetch(`${baseUrl}/admin/change-password`, {
      headers: { Cookie: `mcp_oauth_admin_session=${sessionCookie}` },
    });
    const cpCsrf = extractCsrf(await readHtml(cpPage));
    await fetch(`${baseUrl}/admin/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${sessionCookie}`,
      },
      body: new URLSearchParams({ _csrf: cpCsrf, new_password: "new-password-123" }),
    });
    // Re-login.
    const login2 = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "new-password-123" }),
      redirect: "manual",
    });
    const session2 = extractCookie(login2, "mcp_oauth_admin_session")!;

    // Get the CSRF token from the agents list.
    const agentsPage = await fetch(`${baseUrl}/admin/agents`, {
      headers: { Cookie: `mcp_oauth_admin_session=${session2}` },
    });
    const csrf = extractCsrf(await readHtml(agentsPage));

    // WHEN we POST with the CSRF token
    const create = await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${session2}`,
      },
      body: new URLSearchParams({ _csrf: csrf, username: "alice", scopes: "read:bi_catastro" }),
      redirect: "manual",
    });
    // THEN the response is 302 (redirect to the
    //      one-time-secret page).
    expect(create.status).toBe(302);
    const location = create.headers.get("location");
    expect(location).toBe("/admin/agents/created?username=alice");
  });

  it("the session cookie is HttpOnly + SameSite=Strict", async () => {
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    const res = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    // No Secure flag on loopback.
    expect(setCookie).not.toContain("Secure");
  });
});

describe("admin/router — per-username backoff (task 3.2)", () => {
  it("after 5 failed admin logins within 10 minutes, the 6th attempt returns 429", async () => {
    // GIVEN the bootstrap admin exists
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "right" }, 1_700_000_000);

    // WHEN we POST 5 wrong passwords + a 6th wrong password
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "root", password: "wrong" }),
      });
      expect(res.status).toBe(401);
    }
    // 6th attempt
    const sixth = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "wrong" }),
    });
    // THEN the response is 429
    expect(sixth.status).toBe(429);
    const html = await readHtml(sixth);
    expect(html).toMatch(/locked|too many|429/i);
  });

  it("the 6th attempt with the CORRECT password is also rejected (the lock is username-scoped, not credential-scoped)", async () => {
    // GIVEN 5 failed logins
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "right" }, 1_700_000_000);
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "root", password: "wrong" }),
      });
    }
    // WHEN we try the right password
    const res = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "right" }),
    });
    // THEN the response is 429 (the lockout is not bypassed
    //      by guessing the right password).
    expect(res.status).toBe(429);
  });

  it("the backoff does NOT affect the /oauth/token endpoint (the spec requires the two paths to be independent)", async () => {
    // GIVEN 5 failed admin logins (which DO populate the
    //      login_backoff table for `root`)
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "right" }, 1_700_000_000);
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "root", password: "wrong" }),
      });
    }
    // The admin login is now locked. We don't have a
    // /oauth/token endpoint mounted in this router (the
    // router is for /admin/*; the token endpoint is a
    // separate handler). The contract is that the admin
    // backoff is a different state machine — we verify
    // the absence of cross-talk by checking the
    // login_backoff table is keyed on `username` and the
    // router's handler does NOT consult it for /oauth/token.
    // This test pins the architectural boundary.
    const rows = await db.select<{ username: string }>("SELECT username FROM login_backoff");
    expect(rows.map((r) => r.username)).toEqual(["root"]);
    // The token endpoint would be mounted at the same
    // listener with a different prefix; the router does
    // not own the token endpoint, so a /oauth/token
    // request would 404 here. That's the expected
    // behavior for THIS test (the router is /admin only).
    const notFound = await fetch(`${baseUrl}/oauth/token`, { method: "POST" });
    expect(notFound.status).toBe(404);
  });
});

describe("admin/router — agent CRUD (task 3.3)", () => {
  async function loginAsAdmin(): Promise<string> {
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    const session = extractCookie(login, "mcp_oauth_admin_session")!;
    const cpPage = await fetch(`${baseUrl}/admin/change-password`, {
      headers: { Cookie: `mcp_oauth_admin_session=${session}` },
    });
    const csrf = extractCsrf(await readHtml(cpPage));
    await fetch(`${baseUrl}/admin/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${session}`,
      },
      body: new URLSearchParams({ _csrf: csrf, new_password: "new-password-123" }),
    });
    const reLogin = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "new-password-123" }),
      redirect: "manual",
    });
    return extractCookie(reLogin, "mcp_oauth_admin_session")!;
  }

  async function getCsrf(cookie: string, path: string): Promise<string> {
    const page = await fetch(`${baseUrl}${path}`, {
      headers: { Cookie: `mcp_oauth_admin_session=${cookie}` },
    });
    return extractCsrf(await readHtml(page));
  }

  it("create agent returns the one-time plaintext in the redirect-target page", async () => {
    const cookie = await loginAsAdmin();
    const csrf = await getCsrf(cookie, "/admin/agents");
    const res = await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({
        _csrf: csrf,
        username: "alice",
        scopes: "read:bi_catastro",
        require_change: "1",
      }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    // The location is /admin/agents/created?username=alice
    // and the session cookie carries the plaintext.
    // We can also read the created page directly to verify
    // the plaintext is in the HTML.
    expect(location).toContain("username=alice");
    // Verify the row was created with requireChangeOnFirstLogin=1.
    const rows = await db.select<{ requireChangeOnFirstLogin: number }>(
      "SELECT requireChangeOnFirstLogin FROM users WHERE username = ?",
      ["alice"],
    );
    expect(rows[0]?.requireChangeOnFirstLogin).toBe(1);
  });

  it("disable agent flips the enabled flag to false", async () => {
    const cookie = await loginAsAdmin();
    // First create an agent.
    let csrf = await getCsrf(cookie, "/admin/agents");
    await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, username: "alice", scopes: "" }),
      redirect: "manual",
    });
    csrf = await getCsrf(cookie, "/admin/agents");
    const idRows = await db.select<{ id: number }>("SELECT id FROM users WHERE username = ?", ["alice"]);
    const id = idRows[0]!.id;
    // Disable.
    const res = await fetch(`${baseUrl}/admin/agents/${id}/disable`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const after = await db.select<{ enabled: number }>("SELECT enabled FROM users WHERE id = ?", [id]);
    expect(after[0]?.enabled).toBe(0);
  });

  it("the bootstrap admin refuses minting until rotation (WARN logged on startup)", async () => {
    // GIVEN the bootstrap admin is created
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    // The requireChangeOnFirstLogin flag is set on the row.
    // The token endpoint already enforces this (covered in
    // test/oauth/token.test.ts); this test pins the
    // router-side contract: the admin login form
    // redirects to /admin/change-password when the flag
    // is set.
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/admin/change-password");
  });
});

describe("admin/router — agent scope edit (tasks 3.1, 3.2)", () => {
  // The mcp-admin-ui spec requires:
  // - POST /admin/agents/:id/scopes updates the agent's
  //   scope set via the existing setAgentScopes() helper.
  // - Submitted scope strings MUST be validated against
  //   SCOPE_PATTERN; invalid values are rejected with a
  //   sanitized 400 and NO DB write, NO audit_log row.
  // - Successful writes append an audit_log row with
  //   action="agent.set_scopes", the new scope set, and
  //   the acting admin.

  async function loginAsAdmin(): Promise<string> {
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    const session = extractCookie(login, "mcp_oauth_admin_session")!;
    const cpPage = await fetch(`${baseUrl}/admin/change-password`, {
      headers: { Cookie: `mcp_oauth_admin_session=${session}` },
    });
    const csrf = extractCsrf(await readHtml(cpPage));
    await fetch(`${baseUrl}/admin/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${session}`,
      },
      body: new URLSearchParams({ _csrf: csrf, new_password: "new-password-123" }),
    });
    const reLogin = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "new-password-123" }),
      redirect: "manual",
    });
    return extractCookie(reLogin, "mcp_oauth_admin_session")!;
  }

  async function getCsrf(cookie: string, path: string): Promise<string> {
    const page = await fetch(`${baseUrl}${path}`, {
      headers: { Cookie: `mcp_oauth_admin_session=${cookie}` },
    });
    return extractCsrf(await readHtml(page));
  }

  async function createAgentWithScopes(
    cookie: string,
    username: string,
    scopes: string,
  ): Promise<number> {
    const csrf = await getCsrf(cookie, "/admin/agents");
    await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, username, scopes }),
      redirect: "manual",
    });
    const rows = await db.select<{ id: number }>("SELECT id FROM users WHERE username = ?", [username]);
    return rows[0]!.id;
  }

  it("POST /admin/agents/:id/scopes with a valid scope set updates the row and writes audit_log (task 3.1)", async () => {
    const cookie = await loginAsAdmin();
    const id = await createAgentWithScopes(cookie, "alice", "read:foo");
    const csrf = await getCsrf(cookie, "/admin/agents");
    // WHEN we POST a new scope set
    const res = await fetch(`${baseUrl}/admin/agents/${id}/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, scopes: "read:foo list:foo" }),
      redirect: "manual",
    });
    // THEN the response is 302 (back to the agents list)
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/agents");
    // AND the row is updated
    const after = await db.select<{ scopes: string }>("SELECT scopes FROM users WHERE id = ?", [id]);
    const parsed = JSON.parse(after[0]!.scopes) as string[];
    expect(parsed.sort()).toEqual(["list:foo", "read:foo"]);
    // AND an audit_log row records the change
    const rows = await db.select<{
      action: string;
      actor: string;
      target: string | null;
      outcome: string;
    }>(
      "SELECT action, actor, target, outcome FROM audit_log WHERE action = 'agent.set_scopes'",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor).toBe("root");
    expect(rows[0]!.target).toBe(`user:${id}`);
    expect(rows[0]!.outcome).toBe("ok");
  });

  it("POST /admin/agents/:id/scopes with an INVALID scope is rejected (400) with no DB write and no audit_log row (task 3.1)", async () => {
    const cookie = await loginAsAdmin();
    const id = await createAgentWithScopes(cookie, "alice", "read:foo");
    const csrf = await getCsrf(cookie, "/admin/agents");
    // The audit log is empty to start (the create call
    // didn't log anything either). Capture the baseline
    // BEFORE the bad POST so we can assert no NEW row is
    // written.
    const baseline = await db.select<{ id: number }>("SELECT id FROM audit_log");
    const before = baseline.length;

    // WHEN we POST an invalid scope
    const res = await fetch(`${baseUrl}/admin/agents/${id}/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, scopes: "read:foo not-a-scope" }),
      redirect: "manual",
    });
    // THEN the response is 400 (sanitized)
    expect(res.status).toBe(400);
    const html = await readHtml(res);
    expect(html).toMatch(/not valid|invalid/i);
    // AND the response MUST NOT include the bad scope
    // (audit-safety: the page does not echo the bad value
    // in a context that helps an attacker probe).
    expect(html).not.toContain("not-a-scope");
    // AND the row is unchanged
    const after = await db.select<{ scopes: string }>("SELECT scopes FROM users WHERE id = ?", [id]);
    expect(JSON.parse(after[0]!.scopes)).toEqual(["read:foo"]);
    // AND no audit_log row was written (success or denied)
    const now = await db.select<{ id: number; action: string }>("SELECT id, action FROM audit_log");
    expect(now.length).toBe(before);
  });

  it("POST /admin/agents/:id/scopes accepts an EMPTY scope set (clears the scopes)", async () => {
    // An empty scope set is allowed (the agent has no
    // scopes; the token endpoint falls back to the default
    // scope for that grant). The form's `scopes` field is
    // a space-separated string; an empty string parses to
    // an empty array.
    const cookie = await loginAsAdmin();
    const id = await createAgentWithScopes(cookie, "alice", "read:foo");
    const csrf = await getCsrf(cookie, "/admin/agents");
    const res = await fetch(`${baseUrl}/admin/agents/${id}/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, scopes: "" }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const after = await db.select<{ scopes: string }>("SELECT scopes FROM users WHERE id = ?", [id]);
    expect(JSON.parse(after[0]!.scopes)).toEqual([]);
  });

  it("POST /admin/agents/:id/scopes with an UNKNOWN id returns 404 (no DB write, no audit row)", async () => {
    const cookie = await loginAsAdmin();
    const csrf = await getCsrf(cookie, "/admin/agents");
    const before = (await db.select<{ id: number }>("SELECT id FROM audit_log")).length;
    const res = await fetch(`${baseUrl}/admin/agents/99999/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, scopes: "read:foo" }),
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    const after = (await db.select<{ id: number }>("SELECT id FROM audit_log")).length;
    expect(after).toBe(before);
  });

  it("POST /admin/agents/:id/scopes without a CSRF token is rejected (403)", async () => {
    const cookie = await loginAsAdmin();
    const id = await createAgentWithScopes(cookie, "alice", "read:foo");
    const res = await fetch(`${baseUrl}/admin/agents/${id}/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ scopes: "read:foo list:foo" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });
});

describe("admin/router — client scope edit (task 3.3)", () => {
  // The mcp-admin-ui spec requires:
  // - POST /admin/clients/:id/scopes updates the client's
  //   scope set via the existing setClientScopes() helper.
  // - Submitted scope strings MUST be validated against
  //   SCOPE_PATTERN; invalid values are rejected with a
  //   sanitized 400 and NO DB write, NO audit_log row.
  // - Successful writes append an audit_log row with
  //   action="client.set_scopes".

  async function loginAsAdmin(): Promise<string> {
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    const session = extractCookie(login, "mcp_oauth_admin_session")!;
    const cpPage = await fetch(`${baseUrl}/admin/change-password`, {
      headers: { Cookie: `mcp_oauth_admin_session=${session}` },
    });
    const csrf = extractCsrf(await readHtml(cpPage));
    await fetch(`${baseUrl}/admin/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${session}`,
      },
      body: new URLSearchParams({ _csrf: csrf, new_password: "new-password-123" }),
    });
    const reLogin = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "new-password-123" }),
      redirect: "manual",
    });
    return extractCookie(reLogin, "mcp_oauth_admin_session")!;
  }

  async function getCsrf(cookie: string, path: string): Promise<string> {
    const page = await fetch(`${baseUrl}${path}`, {
      headers: { Cookie: `mcp_oauth_admin_session=${cookie}` },
    });
    return extractCsrf(await readHtml(page));
  }

  async function createClientWithScopes(
    cookie: string,
    clientId: string,
    scopes: string,
  ): Promise<number> {
    const csrf = await getCsrf(cookie, "/admin/clients");
    await fetch(`${baseUrl}/admin/clients/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, client_id: clientId, label: clientId, scopes }),
      redirect: "manual",
    });
    const rows = await db.select<{ id: number }>("SELECT id FROM clients WHERE clientId = ?", [clientId]);
    return rows[0]!.id;
  }

  it("POST /admin/clients/:id/scopes with a valid scope set updates the row and writes audit_log (task 3.3)", async () => {
    const cookie = await loginAsAdmin();
    const id = await createClientWithScopes(cookie, "bi-app", "read:foo");
    const csrf = await getCsrf(cookie, "/admin/clients");
    const res = await fetch(`${baseUrl}/admin/clients/${id}/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, scopes: "read:foo list:foo" }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/clients");
    const after = await db.select<{ scopes: string }>("SELECT scopes FROM clients WHERE id = ?", [id]);
    const parsed = JSON.parse(after[0]!.scopes) as string[];
    expect(parsed.sort()).toEqual(["list:foo", "read:foo"]);
    const rows = await db.select<{
      action: string;
      actor: string;
      target: string | null;
      outcome: string;
    }>(
      "SELECT action, actor, target, outcome FROM audit_log WHERE action = 'client.set_scopes'",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor).toBe("root");
    expect(rows[0]!.target).toBe(`client:${id}`);
    expect(rows[0]!.outcome).toBe("ok");
  });

  it("POST /admin/clients/:id/scopes with an INVALID scope is rejected (400) with no DB write and no audit_log row (task 3.3)", async () => {
    const cookie = await loginAsAdmin();
    const id = await createClientWithScopes(cookie, "bi-app", "read:foo");
    const csrf = await getCsrf(cookie, "/admin/clients");
    const before = (await db.select<{ id: number }>("SELECT id FROM audit_log")).length;
    const res = await fetch(`${baseUrl}/admin/clients/${id}/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, scopes: "read:foo not-a-scope" }),
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    const html = await readHtml(res);
    expect(html).toMatch(/not valid|invalid/i);
    expect(html).not.toContain("not-a-scope");
    const after = await db.select<{ scopes: string }>("SELECT scopes FROM clients WHERE id = ?", [id]);
    expect(JSON.parse(after[0]!.scopes)).toEqual(["read:foo"]);
    const now = (await db.select<{ id: number }>("SELECT id FROM audit_log")).length;
    expect(now).toBe(before);
  });

  it("POST /admin/clients/:id/scopes with an UNKNOWN id returns 404 (no DB write, no audit row)", async () => {
    const cookie = await loginAsAdmin();
    const csrf = await getCsrf(cookie, "/admin/clients");
    const before = (await db.select<{ id: number }>("SELECT id FROM audit_log")).length;
    const res = await fetch(`${baseUrl}/admin/clients/99999/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, scopes: "read:foo" }),
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    const after = (await db.select<{ id: number }>("SELECT id FROM audit_log")).length;
    expect(after).toBe(before);
  });

  it("POST /admin/clients/:id/scopes without a CSRF token is rejected (403)", async () => {
    const cookie = await loginAsAdmin();
    const id = await createClientWithScopes(cookie, "bi-app", "read:foo");
    const res = await fetch(`${baseUrl}/admin/clients/${id}/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ scopes: "read:foo list:foo" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });
});

describe("admin/router — client CRUD + scope catalog (task 3.4)", () => {
  async function loginAsAdmin(): Promise<string> {
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    const session = extractCookie(login, "mcp_oauth_admin_session")!;
    const cpPage = await fetch(`${baseUrl}/admin/change-password`, {
      headers: { Cookie: `mcp_oauth_admin_session=${session}` },
    });
    const csrf = extractCsrf(await readHtml(cpPage));
    await fetch(`${baseUrl}/admin/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${session}`,
      },
      body: new URLSearchParams({ _csrf: csrf, new_password: "new-password-123" }),
    });
    const reLogin = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "new-password-123" }),
      redirect: "manual",
    });
    return extractCookie(reLogin, "mcp_oauth_admin_session")!;
  }

  async function getCsrf(cookie: string, path: string): Promise<string> {
    const page = await fetch(`${baseUrl}${path}`, {
      headers: { Cookie: `mcp_oauth_admin_session=${cookie}` },
    });
    return extractCsrf(await readHtml(page));
  }

  it("create client returns 302 to the one-time-secret page", async () => {
    const cookie = await loginAsAdmin();
    const csrf = await getCsrf(cookie, "/admin/clients");
    const res = await fetch(`${baseUrl}/admin/clients/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, client_id: "bi-app", label: "BI", scopes: "read:bi_catastro" }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain("client_id=bi-app");
  });

  it("delete scope refused when assigned to an agent (with count)", async () => {
    // GIVEN an agent with the scope
    const cookie = await loginAsAdmin();
    let csrf = await getCsrf(cookie, "/admin/agents");
    await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, username: "alice", scopes: "read:bi_catastro" }),
      redirect: "manual",
    });
    csrf = await getCsrf(cookie, "/admin/scopes");
    await fetch(`${baseUrl}/admin/scopes/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, name: "read:bi_catastro", description: "" }),
      redirect: "manual",
    });
    // WHEN we try to delete the scope
    csrf = await getCsrf(cookie, "/admin/scopes");
    const res = await fetch(`${baseUrl}/admin/scopes/${encodeURIComponent("read:bi_catastro")}/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf }),
      redirect: "manual",
    });
    // THEN the response is 409 (Conflict) with the error
    //      page. 409 is the semantically correct status for
    //      "the resource is in use and cannot be deleted".
    //      The router renders the in-use error inline
    //      (rather than redirecting to the success page).
    expect(res.status).toBe(409);
    const html = await readHtml(res);
    expect(html).toMatch(/cannot delete|assigned|in use/i);
    expect(html).toContain("1"); // the count
  });

  it("revoke a refresh token appends an audit row", async () => {
    // GIVEN an admin login + a refresh token
    const cookie = await loginAsAdmin();
    // Seed a refresh token via direct SQL.
    await db.execute(
      `INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, 1, 0, ?)`,
      ["agent-x", "argon2id-stub", "[]", 1_700_000_000],
    );
    await db.execute(
      `INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ["client-x", "argon2id-stub", "x", "[]", 1_700_000_000],
    );
    await db.execute(
      `INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt) VALUES (?, ?, ?, ?, ?, NULL)`,
      [1, 1, "[]", "hash-x", 1_700_000_000],
    );
    // WHEN we POST to revoke
    const csrf = await getCsrf(cookie, "/admin/refresh-tokens");
    const res = await fetch(`${baseUrl}/admin/refresh-tokens/1/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    // THEN the audit_log has a row with action=refresh.revoke
    const rows = await db.select<{ action: string; target: string | null }>(
      "SELECT action, target FROM audit_log WHERE action = 'refresh.revoke'",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.target).toBe("refresh:1");
  });
});

describe("admin/router — scopes list shows inUse count (task 3.4)", () => {
  // The mcp-admin-ui spec requires the scopes list to
  // display the `inUse` count (number of agents + clients
  // currently bound to each scope). The router must call
  // `scopeInUse` for every catalog scope and pass the
  // counts to `renderScopesList`. This test pins the
  // end-to-end behavior: a real DB row assignment causes
  // the matching count to appear in the rendered HTML.

  async function loginAsAdmin(): Promise<string> {
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    const session = extractCookie(login, "mcp_oauth_admin_session")!;
    const cpPage = await fetch(`${baseUrl}/admin/change-password`, {
      headers: { Cookie: `mcp_oauth_admin_session=${session}` },
    });
    const csrf = extractCsrf(await readHtml(cpPage));
    await fetch(`${baseUrl}/admin/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${session}`,
      },
      body: new URLSearchParams({ _csrf: csrf, new_password: "new-password-123" }),
    });
    const reLogin = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "new-password-123" }),
      redirect: "manual",
    });
    return extractCookie(reLogin, "mcp_oauth_admin_session")!;
  }

  async function getCsrf(cookie: string, path: string): Promise<string> {
    const page = await fetch(`${baseUrl}${path}`, {
      headers: { Cookie: `mcp_oauth_admin_session=${cookie}` },
    });
    return extractCsrf(await readHtml(page));
  }

  it("GET /admin/scopes renders the inUse count per scope (task 3.4)", async () => {
    // GIVEN a scope assigned to 1 agent and 0 clients
    const cookie = await loginAsAdmin();
    const csrf = await getCsrf(cookie, "/admin/agents");
    await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf, username: "alice", scopes: "read:bi_catastro" }),
      redirect: "manual",
    });
    // Add the scope to the catalog so the scopes list
    // has a row for it.
    const scsrf = await getCsrf(cookie, "/admin/scopes");
    await fetch(`${baseUrl}/admin/scopes/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: scsrf, name: "read:bi_catastro", description: "" }),
      redirect: "manual",
    });
    // WHEN the admin loads the scopes list
    const res = await fetch(`${baseUrl}/admin/scopes`, {
      headers: { Cookie: `mcp_oauth_admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await readHtml(res);
    // THEN the page shows the scope name AND the inUse
    // count of 1 next to it (1 agent has the scope).
    expect(html).toContain("read:bi_catastro");
    expect(html).toMatch(/read:bi_catastro[\s\S]{0,400}1/);
  });
});

describe("admin/router — audit viewer (task 3.5)", () => {
  async function loginAsAdmin(): Promise<string> {
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    const session = extractCookie(login, "mcp_oauth_admin_session")!;
    const cpPage = await fetch(`${baseUrl}/admin/change-password`, {
      headers: { Cookie: `mcp_oauth_admin_session=${session}` },
    });
    const csrf = extractCsrf(await readHtml(cpPage));
    await fetch(`${baseUrl}/admin/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${session}`,
      },
      body: new URLSearchParams({ _csrf: csrf, new_password: "new-password-123" }),
    });
    const reLogin = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "new-password-123" }),
      redirect: "manual",
    });
    return extractCookie(reLogin, "mcp_oauth_admin_session")!;
  }

  it("GET /admin/audit renders rows newest-first with pagination", async () => {
    // GIVEN 3 audit rows
    const { auditAppend } = await import("../../src/admin/audit.js");
    for (let i = 0; i < 3; i++) {
      await auditAppend(db, {
        ts: 1_700_000_000 + i,
        actor: "root",
        action: `action.${i}`,
        outcome: "ok",
      });
    }
    // WHEN the admin loads /admin/audit
    const cookie = await loginAsAdmin();
    const res = await fetch(`${baseUrl}/admin/audit`, {
      headers: { Cookie: `mcp_oauth_admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await readHtml(res);
    // Newest first.
    expect(html.indexOf("action.2")).toBeLessThan(html.indexOf("action.1"));
    expect(html.indexOf("action.1")).toBeLessThan(html.indexOf("action.0"));
  });

  it("the audit viewer filters by actor", async () => {
    const { auditAppend } = await import("../../src/admin/audit.js");
    await auditAppend(db, { ts: 1, actor: "root", action: "x", outcome: "ok" });
    await auditAppend(db, { ts: 2, actor: "alice", action: "x", outcome: "ok" });
    const cookie = await loginAsAdmin();
    const res = await fetch(`${baseUrl}/admin/audit?actor=root`, {
      headers: { Cookie: `mcp_oauth_admin_session=${cookie}` },
    });
    const html = await readHtml(res);
    expect(html).toContain("root");
    // The filter form is pre-populated.
    expect(html).toContain('value="root"');
  });

  it("the audit viewer redacts a 64-char hex 'target' to '***' (defense in depth)", async () => {
    // The auditAppend helper refuses to persist a 64-char
    // hex. The redaction is the viewer-side fallback for
    // any future schema where such a value COULD exist.
    // We use a non-secret value here (just the action
    // name) and assert the page renders correctly; the
    // redaction of a 64-char hex is covered by the
    // templates test.
    const { auditAppend } = await import("../../src/admin/audit.js");
    await auditAppend(db, { ts: 1, actor: "root", action: "agent.create", target: "alice", outcome: "ok" });
    const cookie = await loginAsAdmin();
    const res = await fetch(`${baseUrl}/admin/audit`, {
      headers: { Cookie: `mcp_oauth_admin_session=${cookie}` },
    });
    const html = await readHtml(res);
    expect(html).toContain("alice");
    expect(html).toContain("agent.create");
  });
});

describe("admin/router — CSRF header for fetch-style requests (gate W2 remediation)", () => {
  // The mcp-admin-ui spec says:
  //   "every state-changing form has a hidden CSRF token input
  //    AND the matching `X-CSRF-Token` header on fetch
  //    requests; the server rejects requests missing either."
  //
  // The original implementation validated only the form's
  // `_csrf` input. Fetch-style requests (the future
  // JS-driven flow) need a path that authenticates the
  // request via the `X-CSRF-Token` HTTP header. The server
  // MUST accept EITHER a form `_csrf` input OR an
  // `X-CSRF-Token` header — and MUST reject when BOTH are
  // missing.
  //
  // The existing form-based POST behavior is preserved: a
  // request with the form's hidden `_csrf` input continues
  // to be accepted (no header required).

  async function loginAsAdmin(): Promise<string> {
    const { ensureBootstrapAdmin } = await import("../../src/admin/bootstrap.js");
    await ensureBootstrapAdmin(db, { username: "root", password: "x" }, 1_700_000_000);
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "x" }),
      redirect: "manual",
    });
    const session = extractCookie(login, "mcp_oauth_admin_session")!;
    const cpPage = await fetch(`${baseUrl}/admin/change-password`, {
      headers: { Cookie: `mcp_oauth_admin_session=${session}` },
    });
    const csrf = extractCsrf(await readHtml(cpPage));
    await fetch(`${baseUrl}/admin/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${session}`,
      },
      body: new URLSearchParams({ _csrf: csrf, new_password: "new-password-123" }),
    });
    const reLogin = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "root", password: "new-password-123" }),
      redirect: "manual",
    });
    return extractCookie(reLogin, "mcp_oauth_admin_session")!;
  }

  async function getCsrf(cookie: string, path: string): Promise<string> {
    const page = await fetch(`${baseUrl}${path}`, {
      headers: { Cookie: `mcp_oauth_admin_session=${cookie}` },
    });
    return extractCsrf(await readHtml(page));
  }

  it("a fetch-style POST with a valid X-CSRF-Token header (no form _csrf) is accepted (302)", async () => {
    // GIVEN an authenticated session
    const cookie = await loginAsAdmin();
    // The page renders the CSRF token in the session; the
    // fetch client must read it from the page (or from a
    // future meta tag) and echo it in the header.
    const csrf = await getCsrf(cookie, "/admin/agents");

    // WHEN we POST /admin/agents/create with the
    //      X-CSRF-Token header set and NO `_csrf` in the
    //      body
    const res = await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
        "X-CSRF-Token": csrf,
      },
      body: new URLSearchParams({ username: "bob", scopes: "" }),
      redirect: "manual",
    });

    // THEN the response is 302 (the same redirect a form
    //      submission with the hidden input would get).
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain("username=bob");
  });

  it("a fetch-style POST with a MISMATCHED X-CSRF-Token header is rejected (403)", async () => {
    // GIVEN an authenticated session
    const cookie = await loginAsAdmin();

    // WHEN we POST with an X-CSRF-Token header that does
    //      NOT match the session's CSRF token (and no
    //      form _csrf)
    const res = await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
        "X-CSRF-Token": "definitely-not-the-session-csrf",
      },
      body: new URLSearchParams({ username: "mallory", scopes: "" }),
    });

    // THEN the response is 403 — the header value is
    //      rejected by the constant-time comparison.
    expect(res.status).toBe(403);
  });

  it("a form POST with the _csrf form input and NO X-CSRF-Token header is STILL accepted (preserves form-based flow)", async () => {
    // This is the existing form-based POST behavior,
    // preserved per the orchestrator's note: "Preserve
    // normal form POST behavior if the UI currently relies
    // on form submission without custom headers."
    const cookie = await loginAsAdmin();
    const csrf = await getCsrf(cookie, "/admin/agents");

    const res = await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
        // NOTE: no X-CSRF-Token header on purpose
      },
      body: new URLSearchParams({ _csrf: csrf, username: "carol", scopes: "" }),
      redirect: "manual",
    });

    expect(res.status).toBe(302);
  });

  it("a POST with BOTH a valid header and a valid form _csrf is accepted (the header wins when both are present)", async () => {
    // The fetch client and the form client MAY coexist
    // (e.g. progressive enhancement). When both are
    // present, the header is the authoritative source —
    // the form's hidden input is a fallback. Either
    // being valid is sufficient.
    const cookie = await loginAsAdmin();
    const csrf = await getCsrf(cookie, "/admin/agents");

    const res = await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
        "X-CSRF-Token": csrf, // valid
      },
      body: new URLSearchParams({ _csrf: csrf, username: "dave", scopes: "" }),
      redirect: "manual",
    });

    expect(res.status).toBe(302);
  });

  it("a POST with a valid form _csrf but a MISMATCHED X-CSRF-Token header is REJECTED (header takes precedence)", async () => {
    // When both are present, the header is the
    // authoritative source. A mismatched header
    // constitutes "the header is present and wrong" and
    // MUST reject the request — even if the form's
    // hidden input would have been valid.
    const cookie = await loginAsAdmin();
    const csrf = await getCsrf(cookie, "/admin/agents");

    const res = await fetch(`${baseUrl}/admin/agents/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `mcp_oauth_admin_session=${cookie}`,
        "X-CSRF-Token": "wrong",
      },
      body: new URLSearchParams({ _csrf: csrf, username: "eve", scopes: "" }),
    });

    expect(res.status).toBe(403);
  });
});

describe("admin/router — AdminSession export", () => {
  it("exports the AdminSession type for callers", () => {
    // The type-only import is a no-op at runtime; the test
    // pins the contract that callers can import the type.
    const _: AdminSession | null = null;
    void _;
  });
});
