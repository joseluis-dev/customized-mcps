/**
 * Server-rendered HTML templates for the admin UI.
 *
 * The mcp-admin-ui spec requires:
 * - The UI is server-rendered HTML, no Express, no SPA.
 *   Each page is a pure `(data) => string` function —
 *   no state, no listener, no DB access. The router owns
 *   the request/response cycle; the templates just render.
 * - Every state-changing form has a hidden `_csrf` input
 *   that matches the session's CSRF token. The login form
 *   is the only exception (it IS the auth gate).
 * - The audit viewer applies `redactAuditValue` to the
 *   `target` / `ip` columns so an operator reading the page
 *   over the shoulder does not see a secret.
 * - One-time secrets (agent password, client secret) are
 *   shown in a dedicated "WARN: copy this now" block; the
 *   secret appears ONCE in the response, never re-rendered.
 *
 * PR 4 of `remove-scope-authorization`:
 * - `renderScopesList` and `renderScopeError` are REMOVED.
 *   The scope catalog page is no longer rendered; the
 *   `/admin/scopes` route is no longer registered.
 * - The agents list, clients list, and refresh-tokens list
 *   MUST NOT include a `Scopes` / `Current scopes` /
 *   `Edit scopes` column. The nav MUST NOT link to a
 *   "Scopes" page.
 * - Legacy `scopes` values are NEVER rendered as inert
 *   text on any admin page. The `RefreshTokenRow.scopes`
 *   field is still read (for BC), but the template does
 *   not surface it.
 *
 * HTML escaping:
 * - Every dynamic value is passed through `escapeHtml`
 *   before being embedded in the page. The escape covers
 *   `<`, `>`, `&`, `"`, `'` — the XSS surface for an
 *   HTML attribute / text context.
 * - The escape is NOT a defense for the URL contexts
 *   (e.g. `href`); for those, the templates only embed
 *   the literal path strings, never user input.
 *
 * Audit-safety:
 * - The one-time secret display is the only place the
 *   plaintext secret appears. The templates NEVER log
 *   the secret, NEVER echo it in a query string, and
 *   NEVER embed it in a form value (so a page-refresh does
 *   not re-render it).
 */

import { redactAuditValue } from "./audit.js";
import type { AgentRecord } from "./agents.js";
import type { ClientRecord } from "./clients.js";
import type { RefreshTokenRow } from "./refresh.js";
import type { AuditRow } from "./audit.js";

/**
 * The audit view-model — same shape as the DB row, but
 * `target` / `ip` have been pre-redacted by the caller.
 * The router does the redaction so the template is a
 * pure renderer (no redaction logic embedded in HTML).
 */
export type AuditRowView = Omit<AuditRow, "target" | "ip"> & {
  target: string | null;
  ip: string | null;
};

/** A pre-shaped row for the refresh-token list.
 *  PR 4 of `remove-scope-authorization`: the `scopes` field
 *  is intentionally NOT part of the view-model that the
 *  refresh-tokens template renders. The field is still
 *  read from the DB (for BC + future migration tooling)
 *  but the template does not project it onto a column. */
export type RefreshTokenView = Omit<RefreshTokenRow, "scopes">;

/** HTML escape. The 5 characters that have meaning in HTML
 *  text / attribute contexts. */
export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the HTML layout (DOCTYPE + head + body). The
 * `csrfToken` is embedded as a `<meta>` tag so client-side
 * JavaScript (if any future feature adds JS) can read it
 * for the `X-CSRF-Token` header. For the current
 * form-based flow, the meta tag is informational; the
 * server's actual check uses the `_csrf` form input.
 *
 * The page is dark-only (the mcp-admin-ui spec is
 * explicit). The `<meta name="color-scheme" content="dark">`
 * tag tells the user agent to render form controls,
 * scrollbars, and the canvas in dark mode before any
 * CSS loads. The `:root { color-scheme: dark }` rule
 * is the matching CSS hook for any nested element /
 * pseudo class that doesn't inherit from the meta tag.
 * The two together guarantee the page renders dark
 * regardless of the user's system preference.
 *
 * Class names are preserved from the previous light
 * theme so the existing inline forms (warn, error,
 * muted, btn, btn-danger, nav, code) keep styling after
 * the CSS swap. The colors below are GitHub Dark tokens
 * (the spec's reference palette); text vs. background
 * contrast is WCAG AA.
 */
export function renderLayout(options: {
  title: string;
  body: string;
  csrfToken: string | null;
}): string {
  const meta = options.csrfToken
    ? `<meta name="csrf-token" content="${escapeHtml(options.csrfToken)}">`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(options.title)}</title>
${meta}
<style>
:root { color-scheme: dark; }
html, body { background: #0d1117; color: #e6edf3; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; max-width: 1100px; }
h1, h2, h3 { font-weight: 600; color: #e6edf3; }
a { color: #58a6ff; }
a:visited { color: #8b949e; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #30363d; padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
th { background: #161b22; color: #e6edf3; }
.warn { background: #1c2128; border: 1px solid #d29922; color: #e6edf3; padding: 1rem; margin: 1rem 0; }
.error { background: #1c2128; border: 1px solid #f85149; color: #f85149; padding: 0.75rem 1rem; margin: 1rem 0; }
.muted { color: #7d8590; font-size: 0.9em; }
.btn { display: inline-block; padding: 0.4rem 0.9rem; background: #238636; color: #ffffff; border: 1px solid #30363d; border-radius: 4px; cursor: pointer; text-decoration: none; }
.btn:hover { background: #2ea043; }
.btn-danger { background: #6e1212; color: #ffffff; }
.btn-danger:hover { background: #8b1a1a; }
nav { margin-bottom: 1.5rem; }
nav a { margin-right: 1rem; }
code { background: #161b22; color: #e6edf3; padding: 0.1rem 0.3rem; border-radius: 3px; }
input, select, textarea { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; padding: 0.3rem 0.5rem; border-radius: 3px; }
input[type="submit"], input[type="button"] { background: #238636; color: #ffffff; cursor: pointer; }
label { color: #e6edf3; }
</style>
</head>
<body>
${options.body}
</body>
</html>`;
}

/** Render the login page. */
export function renderLoginPage(options: { error: string | null }): string {
  const error = options.error
    ? `<div class="error">${escapeHtml(options.error)}</div>`
    : "";
  const body = `
<h1>Admin login</h1>
${error}
<form action="/admin/login" method="POST">
  <p><label>Username: <input type="text" name="username" autocomplete="username" required></label></p>
  <p><label>Password: <input type="password" name="password" autocomplete="current-password" required></label></p>
  <p><button type="submit" class="btn">Sign in</button></p>
</form>
<p class="muted">Default credentials are read from <code>MCP_OAUTH_ADMIN_USERNAME</code> and <code>MCP_OAUTH_ADMIN_PASSWORD</code> on first start. The first login forces a password rotation.</p>
`;
  return renderLayout({ title: "Admin login", body, csrfToken: null });
}

/** Render the change-password page. */
export function renderChangePasswordPage(options: {
  csrfToken: string;
  currentRequired: boolean;
  error: string | null;
}): string {
  const error = options.error
    ? `<div class="error">${escapeHtml(options.error)}</div>`
    : "";
  const currentInput = options.currentRequired
    ? `<p><label>Current password: <input type="password" name="current_password" autocomplete="current-password" required></label></p>`
    : "";
  const body = `
<h1>Change password</h1>
${error}
<form action="/admin/change-password" method="POST">
  <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
  ${currentInput}
  <p><label>New password: <input type="password" name="new_password" autocomplete="new-password" minlength="8" required></label></p>
  <p><button type="submit" class="btn">Change password</button></p>
</form>
<p class="muted">Minimum 8 characters. The new password is stored as an <code>argon2id</code> hash.</p>
`;
  return renderLayout({ title: "Change password", body, csrfToken: options.csrfToken });
}

/** Render the dashboard. */
export function renderDashboard(options: { username: string; csrfToken: string }): string {
  const body = `
<nav>
  <a href="/admin/agents">Agents</a>
  <a href="/admin/clients">Clients</a>
  <a href="/admin/refresh-tokens">Refresh tokens</a>
  <a href="/admin/audit">Audit log</a>
  <a href="/admin/change-password">Change password</a>
  <form action="/admin/logout" method="POST" style="display:inline">
    <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
    <button type="submit" class="btn btn-danger">Sign out</button>
  </form>
</nav>
<h1>Welcome, ${escapeHtml(options.username)}</h1>
<p class="muted">You are signed in to the <code>mcp-oauth-admin</code> console.</p>
`;
  return renderLayout({ title: "Dashboard", body, csrfToken: options.csrfToken });
}

/** Render the agents list. */
export function renderAgentsList(options: {
  agents: AgentRecord[];
  csrfToken: string;
}): string {
  const rows =
    options.agents.length === 0
      ? `<tr><td colspan="5" class="muted">No agents yet.</td></tr>`
      : options.agents
          .map(
            (a) => `
<tr>
  <td>${escapeHtml(a.username)}</td>
  <td>${a.enabled ? "yes" : "no"}</td>
  <td>${a.requireChangeOnFirstLogin ? "yes" : "no"}</td>
  <td>${escapeHtml(formatDate(a.createdAt))}</td>
  <td>
    <form action="/admin/agents/${a.id}/${a.enabled ? "disable" : "enable"}" method="POST" style="display:inline">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <button type="submit" class="btn">${a.enabled ? "Disable" : "Enable"}</button>
    </form>
    <form action="/admin/agents/${a.id}/rotate" method="POST" style="display:inline">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <button type="submit" class="btn">Rotate password</button>
    </form>
  </td>
</tr>`,
          )
          .join("");
  const body = `
<nav>
  <a href="/admin/">Dashboard</a>
  <a href="/admin/agents">Agents</a>
  <a href="/admin/clients">Clients</a>
  <a href="/admin/refresh-tokens">Refresh tokens</a>
  <a href="/admin/audit">Audit log</a>
</nav>
<h1>Agents</h1>
<table>
  <thead><tr><th>Username</th><th>Enabled</th><th>Rotation required</th><th>Created</th><th>Actions</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<h2>Create agent</h2>
<form action="/admin/agents/create" method="POST">
  <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
  <p><label>Username: <input type="text" name="username" required pattern="[A-Za-z0-9_.-]+"></label></p>
  <p><label><input type="checkbox" name="require_change" value="1"> Require password change on first login</label></p>
  <p><button type="submit" class="btn">Create agent</button></p>
</form>
`;
  return renderLayout({ title: "Agents", body, csrfToken: options.csrfToken });
}

/** Render the one-time agent password page. */
export function renderAgentCreated(options: {
  username: string;
  plaintextPassword: string;
  csrfToken: string;
}): string {
  const body = `
<nav><a href="/admin/agents">Back to agents</a></nav>
<h1>Agent created</h1>
<div class="warn">
  <strong>WARN:</strong> The password below is shown <strong>once</strong>. Copy it now — it is not stored in plaintext.
</div>
<p>Username: <code>${escapeHtml(options.username)}</code></p>
<p>Password: <code>${escapeHtml(options.plaintextPassword)}</code></p>
<p class="muted">The password is stored as an <code>argon2id</code> hash. The plaintext is dropped on the floor after this page is rendered.</p>
`;
  return renderLayout({ title: "Agent created", body, csrfToken: options.csrfToken });
}

/** Render the clients list. */
export function renderClientsList(options: {
  clients: ClientRecord[];
  csrfToken: string;
}): string {
  const rows =
    options.clients.length === 0
      ? `<tr><td colspan="5" class="muted">No clients yet.</td></tr>`
      : options.clients
          .map(
            (c) => `
<tr>
  <td><code>${escapeHtml(c.clientId)}</code></td>
  <td>${escapeHtml(c.label)}</td>
  <td>${escapeHtml(formatDate(c.createdAt))}</td>
  <td>${c.lastUsedAt === null ? "<span class=\"muted\">never</span>" : escapeHtml(formatDate(c.lastUsedAt))}</td>
  <td>
    <form action="/admin/clients/${c.id}/rotate" method="POST" style="display:inline">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <button type="submit" class="btn">Rotate secret</button>
    </form>
    <form action="/admin/clients/${c.id}/delete" method="POST" style="display:inline" onsubmit="return confirm('Delete client ${escapeHtml(c.clientId)}?')">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <button type="submit" class="btn btn-danger">Delete</button>
    </form>
  </td>
</tr>`,
          )
          .join("");
  const body = `
<nav>
  <a href="/admin/">Dashboard</a>
  <a href="/admin/agents">Agents</a>
  <a href="/admin/clients">Clients</a>
  <a href="/admin/refresh-tokens">Refresh tokens</a>
  <a href="/admin/audit">Audit log</a>
</nav>
<h1>OAuth clients</h1>
<table>
  <thead><tr><th>clientId</th><th>Label</th><th>Created</th><th>Last used</th><th>Actions</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<h2>Create client</h2>
<form action="/admin/clients/create" method="POST">
  <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
  <p><label>clientId: <input type="text" name="client_id" required pattern="[A-Za-z0-9_.-]+"></label></p>
  <p><label>Label: <input type="text" name="label"></label></p>
  <p><button type="submit" class="btn">Create client</button></p>
</form>
`;
  return renderLayout({ title: "Clients", body, csrfToken: options.csrfToken });
}

/** Render the one-time client secret page. */
export function renderClientCreated(options: {
  clientId: string;
  plaintextSecret: string;
  csrfToken: string;
}): string {
  const body = `
<nav><a href="/admin/clients">Back to clients</a></nav>
<h1>Client created</h1>
<div class="warn">
  <strong>WARN:</strong> The client secret below is shown <strong>once</strong>. Copy it now — it is not stored in plaintext.
</div>
<p>clientId: <code>${escapeHtml(options.clientId)}</code></p>
<p>Secret: <code>${escapeHtml(options.plaintextSecret)}</code></p>
<p class="muted">The secret is stored as an <code>argon2id</code> hash. The plaintext is dropped on the floor after this page is rendered.</p>
`;
  return renderLayout({ title: "Client created", body, csrfToken: options.csrfToken });
}

/** Render the refresh-token revocation list.
 *  PR 4 of `remove-scope-authorization`: the `Scopes`
 *  column is REMOVED. The `RefreshTokenRow.scopes` field
 *  is still read (the DB column is legacy/inert storage)
 *  but the template does not project it onto a column.
 *  Legacy scope values are NOT rendered on this page. */
export function renderRefreshTokensList(options: {
  rows: RefreshTokenView[];
  csrfToken: string;
}): string {
  const rowsHtml = options.rows.length === 0
    ? `<tr><td colspan="5" class="muted">No refresh tokens.</td></tr>`
    : options.rows
        .map(
          (r) => {
            const isRevoked = r.revokedAt !== null;
            const status = isRevoked
              ? `<strong>revoked</strong> at ${escapeHtml(formatDate(r.revokedAt!))}`
              : "active";
            const action = isRevoked
              ? ""
              : `<form action="/admin/refresh-tokens/${r.id}/revoke" method="POST" style="display:inline" onsubmit="return confirm('Revoke this refresh token?')">
                  <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
                  <button type="submit" class="btn btn-danger">Revoke</button>
                </form>`;
            return `
<tr>
  <td>${escapeHtml(r.agentUsername)}</td>
  <td><code>${escapeHtml(r.clientId)}</code></td>
  <td>${escapeHtml(formatDate(r.issuedAt))}</td>
  <td>${status}</td>
  <td>${action}</td>
</tr>`;
          },
        )
        .join("");
  const body = `
<nav>
  <a href="/admin/">Dashboard</a>
  <a href="/admin/agents">Agents</a>
  <a href="/admin/clients">Clients</a>
  <a href="/admin/refresh-tokens">Refresh tokens</a>
  <a href="/admin/audit">Audit log</a>
</nav>
<h1>Refresh tokens</h1>
<table>
  <thead><tr><th>Agent</th><th>Client</th><th>Issued</th><th>Status</th><th>Actions</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
`;
  return renderLayout({ title: "Refresh tokens", body, csrfToken: options.csrfToken });
}

/** Render the audit log viewer. */
export function renderAuditList(options: {
  rows: AuditRowView[];
  total: number;
  page: number;
  pageSize: number;
  csrfToken: string;
  filter?: { actor?: string; action?: string; fromTs?: number; toTs?: number };
}): string {
  const totalPages = Math.max(1, Math.ceil(options.total / options.pageSize));
  const rowsHtml =
    options.rows.length === 0
      ? `<tr><td colspan="6" class="muted">No audit rows match the filter.</td></tr>`
      : options.rows
          .map(
            (r) => `
<tr>
  <td>${escapeHtml(formatDate(r.ts))}</td>
  <td>${escapeHtml(r.actor)}</td>
  <td>${escapeHtml(r.action)}</td>
  <td>${r.target === null ? "<span class=\"muted\">&mdash;</span>" : escapeHtml(redactAuditValue(r.target) ?? "")}</td>
  <td>${r.ip === null ? "<span class=\"muted\">&mdash;</span>" : escapeHtml(redactAuditValue(r.ip) ?? "")}</td>
  <td>${escapeHtml(r.outcome)}</td>
</tr>`,
          )
          .join("");
  // Pagination links (preserve the filter).
  const baseQuery: string[] = [];
  if (options.filter?.actor) baseQuery.push(`actor=${encodeURIComponent(options.filter.actor)}`);
  if (options.filter?.action) baseQuery.push(`action=${encodeURIComponent(options.filter.action)}`);
  const baseQ = baseQuery.length === 0 ? "" : `&${baseQuery.join("&")}`;
  const linkFor = (p: number) => `/admin/audit?page=${p}${baseQ}`;
  const prev = options.page > 1 ? `<a href="${escapeHtml(linkFor(options.page - 1))}">&laquo; prev</a>` : "";
  const next = options.page < totalPages ? `<a href="${escapeHtml(linkFor(options.page + 1))}">next &raquo;</a>` : "";
  const filterActor = options.filter?.actor ?? "";
  const filterAction = options.filter?.action ?? "";
  const body = `
<nav>
  <a href="/admin/">Dashboard</a>
  <a href="/admin/agents">Agents</a>
  <a href="/admin/clients">Clients</a>
  <a href="/admin/refresh-tokens">Refresh tokens</a>
  <a href="/admin/audit">Audit log</a>
</nav>
<h1>Audit log</h1>
<form action="/admin/audit" method="GET">
  <p>
    <label>Actor: <input type="text" name="actor" value="${escapeHtml(filterActor)}"></label>
    <label>Action: <input type="text" name="action" value="${escapeHtml(filterAction)}"></label>
    <button type="submit" class="btn">Filter</button>
  </p>
</form>
<p class="muted">${escapeHtml(String(options.total))} total rows. Page ${escapeHtml(String(options.page))} of ${escapeHtml(String(totalPages))}.</p>
<table>
  <thead><tr><th>ts</th><th>actor</th><th>action</th><th>target</th><th>ip</th><th>outcome</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
<p>${prev} ${next}</p>
`;
  return renderLayout({ title: "Audit log", body, csrfToken: options.csrfToken });
}

/** Render a generic error page. */
export function renderErrorPage(options: {
  status: number;
  message: string;
  csrfToken: string | null;
}): string {
  const body = `
<h1>${escapeHtml(String(options.status))}</h1>
<div class="error">${escapeHtml(options.message)}</div>
<p><a href="/admin/">Back to dashboard</a></p>
`;
  return renderLayout({ title: `Error ${options.status}`, body, csrfToken: options.csrfToken });
}

function formatDate(epochSeconds: number): string {
  // ISO-8601 with seconds. UTC to keep the format
  // deterministic across deployments.
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
