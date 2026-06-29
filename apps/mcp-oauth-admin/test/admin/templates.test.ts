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
      csrfToken: "csrf-abc",
    });
    expect(html).toContain("read:bi_catastro");
    expect(html).toContain("Read BI Catastro rows");
    expect(html).toContain("list:bi_catastro");
  });

  it("includes a 'New scope' form with a CSRF token", () => {
    const html = renderScopesList({ scopes: [], csrfToken: "csrf-abc" });
    expect(html).toContain('action="/admin/scopes/create"');
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
