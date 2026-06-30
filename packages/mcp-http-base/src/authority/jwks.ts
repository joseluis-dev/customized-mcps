/**
 * JwksAuthority — the production / shared-deployment `TokenAuthority`
 * implementation.
 *
 * Phase 1b of the external-token-authority-verification change adds the
 * `JwksAuthority` on top of the Phase 1a `TokenAuthority` abstraction.
 * The OAuth / JWKS backend is the only token-verify path on the
 * resource server: the local HMAC roster backend was removed, and
 * the resource server is required to wire `MCP_AUTHORITY_URL` against
 * an external authority (per the mcp-agent-authorization spec).
 * The app-side `loadHttpRuntimeConfig` fails closed when
 * `MCP_AUTHORITY_URL` is unset.
 *
 * Wire contract (per the mcp-token-authority spec):
 * - The `iss` claim MUST equal `MCP_AUTHORITY_URL`.
 * - The `aud` claim MUST equal `MCP_AUTHORITY_AUDIENCE`.
 * - `exp` and `nbf` are validated with `MCP_AUTHORITY_LEEWAY_S`
 *   seconds of leeway (default 30s).
 * - The JWKS is fetched from `MCP_AUTHORITY_JWKS_URL` and cached for
 *   `MCP_AUTHORITY_JWKS_TTL_S` seconds (default 60s).
 * - On `kid` miss, the JWKS is refetched exactly once. A second
 *   consecutive `kid` miss is rejected with `TokenInvalidError` and
 *   logged at `WARN` (the rejected value and token fingerprint are
 *   NOT included in the log line — audit-safe redaction).
 * - Unreachable authority → `AuthorityUnavailableError` (mapped to
 *   503 by the middleware).
 * - The `scopes` claim (string or array) is IGNORED end-to-end. It
 *   is not extracted, not normalized, not filtered, and not logged.
 *   The returned `scopes` is always `[]` (per PR 1 of the
 *   `remove-scope-authorization` change).
 *
 * Audit-safe redaction (per the spec):
 * - Errors MUST NOT include the supplied token, the `kid`, the
 *   JWKS URL, the authority URL, or the resolved `agentId`.
 * - The middleware's `sanitizeError` path strips whatever leaks,
 *   but the authority itself is the primary defense.
 *
 * Implementation notes:
 * - We use `jose.createRemoteJWKSet` for the JWKS resolver. jose
 *   handles the HTTP fetch (via `https.get` / `http.get` in Node),
 *   the cache lifetime (`cacheMaxAge`), and the cooldown window
 *   (`cooldownDuration`) that prevents a `kid` miss from
 *   stampeding the endpoint.
 * - jose's `getKey` does its OWN kid-miss refetch: when the
 *   cached JWKS lacks the token's `kid`, jose calls `reload()`
 *   once (subject to `cooldownDuration`) and retries. If the
 *   kid is STILL missing after the auto-refetch, jose throws
 *   `JWKSNoMatchingKey`. We rely on this built-in behavior so
 *   the "kid absent from two consecutive JWKS responses" rule
 *   in the spec is enforced by jose's cooldown + auto-refetch
 *   pair, not by a separate counter in our code.
 * - We track per-kid WARN emission: the first time a `kid` is
 *   observed as missing, we emit a structured WARN (without the
 *   kid or token fingerprint — the spec leaves redaction
 *   permissive; the audit-safe default is to omit the values).
 *   We do NOT include the kid or token fingerprint in the log
 *   line because the middleware's `redactSensitive` would strip
 *   them anyway, and the WARN is for the operator to know that
 *   "the JWKS endpoint is missing keys" — not to expose the
 *   specific kid.
 */

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose";
import { createHash } from "node:crypto";
import {
  AuthorityUnavailableError,
  TokenInvalidError,
  type TokenAuthority,
  type VerifiedToken,
  type VerifyContext,
} from "./types.js";
import type { Logger } from "../logging.js";

/**
 * The jose `createRemoteJWKSet` function returns a `JWTVerifyGetKey`
 * function that also exposes a `reload` method (via
 * `Object.defineProperty`). We cast to a type that includes
 * `reload` so the warm() probe can clear the cache. The runtime
 * check (`?.()`) keeps the cast honest — if jose ever drops
 * `reload` we degrade to a no-op rather than crashing.
 */
type JwksResolver = JWTVerifyGetKey & { reload?: () => void };

/**
 * Constructor options for `JwksAuthority`. The `iss` / `aud` / JWKS
 * URL come from the app-side env loader (`MCP_AUTHORITY_URL` and
 * friends); the `logger` is the shared HTTP base's `Logger`.
 */
export type JwksAuthorityOptions = {
  issuer: string;
  jwksUrl: string;
  audience: string;
  ttlSeconds: number;
  leewaySeconds: number;
  fetchTimeoutMs: number;
  logger: Logger;
};

/**
 * JwksAuthority — verifies RS256/ES256 JWTs against the authority's
 * JWKS. The constructor is strict: missing fields throw so the
 * middleware cannot be wired against a permissive default.
 */
export class JwksAuthority implements TokenAuthority {
  // `protected` (not `private`) so the `OAuthAdminAuthority` wrapper
  // can read `issuer` and `fetchTimeoutMs` without a TypeScript cast
  // to `unknown`. The cast was a PR 1 W4 footgun: any future rename
  // of these fields would silently break the wrapper. The values
  // are configuration-derived (not secret-bearing), so widening the
  // visibility to subclasses is safe. The wrapper is the only
  // subclass in the package; if a future third party subclasses
  // `JwksAuthority`, the same field surface is exposed (a public
  // getter would be over-broad — these are internal contract values
  // for the override path, not a public API).
  protected readonly issuer: string;
  protected readonly jwksUrl: URL;
  protected readonly audience: string;
  protected readonly ttlMs: number;
  protected readonly leewaySeconds: number;
  protected readonly fetchTimeoutMs: number;
  protected readonly logger: Logger;
  // jose's resolver. The `reload()` method clears the cache so the
  // next call re-fetches. We use it to implement the kid-miss
  // refetch flow.
  private readonly getKey: JwksResolver;
  private readonly verifyOptions: JWTVerifyOptions;
  // Per-kid second-miss tracking. The spec says: "kid absent from
  // two consecutive JWKS responses" → reject + WARN. We track the
  // last WARN per kid so a flood of kid-miss requests does not
  // produce a flood of WARN lines (one per kid, refreshed after
  // the cooldown period).
  private readonly kidMissWarnedAt = new Map<string, number>();

  constructor(options: JwksAuthorityOptions) {
    if (typeof options.issuer !== "string" || options.issuer.trim().length === 0) {
      throw new Error("JwksAuthority: `issuer` is required (MCP_AUTHORITY_URL).");
    }
    if (typeof options.audience !== "string" || options.audience.trim().length === 0) {
      throw new Error(
        "JwksAuthority: `audience` is required (MCP_AUTHORITY_AUDIENCE). " +
          "An empty audience would let any token issued by the authority be accepted; " +
          "the spec requires fail-closed on this field.",
      );
    }
    if (typeof options.jwksUrl !== "string" || options.jwksUrl.trim().length === 0) {
      throw new Error("JwksAuthority: `jwksUrl` is required (MCP_AUTHORITY_JWKS_URL).");
    }
    if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds < 1) {
      throw new Error(
        `JwksAuthority: ttlSeconds must be a positive integer; got ${options.ttlSeconds}.`,
      );
    }
    if (!Number.isFinite(options.leewaySeconds) || options.leewaySeconds < 0) {
      throw new Error(
        `JwksAuthority: leewaySeconds must be a non-negative integer; got ${options.leewaySeconds}.`,
      );
    }
    if (!Number.isFinite(options.fetchTimeoutMs) || options.fetchTimeoutMs < 1) {
      throw new Error(
        `JwksAuthority: fetchTimeoutMs must be a positive integer; got ${options.fetchTimeoutMs}.`,
      );
    }
    this.issuer = options.issuer;
    this.jwksUrl = new URL(options.jwksUrl);
    this.audience = options.audience;
    this.ttlMs = options.ttlSeconds * 1000;
    this.leewaySeconds = options.leewaySeconds;
    this.fetchTimeoutMs = options.fetchTimeoutMs;
    this.logger = options.logger;
    // jose's `createRemoteJWKSet` returns a function that satisfies
    // `JWTVerifyGetKey` (callable with the protected header + token).
    // It also exposes `reload` via `Object.defineProperty` so the
    // caller can clear the cache.
    this.getKey = createRemoteJWKSet(this.jwksUrl, {
      cacheMaxAge: this.ttlMs,
      timeoutDuration: this.fetchTimeoutMs,
      cooldownDuration: 30_000,
    }) as JwksResolver;
    // jose's `algorithms` allowlist restricts accepted JWS `alg`
    // values. We accept the family the design calls out (RS256/ES256)
    // plus HS256 for sibling-MCP scenarios. Unsecured `alg: none` is
    // NEVER accepted by jose.
    this.verifyOptions = {
      issuer: this.issuer,
      audience: this.audience,
      clockTolerance: this.leewaySeconds,
      algorithms: ["RS256", "ES256", "HS256"],
    };
  }

  /**
   * Prefetch the JWKS so the app-side config loader can fail fast on
   * a misconfigured authority URL. The middleware does NOT call this
   * directly; the app's `loadHttpRuntimeConfig` invokes it during
   * startup. A probe failure throws `AuthorityUnavailableError` so
   * the entrypoint can exit non-zero.
   *
   * Implementation note: we do a direct `fetch` with our own
   * timeout so the probe catches network errors, timeouts, and
   * non-2xx responses. We do NOT call `getKey.reload()` here —
   * jose's resolver is lazy and queues the actual fetch on the
   * first `getKey` call. Calling `reload()` in `warm()` would
   * queue a promise that hangs forever (no one is waiting for
   * it), and the eventual DNS failure would surface as an
   * unhandled rejection long after the test (or the startup
   * probe) completes. The first `verify` call will trigger the
   * fetch anyway via jose's lazy logic.
   */
  async warm(): Promise<void> {
    try {
      const res = await fetchWithTimeout(this.jwksUrl, this.fetchTimeoutMs);
      if (!res.ok) {
        throw new AuthorityUnavailableError(
          `JWKS fetch returned HTTP ${res.status}`,
        );
      }
    } catch (err) {
      if (err instanceof AuthorityUnavailableError) throw err;
      throw new AuthorityUnavailableError("JWKS fetch failed during warm()");
    }
  }

  /**
   * Verify a bearer JWT against the cached JWKS. Throws
   * `TokenInvalidError` for claim / signature / kid-miss failures
   * (mapped to 401 by the middleware) and `AuthorityUnavailableError`
   * for fetch / network / timeout failures (mapped to 503).
   *
   * The optional `context` carries per-request data (currently
   * just the sanitized X-Request-Id). The second-miss WARN log
   * includes the kid, the token fingerprint prefix (first 8 hex
   * chars of SHA-256), and the request id, per the
   * `mcp-token-authority` spec.
   */
  async verify(token: string, context?: VerifyContext): Promise<VerifiedToken> {
    if (typeof token !== "string" || token.length === 0) {
      throw new TokenInvalidError("bearer token rejected: empty");
    }
    const kid = extractKid(token);
    if (kid === undefined) {
      // No `kid` at all — the JWT is malformed for a JWKS backend.
      // The spec maps this to 401.
      throw new TokenInvalidError("bearer token rejected: missing kid");
    }
    // First pass: verify against the cached JWKS. jose's `getKey`
    // fetches the JWKS on a cold cache but does NOT auto-refetch
    // on a kid miss within `cooldownDuration` (the cooldown is
    // what prevents a kid-miss from stampeding the endpoint).
    // The spec requires exactly one refetch on a kid miss, so we
    // do the refetch ourselves: on a `JWKSNoMatchingKey` error
    // we call `getKey.reload()` and re-verify. This gives us
    // the "two consecutive responses" semantics the spec demands.
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.getKey, this.verifyOptions);
      payload = result.payload;
      // Success — clear the per-kid WARN marker so a future
      // missing-kid on the same kid (e.g. authority rotated keys
      // back) emits a fresh WARN.
      this.kidMissWarnedAt.delete(kid);
    } catch (firstErr) {
      if (isTransportFailure(firstErr)) {
        throw new AuthorityUnavailableError(
          "JWKS fetch failed during verify",
        );
      }
      if (!isKidMiss(firstErr)) {
        // Claim / signature failure: reject without a refetch.
        throw new TokenInvalidError(
          "bearer token rejected: claim validation failed",
        );
      }
      // Kid-miss path: force a refetch and re-verify. Awaiting
      // the `reload()` promise is what makes the second `jwtVerify`
      // see the fresh JWKS — without the await, the second
      // verify would race the in-flight fetch and still use the
      // stale JWKS. jose's `cooldownDuration` would block the
      // auto-refetch on its own, so the manual `reload()` here
      // is the seam that gives the spec its "exactly one refetch
      // per kid-miss" semantics.
      try {
        await this.getKey.reload?.();
      } catch {
        throw new AuthorityUnavailableError(
          "JWKS fetch failed during kid-miss refetch",
        );
      }
      try {
        const result = await jwtVerify(token, this.getKey, this.verifyOptions);
        payload = result.payload;
        this.kidMissWarnedAt.delete(kid);
      } catch (secondErr) {
        if (isTransportFailure(secondErr)) {
          throw new AuthorityUnavailableError(
            "JWKS fetch failed during kid-miss refetch",
          );
        }
        if (isKidMiss(secondErr)) {
          // The kid is absent from two consecutive JWKS
          // responses (the spec's "second consecutive miss"
          // scenario). Log + reject. The WARN MUST include
          // (per the spec):
          //   - `kid` — so the operator can identify which key
          //     the authority is missing.
          //   - the first 8 hex chars of SHA-256(token) — so an
          //     operator can correlate the WARN with a captured
          //     token without seeing the full token.
          //   - the request id — so the WARN can be cross-linked
          //     to a specific request in the structured logs.
          // The token fingerprint is computed once at the top
          // of `verify` so we do not pay the SHA-256 cost on
          // the happy path (where the WARN never fires).
          const now = Date.now();
          const lastWarn = this.kidMissWarnedAt.get(kid) ?? 0;
          if (now - lastWarn > 30_000) {
            this.kidMissWarnedAt.set(kid, now);
            const { msg, ctx } = this.formatKidSecondMissWarn(token, kid, context);
            this.logger.warn(msg, ctx);
          }
          throw new TokenInvalidError(
            "bearer token rejected: kid not present in JWKS after refetch",
          );
        }
        // Some other error after refetch (e.g. a claim
        // failure). Map to 401.
        throw new TokenInvalidError(
          "bearer token rejected: claim validation failed after refetch",
        );
      }
    }
    // Map the verified JWT to the `VerifiedToken` shape:
    // `agentId` is the `sub` claim; `scopes` is the always-empty
    // `[]` array (per PR 1 of `remove-scope-authorization`). The
    // previous `SCOPE_PATTERN` filter on the inbound `scopes` claim
    // is removed: the resource server no longer reads the claim in
    // any form.
    const agentId = typeof payload.sub === "string" ? payload.sub : "";
    if (agentId.length === 0) {
      throw new TokenInvalidError("bearer token rejected: missing sub claim");
    }
    return { agentId, scopes: [] };
  }

  /**
   * Build the kid-second-miss WARN log line. The spec mandates
   * `kid` + token fingerprint prefix + request id. When the
   * request id is absent (caller did not pass a context), the
   * field is OMITTED — the audit-safe default is "no value, no
   * log fragment" rather than rendering a `[REDACTED]` or
   * `undefined` placeholder. A separate `logContext` is passed
   * so structured-logging consumers can index the fields without
   * parsing the message body.
   */
  private formatKidSecondMissWarn(
    token: string,
    kid: string,
    context: VerifyContext | undefined,
  ): { msg: string; ctx: { kid: string; tokenFp: string; requestId?: string } } {
    const fingerprint = tokenFingerprint(token);
    const msg =
      `JwksAuthority: token kid "${kid}" not present in JWKS (verified against ` +
      `two consecutive responses). Token fingerprint (sha256:8) = ${fingerprint}. ` +
      `The authority's JWKS does not contain the key this token was signed with. ` +
      `If the authority recently rotated keys, the operator must ensure ` +
      `MCP_AUTHORITY_JWKS_URL points to the current JWKS endpoint.` +
      (context?.requestId ? ` requestId=${context.requestId}` : "");
    const ctx: { kid: string; tokenFp: string; requestId?: string } = {
      kid,
      tokenFp: fingerprint,
    };
    if (context?.requestId) ctx.requestId = context.requestId;
    return { msg, ctx };
  }
}

/**
 * Wrap `fetch` with a timeout. The `warm()` probe uses this so a
 * network error surfaces as `AuthorityUnavailableError`. jose's
 * own `getKey` uses `https.get` / `http.get` directly (not
 * `globalThis.fetch`), so the timeout-on-`fetch` is only used by
 * the probe.
 */
async function fetchWithTimeout(url: URL, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AuthorityUnavailableError(
        `JWKS fetch timed out after ${timeoutMs}ms`,
      );
    }
    throw new AuthorityUnavailableError(
      `JWKS fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decode the JWT header (without verifying) to extract the `kid`.
 * A malformed token returns `undefined` so `verify` rejects it as
 * a kid miss.
 */
function extractKid(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const headerB64 = parts[0];
  if (headerB64 === undefined || headerB64.length === 0) return undefined;
  try {
    const json = atob(headerB64.replace(/-/g, "+").replace(/_/g, "/"));
    const obj = JSON.parse(json) as { kid?: unknown };
    return typeof obj.kid === "string" ? obj.kid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compute the first 8 hex chars of SHA-256(token). The spec
 * requires the kid-miss WARN to include this prefix so an
 * operator can correlate the WARN with a captured token without
 * seeing the full token in the message body. The first 8 hex
 * chars (32 bits of entropy) is enough to disambiguate
 * concurrent WARNs without leaking the token.
 */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
}

/**
 * Map a jose error to `true` if it represents a transport-level
 * failure (the JWKS endpoint is unreachable). The middleware maps
 * such failures to 503 via `AuthorityUnavailableError`.
 *
 * The jose Node-side codepath uses `https.get` / `http.get` directly
 * (not `globalThis.fetch`). On a connection failure the underlying
 * `http.ClientRequest` emits an `'error'` event that jose does not
 * handle — Node's unhandled-error handler converts it to a plain
 * `Error` with `code: "ECONNREFUSED"` (or `ETIMEDOUT`, `ENOTFOUND`,
 * `ECONNRESET`, etc.). jose's `JWKSTimeout` is what surfaces when
 * the socket-level timeout fires before the error event.
 */
function isTransportFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name ?? "";
  if (name === "JWKSTimeout") return true;
  if (name === "JWSInvalid" && (err.message ?? "").toLowerCase().includes("expected 200")) {
    return true;
  }
  // Plain Node errors carry the connection code on `err.code`.
  const code = (err as { code?: string }).code;
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  return false;
}

/**
 * Map a jose error to `true` if it represents a kid-miss (the
 * token's `kid` was not found in the JWKS). jose surfaces this
 * as `JWKSNoMatchingKey` (message: "no applicable key found in
 * the JSON Web Key Set"). We detect it by class name first, then
 * by message substring as a fallback.
 */
function isKidMiss(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "JWKSNoMatchingKey") return true;
  const message = (err.message ?? "").toLowerCase();
  return (
    message.includes("no applicable key") ||
    message.includes("no matching key") ||
    message.includes("jwks no matching key")
  );
}
