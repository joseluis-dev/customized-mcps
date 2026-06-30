/**
 * mcp-readonly-sql wire entrypoint.
 *
 * The app is transport-agnostic at the domain layer. The entrypoint
 * dispatches between:
 * - `stdio` (the historical default — MCP hosts spawn the process and
 *   talk to it over stdin/stdout)
 * - `streamableHttp` (the new opt-in — multiple agents share one process
 *   behind a reverse proxy)
 *
 * Dispatch is decided by the `MCP_TRANSPORT` env var. The decision is
 * encapsulated in `selectTransport` (a pure function in `./dispatcher.ts`)
 * so the failure mode for unknown values is unit-testable.
 *
 * Stdio path:
 * - Same env loading, same profile/limit loading, same SIGTERM/SIGINT
 *   shutdown behavior as the pre-PR2 version. The only difference is
 *   that the McpServer is built via the shared `buildReadOnlyMcpServer`
 *   factory, and the stdio transport is the thin `transports/stdio.ts`
 *   adapter.
 *
 * HTTP path:
 * - Reads HTTP env + agents via `loadHttpRuntimeConfig`.
 * - Builds the same McpServer via the shared factory.
 * - Hands the server factory to `transports/http.ts`, which delegates
 *   the actual HTTP wiring (auth, /healthz, body limits, shutdown) to
 *   the shared `@customized-mcps/mcp-http-base` package.
 */

import { loadRawEnv, readSafetyLimits } from "./config/env.js";
import { loadAllProfiles, ProfileError } from "./config/profiles.js";
import { selectTransport, type Transport } from "./dispatcher.js";
import { sanitizeError } from "./security/sanitizeError.js";
import { buildReadOnlyMcpServer } from "./serverFactory.js";
import { runStdioTransport } from "./transports/stdio.js";
import { loadHttpRuntimeConfig, HttpRuntimeConfigError } from "./config/http.js";
import { buildScopeCatalog } from "./config/scopeCatalog.js";
import { runHttpTransport } from "./transports/http.js";
import type { Logger } from "@customized-mcps/mcp-http-base";

function log(line: string): void {
  process.stderr.write(`[mcp-readonly-sql] ${line}\n`);
}

/** Adapter that turns the stdio `log` function into a `Logger` for the transport. */
const STDIO_LOGGER: Logger = {
  info: (msg) => log(msg),
  warn: (msg) => log(msg),
  error: (msg) => log(msg),
};

/**
 * Pure decision: read `MCP_TRANSPORT` and pick the transport. Translates
 * the dispatcher's thrown error to a non-zero exit with a stderr message
 * so the operator sees a clear failure.
 */
function pickTransport(): Transport {
  try {
    return selectTransport(process.env.MCP_TRANSPORT);
  } catch (e) {
    const { message } = sanitizeError(e);
    log(message);
    process.exit(2);
  }
}

export async function runServer(): Promise<void> {
  const transport = pickTransport();
  if (transport === "stdio") {
    return runStdioServer();
  }
  return runHttpServer();
}

async function runStdioServer(): Promise<void> {
  // Pre-PR2 behavior preserved: load profiles + limits, build McpServer
  // (via the shared factory now), connect to stdio, install SIGTERM/SIGINT
  // handlers that drain and exit.
  const { profileNames, raw } = loadRawEnv();
  let profiles;
  try {
    profiles = await loadAllProfiles(profileNames, raw);
  } catch (e) {
    if (e instanceof ProfileError) {
      log(`Profile configuration error: ${e.message}`);
    } else {
      const { message } = sanitizeError(e);
      log(`Profile configuration error: ${message}`);
    }
    process.exit(2);
  }

  if (profiles.length === 0) {
    log("No DB_PROFILES configured. The server will start but no profile will be available.");
  } else {
    log(`Loaded ${profiles.length} profile(s): ${profiles.map((p) => p.alias).join(", ")}`);
  }

  const limits = readSafetyLimits();
  const handle = buildReadOnlyMcpServer({ profiles, limits });

  const transport = runStdioTransport({ server: handle.server, logger: STDIO_LOGGER });
  await transport.start();

  const shutdown = async (): Promise<void> => {
    log("Shutting down...");
    await transport.stop();
    await handle.onShutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function runHttpServer(): Promise<void> {
  // 1. Load HTTP config + agents. Fail-closed on any validation error.
  // Phase 1b: the loader is async because the JWKS backend's startup
  // probe (`warm()`) is awaited here so a misconfigured authority URL
  // fails fast at startup.
  let config;
  try {
    config = await loadHttpRuntimeConfig();
  } catch (e) {
    const message = e instanceof HttpRuntimeConfigError
      ? e.message
      : sanitizeError(e).message;
    log(`HTTP configuration error: ${message}`);
    process.exit(2);
  }

  // 2. Load profiles + limits (HTTP path needs the same domain config
  //    as stdio — the tool handlers resolve profiles per call).
  const { profileNames, raw } = loadRawEnv();
  let profiles;
  try {
    profiles = await loadAllProfiles(profileNames, raw);
  } catch (e) {
    if (e instanceof ProfileError) {
      log(`Profile configuration error: ${e.message}`);
    } else {
      const { message } = sanitizeError(e);
      log(`Profile configuration error: ${message}`);
    }
    process.exit(2);
  }

  if (profiles.length === 0) {
    log("Warning: HTTP server starting with zero profiles configured. Tools will return errors for every call.");
  } else {
    log(`Loaded ${profiles.length} profile(s): ${profiles.map((p) => p.alias).join(", ")}`);
  }

  // 3. Build the McpServer (the five read-only tools) via the shared
  //    factory. The HTTP transport will receive a fresh McpServer per
  //    request in stateless mode (the v1 default).
  const limits = readSafetyLimits();
  const handle = buildReadOnlyMcpServer({ profiles, limits });

  // 4. Hand the server factory to the HTTP transport. The transport
  //    delegates to `@customized-mcps/mcp-http-base` for the actual HTTP wiring
  //    (listener, auth, /healthz, body limits, shutdown).
  //
  //    PR4 task 4.1: the resource server advertises its scope catalog
  //    at `/.well-known/oauth-protected-resource` (RFC 9728). The
  //    catalog is derived from profile aliases (`read:<alias>` +
  //    `list:<alias>` per profile) OR an explicit `MCP_RESOURCE_SCOPES`
  //    env override. The closure is passed to the transport which
  //    forwards it to the shared base; the shared base invokes the
  //    closure on every well-known request so the value is fresh.
  const scopeCatalog = (): string[] => buildScopeCatalog(profiles, {
    MCP_RESOURCE_SCOPES: process.env.MCP_RESOURCE_SCOPES,
  });
  const transport = runHttpTransport({
    config,
    serverFactory: () => buildReadOnlyMcpServer({ profiles, limits, connections: handle.connections }).server,
    scopeCatalog,
  });
  await transport.start();
  log(
    `HTTP server listening on ${transport.url} ` +
      `(sessionMode=${config.sessionMode}, authorityBackend=${config.authorityBackend})`,
  );

  // 5. The shared base installs its own SIGTERM/SIGINT handlers during
  //    `start()` (it calls `shutdown.installSignalHandlers()`). Those
  //    handlers drain the HTTP server but DO NOT call `process.exit()` —
  //    the process must keep running until the app's own cleanup is
  //    done. The handlers below are idempotent with the shared base's
  //    (the controller's `markShuttingDown` is a no-op on the second
  //    call), so it is safe for both to fire on the same signal.
  const shutdown = async (): Promise<void> => {
    log("Shutting down...");
    await transport.stop();
    await handle.onShutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

runServer().catch((e) => {
  const { message } = sanitizeError(e);
  log(`Fatal error: ${message}`);
  process.exit(1);
});
