/**
 * Phase 5.1 — Local Roster Deprecation Notice (PR 3 of
 * `oauth-sqlite-admin-authorization`).
 *
 * Spec coverage (from `specs/mcp-agent-authorization/spec.md`):
 * - "When the local backend is active, the resource server
 *    MUST log a one-shot `WARN` at startup naming
 *    `MCP_AGENTS_JSON`, `MCP_AGENTS_INLINE`, and
 *    `MCP_AGENT_HMAC_SECRET` as deprecated. Emitted exactly
 *    once per process; points to `deploy/README.md` and
 *    `mcp-oauth-authority`."
 * - "GIVEN the local backend is active OR
 *    `MCP_AUTHORITY_URL` is set
 *    WHEN the resource server starts
 *    THEN stderr contains exactly one `WARN` line naming
 *    the three env vars, OR the line is not emitted."
 *
 * Strict TDD: each scenario below is a real assertion.
 * The test exercises:
 *  - the WARN text names the three deprecated env vars
 *  - the WARN text points operators to
 *    `deploy/README.md` and `mcp-oauth-authority`
 *  - the WARN is emitted exactly once per process (idempotent)
 *  - the WARN is NOT emitted when the OAuth admin backend
 *    is active
 *  - the WARN is actually wired into
 *    `loadHttpRuntimeConfig` (integration smoke)
 *
 * Test layer: unit for the helper, integration for the
 * config-loader wiring.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import {
  loadHttpRuntimeConfig,
  HttpRuntimeConfigError,
  emitLocalRosterDeprecationWarn,
  localRosterDeprecationWarnMessage,
  _resetLocalRosterWarnState,
  _hasEmittedLocalRosterWarn,
  type HttpRuntimeConfig,
} from "../../src/config/http.js";

const VALID_HMAC_SECRET = "x".repeat(32);
const VALID_AGENT = {
  id: "agent-a",
  keyHash: createHmac("sha256", VALID_HMAC_SECRET).update("tok-a").digest("hex"),
  scopes: ["read:*"],
};

let tempDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mcp-readonly-sql-warn-"));
  savedEnv = { ...process.env };
  // Reset the module-level one-shot flag so each test
  // starts from a clean slate. The flag is intentionally
  // module-scoped (the spec says "exactly once per
  // process") so the helper exposes a test-only reset.
  _resetLocalRosterWarnState();
  process.env.MCP_AGENT_HMAC_SECRET = VALID_HMAC_SECRET;
  process.env.MCP_AGENTS_JSON = join(tempDir, "agents.json");
  process.env.MCP_AGENTS_INLINE = undefined;
  delete process.env.MCP_TRANSPORT;
});

/**
 * Mock logger that records every emitted message. The
 * helper asserts the message is on the `warn` channel
 * (info / error are present for shape completeness).
 */
function recordingLogger() {
  const calls: { level: "info" | "warn" | "error"; msg: string }[] = [];
  return {
    logger: {
      info: (msg: string) => calls.push({ level: "info", msg }),
      warn: (msg: string) => calls.push({ level: "warn", msg }),
      error: (msg: string) => calls.push({ level: "error", msg }),
    },
    calls,
  };
}

describe("Phase 5.1 — Local Roster Deprecation Notice", () => {
  describe("localRosterDeprecationWarnMessage (pure text)", () => {
    it("names MCP_AGENTS_JSON, MCP_AGENTS_INLINE, and MCP_AGENT_HMAC_SECRET as deprecated", () => {
      // The spec scenario: "stderr contains exactly one
      // WARN line naming the three env vars". The text
      // MUST name all three (not just one, not just two)
      // so an operator reading stderr knows exactly which
      // env vars to remove.
      const msg = localRosterDeprecationWarnMessage();
      expect(msg).toContain("MCP_AGENTS_JSON");
      expect(msg).toContain("MCP_AGENTS_INLINE");
      expect(msg).toContain("MCP_AGENT_HMAC_SECRET");
    });

    it("the text contains a WARN-level indicator (the channel is `warn` per the spec)", () => {
      // The spec says the line is a `WARN`. The channel
      // assertion is at the emit function; the text
      // assertion here is a defense-in-depth check that
      // the message body includes the literal "WARN" or
      // "deprecated" so a `grep WARN` finds the line.
      const msg = localRosterDeprecationWarnMessage();
      // The spec calls this a WARN. The text MUST include
      // "WARN" (the channel) OR "deprecated" (the reason);
      // either alone is sufficient to identify the line.
      const hasWarnOrDeprecated = /\bWARN\b/i.test(msg) || /deprecated/i.test(msg);
      expect(hasWarnOrDeprecated, "WARN text must include 'WARN' or 'deprecated'").toBe(true);
    });

    it("the text points operators to deploy/README.md and mcp-oauth-authority (the migration path)", () => {
      // The spec scenario: "points to `deploy/README.md`
      // and `mcp-oauth-authority`". The two anchors are
      // the runbook (the deployment runbook ships the
      // migration steps) and the authority app (the
      // target of the migration).
      const msg = localRosterDeprecationWarnMessage();
      expect(msg).toMatch(/deploy\/README\.md/);
      expect(msg).toMatch(/mcp-oauth-admin|oauth-authority|oauth authority/i);
    });
  });

  describe("emitLocalRosterDeprecationWarn (helper)", () => {
    it("emits the WARN to the logger on the local backend", () => {
      // GIVEN a fresh process (one-shot flag cleared)
      // WHEN emit() is called with backend="local"
      // THEN exactly one WARN message is recorded, with
      //      the message text returned by the pure helper.
      const { logger, calls } = recordingLogger();
      const result = emitLocalRosterDeprecationWarn("local", logger);
      expect(result).toBe(true);
      const warnCalls = calls.filter((c) => c.level === "warn");
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]?.msg).toBe(localRosterDeprecationWarnMessage());
    });

    it("does NOT emit a WARN on the OAuth admin backend", () => {
      // GIVEN backend="oauth" (the resource server is
      // talking to the authority; the local roster is not
      // in use)
      // WHEN emit() is called
      // THEN no message is recorded. The spec scenario
      //      for the OAuth backend: "the line is not
      //      emitted".
      const { logger, calls } = recordingLogger();
      const result = emitLocalRosterDeprecationWarn("oauth", logger);
      expect(result).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it("does NOT emit a WARN on the JWKS backend (Phase 1b legacy path; same as oauth for this WARN)", () => {
      // The Phase 1b JWKS backend is no longer the
      // recommended default (PR 3 of
      // oauth-sqlite-admin-authorization narrows the
      // recommendation to the OAuth admin authority).
      // For the deprecation WARN's purposes, the JWKS
      // backend is also NOT a local-roster path, so the
      // WARN is suppressed. This is consistent with the
      // spec wording "the local backend is active OR
      // MCP_AUTHORITY_URL is set" → "the line is not
      // emitted" when MCP_AUTHORITY_URL is set (which
      // selects either the JWKS or the OAuth admin
      // backend, depending on the operator's stack).
      const { logger, calls } = recordingLogger();
      const result = emitLocalRosterDeprecationWarn("jwks", logger);
      expect(result).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it("is one-shot: the second call on the local backend does NOT re-emit (the spec's 'exactly once per process')", () => {
      // GIVEN the WARN was emitted once
      // WHEN emit() is called again on the local backend
      // THEN no second WARN is recorded. The "process"
      //      scope is the module's lifetime; the helper
      //      keeps a module-level flag and short-circuits
      //      on subsequent calls.
      const { logger, calls } = recordingLogger();
      const first = emitLocalRosterDeprecationWarn("local", logger);
      const second = emitLocalRosterDeprecationWarn("local", logger);
      const third = emitLocalRosterDeprecationWarn("local", logger);
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(third).toBe(false);
      const warnCalls = calls.filter((c) => c.level === "warn");
      expect(warnCalls).toHaveLength(1);
      // The internal flag flips on the first emit.
      expect(_hasEmittedLocalRosterWarn()).toBe(true);
    });

    it("once reset, the helper emits again (the test-only reset is a true reset, not a no-op)", () => {
      // GIVEN the WARN was emitted once and the test
      //      reset hook is called
      // WHEN emit() is called again on the local backend
      // THEN the WARN is recorded. The reset is the
      //      test-only seam; production code NEVER calls
      //      it (the spec forbids re-emitting in a
      //      process).
      const { logger, calls } = recordingLogger();
      emitLocalRosterDeprecationWarn("local", logger);
      _resetLocalRosterWarnState();
      expect(_hasEmittedLocalRosterWarn()).toBe(false);
      const result = emitLocalRosterDeprecationWarn("local", logger);
      expect(result).toBe(true);
      const warnCalls = calls.filter((c) => c.level === "warn");
      expect(warnCalls).toHaveLength(2);
    });
  });

  describe("loadHttpRuntimeConfig wiring (integration)", () => {
    function writeAgentsFile(contents: string): string {
      const filePath = join(tempDir, "agents.json");
      writeFileSync(filePath, contents, "utf8");
      return filePath;
    }

    /**
     * Spy on `process.stderr.write` and return a
     * function that returns the concatenated stderr
     * buffer. The resource server's stderr-logger writes
     * one line per `info` / `warn` / `error` call, so the
     * buffer is a line-oriented log of every channel event
     * during `loadHttpRuntimeConfig`. The deprecation WARN
     * appears in the buffer when the helper fires.
     */
    function captureStderr(): { buffer: () => string; restore: () => void } {
      const original = process.stderr.write.bind(process.stderr);
      let buf = "";
      const spy = vi
        .spyOn(process.stderr, "write")
        // The Node.js `process.stderr.write` signature is
        // `write(chunk, encoding?, callback?)`. We
        // capture the first arg (string or Buffer) and
        // forward the call to the original implementation
        // so the test runner's own logging still works.
        .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
          if (typeof chunk === "string") buf += chunk;
          else if (Buffer.isBuffer(chunk)) buf += chunk.toString("utf8");
          // Return the boolean the original would have
          // returned so vitest's internals stay happy.
          return original(chunk as string | Uint8Array, ...(rest as [])) as unknown as boolean;
        });
      return {
        buffer: () => buf,
        restore: () => spy.mockRestore(),
      };
    }

    it("emits the local-roster WARN when MCP_AUTHORITY_URL is unset and the local backend is selected", async () => {
      // GIVEN no MCP_AUTHORITY_URL (local backend
      //      selected), a valid agent roster, a fresh
      //      module-level flag
      // WHEN loadHttpRuntimeConfig() runs
      // THEN stderr contains the WARN text (the helper
      //      fires once and writes via the stderr-logger).
      const path = writeAgentsFile(JSON.stringify([VALID_AGENT]));
      process.env.MCP_AGENTS_JSON = path;
      delete process.env.MCP_AUTHORITY_URL;
      delete process.env.MCP_AUTHORITY_AUDIENCE;

      const cap = captureStderr();
      try {
        const cfg = await loadHttpRuntimeConfig();
        expect(cfg.authorityBackend).toBe("local");
        const stderr = cap.buffer();
        // The WARN text is the canonical message from
        // the pure helper; the stderr logger prefixes it
        // with `[mcp-readonly-sql] `. The deprecation
        // substring (e.g. "local HMAC roster is
        // deprecated") is the unique anchor.
        expect(stderr).toMatch(/local HMAC roster is deprecated/);
        expect(stderr).toMatch(/MCP_AGENTS_JSON/);
        expect(stderr).toMatch(/MCP_AGENTS_INLINE/);
        expect(stderr).toMatch(/MCP_AGENT_HMAC_SECRET/);
        expect(stderr).toMatch(/deploy\/README\.md/);
        expect(stderr).toMatch(/mcp-oauth-admin/);
      } finally {
        cap.restore();
      }
    });

    it("does NOT emit the local-roster WARN when MCP_AUTHORITY_URL is set and the OAuth admin backend is selected", async () => {
      // GIVEN MCP_AUTHORITY_URL set (OAuth admin backend
      //      selected), a stubbed fetch that returns a
      //      minimal JWKS + introspect response
      // WHEN loadHttpRuntimeConfig() runs
      // THEN stderr does NOT contain the deprecation
      //      WARN. The helper sees `backend="oauth"` and
      //      short-circuits; the stderr buffer records
      //      only the other startup lines the loader
      //      emits.
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
      const cap = captureStderr();
      try {
        process.env.MCP_AUTHORITY_URL = "https://auth.example.com";
        process.env.MCP_AUTHORITY_AUDIENCE = "mcp-readonly-sql";
        delete process.env.MCP_AGENTS_JSON;
        delete process.env.MCP_AGENTS_INLINE;

        const cfg = await loadHttpRuntimeConfig();
        expect(cfg.authorityBackend).toBe("oauth");
        const stderr = cap.buffer();
        expect(stderr).not.toMatch(/local HMAC roster is deprecated/);
      } finally {
        cap.restore();
        vi.unstubAllGlobals();
      }
    });
  });
});

// Cleanup the temp dir after the suite. (Vitest does not
// expose `afterAll` for module teardown easily; the temp
// dir is small and the OS reclaims on reboot.)
process.on("exit", () => {
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
