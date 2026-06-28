import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { loadHttpRuntimeConfig, type HttpRuntimeConfig } from "../../src/config/http.js";

const VALID_HMAC_SECRET = "x".repeat(32);
const VALID_AGENT = {
  id: "agent-a",
  // HMAC of the token "tok-a" under VALID_HMAC_SECRET
  keyHash: createHmac("sha256", VALID_HMAC_SECRET).update("tok-a").digest("hex"),
  scopes: ["read:*"],
};

let tempDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mcp-readonly-sql-httpconfig-"));
  savedEnv = { ...process.env };
  // Provide a valid baseline so tests only have to override the fields
  // they care about.
  process.env.MCP_AGENT_HMAC_SECRET = VALID_HMAC_SECRET;
  process.env.MCP_AGENTS_JSON = join(tempDir, "agents.json");
  process.env.MCP_AGENTS_INLINE = undefined;
  // Do NOT set MCP_TRANSPORT here — the config loader is for HTTP mode;
  // the dispatcher in src/index.ts is what reads MCP_TRANSPORT.
  delete process.env.MCP_TRANSPORT;
});

afterEach(() => {
  process.env = savedEnv;
  rmSync(tempDir, { recursive: true, force: true });
});

function writeAgentsFile(contents: string): string {
  const filePath = join(tempDir, "agents.json");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

describe("config/http", () => {
  describe("loadHttpRuntimeConfig", () => {
    it("returns a HttpRuntimeConfig with all fields populated from env", () => {
      // GIVEN a valid env (HMAC secret + agents file with one record)
      // WHEN we load the runtime config
      // THEN every field is populated, including sessionMode derived from stateless
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      process.env.MCP_HTTP_HOST = "127.0.0.1";
      process.env.MCP_HTTP_PORT = "3001";
      process.env.MCP_HTTP_PATH = "/mcp";
      process.env.MCP_HTTP_STATELESS = "true";
      process.env.MCP_HTTP_SHUTDOWN_TIMEOUT_MS = "5000";
      process.env.MCP_LOG_FORMAT = "json";

      const cfg: HttpRuntimeConfig = loadHttpRuntimeConfig();
      expect(cfg.host).toBe("127.0.0.1");
      expect(cfg.port).toBe(3001);
      expect(cfg.path).toBe("/mcp");
      expect(cfg.stateless).toBe(true);
      expect(cfg.shutdownTimeoutMs).toBe(5000);
      expect(cfg.logFormat).toBe("json");
      expect(cfg.hmacSecret).toBe(VALID_HMAC_SECRET);
      expect(cfg.agents).toHaveLength(1);
      expect(cfg.agents[0]?.id).toBe("agent-a");
      expect(cfg.agents[0]?.keyHash).toBe(VALID_AGENT.keyHash);
      expect(cfg.agents[0]?.scopes).toEqual(["read:*"]);
    });

    it("defaults port to 3001 when MCP_HTTP_PORT is unset (spec 'Port Allocation Convention')", () => {
      // GIVEN MCP_HTTP_PORT is unset (operator did not uncomment the .env.example line)
      // WHEN we load the runtime config
      // THEN cfg.port is 3001 — the app-scoped default per the spec
      // (the shared base's default is 3000; the app overrides it to 3001
      // because mcp-readonly-sql binds 3001 by convention so multiple
      // apps can coexist on the same host).
      delete process.env.MCP_HTTP_PORT;
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      const cfg = loadHttpRuntimeConfig();
      expect(cfg.port).toBe(3001);
    });

    it("honors MCP_HTTP_PORT env when set, overriding the app default", () => {
      // GIVEN MCP_HTTP_PORT is set to 3002 (operator wants a non-default port)
      // WHEN we load the runtime config
      // THEN cfg.port is 3002 — explicit env wins over the app default
      process.env.MCP_HTTP_PORT = "3002";
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      const cfg = loadHttpRuntimeConfig();
      expect(cfg.port).toBe(3002);
    });

    it("defaults allowUnboundedBody to false when MCP_HTTP_ALLOW_UNBOUNDED_BODY is unset (safe default)", () => {
      // GIVEN MCP_HTTP_ALLOW_UNBOUNDED_BODY is unset
      // WHEN we load the runtime config
      // THEN cfg.allowUnboundedBody is false (per the chunked-body spec:
      // the opt-in is required; the safe default is reject chunked requests
      // with 411 Length Required).
      delete process.env.MCP_HTTP_ALLOW_UNBOUNDED_BODY;
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      const cfg = loadHttpRuntimeConfig();
      expect(cfg.allowUnboundedBody).toBe(false);
    });

    it("sets allowUnboundedBody=true when MCP_HTTP_ALLOW_UNBOUNDED_BODY=true (chunked-body opt-in)", () => {
      // GIVEN MCP_HTTP_ALLOW_UNBOUNDED_BODY=true
      // WHEN we load the runtime config
      // THEN cfg.allowUnboundedBody is true (the operator has explicitly
      // acknowledged that a reverse proxy enforces the body-size cap
      // upstream — see apps/mcp-readonly-sql/.env.example).
      process.env.MCP_HTTP_ALLOW_UNBOUNDED_BODY = "true";
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      const cfg = loadHttpRuntimeConfig();
      expect(cfg.allowUnboundedBody).toBe(true);
    });

    it("treats MCP_HTTP_ALLOW_UNBOUNDED_BODY values other than 'true' as false", () => {
      // GIVEN MCP_HTTP_ALLOW_UNBOUNDED_BODY is set to a non-'true' value
      // WHEN we load the runtime config
      // THEN cfg.allowUnboundedBody is false (the boolean parser is strict
      // about the literal 'true' — the safety property is "default closed
      // unless the operator explicitly typed true").
      process.env.MCP_HTTP_ALLOW_UNBOUNDED_BODY = "1";
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      const cfg = loadHttpRuntimeConfig();
      expect(cfg.allowUnboundedBody).toBe(false);
    });

    it("flips sessionMode: stateless=true maps to 'stateless'", () => {
      // GIVEN stateless=true (the v1 default per the PR1 remediation)
      // WHEN we load the config
      // THEN the sessionMode is "stateless" (passed verbatim to the shared base)
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      process.env.MCP_HTTP_STATELESS = "true";
      const cfg = loadHttpRuntimeConfig();
      expect(cfg.sessionMode).toBe("stateless");
    });

    it("flips sessionMode: stateless=false maps to 'stateful' (single-agent opt-in)", () => {
      // GIVEN stateless=false (the documented single-agent opt-in)
      // WHEN we load the config
      // THEN the sessionMode is "stateful"
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      process.env.MCP_HTTP_STATELESS = "false";
      const cfg = loadHttpRuntimeConfig();
      expect(cfg.sessionMode).toBe("stateful");
    });

    it("defaults sessionMode to 'stateless' when MCP_HTTP_STATELESS is unset", () => {
      // GIVEN no MCP_HTTP_STATELESS env var
      // WHEN we load the config
      // THEN sessionMode defaults to "stateless" (per the PR1 re-review fix
      // that flipped the default to per-request stateless transports)
      delete process.env.MCP_HTTP_STATELESS;
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      const cfg = loadHttpRuntimeConfig();
      expect(cfg.sessionMode).toBe("stateless");
    });

    it("prefers MCP_AGENTS_JSON over MCP_AGENTS_INLINE when both are set", () => {
      // GIVEN both env vars set, JSON pointing to agent-a and INLINE pointing to agent-b
      // WHEN we load the config
      // THEN the JSON file wins (per the mcp-agent-authorization spec)
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      const inlineAgent = {
        id: "agent-b",
        keyHash: createHmac("sha256", VALID_HMAC_SECRET).update("tok-b").digest("hex"),
        scopes: ["read:bi_catastro"],
      };
      process.env.MCP_AGENTS_JSON = path;
      process.env.MCP_AGENTS_INLINE = JSON.stringify([inlineAgent]);

      const cfg = loadHttpRuntimeConfig();
      expect(cfg.agents).toHaveLength(1);
      expect(cfg.agents[0]?.id).toBe("agent-a");
    });

    it("loads agents from MCP_AGENTS_INLINE when MCP_AGENTS_JSON is unset", () => {
      // GIVEN only MCP_AGENTS_INLINE
      // WHEN we load the config
      // THEN the inline JSON is parsed
      delete process.env.MCP_AGENTS_JSON;
      const inlineAgent = {
        id: "agent-inline",
        keyHash: createHmac("sha256", VALID_HMAC_SECRET).update("tok-inline").digest("hex"),
        scopes: ["list:*"],
      };
      process.env.MCP_AGENTS_INLINE = JSON.stringify([inlineAgent]);
      const cfg = loadHttpRuntimeConfig();
      expect(cfg.agents).toHaveLength(1);
      expect(cfg.agents[0]?.id).toBe("agent-inline");
    });

    it("throws a clear error when neither MCP_AGENTS_JSON nor MCP_AGENTS_INLINE is set", () => {
      // GIVEN no agent source
      // WHEN we load the config
      // THEN the error names the env vars the operator must set
      delete process.env.MCP_AGENTS_JSON;
      delete process.env.MCP_AGENTS_INLINE;
      expect(() => loadHttpRuntimeConfig()).toThrow(/MCP_AGENTS_JSON|MCP_AGENTS_INLINE/);
    });

    it("throws when MCP_AGENTS_JSON points at a missing file", () => {
      // GIVEN an MCP_AGENTS_JSON path that does not exist
      // WHEN we load the config
      // THEN the error mentions the missing file
      process.env.MCP_AGENTS_JSON = join(tempDir, "does-not-exist.json");
      expect(() => loadHttpRuntimeConfig()).toThrow(/MCP_AGENTS_JSON|ENOENT|does-not-exist/);
    });

    it("throws when MCP_AGENTS_JSON contents are not valid JSON", () => {
      // GIVEN a malformed JSON file
      // WHEN we load the config
      // THEN the error names the parse failure
      const path = writeAgentsFile("{not valid json");
      process.env.MCP_AGENTS_JSON = path;
      expect(() => loadHttpRuntimeConfig()).toThrow(/parse|JSON/i);
    });

    it("throws when MCP_AGENTS_JSON has no records (empty array fails closed)", () => {
      // GIVEN an agents file with []
      // WHEN we load the config
      // THEN the error tells the operator to configure at least one agent
      const path = writeAgentsFile("[]");
      process.env.MCP_AGENTS_JSON = path;
      expect(() => loadHttpRuntimeConfig()).toThrow(/at least one agent/);
    });

    it("throws when the HMAC secret is shorter than 32 bytes (delegated to parseHttpConfig)", () => {
      // GIVEN an HMAC secret below the 32-byte minimum
      // WHEN we load the config
      // THEN the error names MCP_AGENT_HMAC_SECRET
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      process.env.MCP_AGENT_HMAC_SECRET = "too-short";
      expect(() => loadHttpRuntimeConfig()).toThrow(/MCP_AGENT_HMAC_SECRET/);
    });

    it("rejects a malformed agent record (keyHash not 64 hex) — fail-closed", () => {
      // GIVEN a record whose keyHash is not 64 hex characters
      // WHEN we load the config
      // THEN the error names the offending index
      const bad = {
        id: "agent-bad",
        keyHash: "not-a-valid-hash",
        scopes: ["read:*"],
      };
      const path = writeAgentsFile(JSON.stringify([bad]));
      process.env.MCP_AGENTS_JSON = path;
      expect(() => loadHttpRuntimeConfig()).toThrow(/keyHash/i);
    });

    it("rejects a malformed scope (verb 'delete' is not allowed) — fail-closed", () => {
      // GIVEN a record whose scope is not in the (read|list|call):<resource> grammar
      // WHEN we load the config
      // THEN the error names the offending scope
      const bad = {
        id: "agent-bad-scope",
        keyHash: VALID_AGENT.keyHash,
        scopes: ["delete:foo"],
      };
      const path = writeAgentsFile(JSON.stringify([bad]));
      process.env.MCP_AGENTS_JSON = path;
      expect(() => loadHttpRuntimeConfig()).toThrow(/scope/i);
    });

    it("rejects a non-loopback host without an opt-in (delegated to parseHttpConfig)", () => {
      // GIVEN a non-loopback host and no opt-in env var
      // WHEN we load the config
      // THEN the error names the opt-in flags
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      process.env.MCP_HTTP_HOST = "0.0.0.0";
      delete process.env.MCP_HTTP_BEHIND_PROXY;
      delete process.env.MCP_HTTP_ALLOW_INSECURE_BIND;
      delete process.env.MCP_HTTP_ALLOW_INSECURE_LOOPBACK;
      expect(() => loadHttpRuntimeConfig()).toThrow(
        /MCP_HTTP_BEHIND_PROXY|MCP_HTTP_ALLOW_INSECURE_BIND/,
      );
    });
  });
});
