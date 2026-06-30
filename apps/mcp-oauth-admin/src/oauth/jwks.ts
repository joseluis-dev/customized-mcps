/**
 * JWKS + OIDC discovery handlers.
 *
 * The mcp-oauth-authority spec requires:
 * - `GET /.well-known/jwks.json` returns the active JWK Set
 *   with ONLY public components (kty, n, e, kid, use, alg).
 *   Private components (d, p, q, dp, dq, qi) MUST NOT appear.
 * - `GET /.well-known/openid-configuration` advertises the
 *   OIDC + OAuth2 endpoints (token, introspect, authorize,
 *   JWKS), the supported grant types (including
 *   `authorization_code`), the PKCE method (`S256`), the
 *   response types, and the issuer. The only response
 *   type the authority supports is `code` (the
 *   authorization-code flow); the implicit `token` flow
 *   is out of scope and MUST NOT be advertised.
 *
 * These handlers are intentionally thin: they read the
 * current `keys` row and shape the response. The handlers
 * are constructed as `http.RequestListener` functions so the
 * authority's main listener can mount them on the same
 * port as the rest of the OAuth2 endpoints.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { loadActiveSigningKey } from "./keys.js";
import type { AuthorityDatabase } from "../db/connection.js";

/**
 * The JWK fields that are considered "public" per the spec.
 * Any field not in this set (and not `kid` / `use` / `alg`)
 * MUST NOT be exposed via JWKS — the spec is explicit that
 * private components (d, p, q, dp, dq, qi) MUST NOT appear.
 */
const PUBLIC_JWK_FIELDS = new Set(["kty", "n", "e", "kid", "use", "alg", "crv", "x", "y"]);

/**
 * Strip a JWK to its public components. The function is
 * intentionally defensive: any unknown field is dropped,
 * so a future private-only field never leaks.
 */
function toPublicJwk(jwk: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(jwk)) {
    if (PUBLIC_JWK_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Construct the `/.well-known/jwks.json` handler. The handler
 * reads the most-recently-created key from the `keys` table
 * and returns a JWK Set with one entry. The response is
 * always 200 (per the spec: the failure mode is an empty
 * JWK Set when the authority has no active key, not a 5xx).
 */
export function createJwksHandler(options: {
  db: AuthorityDatabase;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (_req, res) => {
    const key = await loadActiveSigningKey(options.db);
    const jwks = { keys: key ? [toPublicJwk(key.publicJwk)] : [] };
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.end(JSON.stringify(jwks));
  };
}

/**
 * Construct the `/.well-known/openid-configuration` handler.
 * The discovery doc is built from the request's host so the
 * issuer matches the URL the resource server actually sees
 * (no port mismatch when the authority is behind a reverse
 * proxy on the default port).
 *
 * Per the spec:
 * - The `issuer` is the authority URL.
 * - The `token_endpoint`, `introspection_endpoint`, and
 *   `authorization_endpoint` are advertised. (The
 *   introspect endpoint is an internal contract; we
 *   advertise it so resource servers that want to opt
 *   into the introspection path can find it.)
 * - Supported grants: `client_credentials`, `password`,
 *   `refresh_token`, `authorization_code`. (We expose
 *   `refresh_token` for the token-endpoint refresh grant,
 *   and `authorization_code` for the auth-code flow.)
 * - PKCE method: `S256` only. `plain` is forbidden by
 *   OAuth 2.1 and the spec.
 * - Signing algs: `RS256` only (the only algorithm the
 *   authority uses to sign access tokens).
 * - `subject_types_supported` is `["public"]`: the authority
 *   issues the same stable local subject (e.g.
 *   `user:<agentId>`, `client:<clientId>`) to every
 *   relying party. No pairwise / sector-identifier mapping
 *   is performed.
 */
export function createOidcDiscoveryHandler(options: {
  issuer?: string;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const issuer = options.issuer ?? deriveIssuer(req);
    const body = {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      introspection_endpoint: `${issuer}/oauth/introspect`,
      registration_endpoint: `${issuer}/oauth/register`,
      grant_types_supported: [
        "client_credentials",
        "password",
        "refresh_token",
        "authorization_code",
      ],
      // The authority only supports the authorization-code
      // flow (PKCE S256). The implicit `token` flow is out
      // of scope and is intentionally NOT advertised. An
      // OIDC client that requires `token` would discover
      // it does not apply here and fall back to the
      // standard code flow.
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      subject_types_supported: ["public"],
    };
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.end(JSON.stringify(body));
  };
}

/**
 * Derive the issuer URL from the incoming request. We use
 * the `Host` header verbatim (no port-stripping) so the
 * issuer matches the URL the client used. Behind a reverse
 * proxy, the operator is responsible for setting
 * `X-Forwarded-Host` (or equivalent) correctly.
 */
function deriveIssuer(req: IncomingMessage): string {
  const host = (req.headers.host ?? "127.0.0.1").trim();
  // The OIDC discovery doc is served over the same port the
  // operator bound the authority to. We do not assume a
  // particular scheme; the request URL is the source of
  // truth.
  const proto = (req.headers["x-forwarded-proto"] ?? "http")
    .toString()
    .split(",")[0]
    ?.trim() || "http";
  return `${proto}://${host}`;
}
