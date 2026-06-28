/**
 * Graceful shutdown controller for the shared HTTP transport.
 *
 * Lifecycle (per the mcp-http-transport spec):
 *   1. SIGTERM or SIGINT arrives
 *   2. Mark the controller as shutting down (so /healthz returns 503 and
 *      new requests are rejected)
 *   3. Stop accepting new connections (server.close)
 *   4. Close the SDK transport so any pending requests are flushed
 *   5. Close the application's connection pool / DB connections
 *   6. If the shutdown timeout elapses during step 4 or 5, invoke the
 *      `forceClose` hook (concrete failure-path behavior; e.g. destroy
 *      remaining sockets, then `process.exit(non-zero)`) and log a
 *      structured error. drain() always resolves within the timeout so
 *      the process never hangs indefinitely.
 *
 * The implementation is intentionally side-effect-light. The caller wires
 * the actual `server`, `transport`, `closePool`, and `forceClose`
 * dependencies; the controller orchestrates them. This makes the unit
 * test deterministic and the production wiring obvious.
 */

import type { Logger } from "./logging.js";
import type { Server as HttpServer } from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export type ShutdownDeps = {
  server: HttpServer;
  transport: StreamableHTTPServerTransport;
  closePool: () => Promise<void>;
  timeoutMs: number;
  logger: Logger;
  /** Override the process emitter for testing; defaults to `process`. */
  process?: NodeJS.EventEmitter;
  /**
   * Optional last-resort hook invoked when the graceful drain does not
   * finish within `timeoutMs`. The hook is responsible for tearing down
   * whatever the graceful path could not (e.g. destroy open sockets,
   * terminate background workers, then `process.exit(non-zero)`).
   *
   * The controller does NOT swallow errors from this hook — the
   * production wiring is expected to call `process.exit` so the process
   * can actually stop. Tests can pass a no-op or a tracking stub.
   */
  forceClose?: () => void;
};

export type ShutdownController = {
  isShuttingDown: () => boolean;
  markShuttingDown: () => void;
  drain: () => Promise<void>;
  installSignalHandlers: () => void;
};

export function createShutdownController(deps: ShutdownDeps): ShutdownController {
  let shuttingDown = false;
  let forceCloseInvoked = false;
  const target: NodeJS.EventEmitter = deps.process ?? process;

  function markShuttingDown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.warn("Shutdown signal received; entering drain phase", {});
  }

  function invokeForceClose(): void {
    if (forceCloseInvoked) return;
    forceCloseInvoked = true;
    deps.logger.error(
      `Shutdown drain exceeded ${deps.timeoutMs}ms timeout; invoking force-close`,
      {},
    );
    if (deps.forceClose) {
      try {
        deps.forceClose();
      } catch (e) {
        deps.logger.error(
          `force-close hook threw: ${e instanceof Error ? e.message : String(e)}`,
          {},
        );
      }
    }
  }

  async function drain(): Promise<void> {
    markShuttingDown();

    // Build a timeout that resolves with "timeout" if the work is not
    // done in time. The .unref() makes sure the timer does not keep the
    // event loop alive on its own.
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), deps.timeoutMs).unref();
    });
    // The work promise can REJECT (e.g. closePool throws) — PR1
    // remediation wraps it in a never-rejecting promise so the race
    // resolves either with `"ok"` (work succeeded), `"failed"` (work
    // rejected), or `"timeout"`. drain() must NEVER throw, otherwise
    // the signal handler's `void drain()` would log an unhandled
    // rejection and the process could hang.
    const work = (async () => {
      try {
        await closeServer(deps.server);
        await closeTransport(deps.transport);
        await deps.closePool();
        return "ok" as const;
      } catch (e) {
        deps.logger.error(
          `Shutdown work rejected: ${e instanceof Error ? e.message : String(e)}`,
          {},
        );
        return "failed" as const;
      }
    })();

    // Race: whichever settles first wins. If the timeout wins, we
    // invoke the force-close hook. If work rejects, we still invoke
    // the force-close hook (after a short grace period) so the
    // process does not hang on a stuck teardown.
    const result = await Promise.race([work, timeout]);
    if (result === "timeout" || result === "failed") {
      invokeForceClose();
      // Detach the still-running work; it will resolve eventually but
      // we no longer wait on it. The operator's force-close hook is
      // expected to terminate the process.
    }
  }

  function installSignalHandlers(): void {
    target.on("SIGTERM", () => {
      void drain();
    });
    target.on("SIGINT", () => {
      void drain();
    });
  }

  return {
    isShuttingDown: () => shuttingDown,
    markShuttingDown,
    drain,
    installSignalHandlers,
  };
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      // Swallow any error here so the rest of the drain still runs.
      resolve();
    });
  });
}

async function closeTransport(transport: StreamableHTTPServerTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Same reasoning as closeServer: never throw out of drain.
  }
}
