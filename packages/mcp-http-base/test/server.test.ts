import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac, randomUUID } from "node:crypto";
import {
  createHttpMcpServer,
  type HttpMcpServerOptions,
  type AgentRecord,
  type McpServerFactory,
} from "../src/server.js";
import { createLogger } from "../src/logging.js";

const SECRET = "super-secret-test-key-32-bytes!!";

function hmacOf(token: string): string {
  return createHmac("sha256", SECRET).update(token).digest("hex");
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-a",
    keyHash: hmacOf("tok-a"),
    scopes: ["read:*"],
    ...overrides,
  };
}

function makeOptions(
  overrides: Partial<HttpMcpServerOptions> = {},
): HttpMcpServerOptions {
  return {
    host: "127.0.0.1",
    port: 0, // OS-assigned ephemeral port
    path: "/mcp",
    agents: [makeAgent()],
    hmacSecret: SECRET,
    sessionMode: "stateful",
    logger: createLogger({ format: "text" }),
    shutdownTimeoutMs: 1000,
    serverFactory: (() => {
      // The factory is called once per connection. We return a transport-like
      // stub that pretends to be an McpServer. The tests in this file do not
      // exercise real MCP tool calls; the focus is auth-before-transport,
      // /healthz routing, and session mode wiring.
      return {
        connect: async () => {},
        close: async () => {},
      } as never;
    }) as McpServerFactory,
    onShutdown: async () => {},
    ...overrides,
  };
}

/** Start the server, return its bound port and a stop handle. */
async function startServer(options: HttpMcpServerOptions) {
  const handle = createHttpMcpServer(options);
  await handle.start();
  // @ts-expect-error - private field but necessary for the test
  const addr = handle._server.address() as AddressInfo;
  return { handle, port: addr.port };
}

function http(
  port: number,
  method: "GET" | "POST" | "DELETE",
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const finalHeaders: Record<string, string> = { ...headers };
    // Always set Content-Length when a body is provided. The shared
    // base rejects requests without a Content-Length with 411
    // Length Required (the safe v1 default). Tests that exercise
    // the chunked path can opt in via `allowUnboundedBody: true`.
    if (body !== undefined && finalHeaders["Content-Length"] === undefined) {
      finalHeaders["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
    }
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: finalHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("createHttpMcpServer", () => {
  let stopHandle: { stop: () => Promise<void> } | undefined;

  afterEach(async () => {
    if (stopHandle) {
      await stopHandle.stop();
      stopHandle = undefined;
    }
  });

  describe("/healthz (unauthenticated)", () => {
    it("returns 200 with status=ok and authorityBackend=local while healthy", async () => {
      // Phase 1b: the health endpoint returns JSON so it can carry
      // the `authorityBackend` field per the mcp-token-authority spec.
      // The body MUST NOT include tokens, `kid`, JWKS URL, or
      // authority URL.
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await http(port, "GET", "/healthz");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status?: string; authorityBackend?: string };
      expect(body.status).toBe("ok");
      expect(body.authorityBackend).toBe("local");
    });

    it("returns 503 with status=shutting-down once the controller has been signaled", async () => {
      const opts = makeOptions();
      const { handle, port } = await startServer(opts);
      stopHandle = handle;
      handle.shutdownController.markShuttingDown();
      const res = await http(port, "GET", "/healthz");
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body) as { status?: string; authorityBackend?: string };
      expect(body.status).toBe("shutting-down");
      expect(body.authorityBackend).toBe("local");
    });
  });

  describe("auth-before-transport on the MCP path", () => {
    it("returns 401 for a missing Authorization header", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await http(port, "POST", "/mcp", {}, "{}");
      expect(res.status).toBe(401);
      const parsed = JSON.parse(res.body);
      expect(parsed.error.message).toBe("unauthorized");
      // No token or agent metadata in the body.
      expect(res.body).not.toContain("agent-a");
    });

    it("returns 401 for a malformed bearer token (not in agent list)", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await http(
        port,
        "POST",
        "/mcp",
        { Authorization: "Bearer not-a-real-token" },
        "{}",
      );
      expect(res.status).toBe(401);
      const parsed = JSON.parse(res.body);
      expect(parsed.error.message).toBe("unauthorized");
      expect(res.body).not.toContain("not-a-real-token");
    });

    it("does not invoke the server factory when authorization fails", async () => {
      let factoryCalls = 0;
      const factory: McpServerFactory = (() => {
        factoryCalls++;
        return {
          connect: async () => {},
          close: async () => {},
        } as never;
      }) as McpServerFactory;
      const { handle, port } = await startServer(makeOptions({ serverFactory: factory }));
      stopHandle = handle;
      const res = await http(port, "POST", "/mcp", {}, "{}");
      expect(res.status).toBe(401);
      expect(factoryCalls).toBe(0);
    });
  });

  describe("session mode wiring", () => {
    it("default mode (stateless): factory is created per request so transport state cannot leak across agents", async () => {
      // PR1 remediation: the v1 default is stateless per-request so the
      // multi-agent transport cache cannot share a sessionId across
      // authenticated agents. Stateful mode is the documented opt-in
      // (single-agent only) — see the next test.
      let factoryCalls = 0;
      const factory: McpServerFactory = (() => {
        factoryCalls++;
        return {
          connect: async () => {},
          close: async () => {},
        } as never;
      }) as McpServerFactory;
      const { handle, port } = await startServer(
        makeOptions({ sessionMode: "stateless", serverFactory: factory }),
      );
      stopHandle = handle;
      const auth = `Bearer tok-a`;
      await http(port, "POST", "/mcp", { Authorization: auth }, "{}");
      await http(port, "POST", "/mcp", { Authorization: auth }, "{}");
      expect(factoryCalls).toBe(2);
    });

    it("stateful opt-in: factory is created once and the transport is cached, but this is single-agent only", async () => {
      // PR1 remediation: stateful mode is the documented opt-in. A
      // single cached transport keeps a single sessionId, so it MUST
      // NOT be used to serve multiple distinct agents in v1.
      let factoryCalls = 0;
      const factory: McpServerFactory = (() => {
        factoryCalls++;
        return {
          connect: async () => {},
          close: async () => {},
        } as never;
      }) as McpServerFactory;
      const { handle, port } = await startServer(
        makeOptions({ sessionMode: "stateful", serverFactory: factory }),
      );
      stopHandle = handle;
      // POST a couple of authorized requests; we expect a single factory call.
      const auth = `Bearer tok-a`;
      await http(port, "POST", "/mcp", { Authorization: auth }, "{}");
      await http(port, "POST", "/mcp", { Authorization: auth }, "{}");
      expect(factoryCalls).toBe(1);
    });

    it("stateless mode: factory is created per request", async () => {
      let factoryCalls = 0;
      const factory: McpServerFactory = (() => {
        factoryCalls++;
        return {
          connect: async () => {},
          close: async () => {},
        } as never;
      }) as McpServerFactory;
      const { handle, port } = await startServer(
        makeOptions({ sessionMode: "stateless", serverFactory: factory }),
      );
      stopHandle = handle;
      const auth = `Bearer tok-a`;
      await http(port, "POST", "/mcp", { Authorization: auth }, "{}");
      await http(port, "POST", "/mcp", { Authorization: auth }, "{}");
      expect(factoryCalls).toBe(2);
    });
  });

  describe("custom path", () => {
    it("routes the configured path and leaves /healthz untouched", async () => {
      const { handle, port } = await startServer(
        makeOptions({ path: "/mcp-readonly-sql" }),
      );
      stopHandle = handle;
      const res = await http(port, "GET", "/healthz");
      expect(res.status).toBe(200);
      // Wrong path gets 401 because auth still runs (the path is unknown but
      // the auth middleware short-circuits to 401 for missing headers).
      const noauth = await http(port, "POST", "/mcp-readonly-sql", {}, "{}");
      expect(noauth.status).toBe(401);
    });
  });
});
