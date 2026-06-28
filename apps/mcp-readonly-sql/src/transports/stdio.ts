/**
 * Stdio transport adapter for the mcp-readonly-sql app.
 *
 * This is a thin call into the SDK's `StdioServerTransport`. The pre-PR2
 * `src/index.ts` did this inline; PR2 extracts it into a transport
 * module so the entrypoint can dispatch between stdio and HTTP without
 * branching on `MCP_TRANSPORT` inside a single 60-line file.
 *
 * Contract:
 * - The factory is called with an already-built `McpServer` (the same
 *   server instance the HTTP transport would receive per request in
 *   stateless mode).
 * - `start()` connects the server to a `StdioServerTransport` and returns.
 * - `stop()` is idempotent: it closes the server on the first call and
 *   becomes a no-op on subsequent calls.
 * - The adapter never writes to `process.stdout` — stdout is reserved for
 *   the transport protocol per the `mcp-http-transport` spec's structured
 *   logging requirement.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Logger } from "@customized-mcps/mcp-http-base";

export type StdioTransportOptions = {
  server: McpServer;
  logger: Logger;
};

export type StdioTransportHandle = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function runStdioTransport(options: StdioTransportOptions): StdioTransportHandle {
  const { server, logger } = options;
  let started = false;
  let stopped = false;

  return {
    start: async () => {
      if (started) {
        throw new Error("runStdioTransport.start() called twice without stop()");
      }
      started = true;
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info("Server connected over stdio", {});
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await server.close();
      } catch {
        // The stdio transport is best-effort to close. Swallowing keeps
        // the entrypoint simple — stdio exits as soon as the host
        // disconnects anyway.
      }
    },
  };
}
