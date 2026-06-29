/**
 * HTTP runtime config loader for the mcp-readonly-sql app.
 *
 * This module is the app-side glue between:
 * - the env contract documented in `.env.example` (single source of truth)
 * - the shared `@customized-mcps/mcp-http-base` package, which owns the actual
 *   `parseHttpConfig` and `loadAgents` primitives
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
 * parsing, loopback-only default, and HMAC secret length; this module
 * adds the agents loader (JSON or INLINE) on top of that, and maps
 * missing/invalid agent config to a clear stderr-friendly error.
 *
 * The `sessionMode` field is derived from the `MCP_HTTP_STATELESS` flag
 * so the app side never has to remember the boolean-to-string mapping.
 * PR1 re-review flipped the default to stateless; the app honors that
 * by mapping `undefined` to "stateless".
 *
 * Phase 1b (external-token-authority-verification) adds the
 * authority-backend selection: when MCP_AUTHORITY_URL is unset the
 * app uses the local roster (dev/offline fallback); when set, the
 * app uses the OAuth admin authority (PR 1 of
 * oauth-sqlite-admin-authorization) and the startup probe (`warm()`)
 * is awaited before the config loader returns. A probe failure
 * throws an `HttpRuntimeConfigError` so the entrypoint can exit
 * non-zero with a stderr message that names the authority host
 * (not the JWKS path or any query string).
 *
 * The local roster (HMAC) backend stays available as a dev/offline
 * fallback until Phase 5 of oauth-sqlite-admin-authorization. The
 * selected backend is exposed on `/healthz` via the
 * `authorityBackend` field (audit-safe label, no tokens).
 *
 * Backend selection (mirrored by `authorityBackend`):
 * - `MCP_AUTHORITY_URL` unset  → `LocalRosterAuthority`  (`"local"`)
 * - `MCP_AUTHORITY_URL` set    → `OAuthAdminAuthority`   (`"oauth"`)
 *
 * The `OAuthAdminAuthority` extends `JwksAuthority` (it
 * inherits the JWKS-based `verify()` and adds an introspect
 * probe on `warm()`). The `verify` path is unchanged: each
 * request still resolves the JWT against the authority's
 * JWKS with a 60s cache + `kid`-miss refetch.
 */

import { readFileSync } from "node:fs";
import {
  parseHttpConfig,
  HttpConfigError,
  loadAgents,
  LocalRosterAuthority,
  JwksAuthority,
  OAuthAdminAuthority,
  type AgentRecord,
  type HttpConfig,
  type SessionMode,
  type TokenAuthority,
} from "@customized-mcps/mcp-http-base";

/**
 * The audit-safe label that `/healthz` exposes. The value is
 * deterministic given the env: `"local"` when MCP_AUTHORITY_URL is
 * unset, `"oauth"` when set. The label MUST NOT include tokens,
 * `kid`, JWKS URL, or authority URL.
 */
export type AuthorityBackend = "local" | "oauth" | "jwks";

/**
 * The runtime config the HTTP transport needs to start the shared server.
 * It is the union of the validated `HttpConfig` (from the shared base)
 * plus the loaded `AgentRecord[]`, the derived `sessionMode` literal
 * that the shared base expects on the wire, the resolved
 * `TokenAuthority` (Phase 1b + PR 1 of oauth-sqlite-admin-authorization),
 * and the audit-safe `authorityBackend` label for `/healthz`.
 */
export type HttpRuntimeConfig = HttpConfig & {
  agents: AgentRecord[];
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
   * The audit-safe label for `/healthz`. `"local"` when
   * MCP_AUTHORITY_URL is unset; `"oauth"` when set (the
   * `OAuthAdminAuthority` wrapper). The value MUST NOT
   * include tokens, `kid`, JWKS URL, or authority URL.
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
 * Construct the `TokenAuthority` for the current env. When
 * MCP_AUTHORITY_URL is unset the local-roster backend is selected
 * (dev/offline fallback); when set, the OAuth admin authority is
 * selected (production / shared deployment). The local backend is
 * constructed eagerly so any agent-config error surfaces here;
 * the OAuth admin authority is constructed and its `warm()` probe
 * is awaited so a misconfigured authority URL fails fast at startup.
 *
 * Errors thrown by the `warm()` probe (or by the
 * `OAuthAdminAuthority` constructor) are wrapped in
 * `HttpRuntimeConfigError` so the entrypoint can exit non-zero
 * with a stderr message that names the authority host.
 *
 * PR 1 of oauth-sqlite-admin-authorization selects
 * `OAuthAdminAuthority` (which is the production-shape class
 * extending `JwksAuthority`). The `JwksAuthority` class is
 * still imported so future test surfaces / fallback paths
 * can construct it directly; the app-side loader prefers the
 * `OAuthAdminAuthority` wrapper when MCP_AUTHORITY_URL is set.
 */
async function buildAuthority(
  http: HttpConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): Promise<{ authority: TokenAuthority; backend: AuthorityBackend }> {
  if (http.authorityUrl === undefined) {
    // Local-roster backend. The `agents` list and HMAC secret are
    // still loaded below (this function is called BEFORE the agents
    // are loaded, so we construct the authority lazily here with
    // a note). The actual `LocalRosterAuthority` is constructed in
    // the caller with the loaded agents + secret.
    //
    // We do NOT return early — the caller will substitute the
    // local authority once the agents are loaded. To keep the
    // shape simple, we return a sentinel and let the caller build
    // the local authority.
    return { authority: sentinelLocalAuthority(), backend: "local" };
  }
  // OAuth admin authority (PR 1 of
  // oauth-sqlite-admin-authorization). The shared base's
  // `parseHttpConfig` already rejected the case where
  // `authorityUrl` is set but `authorityAudience` is empty;
  // we still assert for the TypeScript narrowing.
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
        `Set MCP_AUTHORITY_URL (or unset it to use the local backend).`,
    );
  }
  return { authority: auth, backend: "oauth" };
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
 * Sentinel: the local backend is constructed with the loaded agents
 * + HMAC secret AFTER they are resolved. `buildAuthority` returns
 * this sentinel so the caller knows to substitute. We mark it
 * with a brand so the caller cannot accidentally use it before
 * substitution.
 */
function sentinelLocalAuthority(): TokenAuthority {
  return {
    verify: () => {
      throw new Error(
        "sentinelLocalAuthority.verify called before agents were loaded; this is a bug in loadHttpRuntimeConfig",
      );
    },
  };
}

/**
 * The one-shot local-roster deprecation WARN text.
 *
 * The `mcp-agent-authorization` spec (PR 3 of
 * `oauth-sqlite-admin-authorization`) requires the resource
 * server to log a one-shot WARN at startup naming the three
 * local-roster env vars when the local backend is active. The
 * WARN points operators at the migration path
 * (`deploy/README.md` and `mcp-oauth-admin` / the OAuth
 * authority).
 *
 * The text is a pure constant so the helper below can be
 * unit-tested in isolation; the constant lives in a function
 * (not a top-level `const`) so a future maintainer can
 * localise it without changing the test surface.
 */
export function localRosterDeprecationWarnMessage(): string {
  return (
    "WARN: the local HMAC roster is deprecated and will be removed in a future version. " +
    "MCP_AGENTS_JSON, MCP_AGENTS_INLINE, and MCP_AGENT_HMAC_SECRET are the deprecated env vars. " +
    "Migrate to the OAuth admin authority (`mcp-oauth-admin` on port 3002); see deploy/README.md " +
    "and openspec/changes/oauth-sqlite-admin-authorization/specs/mcp-oauth-authority/spec.md for the migration path."
  );
}

/**
 * Module-level one-shot flag. The spec requires "exactly
 * once per process"; the lifetime is the module's lifetime
 * (which IS the process lifetime in production — vitest
 * tests reset the flag explicitly via
 * `_resetLocalRosterWarnState`).
 */
let _localRosterWarnedThisProcess = false;

/**
 * Test-only: clear the one-shot flag so a fresh emit is
 * possible. Production code MUST NOT call this (the spec
 * forbids re-emitting in a process). The leading underscore
 * is the convention for "private / test-only" exports.
 */
export function _resetLocalRosterWarnState(): void {
  _localRosterWarnedThisProcess = false;
}

/**
 * Test-only: returns the current value of the one-shot
 * flag. Production code MUST NOT depend on this; it exists
 * so the test suite can assert the flag flipped after the
 * first emit and reset after `_resetLocalRosterWarnState`.
 */
export function _hasEmittedLocalRosterWarn(): boolean {
  return _localRosterWarnedThisProcess;
}

/**
 * Emit the one-shot local-roster deprecation WARN. The
 * function is a no-op when the backend is NOT local
 * (the spec scenario: "the line is not emitted" when
 * `MCP_AUTHORITY_URL` is set). The function is a no-op on
 * subsequent calls within the same process (the spec
 * scenario: "Emitted exactly once per process").
 *
 * Returns `true` when the WARN was emitted, `false`
 * otherwise. The boolean is the test surface; production
 * callers ignore it.
 *
 * The logger argument is a minimal `{ warn(msg: string): void }`
 * shape so the helper does not depend on the
 * `@customized-mcps/mcp-http-base` `Logger` interface (the
 * resource server's stderr-logger in `loadHttpRuntimeConfig`
 * matches the shape structurally; we keep the helper
 * dependency-free to make it trivial to unit-test).
 */
export function emitLocalRosterDeprecationWarn(
  backend: AuthorityBackend,
  logger: { warn: (msg: string) => void },
): boolean {
  if (backend !== "local") return false;
  if (_localRosterWarnedThisProcess) return false;
  _localRosterWarnedThisProcess = true;
  logger.warn(localRosterDeprecationWarnMessage());
  return true;
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
    MCP_AGENT_HMAC_SECRET: process.env.MCP_AGENT_HMAC_SECRET,
    MCP_AGENTS_JSON: process.env.MCP_AGENTS_JSON,
    MCP_AGENTS_INLINE: process.env.MCP_AGENTS_INLINE,
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
  // startup; the local path is constructed lazily after the
  // agents are loaded.
  const stderrLogger = {
    info: (msg: string) => process.stderr.write(`[mcp-readonly-sql] ${msg}\n`),
    warn: (msg: string) => process.stderr.write(`[mcp-readonly-sql] ${msg}\n`),
    error: (msg: string) => process.stderr.write(`[mcp-readonly-sql] ${msg}\n`),
  };
  const { authority: builtAuthority, backend } = await buildAuthority(http, stderrLogger);

  // For the OAuth admin backend the agents are NOT required
  // (the authority issues and validates tokens; no local
  // roster is needed). The local backend still needs the
  // agents.
  if (backend === "oauth") {
    // The local-roster deprecation WARN is suppressed on the
    // OAuth admin backend (the spec scenario: "the line is
    // not emitted" when `MCP_AUTHORITY_URL` is set). The
    // helper is a no-op on non-local backends; the call is
    // explicit so the wiring is greppable in PR review.
    emitLocalRosterDeprecationWarn(backend, stderrLogger);
    return {
      ...http,
      agents: [],
      sessionMode: http.stateless ? "stateless" : "stateful",
      allowUnboundedBody: parseBoolean(process.env.MCP_HTTP_ALLOW_UNBOUNDED_BODY),
      authority: builtAuthority,
      authorityBackend: "oauth",
    };
  }

  // Local backend: load the agents from MCP_AGENTS_JSON (wins) or
  // MCP_AGENTS_INLINE (fallback). Per the mcp-agent-authorization
  // spec, missing both fails closed.
  let agentsJson: string;
  if (http.agentsJsonPath) {
    try {
      agentsJson = readFileSync(http.agentsJsonPath, "utf8");
    } catch (e) {
      throw new HttpRuntimeConfigError(
        `Failed to read MCP_AGENTS_JSON file at "${http.agentsJsonPath}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  } else if (http.agentsInline !== undefined) {
    agentsJson = http.agentsInline;
  } else {
    throw new HttpRuntimeConfigError(
      "HTTP mode requires at least one agent configured. " +
        "Set MCP_AGENTS_JSON (path to a JSON file) or MCP_AGENTS_INLINE (raw JSON string) " +
        "in the env. See apps/mcp-readonly-sql/.env.example for the format.",
    );
  }

  let agents: AgentRecord[];
  try {
    agents = loadAgents(agentsJson);
  } catch (e) {
    // The shared base throws plain Errors with parse/validation context.
    // Wrap so the entrypoint only needs to catch one error type.
    const message = e instanceof Error ? e.message : String(e);
    throw new HttpRuntimeConfigError(`Failed to load agent config: ${message}`);
  }

  if (agents.length === 0) {
    throw new HttpRuntimeConfigError(
      "HTTP mode requires at least one agent in MCP_AGENTS_JSON or MCP_AGENTS_INLINE; " +
        "received an empty list. Add at least one record with id, keyHash, and scopes.",
    );
  }

  const localAuthority = new LocalRosterAuthority({
    agents,
    hmacSecret: http.hmacSecret,
    logger: stderrLogger,
  });

  // Local-roster deprecation WARN (PR 3 of
  // oauth-sqlite-admin-authorization, Phase 5.1). The spec
  // mandates: "When the local backend is active, the
  // resource server MUST log a one-shot WARN at startup
  // naming MCP_AGENTS_JSON, MCP_AGENTS_INLINE, and
  // MCP_AGENT_HMAC_SECRET as deprecated. Emitted exactly
  // once per process; points to deploy/README.md and
  // mcp-oauth-authority." The helper is one-shot at the
  // module level so a fresh `loadHttpRuntimeConfig` call
  // within the same process does NOT re-emit.
  emitLocalRosterDeprecationWarn(backend, stderrLogger);

  return {
    ...http,
    agents,
    sessionMode: http.stateless ? "stateless" : "stateful",
    allowUnboundedBody: parseBoolean(process.env.MCP_HTTP_ALLOW_UNBOUNDED_BODY),
    authority: localAuthority,
    authorityBackend: "local",
  };
}

