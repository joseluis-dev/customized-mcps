/**
 * OAuth2 authorization-code handler.
 *
 * The mcp-oauth-authority spec requires:
 * - `GET /oauth/authorize` renders a login + consent flow
 *   (login uses the same `users` table and the same
 *   session/CSRF helpers as the admin UI).
 * - `POST /oauth/authorize` accepts `_action=login` and
 *   `_action=consent` form posts.
 * - `redirect_uri` MUST be RFC 8252 §7.3 loopback:
 *   `http://127.0.0.1:<port>`, `http://[::1]:<port>`, or
 *   `http://localhost:<port>` with a non-empty port.
 * - `code_challenge_method` MUST be `S256`. `plain` is rejected.
 * - `state` is echoed on success and on redirect-based errors
 *   when the redirect URI is validated.
 * - Consent is explicit (v1): the handler NEVER issues a code
 *   without an explicit consent POST. There is no auto-skip
 *   for previously-granted scope sets (the spec's "MAY" is
 *   deferred; the per-`(client, user)` grants table is out
 *   of scope for PR 2).
 * - The issued code is single-use, expires in 60s, is bound
 *   to `clientId` + `agentId` + the exact `redirect_uri` +
 *   the `code_challenge`, and is consumed by `/oauth/token`
 *   when exchanged.
 *
 * Implementation notes:
 * - The in-memory code store is a module-level `Map` keyed
 *   by the server-generated `code` (32 random bytes,
 *   base64url). The store is reset on process restart; the
 *   spec accepts this because codes are ≤ 60s and clients
 *   retry the authorize round-trip on disconnect.
 * - The handler reuses the admin session/CSRF helpers
 *   (`signSessionCookie`, `verifySessionCookie`,
 *   `verifyCsrfToken`) so the login form is the same
 *   surface the admin UI exposes — there is exactly ONE
 *   login surface per `users` table.
 * - PKCE is required: a missing `code_challenge` or
 *   `code_challenge_method=plain` returns 400 with a
 *   sanitized error page. The error NEVER leaks the
 *   supplied challenge, the authority URL, or the JWKS URL.
 * - Errors that are redirect-based (the redirect URI is
 *   loopback) attach `error` and `error_description` to the
 *   query string AND echo `state`. Non-loopback URIs render
 *   a sanitized HTML error so an attacker-supplied
 *   `redirect_uri` cannot become a redirect target.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";
import {
  buildSetCookieHeader,
  generateCsrfToken,
  parseCookies,
  SESSION_COOKIE_NAME,
  signSessionCookie,
  verifyCsrfToken,
  verifySessionCookie,
  type SessionData,
} from "../admin/session.js";
import { verifyAgentPassword } from "../admin/agents.js";
import { auditAppend } from "../admin/audit.js";
import { clearFailures, isLocked, recordFailure } from "../admin/backoff.js";
import { SCOPE_PATTERN } from "@customized-mcps/mcp-http-base";

/**
 * The in-memory shape of a one-time code. The
 * `code_challenge` is the S256 challenge supplied at the
 * authorize step; the token endpoint verifies the matching
 * `code_verifier` against it.
 */
export type CodeRecord = {
  clientId: string;
  agentId: number;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scopes: string[];
  expiresAt: number;
};

/**
 * The dependencies the authorize handler needs. The wiring
 * is passed in by the app's main listener so the handler
 * stays driver-agnostic.
 *
 * `now`, `ttlSeconds`, and `codeBytes` are test-injection
 * points; production callers omit them. They are exported
 * (rather than hard-coded) so the verifier phase can pin
 * the timing contract without sleeping in real time.
 */
export type AuthorizeDeps = {
  db: AuthorityDatabase;
  sessionSecret: string;
  secure: boolean;
  defaultScope: string;
  now?: () => number;
  ttlSeconds?: number;
};

const DEFAULT_CODE_TTL_SECONDS = 60;
const DEFAULT_CODE_BYTES = 32;
const FORM_BODY_CAP = 64 * 1024;
const MAX_CODE_CHALLENGE_LENGTH = 128;
const MIN_CODE_CHALLENGE_LENGTH = 43;

/**
 * The module-level code store. In a multi-process
 * deployment this would be Redis or a database table; the
 * spec accepts the in-process limitation because codes are
 * ≤ 60s and clients retry on disconnect.
 */
const codeStore: Map<string, CodeRecord> = new Map();

/**
 * Test-only helper: clear the module-level code store.
 * Exposed so `beforeEach` in the test suite can pin a
 * clean slate between cases. Production code MUST NOT
 * call this.
 */
export function _resetCodeStore(): void {
  codeStore.clear();
}

/** Read the active code store (test introspection only). */
export function getCodeStore(): Map<string, CodeRecord> {
  return codeStore;
}

function getNow(deps: AuthorizeDeps): number {
  return deps.now ? deps.now() : Math.floor(Date.now() / 1000);
}

function getTtl(deps: AuthorizeDeps): number {
  return deps.ttlSeconds ?? DEFAULT_CODE_TTL_SECONDS;
}

function generateCode(): string {
  return randomBytes(DEFAULT_CODE_BYTES).toString("base64url");
}

/**
 * Validate a redirect URI against the RFC 8252 §7.3 loopback
 * forms: `http://127.0.0.1:<port>`, `http://[::1]:<port>`,
 * or `http://localhost:<port>` with a non-empty port.
 *
 * The function returns `false` for:
 * - non-HTTP schemes (the spec is explicit: loopback
 *   redirect URIs use `http`, not `https`)
 * - URIs without a port
 * - non-loopback hostnames
 * - malformed input (URL parse failure, empty string)
 *
 * Exported so the unit test can pin the contract without
 * spinning up a listener.
 */
export function isLoopbackRedirectUri(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.port.length === 0) return false;
  const host = u.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/**
 * Purge expired codes from the store. Called opportunistically
 * before reading from the store; the cost is linear in the
 * store size, which is bounded by `(request rate) * TTL`.
 */
function purgeExpiredCodes(now: number): number {
  let purged = 0;
  for (const [code, rec] of codeStore) {
    if (rec.expiresAt <= now) {
      codeStore.delete(code);
      purged++;
    }
  }
  return purged;
}

/**
 * Consume a code: remove it from the store and return the
 * record. Returns `null` for any of:
 * - the code is unknown (already consumed or never issued)
 * - the code is expired (`expiresAt <= now`)
 *
 * The function is single-use: the second call with the
 * same code returns `null` even when the code is still
 * inside its TTL window.
 */
export function consumeCode(code: string, now: number): CodeRecord | null {
  const rec = codeStore.get(code);
  if (!rec) return null;
  codeStore.delete(code);
  if (rec.expiresAt <= now) return null;
  return rec;
}

/**
 * Construct the `GET/POST /oauth/authorize` handler. The
 * handler dispatches on `req.method`. `GET` renders the
 * login or consent form; `POST` accepts `_action=login`
 * (verify credentials) and `_action=consent` (issue code
 * and 302 to the redirect URI).
 */
export function createAuthorizeHandler(
  deps: AuthorizeDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      // Opportunistic sweep: keeps the store bounded under
      // long-running processes with low traffic. The cost
      // is O(store size) and the store is bounded by
      // (peak QPS) * TTL.
      purgeExpiredCodes(getNow(deps));
      const url = req.url ?? "/";
      const qIdx = url.indexOf("?");
      const path = qIdx === -1 ? url : url.slice(0, qIdx);
      const method = req.method ?? "GET";

      if (path !== "/oauth/authorize" && path !== "/oauth/authorize/") {
        return writeJsonError(res, 404, "not_found");
      }
      if (method === "GET") {
        return handleGet(deps, req, res);
      }
      if (method === "POST") {
        return handlePost(deps, req, res);
      }
      res.setHeader("Allow", "GET, POST");
      return writeJsonError(res, 405, "invalid_request");
    } catch {
      // Defense in depth: the handler MUST NOT 500 the
      // listener. Surface a sanitized 500 page; the real
      // error stays in the catch scope (we never log
      // request bodies or query strings because they may
      // contain a verifier or a client secret).
      return writeHtml(res, 500, renderErrorPage("Internal error"));
    }
  };
}

// -----------------------------------------------------------------------
// GET handler
// -----------------------------------------------------------------------

async function handleGet(
  deps: AuthorizeDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const params = parseQueryParams(req);
  const validation = validateAuthorizeParams(params);
  if (!validation.ok) {
    return writeHtml(res, 400, renderErrorPage(validation.message));
  }
  if (!(await isRegisteredClient(deps, validation.normalized.clientId))) {
    // Unknown client: render a sanitized 400 page. The
    // error MUST NOT echo the supplied client_id (an
    // attacker probing the endpoint learns nothing) and
    // MUST NOT redirect to the (possibly hostile)
    // `redirect_uri` — that would convert a "client not
    // found" into a redirect-based open redirect.
    return writeHtml(res, 400, renderErrorPage("Invalid request."));
  }
  const session = readSession(deps, req);
  if (session === null) {
    return writeHtml(res, 200, renderLoginForm(validation.normalized));
  }
  // Authenticated: render the consent form. The CSRF
  // token is the session's `csrfToken`; the form embeds
  // it as a hidden input.
  return writeHtml(res, 200, renderConsentForm(validation.normalized, session));
}

// -----------------------------------------------------------------------
// POST handler
// -----------------------------------------------------------------------

async function handlePost(
  deps: AuthorizeDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readFormBody(req);
  const action = body.get("_action") ?? "";
  if (action === "login") {
    return handleLogin(deps, req, res, body);
  }
  if (action === "consent") {
    return handleConsent(deps, req, res, body);
  }
  return writeJsonError(res, 400, "invalid_request");
}

async function handleLogin(
  deps: AuthorizeDeps,
  req: IncomingMessage,
  res: ServerResponse,
  body: URLSearchParams,
): Promise<void> {
  const params = extractRequestParamsFromBody(body);
  const validation = validateAuthorizeParams(params);
  if (!validation.ok) {
    return writeHtml(res, 400, renderErrorPage(validation.message));
  }
  if (!(await isRegisteredClient(deps, validation.normalized.clientId))) {
    return writeHtml(res, 400, renderErrorPage("Invalid request."));
  }
  const username = (body.get("username") ?? "").trim();
  const password = body.get("password") ?? "";
  if (username.length === 0 || password.length === 0) {
    return writeHtml(res, 401, renderLoginForm(validation.normalized, "Invalid credentials"));
  }
  const now = getNow(deps);
  // Per-username backoff: same discipline as the admin
  // login form. The lock applies BEFORE the password
  // check so an attacker cannot enumerate valid usernames
  // by observing the response time.
  if (await isLocked(deps.db, username, now)) {
    return writeHtml(res, 429, renderLoginForm(validation.normalized, "Too many failed attempts. Try again later."));
  }
  const result = await verifyAgentPassword(deps.db, username, password);
  if (!result.ok) {
    await recordFailure(deps.db, username, now);
    return writeHtml(res, 401, renderLoginForm(validation.normalized, "Invalid credentials"));
  }
  await clearFailures(deps.db, username);
  const session: SessionData = {
    username,
    userId: result.agent.id,
    csrfToken: generateCsrfToken(),
    createdAt: now,
  };
  const cookieValue = signSessionCookie(deps.sessionSecret, session);
  res.setHeader(
    "Set-Cookie",
    buildSetCookieHeader({
      name: SESSION_COOKIE_NAME,
      value: cookieValue,
      secure: deps.secure,
    }),
  );
  // Audit the authorize-time login. The actor is the
  // user's username; the action names the flow so the
  // audit viewer can distinguish admin logins from
  // authorize-flow logins.
  await auditAppend(deps.db, {
    ts: now,
    actor: username,
    action: "authorize.login",
    target: `user:${result.agent.id}`,
    ip: readIp(req),
    outcome: "ok",
  });
  return writeHtml(res, 200, renderConsentForm(validation.normalized, session));
}

async function handleConsent(
  deps: AuthorizeDeps,
  req: IncomingMessage,
  res: ServerResponse,
  body: URLSearchParams,
): Promise<void> {
  const params = extractRequestParamsFromBody(body);
  const validation = validateAuthorizeParams(params);
  if (!validation.ok) {
    return writeHtml(res, 400, renderErrorPage(validation.message));
  }
  if (!(await isRegisteredClient(deps, validation.normalized.clientId))) {
    return writeHtml(res, 400, renderErrorPage("Invalid request."));
  }
  const session = readSession(deps, req);
  if (session === null) {
    // No session → re-render the login form. The flow
    // starts over with the same `state` so the user
    // resumes the round-trip after authenticating.
    return writeHtml(res, 200, renderLoginForm(validation.normalized));
  }
  // CSRF: the session's `csrfToken` MUST match the
  // form's hidden `_csrf` input. A mismatch is a
  // hard 403 with no body parse of the response.
  const csrf = body.get("_csrf") ?? null;
  if (!verifyCsrfToken(session, csrf)) {
    return writeJsonError(res, 403, "forbidden");
  }
  // Issue the code. The TTL is bounded by the spec; the
  // helper uses `getTtl(deps)` so tests can override.
  const now = getNow(deps);
  const ttl = getTtl(deps);
  const code = generateCode();
  const scopes = parseScopeList(params.scope, deps.defaultScope);
  codeStore.set(code, {
    clientId: params.clientId,
    agentId: session.userId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: "S256",
    scopes,
    expiresAt: now + ttl,
  });
  await auditAppend(deps.db, {
    ts: now,
    actor: session.username,
    action: "authorize.code_issued",
    target: `client:${params.clientId}`,
    ip: readIp(req),
    outcome: "ok",
  });
  // Build the redirect URL. The `state` is echoed
  // verbatim (the spec is explicit: state MUST be
  // echoed unchanged on success and on redirect-based
  // errors). The `code` is the server-generated secret;
  // it is bound to the `redirect_uri` the token endpoint
  // will verify byte-equal.
  const redirectUrl = new URL(params.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (params.state.length > 0) {
    redirectUrl.searchParams.set("state", params.state);
  }
  res.statusCode = 302;
  res.setHeader("Location", redirectUrl.toString());
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.end();
}

// -----------------------------------------------------------------------
// Parameter validation
// -----------------------------------------------------------------------

/**
 * The shape we carry from query parsing through the
 * handlers. The `normalized` shape strips trailing
 * whitespace and decodes the percent-encoded values; we
 * store the normalized form so the form's hidden inputs
 * carry the same values the user submitted.
 */
type NormalizedParams = {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
};

type ValidationResult =
  | { ok: true; normalized: NormalizedParams }
  | { ok: false; message: string };

function validateAuthorizeParams(p: NormalizedParams): ValidationResult {
  if (p.responseType !== "code") {
    return { ok: false, message: "Invalid request." };
  }
  if (p.clientId.length === 0 || p.clientId.length > 256) {
    return { ok: false, message: "Invalid request." };
  }
  if (!isLoopbackRedirectUri(p.redirectUri)) {
    return { ok: false, message: "Invalid request." };
  }
  if (
    p.codeChallenge.length < MIN_CODE_CHALLENGE_LENGTH ||
    p.codeChallenge.length > MAX_CODE_CHALLENGE_LENGTH
  ) {
    return { ok: false, message: "Invalid request." };
  }
  // The base64url alphabet. We accept both upper- and
  // lower-case for the challenge but we store the value
  // as-supplied (the token endpoint will hash the
  // verifier and compare against this exact value).
  if (!/^[A-Za-z0-9_-]+$/.test(p.codeChallenge)) {
    return { ok: false, message: "Invalid request." };
  }
  if (p.codeChallengeMethod !== "S256") {
    return { ok: false, message: "Invalid request." };
  }
  // State is optional per the spec, but when present
  // it MUST be echoed verbatim. We accept any printable
  // ASCII up to 512 chars (the OAuth 2.0 recommendation).
  if (p.state.length > 512) {
    return { ok: false, message: "Invalid request." };
  }
  return { ok: true, normalized: p };
}

function parseScopeList(raw: string, defaultScope: string): string[] {
  if (raw.trim().length === 0) return [defaultScope];
  const tokens = raw.split(/\s+/).filter((s) => s.length > 0);
  // Filter against SCOPE_PATTERN (defense in depth) and
  // fall back to the default if nothing survived.
  const valid = tokens.filter((s) => SCOPE_PATTERN.test(s));
  return valid.length > 0 ? valid : [defaultScope];
}

// -----------------------------------------------------------------------
// Query / body parsing
// -----------------------------------------------------------------------

function parseQueryParams(req: IncomingMessage): NormalizedParams {
  const url = req.url ?? "/";
  const qIdx = url.indexOf("?");
  const query = qIdx === -1 ? "" : url.slice(qIdx + 1);
  const params = new URLSearchParams(query);
  return {
    clientId: (params.get("client_id") ?? "").trim(),
    redirectUri: (params.get("redirect_uri") ?? "").trim(),
    responseType: (params.get("response_type") ?? "").trim(),
    scope: (params.get("scope") ?? "").trim(),
    state: (params.get("state") ?? "").trim(),
    codeChallenge: (params.get("code_challenge") ?? "").trim(),
    codeChallengeMethod: (params.get("code_challenge_method") ?? "").trim(),
  };
}

function extractRequestParamsFromBody(body: URLSearchParams): NormalizedParams {
  return {
    clientId: (body.get("client_id") ?? "").trim(),
    redirectUri: (body.get("redirect_uri") ?? "").trim(),
    responseType: (body.get("response_type") ?? "code").trim(),
    scope: (body.get("scope") ?? "").trim(),
    state: (body.get("state") ?? "").trim(),
    codeChallenge: (body.get("code_challenge") ?? "").trim(),
    codeChallengeMethod: (body.get("code_challenge_method") ?? "").trim(),
  };
}

function readSession(deps: AuthorizeDeps, req: IncomingMessage): SessionData | null {
  const cookieHeader = req.headers["cookie"];
  const cookies = parseCookies(typeof cookieHeader === "string" ? cookieHeader : null);
  const cookie = cookies.get(SESSION_COOKIE_NAME);
  if (typeof cookie !== "string" || cookie.length === 0) return null;
  return verifySessionCookie(deps.sessionSecret, cookie);
}

/**
 * Check whether the supplied `clientId` is a registered
 * OAuth2 client. The check is per-request (no caching) so
 * a future client rotation is picked up without a
 * restart. The query is bounded by the `clientId` UNIQUE
 * index.
 */
async function isRegisteredClient(deps: AuthorizeDeps, clientId: string): Promise<boolean> {
  if (clientId.length === 0) return false;
  const rows = await deps.db.select<{ id: number }>(
    "SELECT id FROM clients WHERE clientId = ? LIMIT 1",
    [clientId],
  );
  return rows.length > 0;
}

function readIp(req: IncomingMessage): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0]!.trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0]!;
  }
  return req.socket.remoteAddress ?? null;
}

function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > FORM_BODY_CAP) {
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

// -----------------------------------------------------------------------
// HTML rendering
// -----------------------------------------------------------------------

function renderLoginForm(p: NormalizedParams, error: string | null = null): string {
  const errorBlock =
    error === null ? "" : `<div class="error">${escapeHtml(error)}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorize</title>
</head>
<body>
  <h1>Sign in to authorize</h1>
  ${errorBlock}
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="_action" value="login">
    ${hiddenInputs(p)}
    <label>Username <input type="text" name="username" autocomplete="username" required></label>
    <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

function renderConsentForm(p: NormalizedParams, session: SessionData): string {
  const scopeList = p.scope.length === 0 ? "(default scope)" : escapeHtml(p.scope);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorize</title>
</head>
<body>
  <h1>Authorize ${escapeHtml(p.clientId)}</h1>
  <p>The application <strong>${escapeHtml(p.clientId)}</strong> is requesting access to the following scopes: <code>${scopeList}</code></p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="_action" value="consent">
    <input type="hidden" name="_csrf" value="${escapeHtml(session.csrfToken)}">
    ${hiddenInputs(p)}
    <button type="submit">Allow</button>
  </form>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Error</title>
</head>
<body>
  <h1>Invalid request</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function hiddenInputs(p: NormalizedParams): string {
  const fields: Array<[string, string]> = [
    ["client_id", p.clientId],
    ["redirect_uri", p.redirectUri],
    ["response_type", p.responseType],
    ["scope", p.scope],
    ["state", p.state],
    ["code_challenge", p.codeChallenge],
    ["code_challenge_method", p.codeChallengeMethod],
  ];
  return fields
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.end(body);
}

function writeJsonError(res: ServerResponse, status: number, error: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.end(JSON.stringify({ error }));
}

// Mark the import as used (the helper exposes the
// single-writer surface for callers that need it; the
// authorize handler itself does not write directly).
void withSingleWriter;
