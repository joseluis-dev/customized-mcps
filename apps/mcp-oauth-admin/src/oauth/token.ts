/**
 * OAuth2 token endpoint.
 *
 * The mcp-oauth-authority spec requires:
 * - `POST /oauth/token` accepts `client_credentials`,
 *   `password`, `refresh_token`, and `authorization_code`
 *   grants.
 * - The response is an RS256 JWT with the spec claims
 *   (`iss`, `aud=mcp:<app>`, `sub`, `iat`, `nbf`, `exp`,
 *   `kid` header) and `expires_in=3600`. The JWT MUST
 *   NOT include a `scope` or `scopes` claim (PR 3 of
 *   `remove-scope-authorization` makes scope authorization
 *   inert; the access token grants access solely by
 *   being a validly issued RS256 JWT for the configured
 *   `aud`).
 * - The response body MUST NOT include a `scope` field.
 *   The OAuth2-standard shape is `access_token`,
 *   `token_type`, `expires_in`. No `scope`.
 * - Incoming `scope` request parameters are TOLERATED
 *   and IGNORED. The authority does NOT return
 *   `invalid_scope` based on a `scope` request value.
 * - `refresh_token` grant REJECTS tokens whose `revokedAt`
 *   is non-null with `400 invalid_grant`. Pre-PR3 refresh
 *   tokens that have a `scopes` column value (legacy
 *   storage) mint a scope-free access token — the
 *   stored value is inert.
 * - `authorization_code` grant REQUIRES PKCE S256, the
 *   `redirect_uri` MUST be byte-equal to the value bound
 *   to the `code`, the `code` is single-use, expires in
 *   ≤ 60 seconds, and the `sub` claim is `user:<agentId>`.
 *   Pre-PR3 codes that carry a `scopes` array (legacy
 *   consent storage) mint a scope-free access token.
 *
 * Audit-safety: errors MUST NOT include the supplied
 * password, the resolved `agentId`, the `clientId`, the
 * `keyHash`, the refresh-token plaintext, the
 * `code_verifier`, the `code_challenge`, the `code`, or
 * any authority / JWKS URL. The handler returns sanitized
 * error shapes; structured audit logging happens via the
 * `audit_log` table (the caller is expected to call the
 * `auditAppend` helper for the success/failure path).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SignJWT, type JWTPayload } from "jose";
import { createHash } from "node:crypto";
import { importSigningPrivateKey, type SigningKeyRecord } from "./keys.js";
import { verifyPassword } from "./passwords.js";
import { type AuthorityDatabase } from "../db/connection.js";
import { consumeCode, isLoopbackRedirectUri } from "./authorize.js";
import { BodyTooLargeError, readFormBody } from "./bodyReader.js";
import { readClientIp } from "./clientIp.js";
import { auditAppend } from "../admin/audit.js";
import { createLogger, type Logger } from "@customized-mcps/mcp-http-base";

/**
 * The dependencies the token handler needs. The wiring is
 * passed in by the app's main listener so the handler stays
 * driver-agnostic.
 *
 * `now` is a test-injection point. Production callers
 * omit it; the verifier phase (and unit tests) may pass a
 * custom clock so the TTL boundary (`expiresAt <= now`)
 * is deterministic. The value is the Unix-seconds
 * timestamp the handler passes to `consumeCode`.
 *
 * `defaultScope` is RETAINED as a required field for
 * backward compatibility with the v1 wiring in
 * `index.ts`. The field is no longer read (the PR 3
 * token endpoint does not resolve or emit scopes), but
 * the entrypoint still passes the value (the env
 * `MCP_OAUTH_DEFAULT_SCOPE` is the operator's stated
 * default for the authority; the field stays in the
 * wiring for forward-compat). Future changes can drop
 * the field; for this slice the field is a no-op.
 */
export type TokenHandlerDeps = {
  db: AuthorityDatabase;
  issuer: string;
  audience: string;
  /** @deprecated Retained for backward compatibility with
   *  the v1 wiring in `index.ts`; the field is no longer
   *  read (PR 3 of `remove-scope-authorization` ignores
   *  scope). */
  defaultScope: string;
  accessTokenTtlSeconds: number;
  activeKey: SigningKeyRecord;
  now?: () => number;
  /** Trust the `X-Forwarded-For` header for the audit
   *  `ip` column. The default is `false`: the direct TCP
   *  peer (`req.socket.remoteAddress`) is the source of
   *  truth, so a spoofed XFF cannot distort the audit
   *  attribution. Operators behind a TLS-terminating
   *  reverse proxy MUST set this to `true` (the app's
   *  `index.ts` wires it from `httpConfig.behindProxy` /
   *  `MCP_HTTP_BEHIND_PROXY=true`). Tests inject the
   *  value directly to drive both branches. */
  trustProxy?: boolean;
  /** Logger injection. Defaults to a text-format stderr
   *  logger. The token audit-failure log lines are
   *  intentionally sanitized — no body, no client_secret,
   *  no refresh-token, no code, no code_verifier, no
   *  raw scope. */
  logger?: Logger;
};

function getNow(deps: TokenHandlerDeps): number {
  return deps.now ? deps.now() : Math.floor(Date.now() / 1000);
}

/**
 * Construct the `POST /oauth/token` handler. The handler
 * parses the form-encoded body, dispatches on
 * `grant_type`, and writes the response.
 *
 * Client credentials may arrive in the form body or the
 * `Authorization: Basic` header. The handler reads the
 * header ONCE up-front and forwards it to the per-grant
 * helpers so the parsing is consistent.
 *
 * The handler is intentionally not async at the function
 * level — jose's `SignJWT` and argon2's `verify` are both
 * async, and the handler awaits them where needed.
 */
export function createTokenHandler(
  deps: TokenHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const trustProxy = deps.trustProxy ?? false;
  const logger: Logger = deps.logger ?? createLogger({ format: "text" });
  return async (req, res) => {
    if (req.method !== "POST") {
      return writeJson(res, 405, { error: "invalid_request" });
    }
    let params: URLSearchParams;
    try {
      params = await readFormBody(req);
    } catch (e) {
      // `BodyTooLargeError` is a typed signal from the
      // shared body reader. The stream is paused (NOT
      // destroyed) so we can write a sanitized JSON 400
      // — the pre-PR `req.destroy()` path converted the
      // 400 into a connection reset.
      if (e instanceof BodyTooLargeError) {
        logger.warn(
          `mcp-oauth-admin: token request body too large; reason=invalid_request`,
        );
        return writeJson(res, 400, { error: "invalid_request" });
      }
      throw e;
    }
    const authHeader = readAuthHeader(req);
    const ip = readClientIp(req, trustProxy);
    const grant = params.get("grant_type");
    if (grant === "client_credentials") {
      return handleClientCredentials(deps, params, res, authHeader, ip, logger);
    }
    if (grant === "password") {
      return handlePasswordGrant(deps, params, res, authHeader, ip, logger);
    }
    if (grant === "refresh_token") {
      return handleRefreshTokenGrant(deps, params, res, authHeader, ip, logger);
    }
    if (grant === "authorization_code") {
      return handleAuthorizationCodeGrant(deps, params, res, authHeader, ip, logger);
    }
    // Unrecognized `grant_type` is logged as a denied
    // audit row. The actor is the IP (no client / user
    // is known at this point). The reason is in a
    // sanitized WARN log line.
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.unknown_grant",
    );
    return writeJson(res, 400, { error: "unsupported_grant_type" });
  };
}

/**
 * Read the `Authorization` request header. The token
 * endpoint honors `Basic` only (the JWT-bearer scheme is
 * not supported as a client-auth method; the issued
 * access tokens themselves use `Bearer`). The function
 * returns the raw header value (no parsing) so the
 * per-grant helpers can match the exact scheme they
 * expect.
 */
function readAuthHeader(req: IncomingMessage): string | null {
  const raw = req.headers["authorization"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") return raw[0]!;
  return null;
}

/**
 * The `client_credentials` grant. Verifies the client_id +
 * client_secret against the `clients` table and mints a
 * JWT. The PR 3 contract: incoming `scope` is ignored;
 * the minted JWT is scope-free (no `scope` / `scopes`
 * claim); the response body does not include a `scope`
 * field.
 *
 * The client credentials may arrive in either the form body
 * (per RFC 6749 §2.3.1) or the `Authorization: Basic`
 * header (per RFC 6749 §2.3.1 + RFC 6749 §2.3.1). The
 * `extractClientCredentials` helper reads both with the
 * header taking precedence; an unauthenticated request
 * (neither) is `invalid_request` (400).
 */
async function handleClientCredentials(
  deps: TokenHandlerDeps,
  params: URLSearchParams,
  res: ServerResponse,
  authHeader: string | null,
  ip: string | null,
  logger: Logger,
): Promise<void> {
  const creds = extractClientCredentials(params, authHeader);
  if (!creds) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.client_credentials",
    );
    return writeJson(res, 400, { error: "invalid_request" });
  }
  const { clientId, clientSecret } = creds;
  // The `scopes` column is selected for the client row
  // because the row's other columns are read; the value
  // itself is INERT post-PR3 (scope authorization is
  // removed). The pre-PR3 `loadScopePrincipal` call is
  // gone — the new policy ignores both the client's
  // stored scopes and any incoming `scope` request
  // value.
  const rows = await deps.db.select<{
    id: number;
    clientSecretHash: string;
    scopes: string;
  }>("SELECT id, clientSecretHash, scopes FROM clients WHERE clientId = ?", [clientId]);
  const client = rows[0];
  if (!client) {
    // We have a `clientId` (from the form/header) but
    // no matching row. The audit actor is the IP — we
    // deliberately do NOT echo the supplied `clientId`
    // as the actor (an attacker probing for valid
    // clientIds would otherwise learn which IDs exist
    // from the audit log). The reason is in a
    // sanitized WARN line.
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.client_credentials",
    );
    return writeJson(res, 401, { error: "invalid_client" });
  }
  const ok = await verifyPassword(client.clientSecretHash, clientSecret);
  if (!ok) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.client_credentials",
    );
    return writeJson(res, 401, { error: "invalid_client" });
  }
  // Incoming `scope` is tolerated and ignored (the
  // value is read so the parser shape is uniform, but
  // it has NO effect on the minted token).
  void params.get("scope");
  const sub = `client:${clientId}`;
  const token = await mintAccessToken(deps, sub);
  await recordTokenOk(
    deps.db,
    logger,
    `client:${clientId}`,
    null,
    ip,
    getNow(deps),
    "token.client_credentials",
  );
  return writeJson(res, 200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: deps.accessTokenTtlSeconds,
  });
}

/**
 * The `password` grant. Verifies the user (username +
 * password against the `users` table) and the client, then
 * mints a JWT. The PR 3 contract: the pre-PR3 user/client
 * scope intersection is gone; the minted JWT is scope-free;
 * incoming `scope` is tolerated and ignored.
 *
 * The `requireChangeOnFirstLogin` flag is honored: when set
 * on the user row, the response is `400` (sanitized error),
 * no token is issued, and the caller MUST rotate the
 * password (the admin UI handles the rotation).
 *
 * Client credentials may arrive in either the form body
 * or the `Authorization: Basic` header. Same as
 * `client_credentials`.
 */
async function handlePasswordGrant(
  deps: TokenHandlerDeps,
  params: URLSearchParams,
  res: ServerResponse,
  authHeader: string | null,
  ip: string | null,
  logger: Logger,
): Promise<void> {
  const username = params.get("username") ?? "";
  const password = params.get("password") ?? "";
  if (!username || !password) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.password",
    );
    return writeJson(res, 400, { error: "invalid_request" });
  }
  const creds = extractClientCredentials(params, authHeader);
  if (!creds) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.password",
    );
    return writeJson(res, 400, { error: "invalid_request" });
  }
  const { clientId, clientSecret } = creds;
  // The `scopes` column on the user row is selected
  // because the row's other columns are read; the value
  // itself is INERT post-PR3 (scope authorization is
  // removed).
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
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.password",
    );
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  if (user.requireChangeOnFirstLogin === 1) {
    await recordTokenDenied(
      deps.db,
      logger,
      `user:${user.id}`,
      null,
      ip,
      getNow(deps),
      "token.password",
    );
    return writeJson(res, 400, { error: "password_change_required" });
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    await recordTokenDenied(
      deps.db,
      logger,
      `user:${user.id}`,
      null,
      ip,
      getNow(deps),
      "token.password",
    );
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
    await recordTokenDenied(
      deps.db,
      logger,
      `user:${user.id}`,
      null,
      ip,
      getNow(deps),
      "token.password",
    );
    return writeJson(res, 401, { error: "invalid_client" });
  }
  const clientOk = await verifyPassword(client.clientSecretHash, clientSecret);
  if (!clientOk) {
    await recordTokenDenied(
      deps.db,
      logger,
      `user:${user.id}`,
      null,
      ip,
      getNow(deps),
      "token.password",
    );
    return writeJson(res, 401, { error: "invalid_client" });
  }
  // Incoming `scope` is tolerated and ignored.
  void params.get("scope");
  const sub = `user:${user.id}`;
  const token = await mintAccessToken(deps, sub);
  await recordTokenOk(
    deps.db,
    logger,
    `user:${user.id}`,
    null,
    ip,
    getNow(deps),
    "token.password",
  );
  return writeJson(res, 200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: deps.accessTokenTtlSeconds,
  });
}

/**
 * The `refresh_token` grant. Looks up the refresh token
 * (SHA-256 of the plaintext against `tokenHash`), rejects
 * revoked tokens with `400 invalid_grant`, and mints a
 * new access token.
 *
 * The PR 3 contract: the minted access token is
 * scope-free regardless of the refresh token's `scopes`
 * column value. Pre-PR3 refresh tokens that carry a
 * `scopes` JSON array (legacy consent storage) mint
 * scope-free access tokens — the stored value is
 * INERT. Incoming `scope` is tolerated and ignored.
 *
 * Client credentials may arrive in the body or the
 * `Authorization: Basic` header (same as the other
 * grants).
 *
 * Audit-safe: the supplied refresh token NEVER appears in
 * any log line; the only logged shape is the granted/denied
 * outcome + reason code.
 */
async function handleRefreshTokenGrant(
  deps: TokenHandlerDeps,
  params: URLSearchParams,
  res: ServerResponse,
  authHeader: string | null,
  ip: string | null,
  logger: Logger,
): Promise<void> {
  const refreshToken = params.get("refresh_token") ?? "";
  if (!refreshToken) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.refresh_token",
    );
    return writeJson(res, 400, { error: "invalid_request" });
  }
  const creds = extractClientCredentials(params, authHeader);
  if (!creds) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.refresh_token",
    );
    return writeJson(res, 400, { error: "invalid_request" });
  }
  const { clientId, clientSecret } = creds;
  const tokenHash = createHash("sha256").update(refreshToken, "utf8").digest("hex");
  // The `scopes` column on the refresh_tokens row is
  // selected for the same reason as the other tables;
  // the value is INERT post-PR3 (scope authorization is
  // removed).
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
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.refresh_token",
    );
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  if (row.revokedAt !== null) {
    await recordTokenDenied(
      deps.db,
      logger,
      `user:${row.agentId}`,
      null,
      ip,
      getNow(deps),
      "token.refresh_token",
    );
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  // Verify the client matches the refresh token's client.
  const clientRows = await deps.db.select<{ id: number; clientId: string; clientSecretHash: string }>(
    "SELECT id, clientId, clientSecretHash FROM clients WHERE id = ?",
    [row.clientId],
  );
  const client = clientRows[0];
  if (!client || client.clientId !== clientId) {
    await recordTokenDenied(
      deps.db,
      logger,
      `user:${row.agentId}`,
      null,
      ip,
      getNow(deps),
      "token.refresh_token",
    );
    return writeJson(res, 401, { error: "invalid_client" });
  }
  const clientOk = await verifyPassword(client.clientSecretHash, clientSecret);
  if (!clientOk) {
    await recordTokenDenied(
      deps.db,
      logger,
      `user:${row.agentId}`,
      null,
      ip,
      getNow(deps),
      "token.refresh_token",
    );
    return writeJson(res, 401, { error: "invalid_client" });
  }
  // Incoming `scope` is tolerated and ignored.
  void params.get("scope");
  const sub = `user:${row.agentId}`;
  const token = await mintAccessToken(deps, sub);
  await recordTokenOk(
    deps.db,
    logger,
    `user:${row.agentId}`,
    null,
    ip,
    getNow(deps),
    "token.refresh_token",
  );
  return writeJson(res, 200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: deps.accessTokenTtlSeconds,
  });
}

/**
 * The `authorization_code` grant (Authorization Code + PKCE).
 *
 * Flow (per the mcp-oauth-authority spec):
 * 1. Read `code`, `redirect_uri`, `code_verifier`, and the
 *    client credentials from the form body OR the
 *    `Authorization: Basic` header.
 * 2. The `redirect_uri` MUST be loopback (RFC 8252 §7.3)
 *    and MUST byte-equal the value bound to the `code`.
 *    A non-loopback URI is rejected with `400 invalid_grant`.
 * 3. The client MUST be registered; the `client_secret`
 *    MUST verify against the stored hash. A failure is
 *    `400 invalid_client`.
 * 4. `consumeCode(code, now)` is single-use: a second
 *    call returns `null`. An expired code
 *    (`expiresAt <= now`) also returns `null`. The
 *    handler maps both to `400 invalid_grant` with a
 *    sanitized body.
 * 5. The PKCE check: the handler computes
 *    `base64url(sha256(code_verifier))` and compares it
 *    to the `code_challenge` bound to the `code`. A
 *    mismatch is `400 invalid_grant`.
 * 6. (Removed in PR 3) The pre-PR3 code re-derived a
 *    granted scope set at exchange time. The PR 3
 *    contract: the code's bound `scopes` field is
 *    INERT (legacy / compat-only); the minted access
 *    token is always scope-free.
 * 7. On success, the handler mints an RS256 JWT with
 *    `sub = user:<agentId>`. The response is the standard
 *    OAuth2 token shape (`access_token`, `token_type`,
 *    `expires_in`) — NO `scope` field.
 *
 * Audit-safety: every error path returns
 * `{ error: "invalid_grant" }` with no internal detail.
 * The supplied `code_verifier`, `code_challenge`, and
 * `clientId` are NEVER echoed in the response body.
 */
async function handleAuthorizationCodeGrant(
  deps: TokenHandlerDeps,
  params: URLSearchParams,
  res: ServerResponse,
  authHeader: string | null,
  ip: string | null,
  logger: Logger,
): Promise<void> {
  const code = params.get("code") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeVerifier = params.get("code_verifier") ?? "";
  if (code.length === 0 || redirectUri.length === 0 || codeVerifier.length === 0) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.authorization_code",
    );
    return writeJson(res, 400, { error: "invalid_request" });
  }
  const creds = extractClientCredentials(params, authHeader);
  if (!creds) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.authorization_code",
    );
    return writeJson(res, 400, { error: "invalid_request" });
  }
  const { clientId, clientSecret } = creds;
  // Enforce the loopback rule on the token request.
  // The spec is explicit: the token endpoint accepts
  // `redirect_uri` only when it matches RFC 8252 §7.3.
  // A non-loopback URI is a hostile-redirect attempt
  // and is rejected with `invalid_grant` (the body is
  // sanitized — no host or scheme is echoed).
  if (!isLoopbackRedirectUri(redirectUri)) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.authorization_code",
    );
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  // Verify the client. We do this BEFORE consuming the
  // code so a wrong `client_secret` does not burn a
  // valid code. The `401 invalid_client` is the same
  // shape the other grants use.
  const clientRows = await deps.db.select<{ id: number; clientSecretHash: string }>(
    "SELECT id, clientSecretHash FROM clients WHERE clientId = ?",
    [clientId],
  );
  const client = clientRows[0];
  if (!client) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.authorization_code",
    );
    return writeJson(res, 401, { error: "invalid_client" });
  }
  const clientOk = await verifyPassword(client.clientSecretHash, clientSecret);
  if (!clientOk) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.authorization_code",
    );
    return writeJson(res, 401, { error: "invalid_client" });
  }
  // Consume the code. `consumeCode` is single-use: the
  // second call returns `null` even within the TTL.
  // An expired code also returns `null`. Both cases
  // map to `invalid_grant` (the spec's mandated shape).
  const now = getNow(deps);
  const record = consumeCode(code, now);
  if (record === null) {
    await recordTokenDenied(
      deps.db,
      logger,
      null,
      null,
      ip,
      getNow(deps),
      "token.authorization_code",
    );
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  // Bind the code to the client. A code issued to
  // client-a MUST NOT be exchanged by client-b.
  if (record.clientId !== clientId) {
    await recordTokenDenied(
      deps.db,
      logger,
      `user:${record.agentId}`,
      null,
      ip,
      getNow(deps),
      "token.authorization_code",
    );
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  // Bind the code to the exact `redirect_uri` (the spec
  // is explicit: the comparison is byte-equal). A
  // different port, path, or query string is a hostile
  // open-redirect attempt and is rejected.
  if (record.redirectUri !== redirectUri) {
    await recordTokenDenied(
      deps.db,
      logger,
      `user:${record.agentId}`,
      null,
      ip,
      getNow(deps),
      "token.authorization_code",
    );
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  // PKCE S256 verify. The challenge is the value bound
  // to the code at issue time; the verifier is
  // supplied on the token request. The handler
  // computes `base64url(sha256(verifier))` and compares
  // it to the challenge. A mismatch is `invalid_grant`.
  const challenge = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  if (challenge !== record.codeChallenge) {
    await recordTokenDenied(
      deps.db,
      logger,
      `user:${record.agentId}`,
      null,
      ip,
      getNow(deps),
      "token.authorization_code",
    );
    return writeJson(res, 400, { error: "invalid_grant" });
  }
  // PR 3: the code's bound `scopes` field is INERT.
  // The minted access token is scope-free regardless
  // of any pre-PR3 `scopes` value the code may carry.
  void record.scopes;
  // Incoming `scope` is tolerated and ignored.
  void params.get("scope");
  // Mint the JWT. The `sub` is `user:<agentId>` so the
  // resource server can resolve the agent without an
  // extra DB lookup. The minted token is scope-free.
  const sub = `user:${record.agentId}`;
  const token = await mintAccessToken(deps, sub);
  await recordTokenOk(
    deps.db,
    logger,
    `user:${record.agentId}`,
    null,
    ip,
    getNow(deps),
    "token.authorization_code",
  );
  return writeJson(res, 200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: deps.accessTokenTtlSeconds,
  });
}

/**
 * Extract the OAuth client credentials from the form body
 * OR the `Authorization: Basic` header. The header is
 * preferred (RFC 6749 §2.3.1) — when present, the body
 * values are ignored. Returns `null` when neither side
 * has a usable pair (the caller maps this to
 * `400 invalid_request`).
 *
 * The Basic scheme decoding is per RFC 7617:
 *   Authorization: Basic base64(client_id ":" client_secret)
 * The colon separator is preserved verbatim (the password
 * MAY contain colons; the separator is the first colon).
 */
function extractClientCredentials(
  params: URLSearchParams,
  authHeader: string | null,
): { clientId: string; clientSecret: string } | null {
  if (authHeader !== null) {
    const m = authHeader.match(/^Basic\s+(\S+)\s*$/i);
    if (m) {
      try {
        const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
        const idx = decoded.indexOf(":");
        if (idx > 0) {
          const clientId = decoded.slice(0, idx);
          const clientSecret = decoded.slice(idx + 1);
          if (clientId.length > 0 && clientSecret.length > 0) {
            return { clientId, clientSecret };
          }
        }
      } catch {
        // Malformed base64 — fall through to body credentials.
      }
    }
  }
  const clientId = params.get("client_id") ?? "";
  const clientSecret = params.get("client_secret") ?? "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Mint an RS256 access token. The claims are:
 * - `iss` (the authority URL)
 * - `aud` (= `mcp:<app>` — the per-app audience)
 * - `sub` (the agent id; `client:<id>` for client_credentials,
 *   `user:<id>` for password/refresh)
 * - `iat` / `nbf` / `exp` (TTL = 3600s by default)
 *
 * The PR 3 contract: the JWT MUST NOT include a `scope`
 * or `scopes` claim. The pre-PR3 `scopes: string[]`
 * argument is dropped — the new helper takes only the
 * `sub` and the granted set is always `[]`.
 *
 * The header includes `alg`, `kid`, `typ`.
 */
async function mintAccessToken(
  deps: TokenHandlerDeps,
  sub: string,
): Promise<string> {
  const privateKey = await importSigningPrivateKey(deps.activeKey);
  // The `iat` / `nbf` / `exp` claims are derived from the
  // injected clock (NOT `Date.now()` directly). The
  // verifier phase and the integration tests pin a fixed
  // clock so the TTL boundary is deterministic; the
  // direct `Date.now()` call would defeat that.
  const now = getNow(deps);
  const payload: JWTPayload = {
    iss: deps.issuer,
    aud: deps.audience,
    sub,
    iat: now,
    nbf: now,
    exp: now + deps.accessTokenTtlSeconds,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: deps.activeKey.id, typ: "JWT" })
    .sign(privateKey);
}

/**
 * Append a sanitized "ok" audit row for a successful token
 * grant. Audit failures are non-fatal: the access token has
 * already been minted, so we log a sanitized WARN and
 * continue. The function NEVER echoes the supplied password,
 * the resolved `agentId`, the `clientId`, the `keyHash`, the
 * refresh-token plaintext, the `code_verifier`, the
 * `code_challenge`, the `code`, or any authority / JWKS URL.
 *
 * The `actor` is the principal who owns the issued token
 * (`client:<clientId>` for `client_credentials`,
 * `user:<agentId>` for the user-bound grants). The `target`
 * is null for `client_credentials` (no user) and null for
 * the user-bound grants (the target shape is the same; the
 * actor already disambiguates the principal).
 */
async function recordTokenOk(
  db: AuthorityDatabase,
  logger: Logger,
  actor: string,
  target: string | null,
  ip: string | null,
  now: number,
  action: string,
): Promise<void> {
  try {
    await auditAppend(db, {
      ts: now,
      actor,
      action,
      target,
      ip,
      outcome: "ok",
    });
  } catch (e) {
    logger.warn(
      `mcp-oauth-admin: token grant audit_append failed; reason=audit_failure`,
    );
    void e;
  }
}

/**
 * Append a sanitized "denied" audit row for a denied token
 * grant + emit a sanitized WARN line. The function is
 * best-effort: an audit failure is logged but does not
 * change the response. The actor is the IP (no client / user
 * is known at this point, or the actor is the principal
 * known up to the failure — see the per-handler call sites).
 * The reason is encoded in the action name (the spec's
 * "denied" outcome is uniform; the per-grant / per-reason
 * distinction lives in `action` so the audit viewer can
 * filter).
 */
async function recordTokenDenied(
  db: AuthorityDatabase,
  logger: Logger,
  actor: string | null,
  target: string | null,
  ip: string | null,
  now: number,
  action: string,
): Promise<void> {
  const finalActor =
    actor ?? `system:token:${ip ?? "unknown"}`;
  try {
    await auditAppend(db, {
      ts: now,
      actor: finalActor,
      action,
      target,
      ip,
      outcome: "denied",
    });
  } catch (e) {
    logger.warn(
      `mcp-oauth-admin: token denied-audit append failed; reason=audit_failure`,
    );
    void e;
  }
  logger.warn(
    `mcp-oauth-admin: token grant denied; action=${redactAction(action)}`,
  );
}

/**
 * Redact an action code before it lands in a log line. The
 * redaction is conservative: when in doubt, return
 * `token.unknown` (a stable token that does not leak any
 * operator-supplied input). The action is a stable code
 * emitted by the handler — never an end-user string — but
 * the redaction is a defense-in-depth measure so a future
 * code path that pipes an attacker-controlled value into
 * the action slot cannot exfiltrate via the log.
 */
function redactAction(action: string): string {
  if (typeof action !== "string" || action.length === 0) return "token.unknown";
  // Allow only `[a-z_.]{1,64}` to pass through. Anything
  // else collapses to `token.unknown`.
  if (!/^[a-z_.]{1,64}$/.test(action)) return "token.unknown";
  return action;
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
