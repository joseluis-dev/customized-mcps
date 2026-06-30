/**
 * Streamable HTTP transport for MCP servers.
 *
 * The exported `createHttpMcpServer` function wires together:
 * - a `node:http` server (no Express dependency, per the design decision)
 * - the SDK's `StreamableHTTPServerTransport`
 * - the per-agent auth middleware (rejects with 401 before the transport
 *   ever sees the request)
 * - the `/healthz` endpoint (always outside the authenticated path)
 * - the graceful shutdown controller (stop accept → drain → close pool)
 * - SIGTERM/SIGINT handlers installed during start() so the operator
 *   does not have to wire them per app
 * - request body size limit, request outcome logging, readiness tracking,
 *   single-flight stateful init, and bearer-header scrubbing (the last
 *   five are PR1 remediation items)
 *
 * Session mode:
 * - `stateful` (default): the factory is called once at first request, the
 *   resulting `McpServer` is connected to a single `StreamableHTTPServerTransport`
 *   that owns the session-id generator. Concurrent clients each get their
 *   own session id and never see each other's notifications. A
 *   single-flight promise guards the init so a poisoned transport is
 *   never cached.
 * - `stateless`: the factory is called per request; a fresh transport is
 *   instantiated with `sessionIdGenerator: undefined`. There is no session
 *   continuity across requests — this mode is the correct choice for
 *   horizontally-scaled deployments.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AuthorityUnavailableError,
  TokenInvalidError,
  type TokenAuthority,
  type VerifiedToken,
  type VerifyContext,
} from "./authority/index.js";
import {
  sendJsonError,
  unauthorizedError,
  serviceUnavailableError,
  JSON_RPC_ERROR_CODES,
  type ErrorEnvelope,
} from "./errors.js";
import { createShutdownController, type ShutdownController } from "./shutdown.js";
import { redactSensitive, type Logger } from "./logging.js";
import {
  resolveResourceServerBaseUrl,
  type ProtectedResourceMetadata,
} from "./config.js";

/** RFC 9728 well-known path for protected resource metadata. */
const WELL_KNOWN_OAUTH_PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";

export type McpServerFactory = () => McpServer | Promise<McpServer>;

export type SessionMode = "stateful" | "stateless";

export type HttpMcpServerOptions = {
  host: string;
  port: number;
  path: string;
  /**
   * The `TokenAuthority` the middleware delegates to. This is the
   * single source of truth for token verification: the middleware
   * calls `authority.verify(token)` for every request that arrives
   * with a bearer header. Required — the shared base refuses to
   * start without a verification backend.
   */
  authority: TokenAuthority;
  /**
   * The audit-safe label that `/healthz` exposes. The value is
   * operator-supplied and MUST be `"oauth"` (or a future backend
   * label) so the health probe reports the selected backend. The
   * label MUST NOT include tokens, `kid`, JWKS URL, or authority
   * URL.
   */
  authorityBackend?: "oauth" | "jwks";
  sessionMode: SessionMode;
  logger: Logger;
  shutdownTimeoutMs: number;
  serverFactory: McpServerFactory;
  /** Optional cleanup hook called at the end of drain (e.g. close DB pool). */
  onShutdown?: () => Promise<void>;
  /**
   * Maximum request body size in bytes. Bodies larger than this limit are
   * rejected with 413 BEFORE the SDK reads them. Default: 1 MiB.
   */
  maxBodyBytes?: number;
  /**
   * When false (the safe default), requests without a `Content-Length`
   * header (i.e. chunked transfer-encoded requests) are rejected with
   * `411 Length Required`. The shared base cannot enforce a body-size
   * cap on chunked streams without interfering with the SDK transport,
   * so chunked traffic is opt-in. Operators that opt in MUST enforce
   * a body-size cap at the reverse proxy (per the
   * `mcp-deployment-templates` spec).
   */
  allowUnboundedBody?: boolean;
  /**
   * Override the Node EventEmitter used for SIGTERM/SIGINT installation
   * (testing). Defaults to the global `process`.
   */
  process?: NodeJS.EventEmitter;
  /**
   * The public URL of the OAuth authority (`MCP_AUTHORITY_URL`).
   * Used as the sole entry of `authorization_servers` in the
   * `/.well-known/oauth-protected-resource` document per RFC 9728.
   * Required so the well-known route can advertise a non-empty list.
   */
  authorityUrl: string;
  /**
   * Optional override for the resource server's own public base URL
   * (`MCP_RESOURCE_SERVER_URL`). When unset, the per-request `Host`
   * header (with `x-forwarded-proto`) is the source of truth. The 401
   * `WWW-Authenticate` header and the well-known `resource` field both
   * derive from this value.
   */
  resourceServerUrl?: string;
};

export type HttpMcpServerHandle = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  url: string;
  /** Exposed so tests (and the SIGTERM handler) can inspect shutdown state. */
  shutdownController: ShutdownController;
  /** Number of currently active stateful sessions. */
  activeSessionCount: () => number;
  /**
   * The underlying `node:http` Server, exposed for testing. The
   * leading underscore marks it as private-but-tested: production
   * code MUST NOT use this field. Tests use it to read the
   * OS-assigned port via `address()` and to verify the listener
   * state after start/stop. The field is `undefined` before
   * `start()` and after `stop()`.
   */
  readonly _server: Server | undefined;
};

/** HTTP status returned by the body-size limit. 413 Payload Too Large. */
const STATUS_PAYLOAD_TOO_LARGE = 413;
/** HTTP status returned for an invalid Content-Length. 400 Bad Request. */
const STATUS_BAD_REQUEST = 400;

/**
 * Resolve the `TokenAuthority` the middleware delegates to.
 *
 * The shared base requires `authority` directly. The function exists
 * as a single fail-closed seam so every error message a caller sees
 * is in one place.
 */
function resolveAuthority(options: HttpMcpServerOptions): TokenAuthority {
  if (options.authority) return options.authority;
  throw new Error(
    "createHttpMcpServer: `authority` (TokenAuthority) is required. " +
      "See @customized-mcps/mcp-http-base `HttpMcpServerOptions` for the contract.",
  );
}

export function createHttpMcpServer(options: HttpMcpServerOptions): HttpMcpServerHandle {
  let server: Server | undefined;
  let statefulTransport: StreamableHTTPServerTransport | undefined;
  // Single-flight guard: the same Promise is returned to every caller
  // while initialization is in progress. If init fails, the next caller
  // will retry.
  let statefulInitPromise: Promise<StreamableHTTPServerTransport> | undefined;
  // Track the count of active stateful sessions for observability. The
  // Set is intentionally minimal — entries are added on init and removed
  // on close. The set was previously assigned but never used; this fix
  // exposes a `activeSessionCount()` accessor so the data is observable.
  const statefulSessions = new Set<string>();
  // Readiness flag: set to true if the factory throws or transport
  // initialization fails, so /healthz can flip to 503.
  let unhealthy = false;
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024; // 1 MiB
  const allowUnboundedBody = options.allowUnboundedBody ?? false;
  // Resolve the `TokenAuthority` once at construction time. The
  // middleware calls `authority.verify(token, context)` for every
  // request; the typed errors thrown by `verify` map to 401
  // (`TokenInvalidError`) or 503 (`AuthorityUnavailableError`) via
  // the catch block in `handleMcpRequest`.
  const authority: TokenAuthority = resolveAuthority(options);
  // One-shot warning so operators see exactly one log line the first
  // time a chunked request (no Content-Length) reaches the shared base
  // when `allowUnboundedBody` is true. The operator should confirm a
  // body-size cap is in front of the process.
  let warnedAboutUnboundedBody = false;

  const shutdown: ShutdownController = createShutdownController({
    server: makeServerRef(() => server),
    transport: makeTransportRef(() => statefulTransport),
    closePool: options.onShutdown ?? (async () => {}),
    timeoutMs: options.shutdownTimeoutMs,
    logger: options.logger,
    process: options.process,
    /**
     * Force-close hook: invoked when the graceful drain does not
     * finish within `shutdownTimeoutMs`. The shared base does NOT
     * reach into `server` to call `socket.destroy()` because the
     * `server` reference passed to the controller is intentionally a
     * narrow surface (only `close()` is invoked through it). Calling
     * `process.exit(1)` here is the last-resort path that lets the
     * OS reap the process. Operators that prefer a different exit
     * code or a different cleanup strategy can supply their own
     * `onShutdown` or extend this hook in a future change.
     */
    forceClose: () => {
      const proc = (options.process ?? process) as NodeJS.EventEmitter & {
        exit?: (code?: number) => never;
      };
      if (typeof proc.exit === "function") {
        proc.exit(1);
      }
    },
  });

  function makeServerRef(get: () => Server | undefined): Server {
    return {
      close(cb?: (err?: Error) => void): unknown {
        const s = get();
        if (!s) {
          cb?.();
          return undefined;
        }
        return s.close(cb);
      },
      // The rest of HttpServer is unused by the controller; the cast keeps the
      // surface narrow.
    } as unknown as Server;
  }

  function makeTransportRef(get: () => StreamableHTTPServerTransport | undefined): StreamableHTTPServerTransport {
    return {
      async close(): Promise<void> {
        const t = get();
        if (t) await t.close();
      },
    } as unknown as StreamableHTTPServerTransport;
  }

  /**
   * Resolve the resource server's public base URL for a single request.
   * Used by the 401 `respond()` path and the well-known handler so the
   * `headers` cast lives in one place.
   */
  function resolveBaseUrlFor(req: IncomingMessage): string {
    return resolveResourceServerBaseUrl(
      { resourceServerUrl: options.resourceServerUrl },
      { headers: req.headers as Record<string, string | string[] | undefined> },
    );
  }

  function markUnhealthy(reason: string): void {
    if (unhealthy) return;
    unhealthy = true;
    options.logger.error(
      `server marked unhealthy: ${redactSensitive(reason)}`,
      {},
    );
  }

  /**
   * Clear the unhealthy flag. Called after a successful transport
   * creation follows a prior failure — the flag is intentionally
   * non-sticky for transient/recoverable failures (e.g. a temporary
   * factory throw on first request). Persistent/non-recoverable
   * failures are surfaced through repeated `markUnhealthy` calls.
   */
  function markHealthy(): void {
    if (!unhealthy) return;
    unhealthy = false;
    options.logger.info("server recovered; /healthz will report 200 again", {});
  }

  async function ensureStatefulTransport(): Promise<StreamableHTTPServerTransport> {
    if (statefulTransport) return statefulTransport;
    if (statefulInitPromise) return statefulInitPromise;
    statefulInitPromise = (async () => {
      // Track the half-built objects so we can clean them up if
      // `factory` or `connect` throws. Without this, every failed init
      // leaks one McpServer and one transport — the next caller will
      // create new ones and the old ones stay alive until the
      // process exits.
      let mcpServer: McpServer | undefined;
      let transport: StreamableHTTPServerTransport | undefined;
      try {
        mcpServer = await options.serverFactory();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            statefulSessions.add(sessionId);
            options.logger.info("session initialized", { requestId: sessionId });
          },
          onsessionclosed: (sessionId) => {
            statefulSessions.delete(sessionId);
            options.logger.info("session closed", { requestId: sessionId });
          },
        });
        await mcpServer.connect(transport);
        // Only cache the transport AFTER a successful connect — a poisoned
        // half-built transport must never be served to subsequent requests.
        statefulTransport = transport;
        return transport;
      } catch (err) {
        // Clean up the half-built McpServer and transport so they do
        // not leak. Errors are best-effort: the original error is what
        // callers need to see.
        if (transport) {
          try { await transport.close(); } catch { /* ignore */ }
        }
        if (mcpServer) {
          try { await mcpServer.close(); } catch { /* ignore */ }
        }
        throw err;
      } finally {
        statefulInitPromise = undefined;
      }
    })();
    return statefulInitPromise;
  }

  function readContentLength(req: IncomingMessage): number | undefined {
    const raw = req.headers["content-length"];
    if (raw === undefined) return undefined;
    const s = Array.isArray(raw) ? raw[0] : raw;
    if (s === undefined) return undefined;
    if (!/^\d+$/.test(s)) return NaN; // sentinel for "invalid"
    return Number(s);
  }

  /**
   * Enforce a hard request-body size limit BEFORE the SDK transport
   * reads from the request stream. We only rely on the
   * `Content-Length` header so we never interfere with the stream
   * itself — the SDK transport reads the body via Hono's
   * `getRequestListener`, which sets its own `data` listener and
   * will see whatever we do not consume.
   *
   * Three failure modes are caught:
   * - `Content-Length` header malformed → 400 Bad Request.
   * - `Content-Length` header larger than `maxBytes` → 413 Payload Too Large.
   * - `Content-Length` header missing (chunked request) when
   *   `allowUnboundedBody` is false → 411 Length Required.
   *
   * When the header is absent AND `allowUnboundedBody` is true, the
   * request is allowed through and a one-shot warning is logged so the
   * operator can confirm a body-size cap is in front of the process.
   * The reverse proxy is the only place a chunked body cap can be
   * enforced.
   */
  function enforceBodyLimit(
    req: IncomingMessage,
    limit: number,
  ): { ok: true } | { ok: false; envelope: ErrorEnvelope } {
    const declared = readContentLength(req);
    if (declared !== undefined && Number.isNaN(declared)) {
      return {
        ok: false,
        envelope: {
          status: STATUS_BAD_REQUEST,
          body: { jsonrpc: "2.0", error: { code: JSON_RPC_ERROR_CODES.SERVICE_UNAVAILABLE, message: "bad-request" }, id: null },
        },
      };
    }
    if (declared !== undefined && declared > limit) {
      return {
        ok: false,
        envelope: {
          status: STATUS_PAYLOAD_TOO_LARGE,
          body: { jsonrpc: "2.0", error: { code: JSON_RPC_ERROR_CODES.SERVICE_UNAVAILABLE, message: "payload-too-large" }, id: null },
        },
      };
    }
    if (declared === undefined) {
      if (!allowUnboundedBody) {
        return {
          ok: false,
          envelope: {
            status: 411,
            body: { jsonrpc: "2.0", error: { code: JSON_RPC_ERROR_CODES.SERVICE_UNAVAILABLE, message: "length-required" }, id: null },
          },
        };
      }
      // Opt-in path: warn once and let it through. The reverse proxy
      // is responsible for the body cap.
      if (!warnedAboutUnboundedBody) {
        warnedAboutUnboundedBody = true;
        options.logger.warn(
          "request without Content-Length accepted because allowUnboundedBody=true; ensure the reverse proxy enforces a body-size cap",
          {},
        );
      }
    }
    return { ok: true };
  }

  /**
   * Strip the Authorization header from `req.headers` so downstream
   * transport / tool handlers cannot accidentally echo the bearer.
   * The header is also removed from the raw header array (Node stores
   * the same data in two places: the lowercased map and a raw array).
   */
  function scrubAuthorizationHeader(req: IncomingMessage): void {
    if (req.headers.authorization !== undefined) {
      delete (req.headers as Record<string, unknown>).authorization;
    }
    if (Array.isArray(req.rawHeaders)) {
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]?.toLowerCase() === "authorization") {
          req.rawHeaders.splice(i, 2);
          i -= 2;
        }
      }
    }
  }

  /**
   * Validate an X-Request-Id value before it lands in a log line. The
   * header is untrusted client input — a client could inject a token
   * fragment or a 64-hex keyHash into the value. We accept only
   * alphanumerics, dashes, and underscores (1..128 chars) so the value
   * is safe to embed in a log line verbatim. Anything else is replaced
   * with `[REDACTED]`. Validation is preferred over redaction here
   * because the log line is structured (the value is a single field),
   * so a deterministic shape is easier to grep than a post-hoc
   * redacted blob.
   */
  function sanitizeRequestId(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    if (value.length === 0) return undefined;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) return "[REDACTED]";
    return value;
  }

  function logOutcome(
    level: "info" | "warn" | "error",
    req: IncomingMessage,
    status: number,
    latencyMs: number,
    agentId: string | undefined,
  ): void {
    const ctx: { requestId?: string; agentId?: string } = {};
    if (agentId) ctx.agentId = agentId;
    const requestId = sanitizeRequestId(req.headers["x-request-id"]);
    if (requestId) ctx.requestId = requestId;
    const msg = `request method=${req.method ?? "?"} path=${req.url ?? "?"} status=${status} latencyMs=${latencyMs}`;
    if (level === "info") options.logger.info(msg, ctx);
    else if (level === "warn") options.logger.warn(msg, ctx);
    else options.logger.error(msg, ctx);
  }

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    // Resolved once per request (the fallback uses request data, so the
    // value can change between requests). The 401 `respond()` path uses
    // this to build the `WWW-Authenticate` header.
    const resourceServerBaseUrl = resolveBaseUrlFor(req);
    const respond = (envelope: ErrorEnvelope, agentId?: string): void => {
      // RFC 6750 §3 + RFC 9728 §5.1: a 401 response MUST include
      // `WWW-Authenticate: Bearer resource_metadata="<url>"` so clients
      // can discover the authority. The header is set ONLY for 401 —
      // a 503 is a transport-level problem, not an auth challenge.
      if (envelope.status === 401) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${resourceServerBaseUrl}${WELL_KNOWN_OAUTH_PROTECTED_RESOURCE}"`,
        );
      }
      const latencyMs = Date.now() - startedAt;
      sendJsonError(res, envelope);
      const level: "info" | "warn" | "error" =
        envelope.status >= 500 ? "error" : envelope.status >= 400 ? "warn" : "info";
      logOutcome(level, req, envelope.status, latencyMs, agentId);
    };

    if (shutdown.isShuttingDown()) {
      respond(serviceUnavailableError());
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      respond(unauthorizedError());
      return;
    }
    const token = authHeader.slice("Bearer ".length).trim();
    // The middleware delegates to the resolved `TokenAuthority`.
    // The typed errors thrown by `verify` map to 401
    // (`TokenInvalidError`) or 503 (`AuthorityUnavailableError`)
    // via the catch block below.
    //
    // Phase 1b (W1 remediation): the middleware also passes a
    // `VerifyContext` with the sanitized X-Request-Id so the
    // JWKS authority can attach the request id to the second-miss
    // WARN line (per the mcp-token-authority spec). The
    // `sanitizeRequestId` helper rejects untrusted input
    // (alphanumerics, dashes, underscores only) so the id is
    // safe to embed in a log line.
    const requestId = sanitizeRequestId(req.headers["x-request-id"]);
    const verifyContext: VerifyContext | undefined = requestId ? { requestId } : undefined;
    let verified: VerifiedToken;
    try {
      verified = await authority.verify(token, verifyContext);
    } catch (err) {
      // 401 on `TokenInvalidError` (the expected "unknown / expired
      // / malformed token" path). 503 on
      // `AuthorityUnavailableError` (the JWKS fetch failed, the
      // authority is unreachable, etc.). Any other thrown error is
      // treated as 503 too — the audit-safe posture is "if we
      // cannot verify, we do not serve" and the client sees a
      // service-unavailable response rather than a stack trace.
      if (err instanceof TokenInvalidError) {
        respond(unauthorizedError());
        return;
      }
      // Authority unavailable (typed) or any other failure (e.g. a
      // programming bug inside the authority implementation) →
      // fail closed with 503. The error message is redacted by
      // `sendJsonError`'s envelope factory (the body is fixed); we
      // also log a sanitized operator-visible line.
      const reason =
        err instanceof AuthorityUnavailableError
          ? "authority unavailable"
          : err instanceof Error
            ? err.message
            : String(err);
      markUnhealthy(reason);
      options.logger.error(
        `token verify failed; returning 503: ${redactSensitive(reason)}`,
        {},
      );
      respond(serviceUnavailableError());
      return;
    }
    const agentId = verified.agentId;

    // Enforce a hard body-size limit BEFORE the SDK transport reads
    // anything from the request stream. The transport would otherwise
    // happily read megabytes of an oversized request.
    const limitCheck = enforceBodyLimit(req, maxBodyBytes);
    if (!limitCheck.ok) {
      respond(limitCheck.envelope, agentId);
      return;
    }

    // Strip the bearer header so the SDK transport (and any tool handler
    // it dispatches to) cannot echo the token.
    scrubAuthorizationHeader(req);

    // Declared in the function scope (not the try block) so the catch
    // handler can reach them for cleanup on the handleRequest-throw
    // path. `let`/`const` inside a `try` block are not visible in the
    // matching `catch` in JavaScript. Initialized to `undefined` so
    // TypeScript's flow analysis treats them as definitely-assigned
    // after the try block (the catch path guards on truthiness).
    let activeTransport: StreamableHTTPServerTransport | undefined;
    let perRequestMcp: McpServer | undefined;

    try {
      if (options.sessionMode === "stateful") {
        activeTransport = await ensureStatefulTransport();
      } else {
        perRequestMcp = await options.serverFactory();
        activeTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        try {
          await perRequestMcp.connect(activeTransport);
        } catch (err) {
          // The per-request server was created but the transport did
          // not connect — clean up both to avoid leaking one server +
          // one transport per failed init.
          try { await activeTransport.close(); } catch { /* ignore */ }
          try { await perRequestMcp.close(); } catch { /* ignore */ }
          throw err;
        }
      }

      // Attach auth context so the SDK forwards the agent identity into
      // `MessageExtraInfo` (used by the app to enforce per-call scope checks).
      (req as { auth?: { clientId: string; scopes: string[] } }).auth = {
        clientId: verified.agentId,
        scopes: verified.scopes,
      };

      await activeTransport.handleRequest(req, res);
      const latencyMs = Date.now() - startedAt;
      const status = res.statusCode ?? 200;
      const level: "info" | "warn" | "error" =
        status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      logOutcome(level, req, status, latencyMs, agentId);

      // Evidence-based health: only clear the previously-set `unhealthy`
      // flag AFTER handleRequest has succeeded. With a cached stateful
      // transport, calling markHealthy() before handleRequest would flip
      // /healthz to 200 on hope, not evidence — the request might still
      // fail and leave the flag incorrectly cleared. Persistent failures
      // are surfaced via markUnhealthy() in the catch path.
      markHealthy();

      if (perRequestMcp) {
        try {
          await perRequestMcp.close();
        } catch {
          // Stateless server close is best-effort; the response was already sent.
        }
        try {
          await activeTransport.close();
        } catch {
          // Same as above.
        }
      }
    } catch (err) {
      // In stateless mode, perRequestMcp and activeTransport were
      // created and successfully connected, but handleRequest() may
      // still throw. Without this cleanup, every failed request would
      // leak one McpServer + one transport. The connect-failure path
      // (above) already closes them in its own catch; this is the
      // belt-and-suspenders for the handleRequest-throw path.
      if (perRequestMcp && activeTransport) {
        try { await activeTransport.close(); } catch { /* ignore */ }
        try { await perRequestMcp.close(); } catch { /* ignore */ }
      }
      markUnhealthy(err instanceof Error ? err.message : String(err));
      const latencyMs = Date.now() - startedAt;
      const redacted = redactSensitive(err instanceof Error ? err.message : String(err));
      options.logger.error(`transport error: ${redacted}`, { agentId });
      if (!res.headersSent) {
        respond(serviceUnavailableError(), agentId);
      } else {
        logOutcome("error", req, res.statusCode ?? 500, latencyMs, agentId);
      }
    }
  }

  function handleHealth(res: ServerResponse): void {
    // Phase 1b (external-token-authority-verification): the
    // health endpoint returns JSON so it can carry the
    // `authorityBackend` field (per the mcp-token-authority spec).
    // The body shape is intentionally minimal: status
    // (`"ok"` / `"unhealthy"` / `"shutting-down"`) plus the
    // backend label. The body MUST NOT include tokens, `kid`,
    // JWKS URL, or authority URL — the middleware's
    // `sanitizeError` path is the same one used for the 401/503
    // JSON-RPC bodies, so the audit-safe contract is uniform
    // across endpoints.
    let status: "ok" | "unhealthy" | "shutting-down";
    if (shutdown.isShuttingDown()) {
      status = "shutting-down";
    } else if (unhealthy) {
      status = "unhealthy";
    } else {
      status = "ok";
    }
    const body = JSON.stringify({
      status,
      authorityBackend: options.authorityBackend ?? "oauth",
    });
    if (status === "ok") {
      res.statusCode = 200;
    } else {
      res.statusCode = 503;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(body);
  }

  /**
   * RFC 9728 §3.1 protected-resource metadata handler. Unauthenticated
   * by design (the metadata is public); the route is matched in
   * `requestHandler` BEFORE `/mcp` so the bearer middleware never sees it.
   *
   * `resource` is the resource server's own public base URL (per-request
   * `Host` fallback applies); `authorization_servers` is the authority's
   * issuer URL; `bearer_methods_supported` is `["header"]`; `scopes_supported`
   * is hardcoded to `[]` (per PR 1 of `remove-scope-authorization`).
   * The previous `scopeCatalog` option is removed: scope authorization
   * is inert and the well-known field is retained for RFC 9728 schema
   * compliance, not as a source of authorization.
   */
  function handleProtectedResourceMetadata(req: IncomingMessage, res: ServerResponse): void {
    const baseUrl = resolveBaseUrlFor(req);
    const body: ProtectedResourceMetadata = {
      resource: baseUrl,
      authorization_servers: [options.authorityUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: [],
    };
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // The metadata is dynamic (per-request `Host` fallback). `no-store`
    // prevents a stale `resource` from leaking after a deployment that
    // flips the env var.
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  }

  function requestHandler(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/healthz") {
      handleHealth(res);
      return;
    }
    // Matched BEFORE the `/mcp` route so the bearer middleware never
    // sees the well-known request.
    if (req.method === "GET" && url === WELL_KNOWN_OAUTH_PROTECTED_RESOURCE) {
      handleProtectedResourceMetadata(req, res);
      return;
    }
    if (url === options.path || url.startsWith(`${options.path}/`)) {
      void handleMcpRequest(req, res);
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
  }

  return {
    start: async () => {
      server = createServer(requestHandler);
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server!.once("error", onError);
        server!.listen(options.port, options.host, () => {
          server!.off("error", onError);
          resolve();
        });
      });
      shutdown.installSignalHandlers();
      options.logger.info(
        `HTTP server listening on http://${options.host}:${server.address() instanceof Object ? (server.address() as { port: number }).port : options.port}${options.path}`,
        {},
      );
    },
    stop: async () => {
      await shutdown.drain();
      // After drain we drop the stateful transport and the bound server so a
      // second stop() call is a no-op.
      statefulTransport = undefined;
      statefulInitPromise = undefined;
      statefulSessions.clear();
      unhealthy = false;
    },
    get url() {
      const port =
        server && server.address()
          ? (server.address() as { port: number }).port
          : options.port;
      return `http://${options.host}:${port}${options.path}`;
    },
    shutdownController: shutdown,
    activeSessionCount: () => statefulSessions.size,
    get _server() {
      return server;
    },
  };
}
