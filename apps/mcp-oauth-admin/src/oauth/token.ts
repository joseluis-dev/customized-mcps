/**
 * OAuth2 token endpoint.
 *
 * The mcp-oauth-authority spec requires:
 * - `POST /oauth/token` accepts `client_credentials`,
 *   `password`, and `refresh_token` grants.
 * - The response is an RS256 JWT with the spec claims
 *   (`iss`, `aud=mcp:<app>`, `sub`, `scope`, `iat`,
 *   `nbf`, `exp`, `kid` header) and `expires_in=3600`.
 * - Mixing `*` with a specific scope is REJECTED with
 *   `400 invalid_scope`.
 * - New agents/clients default to `read:<bound-profile>`
 *   (the authority's `defaultScope`); the default scope is
 *   NEVER `*`.
 * - `refresh_token` grant REJECTS tokens whose `revokedAt`
 *   is non-null with `400 invalid_grant`.
 *
 * Audit-safety: errors MUST NOT include the supplied
 * password, the resolved `agentId`, the `clientId`, the
 * `keyHash`, or the refresh-token plaintext. The handler
 * returns sanitized error shapes; structured audit logging
 * happens via the `audit_log` table (the caller is
 * expected to call the `auditAppend` helper for the
 * success/failure path).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SignJWT, type JWTPayload } from "jose";
import { createHash } from "node:crypto";
import { importSigningPrivateKey, type SigningKeyRecord } from "./keys.js";
import { verifyPassword } from "./passwords.js";
import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";
import { SCOPE_PATTERN } from "@customized-mcps/mcp-http-base";

/**
 * The dependencies the token handler needs. The wiring is
 * passed in by the app's main listener so the handler stays
 * driver-agnostic.
 */
export type TokenHandlerDeps = {
  db: AuthorityDatabase;
  issuer: string;
  audience: string;
  defaultScope: string;
  accessTokenTtlSeconds: number;
  activeKey: SigningKeyRecord;
};

const CLIENT_SCOPE_PATTERN = /^[A-Za-z0-9_*.:\s-]+$/;

/**
 * Construct the `POST /oauth/token` handler. The handler
 * parses the form-encoded body, dispatches on
 * `grant_type`, and writes the response.
 *
 * The handler is intentionally not async at the function
 * level — jose's `SignJWT` and argon2's `verify` are both
 * async, and the handler awaits them where needed.
 */
export function createTokenHandler(
  deps: TokenHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      return writeJson(res, 405, { error: "invalid_request" });
    }
    const params = await readFormBody(req);
    const grant = params.get("grant_type");
    if (grant === "client_credentials") {
      return handleClientCredentials(deps, params, res);
    }
    if (grant === "password") {
      return handlePasswordGrant(deps, params, res);
    }
    if (grant === "refresh_token") {
      return handleRefreshTokenGrant(deps, params, res);
    }
    return writeJson(res, 400, { error: "unsupported_grant_type" });
  };
}

/**
 * The `client_credentials` grant. Verifies the client_id +
 * client_secret against the `clients` table, computes the
 * granted scope (the requested scope intersected with the
 * client's allowed scopes, defaulting to `defaultScope`),
 * and mints a JWT.
 */
async function handleClientCredentials(
  deps: TokenHandlerDeps,
  params: URLSearchParams,
  res: ServerResponse,
): Promise<void> {
  const clientId = params.get("client_id") ?? "";
  const clientSecret = params.get("client_secret") ?? "";
  if (!clientId || !clientSecret) {
    return writeJson(res, 400, { error: "invalid_request" });
  }
  const rows = await deps.db.select<{
    id: number;
    clientSecretHash: string;
    scopes: string;
  }>("SELECT id, clientSecretHash, scopes FROM clients WHERE clientId = ?", [clientId]);
  const client = rows[0];
  if (!client) {
    return writeJson(res, 401, { error: "invalid_client" });
  }
  const ok = await verifyPassword(client.clientSecretHash, clientSecret);
  if (!ok) {
    return writeJson(res, 401, { error: "invalid_client" });
  }
  const requested = params.get("scope") ?? "";
  const clientScopes = parseScopeList(client.scopes);
  const granted = resolveGrantedScope(requested, clientScopes, deps.defaultScope);
  if (granted.error) {
    return writeJson(res, 400, { error: granted.error });
  }
  const sub = `client:${clientId}`;
  const token = await mintAccessToken(deps, sub, granted.scopes);
  return writeJson(res, 200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: deps.accessTokenTtlSeconds,
    scope: granted.scopes.join(" "),
  });
}

/**
 * The `password` grant. Verifies the user (username +
 * password against the `users` table) and the client, then
 * mints a JWT.
 *
 * The `requireChangeOnFirstLogin` flag is honored: when set
 * on the user row, the response is `400` (sanitized error),
 * no token is issued, and the caller MUST rotate the
 * password (the admin UI handles the rotation).
 */
async function handlePasswordGrant(
  deps: TokenHandlerDeps,
  params: URLSearchParams,
  res: ServerResponse,
): Promise<void> {
  const username = params.get("username") ?? "";
  const password = params.get("password") ?? "";
  const clientId = params.get("client_id") ?? "";
  const clientSecret = params.get("client_secret") ?? "";
  if (!username || !password || !clientId || !clientSecret) {
    return writeJson(res, 400, { error: "invalid_request" });
  }
  const userRows = await deps.db.select<{
    id: number;
    passwordHash: string;
    scopes: string;
    enabled: number;
    requireChangeOnFirstLogin: number;
  }>(
    "SELECT id, passwordHash, scopes, enabled, requireChangeOnFirstLogin FROM users WHERE username = ?",
    [username],
  );
  const user = userRows[0];
  if (!user || user.enabled !== 1) {
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  if (user.requireChangeOnFirstLogin === 1) {
    return writeJson(res, 400, { error: "password_change_required" });
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  // Verify the client too — password grant still requires
  // a registered client.
  const clientRows = await deps.db.select<{ id: number; clientSecretHash: string }>(
    "SELECT id, clientSecretHash FROM clients WHERE clientId = ?",
    [clientId],
  );
  const client = clientRows[0];
  if (!client) {
    return writeJson(res, 401, { error: "invalid_client" });
  }
  const clientOk = await verifyPassword(client.clientSecretHash, clientSecret);
  if (!clientOk) {
    return writeJson(res, 401, { error: "invalid_client" });
  }
  const userScopes = parseScopeList(user.scopes);
  const sub = `user:${user.id}`;
  const token = await mintAccessToken(deps, sub, userScopes.length > 0 ? userScopes : [deps.defaultScope]);
  return writeJson(res, 200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: deps.accessTokenTtlSeconds,
    scope: (userScopes.length > 0 ? userScopes : [deps.defaultScope]).join(" "),
  });
}

/**
 * The `refresh_token` grant. Looks up the refresh token
 * (SHA-256 of the plaintext against `tokenHash`), rejects
 * revoked tokens with `400 invalid_grant`, and mints a
 * new access token.
 *
 * Audit-safe: the supplied refresh token NEVER appears in
 * any log line; the only logged shape is the granted/denied
 * outcome + reason code.
 */
async function handleRefreshTokenGrant(
  deps: TokenHandlerDeps,
  params: URLSearchParams,
  res: ServerResponse,
): Promise<void> {
  const refreshToken = params.get("refresh_token") ?? "";
  const clientId = params.get("client_id") ?? "";
  const clientSecret = params.get("client_secret") ?? "";
  if (!refreshToken || !clientId || !clientSecret) {
    return writeJson(res, 400, { error: "invalid_request" });
  }
  const tokenHash = createHash("sha256").update(refreshToken, "utf8").digest("hex");
  const rows = await deps.db.select<{
    id: number;
    agentId: number;
    clientId: number;
    scopes: string;
    revokedAt: number | null;
  }>(
    "SELECT id, agentId, clientId, scopes, revokedAt FROM refresh_tokens WHERE tokenHash = ?",
    [tokenHash],
  );
  const row = rows[0];
  if (!row) {
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  if (row.revokedAt !== null) {
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  // Verify the client matches the refresh token's client.
  const clientRows = await deps.db.select<{ id: number; clientId: string; clientSecretHash: string }>(
    "SELECT id, clientId, clientSecretHash FROM clients WHERE id = ?",
    [row.clientId],
  );
  const client = clientRows[0];
  if (!client || client.clientId !== clientId) {
    return writeJson(res, 401, { error: "invalid_client" });
  }
  const clientOk = await verifyPassword(client.clientSecretHash, clientSecret);
  if (!clientOk) {
    return writeJson(res, 401, { error: "invalid_client" });
  }
  const scopes = parseScopeList(row.scopes);
  const sub = `user:${row.agentId}`;
  const token = await mintAccessToken(deps, sub, scopes.length > 0 ? scopes : [deps.defaultScope]);
  return writeJson(res, 200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: deps.accessTokenTtlSeconds,
    scope: (scopes.length > 0 ? scopes : [deps.defaultScope]).join(" "),
  });
}

/**
 * Parse a JSON-encoded scope list. The schema stores scopes
 * as a JSON string; we tolerate `null` / undefined as `[]`.
 */
function parseScopeList(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/**
 * Resolve the granted scope for a `client_credentials` grant.
 *
 * Rules (per the mcp-oauth-authority spec):
 * - If the request did NOT include a `scope` param, the
 *   granted scope is the client's allowed scopes (or
 *   `defaultScope` when the client has no scopes).
 * - If the request DID include a `scope` param, the
 *   granted scope is the intersection of the request and
 *   the client's allowed scopes.
 * - Mixing `*` with a specific scope is REJECTED.
 * - The `*` wildcard is allowed ONLY when the client's
 *   allowed scopes include it AND the request is `*`
 *   alone (not mixed).
 */
function resolveGrantedScope(
  requested: string,
  clientScopes: string[],
  defaultScope: string,
): { scopes: string[]; error?: undefined } | { scopes: []; error: string } {
  // No request: use the client's scopes (or the default).
  if (requested.trim().length === 0) {
    if (clientScopes.length === 0) {
      // Spec default: `read:<bound-profile>`. Never `*`.
      return { scopes: [defaultScope] };
    }
    return { scopes: clientScopes };
  }
  // Validate the request: every token must be a string;
  // the spec forbids mixing `*` with specific scopes.
  const reqScopes = requested.split(/\s+/).filter((s) => s.length > 0);
  if (reqScopes.some((s) => !CLIENT_SCOPE_PATTERN.test(s))) {
    return { scopes: [], error: "invalid_scope" };
  }
  const hasWildcard = reqScopes.includes("*");
  const hasSpecific = reqScopes.some((s) => s !== "*");
  if (hasWildcard && hasSpecific) {
    return { scopes: [], error: "invalid_scope" };
  }
  if (hasWildcard) {
    if (clientScopes.includes("*")) {
      return { scopes: ["*"] };
    }
    return { scopes: [], error: "invalid_scope" };
  }
  // Specific scopes: filter against the client's allowed
  // set. Drop any that don't match SCOPE_PATTERN (defense
  // in depth — the admin UI's scope catalog is the
  // authoritative source).
  const granted = reqScopes.filter(
    (s) => clientScopes.includes(s) && SCOPE_PATTERN.test(s),
  );
  if (granted.length === 0) {
    return { scopes: [], error: "invalid_scope" };
  }
  return { scopes: granted };
}

/**
 * Mint an RS256 access token. The claims are:
 * - `iss` (the authority URL)
 * - `aud` (= `mcp:<app>` — the per-app audience)
 * - `sub` (the agent id; `client:<id>` for client_credentials,
 *   `user:<id>` for password/refresh)
 * - `scope` (space-delimited; the `scopes` claim is the
 *   same data, but `scope` is the canonical OAuth2 form
 *   for introspection)
 * - `iat` / `nbf` / `exp` (TTL = 3600s by default)
 *
 * The header includes `alg`, `kid`, `typ`.
 */
async function mintAccessToken(
  deps: TokenHandlerDeps,
  sub: string,
  scopes: string[],
): Promise<string> {
  const privateKey = await importSigningPrivateKey(deps.activeKey);
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    iss: deps.issuer,
    aud: deps.audience,
    sub,
    scope: scopes.join(" "),
    scopes: scopes, // also include as array (resource servers can pick)
    iat: now,
    nbf: now,
    exp: now + deps.accessTokenTtlSeconds,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: deps.activeKey.id, typ: "JWT" })
    .sign(privateKey);
}

/**
 * Read the form-encoded body. The token endpoint accepts
 * `application/x-www-form-urlencoded` per the OAuth2 spec.
 * We cap the body at 64 KiB to keep the request surface
 * small.
 */
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

/**
 * Mark `unused` so the linter doesn't complain about an
 * unused import. (The `withSingleWriter` import is used by
 * the caller, not by the handler itself.)
 */
void withSingleWriter;
