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
});
