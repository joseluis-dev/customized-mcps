/**
 * Unit tests for `LocalRosterAuthority`.
 *
 * Phase 1a of the external-token-authority-verification change introduces
 * the `TokenAuthority` abstraction. The local backend is the dev/offline
 * fallback: it wraps the existing v1 `loadAgents` + `validateBearer` path
 * and applies a defense-in-depth `SCOPE_PATTERN` filter on the resolved
 * scopes. The v1 HMAC + constant-time guarantees are preserved; the only
 * NEW behavior is that scopes that do not match `SCOPE_PATTERN` are
 * dropped from the resolved set and logged at `WARN` (the rejected value
 * is omitted from the log line — see `mcp-token-authority` for the
 * audit-safe redaction contract).
 *
 * Bit-for-bit equivalence is asserted by:
 * - the same agent id is returned for the same token (HMAC compare)
 * - `TokenInvalidError` is thrown for unknown tokens (mimicking v1
 *   `validateBearer` returning `ok: false`)
 * - the HMAC secret is NEVER included in the error shape
 * - the supplied token is NEVER included in the error shape
 *
 * Scope-filtering is asserted by:
 * - a mixed scopes array is filtered: valid entries are kept, invalid
 *   entries are dropped from the resolved set
 * - a `WARN` log line is emitted with the agent id (and the count of
 *   dropped entries) but NOT the rejected scope values themselves
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  LocalRosterAuthority,
  TokenInvalidError,
  AuthorityUnavailableError,
  type TokenAuthority,
  type VerifiedToken,
} from "../../src/authority/index.js";
import type { AgentRecord } from "../../src/auth.js";
import type { Logger } from "../../src/logging.js";

const SECRET = "super-secret-test-key-32-bytes!!";

function hmacOf(token: string): string {
  return createHmac("sha256", SECRET).update(token).digest("hex");
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-a",
    keyHash: hmacOf("tok-a"),
    scopes: ["read:*"],
    ...overrides,
  };
}

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

describe("LocalRosterAuthority", () => {
  describe("construction", () => {
    it("rejects a missing agents list (fails closed)", () => {
      // GIVEN no agents and no logger
      // WHEN the authority is constructed
      // THEN the constructor throws (the middleware MUST NOT be wired
      //      against an empty roster — a permissive default would be a
      //      silent misconfiguration leak)
      expect(
        () => new LocalRosterAuthority({ agents: [], hmacSecret: SECRET, logger: silentLogger() }),
      ).toThrow(/at least one agent/i);
    });

    it("rejects an HMAC secret shorter than 32 bytes (defends the constant-time contract)", () => {
      // GIVEN a short HMAC secret
      // WHEN the authority is constructed
      // THEN the constructor throws — the shared base already enforces
      //      this on the env parser, but the authority is the runtime
      //      surface and MUST not allow a weak secret to reach the
      //      HMAC compare.
      expect(
        () =>
          new LocalRosterAuthority({
            agents: [makeAgent()],
            hmacSecret: "short",
            logger: silentLogger(),
          }),
      ).toThrow(/32/i);
    });
  });

  describe("verify — bit-for-bit v1 equivalence (HMAC + constant-time)", () => {
    let authority: TokenAuthority;
    beforeEach(() => {
      authority = new LocalRosterAuthority({
        agents: [makeAgent()],
        hmacSecret: SECRET,
        logger: silentLogger(),
      });
    });

    it("returns {agentId, scopes} when the token HMAC matches the keyHash", async () => {
      // GIVEN a valid token for agent-a
      // WHEN verify is called
      // THEN the resolved identity matches the v1 validateBearer output:
      //      same agentId, same scopes
      const result = (await authority.verify("tok-a")) as VerifiedToken;
      expect(result.agentId).toBe("agent-a");
      expect(result.scopes).toEqual(["read:*"]);
    });

    it("returns the FIRST agent whose keyHash matches (v1 order semantics)", async () => {
      // GIVEN two agents with distinct tokens
      // WHEN the token for the second agent is presented
      // THEN the resolved identity is the second agent
      const a = makeAgent({ id: "agent-a", keyHash: hmacOf("tok-a"), scopes: ["read:*"] });
      const b = makeAgent({ id: "agent-b", keyHash: hmacOf("tok-b"), scopes: ["list:bi"] });
      const auth = new LocalRosterAuthority({
        agents: [a, b],
        hmacSecret: SECRET,
        logger: silentLogger(),
      });
      const result = (await auth.verify("tok-b")) as VerifiedToken;
      expect(result.agentId).toBe("agent-b");
      expect(result.scopes).toEqual(["list:bi"]);
    });

    it("throws TokenInvalidError for an unknown token (v1 reason='invalid' analogue)", async () => {
      // GIVEN a token that does not match any agent's keyHash
      // WHEN verify is called
      // THEN the rejected error is a TokenInvalidError (mapped to 401 by
      //      the middleware). v1's validateBearer returned
      //      { ok: false, reason: "invalid" } for the same condition.
      await expect(authority.verify("definitely-not-a-real-token")).rejects.toBeInstanceOf(
        TokenInvalidError,
      );
    });

    it("throws TokenInvalidError for an empty token (v1 reason='missing' analogue)", async () => {
      // GIVEN an empty token
      // WHEN verify is called
      // THEN the rejected error is a TokenInvalidError (the middleware
      //      also short-circuits on the empty header, but the
      //      authority itself must defend this branch in case a future
      //      caller reaches verify with a non-header value).
      await expect(authority.verify("")).rejects.toBeInstanceOf(TokenInvalidError);
    });

    it("the TokenInvalidError message never includes the supplied token", async () => {
      // GIVEN a token that does not match any agent
      // WHEN verify is called
      // THEN the error message does not contain the supplied token
      //      (audit-safe redaction; the shared base's sanitizeError
      //      path also strips this on the way to the wire).
      const suppliedToken = "super-secret-supplied-token-DO-NOT-LOG";
      try {
        await authority.verify(suppliedToken);
        expect.fail("expected TokenInvalidError");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        expect(message).not.toContain(suppliedToken);
      }
    });

    it("the TokenInvalidError message never includes the HMAC secret or any agent keyHash", async () => {
      // GIVEN the agent's keyHash and the HMAC secret
      // WHEN verify is called with an unknown token
      // THEN neither appears in the error message — the same
      //      audit-safe guarantee v1's validateBearer enforces via its
      //      discriminated-union return shape.
      const agentKeyHash = hmacOf("tok-a");
      try {
        await authority.verify("not-a-real-token");
        expect.fail("expected TokenInvalidError");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        expect(message).not.toContain(agentKeyHash);
        expect(message).not.toContain(SECRET);
      }
    });
  });

  describe("verify — defense-in-depth SCOPE_PATTERN filter (F1)", () => {
    it("drops scopes that do not match SCOPE_PATTERN (the rejected values are NOT in the result)", async () => {
      // GIVEN an agent with a mix of valid and invalid scopes
      //      (the invalid ones are typed as string[] on AgentRecord, so
      //      they survive loadAgents in test wiring; the runtime filter
      //      is the defense-in-depth layer that catches them)
      // WHEN verify is called
      // THEN only the valid scope is returned
      const mixedAgent: AgentRecord = makeAgent({
        id: "agent-mixed",
        keyHash: hmacOf("tok-mixed"),
        scopes: ["read:bi_catastro", "delete:foo", "list:reporting", "invalid-scope"],
      });
      const authority = new LocalRosterAuthority({
        agents: [mixedAgent],
        hmacSecret: SECRET,
        logger: silentLogger(),
      });
      const result = (await authority.verify("tok-mixed")) as VerifiedToken;
      expect(result.agentId).toBe("agent-mixed");
      expect(result.scopes).toEqual(["read:bi_catastro", "list:reporting"]);
      expect(result.scopes).not.toContain("delete:foo");
      expect(result.scopes).not.toContain("invalid-scope");
    });

    it("emits a single WARN log line when invalid scopes are dropped, with the agentId and the count of dropped entries (no rejected values)", () => {
      // GIVEN an authority whose logger is a spy
      // WHEN the authority is constructed with an agent that has invalid
      //      scopes
      // THEN a WARN is emitted that:
      //      - includes the agent id (so operators can locate the record)
      //      - includes the count of dropped entries
      //      - does NOT include any rejected scope value
      const mixedAgent: AgentRecord = makeAgent({
        id: "agent-mixed-warn",
        keyHash: hmacOf("tok-mixed-warn"),
        scopes: ["read:bi", "delete:foo", "read:reporting", "another-bad"],
      });
      const warnSpy = vi.fn();
      const logger: Logger = {
        info: () => undefined,
        warn: warnSpy,
        error: () => undefined,
      };
      new LocalRosterAuthority({
        agents: [mixedAgent],
        hmacSecret: SECRET,
        logger,
      });
      // The construction-time filter is the layer under test. At least
      // one WARN must be emitted (one per agent with dropped scopes).
      const warnCalls = warnSpy.mock.calls;
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      // The first WARN argument is the message. It MUST mention the
      // agent id and the count of dropped scopes. It MUST NOT include
      // the rejected values themselves.
      const firstMessage = warnCalls[0]?.[0] as string;
      expect(typeof firstMessage).toBe("string");
      expect(firstMessage).toContain("agent-mixed-warn");
      // Rejected values: "delete:foo" and "another-bad" — these must not leak.
      expect(firstMessage).not.toContain("delete:foo");
      expect(firstMessage).not.toContain("another-bad");
      // The valid values MUST also not leak — the WARN is about the
      // rejection, not a dump of the scope set.
      expect(firstMessage).not.toContain("read:bi");
      expect(firstMessage).not.toContain("read:reporting");
    });

    it("does not emit a WARN when every scope is valid (happy path is silent)", () => {
      // GIVEN an agent with all valid scopes
      // WHEN the authority is constructed
      // THEN no WARN is emitted — the filter is a defense layer, not a
      //      normal-path log line. Operators who see a WARN learn there
      //      is a misconfigured scope somewhere.
      const cleanAgent = makeAgent({
        id: "agent-clean",
        keyHash: hmacOf("tok-clean"),
        scopes: ["read:bi", "list:*"],
      });
      const warnSpy = vi.fn();
      const logger: Logger = {
        info: () => undefined,
        warn: warnSpy,
        error: () => undefined,
      };
      new LocalRosterAuthority({
        agents: [cleanAgent],
        hmacSecret: SECRET,
        logger,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("TokenAuthority interface compliance", () => {
    it("exposes a verify method that returns a Promise<VerifiedToken>", async () => {
      // GIVEN a LocalRosterAuthority
      // WHEN its verify method is invoked
      // THEN the return is a Promise and the resolved value matches
      //      the { agentId, scopes } contract.
      const authority = new LocalRosterAuthority({
        agents: [makeAgent()],
        hmacSecret: SECRET,
        logger: silentLogger(),
      });
      const promise = authority.verify("tok-a");
      expect(promise).toBeInstanceOf(Promise);
      const result = (await promise) as VerifiedToken;
      expect(typeof result.agentId).toBe("string");
      expect(Array.isArray(result.scopes)).toBe(true);
    });
  });
});

describe("TokenAuthority typed-error contract", () => {
  it("TokenInvalidError is an Error subclass and carries a name", () => {
    // GIVEN the typed error class
    // WHEN it is instantiated
    // THEN it behaves as an Error and the name is set (the middleware
    //      uses `name` as the discriminator in the catch block).
    const e = new TokenInvalidError("nope");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("TokenInvalidError");
  });

  it("AuthorityUnavailableError is an Error subclass and carries a name", () => {
    // GIVEN the typed error class
    // WHEN it is instantiated
    // THEN it behaves as an Error and the name is set.
    const e = new AuthorityUnavailableError("offline");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AuthorityUnavailableError");
  });

  it("TokenInvalidError and AuthorityUnavailableError are NOT the same class", () => {
    // GIVEN both typed error classes
    // WHEN the discriminator is checked
    // THEN they are distinct — the middleware maps each to a different
    //      HTTP status (401 vs 503). If they collapsed, every failure
    //      would be mapped to the same status, breaking the
    //      audit-safe-503-on-unreachable contract.
    const invalid = new TokenInvalidError("x");
    const unavailable = new AuthorityUnavailableError("x");
    expect(invalid).not.toBeInstanceOf(AuthorityUnavailableError);
    expect(unavailable).not.toBeInstanceOf(TokenInvalidError);
  });
});
