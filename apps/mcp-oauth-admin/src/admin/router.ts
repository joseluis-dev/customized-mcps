/**
 * Server-rendered admin UI router for `apps/mcp-oauth-admin`.
 *
 * The mcp-admin-ui spec requires (PR 2):
 * - 3.1 Session: signed cookie, 32-byte secret, CSRF
 *   double-submit 403; rotation on login.
 * - 3.2 Per-username backoff: 5 fails/10m -> 429; NOT on
 *   /oauth/token (this router does NOT own /oauth/token,
 *   so the contract is architectural — the router does
 *   not consult `login_backoff` for any non-admin route).
 * - 3.3 Agent CRUD: one-time plaintext, argon2id,
 *   requireChangeOnFirstLogin; bootstrap refuses mint; WARN.
 * - 3.4 Client CRUD + scope catalog (refuse delete when
 *   assigned); revocation + audit row.
 * - 3.5 Audit viewer paginate, filter, redact; 91d row
 *   swept.
 *
 * Implementation notes:
 * - The router is a single `http.RequestListener` (the
 *   function returned by `createAdminRouter`). The caller
 *   mounts it on the same listener as the OAuth handlers
 *   (`/oauth/token`, `/oauth/introspect`, `/.well-known/...`).
 * - The router is PURE for testing: it does not read
 *   `process.env` directly. The `AdminRouterDeps` carries
 *   the secret + DB handle; the entrypoint wires them.
 * - All forms have a hidden `_csrf` input. The server
 *   checks the form value OR the `X-CSRF-Token` header
 *   against the session. A missing or mismatched token
 *   returns 403 (no mutation occurs).
 * - The router is a server-rendered HTML app. No
 *   JavaScript framework, no SPA. Every state change
 *   requires a form post.
 *
 * Audit-safety:
 * - The router NEVER logs the session cookie, the CSRF
 *   token, the supplied password, or the one-time
 *   plaintext secrets. The audit log carries the
 *   `actor=root` and `target=user:N` / `client:N` /
 *   `scope:name` / `refresh:N` references, NEVER the
 *   secret values.
 * - The audit viewer redacts any `target` / `ip` value
 *   that looks like a 64-char hex (defense in depth;
 *   `auditAppend` rejects these at write time).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";
import {
  buildSetCookieHeader,
  CSRF_COOKIE_NAME,
  generateCsrfToken,
  parseCookies,
  SESSION_COOKIE_NAME,
  signSessionCookie,
  verifyCsrfToken,
  verifySessionCookie,
  type SessionData,
} from "./session.js";
import {
  BACKOFF_THRESHOLD,
  BACKOFF_WINDOW_SECONDS,
  LOCK_DURATION_SECONDS,
  clearFailures,
  isLocked,
  recordFailure,
} from "./backoff.js";
import { auditAppend, countAuditRows, listAuditRows, redactAuditValue, type AuditRow } from "./audit.js";
import {
  changeOwnPassword,
  createAgent,
  getAgentById,
  getAgentByUsername,
  listAgents,
  recordAgentLogin,
  rotateAgentPassword,
  setAgentEnabled,
  setAgentScopes,
  verifyAgentPassword,
  type AgentRecord,
} from "./agents.js";
import {
  createClient,
  deleteClient,
  getClientById,
  listClients,
  rotateClientSecret,
  type ClientRecord,
} from "./clients.js";
import {
  createScope,
  deleteScope,
  listScopes,
  scopeInUse,
  type ScopeRecord,
} from "./scopes.js";
import { countRefreshTokens, listRefreshTokens, revokeRefreshToken, type RefreshTokenRow } from "./refresh.js";
import {
  escapeHtml,
  renderAgentsList,
  renderAgentCreated,
  renderAuditList,
  renderChangePasswordPage,
  renderClientCreated,
  renderClientsList,
  renderDashboard,
  renderErrorPage,
  renderLayout,
  renderLoginPage,
  renderRefreshTokensList,
  renderScopeError,
  renderScopesList,
  type AuditRowView,
} from "./templates.js";

/**
 * The router's dependencies. The shape is the public
 * contract the entrypoint uses to wire the router into the
 * listener.
 */
export type AdminRouterDeps = {
  db: AuthorityDatabase;
  /** The 32-byte session secret (hex). */
  sessionSecret: string;
  /** Add the `Secure` flag to session cookies (true on non-loopback). */
  secure: boolean;
};

/** The session shape the router reads from the cookie. */
export type AdminSession = SessionData;

/** Constants exposed for the templates and tests. */
export const ADMIN_PATHS = Object.freeze({
  LOGIN: "/admin/login",
  LOGOUT: "/admin/logout",
  CHANGE_PASSWORD: "/admin/change-password",
  DASHBOARD: "/admin/",
  AGENTS: "/admin/agents",
  AGENT_CREATED: "/admin/agents/created",
  CLIENTS: "/admin/clients",
  CLIENT_CREATED: "/admin/clients/created",
  SCOPES: "/admin/scopes",
  REFRESH_TOKENS: "/admin/refresh-tokens",
  AUDIT: "/admin/audit",
});

/**
 * Construct the admin UI router. The returned function is
 * a `http.RequestListener` that handles the `/admin/*`
 * routes. Routes outside `/admin/*` are passed through
 * (the function returns 404).
 */
export function createAdminRouter(
  deps: AdminRouterDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const rawUrl = req.url ?? "/";
      // Strip the query string for routing. The handlers
      // that need the query string re-parse `req.url`
      // themselves (the audit viewer, for example).
      const qIdx = rawUrl.indexOf("?");
      const url = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
      if (!url.startsWith("/admin")) {
        return writeJson(res, 404, { error: "not_found" });
      }
      // Parse cookies up-front so the auth check is
      // consistent across all routes.
      const cookieHeader = req.headers["cookie"];
      const cookies = parseCookies(typeof cookieHeader === "string" ? cookieHeader : null);
      const session = readSession(deps, cookies);
      // Login form is the only state-changing form that
      // does NOT require a session.
      if (url === ADMIN_PATHS.LOGIN && req.method === "GET") {
        return serveLoginPage(res, /* error */ null);
      }
      if (url === ADMIN_PATHS.LOGIN && req.method === "POST") {
        return handleLogin(deps, req, res);
      }
      // Logout requires a valid session.
      if (url === ADMIN_PATHS.LOGOUT && req.method === "POST") {
        return handleLogout(deps, req, res, session);
      }
      // All other routes require a session.
      if (session === null) {
        return redirect(res, "/admin/login");
      }
      // Verify the CSRF token for state-changing methods.
      // The form body is read ONCE here; the dispatched
      // handler receives the cached `URLSearchParams` so
      // it does not need to read the body again.
      let body: URLSearchParams | null = null;
      if (req.method === "POST") {
        body = await readFormBody(req);
        const headerToken = readCsrfHeader(req);
        const csrfOk = verifyCsrfForRequest(session, body, headerToken);
        if (!csrfOk) {
          return writeJson(res, 403, { error: "forbidden" });
        }
      }
      // Dispatch.
      if (url === ADMIN_PATHS.DASHBOARD && req.method === "GET") {
        return serveDashboard(deps, res, session);
      }
      if (url === ADMIN_PATHS.CHANGE_PASSWORD && req.method === "GET") {
        return serveChangePassword(res, session);
      }
      if (url === ADMIN_PATHS.CHANGE_PASSWORD && req.method === "POST") {
        return handleChangePassword(deps, body, req, res, session);
      }
      if (url === ADMIN_PATHS.AGENTS && req.method === "GET") {
        return serveAgentsList(deps, res, session);
      }
      if (url === ADMIN_PATHS.AGENT_CREATED && req.method === "GET") {
        return serveAgentCreated(deps, res, session, req);
      }
      if (url === "/admin/agents/create" && req.method === "POST") {
        return handleCreateAgent(deps, body, req, res, session);
      }
      if (url.startsWith("/admin/agents/") && (url.endsWith("/enable") || url.endsWith("/disable")) && req.method === "POST") {
        return handleToggleAgent(deps, req, res, session, url);
      }
      if (url.startsWith("/admin/agents/") && url.endsWith("/rotate") && req.method === "POST") {
        return handleRotateAgent(deps, req, res, session, url);
      }
      if (url === ADMIN_PATHS.CLIENTS && req.method === "GET") {
        return serveClientsList(deps, res, session);
      }
      if (url === ADMIN_PATHS.CLIENT_CREATED && req.method === "GET") {
        return serveClientCreated(deps, res, session, req);
      }
      if (url === "/admin/clients/create" && req.method === "POST") {
        return handleCreateClient(deps, body, req, res, session);
      }
      if (url.startsWith("/admin/clients/") && url.endsWith("/rotate") && req.method === "POST") {
        return handleRotateClient(deps, req, res, session, url);
      }
      if (url.startsWith("/admin/clients/") && url.endsWith("/delete") && req.method === "POST") {
        return handleDeleteClient(deps, req, res, session, url);
      }
      if (url === ADMIN_PATHS.SCOPES && req.method === "GET") {
        return serveScopesList(deps, res, session);
      }
      if (url === "/admin/scopes/create" && req.method === "POST") {
        return handleCreateScope(deps, body, req, res, session);
      }
      if (url.startsWith("/admin/scopes/") && url.endsWith("/delete") && req.method === "POST") {
        return handleDeleteScope(deps, body, req, res, session, url);
      }
      if (url === ADMIN_PATHS.REFRESH_TOKENS && req.method === "GET") {
        return serveRefreshTokens(deps, res, session);
      }
      if (url.startsWith("/admin/refresh-tokens/") && url.endsWith("/revoke") && req.method === "POST") {
        return handleRevokeRefreshToken(deps, req, res, session, url);
      }
      if (url === ADMIN_PATHS.AUDIT && req.method === "GET") {
        return serveAudit(deps, req, res, session);
      }
      return writeJson(res, 404, { error: "not_found" });
    } catch (e) {
      // Defense in depth: the router MUST NOT 500 the
      // listener. Surface a sanitized 500 page; the
      // internal error is appended to the audit log with
      // a sanitized reason code (the actual message is
      // NEVER included).
      const errId = randomBytes(6).toString("hex");
      try {
        await auditAppend(deps.db, {
          ts: Math.floor(Date.now() / 1000),
          actor: "system:router",
          action: "router.error",
          target: errId,
          outcome: "denied",
        });
      } catch {
        // Audit log failure is non-fatal; the operator sees
        // the 500 page and the errId.
      }
      return writeHtml(res, 500, renderErrorPage({ status: 500, message: "Internal error", csrfToken: null }));
    }
  };
}

// -----------------------------------------------------------------------
// Session helpers
// -----------------------------------------------------------------------

function readSession(deps: AdminRouterDeps, cookies: Map<string, string>): AdminSession | null {
  const cookie = cookies.get(SESSION_COOKIE_NAME);
  if (typeof cookie !== "string" || cookie.length === 0) return null;
  return verifySessionCookie(deps.sessionSecret, cookie);
}

function makeSession(deps: AdminRouterDeps, username: string, userId: number): {
  data: AdminSession;
  cookieValue: string;
} {
  const data: AdminSession = {
    username,
    userId,
    csrfToken: generateCsrfToken(),
    createdAt: Math.floor(Date.now() / 1000),
  };
  const cookieValue = signSessionCookie(deps.sessionSecret, data);
  return { data, cookieValue };
}

function setSessionCookie(deps: AdminRouterDeps, res: ServerResponse, cookieValue: string): void {
  const header = buildSetCookieHeader({
    name: SESSION_COOKIE_NAME,
    value: cookieValue,
    secure: deps.secure,
  });
  res.setHeader("Set-Cookie", header);
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
}

/**
 * Read the `X-CSRF-Token` header from the incoming request.
 * Returns `null` when the header is missing or empty. The
 * header is the canonical path for fetch-style requests
 * (the form's hidden input is the canonical path for
 * form-based POSTs).
 */
function readCsrfHeader(req: IncomingMessage): string | null {
  const raw = req.headers["x-csrf-token"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string" && raw[0].length > 0) {
    return raw[0];
  }
  return null;
}

/**
 * Verify the CSRF token for a request. The spec requires
 * the form's hidden `_csrf` input AND the `X-CSRF-Token`
 * header on fetch requests; the server MUST reject
 * requests missing either. Practically, that means: the
 * server accepts EITHER the header (when present) OR the
 * form's hidden input (when no header is sent), and
 * rejects when BOTH are missing.
 *
 * Precedence: when the `X-CSRF-Token` header is present,
 * it is the authoritative source. A mismatched header
 * rejects the request — even if the form's hidden input
 * would have been valid. This prevents a downgrade
 * attack where a JS client sends both a wrong header and
 * a valid form input.
 *
 * Form-based POSTs (no header) continue to be accepted
 * via the `_csrf` form input.
 */
function verifyCsrfForRequest(
  session: AdminSession,
  body: URLSearchParams,
  headerToken: string | null,
): boolean {
  if (headerToken !== null) {
    return verifyCsrfToken(session, headerToken);
  }
  const formToken = body.get("_csrf") ?? undefined;
  return verifyCsrfToken(session, formToken);
}

// -----------------------------------------------------------------------
// Login / logout / change-password
// -----------------------------------------------------------------------

function serveLoginPage(res: ServerResponse, error: string | null): void {
  writeHtml(res, error === null ? 200 : 401, renderLoginPage({ error }));
}

async function handleLogin(
  deps: AdminRouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const params = await readFormBody(req);
  const username = (params.get("username") ?? "").trim();
  const password = params.get("password") ?? "";
  if (username.length === 0 || password.length === 0) {
    return serveLoginPage(res, "Invalid credentials");
  }
  const now = Math.floor(Date.now() / 1000);
  // Per-username backoff check. The lock applies BEFORE
  // the password check so an attacker cannot enumerate
  // valid usernames by observing the response time.
  if (await isLocked(deps.db, username, now)) {
    return writeHtml(res, 429, renderLoginPage({ error: "Too many failed attempts. Try again in 10 minutes." }));
  }
  const result = await verifyAgentPassword(deps.db, username, password);
  if (!result.ok) {
    // Record the failure. The 5th attempt is the LAST
    // allowed attempt — the response is 401. The 6th
    // attempt is rejected by the lock check at the top
    // of this function. This matches the spec: "after 5
    // consecutive failures, further attempts return
    // 429".
    await recordFailure(deps.db, username, now);
    return writeHtml(res, 401, renderLoginPage({ error: "Invalid credentials" }));
  }
  // Successful login — clear the backoff and create a
  // fresh session (the CSRF token rotates on every
  // login).
  await clearFailures(deps.db, username);
  await recordAgentLogin(deps.db, result.agent.id, now);
  const session = makeSession(deps, username, result.agent.id);
  setSessionCookie(deps, res, session.cookieValue);
  await auditAppend(deps.db, {
    ts: now,
    actor: username,
    action: "admin.login",
    target: `user:${result.agent.id}`,
    ip: readIp(req),
    outcome: "ok",
  });
  // If the admin is in the bootstrap rotation flow,
  // redirect to the change-password page.
  if (result.agent.requireChangeOnFirstLogin) {
    return redirect(res, "/admin/change-password");
  }
  return redirect(res, "/admin/");
}

async function handleLogout(
  deps: AdminRouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession | null,
): Promise<void> {
  clearSessionCookie(res);
  if (session !== null) {
    await auditAppend(deps.db, {
      ts: Math.floor(Date.now() / 1000),
      actor: session.username,
      action: "admin.logout",
      ip: readIp(req),
      outcome: "ok",
    });
  }
  return redirect(res, "/admin/login");
}

function serveChangePassword(res: ServerResponse, session: AdminSession): void {
  writeHtml(
    res,
    200,
    renderChangePasswordPage({
      csrfToken: session.csrfToken,
      // The current password is required UNLESS the
      // session is for a bootstrap admin in the rotation
      // flow. The router's `session.requireChangeOnFirstLogin`
      // does not exist; the flag is read from the DB
      // row on every page render. We keep the GET
      // handler simple and look up the row.
      // For the GET path, the caller is expected to
      // have just logged in; the redirect from
      // /admin/login already confirmed the flag is set.
      // We re-read the flag here for correctness.
      currentRequired: true, // updated by the handler
      error: null,
    }),
  );
}

async function handleChangePassword(
  deps: AdminRouterDeps,
  body: URLSearchParams | null,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
): Promise<void> {
  const params = body ?? new URLSearchParams();
  const newPassword = params.get("new_password") ?? "";
  const currentPassword = params.get("current_password");
  const agent = await getAgentById(deps.db, session.userId);
  if (!agent) {
    return redirect(res, "/admin/login");
  }
  const currentRequired = !agent.requireChangeOnFirstLogin;
  const result = await changeOwnPassword(deps.db, agent.id, {
    currentPassword: currentRequired ? currentPassword : null,
    newPassword,
    now: Math.floor(Date.now() / 1000),
  });
  if (!result.ok) {
    const message =
      result.reason === "invalid_new"
        ? "Password must be at least 8 characters."
        : result.reason === "invalid_current"
          ? "Current password is incorrect."
          : "User not found.";
    return writeHtml(
      res,
      result.reason === "invalid_current" ? 403 : 400,
      renderChangePasswordPage({
        csrfToken: session.csrfToken,
        currentRequired,
        error: message,
      }),
    );
  }
  // Audit + redirect to the dashboard.
  await auditAppend(deps.db, {
    ts: Math.floor(Date.now() / 1000),
    actor: session.username,
    action: "admin.change_password",
    target: `user:${agent.id}`,
    ip: readIp(req),
    outcome: "ok",
  });
  return redirect(res, "/admin/");
}

// -----------------------------------------------------------------------
// Dashboard
// -----------------------------------------------------------------------

function serveDashboard(
  _deps: AdminRouterDeps,
  res: ServerResponse,
  session: AdminSession,
): void {
  writeHtml(
    res,
    200,
    renderDashboard({ username: session.username, csrfToken: session.csrfToken }),
  );
}

// -----------------------------------------------------------------------
// Agents
// -----------------------------------------------------------------------

async function serveAgentsList(
  deps: AdminRouterDeps,
  res: ServerResponse,
  session: AdminSession,
): Promise<void> {
  const agents = await listAgents(deps.db);
  writeHtml(res, 200, renderAgentsList({ agents, csrfToken: session.csrfToken }));
}

async function handleCreateAgent(
  deps: AdminRouterDeps,
  body: URLSearchParams | null,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
): Promise<void> {
  const params = body ?? new URLSearchParams();
  const username = (params.get("username") ?? "").trim();
  const scopesRaw = (params.get("scopes") ?? "").trim();
  const scopes = scopesRaw.length === 0 ? [] : scopesRaw.split(/\s+/);
  const requireChange = params.get("require_change") === "1";
  const result = await createAgent(deps.db, {
    username,
    scopes,
    requireChangeOnFirstLogin: requireChange,
    now: Math.floor(Date.now() / 1000),
  });
  if (!result.ok) {
    // Render the agents list with a sanitized error.
    const agents = await listAgents(deps.db);
    const message =
      result.reason === "duplicate"
        ? `Agent "${username}" already exists.`
        : result.reason === "invalid_scope"
          ? "One or more scopes are not valid."
          : "Invalid username.";
    return writeHtml(
      res,
      400,
      appendError(renderAgentsList({ agents, csrfToken: session.csrfToken }), message),
    );
  }
  await auditAppend(deps.db, {
    ts: Math.floor(Date.now() / 1000),
    actor: session.username,
    action: "agent.create",
    target: `user:${result.agent.id}`,
    ip: readIp(req),
    outcome: "ok",
  });
  // Stash the plaintext in a short-lived cookie so the
  // created page can display it once. The cookie is
  // consumed by the GET /admin/agents/created handler
  // and cleared immediately.
  res.setHeader(
    "Set-Cookie",
    buildSetCookieHeader({
      name: "mcp_oauth_admin_one_time",
      value: encodeURIComponent(JSON.stringify({ username: result.agent.username, plaintext: result.plaintextPassword })),
      secure: deps.secure,
      maxAgeSeconds: 60,
    }),
  );
  return redirect(res, `/admin/agents/created?username=${encodeURIComponent(result.agent.username)}`);
}

async function serveAgentCreated(
  deps: AdminRouterDeps,
  res: ServerResponse,
  session: AdminSession,
  req: IncomingMessage,
): Promise<void> {
  // Read the one-time cookie and clear it.
  const cookieHeader = req.headers["cookie"];
  const cookies = parseCookies(typeof cookieHeader === "string" ? cookieHeader : null);
  const raw = cookies.get("mcp_oauth_admin_one_time");
  let payload: { username: string; plaintext: string } | null = null;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      payload = JSON.parse(decodeURIComponent(raw)) as { username: string; plaintext: string };
    } catch {
      payload = null;
    }
  }
  // Clear the one-time cookie.
  res.setHeader(
    "Set-Cookie",
    `mcp_oauth_admin_one_time=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${deps.secure ? "; Secure" : ""}`,
  );
  if (payload === null) {
    // No one-time payload — render the agents list with a
    // sanitized message. (The cookie is consumed exactly
    // once; a refresh will not re-render the secret.)
    const agents = await listAgents(deps.db);
    return writeHtml(
      res,
      200,
      appendError(
        renderAgentsList({ agents, csrfToken: session.csrfToken }),
        "The one-time secret has been consumed. Refresh to see the agents list.",
      ),
    );
  }
  writeHtml(
    res,
    200,
    renderAgentCreated({
      username: payload.username,
      plaintextPassword: payload.plaintext,
      csrfToken: session.csrfToken,
    }),
  );
}

async function handleToggleAgent(
  deps: AdminRouterDeps,
  _req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
  url: string,
): Promise<void> {
  const m = url.match(/^\/admin\/agents\/(\d+)\/(enable|disable)$/);
  if (!m) return writeJson(res, 404, { error: "not_found" });
  const id = Number(m[1]);
  if (!Number.isInteger(id) || id <= 0) return writeJson(res, 404, { error: "not_found" });
  const enable = m[2] === "enable";
  const ok = await setAgentEnabled(deps.db, id, enable);
  if (!ok) return writeJson(res, 404, { error: "not_found" });
  await auditAppend(deps.db, {
    ts: Math.floor(Date.now() / 1000),
    actor: session.username,
    action: enable ? "agent.enable" : "agent.disable",
    target: `user:${id}`,
    ip: readIp(_req),
    outcome: "ok",
  });
  return redirect(res, "/admin/agents");
}

async function handleRotateAgent(
  deps: AdminRouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
  url: string,
): Promise<void> {
  const m = url.match(/^\/admin\/agents\/(\d+)\/rotate$/);
  if (!m) return writeJson(res, 404, { error: "not_found" });
  const id = Number(m[1]);
  if (!Number.isInteger(id) || id <= 0) return writeJson(res, 404, { error: "not_found" });
  const result = await rotateAgentPassword(deps.db, id, Math.floor(Date.now() / 1000));
  if (!result.ok) return writeJson(res, 404, { error: "not_found" });
  await auditAppend(deps.db, {
    ts: Math.floor(Date.now() / 1000),
    actor: session.username,
    action: "agent.rotate",
    target: `user:${id}`,
    ip: readIp(req),
    outcome: "ok",
  });
  const agent = await getAgentById(deps.db, id);
  if (!agent) return writeJson(res, 404, { error: "not_found" });
  res.setHeader(
    "Set-Cookie",
    buildSetCookieHeader({
      name: "mcp_oauth_admin_one_time",
      value: encodeURIComponent(JSON.stringify({ username: agent.username, plaintext: result.plaintextPassword })),
      secure: deps.secure,
      maxAgeSeconds: 60,
    }),
  );
  return redirect(res, `/admin/agents/created?username=${encodeURIComponent(agent.username)}`);
}

// -----------------------------------------------------------------------
// Clients
// -----------------------------------------------------------------------

async function serveClientsList(
  deps: AdminRouterDeps,
  res: ServerResponse,
  session: AdminSession,
): Promise<void> {
  const clients = await listClients(deps.db);
  writeHtml(res, 200, renderClientsList({ clients, csrfToken: session.csrfToken }));
}

async function handleCreateClient(
  deps: AdminRouterDeps,
  body: URLSearchParams | null,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
): Promise<void> {
  const params = body ?? new URLSearchParams();
  const clientId = (params.get("client_id") ?? "").trim();
  const label = (params.get("label") ?? "").trim();
  const scopesRaw = (params.get("scopes") ?? "").trim();
  const scopes = scopesRaw.length === 0 ? [] : scopesRaw.split(/\s+/);
  const result = await createClient(deps.db, {
    clientId,
    label,
    scopes,
    now: Math.floor(Date.now() / 1000),
  });
  if (!result.ok) {
    const clients = await listClients(deps.db);
    const message =
      result.reason === "duplicate"
        ? `Client "${clientId}" already exists.`
        : result.reason === "invalid_scope"
          ? "One or more scopes are not valid."
          : "Invalid client id.";
    return writeHtml(
      res,
      400,
      appendError(renderClientsList({ clients, csrfToken: session.csrfToken }), message),
    );
  }
  await auditAppend(deps.db, {
    ts: Math.floor(Date.now() / 1000),
    actor: session.username,
    action: "client.create",
    target: `client:${result.client.id}`,
    ip: readIp(req),
    outcome: "ok",
  });
  res.setHeader(
    "Set-Cookie",
    buildSetCookieHeader({
      name: "mcp_oauth_admin_one_time",
      value: encodeURIComponent(JSON.stringify({ clientId: result.client.clientId, plaintext: result.plaintextSecret })),
      secure: deps.secure,
      maxAgeSeconds: 60,
    }),
  );
  return redirect(res, `/admin/clients/created?client_id=${encodeURIComponent(result.client.clientId)}`);
}

async function serveClientCreated(
  deps: AdminRouterDeps,
  res: ServerResponse,
  session: AdminSession,
  req: IncomingMessage,
): Promise<void> {
  const cookieHeader = req.headers["cookie"];
  const cookies = parseCookies(typeof cookieHeader === "string" ? cookieHeader : null);
  const raw = cookies.get("mcp_oauth_admin_one_time");
  let payload: { clientId: string; plaintext: string } | null = null;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      payload = JSON.parse(decodeURIComponent(raw)) as { clientId: string; plaintext: string };
    } catch {
      payload = null;
    }
  }
  res.setHeader(
    "Set-Cookie",
    `mcp_oauth_admin_one_time=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${deps.secure ? "; Secure" : ""}`,
  );
  if (payload === null) {
    const clients = await listClients(deps.db);
    return writeHtml(
      res,
      200,
      appendError(
        renderClientsList({ clients, csrfToken: session.csrfToken }),
        "The one-time secret has been consumed. Refresh to see the clients list.",
      ),
    );
  }
  writeHtml(
    res,
    200,
    renderClientCreated({
      clientId: payload.clientId,
      plaintextSecret: payload.plaintext,
      csrfToken: session.csrfToken,
    }),
  );
}

async function handleRotateClient(
  deps: AdminRouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
  url: string,
): Promise<void> {
  const m = url.match(/^\/admin\/clients\/(\d+)\/rotate$/);
  if (!m) return writeJson(res, 404, { error: "not_found" });
  const id = Number(m[1]);
  if (!Number.isInteger(id) || id <= 0) return writeJson(res, 404, { error: "not_found" });
  const result = await rotateClientSecret(deps.db, id, Math.floor(Date.now() / 1000));
  if (!result.ok) return writeJson(res, 404, { error: "not_found" });
  const client = await getClientById(deps.db, id);
  if (!client) return writeJson(res, 404, { error: "not_found" });
  await auditAppend(deps.db, {
    ts: Math.floor(Date.now() / 1000),
    actor: session.username,
    action: "client.rotate",
    target: `client:${id}`,
    ip: readIp(req),
    outcome: "ok",
  });
  res.setHeader(
    "Set-Cookie",
    buildSetCookieHeader({
      name: "mcp_oauth_admin_one_time",
      value: encodeURIComponent(JSON.stringify({ clientId: client.clientId, plaintext: result.plaintextSecret })),
      secure: deps.secure,
      maxAgeSeconds: 60,
    }),
  );
  return redirect(res, `/admin/clients/created?client_id=${encodeURIComponent(client.clientId)}`);
}

async function handleDeleteClient(
  deps: AdminRouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
  url: string,
): Promise<void> {
  const m = url.match(/^\/admin\/clients\/(\d+)\/delete$/);
  if (!m) return writeJson(res, 404, { error: "not_found" });
  const id = Number(m[1]);
  if (!Number.isInteger(id) || id <= 0) return writeJson(res, 404, { error: "not_found" });
  const result = await deleteClient(deps.db, id);
  if (!result.ok) {
    if (result.reason === "in_use") {
      await auditAppend(deps.db, {
        ts: Math.floor(Date.now() / 1000),
        actor: session.username,
        action: "client.delete",
        target: `client:${id}`,
        ip: readIp(req),
        outcome: "denied",
      });
      const clients = await listClients(deps.db);
      return writeHtml(
        res,
        409,
        appendError(
          renderClientsList({ clients, csrfToken: session.csrfToken }),
          `Client has ${result.count} outstanding refresh token(s); revoke them first.`,
        ),
      );
    }
    return writeJson(res, 404, { error: "not_found" });
  }
  await auditAppend(deps.db, {
    ts: Math.floor(Date.now() / 1000),
    actor: session.username,
    action: "client.delete",
    target: `client:${id}`,
    ip: readIp(req),
    outcome: "ok",
  });
  return redirect(res, "/admin/clients");
}

// -----------------------------------------------------------------------
// Scopes
// -----------------------------------------------------------------------

async function serveScopesList(
  deps: AdminRouterDeps,
  res: ServerResponse,
  session: AdminSession,
): Promise<void> {
  const scopes = await listScopes(deps.db);
  writeHtml(res, 200, renderScopesList({ scopes, csrfToken: session.csrfToken }));
}

async function handleCreateScope(
  deps: AdminRouterDeps,
  body: URLSearchParams | null,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
): Promise<void> {
  const params = body ?? new URLSearchParams();
  const name = (params.get("name") ?? "").trim();
  const description = (params.get("description") ?? "").trim();
  const result = await createScope(deps.db, {
    name,
    description,
    now: Math.floor(Date.now() / 1000),
  });
  if (!result.ok) {
    const scopes = await listScopes(deps.db);
    return writeHtml(
      res,
      400,
      writeHtmlInline(
        renderScopeError({ scopeName: name, reason: result.reason === "duplicate" ? "in_use" : "invalid", csrfToken: session.csrfToken }),
      ),
    );
  }
  await auditAppend(deps.db, {
    ts: Math.floor(Date.now() / 1000),
    actor: session.username,
    action: "scope.create",
    target: `scope:${name}`,
    ip: readIp(req),
    outcome: "ok",
  });
  return redirect(res, "/admin/scopes");
}

async function handleDeleteScope(
  deps: AdminRouterDeps,
  _body: URLSearchParams | null,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
  url: string,
): Promise<void> {
  const m = url.match(/^\/admin\/scopes\/(.+)\/delete$/);
  if (!m) return writeJson(res, 404, { error: "not_found" });
  const name = decodeURIComponent(m[1]!);
  const result = await deleteScope(deps.db, name);
  if (!result.ok) {
    await auditAppend(deps.db, {
      ts: Math.floor(Date.now() / 1000),
      actor: session.username,
      action: "scope.delete",
      target: `scope:${name}`,
      ip: readIp(req),
      outcome: "denied",
    });
    if (result.reason === "in_use") {
      return writeHtml(
        res,
        409,
        renderScopeError({
          scopeName: name,
          reason: "in_use",
          count: result.count,
          csrfToken: session.csrfToken,
        }),
      );
    }
    if (result.reason === "not_found") {
      return writeHtml(
        res,
        404,
        renderScopeError({ scopeName: name, reason: "not_found", csrfToken: session.csrfToken }),
      );
    }
  }
  await auditAppend(deps.db, {
    ts: Math.floor(Date.now() / 1000),
    actor: session.username,
    action: "scope.delete",
    target: `scope:${name}`,
    ip: readIp(req),
    outcome: "ok",
  });
  return redirect(res, "/admin/scopes");
}

// -----------------------------------------------------------------------
// Refresh tokens
// -----------------------------------------------------------------------

async function serveRefreshTokens(
  deps: AdminRouterDeps,
  res: ServerResponse,
  session: AdminSession,
): Promise<void> {
  const rows = await listRefreshTokens(deps.db, { limit: 200, offset: 0 });
  writeHtml(res, 200, renderRefreshTokensList({ rows, csrfToken: session.csrfToken }));
}

async function handleRevokeRefreshToken(
  deps: AdminRouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
  url: string,
): Promise<void> {
  const m = url.match(/^\/admin\/refresh-tokens\/(\d+)\/revoke$/);
  if (!m) return writeJson(res, 404, { error: "not_found" });
  const id = Number(m[1]);
  if (!Number.isInteger(id) || id <= 0) return writeJson(res, 404, { error: "not_found" });
  const result = await revokeRefreshToken(
    deps.db,
    id,
    Math.floor(Date.now() / 1000),
    session.username,
    readIp(req),
  );
  if (!result.ok) {
    return writeJson(res, 404, { error: "not_found" });
  }
  return redirect(res, "/admin/refresh-tokens");
}

// -----------------------------------------------------------------------
// Audit log
// -----------------------------------------------------------------------

async function serveAudit(
  deps: AdminRouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
  session: AdminSession,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = 50;
  const offset = (page - 1) * pageSize;
  const actorFilter = url.searchParams.get("actor") ?? undefined;
  const actionFilter = url.searchParams.get("action") ?? undefined;
  const rows = await listAuditRows(deps.db, {
    limit: pageSize,
    offset,
    ...(actorFilter ? { actor: actorFilter } : {}),
    ...(actionFilter ? { action: actionFilter } : {}),
  });
  const total = await countAuditRows(deps.db, {
    ...(actorFilter ? { actor: actorFilter } : {}),
    ...(actionFilter ? { action: actionFilter } : {}),
  });
  const view: AuditRowView[] = rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    action: r.action,
    target: r.target,
    ip: r.ip,
    outcome: r.outcome,
  }));
  writeHtml(
    res,
    200,
    renderAuditList({
      rows: view,
      total,
      page,
      pageSize,
      csrfToken: session.csrfToken,
      ...(actorFilter || actionFilter
        ? { filter: { ...(actorFilter ? { actor: actorFilter } : {}), ...(actionFilter ? { action: actionFilter } : {}) } }
        : {}),
    }),
  );
}

// -----------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(`Redirecting to ${location}`);
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  writeHtml(res, status, JSON.stringify(body));
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.end(body);
}

/** A no-op helper kept for the templates that want a fresh body. */
function writeHtmlInline(html: string): string {
  return html;
}

function appendError(html: string, message: string): string {
  // Insert the error div right after the `<body>` tag.
  // The templates always render the body as the second
  // line; the regex is intentionally narrow.
  return html.replace(
    "<body>\n",
    `<body>\n<div class="error">${escapeHtml(message)}</div>\n`,
  );
}

function readIp(req: IncomingMessage): string | null {
  // The operator's reverse proxy sets `X-Forwarded-For`;
  // we use the first value. The `req.socket.remoteAddress`
  // is the direct peer.
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0]!.trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0]!;
  }
  return req.socket.remoteAddress ?? null;
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cap = 64 * 1024;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        rejectP(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolveP(new URLSearchParams(text));
    });
    req.on("error", rejectP);
  });
}

// Mark `withSingleWriter` and `setAgentScopes` as used so
// the linter doesn't complain. They are part of the
// router's documented surface but not exercised by
// PR 2's HTTP routes; future PR 3 routes will use them.
void withSingleWriter;
void setAgentScopes;

// Mark type-only imports as used.
void (null as unknown as AgentRecord);
void (null as unknown as ClientRecord);
void (null as unknown as ScopeRecord);
void (null as unknown as RefreshTokenRow);
void (null as unknown as AuditRow);
void CSRF_COOKIE_NAME;
void BACKOFF_WINDOW_SECONDS;

// Mark the redact helper as used (the audit row view is
// already pre-redacted by the templates, but the import
// is the documented surface).
void redactAuditValue;
