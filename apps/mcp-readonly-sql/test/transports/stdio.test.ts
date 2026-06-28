import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import { runStdioTransport } from "../../src/transports/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Build a `McpServer` whose `connect` is mocked so we can assert that
 * the stdio transport is the one being connected to (and not anything
 * else). We still want the real `McpServer` shape so the factory call
 * site is faithful to production.
 */
function makeServerWithMockedConnect(): McpServer {
  // Construct a real McpServer and replace `connect` with a spy that
  // resolves to a known value. Tests can then assert on the spy.
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const spy = vi.fn(async () => undefined);
  // The McpServer.connect signature is `(transport: Transport) => Promise<void>`.
  // We narrow the type so the cast is safe.
  (server as unknown as { connect: typeof spy }).connect = spy;
  return Object.assign(server, { _connectSpy: spy }) as McpServer & {
    _connectSpy: ReturnType<typeof vi.fn>;
  };
}

/**
 * Build a fake logger that captures log lines so the test can assert on
 * them without touching the real stderr.
 */
function makeSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("transports/stdio", () => {
  let originalStdout: typeof process.stdout;
  let originalStderr: typeof process.stderr;
  let originalStdin: typeof process.stdin;

  beforeEach(() => {
    // Snapshot the real streams so we can restore them after each test.
    originalStdout = process.stdout;
    originalStderr = process.stderr;
    originalStdin = process.stdin;
  });

  afterEach(() => {
    // Restore so a test that swaps streams does not leak into siblings.
    Object.defineProperty(process, "stdout", { value: originalStdout, writable: true });
    Object.defineProperty(process, "stderr", { value: originalStderr, writable: true });
    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
    vi.restoreAllMocks();
  });

  describe("runStdioTransport", () => {
    it("connects the McpServer to a StdioServerTransport", async () => {
      // GIVEN a real McpServer and a logger
      // WHEN we run the stdio transport
      // THEN the server's connect is called with a StdioServerTransport
      const server = makeServerWithMockedConnect();
      const logger = makeSilentLogger();
      const handle = runStdioTransport({ server, logger });

      // Wait for the async start path to complete.
      await handle.start();

      // Assert: the connect spy was called exactly once with a StdioServerTransport.
      expect(server._connectSpy).toHaveBeenCalledTimes(1);
      const arg = server._connectSpy.mock.calls[0]?.[0];
      expect(arg).toBeInstanceOf(StdioServerTransport);

      await handle.stop();
    });

    it("returns a handle whose start resolves", async () => {
      // GIVEN a real McpServer
      // WHEN we run start
      // THEN the returned promise resolves without throwing
      const server = makeServerWithMockedConnect();
      const logger = makeSilentLogger();
      const handle = runStdioTransport({ server, logger });
      await expect(handle.start()).resolves.toBeUndefined();
      await handle.stop();
    });

    it("returns a handle whose stop is idempotent and resolves", async () => {
      // GIVEN a started stdio transport
      // WHEN we call stop twice
      // THEN both calls resolve (no throw, no unhandled rejection)
      const server = makeServerWithMockedConnect();
      const logger = makeSilentLogger();
      const handle = runStdioTransport({ server, logger });
      await handle.start();
      await expect(handle.stop()).resolves.toBeUndefined();
      await expect(handle.stop()).resolves.toBeUndefined();
    });

    it("logs that the server connected over stdio", async () => {
      // GIVEN a real McpServer
      // WHEN the stdio transport is started
      // THEN the logger.info is called with a message naming the stdio transport
      const server = makeServerWithMockedConnect();
      const logger = makeSilentLogger();
      const handle = runStdioTransport({ server, logger });
      await handle.start();
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
      const hit = infoCalls.some(
        (call: unknown[]) => typeof call[0] === "string" && /stdio/i.test(call[0]),
      );
      expect(hit).toBe(true);
      await handle.stop();
    });

    it("does NOT touch process.stdout (the MCP transport owns stdout)", async () => {
      // GIVEN a real McpServer
      // WHEN the stdio transport is started
      // THEN process.stdout is not written to by the transport itself
      // (writes are the SDK transport's job; our adapter must not log to stdout)
      const writes: string[] = [];
      const fakeStdout = new Writable({
        write(chunk, _enc, cb) {
          writes.push(chunk.toString());
          cb();
        },
      });
      Object.defineProperty(process, "stdout", { value: fakeStdout, writable: true });
      const server = makeServerWithMockedConnect();
      const logger = makeSilentLogger();
      const handle = runStdioTransport({ server, logger });
      await handle.start();
      // The transport itself should not write to stdout. (The SDK
      // transport may, but the adapter does not.)
      const adapterWrites = writes.filter(
        (w) => /mcp-readonly-sql|stdio|transport/i.test(w),
      );
      expect(adapterWrites, "stdio adapter must not write to process.stdout").toEqual([]);
      await handle.stop();
    });

    it("propagates errors from server.connect to the caller (not swallowed)", async () => {
      // GIVEN an McpServer whose connect rejects
      // WHEN the stdio transport is started
      // THEN the rejection surfaces to the caller so the entrypoint can exit
      const server = new McpServer({ name: "test", version: "0.0.0" });
      (server as unknown as { connect: () => Promise<void> }).connect = async () => {
        throw new Error("simulated connect failure");
      };
      const logger = makeSilentLogger();
      const handle = runStdioTransport({ server, logger });
      await expect(handle.start()).rejects.toThrow(/simulated connect failure/);
    });
  });
});
