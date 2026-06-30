/**
 * HTTP transport adapter for the mcp-readonly-sql app.
 *
 * This is a thin call into the shared `@customized-mcps/mcp-http-base` package's
 * `createHttpMcpServer`. The shared package owns:
 * - the `node:http` listener and SDK transport wiring
 * - the per-agent auth middleware (delegated to the resolved `TokenAuthority`)
 * - the `/healthz` endpoint
 * - the SIGTERM/SIGINT graceful shutdown controller
 * - request body size limits and structured logging
 * - the `/.well-known/oauth-protected-resource` handler — the shared
 *   base hardcodes `scopes_supported: []` (the scope catalog is gone;
 *   scope authorization is inert per PR 1 of `remove-scope-authorization`)
 *
 * The app side owns:
 * - the McpServer factory (the five read-only tools + connection pool)
 * - the env-to-config mapping (`config/http.ts`)
 * - the dispatcher (`dispatcher.ts`) that picks this vs stdio
 *
 * Per PR1 re-review, the v1 default is stateless (per-request transports)
 * so a cached stateful transport cannot leak its session id across
 * authenticated agents. The shared base receives the session mode as a
 * literal string; we derive that string from `HttpRuntimeConfig.sessionMode`
 * which itself comes from the `MCP_HTTP_STATELESS` env var.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createHttpMcpServer,
  createLogger,
  type HttpMcpServerHandle,
  type HttpMcpServerOptions,
  type Logger,
} from "@customized-mcps/mcp-http-base";
import type { HttpRuntimeConfig } from "../config/http.js";

export type RunHttpTransportOptions = {
  config: HttpRuntimeConfig;
  /**
   * Factory that builds a fresh `McpServer` for each request. In stateless
   * mode this is called per request; in stateful mode it is called once
   * by the shared base. The shared base passes the result to the SDK
   * `connect` method itself, so the factory just returns a configured
   * `McpServer`.
   */
  serverFactory: () => McpServer;
  /**
   * Test hook: receives the options object just before it is handed to
   * the shared base. Production code does NOT pass this; tests use it
   * to assert on the wiring (e.g. sessionMode literal) without starting
   * an actual server.
   */
  onOptionsBuilt?: (opts: HttpMcpServerOptions) => void;
};

export type HttpTransportHandle = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  url: string;
};

export function runHttpTransport(options: RunHttpTransportOptions): HttpTransportHandle {
  const { config, serverFactory, onOptionsBuilt } = options;

  const logger: Logger = createLogger({ format: config.logFormat });

  const sharedOptions: HttpMcpServerOptions = {
    host: config.host,
    port: config.port,
    path: config.path,
    // Phase 1b (external-token-authority-verification): the
    // resolved `TokenAuthority` is the single source of truth
    // for token verification. The OAuth admin authority issues
    // and validates RS256 JWTs; the middleware calls
    // `authority.verify(token)` and the result flows through
    // unchanged. The local HMAC roster backend was removed;
    // every request MUST be validated against the external
    // authority.
    authority: config.authority,
    // Phase 1b: the audit-safe label that `/healthz` exposes.
    // "oauth" when the OAuth admin authority is selected.
    authorityBackend: config.authorityBackend,
    // PR1 (mcp-http-base): the public URL of the OAuth authority.
    // The shared base advertises this URL as the sole entry of
    // `authorization_servers` in the
    // `/.well-known/oauth-protected-resource` document per RFC 9728.
    // Required so the well-known route can advertise a non-empty list.
    authorityUrl: config.authorityUrl ?? "",
    // PR1 (mcp-http-base): the resource server's own public base URL.
    // When unset, the shared base falls back to the per-request `Host`
    // header (with `x-forwarded-proto`) — see
    // `resolveResourceServerBaseUrl`. The 401 `WWW-Authenticate`
    // header and the well-known `resource` field both derive from this
    // value.
    resourceServerUrl: config.resourceServerUrl,
    sessionMode: config.sessionMode,
    logger,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    // Chunked-body opt-in. `false` (the safe default) makes the shared
    // base reject requests without a Content-Length with 411 Length
    // Required. Operators that front the app with a reverse proxy that
    // enforces client_max_body_size may set MCP_HTTP_ALLOW_UNBOUNDED_BODY=true
    // — see apps/mcp-readonly-sql/.env.example.
    allowUnboundedBody: config.allowUnboundedBody,
    // The shared base's `serverFactory` is `() => McpServer | Promise<McpServer>`.
    // We return the app's factory unchanged; the shared base calls it per
    // request (stateless) or once on first request (stateful).
    serverFactory: () => serverFactory(),
    onShutdown: async () => {
      // The app-side connection pool is owned by the McpServer factory's
      // caller (the entrypoint). The shared base does not have a handle
      // to it directly; the entrypoint wires the pool-closure into the
      // transport's lifecycle. For now this hook is a no-op at the
      // transport layer — the entrypoint registers its own SIGTERM handler
      // to drain in-flight queries, then calls shared.stop() and pool.destroyAll().
    },
  };

  // PR2 of `remove-scope-authorization`: no scope-catalog option is
  // forwarded. The shared base hardcodes `scopes_supported: []` in the
  // well-known handler. The previous app-side closure (which derived
  // the catalog from profile aliases or `MCP_RESOURCE_SCOPES`) is gone.

  // Test-only hook. The signature is unconditional so production code
  // never has to branch on its presence.
  if (onOptionsBuilt) onOptionsBuilt(sharedOptions);

  const handle: HttpMcpServerHandle = createHttpMcpServer(sharedOptions);

  return {
    start: () => handle.start(),
    stop: async () => {
      await handle.stop();
    },
    get url() {
      return handle.url;
    },
  };
}
