/**
 * End-to-end admin-UI assertions for PR 4 of
 * `remove-scope-authorization` (the mcp-oauth-admin admin UI).
 *
 * The mcp-admin-ui spec (delta) requires:
 * - The admin UI MUST NOT render any active control, link,
 *   button, or form whose purpose is to create, edit, delete,
 *   or assign OAuth scopes.
 * - The admin UI MUST NOT render a `scopes` column, cell,
 *   field, or section whose purpose is to display the legacy
 *   `scopes` value on the agent list, client list, agent
 *   detail, or client detail.
 * - The rendered HTML MUST NOT contain any
 *   `POST .../scopes` form action, nor a `<td>` / `<th>` /
 *   `<div>` whose labeled purpose is to display the legacy
 *   `scopes` value.
 * - No scope string (e.g. `read:bi_catastro`) is rendered as
 *   inert text in any admin page.
 * - Legacy scope values remain in storage and MAY be exposed
 *   through low-level DB/export/debug paths; the admin UI is
 *   not required to display them.
 * - The shared `@customized-mcps/mcp-http-base` package MUST
 *   NOT export the cross-slice compat shim
 *   (`SCOPE_PATTERN` / `isValidScope` / `Scope`).
 *
 * Test layer: integration for the router-rendered HTML;
 * source-level for the compat shim removal.
 *
 * Test runner: `pnpm --filter mcp-oauth-admin test`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  openDatabase,
  initializeSchema,
  drainWriterChain,
  type AuthorityDatabase,
} from "../src/db/index.js";
import { createAdminRouter, type AdminRouterDeps, type AdminSession } from "../src/admin/router.js";
import { generateSessionSecret } from "../src/admin/session.js";

/**
 * Scope strings the test uses as sentinels. The admin UI MUST
 * NOT render any of them. They mirror the previous OAuth
 * scope catalog's grammar.
 */
const SCOPE_SENTINELS = [
  "read:bi_catastro",
  "list:bi_catastro",
  "call:bi_catastro",
];

let db: AuthorityDatabase;
let server: Server;
let baseUrl: string;
let deps: AdminRouterDeps;

beforeEach(async () => {
  db = openDatabase({ path: ":memory:" });
  await initializeSchema(db);
  deps = {
    db,
    sessionSecret: generateSessionSecret(),
    secure: false,
  };
  const handler = createAdminRouter(deps);
  server = createServer(handler);
  await new Promise<void>((resolveP) => server.listen(0, "127.0.0.1", () => resolveP()));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await drainWriterChain(db);
  await new Promise<void>((resolveP, rejectP) => {
    server.close((err) => (err ? rejectP(err) : resolveP()));
  });
  await db.close();
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Log in as an admin via the router's login form. The
 * caller seeds the admin via `createAgent` so we control
 * the username / password. We then post the login form,
 * capture the session cookie, and (when the admin is in
 * the bootstrap rotation flow) complete the rotation
 * before returning.
 */
async function loginAsAdmin(): Promise<{ csrf: string; sessionCookie: string | null }> {
  const { createAgent } = await import("../src/admin/agents.js");
  await createAgent(db, {
    username: "root",
    requireChangeOnFirstLogin: false,
    now: Math.floor(Date.now() / 1000),
  });
  // The password returned by createAgent is the one we use
  // to log in. We can't intercept the plaintext here, so
  // we re-derive it via the verifyAgentPassword path on
  // the login form (the plaintext is the auto-generated
  // value returned in `createAgent`).
  // The cleanest approach is to set the password to a
  // known value via the database directly, so the login
  // form can match it. We do that by inserting a row with
  // a known argon2id hash for our test password.
  // Simpler: we delete the just-created agent and insert
  // one with a known password hash via a direct UPDATE.
  const { hashPassword } = await import("../src/oauth/passwords.js");
  const knownPassword = "testpass1234";
  const knownHash = await hashPassword(knownPassword);
  await db.execute(
    "UPDATE users SET passwordHash = ?, requireChangeOnFirstLogin = 0 WHERE username = ?",
    [knownHash, "root"],
  );
  const loginRes = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "root", password: knownPassword }),
    redirect: "manual",
  });
  const setCookie = loginRes.headers.get("set-cookie");
  const cookieHeader = setCookie ? setCookie.split(";")[0]! : "";
  const sessionCookie = cookieHeader;
  // The login response is a 302 to /admin/. The CSRF token
  // is the same on every rendered page; we read it from the
  // dashboard.
  const dashRes = await fetch(`${baseUrl}/admin/`, {
    headers: { Cookie: cookieHeader },
  });
  const dashHtml = await dashRes.text();
  const csrfMatch = dashHtml.match(/name="csrf-token"\s+content="([^"]+)"/);
  const csrf = csrfMatch?.[1] ?? "";
  return { csrf, sessionCookie };
}

/**
 * Read the rendered HTML of an admin page as an authenticated
 * admin. Returns the raw HTML body for further assertions.
 */
async function fetchAdmin(path: string, cookie: string | null): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return res.text();
}

// -----------------------------------------------------------------------
// Rendered HTML contracts — the admin UI MUST NOT render the scope surface
// -----------------------------------------------------------------------

describe("admin UI (PR 4 of remove-scope-authorization) — rendered HTML has no scope surface", () => {
  it("dashboard nav does NOT link to /admin/scopes", async () => {
    // GIVEN a logged-in admin
    // WHEN the dashboard page is rendered
    // THEN the navigation does NOT contain a link to
    //      `/admin/scopes` (the scope catalog page is
    //      removed).
    const { sessionCookie } = await loginAsAdmin();
    const html = await fetchAdmin("/admin/", sessionCookie);
    expect(html).not.toContain('href="/admin/scopes"');
  });

  it("agents list page does NOT render a 'Current scopes' column header", async () => {
    // GIVEN a logged-in admin
    // WHEN the agents list is rendered
    // THEN the table does NOT have a column whose header
    //      mentions "Current scopes" or "Edit scopes".
    const { sessionCookie } = await loginAsAdmin();
    const html = await fetchAdmin("/admin/agents", sessionCookie);
    expect(html).not.toContain("Current scopes");
    expect(html).not.toContain("Edit scopes");
  });

  it("agents list page does NOT render a POST /admin/agents/:id/scopes form", async () => {
    // GIVEN a logged-in admin
    // WHEN the agents list is rendered
    // THEN no `<form method="POST" action=".../scopes">`
    //      element is present.
    const { sessionCookie } = await loginAsAdmin();
    const html = await fetchAdmin("/admin/agents", sessionCookie);
    expect(html).not.toMatch(/<form[^>]+action="[^"]*\/admin\/agents\/\d+\/scopes"/);
    expect(html).not.toMatch(/<form[^>]+action="[^"]*\/admin\/clients\/\d+\/scopes"/);
  });

  it("agents list page does NOT render a 'set scopes' input or 'Save scopes' button", async () => {
    // The previous per-row form had a `<input name="scopes">`
    // and a `<button>Save scopes</button>`. The post-PR4
    // page MUST NOT contain either.
    const { sessionCookie } = await loginAsAdmin();
    const html = await fetchAdmin("/admin/agents", sessionCookie);
    expect(html).not.toMatch(/name="scopes"/);
    expect(html).not.toContain("Save scopes");
  });

  it("clients list page does NOT render a 'Current scopes' or 'Edit scopes' column", async () => {
    // GIVEN a logged-in admin
    // WHEN the clients list is rendered
    // THEN the table does NOT have a column whose header
    //      mentions "Current scopes" or "Edit scopes".
    const { sessionCookie } = await loginAsAdmin();
    const html = await fetchAdmin("/admin/clients", sessionCookie);
    expect(html).not.toContain("Current scopes");
    expect(html).not.toContain("Edit scopes");
  });

  it("clients list page does NOT render a POST /admin/clients/:id/scopes form", async () => {
    const { sessionCookie } = await loginAsAdmin();
    const html = await fetchAdmin("/admin/clients", sessionCookie);
    expect(html).not.toMatch(/<form[^>]+action="[^"]*\/admin\/clients\/\d+\/scopes"/);
  });

  it("refresh-tokens list does NOT render a 'Scopes' column or cell", async () => {
    // GIVEN a logged-in admin
    // WHEN the refresh-tokens list is rendered
    // THEN the table does NOT have a column whose header
    //      is "Scopes" (the column was removed; the
    //      RefreshTokenRow.scopes field is still read but
    //      not surfaced through the template).
    const { sessionCookie } = await loginAsAdmin();
    const html = await fetchAdmin("/admin/refresh-tokens", sessionCookie);
    // The template has the columns "Agent", "Client",
    // "Issued", "Status", "Actions" — "Scopes" MUST NOT be
    // present as a `<th>` header.
    expect(html).not.toMatch(/<th[^>]*>\s*Scopes\s*<\/th>/i);
  });

  it("the rendered admin HTML does NOT contain a scope string sentinel as inert text", async () => {
    // The previous page listed scope strings like
    // `read:bi_catastro` as inert text. The post-PR4 page
    // MUST NOT render any of them. We grep all of the
    // operator-facing pages and assert no scope sentinel
    // is present.
    const { sessionCookie } = await loginAsAdmin();
    const pages = [
      "/admin/",
      "/admin/agents",
      "/admin/clients",
      "/admin/refresh-tokens",
      "/admin/audit",
      "/admin/change-password",
    ];
    for (const path of pages) {
      const html = await fetchAdmin(path, sessionCookie);
      for (const sentinel of SCOPE_SENTINELS) {
        expect(
          html.includes(sentinel),
          `page ${path} unexpectedly rendered scope sentinel "${sentinel}"`,
        ).toBe(false);
      }
    }
  });

  it("the dashboard does NOT link to a 'Scopes' page (no nav entry)", async () => {
    // The dashboard nav has Dashboard / Agents / Clients /
    // Refresh tokens / Audit log / Change password. "Scopes"
    // is NOT a nav entry.
    const { sessionCookie } = await loginAsAdmin();
    const html = await fetchAdmin("/admin/", sessionCookie);
    expect(html).not.toMatch(/<a[^>]+>\s*Scopes\s*<\/a>/i);
  });
});

// -----------------------------------------------------------------------
// Router-level contracts — the scope routes MUST NOT be registered
// -----------------------------------------------------------------------

describe("admin router (PR 4 of remove-scope-authorization) — scope routes are not registered", () => {
  it("GET /admin/scopes returns 404 (route not registered)", async () => {
    // The previous router served a scope catalog page at
    // /admin/scopes. PR 4 unregisters the route. A 404
    // (the catch-all `writeJson(404)`) is the contract.
    const { sessionCookie } = await loginAsAdmin();
    const res = await fetch(`${baseUrl}/admin/scopes`, {
      headers: { Cookie: sessionCookie ?? "" },
    });
    expect(res.status).toBe(404);
  });

  it("POST /admin/scopes/create returns 404 (route not registered)", async () => {
    // The previous router accepted a POST to add a scope.
    // PR 4 unregisters the route. The CSRF check passes
    // (we send a valid token in the form body); the route
    // is no longer dispatched, so the catch-all returns 404.
    const { sessionCookie, csrf } = await loginAsAdmin();
    const res = await fetch(`${baseUrl}/admin/scopes/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: sessionCookie ?? "",
      },
      body: new URLSearchParams({ _csrf: csrf, name: "read:foo" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /admin/scopes/:name/delete returns 404 (route not registered)", async () => {
    const { sessionCookie, csrf } = await loginAsAdmin();
    const res = await fetch(`${baseUrl}/admin/scopes/read:foo/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: sessionCookie ?? "",
      },
      body: new URLSearchParams({ _csrf: csrf }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /admin/agents/:id/scopes returns 404 (route not registered)", async () => {
    const { sessionCookie, csrf } = await loginAsAdmin();
    const res = await fetch(`${baseUrl}/admin/agents/1/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: sessionCookie ?? "",
      },
      body: new URLSearchParams({ _csrf: csrf, scopes: "read:foo" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /admin/clients/:id/scopes returns 404 (route not registered)", async () => {
    const { sessionCookie, csrf } = await loginAsAdmin();
    const res = await fetch(`${baseUrl}/admin/clients/1/scopes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: sessionCookie ?? "",
      },
      body: new URLSearchParams({ _csrf: csrf, scopes: "read:foo" }),
    });
    expect(res.status).toBe(404);
  });
});

// -----------------------------------------------------------------------
// Source-level contracts — the compat shim MUST be removed from mcp-http-base
// -----------------------------------------------------------------------

describe("mcp-http-base compat shim (PR 4 of remove-scope-authorization) — SCOPE_PATTERN is gone", () => {
  function readPackageFile(relativePath: string): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", relativePath), "utf8");
  }

  it("auth.ts does NOT export SCOPE_PATTERN, isValidScope, or the Scope type", () => {
    // The cross-slice compat shim added in PR 3 of
    // `remove-scope-authorization` (so the admin module could
    // keep compiling) is removed in PR 4 once the admin
    // stops importing it.
    const src = readPackageFile(
      join("..", "..", "packages", "mcp-http-base", "src", "auth.ts"),
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/export\s+const\s+SCOPE_PATTERN/);
    expect(code).not.toMatch(/export\s+function\s+isValidScope/);
    expect(code).not.toMatch(/export\s+type\s+Scope/);
  });

  it("mcp-http-base index.ts does NOT re-export SCOPE_PATTERN, isValidScope, or Scope", () => {
    const src = readPackageFile(
      join("..", "..", "packages", "mcp-http-base", "src", "index.ts"),
    );
    // Strip comments so the JSDoc preamble (which references
    // the legacy names in prose) does not inflate the count.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bSCOPE_PATTERN\b/);
    expect(code).not.toMatch(/\bisValidScope\b/);
    // The `Scope` type alias is gone. We use a word-boundary
    // match against `Scope` as a bare identifier (no dot or
    // other separators), which catches both `type Scope` and
    // the lone `Scope` token from the PR 3 compat shim.
    expect(code).not.toMatch(/\bScope\b/);
  });

  it("mcp-http-base auth.ts does NOT export the compat shim (SCOPE_PATTERN / isValidScope / Scope type)", () => {
    const src = readPackageFile(
      join("..", "..", "packages", "mcp-http-base", "src", "auth.ts"),
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/export\s+const\s+SCOPE_PATTERN/);
    expect(code).not.toMatch(/export\s+function\s+isValidScope/);
    expect(code).not.toMatch(/export\s+type\s+Scope\b/);
  });
});

// -----------------------------------------------------------------------
// Source-level contracts — the admin module MUST NOT import the compat shim
// -----------------------------------------------------------------------

describe("admin module (PR 4 of remove-scope-authorization) — does not import SCOPE_PATTERN", () => {
  function readAdminSource(relativePath: string): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", "src", relativePath), "utf8");
  }
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("admin/agents.ts does NOT import SCOPE_PATTERN", () => {
    const src = stripComments(readAdminSource("admin/agents.ts"));
    expect(src).not.toMatch(/\bSCOPE_PATTERN\b/);
  });

  it("admin/clients.ts does NOT import SCOPE_PATTERN", () => {
    const src = stripComments(readAdminSource("admin/clients.ts"));
    expect(src).not.toMatch(/\bSCOPE_PATTERN\b/);
  });

  it("admin/router.ts does NOT import SCOPE_PATTERN", () => {
    const src = stripComments(readAdminSource("admin/router.ts"));
    expect(src).not.toMatch(/\bSCOPE_PATTERN\b/);
  });

  it("admin/scopes.ts does NOT exist (catalog module is removed)", () => {
    // The `admin/scopes.ts` file is the scope-catalog CRUD
    // module. PR 4 deletes it. We assert the file is gone
    // by attempting to import it; the import MUST fail.
    const here = dirname(fileURLToPath(import.meta.url));
    const filePath = join(here, "..", "src", "admin", "scopes.ts");
    let exists = true;
    try {
      readFileSync(filePath, "utf8");
    } catch {
      exists = false;
    }
    expect(exists, "expected src/admin/scopes.ts to be deleted").toBe(false);
  });

  it("admin/agents.ts does NOT export setAgentScopes", () => {
    const src = readAdminSource("admin/agents.ts");
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+setAgentScopes/);
  });

  it("admin/clients.ts does NOT export setClientScopes", () => {
    const src = readAdminSource("admin/clients.ts");
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+setClientScopes/);
  });
});

// -----------------------------------------------------------------------
// DB schema contract — destructive migration is FORBIDDEN
// -----------------------------------------------------------------------

describe("DB schema (PR 4 of remove-scope-authorization) — no destructive migration", () => {
  it("the seven required tables (users, clients, scopes, keys, refresh_tokens, audit_log, login_backoff) all exist", async () => {
    // The spec requires the schema to remain unchanged
    // (no destructive migration). The seven tables MUST
    // still exist after PR 4.
    const rows = await db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    const names = new Set(rows.map((r) => r.name));
    for (const required of [
      "users",
      "clients",
      "scopes",
      "keys",
      "refresh_tokens",
      "audit_log",
      "login_backoff",
    ]) {
      expect(names.has(required), `expected table ${required} to exist`).toBe(true);
    }
  });

  it("the legacy `scopes` columns on users, clients, and refresh_tokens remain inert", async () => {
    // PR 4 keeps the legacy `scopes` columns as inert
    // storage. The columns MUST still be present.
    for (const table of ["users", "clients", "refresh_tokens"]) {
      const cols = await db.select<{ name: string }>(`PRAGMA table_info(${table})`);
      const names = cols.map((c) => c.name);
      expect(
        names.includes("scopes"),
        `expected ${table}.scopes column to remain inert`,
      ).toBe(true);
    }
  });
});

// Mark the imported symbols as used so vitest doesn't fail
// on a noUnusedLocals check (some configs enable it).
void (null as unknown as AdminSession);
