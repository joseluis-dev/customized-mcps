/**
 * Unauthenticated liveness probe for the OAuth2 authority.
 *
 * The MCP deployment spec (mcp-deployment-templates) requires every
 * MCP app to expose `GET /healthz` outside the authenticated request
 * path so external load balancers and orchestrators can probe it
 * without credentials. The endpoint reports:
 *   - `status`: `"ok"` when the authority is accepting traffic and
 *      can sign tokens, `"shutting-down"` during graceful drain,
 *      `"unhealthy"` when a startup probe failed.
 *   - `issuer`: the canonical MCP_AUTHORITY_URL when set; omitted
 *      otherwise (the OAuth wiring is disabled).
 *   - `protectedResources`: the allowlist length (audit-safe
 *      discriminator; the URIs themselves are NOT echoed so the
 *      endpoint can be scraped without leaking the deploy topology).
 *
 * The probe is intentionally NOT authenticated (the load balancer
 * cannot carry bearer tokens), but the body is sanitized — no
 * tokens, no JWKS URL, no signing key id, no full resource URIs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadActiveSigningKey } from "./keys.js";
import type { AuthorityDatabase } from "../db/connection.js";
import type { OAuthConfig } from "../config/oauth.js";

export type HealthHandlerOptions = {
  db: AuthorityDatabase;
  oauth?: OAuthConfig;
  /** Test hook: a flag that forces `"unhealthy"` regardless of state. */
  unhealthy?: () => boolean;
};

export function createHealthHandler(
  options: HealthHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("method not allowed");
      return;
    }
    let status: "ok" | "unhealthy" = "ok";
    if (options.unhealthy && options.unhealthy()) {
      status = "unhealthy";
    } else {
      // The probe verifies that the authority has an active signing
      // key — the absence of one means the process cannot mint
      // tokens, which is an unhealthy state for an OAuth authority.
      const key = await loadActiveSigningKey(options.db);
      if (!key) {
        status = "unhealthy";
      }
    }
    const body: Record<string, unknown> = { status };
    if (options.oauth && options.oauth.issuer !== undefined) {
      // The issuer is the canonical MCP_AUTHORITY_URL — it is
      // operator-supplied and safe to advertise (operators already
      // configure it as the public URL). The full resource URIs are
      // NOT echoed (see comment above on the audit-safe posture).
      body["issuer"] = options.oauth.issuer;
      body["protectedResources"] = options.oauth.allowedResources.length;
    }
    res.statusCode = status === "ok" ? 200 : 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  };
}