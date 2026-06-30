import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { runHttpTransport } from "../../src/transports/http.js";
import { buildReadOnlyMcpServer } from "../../src/serverFactory.js";
import type { Profile, SafetyLimits } from "../../src/types.js";
import {
  type HttpRuntimeConfig,
} from "../../src/config/http.js";
import {
  TokenInvalidError,
  type Logger,
  type TokenAuthority,
  type VerifiedToken,
} from "@customized-mcps/mcp-http-base";

/**
 * The local HMAC roster backend was removed. The transport unit
 * tests use a hand-rolled `TokenAuthority` (spy) that maps a single
 * known token to a fixed verified identity. The wire contract is
 * the same; the values are arbitrary.
 */
function knownAgentAuthority(): TokenAuthority {
  return {
    verify: async (token: string): Promise<VerifiedToken> => {
      if (token === "tok-a") {
        return { agentId: "agent-a", scopes: ["read:*"] };
      }
      throw new TokenInvalidError("not a known token");
    },
  };
}

const TEST_LIMITS: SafetyLimits = {
  maxRowsDefault: 100,
  maxRowsHardLimit: 1000,
  queryTimeoutMsDefault: 10_000,
  queryTimeoutMsHardLimit: 60_000,
};

const FAKE_SQLITE_PROFILE: Profile = {
  name: "SQLITE_FAKE",
  alias: "SQLITE_FAKE",
  operatorKey: "SQLITE_FAKE",
  dialect: "sqlite",
  client: "sqlite",
  scope: "database",
  initialDatabase: "main",
  allowedDatabases: ["main"],
  requireQualifiedDatabase: true,
  capabilities: ["read-only"],
  connection: { kind: "sqlite", filename: ":memory:" },
  knexOptions: {},
};

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function makeConfig(overrides: Partial<HttpRuntimeConfig> = {}): HttpRuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    stateless: true,
    sessionMode: "stateless",
    shutdownTimeoutMs: 1000,
    logFormat: "text",
    behindProxy: false,
    allowInsecureBind: false,
    allowUnboundedBody: false,
    // The resource server is wired against an external authority;
    // the unit tests inject a known-token spy so the wire contract
    // is exercised without spinning up a real authority.
    authority: knownAgentAuthority(),
    authorityBackend: "oauth",
    authorityUrl: "https://auth.example.com",
    authorityJwksUrl: undefined,
    authorityAudience: "mcp-readonly-sql",
    authorityJwksTtlSeconds: 60,
    authorityLeewaySeconds: 30,
    authorityFetchTimeoutMs: 5000,
    ...overrides,
  };
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
    if (body !== undefined) req.write(body);
    req.on("error", reject);
    req.end();
  });
}

describe("transports/http", () => {
  let activeHandles: Array<{ stop: () => Promise<void> }> = [];

  beforeEach(() => {
    activeHandles = [];
  });

  afterEach(async () => {
    for (const h of activeHandles) {
      await h.stop();
    }
    activeHandles = [];
  });

  describe("runHttpTransport", () => {
    it("starts an HTTP server on the configured host/port/path and returns a usable handle", async () => {
      // GIVEN a valid config + a built server
      // WHEN the transport is started
      // THEN it returns a handle with start/stop and the server is reachable
      const cfg = makeConfig({ port: 0 });
      const handle = runHttpTransport({ config: cfg, serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server });
      await handle.start();
      activeHandles.push(handle);

      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

      // Resolve the OS-assigned port from the URL so the test does not
      // depend on the production-config port.
      const port = Number(new URL(handle.url).port);
      const res = await http(port, "GET", "/healthz");
      expect(res.status).toBe(200);
      // Phase 1b: the health endpoint returns JSON with the
      // `authorityBackend` field (per the mcp-token-authority spec).
      // The default is "oauth" now that the local HMAC backend was
      // removed.
      const body = JSON.parse(res.body) as { status?: string; authorityBackend?: string };
      expect(body.status).toBe("ok");
      expect(body.authorityBackend).toBe("oauth");
    });

    it("returns 401 when a request to /mcp has no Authorization header", async () => {
      // GIVEN the server is up
      // WHEN an unauthenticated POST /mcp is sent
      // THEN the response is 401 with a sanitized JSON-RPC body
      const cfg = makeConfig({ port: 0 });
      const handle = runHttpTransport({ config: cfg, serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server });
      await handle.start();
      activeHandles.push(handle);
      const port = Number(new URL(handle.url).port);
      const res = await http(port, "POST", "/mcp", { "Content-Type": "application/json" }, "{}");
      expect(res.status).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error).toBeDefined();
    });

    it("returns 401 when a request to /mcp has a wrong bearer token", async () => {
      // GIVEN the server is up
      // WHEN a POST /mcp is sent with an invalid bearer token
      // THEN the response is 401 (the authority rejected the token; the
      //      middleware sanitizes the body to avoid leaking the token
      //      fragment).
      const cfg = makeConfig({ port: 0 });
      const handle = runHttpTransport({ config: cfg, serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server });
      await handle.start();
      activeHandles.push(handle);
      const port = Number(new URL(handle.url).port);
      const res = await http(port, "POST", "/mcp", {
        "Authorization": "Bearer wrong-token",
        "Content-Type": "application/json",
      }, "{}");
      expect(res.status).toBe(401);
      // Token MUST NOT appear in the body.
      expect(res.body).not.toContain("wrong-token");
    });

    it("exposes /healthz outside the authenticated path (no Authorization required)", async () => {
      // GIVEN the server is up
      // WHEN an unauthenticated GET /healthz is sent
      // THEN the response is 200 with body { status: "ok", authorityBackend: "oauth" }
      const cfg = makeConfig({ port: 0 });
      const handle = runHttpTransport({ config: cfg, serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server });
      await handle.start();
      activeHandles.push(handle);
      const port = Number(new URL(handle.url).port);
      const res = await http(port, "GET", "/healthz");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status?: string; authorityBackend?: string };
      expect(body.status).toBe("ok");
      expect(body.authorityBackend).toBe("oauth");
    });

    it("stop() closes the listener (subsequent /healthz attempts fail with ECONNREFUSED)", async () => {
      // GIVEN the server is up
      // WHEN stop() is awaited
      // THEN the listener is closed — a follow-up /healthz request fails
      // with a connection error (the OS rejects the connection because
      // there is no longer a listener on the port).
      //
      // This is the app-side mirror of the shared base's 503-on-drain
      // contract: the shared base's own tests cover the
      // `markShuttingDown` → 503 path; here we verify the app's
      // transport handle wires stop() into the shared base's drain.
      const cfg = makeConfig({ port: 0, shutdownTimeoutMs: 500 });
      const handle = runHttpTransport({ config: cfg, serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server });
      await handle.start();
      const port = Number(new URL(handle.url).port);
      await handle.stop();
      // The port is no longer accepting connections. We assert the
      // promise rejects with a connection error so we are not coupled
      // to the exact text of the error.
      await expect(http(port, "GET", "/healthz")).rejects.toThrow();
    });

    it("passes stateless=true to the shared base when config.sessionMode is 'stateless'", () => {
      // GIVEN a config with sessionMode="stateless"
      // WHEN the transport is built
      // THEN the underlying createHttpMcpServer is called with sessionMode="stateless"
      //
      // We assert by inspection: the factory is wrapped in a callable
      // that records the options. The shared base is exercised by the
      // contract tests in packages/mcp-http-base/test/; here we just
      // verify the wiring.
      const cfg = makeConfig({ sessionMode: "stateless" });
      const observed: { sessionMode?: string } = {};
      const handle = runHttpTransport({
        config: cfg,
        serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server,
        onOptionsBuilt: (opts) => {
          observed.sessionMode = opts.sessionMode;
        },
      });
      // We never call start() — we just inspect the wired options.
      expect(observed.sessionMode).toBe("stateless");
      // The handle still exposes the same start/stop surface even if we
      // never start it; the assertion is the only test goal here.
      expect(typeof handle.start).toBe("function");
      expect(typeof handle.stop).toBe("function");
    });

    it("passes stateless=false to the shared base when config.sessionMode is 'stateful'", () => {
      // GIVEN a config with sessionMode="stateful" (the single-agent opt-in)
      // WHEN the transport is built
      // THEN the underlying createHttpMcpServer is called with sessionMode="stateful"
      const cfg = makeConfig({ sessionMode: "stateful", stateless: false });
      const observed: { sessionMode?: string } = {};
      const handle = runHttpTransport({
        config: cfg,
        serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server,
        onOptionsBuilt: (opts) => {
          observed.sessionMode = opts.sessionMode;
        },
      });
      expect(observed.sessionMode).toBe("stateful");
    });

    it("passes allowUnboundedBody=true to the shared base when config.allowUnboundedBody is true", () => {
      // GIVEN a config with allowUnboundedBody=true (the chunked-body opt-in)
      // WHEN the transport is built
      // THEN the underlying createHttpMcpServer is called with
      //      allowUnboundedBody=true (so the shared base accepts chunked
      //      transfer-encoded bodies with a one-shot warning, instead of
      //      rejecting them with 411 Length Required).
      const cfg = makeConfig({ allowUnboundedBody: true });
      const observed: { allowUnboundedBody?: boolean } = {};
      const handle = runHttpTransport({
        config: cfg,
        serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server,
        onOptionsBuilt: (opts) => {
          observed.allowUnboundedBody = opts.allowUnboundedBody;
        },
      });
      expect(observed.allowUnboundedBody).toBe(true);
    });

    it("forwards allowUnboundedBody=false to the shared base when the operator did not opt in (safe default)", () => {
      // GIVEN a config with allowUnboundedBody=false (the operator did
      // not set MCP_HTTP_ALLOW_UNBOUNDED_BODY)
      // WHEN the transport is built
      // THEN the underlying createHttpMcpServer is called with
      //      allowUnboundedBody=false. The shared base treats `false`
      //      (and `undefined`) identically — chunked bodies are rejected
      //      with 411 Length Required. Forwarding the literal false
      //      makes the wire contract explicit and avoids any "implicit
      //      default" ambiguity.
      const cfg = makeConfig({ allowUnboundedBody: false });
      const observed: { allowUnboundedBody?: boolean } = {};
      const handle = runHttpTransport({
        config: cfg,
        serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server,
        onOptionsBuilt: (opts) => {
          observed.allowUnboundedBody = opts.allowUnboundedBody;
        },
      });
      expect(observed.allowUnboundedBody).toBe(false);
    });

    it("stop() is idempotent (a second stop() resolves without throwing)", async () => {
      // GIVEN a started transport
      // WHEN stop() is called twice
      // THEN both calls resolve
      const cfg = makeConfig({ port: 0 });
      const handle = runHttpTransport({ config: cfg, serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server });
      await handle.start();
      await expect(handle.stop()).resolves.toBeUndefined();
      await expect(handle.stop()).resolves.toBeUndefined();
    });

    describe("scopeCatalog wiring (PR4 task 4.1 + 4.2)", () => {
      // The resource server exposes `scopes_supported` at
      // `/.well-known/oauth-protected-resource` (RFC 9728 + the
      // `mcp-token-authority` delta). The catalog is supplied by the
      // app via `RunHttpTransportOptions.scopeCatalog`; the shared
      // base invokes the closure on every well-known request so the
      // value is fresh. The app side derives the catalog from
      // profile aliases + an optional `MCP_RESOURCE_SCOPES` env
      // override (see `config/scopeCatalog.ts`); here we just verify
      // the wiring from the transport to the shared base.

      it("forwards the scopeCatalog option to the shared base when set", () => {
        // GIVEN a transport built with a scopeCatalog option
        // WHEN the transport is built
        // THEN the underlying createHttpMcpServer is called with the
        //      same scopeCatalog function (the shared base invokes
        //      it on every well-known request).
        const cfg = makeConfig({ port: 0 });
        const catalog = (): string[] => ["read:demo", "list:demo"];
        const observed: { scopeCatalog?: () => string[] } = {};
        const handle = runHttpTransport({
          config: cfg,
          serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server,
          scopeCatalog: catalog,
          onOptionsBuilt: (opts) => {
            observed.scopeCatalog = opts.scopeCatalog;
          },
        });
        // The forwarded catalog IS the same function reference.
        expect(observed.scopeCatalog).toBe(catalog);
        // The catalog returns the expected scopes when invoked.
        expect(observed.scopeCatalog?.()).toEqual(["read:demo", "list:demo"]);
        // The handle is still well-formed even though we never start it.
        expect(typeof handle.start).toBe("function");
        expect(typeof handle.stop).toBe("function");
      });

      it("omits the scopeCatalog option from the shared base when not set (defaults to [] per RFC 9728)", () => {
        // GIVEN a transport built WITHOUT a scopeCatalog option
        // WHEN the transport is built
        // THEN the underlying createHttpMcpServer is called without
        //      a scopeCatalog field, so the shared base falls back
        //      to the documented default of `() => []` (the catalog
        //      is the resource server's responsibility, not the
        //      shared base's).
        const cfg = makeConfig({ port: 0 });
        const observed: { scopeCatalog?: () => string[] } = {};
        runHttpTransport({
          config: cfg,
          serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server,
          onOptionsBuilt: (opts) => {
            observed.scopeCatalog = opts.scopeCatalog;
          },
        });
        expect(observed.scopeCatalog).toBeUndefined();
      });

      it("the well-known endpoint reflects the scopeCatalog (read+list per profile alias)", async () => {
        // GIVEN a transport built with a scopeCatalog derived from
        //      a single profile's alias (the app's default path when
        //      `MCP_RESOURCE_SCOPES` is unset)
        // WHEN a client calls `GET /.well-known/oauth-protected-resource`
        // THEN the response body includes the catalog scopes in
        //      `scopes_supported`.
        const cfg = makeConfig({ port: 0 });
        // The catalog mirrors the app's buildScopeCatalog() for a
        // single profile with alias "demo" (the FAKE_SQLITE_PROFILE
        // above uses operatorKey SQLITE_FAKE, so we use the
        // resulting alias "SQLITE_FAKE" — we exercise the same
        // shape the production code would produce).
        const catalog = (): string[] => ["read:SQLITE_FAKE", "list:SQLITE_FAKE"];
        const handle = runHttpTransport({
          config: cfg,
          serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server,
          scopeCatalog: catalog,
        });
        await handle.start();
        activeHandles.push(handle);
        const port = Number(new URL(handle.url).port);
        const res = await http(port, "GET", "/.well-known/oauth-protected-resource");
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as {
          resource?: string;
          authorization_servers?: string[];
          scopes_supported?: string[];
        };
        expect(body.scopes_supported).toEqual(["read:SQLITE_FAKE", "list:SQLITE_FAKE"]);
        // The other RFC 9728 fields are still present (the catalog
        // is additive — the shared base still owns resource,
        // authorization_servers, bearer_methods_supported).
        expect(body.bearer_methods_supported).toEqual(["header"]);
        expect(body.authorization_servers).toEqual([cfg.authorityUrl]);
        // The well-known endpoint is unauthenticated; the body
        // MUST NOT include the operator's token or agent id.
        expect(res.body).not.toContain("Bearer");
        expect(res.body).not.toContain("tok-a");
      });

      it("the well-known endpoint reflects an MCP_RESOURCE_SCOPES env override (the env branch wins over the profile branch)", async () => {
        // GIVEN a transport built with a scopeCatalog derived from
        //      an operator-set `MCP_RESOURCE_SCOPES` env var
        // WHEN a client calls the well-known endpoint
        // THEN the response body advertises the env value, NOT the
        //      profile-derived catalog. The minimal-path catalog
        //      source-of-truth is the env when set; the profile
        //      derivation is the fallback.
        const cfg = makeConfig({ port: 0 });
        // Mirrors `buildScopeCatalog(profiles, { MCP_RESOURCE_SCOPES: "read:foo, list:bar" })`.
        const catalog = (): string[] => ["read:foo", "list:bar"];
        const handle = runHttpTransport({
          config: cfg,
          serverFactory: () => buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server,
          scopeCatalog: catalog,
        });
        await handle.start();
        activeHandles.push(handle);
        const port = Number(new URL(handle.url).port);
        const res = await http(port, "GET", "/.well-known/oauth-protected-resource");
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as { scopes_supported?: string[] };
        expect(body.scopes_supported).toEqual(["read:foo", "list:bar"]);
      });
    });
  });
});
