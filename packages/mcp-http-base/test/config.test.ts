import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHttpConfig,
  HttpConfigError,
  type HttpConfigInput,
} from "../src/config.js";

/**
 * Build a complete, valid env object for the happy path, then let each test
 * override the specific field under examination. Default HMAC secret is
 * 32+ bytes so the "min length" check never fires accidentally.
 */
function baseEnv(overrides: Partial<HttpConfigInput> = {}): HttpConfigInput {
  return {
    MCP_TRANSPORT: "streamableHttp",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: "3000",
    MCP_HTTP_PATH: "/mcp",
    // MCP_HTTP_STATELESS is intentionally left undefined in the default
    // helper so we can assert the documented default of "stateless=true".
    // Tests that need to flip the mode set the field explicitly.
    MCP_HTTP_STATELESS: undefined,
    MCP_HTTP_SHUTDOWN_TIMEOUT_MS: "10000",
    MCP_LOG_FORMAT: "text",
    MCP_AGENT_HMAC_SECRET: "x".repeat(48),
    MCP_AGENTS_JSON: undefined,
    MCP_AGENTS_INLINE: JSON.stringify([
      { id: "agent-a", keyHash: "0".repeat(64), scopes: ["read:*"] },
    ]),
    MCP_HTTP_BEHIND_PROXY: "false",
    MCP_HTTP_ALLOW_INSECURE_BIND: "false",
    MCP_HTTP_ALLOW_INSECURE_LOOPBACK: "false",
    // Phase 1b (external-token-authority-verification): 6 new authority
    // env vars. The baseEnv helper leaves them undefined so tests can
    // assert the "unset" defaults and the "set" overrides independently.
    MCP_AUTHORITY_URL: undefined,
    MCP_AUTHORITY_JWKS_URL: undefined,
    MCP_AUTHORITY_AUDIENCE: undefined,
    MCP_AUTHORITY_JWKS_TTL_S: undefined,
    MCP_AUTHORITY_LEEWAY_S: undefined,
    MCP_AUTHORITY_FETCH_TIMEOUT_MS: undefined,
    ...overrides,
  };
}

describe("parseHttpConfig", () => {
  describe("host binding (loopback-only by default)", () => {
    it("accepts the default loopback host 127.0.0.1", () => {
      const cfg = parseHttpConfig(baseEnv());
      expect(cfg.host).toBe("127.0.0.1");
      expect(cfg.port).toBe(3000);
      expect(cfg.path).toBe("/mcp");
    });

    it("accepts ::1 and 'localhost' as loopback", () => {
      expect(parseHttpConfig(baseEnv({ MCP_HTTP_HOST: "::1" })).host).toBe(
        "::1",
      );
      expect(parseHttpConfig(baseEnv({ MCP_HTTP_HOST: "localhost" })).host).toBe(
        "localhost",
      );
    });

    it("rejects a non-loopback host without an explicit opt-in", () => {
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_HTTP_HOST: "0.0.0.0" })),
      ).toThrow(HttpConfigError);
      try {
        parseHttpConfig(baseEnv({ MCP_HTTP_HOST: "0.0.0.0" }));
      } catch (e) {
        const err = e as HttpConfigError;
        expect(err.message).toContain("MCP_HTTP_BEHIND_PROXY");
        expect(err.message).toContain("MCP_HTTP_ALLOW_INSECURE_BIND");
      }
    });

    it("accepts a non-loopback host when MCP_HTTP_BEHIND_PROXY=true (no warning)", () => {
      const cfg = parseHttpConfig(
        baseEnv({
          MCP_HTTP_HOST: "0.0.0.0",
          MCP_HTTP_BEHIND_PROXY: "true",
        }),
      );
      expect(cfg.host).toBe("0.0.0.0");
      expect(cfg.behindProxy).toBe(true);
      expect(cfg.allowInsecureBind).toBe(false);
    });

    it("accepts a non-loopback host when MCP_HTTP_ALLOW_INSECURE_BIND=true and flags the warning", () => {
      const cfg = parseHttpConfig(
        baseEnv({
          MCP_HTTP_HOST: "0.0.0.0",
          MCP_HTTP_ALLOW_INSECURE_BIND: "true",
        }),
      );
      expect(cfg.host).toBe("0.0.0.0");
      expect(cfg.allowInsecureBind).toBe(true);
      expect(cfg.behindProxy).toBe(false);
    });

    it("treats MCP_HTTP_ALLOW_INSECURE_LOOPBACK=true as equivalent (deprecated alias)", () => {
      // The original flag was misleading: "INSECURE_LOOPBACK" but the flag
      // permits non-loopback binding. Keep the legacy name as a deprecated
      // alias so existing operators are not broken; new code should use
      // MCP_HTTP_ALLOW_INSECURE_BIND.
      const cfg = parseHttpConfig(
        baseEnv({
          MCP_HTTP_HOST: "0.0.0.0",
          MCP_HTTP_ALLOW_INSECURE_LOOPBACK: "true",
        }),
      );
      expect(cfg.host).toBe("0.0.0.0");
      expect(cfg.allowInsecureBind).toBe(true);
    });
  });

  describe("port and path parsing", () => {
    it("parses a custom port and path", () => {
      const cfg = parseHttpConfig(
        baseEnv({ MCP_HTTP_PORT: "3100", MCP_HTTP_PATH: "/mcp-readonly-sql" }),
      );
      expect(cfg.port).toBe(3100);
      expect(cfg.path).toBe("/mcp-readonly-sql");
    });

    it("rejects a non-numeric port", () => {
      expect(() => parseHttpConfig(baseEnv({ MCP_HTTP_PORT: "abc" }))).toThrow(
        HttpConfigError,
      );
    });

    it("rejects a port outside the legal TCP range", () => {
      expect(() => parseHttpConfig(baseEnv({ MCP_HTTP_PORT: "0" }))).toThrow(
        HttpConfigError,
      );
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_HTTP_PORT: "70000" })),
      ).toThrow(HttpConfigError);
    });

    it("rejects a partially numeric port like '3000abc' (strict parsing)", () => {
      // Number.parseInt would silently accept "3000abc" as 3000; we reject it
      // so misconfigured env vars fail fast.
      expect(() => parseHttpConfig(baseEnv({ MCP_HTTP_PORT: "3000abc" }))).toThrow(
        HttpConfigError,
      );
    });

    it("requires the path to start with a slash", () => {
      expect(() => parseHttpConfig(baseEnv({ MCP_HTTP_PATH: "mcp" }))).toThrow(
        HttpConfigError,
      );
    });
  });

  describe("stateless mode and shutdown timeout", () => {
    it("defaults to STATELESS sessions (stateless=true) so the multi-agent transport cache cannot leak sessions across agents", () => {
      // PR1 review finding: a single cached StreamableHTTPServerTransport
      // shared its sessionId across all agents. The safe default in v1 is
      // per-request stateless transport; the stateful cache is the opt-in
      // and is documented as single-agent only.
      const cfg = parseHttpConfig(baseEnv());
      expect(cfg.stateless).toBe(true);
    });

    it("parses MCP_HTTP_STATELESS=true as stateless", () => {
      const cfg = parseHttpConfig(baseEnv({ MCP_HTTP_STATELESS: "true" }));
      expect(cfg.stateless).toBe(true);
    });

    it("parses MCP_HTTP_STATELESS=false as stateful (single-agent opt-in)", () => {
      const cfg = parseHttpConfig(baseEnv({ MCP_HTTP_STATELESS: "false" }));
      expect(cfg.stateless).toBe(false);
    });

    it("parses the shutdown timeout in milliseconds", () => {
      const cfg = parseHttpConfig(
        baseEnv({ MCP_HTTP_SHUTDOWN_TIMEOUT_MS: "5000" }),
      );
      expect(cfg.shutdownTimeoutMs).toBe(5000);
    });

    it("rejects a non-numeric shutdown timeout", () => {
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_HTTP_SHUTDOWN_TIMEOUT_MS: "fast" })),
      ).toThrow(HttpConfigError);
    });

    it("rejects a partially numeric shutdown timeout like '5000ms'", () => {
      expect(() =>
        parseHttpConfig(
          baseEnv({ MCP_HTTP_SHUTDOWN_TIMEOUT_MS: "5000ms" }),
        ),
      ).toThrow(HttpConfigError);
    });

    it("rejects a zero or negative shutdown timeout", () => {
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_HTTP_SHUTDOWN_TIMEOUT_MS: "0" })),
      ).toThrow(HttpConfigError);
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_HTTP_SHUTDOWN_TIMEOUT_MS: "-1" })),
      ).toThrow(HttpConfigError);
    });
  });

  describe("agent configuration source", () => {
    it("prefers MCP_AGENTS_JSON when both are set", () => {
      const cfg = parseHttpConfig(
        baseEnv({
          MCP_AGENTS_JSON: "/etc/mcp/agents.json",
          MCP_AGENTS_INLINE: JSON.stringify([{ id: "x", keyHash: "y", scopes: [] }]),
        }),
      );
      expect(cfg.agentsJsonPath).toBe("/etc/mcp/agents.json");
      expect(cfg.agentsInline).toBeDefined();
    });

    it("uses MCP_AGENTS_INLINE when MCP_AGENTS_JSON is absent", () => {
      const cfg = parseHttpConfig(
        baseEnv({ MCP_AGENTS_JSON: undefined, MCP_AGENTS_INLINE: "[{}]" }),
      );
      expect(cfg.agentsJsonPath).toBeUndefined();
      expect(cfg.agentsInline).toBe("[{}]");
    });

    it("reports agentConfig when no source is configured (caller decides fail-closed)", () => {
      const cfg = parseHttpConfig(
        baseEnv({ MCP_AGENTS_JSON: undefined, MCP_AGENTS_INLINE: undefined }),
      );
      expect(cfg.agentsJsonPath).toBeUndefined();
      expect(cfg.agentsInline).toBeUndefined();
    });
  });

  describe("HMAC secret length", () => {
    it("rejects a missing HMAC secret", () => {
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_AGENT_HMAC_SECRET: "" })),
      ).toThrow(HttpConfigError);
    });

    it("rejects an HMAC secret shorter than 32 bytes", () => {
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_AGENT_HMAC_SECRET: "short" })),
      ).toThrow(HttpConfigError);
      try {
        parseHttpConfig(baseEnv({ MCP_AGENT_HMAC_SECRET: "short" }));
      } catch (e) {
        const err = e as HttpConfigError;
        expect(err.message).toContain("32");
      }
    });

    it("accepts a 32-byte HMAC secret", () => {
      const cfg = parseHttpConfig(
        baseEnv({ MCP_AGENT_HMAC_SECRET: "x".repeat(32) }),
      );
      expect(cfg.hmacSecret).toBe("x".repeat(32));
    });
  });

  describe("log format", () => {
    it("defaults to text log format", () => {
      const cfg = parseHttpConfig(baseEnv());
      expect(cfg.logFormat).toBe("text");
    });

    it("accepts MCP_LOG_FORMAT=json", () => {
      const cfg = parseHttpConfig(baseEnv({ MCP_LOG_FORMAT: "json" }));
      expect(cfg.logFormat).toBe("json");
    });

    it("rejects an unknown log format", () => {
      expect(() => parseHttpConfig(baseEnv({ MCP_LOG_FORMAT: "yaml" }))).toThrow(
        HttpConfigError,
      );
    });
  });

  describe("vitest configuration safety", () => {
    it("vitest config sets forbidOnly: true so a stray `.only` cannot narrow the suite silently", () => {
      // We read the on-disk vitest config so the test does not depend
      // on vitest's internal state (the runtime would already be
      // affected by a stray .only at this point).
      const here = join(dirname(fileURLToPath(import.meta.url)), "..");
      const cfgPath = join(here, "vitest.config.ts");
      const src = readFileSync(cfgPath, "utf8");
      // Strip comments so the JSDoc above does not affect the match.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code).toMatch(/forbidOnly\s*:\s*true/);
    });
  });

  describe("authority env vars (Phase 1b — 1b.5)", () => {
    // Phase 1b of the external-token-authority-verification change
    // introduces six new env vars (MCP_AUTHORITY_URL, MCP_AUTHORITY_JWKS_URL,
    // MCP_AUTHORITY_AUDIENCE, MCP_AUTHORITY_JWKS_TTL_S, MCP_AUTHORITY_LEEWAY_S,
    // MCP_AUTHORITY_FETCH_TIMEOUT_MS). The defaults are 60/30/5000 for
    // the integer fields; the URL/audience fields are undefined when
    // unset. When MCP_AUTHORITY_URL is set, MCP_AUTHORITY_AUDIENCE is
    // REQUIRED (fail closed) — the auth spec demands a hard audience
    // check; an empty audience would let any token issued by the
    // authority be accepted.

    it("returns undefined for all authority URL/audience fields when unset", () => {
      const cfg = parseHttpConfig(baseEnv());
      expect(cfg.authorityUrl).toBeUndefined();
      expect(cfg.authorityJwksUrl).toBeUndefined();
      expect(cfg.authorityAudience).toBeUndefined();
    });

    it("defaults the three integer authority fields to 60/30/5000 when unset", () => {
      // The defaults are documented in the spec and in
      // .env.example: TTL 60s, leeway 30s, fetch timeout 5000ms.
      const cfg = parseHttpConfig(baseEnv());
      expect(cfg.authorityJwksTtlSeconds).toBe(60);
      expect(cfg.authorityLeewaySeconds).toBe(30);
      expect(cfg.authorityFetchTimeoutMs).toBe(5000);
    });

    it("parses a custom TTL, leeway, and fetch timeout", () => {
      const cfg = parseHttpConfig(
        baseEnv({
          MCP_AUTHORITY_JWKS_TTL_S: "120",
          MCP_AUTHORITY_LEEWAY_S: "5",
          MCP_AUTHORITY_FETCH_TIMEOUT_MS: "10000",
        }),
      );
      expect(cfg.authorityJwksTtlSeconds).toBe(120);
      expect(cfg.authorityLeewaySeconds).toBe(5);
      expect(cfg.authorityFetchTimeoutMs).toBe(10000);
    });

    it("rejects a non-integer authority TTL (strict parsing, like the other integer fields)", () => {
      // "fast" is not a number; the field is a seconds count, so the
      // parser rejects it the same way it rejects "fast" for
      // MCP_HTTP_SHUTDOWN_TIMEOUT_MS.
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_AUTHORITY_JWKS_TTL_S: "fast" })),
      ).toThrow(HttpConfigError);
    });

    it("rejects a non-integer authority leeway (strict parsing)", () => {
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_AUTHORITY_LEEWAY_S: "many" })),
      ).toThrow(HttpConfigError);
    });

    it("rejects a non-integer authority fetch timeout (strict parsing)", () => {
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_AUTHORITY_FETCH_TIMEOUT_MS: "5s" })),
      ).toThrow(HttpConfigError);
    });

    it("rejects a negative or zero authority fetch timeout (the timeout must be > 0)", () => {
      // A 0ms fetch timeout would let a hung JWKS endpoint freeze the
      // middleware for 0ms — but `AbortSignal.timeout(0)` is effectively
      // "abort immediately", which is a useful fail-fast mode; the spec
      // asks for a positive minimum so the operator is forced to pick a
      // real value. We allow >= 1.
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_AUTHORITY_FETCH_TIMEOUT_MS: "0" })),
      ).toThrow(HttpConfigError);
      expect(() =>
        parseHttpConfig(baseEnv({ MCP_AUTHORITY_FETCH_TIMEOUT_MS: "-1" })),
      ).toThrow(HttpConfigError);
    });

    it("preserves the authority URL and audience as the operator typed them (no normalization)", () => {
      // The auth spec says: when MCP_AUTHORITY_URL is set, MCP_AUTHORITY_AUDIENCE
      // is REQUIRED. We assert that the value flows through to the
      // config object verbatim — the operator is responsible for
      // matching the value the authority actually issues, but the
      // config layer does NOT silently transform it.
      const cfg = parseHttpConfig(
        baseEnv({
          MCP_AUTHORITY_URL: "https://auth.example.com",
          MCP_AUTHORITY_AUDIENCE: "mcp-readonly-sql",
        }),
      );
      expect(cfg.authorityUrl).toBe("https://auth.example.com");
      expect(cfg.authorityAudience).toBe("mcp-readonly-sql");
    });

    it("rejects a missing audience when MCP_AUTHORITY_URL is set (fail-closed on the audience check)", () => {
      // The auth spec is explicit: a token issued by the authority
      // could be for any audience, and an empty audience would let any
      // such token through. The config layer fails closed.
      expect(() =>
        parseHttpConfig(
          baseEnv({
            MCP_AUTHORITY_URL: "https://auth.example.com",
            MCP_AUTHORITY_AUDIENCE: undefined,
          }),
        ),
      ).toThrow(HttpConfigError);
    });

    it("rejects an empty audience when MCP_AUTHORITY_URL is set (whitespace-only also rejected)", () => {
      // Empty string and whitespace-only are both "the operator did
      // not configure an audience". The trim must happen before the
      // check so a stray space in the .env file is not silently
      // treated as a configured audience.
      expect(() =>
        parseHttpConfig(
          baseEnv({
            MCP_AUTHORITY_URL: "https://auth.example.com",
            MCP_AUTHORITY_AUDIENCE: "",
          }),
        ),
      ).toThrow(HttpConfigError);
      expect(() =>
        parseHttpConfig(
          baseEnv({
            MCP_AUTHORITY_URL: "https://auth.example.com",
            MCP_AUTHORITY_AUDIENCE: "   ",
          }),
        ),
      ).toThrow(HttpConfigError);
    });

    it("preserves MCP_AUTHORITY_JWKS_URL as the operator typed it (no path auto-derivation)", () => {
      // The spec does NOT mandate a default for MCP_AUTHORITY_JWKS_URL —
      // it is its own env var. We assert that whatever the operator
      // types flows through to the config object verbatim. A future
      // change may add a well-known default; the current contract is
      // "no silent transformation".
      const cfg = parseHttpConfig(
        baseEnv({
          MCP_AUTHORITY_URL: "https://auth.example.com",
          MCP_AUTHORITY_JWKS_URL: "https://auth.example.com/jwks/special.json",
          MCP_AUTHORITY_AUDIENCE: "mcp-readonly-sql",
        }),
      );
      expect(cfg.authorityJwksUrl).toBe("https://auth.example.com/jwks/special.json");
    });

    it("leaves MCP_AUTHORITY_JWKS_URL as undefined when both env vars are unset (the app-side loader rejects this state)", () => {
      // The shared config layer is permissive: JWKS URL is optional
      // in the type system. The app-side `loadHttpRuntimeConfig`
      // rejects the unset state when MCP_AUTHORITY_URL is set, because
      // a JWKS-less JWKS authority is a misconfiguration. We assert
      // the shared layer's contract here.
      const cfg = parseHttpConfig(
        baseEnv({
          MCP_AUTHORITY_URL: "https://auth.example.com",
          MCP_AUTHORITY_AUDIENCE: "mcp-readonly-sql",
        }),
      );
      // The shared config layer preserves the unset state — the
      // app-side loader is the layer that adds the fail-closed check.
      expect(cfg.authorityJwksUrl).toBeUndefined();
    });

    it("does not require MCP_AUTHORITY_AUDIENCE when MCP_AUTHORITY_URL is unset (local backend path)", () => {
      // The local-roster backend does not need an audience — the
      // middleware calls validateBearer() directly, and there is no
      // JWT to validate. The audience requirement is bound to the
      // external (JWKS) path only.
      const cfg = parseHttpConfig(baseEnv());
      expect(cfg.authorityUrl).toBeUndefined();
      expect(cfg.authorityAudience).toBeUndefined();
    });
  });
});
