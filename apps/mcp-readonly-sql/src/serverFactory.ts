/**
 * Server factory for the mcp-readonly-sql app.
 *
 * Extracts the McpServer construction and tool registration into a
 * reusable function so the stdio entrypoint and the HTTP transport can
 * both wire the same five-tool surface (per the `mcp-tool-surface` spec).
 *
 * The HTTP path is a thin call into the shared `@customized-mcps/mcp-http-base` package;
 * the server factory exists so the app can hand a closure to the shared
 * base that builds an `McpServer` with the read-only tools already
 * registered, then returns a `destroyAll` hook the shared base can invoke
 * during graceful shutdown.
 *
 * The factory never reads `process.env` — it is a pure function of its
 * arguments. The entrypoint is responsible for loading profiles, safety
 * limits, and the connection manager.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConnectionManager } from "./db/knexFactory.js";
import { registerReadOnlyTools } from "./tools/readonlyTools.js";
import type { Profile, SafetyLimits } from "./types.js";

export type ReadOnlyMcpServerHandle = {
  /** The fully-configured `McpServer` with the five read-only tools registered. */
  server: McpServer;
  /** The connection manager owning the Knex connection pool. */
  connections: ConnectionManager;
  /**
   * Shutdown hook. Resolves once the connection pool has been destroyed.
   * Wired into the shared HTTP base's `onShutdown` so a graceful drain
   * closes the DB pool last (per the `mcp-http-transport` spec's
   * Graceful Shutdown requirement).
   */
  onShutdown: () => Promise<void>;
};

export type BuildServerOptions = {
  profiles: Profile[];
  limits: SafetyLimits;
  /** Optional pre-built connection manager (mostly for tests). */
  connections?: ConnectionManager;
};

/**
 * Load the package version from this app's `package.json` so the McpServer
 * identity stays in sync with the published version.
 */
function loadPackageVersion(): string {
  // Walk up from this file to find the nearest package.json. Vitest runs
  // the source through TS, so `import.meta.url` resolves to the source
  // file (not the compiled dist), and we land in apps/mcp-readonly-sql/.
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(
    readFileSync(join(here, "..", "package.json"), "utf8"),
  ) as { name: string; version: string };
  if (pkg.name !== "mcp-readonly-sql") {
    // Sanity check: the server identity must come from THIS package's
    // package.json, not a workspace sibling. A wrong path would emit the
    // wrong version string.
    throw new Error(
      `serverFactory: expected to read mcp-readonly-sql/package.json, got name="${pkg.name}"`,
    );
  }
  return pkg.version;
}

export function buildReadOnlyMcpServer(
  options: BuildServerOptions,
): ReadOnlyMcpServerHandle {
  const { profiles, limits } = options;
  const connections = options.connections ?? new ConnectionManager();

  const server = new McpServer({
    name: "mcp-readonly-sql",
    version: loadPackageVersion(),
  });

  registerReadOnlyTools(server, { profiles, limits, connections });

  return {
    server,
    connections,
    onShutdown: async () => {
      await connections.destroyAll();
    },
  };
}
