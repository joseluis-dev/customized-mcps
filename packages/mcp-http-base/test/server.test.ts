import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHttpMcpServer,
  type HttpMcpServerOptions,
  type McpServerFactory,
  type TokenAuthority,
  type VerifiedToken,
} from "../src/server.js";
import { createLogger } from "../src/logging.js";

/** Local stand-in for the OAuth authority URL. The well-known handler and the
 * 401 `WWW-Authenticate` header use this in tests; production wires the
 * real `MCP_AUTHORITY_URL`. */
const TEST_AUTHORITY_URL = "http://127.0.0.1:3002";

/**
 * A hand-rolled `TokenAuthority` for the unit tests in this file. The
 * resource server is wired against an external OAuth / JWKS authority
 * in production; the unit tests use a spy so the wire contract
 * (TokenInvalidError → 401, AuthorityUnavailableError → 503) can be
 * exercised without spinning up a real authority.
 */
function makeSpyAuthority(
  verifier: (token: string) => Promise<VerifiedToken>,
): TokenAuthority & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    verify: async (token: string): Promise<VerifiedToken> => {
      calls.push(token);
      return verifier(token);
    },
  };
}

function makeOptions(
  overrides: Partial<HttpMcpServerOptions> = {},
): HttpMcpServerOptions {
  return {
    host: "127.0.0.1",
    port: 0, // OS-assigned ephemeral port
    path: "/mcp",
    authority: makeSpyAuthority(async (token) => {
      if (token === "tok-a") {
        return { agentId: "agent-a", scopes: ["read:*"] };
      }
      throw new (await import("../src/authority/index.js")).TokenInvalidError("nope");
    }),
    authorityUrl: TEST_AUTHORITY_URL,
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
    it("returns 200 with status=ok and authorityBackend=oauth while healthy", async () => {
      // Phase 1b: the health endpoint returns JSON so it can carry
      // the `authorityBackend` field per the mcp-token-authority spec.
      // The body MUST NOT include tokens, `kid`, JWKS URL, or
      // authority URL. The default backend label is "oauth" (the only
      // production-shape backend after the local HMAC roster was
      // removed).
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await http(port, "GET", "/healthz");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status?: string; authorityBackend?: string };
      expect(body.status).toBe("ok");
      expect(body.authorityBackend).toBe("oauth");
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
      expect(body.authorityBackend).toBe("oauth");
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

    it("returns 401 for a malformed bearer token (not accepted by the authority)", async () => {
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

  describe("WWW-Authenticate on 401", () => {
    // RFC 6750 §3 + RFC 9728 §5.1: a 401 from a resource server MUST
    // include `WWW-Authenticate: Bearer resource_metadata="<url>"` so
    // the client can discover the authority. The URL MUST point at the
    // resource server's own well-known endpoint (NOT the authority
    // issuer). The 401 body is the sanitized JSON-RPC envelope; only
    // the header is new.

    it("emits WWW-Authenticate with the env-driven resource_server_url on a 401 (missing bearer)", async () => {
      const { handle, port } = await startServer(
        makeOptions({ resourceServerUrl: "https://mcp.example.com" }),
      );
      stopHandle = handle;
      const res = await http(port, "POST", "/mcp", {}, "{}");
      expect(res.status).toBe(401);
      const wwwAuth = res.headers["www-authenticate"];
      expect(typeof wwwAuth === "string" ? wwwAuth : wwwAuth?.[0]).toBe(
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      );
    });

    it("falls back to the request Host header (http://) when no resourceServerUrl is set", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await http(port, "POST", "/mcp", {}, "{}");
      expect(res.status).toBe(401);
      const wwwAuth = res.headers["www-authenticate"];
      expect(typeof wwwAuth === "string" ? wwwAuth : wwwAuth?.[0]).toBe(
        `Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`,
      );
    });

    it("uses x-forwarded-proto when present (https behind a TLS-terminating proxy)", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await http(
        port,
        "POST",
        "/mcp",
        { "X-Forwarded-Proto": "https" },
        "{}",
      );
      expect(res.status).toBe(401);
      const wwwAuth = res.headers["www-authenticate"];
      expect(typeof wwwAuth === "string" ? wwwAuth : wwwAuth?.[0]).toBe(
        `Bearer resource_metadata="https://127.0.0.1:${port}/.well-known/oauth-protected-resource"`,
      );
    });

    it("does NOT emit WWW-Authenticate on 503 (authority-unavailable is a transport problem, not an auth challenge)", async () => {
      const { AuthorityUnavailableError } = await import("../src/authority/index.js");
      const authority: TokenAuthority = {
        verify: async () => {
          throw new AuthorityUnavailableError("JWKS down");
        },
      };
      const { handle, port } = await startServer(
        makeOptions({
          authority,
          resourceServerUrl: "https://mcp.example.com",
        }),
      );
      stopHandle = handle;
      const res = await http(
        port,
        "POST",
        "/mcp",
        { Authorization: "Bearer anything" },
        "{}",
      );
      expect(res.status).toBe(503);
      expect(res.headers["www-authenticate"]).toBeUndefined();
    });

    it("the 401 body remains the sanitized JSON-RPC envelope (no token / no agent id leaked)", async () => {
      const { handle, port } = await startServer(
        makeOptions({ resourceServerUrl: "https://mcp.example.com" }),
      );
      stopHandle = handle;
      const res = await http(
        port,
        "POST",
        "/mcp",
        { Authorization: "Bearer secret-token-value-12345" },
        "{}",
      );
      expect(res.status).toBe(401);
      expect(res.body).not.toContain("secret-token-value-12345");
      const parsed = JSON.parse(res.body) as { error?: { message?: string } };
      expect(parsed.error?.message).toBe("unauthorized");
    });
  });

  describe("GET /.well-known/oauth-protected-resource", () => {
    // RFC 9728 §3.1: the protected resource metadata document. The
    // resource server returns its own public base URL in `resource`
    // and the OAuth authority's URL in `authorization_servers`. The
    // handler is unauthenticated by design — clients discover the
    // authority from the resource server, then start the auth-code
    // flow against the authority.

    it("returns RFC 9728 JSON with the env-driven resource URL and the authority's issuer URL", async () => {
      const { handle, port } = await startServer(
        makeOptions({
          resourceServerUrl: "https://mcp.example.com",
        }),
      );
      stopHandle = handle;
      const res = await http(
        port,
        "GET",
        "/.well-known/oauth-protected-resource",
      );
      expect(res.status).toBe(200);
      const ct = res.headers["content-type"];
      expect(typeof ct === "string" ? ct : ct?.[0]).toMatch(/application\/json/);
      const body = JSON.parse(res.body) as {
        resource?: string;
        authorization_servers?: string[];
        bearer_methods_supported?: string[];
        scopes_supported?: string[];
      };
      expect(body.resource).toBe("https://mcp.example.com");
      expect(body.authorization_servers).toEqual([TEST_AUTHORITY_URL]);
      expect(body.bearer_methods_supported).toEqual(["header"]);
      // PR 1 of `remove-scope-authorization`: the resource server
      // always advertises `scopes_supported: []` regardless of any
      // legacy scope storage. The previous `scopeCatalog` option is
      // removed.
      expect(body.scopes_supported).toEqual([]);
    });

    it("uses the request Host as the `resource` value when no MCP_RESOURCE_SERVER_URL is set", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await http(
        port,
        "GET",
        "/.well-known/oauth-protected-resource",
      );
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { resource?: string };
      expect(body.resource).toBe(`http://127.0.0.1:${port}`);
    });

    it("always returns scopes_supported: [] (PR 1 task 1.5: scopeCatalog option removed)", async () => {
      // The previous contract had a `scopeCatalog` option that
      // contributed entries to `scopes_supported`. The
      // `remove-scope-authorization` change makes `scopes_supported`
      // always `[]` — the field is retained for RFC 9728 schema
      // compliance, not as a source of authorization.
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await http(
        port,
        "GET",
        "/.well-known/oauth-protected-resource",
      );
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { scopes_supported?: string[] };
      expect(body.scopes_supported).toEqual([]);
    });

    it("the well-known endpoint does not require an Authorization header (it's public, per RFC 9728)", async () => {
      const { handle, port } = await startServer(makeOptions());
      stopHandle = handle;
      const res = await http(
        port,
        "GET",
        "/.well-known/oauth-protected-resource",
      );
      expect(res.status).toBe(200);
    });
  });
});
