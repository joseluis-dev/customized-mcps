/**
 * OAuth2 introspection endpoint (RFC 7662).
 *
 * The mcp-oauth-authority spec requires:
 * - `POST /oauth/introspect` validates a token + returns
 *   `{ active: true, ... }` or `{ active: false }`.
 * - The endpoint is the `OAuthAdminAuthority.warm()` probe
 *   target: the resource-server-side wrapper POSTs a
 *   trivial introspection at startup, and exits non-zero
 *   on connection refused, 5xx, or unexpected body.
 *
 * Audit-safety:
 * - The supplied token is NEVER included in any log line
 *   or error message. The middleware's `sanitizeError`
 *   strips whatever leaks, but this handler is the primary
 *   defense.
 * - The response shape is the canonical RFC 7662 fields:
 *   `active`, `sub`, `aud`, `iss`, `scope`, `exp`, `iat`.
 *   We do NOT return the token, the `kid`, or any
 *   private JWK component.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { jwtVerify, errors as joseErrors } from "jose";
import { importSigningPrivateKey, loadActiveSigningKey } from "./keys.js";
import { SCOPE_PATTERN } from "@customized-mcps/mcp-http-base";
import type { AuthorityDatabase } from "../db/connection.js";
import { BodyTooLargeError, readFormBody } from "./bodyReader.js";

/**
 * The dependencies the introspect handler needs. We share
 * the same `TokenHandlerDeps` shape as the token endpoint
 * because both handlers need the issuer, audience, and
 * active key — and the introspect endpoint reads its key
 * dynamically (so a key rotation is picked up without a
 * restart).
 */
export type IntrospectHandlerDeps = {
  db: AuthorityDatabase;
  issuer: string;
  audience: string;
};

/**
 * Construct the `POST /oauth/introspect` handler. The
 * handler verifies the token against the active JWKS and
 * returns the RFC 7662 shape.
 */
export function createIntrospectHandler(
  deps: IntrospectHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      return writeJson(res, 405, { error: "invalid_request" });
    }
    let params: URLSearchParams;
    try {
      params = await readFormBody(req);
    } catch (e) {
      // Mirror the token handler's typed error boundary:
      // an oversized body is `400 invalid_request`, NOT a
      // connection reset. The stream is paused so we can
      // write the response cleanly.
      if (e instanceof BodyTooLargeError) {
        return writeJson(res, 400, { error: "invalid_request" });
      }
      throw e;
    }
    const token = params.get("token") ?? "";
    // Empty / missing `token` is a valid RFC 7662 request:
    // the spec says the server MUST return
    // `{ active: false }` (NOT 400). The resource
    // server's `OAuthAdminAuthority.warm()` probe
    // sends `token=` to confirm the endpoint is
    // alive; a 400 here would fail the probe (the
    // wrapper expects a 200 + `{active: false}`).
    //
    // This is the canonical RFC 7662 behavior: the
    // `introspect()` function already handles an
    // empty token by returning `{ active: false }`;
    // the previous short-circuit was a defense-in-
    // depth that was too aggressive. The fix is to
    // delegate the empty-token case to `introspect()`
    // so the response shape is uniform.
    const result = await introspect(deps, token);
    return writeJson(res, 200, result);
  };
}

/**
 * Verify a token and return the RFC 7662 introspection
 * shape. The function is exported so the `OAuthAdminAuthority`
 * wrapper in the resource-server package can drive the
 * startup probe without a network round-trip.
 */
export async function introspect(
  deps: IntrospectHandlerDeps,
  token: string,
): Promise<Record<string, unknown>> {
  if (typeof token !== "string" || token.length === 0) {
    return { active: false };
  }
  const activeKey = await loadActiveSigningKey(deps.db);
  if (!activeKey) {
    return { active: false };
  }
  let privateKey;
  try {
    privateKey = await importSigningPrivateKey(activeKey);
  } catch {
    return { active: false };
  }
  try {
    const verified = await jwtVerify(token, privateKey, {
      issuer: deps.issuer,
      audience: deps.audience,
      algorithms: ["RS256"],
    });
    const payload = verified.payload;
    const rawScopes = (() => {
      const v = (payload as { scopes?: unknown }).scopes;
      if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
      const s = (payload as { scope?: unknown }).scope;
      if (typeof s === "string") return s.split(/\s+/).filter((x) => x.length > 0);
      return [];
    })();
    const kept = rawScopes.filter((s) => SCOPE_PATTERN.test(s));
    return {
      active: true,
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      aud: payload.aud,
      iss: payload.iss,
      scope: kept.join(" "),
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch (e) {
    // Map to `{ active: false }` for ALL verification
    // failures: bad signature, wrong audience, expired,
    // etc. The introspect endpoint MUST NOT distinguish
    // between "unknown token" and "expired token" in the
    // response (the spec leaves the choice to the impl;
    // we follow RFC 7662 §2.2 which says always return
    // active=false on a failure).
    if (e instanceof joseErrors.JWTExpired) return { active: false };
    if (e instanceof joseErrors.JWTClaimValidationFailed) return { active: false };
    if (e instanceof joseErrors.JWSSignatureVerificationFailed) return { active: false };
    return { active: false };
  }
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
