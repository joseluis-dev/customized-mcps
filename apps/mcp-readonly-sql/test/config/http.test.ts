import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadHttpRuntimeConfig,
  type HttpRuntimeConfig,
  HttpRuntimeConfigError,
} from "../../src/config/http.js";

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Do NOT set MCP_TRANSPORT here — the config loader is for HTTP mode;
  // the dispatcher in src/index.ts is what reads MCP_TRANSPORT.
  delete process.env.MCP_TRANSPORT;
});

afterEach(() => {
  process.env = savedEnv;
  // Unstub `fetch` (and any other globals) the tests injected. Centralising
  // this in `afterEach` removes the per-test `try/finally` block that was
  // duplicated across every stubbing site — a small readability win that
  // also makes it harder to forget cleanup on a new test.
  vi.unstubAllGlobals();
});

/**
 * Stub the JWKS + introspect endpoints the OAuthAdminAuthority.warm()
 * probe calls. The stub returns a minimal JWKS document and a
 * `{ active: false }` introspect response. A test that exercises a
 * probe failure overrides `fetchStub` to throw.
 */
function stubAuthorityEndpoints(): ReturnType<typeof vi.fn> {
  const jwks = JSON.stringify({ keys: [] });
  const introspect = JSON.stringify({ active: false });
  const fetchStub = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/.well-known/jwks.json")) {
      return new Response(jwks, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/oauth/introspect")) {
      return new Response(introspect, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

describe("config/http", () => {
  describe("loadHttpRuntimeConfig", () => {
    it("returns a HttpRuntimeConfig with all fields populated from env", async () => {
      // GIVEN a valid OAuth authority (MCP_AUTHORITY_URL + audience) and a stubbed fetch
      // WHEN we load the runtime config
      // THEN every field is populated, including sessionMode derived from stateless
      stubAuthorityEndpoints();
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      process.env.MCP_HTTP_HOST = "127.0.0.1";
      process.env.MCP_HTTP_PORT = "3001";
      process.env.MCP_HTTP_PATH = "/mcp";
      process.env.MCP_HTTP_STATELESS = "true";
      process.env.MCP_HTTP_SHUTDOWN_TIMEOUT_MS = "5000";
      process.env.MCP_LOG_FORMAT = "json";

      const cfg: HttpRuntimeConfig = await loadHttpRuntimeConfig();
      expect(cfg.host).toBe("127.0.0.1");
      expect(cfg.port).toBe(3001);
      expect(cfg.path).toBe("/mcp");
      expect(cfg.stateless).toBe(true);
      expect(cfg.shutdownTimeoutMs).toBe(5000);
      expect(cfg.logFormat).toBe("json");
      expect(cfg.authorityBackend).toBe("oauth");
      expect(cfg.authorityUrl).toBe("https://auth.example.com");
      expect(cfg.authorityAudience).toBe("mcp-readonly-sql");
    });

    it("defaults port to 3001 when MCP_HTTP_PORT is unset (spec 'Port Allocation Convention')", async () => {
      // GIVEN MCP_HTTP_PORT is unset (operator did not uncomment the .env.example line)
      // WHEN we load the runtime config
      // THEN cfg.port is 3001 — the app-scoped default per the spec
      // (the shared base's default is 3000; the app overrides it to 3001
      // because mcp-readonly-sql binds 3001 by convention so multiple
      // apps can coexist on the same host).
      stubAuthorityEndpoints();
      delete process.env.MCP_HTTP_PORT;
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      const cfg = await loadHttpRuntimeConfig();
      expect(cfg.port).toBe(3001);
    });

    it("honors MCP_HTTP_PORT env when set, overriding the app default", async () => {
      // GIVEN MCP_HTTP_PORT is set to 3002 (operator wants a non-default port)
      // WHEN we load the runtime config
      // THEN cfg.port is 3002 — explicit env wins over the app default
      stubAuthorityEndpoints();
      process.env.MCP_HTTP_PORT = "3002";
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      const cfg = await loadHttpRuntimeConfig();
      expect(cfg.port).toBe(3002);
    });

    it("defaults allowUnboundedBody to false when MCP_HTTP_ALLOW_UNBOUNDED_BODY is unset (safe default)", async () => {
      // GIVEN MCP_HTTP_ALLOW_UNBOUNDED_BODY is unset
      // WHEN we load the runtime config
      // THEN cfg.allowUnboundedBody is false (per the chunked-body spec:
      // the opt-in is required; the safe default is reject chunked requests
      // with 411 Length Required).
      stubAuthorityEndpoints();
      delete process.env.MCP_HTTP_ALLOW_UNBOUNDED_BODY;
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      const cfg = await loadHttpRuntimeConfig();
      expect(cfg.allowUnboundedBody).toBe(false);
    });

    it("sets allowUnboundedBody=true when MCP_HTTP_ALLOW_UNBOUNDED_BODY=true (chunked-body opt-in)", async () => {
      // GIVEN MCP_HTTP_ALLOW_UNBOUNDED_BODY=true
      // WHEN we load the runtime config
      // THEN cfg.allowUnboundedBody is true (the operator has explicitly
      // acknowledged that a reverse proxy enforces the body-size cap
      // upstream — see apps/mcp-readonly-sql/.env.example).
      stubAuthorityEndpoints();
      process.env.MCP_HTTP_ALLOW_UNBOUNDED_BODY = "true";
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      const cfg = await loadHttpRuntimeConfig();
      expect(cfg.allowUnboundedBody).toBe(true);
    });

    it("treats MCP_HTTP_ALLOW_UNBOUNDED_BODY values other than 'true' as false", async () => {
      // GIVEN MCP_HTTP_ALLOW_UNBOUNDED_BODY is set to a non-'true' value
      // WHEN we load the runtime config
      // THEN cfg.allowUnboundedBody is false (the boolean parser is strict
      // about the literal 'true' — the safety property is "default closed
      // unless the operator explicitly typed true").
      stubAuthorityEndpoints();
      process.env.MCP_HTTP_ALLOW_UNBOUNDED_BODY = "1";
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      const cfg = await loadHttpRuntimeConfig();
      expect(cfg.allowUnboundedBody).toBe(false);
    });

    it("flips sessionMode: stateless=true maps to 'stateless'", async () => {
      // GIVEN stateless=true (the v1 default per the PR1 remediation)
      // WHEN we load the config
      // THEN the sessionMode is "stateless" (passed verbatim to the shared base)
      stubAuthorityEndpoints();
      process.env.MCP_HTTP_STATELESS = "true";
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      const cfg = await loadHttpRuntimeConfig();
      expect(cfg.sessionMode).toBe("stateless");
    });

    it("flips sessionMode: stateless=false maps to 'stateful' (single-agent opt-in)", async () => {
      // GIVEN stateless=false (the documented single-agent opt-in)
      // WHEN we load the config
      // THEN the sessionMode is "stateful"
      stubAuthorityEndpoints();
      process.env.MCP_HTTP_STATELESS = "false";
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      const cfg = await loadHttpRuntimeConfig();
      expect(cfg.sessionMode).toBe("stateful");
    });

    it("defaults sessionMode to 'stateless' when MCP_HTTP_STATELESS is unset", async () => {
      // GIVEN no MCP_HTTP_STATELESS env var
      // WHEN we load the config
      // THEN sessionMode defaults to "stateless" (per the PR1 re-review fix
      // that flipped the default to per-request stateless transports)
      stubAuthorityEndpoints();
      delete process.env.MCP_HTTP_STATELESS;
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      const cfg = await loadHttpRuntimeConfig();
      expect(cfg.sessionMode).toBe("stateless");
    });

    it("rejects a non-loopback host without an opt-in (delegated to parseHttpConfig)", async () => {
      // GIVEN a non-loopback host and no opt-in env var
      // WHEN we load the runtime config
      // THEN the error names the opt-in flags
      stubAuthorityEndpoints();
      process.env.MCP_HTTP_HOST = "0.0.0.0";
      delete process.env.MCP_HTTP_BEHIND_PROXY;
      delete process.env.MCP_HTTP_ALLOW_INSECURE_BIND;
      delete process.env.MCP_HTTP_ALLOW_INSECURE_LOOPBACK;
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      await expect(loadHttpRuntimeConfig()).rejects.toThrow(
        /MCP_HTTP_BEHIND_PROXY|MCP_HTTP_ALLOW_INSECURE_BIND/,
      );
    });

    it("rejects when MCP_AUTHORITY_URL is missing (the local backend was removed)", async () => {
      // Spec scenario: the local HMAC roster was removed. The
      // resource server MUST be wired to an external authority;
      // a missing MCP_AUTHORITY_URL fails closed with a clear
      // stderr-friendly error.
      delete process.env.MCP_AUTHORITY_URL;
      delete process.env.MCP_AUTHORITY_JWKS_URL;
      delete process.env.MCP_AUTHORITY_AUDIENCE;
      await expect(loadHttpRuntimeConfig()).rejects.toThrow(/MCP_AUTHORITY_URL/);
    });

    it("rejects when MCP_AUTHORITY_AUDIENCE is missing with the URL set (delegated to parseHttpConfig)", async () => {
      // The shared base enforces the audience-required check; the
      // app-side loader surfaces the error so the entrypoint can
      // exit non-zero.
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      delete process.env.MCP_AUTHORITY_AUDIENCE;
      await expect(loadHttpRuntimeConfig()).rejects.toThrow(/MCP_AUTHORITY_AUDIENCE/);
    });
  });

  describe("backend selection (Phase 1b — 1b.6)", () => {
    // Phase 1b of external-token-authority-verification wires the
    // authority-backend selection into the app's HTTP config loader.
    // The selection rule (per the mcp-agent-authorization spec):
    //   - MCP_AUTHORITY_URL unset → fail closed (the local backend was removed)
    //   - MCP_AUTHORITY_URL set   → OAuthAdminAuthority (production backend)
    // The `HttpRuntimeConfig.authority` field carries the resolved
    // TokenAuthority. The `HttpRuntimeConfig.authorityBackend` field
    // is the audit-safe label (`"oauth"`) that /healthz surfaces.
    // The startup probe (`warm()`) runs on the OAuth path; a probe
    // failure throws so the entrypoint can exit non-zero.

    it("selects the OAuth admin backend when MCP_AUTHORITY_URL is set and reachable (authorityBackend='oauth')", async () => {
      // GIVEN MCP_AUTHORITY_URL set, MCP_AUTHORITY_AUDIENCE set, and a
      //      reachable JWKS + introspect endpoint (the stub returns a
      //      200 + a minimal JWKS document for the JWKS probe AND a
      //      200 + { active: false } for the introspect probe; the
      //      OAuthAdminAuthority.warm() needs both to succeed).
      // WHEN we load the runtime config
      // THEN cfg.authority is an OAuthAdminAuthority (NOT a
      //      LocalRosterAuthority) and cfg.authorityBackend is "oauth"
      const fetchStub = stubAuthorityEndpoints();
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      const cfg = await loadHttpRuntimeConfig();
      expect(cfg.authorityBackend).toBe("oauth");
      // The class check is the assertion: the resolved authority is
      // an OAuthAdminAuthority (which extends JwksAuthority).
      const cls = cfg.authority.constructor.name;
      expect(cls).toBe("OAuthAdminAuthority");
      // The JWKS + introspect endpoints were probed at least once
      // (the OAuthAdminAuthority.warm() probe fires both).
      expect(fetchStub).toHaveBeenCalled();
      const calledUrls = fetchStub.mock.calls.map((c) => String(c[0]));
      expect(calledUrls.some((u) => u.includes("/.well-known/jwks.json"))).toBe(true);
      expect(calledUrls.some((u) => u.includes("/oauth/introspect"))).toBe(true);
    });

    it("the JWKS startup probe failure throws HttpRuntimeConfigError so the entrypoint exits non-zero", async () => {
      // GIVEN MCP_AUTHORITY_URL set but the JWKS endpoint is unreachable
      //      (fetch rejects — simulating a network error or a 5xx)
      // WHEN we load the runtime config
      // THEN the loader throws an HttpRuntimeConfigError whose message
      //      names the authority host and base path (NOT the JWKS URL
      //      path — the auth spec says: "stderr names the authority
      //      host and base path only").
      const fetchStub = vi.fn(async () => {
        throw new TypeError("fetch failed");
      });
      vi.stubGlobal("fetch", fetchStub);
      process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
      process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
      let caught: unknown;
      try {
        await loadHttpRuntimeConfig();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HttpRuntimeConfigError);
      const msg = (caught as Error).message;
      // The message MUST mention the authority host (auth.example.com)
      // — operators read stderr to know which authority is broken.
      expect(msg).toContain("auth.example.com");
      // The message MUST NOT echo the token path or any query string —
      // the spec says: "stderr names the authority host and base path
      // only". A URL-shaped suffix like "/.well-known/jwks.json" is
      // the JWKS path; it MUST NOT be in the operator-visible error.
      // (We don't pin a specific "MUST NOT contain" — the spec leaves
      // the exact wording to the implementation. The positive check
      // on the host is the binding contract.)
    });
  });
});
