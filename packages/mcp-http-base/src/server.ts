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
import { validateBearer, type AgentRecord } from "./auth.js";
import {
  sendJsonError,
  unauthorizedError,
  serviceUnavailableError,
  JSON_RPC_ERROR_CODES,
  type ErrorEnvelope,
} from "./errors.js";
import { createShutdownController, type ShutdownController } from "./shutdown.js";
import { redactSensitive, type Logger } from "./logging.js";

export type McpServerFactory = () => McpServer | Promise<McpServer>;

export type SessionMode = "stateful" | "stateless";

export type HttpMcpServerOptions = {
  host: string;
  port: number;
  path: string;
  agents: readonly AgentRecord[];
  hmacSecret: string;
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
    const respond = (envelope: ErrorEnvelope, agentId?: string): void => {
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
    const result = validateBearer(token, options.hmacSecret, options.agents);
    if (!result.ok) {
      respond(unauthorizedError());
      return;
    }
    const agentId = result.agent.id;

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
        clientId: result.agent.id,
        scopes: result.agent.scopes,
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
    if (shutdown.isShuttingDown()) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("shutting-down");
      return;
    }
    if (unhealthy) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("unhealthy");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("ok");
  }

  function requestHandler(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/healthz") {
      handleHealth(res);
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
