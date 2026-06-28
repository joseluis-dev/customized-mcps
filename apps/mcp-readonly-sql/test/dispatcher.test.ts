import { describe, it, expect } from "vitest";
import { selectTransport } from "../src/dispatcher.js";

describe("transport dispatcher", () => {
  describe("selectTransport", () => {
    it("defaults to stdio when the value is undefined", () => {
      expect(selectTransport(undefined)).toBe("stdio");
    });

    it("defaults to stdio when the value is an empty string", () => {
      expect(selectTransport("")).toBe("stdio");
    });

    it("defaults to stdio when the value is whitespace", () => {
      expect(selectTransport("   ")).toBe("stdio");
    });

    it("accepts 'stdio' explicitly", () => {
      expect(selectTransport("stdio")).toBe("stdio");
    });

    it("accepts 'stdio' case-insensitively", () => {
      expect(selectTransport("STDIO")).toBe("stdio");
      expect(selectTransport("Stdio")).toBe("stdio");
    });

    it("accepts 'streamableHttp' explicitly", () => {
      expect(selectTransport("streamableHttp")).toBe("streamableHttp");
    });

    it("accepts 'streamableHttp' case-insensitively", () => {
      expect(selectTransport("STREAMABLEHTTP")).toBe("streamableHttp");
      expect(selectTransport("StreamableHttp")).toBe("streamableHttp");
    });

    it("trims surrounding whitespace before deciding", () => {
      expect(selectTransport("  stdio  ")).toBe("stdio");
      expect(selectTransport("\tstreamableHttp\n")).toBe("streamableHttp");
    });

    it("rejects unknown values with a message that names the allowed values", () => {
      // GIVEN MCP_TRANSPORT=tcp
      // WHEN the dispatcher evaluates it
      // THEN it throws an error mentioning the allowed values
      expect(() => selectTransport("tcp")).toThrow(/stdio/);
      expect(() => selectTransport("tcp")).toThrow(/streamableHttp/);
    });

    it("rejects unknown values (fail-fast) — the entrypoint can map the error to a non-zero exit", () => {
      // The dispatcher is a pure function: it throws and the caller decides
      // how to translate the failure to a process exit. Confirming the
      // contract here keeps the failure mode testable.
      expect(() => selectTransport("http")).toThrow();
      expect(() => selectTransport("websocket")).toThrow();
      expect(() => selectTransport("stdio-http")).toThrow();
    });
  });
});
