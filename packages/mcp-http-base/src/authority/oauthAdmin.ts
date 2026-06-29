/**
 * OAuthAdminAuthority — extends `JwksAuthority` with a
 * startup probe against `/oauth/introspect`.
 *
 * The mcp-oauth-authority spec requires:
 * - The resource-server-side wrapper for the OAuth2
 *   authority. When `MCP_AUTHORITY_URL` is set, the app
 *   picks `OAuthAdminAuthority` over `JwksAuthority`.
 * - `warm()` POSTs `application/x-www-form-urlencoded`
 *   `token=` to `/oauth/introspect` against
 *   `MCP_AUTHORITY_URL`.
 * - `warm()` rejects on connection refused, TLS / DNS
 *   errors, 5xx responses, or unexpected body shape. The
 *   app-side loader translates the rejection into a
 *   non-zero exit.
 * - `verify()` is inherited from `JwksAuthority` (RS256 +
 *   JWKS cache + kid-miss refetch). The introspect probe
 *   is the only addition; the resource server's request
 *   path is unchanged.
 *
 * Implementation note: we keep the JWKS-only request path
 * (`verify`) and add the introspect probe (`warm`). The
 * two paths use different transports (JWKS for verify,
 * introspect for warm) because the introspect path is the
 * spec-mandated startup check. The JWKS path is the
 * per-request path; the introspect path is the bulk
 * startup check.
 *
 * Audit-safety: errors raised by `warm` include the
 * authority host + path only (per the mcp-agent-authorization
 * spec). The token is NEVER logged.
 */

import { JwksAuthority, type JwksAuthorityOptions } from "./jwks.js";

/**
 * The constructor options for `OAuthAdminAuthority`. The
 * shape is the same as `JwksAuthority` (since the wrapper
 * extends the JWKS class) plus a logger — the JWKS
 * constructor already requires a logger so this is the
 * same shape.
 */
export type OAuthAdminAuthorityOptions = JwksAuthorityOptions;

export class OAuthAdminAuthority extends JwksAuthority {
  constructor(options: OAuthAdminAuthorityOptions) {
    super(options);
  }

  /**
   * Probe the authority by POSTing to `/oauth/introspect`.
   * The probe is the only OAuth-specific addition over
   * `JwksAuthority`; the spec says: "OAuthAdminAuthority
   * calls /oauth/introspect against MCP_AUTHORITY_URL
   * before the listener accepts requests; exits non-zero
   * on connection refused, TLS error, 5xx, or unexpected
   * body."
   *
   * Implementation notes:
   * - We do NOT use jose's `createRemoteJWKSet` for the
   *   introspect path; we use `globalThis.fetch` with a
   *   timeout (so a connection refused surfaces
   *   immediately). The shared base's `fetchWithTimeout`
   *   pattern is mirrored here.
   * - The probe is the spec-mandated startup check; the
   *   resource-server entrypoint awaits this and exits
   *   non-zero on a failure. The probe's success is
   *   recorded with a structured INFO log so an operator
   *   can see the authority version they connected to.
   */
  override async warm(): Promise<void> {
    // First, run the parent JWKS probe. If the JWKS is
    // unreachable we fail fast — the resource server
    // cannot verify ANY token without it. The parent
    // throws AuthorityUnavailableError on a 5xx / network
    // failure; we surface that as-is so the app-side
    // loader's error message names the authority host.
    await super.warm();

    // Then probe /oauth/introspect. The probe body is the
    // canonical RFC 7662 form-encoded `token=` (with an
    // empty value — the authority MUST accept the empty
    // string and return `{ active: false }`; this is the
    // documented "is the authority alive?" check).
    //
    // PR 3 W4: the `issuer` and `fetchTimeoutMs` fields are
    // now `protected readonly` on `JwksAuthority` so the
    // wrapper reads them directly (no TypeScript cast to
    // `unknown`). The cast was a PR 1 footgun: any rename
    // of the parent field would silently break the wrapper.
    const issuer = this.issuer;
    const introspectUrl = new URL("/oauth/introspect", issuer).toString();
    const fetchTimeoutMs = this.fetchTimeoutMs;
    let res: Response;
    try {
      res = await fetchWithTimeout(introspectUrl, fetchTimeoutMs, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "token=",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `OAuthAdminAuthority introspect probe failed (network): ${msg}. ` +
          `Verify MCP_AUTHORITY_URL is reachable.`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `OAuthAdminAuthority introspect probe failed: HTTP ${res.status}. ` +
          `The authority is up but the introspect endpoint returned an error.`,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(
        `OAuthAdminAuthority introspect probe failed: response was not valid JSON. ` +
          `The authority must return the canonical RFC 7662 shape.`,
      );
    }
    if (typeof body !== "object" || body === null) {
      throw new Error(
        `OAuthAdminAuthority introspect probe failed: response was not a JSON object. ` +
          `Expected the canonical RFC 7662 shape with an "active" field.`,
      );
    }
    if (typeof (body as { active?: unknown }).active !== "boolean") {
      throw new Error(
        `OAuthAdminAuthority introspect probe failed: response shape unexpected ` +
          `(missing boolean "active" field).`,
      );
    }
  }
}

/**
 * Wrap `fetch` with a timeout. Mirrors the shared base's
 * `fetchWithTimeout` helper but is duplicated here to keep
 * the wrapper self-contained (the JWKS class's helper is
 * not exported).
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
