import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createLogger,
  redactSensitive,
  type LogFormat,
} from "../src/logging.js";

describe("redactSensitive", () => {
  it("redacts a bearer token fragment", () => {
    const out = redactSensitive("Authorization: Bearer abc.def.ghi");
    expect(out).not.toContain("abc.def.ghi");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a keyHash value (hex-shaped string)", () => {
    const out = redactSensitive(`keyHash: ${"a".repeat(64)}`);
    expect(out).not.toContain("a".repeat(64));
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a mixed-hex keyHash value (digits and letters a-f)", () => {
    const hash = "0123456789abcdef".repeat(4); // 64 hex chars
    const out = redactSensitive(`keyHash: ${hash}`);
    expect(out).not.toContain(hash);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts an HMAC secret value passed by name", () => {
    const out = redactSensitive("MCP_AGENT_HMAC_SECRET: super-secret-value");
    expect(out).not.toContain("super-secret-value");
    expect(out).toContain("[REDACTED]");
  });

  it("does not redact arbitrary non-sensitive text", () => {
    const out = redactSensitive("Server started on port 3000");
    expect(out).toBe("Server started on port 3000");
  });

  it("redacts multiple sensitive fragments in the same line", () => {
    const hash = "0123456789abcdef".repeat(4);
    const out = redactSensitive(
      `Authorization: Bearer ${"t".repeat(40)} keyHash: ${hash}`,
    );
    expect(out).not.toContain("t".repeat(40));
    expect(out).not.toContain(hash);
    // Two redactions in one line.
    const matches = out.match(/\[REDACTED\]/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("treats unknown patterns as non-sensitive", () => {
    const out = redactSensitive("user_id=42 and order=123");
    expect(out).not.toContain("[REDACTED]");
  });
});

describe("createLogger", () => {
  let stderrWrites: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrWrites = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  function newLogger(format: LogFormat) {
    return createLogger({ format });
  }

  describe("text format", () => {
    it("writes a single human-readable line to stderr", () => {
      const log = newLogger("text");
      log.info("server started");
      expect(stderrWrites).toHaveLength(1);
      const line = stderrWrites[0]!;
      expect(line).toContain("server started");
      expect(line).toMatch(/INFO/);
    });

    it("includes agentId and requestId when provided", () => {
      const log = newLogger("text");
      log.info("request handled", { agentId: "agent-a", requestId: "req-1" });
      const line = stderrWrites[0]!;
      expect(line).toContain("agentId=agent-a");
      expect(line).toContain("requestId=req-1");
    });

    it("redacts sensitive fragments inside the message", () => {
      const log = newLogger("text");
      log.info(`Authorization: Bearer ${"t".repeat(40)}`);
      const line = stderrWrites[0]!;
      expect(line).not.toContain("t".repeat(40));
      expect(line).toContain("[REDACTED]");
    });
  });

  describe("json format", () => {
    it("writes a single-line JSON object to stderr with ts/level/msg", () => {
      const log = newLogger("json");
      log.warn("capacity warning");
      expect(stderrWrites).toHaveLength(1);
      const parsed = JSON.parse(stderrWrites[0]!.trim());
      expect(parsed.level).toBe("warn");
      expect(parsed.msg).toBe("capacity warning");
      expect(typeof parsed.ts).toBe("string");
    });

    it("emits agentId as a structured field, not embedded in msg", () => {
      const log = newLogger("json");
      log.info("request handled", { agentId: "agent-a", requestId: "req-1" });
      const parsed = JSON.parse(stderrWrites[0]!.trim());
      expect(parsed.agentId).toBe("agent-a");
      expect(parsed.requestId).toBe("req-1");
      expect(parsed.msg).not.toContain("agent-a");
    });

    it("redacts sensitive content even inside the JSON message", () => {
      const log = newLogger("json");
      log.error(`bearer ${"x".repeat(40)} rejected`);
      const parsed = JSON.parse(stderrWrites[0]!.trim());
      expect(parsed.msg).not.toContain("x".repeat(40));
      expect(parsed.msg).toContain("[REDACTED]");
    });
  });

  describe("HTTP-only stream guarantee", () => {
    it("never writes to stdout", () => {
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const log = newLogger("json");
      log.info("anything");
      log.error("anything");
      log.warn("anything");
      expect(stdoutSpy).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });
  });
});
