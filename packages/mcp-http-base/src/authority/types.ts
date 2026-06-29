/**
 * TokenAuthority — the resource-server-side contract for agent-token
 * verification.
 *
 * The shared base (`@customized-mcps/mcp-http-base`) is the single source of
 * truth for this contract. Two implementations live in this package:
 *
 * - `LocalRosterAuthority` (dev/offline fallback) — wraps the v1
 *   `loadAgents` + `validateBearer` HMAC path. The local backend is the
 *   unset-env default; the recommended default for production and
 *   shared deployments is the JWKS-backed authority (Phase 1b).
 * - `JwksAuthority` (Phase 1b) — verifies RS256/ES256 JWTs against
 *   the authority's JWKS, with 60s cache, `kid`-miss refetch, and
 *   fail-closed 503 on authority unreachable.
 *
 * Every `verify` implementation MUST:
 * - return `{ agentId, scopes }` on success (all scopes match
 *   `SCOPE_PATTERN`; `LocalRosterAuthority` filters out invalid
 *   entries as a defense-in-depth step).
 * - throw `TokenInvalidError` for malformed, expired, revoked, or
 *   unknown tokens. The middleware maps this to `401`.
 * - throw `AuthorityUnavailableError` for fetch / network / timeout
 *   failures. The middleware maps this to `503`.
 *
 * Implementations MUST NOT include the supplied token, the resolved
 * agentId, the keyHash, the `kid`, the authority URL, or the JWKS
 * URL in any thrown error message. The middleware's `sanitizeError`
 * path strips whatever leaks, but the authority itself is the
 * primary defense.
 *
 * Lifecycle:
 * - `verify` is the only required method.
 * - `warm` is OPTIONAL: an app MAY call it at startup to pre-fetch
 *   the JWKS (or to fail fast on a misconfigured authority URL).
 *   The shared base does NOT call it; the app-side config loader
 *   decides when the probe is appropriate. This keeps `verify` the
 *   single source of truth for the request path and avoids
 *   `warm()`-vs-`verify()` initialization races.
 */

import type { Logger } from "../logging.js";
import type { AgentRecord } from "../auth.js";

/**
 * A verified agent identity, as returned by `TokenAuthority.verify`.
 *
 * The shape is intentionally narrow: `agentId` is the stable id
 * (local roster's `id` field, or the JWT `sub` claim on the JWKS
 * backend) and `scopes` is the granted set, already filtered
 * against `SCOPE_PATTERN`.
 */
export type VerifiedToken = {
  agentId: string;
  scopes: string[];
};

/**
 * Optional per-request context passed to `TokenAuthority.verify`.
 *
 * Phase 1b's `JwksAuthority` uses this to attach the X-Request-Id
 * (sanitized by the shared base's `sanitizeRequestId`) to the
 * second-miss WARN log line, so an operator can correlate a
 * kid-miss WARN with the request that triggered it. The
 * `LocalRosterAuthority` ignores the context (the local backend
 * has no per-request WARN scenario). Future backends (e.g.
 * `IntrospectionAuthority`) may use additional fields.
 *
 * The field is intentionally narrow: only the values the spec
 * requires in WARN lines, plus a slot for future fields. The
 * middleware MUST sanitize `requestId` (the X-Request-Id header
 * is untrusted client input) before passing it in.
 */
export type VerifyContext = {
  requestId?: string;
};

/**
 * The contract every resource-server-side token verifier must
 * implement. The shared base's HTTP middleware calls
 * `verify(token, context)` for every request that arrives with a
 * bearer header.
 */
export interface TokenAuthority {
  verify(token: string, context?: VerifyContext): Promise<VerifiedToken>;
  /**
   * Optional startup probe. Implementations that need to pre-fetch
   * state (e.g. a JWKS) MAY implement this. The app-side config
   * loader decides when the probe is appropriate. The shared base
   * does NOT call it directly.
   */
  warm?(): Promise<void>;
}

/**
 * Thrown by `TokenAuthority.verify` when the token is malformed,
 * expired, revoked, or unknown. The shared base middleware maps
 * this to a sanitized 401 response. The `name` property is the
 * discriminator the middleware uses; do NOT override it.
 */
export class TokenInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenInvalidError";
  }
}

/**
 * Thrown by `TokenAuthority.verify` when the authority is
 * unreachable, times out, or returns a non-2xx response. The
 * shared base middleware maps this to a sanitized 503 response.
 * The `name` property is the discriminator; do NOT override it.
 */
export class AuthorityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityUnavailableError";
  }
}

/**
 * Constructor options for `LocalRosterAuthority`. Re-exported as
 * `LocalRosterAuthorityOptions` so callers do not have to import
 * the internal field shape.
 */
export type LocalRosterAuthorityOptions = {
  agents: AgentRecord[];
  hmacSecret: string;
  logger: Logger;
};

/**
 * Re-export `Logger` here so callers can import the full authority
 * surface from `@customized-mcps/mcp-http-base` without reaching
 * into the logging module directly. This keeps the public API
 * stable when the logger implementation changes.
 */
export type { Logger };
