/**
 * Session and CSRF helpers for the admin UI.
 *
 * The mcp-admin-ui spec requires:
 * - Session cookie: `HttpOnly`, `SameSite=Strict`, `Secure` (when
 *   not loopback), signed with a server-side secret. The secret is
 *   `node:crypto.randomBytes(32)`; restarting the process
 *   invalidates all sessions.
 * - Double-submit CSRF: every state-changing form has a hidden
 *   CSRF token input AND the matching `X-CSRF-Token` header on
 *   fetch requests; the server rejects requests missing either.
 *   The CSRF token is held in the session; the form / header value
 *   MUST match it.
 *
 * The module is pure: it has no DB dependency, no I/O, no
 * listeners. The router (`admin/router.ts`) wires the helpers to
 * the database and the request/response cycle.
 *
 * Cryptography choices:
 * - Session secret: 32 bytes from `crypto.randomBytes`. Stored as
 *   64-char hex in memory (the operator never sees it on disk;
 *   it lives only in the process). A restart generates a new
 *   secret and invalidates every outstanding cookie.
 * - Session cookie: HMAC-SHA256 signature over the JSON-encoded
 *   session. The payload is `base64url(JSON).base64url(HMAC)`.
 *   The signature is verified in constant time; any tamper
 *   (payload, signature, length) is rejected.
 * - CSRF token: 32 bytes from `crypto.randomBytes`, stored in the
 *   session (which is server-side). The browser receives it as a
 *   hidden form input AND/OR an `X-CSRF-Token` header; the
 *   router checks at least one of those against the session
 *   value. Comparison is constant-time.
 *
 * Audit-safety: this module NEVER logs the secret, the session
 * payload, or the CSRF token. The shared `redactSensitive`
 * helper strips any 64-char hex (which would be a leaked secret)
 * from the surrounding log line.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The session data signed into the cookie. The CSRF token lives
 * here so a server-side lookup is the only source of truth (the
 * browser never gets to "set" the CSRF token independently).
 */
export type SessionData = {
  /** The admin's username (the `users.username` column). */
  username: string;
  /** The admin's row id (`users.id`). */
  userId: number;
  /** A 32-byte hex CSRF token. Rotated on login / privilege change. */
  csrfToken: string;
  /** Unix-seconds timestamp when the session was minted. */
  createdAt: number;
};

const SESSION_SECRET_BYTES = 32;
const CSRF_TOKEN_BYTES = 32;

/** The session cookie name. The browser stores it as HttpOnly. */
export const SESSION_COOKIE_NAME = "mcp_oauth_admin_session";

/**
 * The CSRF cookie name. Distinct from the session cookie so a
 * future "double-submit" extension (where the server ALSO sets
 * this cookie as a non-HttpOnly, JS-readable value) does not
 * collide with the session cookie. Currently the CSRF token is
 * embedded in the session payload AND in the hidden form input;
 * this constant is exported for future use + the double-submit
 * invariant check in the test suite.
 */
export const CSRF_COOKIE_NAME = "mcp_oauth_admin_csrf";

/**
 * Generate a fresh session secret. The secret is the 32-byte
 * HMAC key for the session cookie. Returning it as 64-char hex
 * keeps the value JSON-safe and easy to log (operators who want
 * to debug a session issue can grep for a specific secret value
 * without seeing the raw bytes).
 */
export function generateSessionSecret(): string {
  return randomBytes(SESSION_SECRET_BYTES).toString("hex");
}

/** Alias for `generateSessionSecret` (the entrypoint uses this name). */
export const generateAdminSessionSecret = generateSessionSecret;

/**
 * Generate a fresh CSRF token. 32 bytes of entropy, hex-encoded
 * so it is safe to embed in HTML form inputs.
 */
export function generateCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString("hex");
}

/**
 * Sign a session payload into a cookie value. The format is
 * `base64url(JSON).base64url(HMAC-SHA256)`. The HMAC is computed
 * over the base64url payload string (not the raw JSON) so the
 * signature is stable across implementations.
 */
export function signSessionCookie(secret: string, data: SessionData): string {
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Verify a session cookie. Returns the parsed payload on success;
 * returns `null` on ANY failure (bad signature, tampered payload,
 * malformed input, wrong secret, non-JSON). The caller MUST treat
 * `null` as "not authenticated" and respond with 401 / redirect
 * to the login form. The function NEVER throws.
 */
export function verifySessionCookie(secret: string, cookie: string): SessionData | null {
  if (typeof cookie !== "string" || cookie.length === 0) return null;
  const dot = cookie.indexOf(".");
  if (dot <= 0 || dot === cookie.length - 1) return null;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (payload.length === 0 || sig.length === 0) return null;
  // Recompute the expected signature and compare in constant time.
  const expected = createHmac("sha256", secret).update(payload).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;
  // Decode the payload. Bad JSON → null (treated as malformed cookie).
  let parsed: unknown;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (!isSessionData(parsed)) return null;
  return parsed;
}

/**
 * Verify a CSRF token against the session. The comparison is
 * constant-time; the function returns false on length mismatch
 * without short-circuiting on the first byte. The caller should
 * reject the request with 403 when this returns false.
 */
export function verifyCsrfToken(session: SessionData, submitted: string | undefined | null): boolean {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  if (typeof session.csrfToken !== "string" || session.csrfToken.length === 0) return false;
  const a = Buffer.from(session.csrfToken, "utf8");
  const b = Buffer.from(submitted, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Build a `Set-Cookie` header value. The session cookie is
 * `HttpOnly; SameSite=Strict; Path=/`; the caller adds `Secure`
 * when the deployment is non-loopback. We always set `Path=/` so
 * every admin route receives the cookie.
 */
export function buildSetCookieHeader(options: {
  name: string;
  value: string;
  secure: boolean;
  maxAgeSeconds?: number;
}): string {
  const parts = [`${options.name}=${options.value}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (options.secure) parts.push("Secure");
  if (typeof options.maxAgeSeconds === "number" && options.maxAgeSeconds > 0) {
    parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
  }
  return parts.join("; ");
}

/**
 * Parse the `Cookie` request header into a name→value map. The
 * function is defensive: malformed pairs are skipped, value
 * decoding is via `decodeURIComponent` (the standard for cookies
 * per RFC 6265), and duplicate names keep the FIRST occurrence
 * (so a malicious duplicate cannot override a legitimate cookie).
 *
 * The `raw` argument is the literal value of the `Cookie`
 * header (e.g. `"a=1; b=2"`). The router passes `req.headers.cookie`
 * directly; the test passes any object that has a `.get("cookie")`
 * method (the WHATWG Headers API) for ergonomics.
 */
export function parseCookies(source: Headers | { get(name: string): string | null | undefined } | string | null | undefined): Map<string, string> {
  let raw: string | null | undefined;
  if (typeof source === "string") {
    raw = source;
  } else if (source === null || source === undefined) {
    raw = undefined;
  } else {
    raw = source.get("cookie");
  }
  const out = new Map<string, string>();
  if (typeof raw !== "string" || raw.length === 0) return out;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    if (out.has(name)) continue; // first occurrence wins
    let value = trimmed.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Malformed escape; keep the raw value rather than throwing.
    }
    out.set(name, value);
  }
  return out;
}

/**
 * Type guard for `SessionData`. Used after `JSON.parse` to make
 * sure the payload has the expected shape (the cookie is
 * server-issued, so this is defense-in-depth — a malformed
 * payload means a bug, not user input).
 */
function isSessionData(value: unknown): value is SessionData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.username === "string" &&
    typeof v.userId === "number" &&
    Number.isInteger(v.userId) &&
    typeof v.csrfToken === "string" &&
    typeof v.createdAt === "number"
  );
}
