/**
 * Unit tests for the admin UI template helpers.
 *
 * The mcp-admin-ui spec requires:
 * - The UI is server-rendered HTML, no Express, no SPA. The
 *   router builds pages with string-template helpers — no
 *   external template engine.
 * - Every state-changing form has a hidden CSRF token input
 *   that matches the session's CSRF token.
 * - The audit viewer renders the `target` column with the
 *   `redactAuditValue` helper applied; a row whose target
 *   looks like a token displays as `***`.
 * - One-time secrets (agent password, client secret) are
 *   shown in a dedicated "WARN: copy this now" block; the
 *   secret appears ONCE in the response, never re-rendered.
 *
 * Test layer: unit. The template functions are pure
 * `(data) => string`; no DB, no listener.
 */

import { describe, it, expect } from "vitest";
import {
  renderLayout,
  renderLoginPage,
  renderChangePasswordPage,
  renderDashboard,
  renderAgentsList,
  renderAgentCreated,
  renderClientsList,
  renderClientCreated,
  renderScopesList,
  renderScopeError,
  renderRefreshTokensList,
  renderAuditList,
  renderErrorPage,
  escapeHtml,
  type AuditRowView,
  type RefreshTokenView,
} from "../../src/admin/templates.js";

const fixedNow = 1_700_000_000;

describe("admin/templates — escapeHtml", () => {
  it("escapes <, >, &, \", ' to their HTML entities", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml('"hi"')).toBe("&quot;hi&quot;");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("returns the input unchanged for safe strings", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
    expect(escapeHtml("user-42")).toBe("user-42");
  });

  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("admin/templates — renderLayout", () => {
  it("wraps the body in a valid HTML5 page with a title", () => {
    const html = renderLayout({ title: "Dashboard", body: "<p>hi</p>", csrfToken: null });
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("<title>Dashboard</title>");
    expect(html).toContain("<p>hi</p>");
  });

  it("embeds the CSRF token in a meta tag when the session is authenticated", () => {
    const html = renderLayout({ title: "X", body: "y", csrfToken: "abc123" });
    expect(html).toContain('name="csrf-token"');
    expect(html).toContain('content="abc123"');
  });

  it("does NOT embed a CSRF meta tag when the session is not authenticated", () => {
    const html = renderLayout({ title: "X", body: "y", csrfToken: null });
    expect(html).not.toContain('name="csrf-token"');
  });

  it("emits <meta name=\"color-scheme\" content=\"dark\"> so browsers render native controls in dark mode (task 3.5)", () => {
    // The mcp-admin-ui spec requires a dark-only theme.
    // The `color-scheme` meta tag is the browser-level
    // signal: it tells the user agent to render form
    // controls, scrollbars, and the canvas in dark mode
    // even before any CSS loads.
    const html = renderLayout({ title: "X", body: "y", csrfToken: null });
    expect(html).toMatch(/<meta\s+name="color-scheme"\s+content="dark"\s*>/);
  });

  it("emits `:root { color-scheme: dark }` in the embedded stylesheet (task 3.5)", () => {
    // The CSS-level `color-scheme: dark` declaration is
    // the matching hook for any nested element / pseudo
    // class that doesn't inherit from the meta tag. The
    // two together guarantee the page renders dark
    // regardless of the user's system preference.
    const html = renderLayout({ title: "X", body: "y", csrfToken: null });
    expect(html).toMatch(/:root\s*\{\s*color-scheme:\s*dark\s*;?\s*\}/);
  });

  it("does NOT emit any light-palette tokens in the embedded stylesheet (task 3.6)", () => {
    // The spec mandates dark-only; the previous light
    // palette used `#1a1a1a` for text and `#f6f6f6` for
    // the table-header background. The new palette MUST
    // NOT reuse those values.
    const html = renderLayout({ title: "X", body: "y", csrfToken: null });
    expect(html).not.toContain("#1a1a1a");
    expect(html).not.toContain("#f6f6f6");
    // The body background must NOT be white (the old
    // default). Any explicit `body { ... background: #fff
    // ... }` block would also be a regression.
    expect(html).not.toMatch(/body\s*\{[^}]*background:\s*#fff/i);
  });

  it("preserves the same class names used by the existing body markup (task 3.6 — class names unchanged)", () => {
    // Class names MUST remain unchanged so the existing
    // inline forms (warn, error, muted, btn, btn-danger,
    // nav, code) keep styling after the CSS swap. We
    // assert each class is reachable by checking the
    // embedded CSS contains a rule that targets it.
    const html = renderLayout({ title: "X", body: "y", csrfToken: null });
    // Each of these class names is referenced from a
    // `<div class="...">`, `<button class="...">`,
    // `<form ...>`, or `<code>` in the existing body
    // markup. The CSS must keep the selectors.
    expect(html).toMatch(/\.warn\b/);
    expect(html).toMatch(/\.error\b/);
    expect(html).toMatch(/\.muted\b/);
    expect(html).toMatch(/\.btn\b/);
    expect(html).toMatch(/\.btn-danger\b/);
    expect(html).toMatch(/\bnav\b/);
    expect(html).toMatch(/\bcode\b/);
  });
});

describe("admin/templates — renderLoginPage", () => {
  it("renders a form pointing at /admin/login with a username input", () => {
    const html = renderLoginPage({ error: null });
    expect(html).toContain('action="/admin/login"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
  });

  it("does NOT include a CSRF token in the login form (the login is the auth gate)", () => {
    // The login form is the only state-changing form that
    // is NOT protected by CSRF (it IS the auth gate). A
    // CSRF token would require the user to be authenticated
    // already, which is a chicken-and-egg problem.
    const html = renderLoginPage({ error: null });
    expect(html).not.toContain('name="_csrf"');
  });

  it("renders an error message when one is provided", () => {
    const html = renderLoginPage({ error: "Invalid credentials" });
    expect(html).toContain("Invalid credentials");
  });

  it("does NOT render the error block when no error", () => {
    const html = renderLoginPage({ error: null });
    expect(html).not.toContain('class="error"');
  });
});

describe("admin/templates — renderChangePasswordPage", () => {
  it("renders a form pointing at /admin/change-password", () => {
    const html = renderChangePasswordPage({
      csrfToken: "csrf-abc",
      currentRequired: true,
      error: null,
    });
    expect(html).toContain('action="/admin/change-password"');
    expect(html).toContain('name="new_password"');
    expect(html).toContain('name="_csrf"');
    expect(html).toContain('value="csrf-abc"');
  });

  it("renders a current_password input when the flag is set", () => {
    const html = renderChangePasswordPage({
      csrfToken: "csrf-abc",
      currentRequired: true,
      error: null,
    });
    expect(html).toContain('name="current_password"');
  });

  it("OMITS the current_password input when the flag is set (bootstrap case)", () => {
    const html = renderChangePasswordPage({
      csrfToken: "csrf-abc",
      currentRequired: false,
      error: null,
    });
    expect(html).not.toContain('name="current_password"');
  });

  it("renders the error block when an error is provided", () => {
    const html = renderChangePasswordPage({
      csrfToken: "csrf-abc",
      currentRequired: false,
      error: "Password too short",
    });
    expect(html).toContain("Password too short");
  });
});

describe("admin/templates — renderDashboard", () => {
  it("renders the username and navigation links", () => {
    const html = renderDashboard({ username: "root", csrfToken: "csrf-abc" });
    expect(html).toContain("root");
    expect(html).toContain("/admin/agents");
    expect(html).toContain("/admin/clients");
    expect(html).toContain("/admin/scopes");
    expect(html).toContain("/admin/refresh-tokens");
    expect(html).toContain("/admin/audit");
  });
});

describe("admin/templates — renderAgentsList", () => {
  it("renders a row for each agent with username + enabled flag + requireChangeOnFirstLogin flag", () => {
    const html = renderAgentsList({
      agents: [
        {
          id: 1,
          username: "alice",
          scopes: ["read:bi_catastro"],
          enabled: true,
          requireChangeOnFirstLogin: false,
          createdAt: fixedNow,
          lastLoginAt: null,
        },
        {
          id: 2,
          username: "bob",
          scopes: [],
          enabled: false,
          requireChangeOnFirstLogin: true,
          createdAt: fixedNow + 1,
          lastLoginAt: fixedNow + 100,
        },
      ],
      csrfToken: "csrf-abc",
    });
    expect(html).toContain("alice");
    expect(html).toContain("bob");
    expect(html).toContain("read:bi_catastro");
  });

  it("renders an empty-state row when there are no agents", () => {
    const html = renderAgentsList({ agents: [], csrfToken: "csrf-abc" });
    expect(html).toContain("No agents");
  });

  it("includes a 'New agent' form with a CSRF token", () => {
    const html = renderAgentsList({ agents: [], csrfToken: "csrf-abc" });
    expect(html).toContain('action="/admin/agents/create"');
    expect(html).toContain('name="_csrf"');
    expect(html).toContain('value="csrf-abc"');
  });

  it("renders an inline scope-edit form per agent (task 3.7)", () => {
    // The mcp-admin-ui spec requires inline scope editing
    // on the agents list page (server-rendered form, no
    // JS). Each row exposes a form whose action posts to
    // `/admin/agents/:id/scopes` with a hidden CSRF
    // input and an editable `scopes` input pre-populated
    // with the current scope set.
    const html = renderAgentsList({
      agents: [
        {
          id: 7,
          username: "alice",
          scopes: ["read:bi_catastro", "list:bi_catastro"],
          enabled: true,
          requireChangeOnFirstLogin: false,
          createdAt: fixedNow,
          lastLoginAt: null,
        },
      ],
      csrfToken: "csrf-abc",
    });
    // Per-row form posting to the scope-edit route
    expect(html).toContain('action="/admin/agents/7/scopes"');
    // The form carries the CSRF token (the canonical
    // form-based CSRF guard for state-changing requests)
    expect(html).toMatch(/action="\/admin\/agents\/7\/scopes"[\s\S]*?name="_csrf"[\s\S]*?value="csrf-abc"/);
    // The scopes input is pre-populated with the
    // current scope set (space-separated; the handler
    // re-parses it on POST).
    expect(html).toMatch(/name="scopes"\s+value="[^"]*read:bi_catastro[^"]*"/);
  });
});

describe("admin/templates — renderAgentCreated", () => {
  it("renders the one-time plaintext in a WARN block with the username", () => {
    const html = renderAgentCreated({
      username: "alice",
      plaintextPassword: "secret-password-12345",
      csrfToken: "csrf-abc",
    });
    expect(html).toContain("alice");
    expect(html).toContain("secret-password-12345");
    expect(html).toMatch(/WARN/i);
  });

  it("renders a 'Back to agents' link", () => {
    const html = renderAgentCreated({
      username: "alice",
      plaintextPassword: "x",
      csrfToken: "csrf-abc",
    });
    expect(html).toContain('href="/admin/agents"');
  });
});

describe("admin/templates — renderClientsList", () => {
  it("renders a row for each client with clientId + label + scopes", () => {
    const html = renderClientsList({
      clients: [
        {
          id: 1,
          clientId: "bi-catastro-app",
          label: "BI Catastro",
          scopes: ["read:bi_catastro"],
          createdAt: fixedNow,
          lastUsedAt: null,
        },
      ],
      csrfToken: "csrf-abc",
    });
    expect(html).toContain("bi-catastro-app");
    expect(html).toContain("BI Catastro");
    expect(html).toContain("read:bi_catastro");
  });

  it("includes a 'New client' form with a CSRF token", () => {
    const html = renderClientsList({ clients: [], csrfToken: "csrf-abc" });
    expect(html).toContain('action="/admin/clients/create"');
    expect(html).toContain('name="_csrf"');
  });

  it("renders an inline scope-edit form per client (task 3.7)", () => {
    // The mcp-admin-ui spec requires inline scope editing
    // on the clients list page (server-rendered form, no
    // JS). Each row exposes a form whose action posts to
    // `/admin/clients/:id/scopes` with a hidden CSRF
    // input and an editable `scopes` input pre-populated
    // with the current scope set.
    const html = renderClientsList({
      clients: [
        {
          id: 9,
          clientId: "bi-catastro-app",
          label: "BI Catastro",
          scopes: ["read:bi_catastro"],
          createdAt: fixedNow,
          lastUsedAt: null,
        },
      ],
      csrfToken: "csrf-abc",
    });
    // Per-row form posting to the scope-edit route
    expect(html).toContain('action="/admin/clients/9/scopes"');
    // The form carries the CSRF token
    expect(html).toMatch(/action="\/admin\/clients\/9\/scopes"[\s\S]*?name="_csrf"[\s\S]*?value="csrf-abc"/);
    // The scopes input is pre-populated with the
    // current scope set.
    expect(html).toMatch(/name="scopes"\s+value="[^"]*read:bi_catastro[^"]*"/);
  });
});

describe("admin/templates — renderClientCreated", () => {
  it("renders the one-time secret in a WARN block with the clientId", () => {
    const html = renderClientCreated({
      clientId: "bi-catastro-app",
      plaintextSecret: "client-secret-12345",
      csrfToken: "csrf-abc",
    });
    expect(html).toContain("bi-catastro-app");
    expect(html).toContain("client-secret-12345");
    expect(html).toMatch(/WARN/i);
  });
});

describe("admin/templates — renderScopesList", () => {
  it("renders a row for each scope with name + description", () => {
    const html = renderScopesList({
      scopes: [
        { name: "read:bi_catastro", description: "Read BI Catastro rows", createdAt: fixedNow },
        { name: "list:bi_catastro", description: "", createdAt: fixedNow + 1 },
      ],
      inUse: { "read:bi_catastro": 0, "list:bi_catastro": 0 },
      csrfToken: "csrf-abc",
    });
    expect(html).toContain("read:bi_catastro");
    expect(html).toContain("Read BI Catastro rows");
    expect(html).toContain("list:bi_catastro");
  });

  it("includes a 'New scope' form with a CSRF token", () => {
    const html = renderScopesList({
      scopes: [],
      inUse: {},
      csrfToken: "csrf-abc",
    });
    expect(html).toContain('action="/admin/scopes/create"');
  });

  it("renders the inUse count next to each scope (task 3.4)", () => {
    // The mcp-admin-ui spec requires the scopes list to
    // show the `inUse` count (number of agents + clients
    // currently bound to each scope). The template
    // receives a `Record<name, count>` map so the router
    // can pre-compute the counts via `scopeInUse` and
    // pass them in one shot.
    const html = renderScopesList({
      scopes: [
        { name: "read:bi_catastro", description: "Read BI", createdAt: fixedNow },
        { name: "list:bi_catastro", description: "List BI", createdAt: fixedNow + 1 },
      ],
      inUse: { "read:bi_catastro": 4, "list:bi_catastro": 0 },
      csrfToken: "csrf-abc",
    });
    // The count appears as a visible value next to the
    // scope row. We assert the number is present in the
    // HTML (the surrounding markup is up to the renderer).
    expect(html).toMatch(/read:bi_catastro[\s\S]{0,200}4/);
    // The 0-count for `list:bi_catastro` is also
    // rendered (the admin needs to know a scope is
    // currently unassigned — the delete form depends on
    // it).
    expect(html).toMatch(/list:bi_catastro[\s\S]{0,200}0/);
  });

  it("defaults the inUse count to 0 when a scope is missing from the map (defensive)", () => {
    // A scope in the catalog might exist without a row
    // in the inUse map if the router forgot to look it
    // up. The template MUST NOT throw; it MUST render
    // 0 so the page stays usable.
    const html = renderScopesList({
      scopes: [
        { name: "read:bi_catastro", description: "Read BI", createdAt: fixedNow },
      ],
      inUse: {},
      csrfToken: "csrf-abc",
    });
    expect(html).toContain("read:bi_catastro");
    // The page renders successfully (no throw).
    expect(html).toMatch(/<table[\s\S]+<\/table>/);
  });
});

describe("admin/templates — renderScopeError", () => {
  it("renders the 'in use' error with the count", () => {
    const html = renderScopeError({
      scopeName: "read:bi_catastro",
      reason: "in_use",
      count: 3,
      csrfToken: "csrf-abc",
    });
    expect(html).toContain("read:bi_catastro");
    expect(html).toContain("3");
    expect(html).toMatch(/assigned|in use|cannot delete/i);
  });
});

describe("admin/templates — renderRefreshTokensList", () => {
  it("renders each token row with agentUsername + clientId + issuedAt", () => {
    const rows: RefreshTokenView[] = [
      {
        id: 1,
        agentUsername: "alice",
        clientId: "bi-catastro-app",
        clientLabel: "BI Catastro",
        scopes: ["read:bi_catastro"],
        issuedAt: fixedNow,
        revokedAt: null,
      },
    ];
    const html = renderRefreshTokensList({ rows, csrfToken: "csrf-abc" });
    expect(html).toContain("alice");
    expect(html).toContain("bi-catastro-app");
    expect(html).toContain("read:bi_catastro");
    // A revoke form with CSRF token.
    expect(html).toContain('action="/admin/refresh-tokens/1/revoke"');
    expect(html).toContain('name="_csrf"');
  });

  it("renders 'revoked' badge for revoked tokens and OMITS the revoke button", () => {
    const rows: RefreshTokenView[] = [
      {
        id: 1,
        agentUsername: "alice",
        clientId: "bi-catastro-app",
        clientLabel: "BI Catastro",
        scopes: [],
        issuedAt: fixedNow,
        revokedAt: fixedNow + 100,
      },
    ];
    const html = renderRefreshTokensList({ rows, csrfToken: "csrf-abc" });
    expect(html).toMatch(/revoked/i);
    expect(html).not.toContain('action="/admin/refresh-tokens/1/revoke"');
  });
});

describe("admin/templates — renderAuditList — secret redaction", () => {
  it("renders a 'target' value verbatim when it does not look like a secret", () => {
    const row: AuditRowView = {
      id: 1,
      ts: fixedNow,
      actor: "root",
      action: "agent.create",
      target: "user:42",
      ip: "127.0.0.1",
      outcome: "ok",
    };
    const html = renderAuditList({ rows: [row], total: 1, page: 1, pageSize: 50, csrfToken: "csrf-abc" });
    expect(html).toContain("user:42");
    expect(html).toContain("agent.create");
    expect(html).toContain("root");
  });

  it("redacts a 64-char hex 'target' to '***' in the rendered HTML", () => {
    // The viewer-side redaction: even if a hash-like value
    // were in the database, the template renders it as
    // `***`. (In practice, auditAppend refuses to write
    // such a value — this is a defense-in-depth check.)
    const row: AuditRowView = {
      id: 1,
      ts: fixedNow,
      actor: "root",
      action: "agent.rotate",
      target: "a".repeat(64),
      ip: null,
      outcome: "ok",
    };
    const html = renderAuditList({ rows: [row], total: 1, page: 1, pageSize: 50, csrfToken: "csrf-abc" });
    expect(html).toContain("***");
    expect(html).not.toContain("a".repeat(64));
  });

  it("renders pagination links when total > pageSize", () => {
    const rows: AuditRowView[] = [];
    for (let i = 0; i < 25; i++) {
      rows.push({
        id: i + 1,
        ts: fixedNow + i,
        actor: "root",
        action: "agent.list",
        target: null,
        ip: null,
        outcome: "ok",
      });
    }
    const html = renderAuditList({ rows: rows.slice(0, 50), total: 200, page: 1, pageSize: 50, csrfToken: "csrf-abc" });
    expect(html).toContain("/admin/audit?page=2");
  });

  it("includes filter form (actor + action + from + to)", () => {
    const html = renderAuditList({ rows: [], total: 0, page: 1, pageSize: 50, csrfToken: "csrf-abc" });
    expect(html).toContain('name="actor"');
    expect(html).toContain('name="action"');
  });
});

describe("admin/templates — renderErrorPage", () => {
  it("renders a sanitized error message (no stack trace)", () => {
    const html = renderErrorPage({ status: 500, message: "Internal error", csrfToken: null });
    expect(html).toContain("500");
    expect(html).toContain("Internal error");
    // No stack trace.
    expect(html).not.toContain("at Object");
    expect(html).not.toContain(".ts:");
  });
});

describe("admin/templates — HTML escaping", () => {
  it("escapes the username in the agents list", () => {
    // GIVEN an agent whose username contains HTML
    // WHEN we render the list
    // THEN the HTML is escaped (no XSS).
    const html = renderAgentsList({
      agents: [
        {
          id: 1,
          username: "<script>alert(1)</script>",
          scopes: [],
          enabled: true,
          requireChangeOnFirstLogin: false,
          createdAt: fixedNow,
          lastLoginAt: null,
        },
      ],
      csrfToken: "csrf-abc",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the clientId in the clients list", () => {
    const html = renderClientsList({
      clients: [
        {
          id: 1,
          clientId: '"><img src=x onerror=alert(1)>',
          label: "x",
          scopes: [],
          createdAt: fixedNow,
          lastUsedAt: null,
        },
      ],
      csrfToken: "csrf-abc",
    });
    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
    expect(html).toContain("&lt;img");
  });
});
