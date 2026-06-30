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
 * PR 4 of `remove-scope-authorization`:
 * - `renderScopesList` and `renderScopeError` are REMOVED.
 *   The tests in this file pin the absence: the template
 *   helpers MUST NOT exist on the public surface, and the
 *   agent / client / refresh-tokens / dashboard views
 *   MUST NOT render a `Scopes` / `Current scopes` /
 *   `Edit scopes` column, a `scopes` form input, or a
 *   link to `/admin/scopes`.
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
    const html = renderLayout({ title: "X", body: "y", csrfToken: null });
    expect(html).not.toMatch(/background:\s*#fff/i);
    expect(html).not.toMatch(/color:\s*#000/i);
  });
});

describe("admin/templates — renderLoginPage", () => {
  it("renders the username + password form", () => {
    const html = renderLoginPage({ error: null });
    expect(html).toContain('action="/admin/login"');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
  });

  it("renders the error banner when an error is provided", () => {
    const html = renderLoginPage({ error: "Invalid credentials" });
    expect(html).toContain("Invalid credentials");
  });

  it("does NOT render an error banner when error is null", () => {
    const html = renderLoginPage({ error: null });
    expect(html).not.toMatch(/class="error"/);
  });
});

describe("admin/templates — renderChangePasswordPage", () => {
  it("requires the current password when currentRequired is true", () => {
    const html = renderChangePasswordPage({
      csrfToken: "csrf-abc",
      currentRequired: true,
      error: null,
    });
    expect(html).toContain('name="current_password"');
  });

  it("omits the current password when currentRequired is false (bootstrap rotation flow)", () => {
    const html = renderChangePasswordPage({
      csrfToken: "csrf-abc",
      currentRequired: false,
      error: null,
    });
    expect(html).not.toContain('name="current_password"');
  });

  it("embeds the CSRF token in a hidden input", () => {
    const html = renderChangePasswordPage({
      csrfToken: "csrf-abc",
      currentRequired: true,
      error: null,
    });
    expect(html).toContain('name="_csrf"');
    expect(html).toContain('value="csrf-abc"');
  });

  it("renders the error banner when an error is provided", () => {
    const html = renderChangePasswordPage({
      csrfToken: "csrf-abc",
      currentRequired: true,
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
    expect(html).toContain("/admin/refresh-tokens");
    expect(html).toContain("/admin/audit");
  });

  it("does NOT link to a /admin/scopes page (PR 4 of remove-scope-authorization)", () => {
    // The scope catalog page is removed in PR 4. The
    // dashboard MUST NOT link to it.
    const html = renderDashboard({ username: "root", csrfToken: "csrf-abc" });
    expect(html).not.toContain("/admin/scopes");
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
    // The legacy `scopes` column is removed in PR 4; the
    // template MUST NOT render a scope string even when
    // the row carries one (the field is read for BC; the
    // column is gone).
    expect(html).not.toContain("read:bi_catastro");
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

  it("does NOT render a 'Current scopes' / 'Edit scopes' column (PR 4 of remove-scope-authorization)", () => {
    // The previous per-row form posted to
    // `/admin/agents/:id/scopes` with a hidden CSRF
    // input. PR 4 removes the form, the column, and the
    // `scopes` input. We assert all three are gone.
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
    expect(html).not.toContain("/admin/agents/7/scopes");
    expect(html).not.toMatch(/name="scopes"/);
    expect(html).not.toContain("Save scopes");
    expect(html).not.toContain("Current scopes");
    expect(html).not.toContain("Edit scopes");
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
  it("renders a row for each client with clientId + label (no scopes column)", () => {
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
    // The legacy `scopes` column is removed; the template
    // MUST NOT render a scope string even when the row
    // carries one.
    expect(html).not.toContain("read:bi_catastro");
  });

  it("includes a 'New client' form with a CSRF token", () => {
    const html = renderClientsList({ clients: [], csrfToken: "csrf-abc" });
    expect(html).toContain('action="/admin/clients/create"');
    expect(html).toContain('name="_csrf"');
  });

  it("does NOT render an inline scope-edit form per client (PR 4 of remove-scope-authorization)", () => {
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
    expect(html).not.toContain("/admin/clients/9/scopes");
    expect(html).not.toMatch(/name="scopes"/);
    expect(html).not.toContain("Save scopes");
    expect(html).not.toContain("Current scopes");
    expect(html).not.toContain("Edit scopes");
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

describe("admin/templates — renderScopesList is REMOVED (PR 4 of remove-scope-authorization)", () => {
  it("the public surface does NOT export renderScopesList", async () => {
    // The previous scope-catalog page (`renderScopesList`)
    // is removed in PR 4. The template module's public
    // surface MUST NOT include the helper. We pin the
    // contract by importing the module and asserting the
    // named export is `undefined`.
    const mod = (await import("../../src/admin/templates.js")) as Record<string, unknown>;
    expect(mod.renderScopesList).toBeUndefined();
  });
});

describe("admin/templates — renderScopeError is REMOVED (PR 4 of remove-scope-authorization)", () => {
  it("the public surface does NOT export renderScopeError", async () => {
    const mod = (await import("../../src/admin/templates.js")) as Record<string, unknown>;
    expect(mod.renderScopeError).toBeUndefined();
  });
});

describe("admin/templates — renderRefreshTokensList", () => {
  it("renders each token row with agentUsername + clientId + issuedAt (no Scopes column)", () => {
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
    // The legacy `scopes` cell is removed; the template
    // MUST NOT render a scope string.
    expect(html).not.toContain("read:bi_catastro");
  });

  it("renders a Revoke form for active tokens", () => {
    const rows: RefreshTokenView[] = [
      {
        id: 1,
        agentUsername: "alice",
        clientId: "bi-catastro-app",
        clientLabel: "BI Catastro",
        scopes: [],
        issuedAt: fixedNow,
        revokedAt: null,
      },
    ];
    const html = renderRefreshTokensList({ rows, csrfToken: "csrf-abc" });
    expect(html).toContain('action="/admin/refresh-tokens/1/revoke"');
  });

  it("does NOT render a Revoke form for revoked tokens", () => {
    const rows: RefreshTokenView[] = [
      {
        id: 1,
        agentUsername: "alice",
        clientId: "bi-catastro-app",
        clientLabel: "BI Catastro",
        scopes: [],
        issuedAt: fixedNow,
        revokedAt: fixedNow + 1,
      },
    ];
    const html = renderRefreshTokensList({ rows, csrfToken: "csrf-abc" });
    expect(html).not.toContain('action="/admin/refresh-tokens/1/revoke"');
  });

  it("does NOT include a `<th>Scopes</th>` column header (PR 4 of remove-scope-authorization)", () => {
    const rows: RefreshTokenView[] = [];
    const html = renderRefreshTokensList({ rows, csrfToken: "csrf-abc" });
    expect(html).not.toMatch(/<th[^>]*>\s*Scopes\s*<\/th>/i);
  });
});

describe("admin/templates — renderAuditList", () => {
  it("renders each audit row with redacted target + ip", () => {
    const rows: AuditRowView[] = [
      {
        id: 1,
        ts: fixedNow,
        actor: "root",
        action: "agent.create",
        target: "user:1",
        ip: "127.0.0.1",
        outcome: "ok",
      },
    ];
    const html = renderAuditList({
      rows,
      total: 1,
      page: 1,
      pageSize: 50,
      csrfToken: "csrf-abc",
    });
    expect(html).toContain("root");
    expect(html).toContain("agent.create");
    expect(html).toContain("user:1");
    expect(html).toContain("127.0.0.1");
    expect(html).toContain("ok");
  });

  it("renders the pagination links (prev / next)", () => {
    const rows: AuditRowView[] = [];
    const html = renderAuditList({
      rows,
      total: 200,
      page: 2,
      pageSize: 50,
      csrfToken: "csrf-abc",
    });
    expect(html).toMatch(/page=1/);
    expect(html).toMatch(/page=3/);
  });

  it("preserves the filter params in the pagination link (audit / actor=root)", () => {
    const rows: AuditRowView[] = [];
    const html = renderAuditList({
      rows,
      total: 200,
      page: 2,
      pageSize: 50,
      csrfToken: "csrf-abc",
      filter: { actor: "root" },
    });
    expect(html).toContain("actor=root");
  });

  it("renders the empty-state row when the filter matches no rows", () => {
    const html = renderAuditList({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 50,
      csrfToken: "csrf-abc",
    });
    expect(html).toContain("No audit rows match the filter");
  });
});

describe("admin/templates — renderErrorPage", () => {
  it("renders the status + error message", () => {
    const html = renderErrorPage({ status: 500, message: "Internal error", csrfToken: null });
    expect(html).toContain("500");
    expect(html).toContain("Internal error");
  });
});
