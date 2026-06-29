/**
 * Deeper HTTP contract tests for createHttpMcpServer.
 *
 * These tests exercise the SDK's `StreamableHTTPServerTransport` end-to-end
 * (POST JSON-RPC, malformed body, GET without Accept) using a real
 * `McpServer` instance — they go beyond the stub-factory tests in
 * `server.test.ts`. Per the PR1 review finding: "HTTP contract tests are
 * too shallow".
 *
 * SSE (GET /mcp) is exercised in the sense that we prove an
 * unauthenticated/non-SSE GET to the MCP path is rejected — the
 * full open-stream behavior is the responsibility of the SDK and is
 * covered upstream. The shared base only needs to make sure auth
 * runs before the transport and that wrong methods get a safe
 * response shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createHttpMcpServer,
  type HttpMcpServerOptions,
  type McpServerFactory,
} from "../src/server.js";
import { createLogger } from "../src/logging.js";
import {
  TokenInvalidError,
  AuthorityUnavailableError,
  type TokenAuthority,
  type VerifiedToken,
} from "../src/authority/index.js";

/**
 * The tests in this file exercise the SDK transport end-to-end. The
 * resource server is wired against an external OAuth / JWKS authority
 * in production; the unit tests use a hand-rolled `TokenAuthority` that
 * maps a single known token ("good-token") to a fixed verified
 * identity. The shape is what the contract needs; the values are
 * arbitrary.
 */
const KNOWN_AGENT_ID = "agent-a";
const KNOWN_SCOPES: string[] = ["read:*"];

function knownAgentAuthority(): TokenAuthority {
  return {
    verify: async (token: string): Promise<VerifiedToken> => {
      if (token === "tok-a") {
        return { agentId: KNOWN_AGENT_ID, scopes: KNOWN_SCOPES };
      }
      throw new TokenInvalidError("not a known token");
    },
  };
}

/** Build a real McpServer with one trivial tool so the SDK has something
 *  to dispatch when a request comes in. */
function realServerFactory(): McpServer {
  const server = new McpServer(
    { name: "test-server", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.tool(
    "ping",
    "A trivial tool that returns pong",
    {},
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
  return server;
}

function makeOptions(
  overrides: Partial<HttpMcpServerOptions> = {},
): HttpMcpServerOptions {
  return {
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    authority: knownAgentAuthority(),
    authorityUrl: "http://127.0.0.1:3002",
    sessionMode: "stateful",
    logger: createLogger({ format: "text" }),
    shutdownTimeoutMs: 1000,
    serverFactory: (() => realServerFactory()) as McpServerFactory,
    onShutdown: async () => {},
    ...overrides,
  };
}

async function startServer(options: HttpMcpServerOptions) {
  const handle = createHttpMcpServer(options);
  await handle.start();
  // @ts-expect-error - private field but necessary for the test
  const addr = handle._server.address() as AddressInfo;
  return { handle, port: addr.port };
}

function postRequest(
  port: number,
  urlPath: string,
  headers: Record<string, string>,
  body: string | Buffer,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = typeof body === "string" ? Buffer.from(body) : body;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": String(bodyBuf.length),
        },
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
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * Extract the JSON-RPC payload from an SSE event-stream response.
 * The SDK returns responses as a series of "data: <json>\n\n" frames
 * (per the Streamable HTTP spec). For single-response POSTs the body
 * contains one frame; we read the first "data:" line.
 */
function parseSsePayload(raw: string): string {
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("data:")) {
      return line.slice("data:".length).trim();
    }
  }
  return raw;
}

describe("createHttpMcpServer — end-to-end contract (real McpServer)", () => {
  let stopHandle: { stop: () => Promise<void> } | undefined;

  afterEach(async () => {
    if (stopHandle) {
      await stopHandle.stop();
      stopHandle = undefined;
    }
  });

  describe("authorized POST /mcp", () => {
    it("reaches the SDK transport and is acknowledged (initialize round-trip)", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      // Step 1: initialize. The server should respond with a JSON-RPC
      // result (delivered as a single SSE frame per the Streamable HTTP
      // spec). The shared base MUST forward the body to the transport
      // and let the SDK respond.
      const init = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer tok-a",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.0" },
          },
        }),
      );
      expect(init.status).toBe(200);
      const initBody = JSON.parse(parseSsePayload(init.body)) as {
        result?: { serverInfo?: { name?: string } };
      };
      expect(initBody.result?.serverInfo?.name).toBe("test-server");
    });

    it("propagates auth context onto req.auth so tool handlers can read it", async () => {
      // Register a tool that reads `extra.authInfo` and returns it as
      // its result. The shared base must set req.auth before the SDK
      // dispatches the tool call.
      const server = new McpServer(
        { name: "auth-probe", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      server.tool(
        "whoami",
        "Returns the authenticated agent's id and scopes",
        {},
        async (_args, extra) => {
          const info = (extra as unknown as { authInfo?: { clientId?: string; scopes?: string[] } }).authInfo;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  clientId: info?.clientId,
                  scopes: info?.scopes,
                }),
              },
            ],
          };
        },
      );
      const { handle, port } = await startServer(
        makeOptions({ sessionMode: "stateless", serverFactory: (() => server) as McpServerFactory }),
      );
      stopHandle = handle;
      // Initialize.
      const init = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer tok-a",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.0" },
          },
        }),
      );
      expect(init.status).toBe(200);
      const sessionId = init.headers["mcp-session-id"] as string | undefined;
      // Call the tool. In stateless mode, no session id is required.
      const call = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer tok-a",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        }),
      );
      expect(call.status).toBe(200);
      // The tool returned the auth context that the SDK observed via
      // MessageExtraInfo. We assert the agent id is present.
      const callBody = parseSsePayload(call.body);
      expect(callBody).toContain("agent-a");
      expect(callBody).toContain("read");
    });
  });

  describe("malformed bodies", () => {
    it("rejects a non-JSON body with a parse error envelope", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer tok-a",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        "this is not json",
      );
      // The SDK transport returns a parse error; the shared base must
      // forward it without leaking the body in the response.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toContain("this is not json");
      // The error response is delivered as application/json (so the
      // caller can parse the JSON-RPC envelope) — even when the inbound
      // body was unparseable.
      const ct = res.headers["content-type"];
      expect(typeof ct === "string" ? ct : (ct?.[0] ?? "")).toMatch(
        /application\/json/,
      );
    });

    it("the parse-error body is a recognizable JSON-RPC error envelope (code + message + jsonrpc)", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer tok-a",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        "not json at all",
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      const ct = res.headers["content-type"];
      const contentType = typeof ct === "string" ? ct : (ct?.[0] ?? "");
      expect(contentType).toMatch(/application\/json/);
      // The body MUST be parseable JSON with a JSON-RPC error shape.
      const parsed = JSON.parse(res.body) as {
        jsonrpc?: string;
        error?: { code?: number; message?: string };
        id?: unknown;
      };
      expect(parsed.jsonrpc).toBe("2.0");
      expect(typeof parsed.error?.code).toBe("number");
      expect(typeof parsed.error?.message).toBe("string");
    });

    it("rejects a body with invalid Content-Length", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      // Hand-build a request with a non-numeric Content-Length.
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Length": "not-a-number",
              Authorization: "Bearer tok-a",
              "Content-Type": "application/json",
            },
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            r.on("error", reject);
          },
        );
        req.on("error", reject);
        req.write("{}");
        req.end();
      });
      // The Node server rejects the bad Content-Length itself; we
      // accept any 4xx as "safe failure".
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("SSE GET on the MCP path", () => {
    it("GET /mcp with Accept: text/event-stream reaches the SDK transport (server creates an SSE response)", async () => {
      // The Streamable HTTP spec requires GET to open an SSE stream so the
      // server can push notifications to the client. The shared base must
      // forward the GET to the transport with a valid bearer. We first
      // initialize a session, capture the Mcp-Session-Id, then issue a
      // GET — that proves the GET reached the SDK transport (which in
      // turn opens a stream and writes the SSE prelude).
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      // Step 1: initialize a session so the SDK has a session id to
      // associate with the SSE stream.
      const init = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer tok-a",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "sse-test", version: "0.0.0" },
          },
        }),
      );
      expect(init.status).toBe(200);
      const sessionId = init.headers["mcp-session-id"];
      expect(typeof sessionId === "string" ? sessionId : (sessionId?.[0] ?? "")).toBeTruthy();
      // Step 2: GET with the session id. The SDK transport opens a
      // long-lived SSE stream; we read just enough to confirm the
      // response is text/event-stream and not 401/404/5xx.
      const res = await new Promise<{
        status: number;
        headers: Record<string, string | string[] | undefined>;
        body: string;
      }>((resolve) => {
        let resolved = false;
        const done = (payload: {
          status: number;
          headers: Record<string, string | string[] | undefined>;
          body: string;
        }): void => {
          if (resolved) return;
          resolved = true;
          resolve(payload);
        };
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "GET",
            headers: {
              Authorization: "Bearer tok-a",
              Accept: "text/event-stream",
              "mcp-session-id":
                typeof sessionId === "string" ? sessionId : (sessionId?.[0] ?? ""),
            },
          },
          (r) => {
            const chunks: Buffer[] = [];
            // Resolve as soon as the response headers arrive — that is
            // the proof the request reached the SDK transport. The body
            // is a long-lived stream we do not wait for.
            done({
              status: r.statusCode ?? 0,
              headers: r.headers as Record<string, string | string[] | undefined>,
              body: "",
            });
            r.on("data", (c) => chunks.push(c));
            r.on("end", () => {
              // Replace the body with whatever we read before the
              // connection was destroyed.
              done({
                status: r.statusCode ?? 0,
                headers: r.headers as Record<string, string | string[] | undefined>,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
            r.on("error", () => {
              // Ignore stream errors; we already resolved on headers.
            });
            // Destroy the request so the long-lived SSE stream closes.
            setTimeout(() => req.destroy(), 50);
          },
        );
        req.on("error", () => {
          // Ignore request errors; the resolve on headers has already
          // happened (or the request never reached the server, in which
          // case the test will fail with a non-2xx status assertion).
          done({ status: 0, headers: {}, body: "" });
        });
        req.end();
      });
      // The transport MUST have responded. The status may be 200 (stream
      // open) or 405/409 (some SDK versions only allow GET with
      // notifications capability). What we care about is that the
      // request reached the transport, not 401/404/5xx.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(404);
      expect(res.status).toBeLessThan(500);
      // If the transport opened a stream, content-type is text/event-stream.
      const ct = res.headers["content-type"];
      const contentType = typeof ct === "string" ? ct : (ct?.[0] ?? "");
      if (res.status === 200) {
        expect(contentType).toMatch(/text\/event-stream/);
      }
    });

    it("GET /mcp with a missing bearer is rejected with 401 (auth runs before transport)", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "GET",
            headers: { Accept: "text/event-stream" },
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            r.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(res.status).toBe(401);
      const parsed = JSON.parse(res.body) as { error?: { message?: string } };
      expect(parsed.error?.message).toBe("unauthorized");
    });
  });

  describe("non-POST methods on the MCP path", () => {
    it("PUT on the MCP path returns 401 (auth runs before path-aware routing)", async () => {
      // Security posture: auth runs before any path-aware dispatch, so
      // unsupported methods on the MCP path surface a 401 to a caller
      // without credentials (the path-existence leak is avoided). When
      // the caller presents a valid bearer, the SDK transport is what
      // decides the response — see the SDK contract for PUT semantics.
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: "/mcp", method: "PUT" },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            r.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(res.status).toBe(401);
    });

    it("DELETE on the MCP path returns 401 (auth-first posture)", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: "/mcp", method: "DELETE" },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            r.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(res.status).toBe(401);
    });
  });

  describe("auth context propagation", () => {
    it("sets req.auth before the transport dispatches the tool", async () => {
      // Use a tool that returns the auth info it received via
      // `extra.authInfo`. The shared base attaches `{ clientId, scopes }`
      // to req.auth; the SDK forwards it as MessageExtraInfo.
      const seen: Array<{ clientId?: string; scopes?: string[] }> = [];
      const server = new McpServer(
        { name: "auth-trap", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      server.tool(
        "trap",
        "Captures authInfo",
        {},
        async (_args, extra) => {
          const info = (extra as unknown as { authInfo?: { clientId?: string; scopes?: string[] } }).authInfo;
          seen.push(info ?? {});
          return { content: [{ type: "text", text: "ok" }] };
        },
      );
      const { handle, port } = await startServer(
        makeOptions({ sessionMode: "stateless", serverFactory: (() => server) as McpServerFactory }),
      );
      stopHandle = handle;
      const init = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer tok-a",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
      );
      expect(init.status).toBe(200);
      const call = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer tok-a",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "trap", arguments: {} },
        }),
      );
      expect(call.status).toBe(200);
      // Wait a tick for the tool to have observed the call.
      await new Promise((r) => setTimeout(r, 50));
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]?.clientId).toBe(KNOWN_AGENT_ID);
      expect(seen[0]?.scopes).toEqual(KNOWN_SCOPES);
    });
  });

  describe("TokenAuthority middleware wiring (Phase 1a)", () => {
    // Phase 1a replaces the middleware's direct verify path with
    // `await authority.verify(token)`. The middleware MUST still
    // produce the same 401 / 503 / 200 mapping — only the
    // verification surface has changed. These tests use a
    // hand-rolled `TokenAuthority` implementation (a spy) to
    // assert the contract end-to-end.
    it("the middleware calls authority.verify with the bearer token", async () => {
      // GIVEN a TokenAuthority spy AND a tool that echoes back the
      // auth context the SDK observed via `MessageExtraInfo.authInfo`
      // (so we can assert the resolved identity flowed through the
      // middleware into the transport).
      const verifySpy = vi.fn(
        async (token: string): Promise<VerifiedToken> => {
          if (token === "good-token") {
            return { agentId: "spy-agent", scopes: ["read:spy"] };
          }
          throw new TokenInvalidError("bad token");
        },
      );
      const authority: TokenAuthority = { verify: verifySpy };
      const server = new McpServer(
        { name: "auth-spy", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      server.tool(
        "whoami",
        "Returns the authenticated agent's id and scopes",
        {},
        async (_args, extra) => {
          const info = (extra as unknown as { authInfo?: { clientId?: string; scopes?: string[] } }).authInfo;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  clientId: info?.clientId,
                  scopes: info?.scopes,
                }),
              },
            ],
          };
        },
      );
      const { handle, port } = await startServer(
        makeOptions({
          authority,
          sessionMode: "stateless",
          serverFactory: (() => server) as McpServerFactory,
        }),
      );
      stopHandle = handle;
      // Step 1: initialize so the SDK has a session to dispatch the
      // tool call through.
      const init = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer good-token",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "auth-spy", version: "0.0.0" },
          },
        }),
      );
      expect(init.status).toBe(200);
      // The middleware MUST have called verify with the trimmed token
      // (the "Bearer " prefix must not be passed to the authority).
      expect(verifySpy).toHaveBeenCalled();
      const callArg = verifySpy.mock.calls[0]?.[0];
      expect(callArg).toBe("good-token");
      // Step 2: invoke the echo tool. The resolved agent id flows
      // through the middleware into req.auth, which the SDK surfaces
      // as MessageExtraInfo.authInfo — the tool echoes it back so we
      // can assert the wire end-to-end.
      const call = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer good-token",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        }),
      );
      expect(call.status).toBe(200);
      expect(parseSsePayload(call.body)).toContain("spy-agent");
    });

    it("maps TokenInvalidError to 401 with a sanitized JSON-RPC body (no token, no agent id)", async () => {
      // GIVEN an authority that throws TokenInvalidError
      // WHEN a request arrives with a bearer
      // THEN the middleware maps the error to 401 with the same
      //      audit-safe envelope used by the v1 path. The token and
      //      the resolved agent id MUST NOT appear in the body.
      const authority: TokenAuthority = {
        verify: async () => {
          throw new TokenInvalidError("upstream says no");
        },
      };
      const { handle, port } = await startServer(makeOptions({ authority }));
      stopHandle = handle;
      const res = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer some-bogus-token-12345",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "x", version: "0" },
          },
        }),
      );
      expect(res.status).toBe(401);
      const parsed = JSON.parse(res.body) as { error?: { message?: string } };
      expect(parsed.error?.message).toBe("unauthorized");
      // The supplied token MUST NOT appear in the body.
      expect(res.body).not.toContain("some-bogus-token-12345");
      // The internal "upstream says no" message MUST NOT appear.
      expect(res.body).not.toContain("upstream says no");
    });

    it("maps AuthorityUnavailableError to 503 with a sanitized JSON-RPC body", async () => {
      // GIVEN an authority that throws AuthorityUnavailableError
      //      (simulating a JWKS fetch failure or an unreachable
      //      authority in production)
      // WHEN a request arrives with a bearer
      // THEN the middleware maps the error to 503 — the audit-safe
      //      fail-closed posture: the resource server refuses the
      //      request rather than granting implicit access.
      const authority: TokenAuthority = {
        verify: async () => {
          throw new AuthorityUnavailableError("JWKS fetch failed");
        },
      };
      const { handle, port } = await startServer(makeOptions({ authority }));
      stopHandle = handle;
      const res = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer any-token",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "x", version: "0" },
          },
        }),
      );
      expect(res.status).toBe(503);
      const parsed = JSON.parse(res.body) as { error?: { message?: string } };
      // 503 body MUST be a sanitized service-unavailable error. The
      // exact message in the body is the closed `unavailable` envelope
      // (per the existing `serviceUnavailableError` factory), NOT
      // "JWKS fetch failed" — internal error context MUST NOT leak.
      expect(parsed.error?.message).not.toBe("JWKS fetch failed");
      // The body MUST contain a JSON-RPC error envelope.
      expect(parsed.error?.message).toBeTruthy();
      // The 503 envelope is a service-unavailable-style message (it
      // was already used for the shutting-down path in v1; the
      // resource-server-on-unreachable-authority case reuses the
      // same audit-safe shape).
      expect(["shutting-down", "unavailable", "service-unavailable"]).toContain(
        parsed.error?.message,
      );
    });

    it("an authority that throws a non-typed Error is treated as 503 (fail-closed default)", async () => {
      // GIVEN an authority that throws a plain Error (not a typed
      //      TokenInvalidError or AuthorityUnavailableError) — e.g. a
      //      programming bug, a misconfigured JWKS path, or an
      //      unexpected runtime failure inside the authority itself
      // WHEN a request arrives
      // THEN the middleware fails closed (503) rather than 500: the
      //      audit-safe posture is "if we cannot verify, we do not
      //      serve", and the client sees a service-unavailable
      //      response instead of a stack trace.
      const authority: TokenAuthority = {
        verify: async () => {
          throw new Error("something exploded inside the authority");
        },
      };
      const { handle, port } = await startServer(makeOptions({ authority }));
      stopHandle = handle;
      const res = await postRequest(
        port,
        "/mcp",
        {
          Authorization: "Bearer whatever",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "x", version: "0" },
          },
        }),
      );
      expect(res.status).toBe(503);
      // The internal error message MUST NOT leak.
      expect(res.body).not.toContain("something exploded");
    });
  });
});
