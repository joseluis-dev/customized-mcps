/**
 * HTTP transport configuration parser.
 *
 * The shape is fed by `process.env` at the app layer; we keep this pure so
 * the unit tests do not need to mutate `process.env`. The app (PR2) is
 * responsible for reading the env, calling this function, and exiting
 * non-zero with a stderr message on `HttpConfigError`.
 *
 * The shared base now only knows about the OAuth / JWKS authority
 * backends. The local HMAC roster (and its `MCP_AGENT_HMAC_SECRET` /
 * `MCP_AGENTS_JSON` / `MCP_AGENTS_INLINE` env vars) was removed; the
 * resource server is required to wire `MCP_AUTHORITY_URL` against an
 * external authority (`apps/mcp-oauth-admin` is the canonical target).
 *
 * Phase 1b of `external-token-authority-verification` adds six authority
 * env vars (MCP_AUTHORITY_URL, MCP_AUTHORITY_JWKS_URL, MCP_AUTHORITY_AUDIENCE,
 * MCP_AUTHORITY_JWKS_TTL_S, MCP_AUTHORITY_LEEWAY_S, MCP_AUTHORITY_FETCH_TIMEOUT_MS).
 * The integer fields have documented defaults (60/30/5000); the URL
 * fields are `undefined` when unset. When MCP_AUTHORITY_URL is set,
 * MCP_AUTHORITY_AUDIENCE is REQUIRED — the audit-safe posture is to
 * reject an empty audience so a token issued by the authority for any
 * other audience cannot be accepted.
 */

export type LogFormat = "text" | "json";

export type HttpConfigInput = {
  MCP_TRANSPORT: string | undefined;
  MCP_HTTP_HOST: string | undefined;
  MCP_HTTP_PORT: string | undefined;
  MCP_HTTP_PATH: string | undefined;
  MCP_HTTP_STATELESS: string | undefined;
  MCP_HTTP_SHUTDOWN_TIMEOUT_MS: string | undefined;
  MCP_LOG_FORMAT: string | undefined;
  MCP_HTTP_BEHIND_PROXY: string | undefined;
  /** Preferred opt-in: explicitly acknowledges that no TLS is in the app. */
  MCP_HTTP_ALLOW_INSECURE_BIND: string | undefined;
  /** Deprecated alias kept for backward compatibility. Prefer ALLOW_INSECURE_BIND. */
  MCP_HTTP_ALLOW_INSECURE_LOOPBACK: string | undefined;
  // Phase 1b (external-token-authority-verification):
  MCP_AUTHORITY_URL: string | undefined;
  MCP_AUTHORITY_JWKS_URL: string | undefined;
  MCP_AUTHORITY_AUDIENCE: string | undefined;
  MCP_AUTHORITY_JWKS_TTL_S: string | undefined;
  MCP_AUTHORITY_LEEWAY_S: string | undefined;
  MCP_AUTHORITY_FETCH_TIMEOUT_MS: string | undefined;
  /**
   * The resource server's own public base URL. The 401
   * `WWW-Authenticate` header and the `/.well-known/oauth-protected-resource`
   * body MUST point at the resource server's own base URL (RFC 9728 §5.1,
   * RFC 6750 §3), NOT the authority issuer. When unset, the server falls
   * back to the per-request `Host` header + `x-forwarded-proto` via
   * `resolveResourceServerBaseUrl` below.
   */
  MCP_RESOURCE_SERVER_URL: string | undefined;
};

export type HttpConfig = {
  host: string;
  port: number;
  path: string;
  stateless: boolean;
  shutdownTimeoutMs: number;
  logFormat: LogFormat;
  behindProxy: boolean;
  allowInsecureBind: boolean;
  // Phase 1b (external-token-authority-verification): the six
  // authority env vars. The OAuth admin / JWKS backend is the
  // only token-verify path on the resource server. When
  // `authorityUrl` is `undefined`, the app-side loader rejects
  // the configuration (the resource server MUST be wired to an
  // external authority). When set, the app uses the OAuth admin
  // / JWKS backend. The integer fields have the documented
  // defaults (60/30/5000). The audience is REQUIRED when the
  // URL is set.
  authorityUrl: string | undefined;
  authorityJwksUrl: string | undefined;
  authorityAudience: string | undefined;
  authorityJwksTtlSeconds: number;
  authorityLeewaySeconds: number;
  authorityFetchTimeoutMs: number;
  /**
   * The operator-configured resource server base URL. `undefined` means
   * the per-request `Host` header is the source of truth (see
   * `resolveResourceServerBaseUrl`). The shared config layer does NOT
   * default this to the authority URL — the resource server and
   * authorization server are separate origins, and the RFC 9728 metadata
   * MUST point at the resource server itself.
   */
  resourceServerUrl: string | undefined;
};

export class HttpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpConfigError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);

/**
 * Pure function that turns the env-shaped input into a validated HttpConfig.
 * Throws HttpConfigError on any constraint violation. Caller is expected to
 * catch and exit the process with the error message.
 */
export function parseHttpConfig(input: HttpConfigInput): HttpConfig {
  const host = (input.MCP_HTTP_HOST ?? "127.0.0.1").trim();
  const behindProxy = parseBoolean(input.MCP_HTTP_BEHIND_PROXY);
  // Accept the new, accurate flag name OR the legacy misleading name.
  const allowInsecureBind = parseBoolean(input.MCP_HTTP_ALLOW_INSECURE_BIND) ||
    parseBoolean(input.MCP_HTTP_ALLOW_INSECURE_LOOPBACK);

  if (!LOOPBACK_HOSTS.has(host)) {
    if (!behindProxy && !allowInsecureBind) {
      throw new HttpConfigError(
        `Refusing to bind non-loopback host "${host}" without an opt-in. ` +
          `Set MCP_HTTP_BEHIND_PROXY=true (production behind a TLS-terminating proxy) ` +
          `or MCP_HTTP_ALLOW_INSECURE_BIND=true (explicit dev/staging acknowledgement ` +
          `that TLS is the operator's responsibility). ` +
          `The legacy MCP_HTTP_ALLOW_INSECURE_LOOPBACK is accepted as a deprecated alias.`,
      );
    }
  }

  const port = parseStrictInteger(input.MCP_HTTP_PORT, 3000, "MCP_HTTP_PORT", 1, 65535);

  const path = (input.MCP_HTTP_PATH ?? "/mcp").trim();
  if (!path.startsWith("/")) {
    throw new HttpConfigError(
      `MCP_HTTP_PATH must start with "/"; got "${path}".`,
    );
  }

  // PR1 remediation: the default flipped to `stateless: true` because a
  // single cached `StreamableHTTPServerTransport` shared its session id
  // across all authenticated agents — a multi-agent isolation bug. The
  // safe default in v1 is per-request stateless transport (the factory
  // is called per request and the transport is closed at the end of
  // the request). Stateful mode is the opt-in (set
  // `MCP_HTTP_STATELESS=false`) and is documented as single-agent only:
  // the SDK's transport keeps a single sessionId per transport instance,
  // so a second agent presenting that sessionId would share the
  // transport surface. The transport's per-request scope is the only
  // safe multi-agent shape in v1.
  const stateless = input.MCP_HTTP_STATELESS === undefined
    ? true
    : parseBoolean(input.MCP_HTTP_STATELESS);

  const shutdownTimeoutMs = parseStrictInteger(
    input.MCP_HTTP_SHUTDOWN_TIMEOUT_MS,
    10000,
    "MCP_HTTP_SHUTDOWN_TIMEOUT_MS",
    1,
    Number.MAX_SAFE_INTEGER,
  );

  const logFormatRaw = (input.MCP_LOG_FORMAT ?? "text").trim();
  if (logFormatRaw !== "text" && logFormatRaw !== "json") {
    throw new HttpConfigError(
      `MCP_LOG_FORMAT must be "text" or "json"; got "${logFormatRaw}".`,
    );
  }

  // Phase 1b (external-token-authority-verification): the six
  // authority env vars. The integer fields have documented
  // defaults (60/30/5000). When MCP_AUTHORITY_URL is set,
  // MCP_AUTHORITY_AUDIENCE is REQUIRED — an empty audience would
  // let any token issued by the authority be accepted. The
  // shared config layer is permissive on the JWKS URL: the
  // app-side loader enforces the fail-closed check on the
  // (URL, JWKS URL) pair.
  const authorityUrl = nonEmpty(input.MCP_AUTHORITY_URL);
  const authorityAudience = nonEmpty(input.MCP_AUTHORITY_AUDIENCE);
  if (authorityUrl !== undefined && authorityAudience === undefined) {
    throw new HttpConfigError(
      `MCP_AUTHORITY_AUDIENCE is required when MCP_AUTHORITY_URL is set. ` +
        `An empty audience would let any token issued by the authority be accepted; ` +
        `the spec requires fail-closed on this field. Set MCP_AUTHORITY_AUDIENCE to the ` +
        `value the authority issues tokens for.`,
    );
  }
  const authorityJwksTtlSeconds = parseStrictInteger(
    input.MCP_AUTHORITY_JWKS_TTL_S,
    60,
    "MCP_AUTHORITY_JWKS_TTL_S",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const authorityLeewaySeconds = parseStrictInteger(
    input.MCP_AUTHORITY_LEEWAY_S,
    30,
    "MCP_AUTHORITY_LEEWAY_S",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const authorityFetchTimeoutMs = parseStrictInteger(
    input.MCP_AUTHORITY_FETCH_TIMEOUT_MS,
    5000,
    "MCP_AUTHORITY_FETCH_TIMEOUT_MS",
    1,
    Number.MAX_SAFE_INTEGER,
  );

  // The shared layer is transparent on `MCP_RESOURCE_SERVER_URL`: it
  // stores the value verbatim (post-trim). The per-request resolution
  // (config vs. `Host` + `x-forwarded-proto` fallback) lives in
  // `resolveResourceServerBaseUrl` so it can be unit-tested without
  // spinning up a real HTTP server.
  const resourceServerUrl = nonEmpty(input.MCP_RESOURCE_SERVER_URL);

  return {
    host,
    port,
    path,
    stateless,
    shutdownTimeoutMs,
    logFormat: logFormatRaw,
    behindProxy,
    allowInsecureBind,
    authorityUrl,
    authorityJwksUrl: nonEmpty(input.MCP_AUTHORITY_JWKS_URL),
    authorityAudience,
    authorityJwksTtlSeconds,
    authorityLeewaySeconds,
    authorityFetchTimeoutMs,
    resourceServerUrl,
  };
}

/**
 * Minimal structural request shape consumed by `resolveResourceServerBaseUrl`.
 * Exposing only `headers` keeps the resolver unit-testable from a plain
 * vitest test and reusable from the server (which has the real
 * `IncomingMessage` in scope).
 */
export type ResourceServerRequestLike = {
  headers: Record<string, string | string[] | undefined>;
};

/**
 * RFC 9728 protected-resource metadata document. `resource` is the
 * resource server's own public base URL; `authorization_servers` lists
 * OAuth authority issuers; `bearer_methods_supported` is hard-coded to
 * `["header"]` (token-in-query / token-in-body are out of scope for v1).
 */
export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
};

/**
 * Resolve the resource server's public base URL for a single request.
 *
 * Source of truth (in order):
 * 1. `config.resourceServerUrl` (the operator's `MCP_RESOURCE_SERVER_URL`).
 *    Trailing slashes are stripped so concatenation with the
 *    well-known path produces exactly one `/`.
 * 2. Per-request `Host` header, prefixed with the `x-forwarded-proto`
 *    scheme when the request came through a TLS-terminating proxy;
 *    otherwise `http://`. `x-forwarded-proto` may be a string or an
 *    array of strings; the first value wins.
 *
 * Throws `HttpConfigError` when neither source is available. The
 * resource server MUST be able to advertise an absolute URL — a
 * silent empty string would let a client fall through to a
 * relative-path well-known request that 404s.
 */
export function resolveResourceServerBaseUrl(
  config: Pick<HttpConfig, "resourceServerUrl">,
  request: ResourceServerRequestLike,
): string {
  if (config.resourceServerUrl) {
    return config.resourceServerUrl.replace(/\/+$/, "");
  }
  const host = readHeaderIgnoreCase(request.headers, "host");
  if (host === undefined || host.length === 0) {
    throw new HttpConfigError(
      "Cannot resolve resource server base URL: MCP_RESOURCE_SERVER_URL is unset " +
        "and the request has no Host header. Set MCP_RESOURCE_SERVER_URL on the " +
        "resource server, or ensure the request includes a Host header.",
    );
  }
  const forwardedProto = readHeaderIgnoreCase(request.headers, "x-forwarded-proto");
  const rawScheme = forwardedProto !== undefined
    ? forwardedProto.split(",")[0]?.trim() ?? ""
    : "";
  const scheme = rawScheme.length > 0 ? rawScheme : "http";
  return `${scheme}://${host}`;
}

/**
 * Read a single header value from a Node `IncomingMessage`-shaped
 * headers map. Multi-value headers are returned as the first value of
 * the array (e.g. `x-forwarded-proto` when chained proxies produce
 * a list).
 */
function readHeaderIgnoreCase(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

/**
 * Strict integer parser: requires the entire trimmed string to match a
 * base-10 integer. Rejects "3000abc", "1.5", and "  3000  " is fine
 * (trimmed). The min/max bounds are inclusive. Falls back to `defaultValue`
 * when the input is undefined or empty.
 */
function parseStrictInteger(
  raw: string | undefined,
  defaultValue: number,
  fieldName: string,
  min: number,
  max: number,
): number {
  const value = (raw ?? "").trim();
  if (value.length === 0) return defaultValue;
  if (!/^-?\d+$/.test(value)) {
    throw new HttpConfigError(
      `${fieldName} must be an integer in [${min}, ${max}]; got "${raw}".`,
    );
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpConfigError(
      `${fieldName} must be an integer in [${min}, ${max}]; got "${raw}".`,
    );
  }
  return n;
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.trim().toLowerCase() === "true";
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
