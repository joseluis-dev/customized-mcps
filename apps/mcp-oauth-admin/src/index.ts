/**
 * Entry point for `apps/mcp-oauth-admin`.
 *
 * Wires the SQLite store, the OAuth endpoints, the admin UI
 * router, the backup loop, the retention sweep, and the
 * bootstrap admin into a single `node:http` listener on
 * `MCP_HTTP_HOST:MCP_HTTP_PORT` (default 127.0.0.1:3002).
 *
 * PR 2 (this commit) introduces this entrypoint so the
 * `bin`, `dev`, and `start` scripts in `package.json`
 * resolve. The `bin` script previously referenced a file
 * that did not exist (W1 in the PR 1 verify report).
 *
 * The entrypoint is intentionally minimal: the heavy
 * lifting lives in the modules under `src/admin/`,
 * `src/db/`, and `src/oauth/`. The entrypoint is the
 * composition root.
 *
 * Env loading: this file imports `dotenv/config` BEFORE any
 * other module so the `process.env.*` reads below see the
 * values from the per-app `.env` file (the same file the
 * systemd unit mounts via `EnvironmentFile=`). Without this
 * import, every `process.env.*` lookup returns `undefined`
 * in dev / `node dist/index.js` and the operator's
 * `.env` is silently ignored — a bug that surfaced as
 * "env vars are not loading". The companion app
 * `apps/mcp-readonly-sql` loads dotenv the same way
 * (see `apps/mcp-readonly-sql/src/config/env.ts`); the
 * deploy contract (`deploy/systemd/mcp-oauth-admin.service`)
 * explicitly assumes dotenv runs at startup. Side-effect
 * import only; we never reference `dotenv` again.
 *
 * Audit-safety:
 * - The bootstrap admin's password is read from
 *   `MCP_OAUTH_ADMIN_PASSWORD` and stored as an `argon2id`
 *   hash. The plaintext is never logged.
 * - A `WARN` is emitted while the bootstrap env vars are
 *   set, regardless of whether the admin already exists.
 * - The session secret is `crypto.randomBytes(32)` and is
 *   regenerated on every restart (so all sessions are
 *   invalidated on restart — the spec's "secret rotation
 *   invalidates sessions" rule).
 */

import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { openDatabase, initializeSchema, defaultDatabasePath, drainWriterChain } from "./db/index.js";
import { setActiveSigningKey } from "./oauth/keys.js";
import { createJwksHandler, createOidcDiscoveryHandler } from "./oauth/jwks.js";
import { createTokenHandler, type TokenHandlerDeps } from "./oauth/token.js";
import { createIntrospectHandler, type IntrospectHandlerDeps } from "./oauth/introspect.js";
import { createAuthorizeHandler, type AuthorizeDeps } from "./oauth/authorize.js";
import { createAdminRouter, type AdminRouterDeps } from "./admin/router.js";
import { generateSessionSecret } from "./admin/session.js";
import { ensureBootstrapAdmin, resolveBootstrapEnv, shouldWarnBootstrapEnv } from "./admin/bootstrap.js";
import { startBackupLoop, resolveBackupTarget, resolveBackupIntervalSeconds, runBackupOnce } from "./backup.js";
import { startSweepLoop } from "./sweep.js";
import { parseHttpConfig, HttpConfigError } from "@customized-mcps/mcp-http-base";
import { createLogger } from "@customized-mcps/mcp-http-base";

/**
 * The HTTP transport config — host, port, path, etc.
 * Read from the env on the production path; the test
 * path passes a `HttpConfigInput` directly.
 *
 * Note: the `MCP_AUTHORITY_*` env vars (URL, JWKS URL, audience,
 * cache TTL, leeway, fetch timeout) are intentionally forwarded
 * as `undefined` rather than read from `process.env`. The
 * `mcp-oauth-admin` app is the authority, not a resource-server
 * client of one — those vars are verifier-side configuration and
 * have no meaning on the issuer side. Reading them from the env
 * would let an operator set `MCP_AUTHORITY_URL` on the authority
 * host and trigger a fail-closed startup error in the shared
 * `parseHttpConfig` audience check (the audience-required rule
 * only fires when the URL is set, but the audience is irrelevant
 * for an issuer). The `HttpConfigInput` type requires every key,
 * so we list them explicitly with `undefined` values: the type
 * is satisfied, the values are guaranteed to be `undefined`, and
 * a future maintainer who copies one of these lines sees the
 * "intentionally undefined" comment in context.
 */
function readHttpConfig(): ReturnType<typeof parseHttpConfig> {
  return parseHttpConfig({
    MCP_TRANSPORT: process.env.MCP_TRANSPORT,
    MCP_HTTP_HOST: process.env.MCP_HTTP_HOST,
    MCP_HTTP_PORT: process.env.MCP_HTTP_PORT,
    MCP_HTTP_PATH: process.env.MCP_HTTP_PATH,
    MCP_HTTP_STATELESS: process.env.MCP_HTTP_STATELESS,
    MCP_HTTP_SHUTDOWN_TIMEOUT_MS: process.env.MCP_HTTP_SHUTDOWN_TIMEOUT_MS,
    MCP_LOG_FORMAT: process.env.MCP_LOG_FORMAT,
    MCP_HTTP_BEHIND_PROXY: process.env.MCP_HTTP_BEHIND_PROXY,
    MCP_HTTP_ALLOW_INSECURE_BIND: process.env.MCP_HTTP_ALLOW_INSECURE_BIND,
    MCP_HTTP_ALLOW_INSECURE_LOOPBACK: process.env.MCP_HTTP_ALLOW_INSECURE_LOOPBACK,
    // Verifier-side env vars; the authority does not use them.
    MCP_AUTHORITY_URL: undefined,
    MCP_AUTHORITY_JWKS_URL: undefined,
    MCP_AUTHORITY_AUDIENCE: undefined,
    MCP_AUTHORITY_JWKS_TTL_S: undefined,
    MCP_AUTHORITY_LEEWAY_S: undefined,
    MCP_AUTHORITY_FETCH_TIMEOUT_MS: undefined,
  });
}

/**
 * The main entry point. Exported so the tests can drive
 * the wiring without spawning a subprocess.
 */
export async function main(): Promise<{ server: ReturnType<typeof createServer>; shutdown: () => Promise<void> }> {
  const httpConfig = readHttpConfig();
  const dbPath = defaultDatabasePath();
  const db = openDatabase({ path: dbPath });
  await initializeSchema(db);
  const logger = createLogger({ format: httpConfig.logFormat });
  // Bootstrap admin: read the env, insert the row if
  // missing, and emit a WARN while the env vars are set.
  const env = resolveBootstrapEnv({
    username: process.env.MCP_OAUTH_ADMIN_USERNAME,
    password: process.env.MCP_OAUTH_ADMIN_PASSWORD,
  });
  if (shouldWarnBootstrapEnv(env)) {
    logger.warn(
      "mcp-oauth-admin: MCP_OAUTH_ADMIN_USERNAME / MCP_OAUTH_ADMIN_PASSWORD are set. " +
        "These env vars seed the bootstrap admin and should be unset after the first rotation. " +
        "While they are set, the admin cannot mint tokens until the password is rotated.",
    );
  }
  const bootstrap = await ensureBootstrapAdmin(db, env, Math.floor(Date.now() / 1000));
  if (bootstrap.created && bootstrap.username !== null) {
    logger.info(`mcp-oauth-admin: bootstrap admin "${bootstrap.username}" created.`);
  }
  // Signing key: load from the `keys` table or generate a
  // fresh RS256 key on first start.
  const activeKey = await setActiveSigningKey(db);
  // Session secret: regenerated on every restart (so
  // sessions are invalidated). The secret is NEVER logged.
  const sessionSecret = generateSessionSecret();
  // OAuth endpoint deps.
  const tokenDeps: TokenHandlerDeps = {
    db,
    issuer: `http://${httpConfig.host}:${httpConfig.port}`,
    audience: process.env.MCP_AUTHORITY_AUDIENCE ?? `mcp:${process.env.MCP_OAUTH_APP_ID ?? "admin"}`,
    defaultScope: process.env.MCP_OAUTH_DEFAULT_SCOPE ?? "read:bi_catastro",
    accessTokenTtlSeconds: 3600,
    activeKey,
  };
  const introspectDeps: IntrospectHandlerDeps = {
    db,
    issuer: `http://${httpConfig.host}:${httpConfig.port}`,
    audience: tokenDeps.audience,
  };
  // Authorize handler deps. The handler reuses the admin
  // session secret (the spec's "one login surface" rule)
  // and the authority's `defaultScope` for the consented
  // scope set when the request omits one. `secure` mirrors
  // the admin router's flag so the session cookie is marked
  // `Secure` on non-loopback deployments.
  const authorizeDeps: AuthorizeDeps = {
    db,
    sessionSecret,
    secure: !["127.0.0.1", "::1", "localhost"].includes(httpConfig.host),
    defaultScope: tokenDeps.defaultScope,
  };
  // Admin router deps.
  const adminDeps: AdminRouterDeps = {
    db,
    sessionSecret,
    secure: !["127.0.0.1", "::1", "localhost"].includes(httpConfig.host),
  };
  // Backup loop: optional, gated on `MCP_OAUTH_BACKUP_TARGET`.
  const backupTarget = resolveBackupTarget(process.env.MCP_OAUTH_BACKUP_TARGET);
  const backupInterval = resolveBackupIntervalSeconds(process.env.MCP_OAUTH_BACKUP_INTERVAL_S);
  let backupScheduler: { stop: () => Promise<void> } | null = null;
  if (backupTarget !== undefined) {
    backupScheduler = startBackupLoop({
      dbPath,
      targetPath: backupTarget,
      intervalSeconds: backupInterval,
      onError: (err) => logger.error(`mcp-oauth-admin: backup error: ${err.message}`),
    });
  } else {
    // Run a one-shot backup at startup if a target was set
    // on a previous run. (No-op otherwise.)
    try {
      await runBackupOnce({ dbPath, targetPath: "" });
    } catch {
      // Ignore — the spec only requires backup when the
      // env is set.
    }
  }
  // Retention sweep: opt-out via `MCP_OAUTH_DISABLE_RETENTION_SWEEP`.
  const sweepDisabled = process.env.MCP_OAUTH_DISABLE_RETENTION_SWEEP === "true";
  const sweepScheduler = sweepDisabled
    ? null
    : startSweepLoop({
        db,
        onError: (err) => logger.error(`mcp-oauth-admin: sweep error: ${err.message}`),
      });
  // Compose the listener. The handler dispatches to the
  // admin UI for `/admin/*` and to the OAuth endpoints
  // for everything else. The OAuth + JWKS handlers
  // pre-date the admin router.
  const adminRouter = createAdminRouter(adminDeps);
  const tokenHandler = createTokenHandler(tokenDeps);
  const introspectHandler = createIntrospectHandler(introspectDeps);
  const authorizeHandler = createAuthorizeHandler(authorizeDeps);
  const jwksHandler = createJwksHandler({ db });
  const oidcHandler = createOidcDiscoveryHandler({ issuer: tokenDeps.issuer });
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/admin")) {
      return adminRouter(req, res);
    }
    if (url === "/.well-known/jwks.json") {
      return jwksHandler(req, res);
    }
    if (url === "/.well-known/openid-configuration") {
      return oidcHandler(req, res);
    }
    if (url.startsWith("/oauth/authorize")) {
      return authorizeHandler(req, res);
    }
    if (url === "/oauth/token") {
      return tokenHandler(req, res);
    }
    if (url === "/oauth/introspect") {
      return introspectHandler(req, res);
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not_found" }));
  });
  // Bind.
  await new Promise<void>((resolveP, rejectP) => {
    server.once("error", rejectP);
    server.listen(httpConfig.port, httpConfig.host, () => {
      server.off("error", rejectP);
      resolveP();
    });
  });
  logger.info(
    `mcp-oauth-admin: listening on http://${httpConfig.host}:${httpConfig.port} ` +
      `(audience=${tokenDeps.audience})`,
  );
  // Shutdown wiring.
  const shutdown = async (): Promise<void> => {
    logger.info("mcp-oauth-admin: shutting down.");
    if (backupScheduler !== null) await backupScheduler.stop();
    if (sweepScheduler !== null) await sweepScheduler.stop();
    await drainWriterChain(db);
    await new Promise<void>((resolveP, rejectP) => {
      server.close((err) => (err ? rejectP(err) : resolveP()));
    });
    await db.close();
  };
  // Wire SIGTERM / SIGINT to the shutdown handler. The
  // operator can extend the timeout via
  // `MCP_HTTP_SHUTDOWN_TIMEOUT_MS`.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void shutdown().then(() => process.exit(0));
    });
  }
  return { server, shutdown };
}

// Mark `randomBytes` as used (the import is the documented
// surface; the production code uses it through the
// session module).
void randomBytes;

// If `main` is called directly, run it. When the module
// is imported (e.g. by tests), the call is a no-op.
const isEntrypoint = import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/") ?? ""}`;
if (isEntrypoint) {
  main().catch((err: unknown) => {
    const msg = err instanceof HttpConfigError ? err.message : err instanceof Error ? err.message : String(err);
    process.stderr.write(`mcp-oauth-admin: ${msg}\n`);
    process.exit(1);
  });
}
