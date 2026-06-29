/**
 * HTTP runtime config loader for the mcp-readonly-sql app.
 *
 * This module is the app-side glue between:
 * - the env contract documented in `.env.example` (single source of truth)
 * - the shared `@customized-mcps/mcp-http-base` package, which owns the actual
 *   `parseHttpConfig` primitive and the `OAuthAdminAuthority` / `JwksAuthority`
 *   classes.
 *
 * The function is pure from a dependency-injection point of view: it
 * reads `process.env` directly because env vars are the only source of
 * truth for runtime configuration, but it does NOT mutate env, register
 * signal handlers, or start any transport. The entrypoint calls this,
 * then hands the result to `transports/http.ts` which calls
 * `createHttpMcpServer`.
 *
 * Error policy (per the `mcp-agent-authorization` spec): every failure
 * is fatal at startup. The shared base already enforces strict numeric
 * parsing, loopback-only default, and audience-required-on-authority;
 * this module fails closed when `MCP_AUTHORITY_URL` is missing because
 * the local HMAC roster backend was removed — the resource server MUST
 * be wired to an external authority.
 *
 * The `sessionMode` field is derived from the `MCP_HTTP_STATELESS` flag
 * so the app side never has to remember the boolean-to-string mapping.
 * PR1 re-review flipped the default to stateless; the app honors that
 * by mapping `undefined` to "stateless".
 *
 * Phase 1b (external-token-authority-verification) adds the
 * authority-backend selection: when MCP_AUTHORITY_URL is set the
 * app uses the OAuth admin authority (PR 1 of
 * oauth-sqlite-admin-authorization) and the startup probe (`warm()`)
 * is awaited before the config loader returns. A probe failure
 * throws an `HttpRuntimeConfigError` so the entrypoint can exit
 * non-zero with a stderr message that names the authority host
 * (not the JWKS path or any query string).
 *
 * Backend selection (mirrored by `authorityBackend`):
 * - `MCP_AUTHORITY_URL` unset  → fail closed (`HttpRuntimeConfigError`)
 * - `MCP_AUTHORITY_URL` set    → `OAuthAdminAuthority`   (`"oauth"`)
 *
 * The `OAuthAdminAuthority` extends `JwksAuthority` (it
 * inherits the JWKS-based `verify()` and adds an introspect
 * probe on `warm()`). The `verify` path is unchanged: each
 * request still resolves the JWT against the authority's
 * JWKS with a 60s cache + `kid`-miss refetch.
 */

import {
  parseHttpConfig,
  HttpConfigError,
  OAuthAdminAuthority,
  type HttpConfig,
  type SessionMode,
  type TokenAuthority,
} from "@customized-mcps/mcp-http-base";

/**
 * The audit-safe label that `/healthz` exposes. The value is
 * deterministic given the env: `"oauth"` when MCP_AUTHORITY_URL
 * is set (the only supported backend on the resource server). The
 * label MUST NOT include tokens, `kid`, JWKS URL, or authority URL.
 */
export type AuthorityBackend = "oauth" | "jwks";

/**
 * The runtime config the HTTP transport needs to start the shared server.
 * It is the union of the validated `HttpConfig` (from the shared base)
 * plus the derived `sessionMode` literal that the shared base expects on
 * the wire, the resolved `TokenAuthority` (Phase 1b + PR 1 of
 * oauth-sqlite-admin-authorization), and the audit-safe `authorityBackend`
 * label for `/healthz`.
 */
export type HttpRuntimeConfig = HttpConfig & {
  sessionMode: SessionMode;
  /**
   * Chunked-body opt-in. The shared base treats `false` and `undefined`
   * identically (rejects with 411). The app reads
   * `MCP_HTTP_ALLOW_UNBOUNDED_BODY` from the env and defaults to
   * `false` (the safe closed-by-default). The HTTP transport forwards
   * this value verbatim to `createHttpMcpServer`.
   */
  allowUnboundedBody: boolean;
  /**
   * The resolved `TokenAuthority`. Phase 1a introduced the
   * abstraction; Phase 1b adds the JWKS backend; PR 1 of
   * oauth-sqlite-admin-authorization adds the OAuth admin
   * authority. The HTTP transport forwards this to
   * `createHttpMcpServer`. The shared base's middleware calls
   * `authority.verify(token)` for every request.
   */
  authority: TokenAuthority;
  /**
   * The audit-safe label for `/healthz`. `"oauth"` when
   * MCP_AUTHORITY_URL is set (the `OAuthAdminAuthority` wrapper).
   * The value MUST NOT include tokens, `kid`, JWKS URL, or
   * authority URL.
   */
  authorityBackend: AuthorityBackend;
};

export class HttpRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpRuntimeConfigError";
  }
}
/**
 * Strict boolean parser that mirrors the shared base's `parseBoolean`
 * semantics: only the literal string "true" (trimmed, case-insensitive)
 * is truthy. Every other value (including "1", "yes", "on", "") is
 * false. The shared base does not export this helper, so we keep a
 * private copy here to avoid leaking app internals into the public API
 * of `@customized-mcps/mcp-http-base`.
 */
function parseBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.trim().toLowerCase() === "true";
}

/**
 * Construct the `TokenAuthority` for the current env. The resource
 * server is wired against an external authority; the only supported
 * backend is `OAuthAdminAuthority` (production-shape class extending
 * `JwksAuthority`). The authority is constructed and its `warm()`
 * probe is awaited so a misconfigured authority URL fails fast at
 * startup.
 *
 * Errors thrown by the `warm()` probe (or by the
 * `OAuthAdminAuthority` constructor) are wrapped in
 * `HttpRuntimeConfigError` so the entrypoint can exit non-zero
 * with a stderr message that names the authority host.
 */
async function buildAuthority(
  http: HttpConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): Promise<TokenAuthority> {
  if (http.authorityUrl === undefined) {
    throw new HttpRuntimeConfigError(
      "MCP_AUTHORITY_URL is required. The local HMAC roster backend was removed; " +
        "the resource server must be wired against an external OAuth authority. " +
        "Set MCP_AUTHORITY_URL to the authority host (e.g. the mcp-oauth-admin app on " +
        "port 3002) and MCP_AUTHORITY_AUDIENCE to the value the authority issues tokens for. " +
        "See deploy/README.md → \"Choose your backend\" for the deployment topology.",
    );
  }
  // The (URL, audience) pair check is enforced by the shared
  // `parseHttpConfig` layer: when MCP_AUTHORITY_URL is set, an empty
  // `MCP_AUTHORITY_AUDIENCE` throws `HttpConfigError` and the
  // loader below wraps it in `HttpRuntimeConfigError`. The shared
  // layer is the single source of truth for the audience-required
  // check. The narrow below is a TypeScript-only guard so we can
  // pass `http.authorityAudience` (typed `string | undefined`) to
  // the `audience` field on the authority options (typed `string`).
  // At runtime the branch is unreachable because the shared layer
  // already rejected the empty-audience case; we still throw a
  // matching error so any future regression in the shared layer
  // surfaces here with a clear message rather than as a
  // `TypeError: undefined is not assignable to string`.
  if (http.authorityAudience === undefined) {
    throw new HttpRuntimeConfigError(
      "MCP_AUTHORITY_AUDIENCE is required when MCP_AUTHORITY_URL is set. " +
        "Set MCP_AUTHORITY_AUDIENCE to the value the authority issues tokens for.",
    );
  }
  const jwksUrl = http.authorityJwksUrl ?? defaultJwksUrl(http.authorityUrl);
  const auth = new OAuthAdminAuthority({
    issuer: http.authorityUrl,
    jwksUrl,
    audience: http.authorityAudience,
    ttlSeconds: http.authorityJwksTtlSeconds,
    leewaySeconds: http.authorityLeewaySeconds,
    fetchTimeoutMs: http.authorityFetchTimeoutMs,
    logger,
  });
  try {
    await auth.warm?.();
  } catch (e) {
    const url = new URL(http.authorityUrl);
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    const message = e instanceof Error ? e.message : String(e);
    throw new HttpRuntimeConfigError(
      `Authority probe failed for ${url.host}${basePath}: ${message}. ` +
        `Verify MCP_AUTHORITY_URL is reachable.`,
    );
  }
  return auth;
}

/**
 * Compute the default JWKS URL from the authority URL using the
 * OIDC well-known convention. Keeps the env file short for the
 * common case (a sibling MCP that serves its JWKS at the standard
 * path). Operators that need a non-standard JWKS path can still
 * set MCP_AUTHORITY_JWKS_URL explicitly.
 */
function defaultJwksUrl(authorityUrl: string): string {
  const url = new URL(authorityUrl);
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.protocol}//${url.host}${basePath}/.well-known/jwks.json`;
}

/**
 * Pure-from-the-outside function that reads the relevant env vars and
 * returns a validated `HttpRuntimeConfig`. Throws on any constraint
 * violation; the entrypoint is responsible for translating the error
 * to a non-zero process exit.
 */
export async function loadHttpRuntimeConfig(): Promise<HttpRuntimeConfig> {
  const httpInput: Parameters<typeof parseHttpConfig>[0] = {
    MCP_TRANSPORT: process.env.MCP_TRANSPORT,
    MCP_HTTP_HOST: process.env.MCP_HTTP_HOST,
    // Spec "Port Allocation Convention": mcp-readonly-sql MUST default to
    // MCP_HTTP_PORT=3001. The shared base defaults to 3000, so the app
    // overrides the default here. Explicit `MCP_HTTP_PORT` env still wins.
    MCP_HTTP_PORT: process.env.MCP_HTTP_PORT ?? "3001",
    MCP_HTTP_PATH: process.env.MCP_HTTP_PATH,
    MCP_HTTP_STATELESS: process.env.MCP_HTTP_STATELESS,
    MCP_HTTP_SHUTDOWN_TIMEOUT_MS: process.env.MCP_HTTP_SHUTDOWN_TIMEOUT_MS,
    MCP_LOG_FORMAT: process.env.MCP_LOG_FORMAT,
    MCP_HTTP_BEHIND_PROXY: process.env.MCP_HTTP_BEHIND_PROXY,
    MCP_HTTP_ALLOW_INSECURE_BIND: process.env.MCP_HTTP_ALLOW_INSECURE_BIND,
    MCP_HTTP_ALLOW_INSECURE_LOOPBACK: process.env.MCP_HTTP_ALLOW_INSECURE_LOOPBACK,
    MCP_AUTHORITY_URL: process.env.MCP_AUTHORITY_URL,
    MCP_AUTHORITY_JWKS_URL: process.env.MCP_AUTHORITY_JWKS_URL,
    MCP_AUTHORITY_AUDIENCE: process.env.MCP_AUTHORITY_AUDIENCE,
    MCP_AUTHORITY_JWKS_TTL_S: process.env.MCP_AUTHORITY_JWKS_TTL_S,
    MCP_AUTHORITY_LEEWAY_S: process.env.MCP_AUTHORITY_LEEWAY_S,
    MCP_AUTHORITY_FETCH_TIMEOUT_MS: process.env.MCP_AUTHORITY_FETCH_TIMEOUT_MS,
  };

  let http: HttpConfig;
  try {
    http = parseHttpConfig(httpInput);
  } catch (e) {
    if (e instanceof HttpConfigError) {
      throw new HttpRuntimeConfigError(e.message);
    }
    throw e;
  }

  // Select the authority backend. The OAuth admin path awaits
  // `warm()` so a misconfigured authority URL fails fast at
  // startup. A missing `MCP_AUTHORITY_URL` fails closed — the
  // local HMAC roster backend was removed and the resource
  // server MUST be wired to an external authority.
  const stderrLogger = {
    info: (msg: string) => process.stderr.write(`[mcp-readonly-sql] ${msg}\n`),
    warn: (msg: string) => process.stderr.write(`[mcp-readonly-sql] ${msg}\n`),
    error: (msg: string) => process.stderr.write(`[mcp-readonly-sql] ${msg}\n`),
  };
  const authority = await buildAuthority(http, stderrLogger);

  return {
    ...http,
    sessionMode: http.stateless ? "stateless" : "stateful",
    allowUnboundedBody: parseBoolean(process.env.MCP_HTTP_ALLOW_UNBOUNDED_BODY),
    authority,
    authorityBackend: "oauth",
  };
}
