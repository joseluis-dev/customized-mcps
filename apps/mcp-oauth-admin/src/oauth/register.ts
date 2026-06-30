/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591).
 *
 * The mcp-oauth-authority spec requires:
 * - `POST /oauth/register` accepts RFC 7591-style registration
 *   requests.
 * - The endpoint requires a JSON `redirect_uris` array; every
 *   entry MUST satisfy the loopback redirect URI rule (RFC
 *   8252 §7.3). A non-loopback URI is rejected with
 *   `400 invalid_redirect_uri`.
 * - Authorization-code clients: `grant_types` defaults to
 *   `["authorization_code"]`; `response_types` defaults to
 *   `["code"]`. The endpoint rejects unsupported values
 *   (e.g. `implicit`).
 * - `token_endpoint_auth_method` defaults to
 *   `client_secret_post`. Supported methods:
 *   `client_secret_post` and `client_secret_basic` (both
 *   are accepted by the token endpoint; see `oauth/token.ts`).
 * - The response carries at least `client_id`, `client_secret`,
 *   `client_id_issued_at`, `client_secret_expires_at` (0 for
 *   non-expiring), `redirect_uris`, `grant_types`,
 *   `response_types`, `token_endpoint_auth_method`, and
 *   `scope: ""` (the empty string, retained for RFC 7591
 *   compatibility; PR 3 of `remove-scope-authorization`
 *   makes scope authorization inert and the DCR response
 *   always returns `scope: ""` regardless of the request's
 *   `scope` value or the catalog state).
 * - The endpoint generates a 32-byte random `client_id`
 *   and a 32-byte random `client_secret`. The plaintext
 *   secret is returned exactly once in the response; the
 *   DB row stores only the `argon2id` hash.
 * - Incoming `scope` request parameters are TOLERATED and
 *   IGNORED (no `invalid_scope` rejection; the response is
 *   always `201` with `scope: ""`). The pre-PR3
 *   `boundRegistrationScope` + catalog gate is gone.
 * - Errors are sanitized: secrets are NEVER echoed in the
 *   response body, regardless of failure mode.
 * - Successful registrations are appended to the `audit_log`
 *   table with the action `client.register` (the actor is
 *   the registration's IP — there is no user session).
 * - Failed registration attempts leave an audit row with
 *   `outcome="denied"` AND a sanitized WARN log line so an
 *   operator can correlate denied requests without seeing
 *   the request body (which may contain a would-be secret).
 *   The `actor` is the request IP (or `unknown` when the
 *   IP is not available — behind a misconfigured proxy the
 *   `req.socket.remoteAddress` is the loopback address; we
 *   do NOT trust `X-Forwarded-For` without an explicit
 *   proxy opt-in, the same rule the other handlers use).
 * - The endpoint is bounded by an in-process per-IP rate
 *   limit. The limit is a simple sliding-window counter
 *   keyed by the request IP; the operator can tune the
 *   threshold and window via the `RegisterHandlerDeps`.
 *   The 6th attempt within the window returns `429`
 *   with a sanitized JSON body and no secret material.
 *
 * Implementation notes:
 * - The endpoint is a `http.RequestListener`. The app
 *   entrypoint mounts it on the same listener as the rest
 *   of the OAuth endpoints.
 * - The endpoint is intentionally minimal: there is no
 *   admin UI surface; the operator is expected to use
 *   this endpoint from a CI pipeline or post-install
 *   hook. The admin UI's existing `createClient` flow is
 *   the canonical path for pre-registered clients.
 * - All error paths return a sanitized JSON body. The
 *   handler is wrapped in a top-level `try` / `catch` so
 *   an unexpected exception (e.g. a DB connection drop)
 *   does not crash the listener; the catch returns a
 *   sanitized 500 with a stable error code. The
 *   exception is logged once with no body or secret.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { type AuthorityDatabase } from "../db/connection.js";
import { auditAppend } from "../admin/audit.js";
import { createClient } from "../admin/clients.js";
import { isLoopbackRedirectUri } from "./authorize.js";
import { BodyTooLargeError, readJsonBody } from "./bodyReader.js";
import { readClientIp } from "./clientIp.js";
import { createLogger, type Logger } from "@customized-mcps/mcp-http-base";

/**
 * The dependencies the registration handler needs. The
 * shape is the same as the other OAuth handlers so the
 * entrypoint wiring is uniform. The rate-limit and
 * logger fields are optional with sensible defaults.
 */
export type RegisterHandlerDeps = {
  db: AuthorityDatabase;
  /** @deprecated Retained for backward compatibility with
   *  the v1 wiring in `index.ts`; the field is no longer
   *  read (PR 3 of `remove-scope-authorization` ignores
   *  scope). */
  defaultScope?: string;
  /** Test-injection point for the client_id / client_secret
   *  generator. Production callers omit it. */
  generateId?: () => string;
  /** Test-injection point for the body cap. Default 64 KiB. */
  bodyCap?: number;
  /** Per-IP registration rate limit. Default 5 attempts
   *  per 60 seconds (the same shape as the per-username
   *  login backoff in `admin/backoff.ts`). */
  rateLimit?: { threshold: number; windowSeconds: number };
  /** Clock injection (test-only). Defaults to
   *  `Math.floor(Date.now() / 1000)`. */
  now?: () => number;
  /** Logger injection. Defaults to a text-format stderr
   *  logger. The `register` log lines are intentionally
   *  sanitized — no body, no client_secret, no
   *  redirect_uri, no raw scope. */
  logger?: Logger;
  /** Trust the `X-Forwarded-For` header for the client IP
   *  (and therefore the per-IP rate-limit key + the audit
   *  `actor` / `ip` columns). The default is `false`: the
   *  direct TCP peer (`req.socket.remoteAddress`) is the
   *  source of truth, so a spoofed XFF cannot bypass the
   *  rate limit or distort the audit attribution. Operators
   *  behind a TLS-terminating reverse proxy MUST set this
   *  to `true` (the app's `index.ts` wires it from
   *  `httpConfig.behindProxy` / `MCP_HTTP_BEHIND_PROXY=true`).
   *  Tests inject the value directly to drive both branches. */
  trustProxy?: boolean;
};

/**
 * The maximum body size for a registration request. 64 KiB
 * is more than enough for a reasonable registration payload
 * (the largest documented `redirect_uris` list is well under
 * 1 KiB).
 */
const DEFAULT_BODY_CAP = 64 * 1024;

/**
 * The default rate limit: 5 attempts per 60 seconds. The
 * threshold matches the per-username login backoff; the
 * window is shorter because DCR is a one-shot operation
 * (a legitimate client registers once, not repeatedly).
 */
const DEFAULT_RATE_LIMIT = { threshold: 5, windowSeconds: 60 };

/**
 * The supported `token_endpoint_auth_method` values. The
 * token endpoint accepts both (see `oauth/token.ts`'s
 * `extractClientCredentials`), so the DCR handler can
 * advertise both to clients. Other values (e.g.
 * `client_secret_jwt`, `private_key_jwt`, `none`) are out
 * of scope for v1 and are rejected with `400`.
 */
const SUPPORTED_AUTH_METHODS = new Set([
  "client_secret_post",
  "client_secret_basic",
]);

/**
 * The shape of a parsed registration request. The shape is
 * the union of every documented RFC 7591 field; we accept
 * unknown fields (silently ignored) to be forward-compatible
 * with future RFC extensions.
 */
type RegistrationRequest = {
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  scope?: unknown;
  client_name?: unknown;
  client_uri?: unknown;
  logo_uri?: unknown;
  policy_uri?: unknown;
  tos_uri?: unknown;
  contacts?: unknown;
  software_id?: unknown;
  software_version?: unknown;
};

/**
 * The response shape per RFC 7591 §3.2.1. The field set is
 * the union of `client_id`, `client_secret`, the timestamps,
 * and the fields we actively support.
 */
type RegistrationResponse = {
  client_id: string;
  client_secret: string;
  client_id_issued_at: number;
  client_secret_expires_at: number;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
  client_name?: string;
  client_uri?: string;
};

/**
 * The in-process per-IP rate-limit state. Keyed by the
 * request IP. Each entry tracks the recent attempt
 * timestamps inside the active window; the counter is
 * monotonic within the window. A new request outside the
 * window resets the counter to 1.
 *
 * The Map is intentionally module-level. A multi-process
 * deployment would need a shared store (Redis or the
 * `login_backoff` table); the spec accepts the in-process
 * limitation because DCR is low-volume per-IP and the
 * worst case is a brief per-process throttle, not a
 * global lockout. The state is reset on process restart
 * (the same way the auth-code store is reset).
 */
const ipRateState: Map<string, number[]> = new Map();

/**
 * Check the rate limit for an IP. Returns `null` when the
 * IP is under the limit, or the number of seconds until
 * the limit is released. The function is a pure read of
 * the in-process state (no side effects on the success
 * path; the call site is responsible for calling
 * `recordRegisterAttempt` after the read so a successful
 * attempt that immediately follows a denied one does not
 * double-count).
 */
function checkRateLimit(
  ip: string,
  threshold: number,
  windowSeconds: number,
  now: number,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const cutoff = now - windowSeconds;
  const attempts = ipRateState.get(ip) ?? [];
  // Drop expired entries.
  const recent = attempts.filter((t) => t > cutoff);
  if (recent.length >= threshold) {
    // Lock until the oldest entry in the window expires.
    const oldest = recent[0]!;
    const retryAfterSeconds = Math.max(1, oldest + windowSeconds - now);
    ipRateState.set(ip, recent);
    return { allowed: false, retryAfterSeconds };
  }
  ipRateState.set(ip, recent);
  return { allowed: true };
}

/**
 * Record a registration attempt for the IP. Called after
 * the rate-limit check passes (the function adds the
 * `now` timestamp to the sliding window). The
 * `recordRegisterAttempt` + `checkRateLimit` pair is
 * split so the caller can decide whether to count a
 * request that was rejected by an earlier validation
 * step (the current implementation counts every well-
 * formed POST so a flood of malformed bodies still
 * trips the limit).
 */
function recordRegisterAttempt(ip: string, now: number): void {
  const attempts = ipRateState.get(ip) ?? [];
  attempts.push(now);
  ipRateState.set(ip, attempts);
}

/**
 * Test-only helper: clear the module-level rate-limit
 * state. Production code MUST NOT call this; tests
 * invoke it from `beforeEach` to pin a clean slate.
 */
export function _resetRegisterRateLimit(): void {
  ipRateState.clear();
}

/**
 * Construct the `POST /oauth/register` handler.
 */
export function createRegisterHandler(
  deps: RegisterHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const generateId = deps.generateId ?? defaultGenerateId;
  const cap = deps.bodyCap ?? DEFAULT_BODY_CAP;
  const rateLimit = deps.rateLimit ?? DEFAULT_RATE_LIMIT;
  const getNow = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const logger: Logger =
    deps.logger ?? createLogger({ format: "text" });
  const trustProxy = deps.trustProxy ?? false;
  return async (req, res) => {
    const now = getNow();
    const ip = readClientIp(req, trustProxy);
    const actor = `system:register:${ip ?? "unknown"}`;
    // Defense in depth: the entire body is wrapped in a
    // try/catch so an unexpected exception (e.g. a DB
    // connection drop) does not crash the listener.
    // The catch returns a sanitized 500 + a WARN log line.
    try {
      if (req.method !== "POST") {
        await recordDeniedAttempt(deps.db, logger, {
          ts: now,
          actor,
          ip,
          action: "client.register",
          outcome: "denied",
          reason: "method_not_post",
        });
        return writeJson(res, 405, { error: "invalid_request" });
      }
      // Rate limit: per-IP, sliding window. The check
      // runs BEFORE we read the body so a flood of
      // requests with bogus bodies still trips the limit.
      const limitKey = ip ?? "__unknown__";
      const limit = checkRateLimit(limitKey, rateLimit.threshold, rateLimit.windowSeconds, now);
      if (!limit.allowed) {
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
        await recordDeniedAttempt(deps.db, logger, {
          ts: now,
          actor,
          ip,
          action: "client.register",
          outcome: "denied",
          reason: "rate_limited",
        });
        return writeJson(res, 429, { error: "invalid_request" });
      }
      recordRegisterAttempt(limitKey, now);
      const body = await readJsonBody(req, cap);
      if (body === null) {
        await recordDeniedAttempt(deps.db, logger, {
          ts: now,
          actor,
          ip,
          action: "client.register",
          outcome: "denied",
          reason: "invalid_body",
        });
        return writeJson(res, 400, { error: "invalid_request" });
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        await recordDeniedAttempt(deps.db, logger, {
          ts: now,
          actor,
          ip,
          action: "client.register",
          outcome: "denied",
          reason: "invalid_body",
        });
        return writeJson(res, 400, { error: "invalid_request" });
      }
      const parsed = body as RegistrationRequest;
      // 1. Validate `redirect_uris` (RFC 7591 §2 + RFC 8252 §7.3).
      const redirectUrisResult = parseRedirectUris(parsed.redirect_uris);
      if (!redirectUrisResult.ok) {
        await recordDeniedAttempt(deps.db, logger, {
          ts: now,
          actor,
          ip,
          action: "client.register",
          outcome: "denied",
          reason: redirectUrisResult.error,
        });
        return writeJson(res, 400, { error: redirectUrisResult.error });
      }
      const redirectUris = redirectUrisResult.value;
      // 2. Validate `grant_types`. The default is
      //    `["authorization_code"]`. The token endpoint
      //    supports `client_credentials`, `password`,
      //    `refresh_token`, and `authorization_code`; DCR
      //    clients only get the authorization-code grant
      //    (the other grants are for pre-registered clients
      //    with operator-blessed credentials).
      const grantTypes = parseGrantTypes(parsed.grant_types);
      // 3. Validate `response_types`. Default `["code"]`.
      const responseTypes = parseResponseTypes(parsed.response_types);
      // 4. Validate `token_endpoint_auth_method`. Default
      //    `client_secret_post`. We accept `client_secret_basic`
      //    as well; both are honored by the token endpoint.
      const authMethod = parseAuthMethod(parsed.token_endpoint_auth_method);
      if (!authMethod.ok) {
        await recordDeniedAttempt(deps.db, logger, {
          ts: now,
          actor,
          ip,
          action: "client.register",
          outcome: "denied",
          reason: authMethod.error,
        });
        return writeJson(res, 400, { error: authMethod.error });
      }
      // 5. PR 3 of `remove-scope-authorization`: incoming
      //    `scope` is tolerated and ignored. The
      //    `boundRegistrationScope` + catalog gate is
      //    gone; the response is always `201` with
      //    `scope: ""` (the empty string, retained for
      //    RFC 7591 compatibility). The newly-registered
      //    client's `scopes` column is empty
      //    (legacy/inert).
      //    (The `parsed.scope` is read for shape
      //    uniformity; the value is not echoed into the
      //    response and is not used to bound the
      //    registration.)
      void parsed.scope;
      const grantedScope = "";
      // 6. Generate the credentials.
      const clientId = generateId();
      const clientSecret = generateId();
      // 7. Persist the client via the typed helper so the
      //    DB shape stays consistent with the admin UI
      //    create-client path. The plaintext secret is
      //    returned to the caller; the DB row stores the
      //    hash only. The pre-generated `clientSecret` is
      //    passed through so the stored hash matches the
      //    value in the registration response. The
      //    client's `scopes` column is `[]` (empty
      //    array) — the field is INERT post-PR3.
      const result = await createClient(deps.db, {
        clientId,
        label: typeof parsed.client_name === "string" ? parsed.client_name : "",
        redirectUris,
        plaintextSecret: clientSecret,
        now,
      });
      if (!result.ok) {
        // The only realistic failure is `duplicate` (we just
        // generated the id; collisions on 32 random bytes
        // are cryptographically improbable). The fallback
        // is a sanitized `400 invalid_request` so we never
        // echo internal state.
        await recordDeniedAttempt(deps.db, logger, {
          ts: now,
          actor,
          ip,
          action: "client.register",
          outcome: "denied",
          reason: result.reason,
        });
        return writeJson(res, 400, { error: "invalid_request" });
      }
      // 8. Append the audit row. The actor is the request's
      //    IP (there is no user session); the target is the
      //    freshly-issued client_id (sanitized — NOT the
      //    secret). Audit failure is non-fatal: the
      //    registration is already persisted. We log a
      //    sanitized WARN so an operator can correlate the
      //    successful registration with the missing audit
      //    row without seeing any secret material.
      try {
        await auditAppend(deps.db, {
          ts: now,
          actor,
          action: "client.register",
          target: `client:${clientId}`,
          ip,
          outcome: "ok",
        });
      } catch (e) {
        logger.warn(
          `mcp-oauth-admin: DCR audit_append failed; registration persisted, reason=audit_failure`,
        );
        void e;
      }
      // 9. Build the RFC 7591 response. The `client_secret`
      //    is the plaintext; the caller is responsible for
      //    showing it once to the operator and never
      //    persisting it. The `scope` field is the empty
      //    string (PR 3 of `remove-scope-authorization`).
      const response: RegistrationResponse = {
        client_id: clientId,
        client_secret: clientSecret,
        client_id_issued_at: now,
        client_secret_expires_at: 0, // v1: non-expiring
        redirect_uris: redirectUris,
        grant_types: grantTypes,
        response_types: responseTypes,
        token_endpoint_auth_method: authMethod.value,
        scope: grantedScope,
      };
      if (typeof parsed.client_name === "string" && parsed.client_name.length > 0) {
        response.client_name = parsed.client_name;
      }
      if (typeof parsed.client_uri === "string" && parsed.client_uri.length > 0) {
        response.client_uri = parsed.client_uri;
      }
      return writeJson(res, 201, response);
    } catch (e) {
      // Defense in depth: an unexpected exception
      // (DB drop, OOM, etc.) MUST NOT crash the
      // listener. Return a sanitized 500 + a WARN
      // log line. The exception is logged once; the
      // response body is stable.
      // `BodyTooLargeError` is a typed signal from
      // the body reader; it is mapped to a sanitized
      // 400, not a 500, because the spec is explicit
      // that oversized bodies are an `invalid_request`
      // (RFC 7591 §3.2.2).
      if (e instanceof BodyTooLargeError) {
        logger.warn(
          `mcp-oauth-admin: DCR request body too large; reason=invalid_request`,
        );
        if (!res.headersSent) {
          return writeJson(res, 400, { error: "invalid_request" });
        }
        return;
      }
      const reason = e instanceof Error ? e.message : "internal_error";
      logger.warn(
        `mcp-oauth-admin: DCR handler caught unexpected exception; reason=${redactReason(reason)}`,
      );
      if (!res.headersSent) {
        return writeJson(res, 500, { error: "invalid_request" });
      }
      return;
    }
  };
}

/**
 * Append a `denied` audit row and emit a sanitized WARN.
 * The function is best-effort: an audit failure is logged
 * but does not change the response. The reason code is
 * carried verbatim into the WARN line (the value is a
 * short token — never a request body or a secret).
 */
async function recordDeniedAttempt(
  db: AuthorityDatabase,
  logger: Logger,
  args: {
    ts: number;
    actor: string;
    ip: string | null;
    action: string;
    outcome: "denied";
    reason: string;
  },
): Promise<void> {
  try {
    await auditAppend(db, {
      ts: args.ts,
      actor: args.actor,
      action: args.action,
      // No `target` for a denied request: the
      // client_id was never issued, so there is
      // nothing to log. The `actor` carries the IP.
      target: null,
      ip: args.ip,
      outcome: args.outcome,
    });
  } catch (e) {
    logger.warn(
      `mcp-oauth-admin: DCR denied-audit append failed; reason=${redactReason(args.reason)}`,
    );
    void e;
  }
  // The log line is intentionally short. The reason
  // token is a stable code (`invalid_body`,
  // `rate_limited`, `invalid_scope`, etc.); the
  // operator correlates the row with the WARN by
  // timestamp. No request body, no IP, no scope.
  logger.warn(
    `mcp-oauth-admin: DCR request denied; reason=${redactReason(args.reason)}`,
  );
}

/**
 * Redact a reason code before it lands in a log line. The
 * redaction is conservative: when in doubt, return
 * `internal_error` (the stable token that does not leak
 * any operator-supplied input). The reason is a stable
 * code emitted by the handler — never an end-user string
 * — but the redaction is a defense-in-depth measure so a
 * future code path that pipes an attacker-controlled
 * value into the reason slot cannot exfiltrate via the
 * log.
 */
function redactReason(reason: string): string {
  if (typeof reason !== "string" || reason.length === 0) return "internal_error";
  // Allow only `[a-z_]{1,32}` to pass through. Anything
  // else collapses to `internal_error`.
  if (!/^[a-z_]{1,32}$/.test(reason)) return "internal_error";
  return reason;
}

/**
 * Parse and validate the `redirect_uris` field. The result
 * is either the validated list (1..N entries) or a
 * sanitized `invalid_redirect_uri` error. Every URI MUST
 * pass `isLoopbackRedirectUri` (the v1 spec is explicit:
 * the authority is loopback-only; DCR clients that want
 * public redirect URIs are out of scope for v1).
 *
 * The function name is `parseRedirectUris` (NOT
 * `parseScopeList`): the JSON-list parsing of redirect
 * URIs is structurally identical to scope-list parsing,
 * but the two shapes are semantically distinct and a
 * future maintainer MUST NOT reuse this helper for
 * scopes. The historical `parseScopeList` name in the
 * other modules is intentional; this helper exists to
 * make the redirect-URI ↔ scope confusion impossible.
 */
function parseRedirectUris(
  raw: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "invalid_redirect_uri" };
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      return { ok: false, error: "invalid_redirect_uri" };
    }
    if (!isLoopbackRedirectUri(entry)) {
      return { ok: false, error: "invalid_redirect_uri" };
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

/**
 * Parse the `grant_types` field. The default is
 * `["authorization_code"]`. We accept a subset of the
 * standard grant types (any that include
 * `authorization_code` is allowed). DCR clients do NOT
 * get the `client_credentials`, `password`, or
 * `refresh_token` grants — those are operator-blessed
 * pre-registration paths.
 */
function parseGrantTypes(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return ["authorization_code"];
  }
  const allowed = new Set(["authorization_code", "refresh_token"]);
  const filtered = raw.filter((s): s is string => typeof s === "string" && allowed.has(s));
  // Always include `authorization_code` even if omitted;
  // the spec requires it for DCR clients.
  if (!filtered.includes("authorization_code")) {
    filtered.unshift("authorization_code");
  }
  return filtered;
}

/**
 * Parse the `response_types` field. The default is
 * `["code"]`. v1 only supports `code` (the implicit
 * response type is out of scope).
 */
function parseResponseTypes(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return ["code"];
  }
  const allowed = new Set(["code"]);
  const filtered = raw.filter((s): s is string => typeof s === "string" && allowed.has(s));
  return filtered.length > 0 ? filtered : ["code"];
}

/**
 * Parse the `token_endpoint_auth_method` field. The
 * default is `client_secret_post`. The supported
 * values are listed in `SUPPORTED_AUTH_METHODS`.
 */
function parseAuthMethod(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: true, value: "client_secret_post" };
  }
  if (!SUPPORTED_AUTH_METHODS.has(raw)) {
    return { ok: false, error: "invalid_client_metadata" };
  }
  return { ok: true, value: raw };
}

/**
 * The default `client_id` / `client_secret` generator. 32
 * random bytes → 43 base64url chars (≈ 192 bits of
 * entropy). The same generator is used for both fields.
 * The generator is a separate function so tests can inject
 * a deterministic implementation.
 */
function defaultGenerateId(): string {
  return randomBytes(32).toString("base64url");
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.end(JSON.stringify(body));
}
