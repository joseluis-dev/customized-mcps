import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  loadAgents,
  validateBearer,
  matchScope,
  type AgentRecord,
} from "../src/auth.js";

/**
 * Build an HMAC keyHash for tests so we exercise the same SHA-256 path
 * production code uses, instead of hand-rolled hex strings.
 */
function hmac(secret: string, token: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-a",
    keyHash: hmac("super-secret-test-key-32-bytes!!", "tok-a"),
    scopes: ["read:*"],
    ...overrides,
  };
}

describe("loadAgents", () => {
  it("parses a single agent", () => {
    const out = loadAgents(JSON.stringify([makeAgent()]));
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("agent-a");
    expect(out[0]?.scopes).toEqual(["read:*"]);
  });

  it("parses multiple agents preserving order", () => {
    const a = makeAgent({ id: "first" });
    const b = makeAgent({ id: "second", scopes: ["list:bi_catastro"] });
    const c = makeAgent({ id: "third", scopes: ["call:*"] });
    const out = loadAgents(JSON.stringify([a, b, c]));
    expect(out.map((x) => x.id)).toEqual(["first", "second", "third"]);
    expect(out.map((x) => x.scopes)).toEqual([
      ["read:*"],
      ["list:bi_catastro"],
      ["call:*"],
    ]);
  });

  it("throws on invalid JSON", () => {
    expect(() => loadAgents("{not json")).toThrow();
  });

  it("throws when the root is not an array", () => {
    expect(() => loadAgents('{"id":"a"}')).toThrow(/array/);
  });

  it("throws when an agent record is missing a required field", () => {
    expect(() => loadAgents(JSON.stringify([{ id: "x" }]))).toThrow();
    expect(() =>
      loadAgents(
        JSON.stringify([{ id: "x", keyHash: "abc", scopes: "not-an-array" }]),
      ),
    ).toThrow();
  });

  it("normalizes and trims string fields", () => {
    const validKeyHash = "0123456789abcdef".repeat(4); // 64 hex chars
    const out = loadAgents(
      JSON.stringify([
        {
          id: "  spaced  ",
          keyHash: `  ${validKeyHash}  `,
          scopes: [" read:profile "],
        },
      ]),
    );
    expect(out[0]?.id).toBe("spaced");
    expect(out[0]?.keyHash).toBe(validKeyHash);
    expect(out[0]?.scopes).toEqual(["read:profile"]);
  });

  it("throws on duplicate agent ids", () => {
    const a = makeAgent({ id: "dup" });
    const b = makeAgent({ id: "dup" });
    expect(() => loadAgents(JSON.stringify([a, b]))).toThrow(/duplicate/i);
  });

  it("rejects a keyHash that is not exactly 64 hex characters", () => {
    const tooShort = makeAgent({ keyHash: "a".repeat(63) });
    expect(() => loadAgents(JSON.stringify([tooShort]))).toThrow(/64 hex/);

    const tooLong = makeAgent({ keyHash: "a".repeat(65) });
    expect(() => loadAgents(JSON.stringify([tooLong]))).toThrow(/64 hex/);

    const nonHex = makeAgent({ keyHash: "z".repeat(64) });
    expect(() => loadAgents(JSON.stringify([nonHex]))).toThrow(/64 hex/);
  });

  it("accepts a well-formed 64-char hex keyHash", () => {
    const valid = makeAgent({ keyHash: "0123456789abcdef".repeat(4) });
    const out = loadAgents(JSON.stringify([valid]));
    expect(out[0]?.keyHash).toBe("0123456789abcdef".repeat(4));
  });

  it("rejects scopes that do not match the grammar (verb:resource)", () => {
    const badVerb = makeAgent({ scopes: ["delete:foo"] });
    expect(() => loadAgents(JSON.stringify([badVerb]))).toThrow(/scope/);

    const malformed = makeAgent({ scopes: ["readfoo"] });
    expect(() => loadAgents(JSON.stringify([malformed]))).toThrow(/scope/);

    const emptyResource = makeAgent({ scopes: ["read:"] });
    expect(() => loadAgents(JSON.stringify([emptyResource]))).toThrow(/scope/);

    const emptyVerb = makeAgent({ scopes: [":foo"] });
    expect(() => loadAgents(JSON.stringify([emptyVerb]))).toThrow(/scope/);
  });

  it("accepts scopes with verb in {read, list, call} and resource as identifier or '*'", () => {
    const wildcardStar = makeAgent({ scopes: ["read:*"] });
    expect(() => loadAgents(JSON.stringify([wildcardStar]))).not.toThrow();

    const namedResource = makeAgent({
      scopes: ["read:bi_catastro", "list:bi_catastro", "call:*"],
    });
    expect(() => loadAgents(JSON.stringify([namedResource]))).not.toThrow();
  });
});

describe("validateBearer", () => {
  const secret = "super-secret-test-key-32-bytes!!";
  const token = "tok-a";
  const agent = makeAgent({
    id: "agent-a",
    keyHash: hmac(secret, token),
    scopes: ["read:bi_catastro"],
  });

  it("accepts a token whose HMAC matches an agent's keyHash", () => {
    const result = validateBearer(token, secret, [agent]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agent.id).toBe("agent-a");
      expect(result.agent.scopes).toEqual(["read:bi_catastro"]);
    }
  });

  it("rejects a missing token (empty string) with reason=missing", () => {
    const result = validateBearer("", secret, [agent]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing");
    }
  });

  it("rejects a malformed token with reason=invalid", () => {
    const result = validateBearer("not-the-right-token", secret, [agent]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid");
    }
  });

  it("rejects an empty agent list with reason=invalid (no agent matches)", () => {
    const result = validateBearer(token, secret, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid");
    }
  });

  it("does not include the supplied token in any failure shape", () => {
    const result = validateBearer("totally-wrong", secret, [agent]);
    expect(result.ok).toBe(false);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("totally-wrong");
  });

  it("does not include the agent id, keyHash, or HMAC secret in any failure shape", () => {
    const result = validateBearer("totally-wrong", secret, [agent]);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("agent-a");
    expect(serialised).not.toContain(agent.keyHash);
    expect(serialised).not.toContain(secret);
  });
});

describe("constant-time comparison (timingSafeEqual)", () => {
  it("returns true for equal buffers", async () => {
    const { constantTimeEqualString } = await import("../src/auth.js");
    expect(constantTimeEqualString("abc", "abc")).toBe(true);
  });

  it("returns false for buffers of different length", async () => {
    const { constantTimeEqualString } = await import("../src/auth.js");
    expect(constantTimeEqualString("abc", "abcd")).toBe(false);
  });

  it("returns false for buffers of equal length but different content", async () => {
    const { constantTimeEqualString } = await import("../src/auth.js");
    expect(constantTimeEqualString("abc", "abd")).toBe(false);
  });
});

describe("matchScope", () => {
  it("matches an exact verb:resource scope", () => {
    expect(matchScope(["read:bi_catastro"], "read:bi_catastro")).toBe(true);
  });

  it("rejects a different verb", () => {
    expect(matchScope(["read:bi_catastro"], "list:bi_catastro")).toBe(false);
  });

  it("rejects a different resource", () => {
    expect(matchScope(["read:bi_catastro"], "read:reporting")).toBe(false);
  });

  it("accepts a wildcard resource when the verb matches", () => {
    expect(matchScope(["read:*"], "read:bi_catastro")).toBe(true);
    expect(matchScope(["read:*"], "read:reporting")).toBe(true);
  });

  it("does not let a wildcard verb be used (verbs are not wildcarded)", () => {
    expect(matchScope(["*:bi_catastro"], "read:bi_catastro")).toBe(false);
  });

  it("returns false when no scope matches", () => {
    expect(matchScope([], "read:bi_catastro")).toBe(false);
    expect(matchScope(["list:bi_catastro"], "read:bi_catastro")).toBe(false);
  });

  it("does not promote read to call across the same resource", () => {
    // Verbs are independent; call operations require an explicit call:<r>
    // scope. This is the conservative choice — read-only agents MUST NOT
    // acquire call capabilities implicitly.
    expect(matchScope(["read:bi_catastro"], "call:bi_catastro")).toBe(false);
  });
});
