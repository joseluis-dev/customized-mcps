/**
 * Tests for the retained scope utilities in `packages/mcp-http-base/src/auth.ts`.
 *
 * The local HMAC roster backend was removed in favour of the OAuth / JWKS
 * authority backends. The `SCOPE_PATTERN`, `isValidScope`, and `matchScope`
 * utilities are retained because every authority implementation filters
 * its resolved scope set against the same grammar — they are the single
 * source of truth for "a valid scope" on the resource-server side.
 *
 * These tests cover the v1 contract:
 *  - exact `<verb>:<resource>` match
 *  - wildcard resource (`<verb>:*`)
 *  - verb mismatch (different verbs do not promote)
 *  - resource mismatch (different resources do not promote)
 *  - wildcard verb (`*:<resource>`) is NOT a wildcard
 *  - empty agent scope set returns false
 *  - valid scopes (read|list|call) and invalid scopes (delete, malformed, etc.)
 */

import { describe, it, expect } from "vitest";
import {
  SCOPE_PATTERN,
  isValidScope,
  matchScope,
  type Scope,
} from "../src/auth.js";

describe("SCOPE_PATTERN", () => {
  it("matches the canonical valid scopes (read|list|call, identifier or '*')", () => {
    // The grammar is `<verb>:<resource>` where verb is in {read, list, call}
    // and resource is `*` or an identifier `[A-Za-z0-9_.-]+`. The pattern
    // is case-insensitive on the verb.
    expect(SCOPE_PATTERN.test("read:bi_catastro")).toBe(true);
    expect(SCOPE_PATTERN.test("list:bi_catastro")).toBe(true);
    expect(SCOPE_PATTERN.test("call:foo")).toBe(true);
    expect(SCOPE_PATTERN.test("read:*")).toBe(true);
    expect(SCOPE_PATTERN.test("list:*")).toBe(true);
    expect(SCOPE_PATTERN.test("call:*")).toBe(true);
    expect(SCOPE_PATTERN.test("READ:foo")).toBe(true);
    expect(SCOPE_PATTERN.test("List:foo")).toBe(true);
  });

  it("rejects unknown verbs (delete|write|admin are not in v1)", () => {
    // v1 has only {read, list, call}. Mutating verbs like `delete` are
    // not part of the resource-server surface in v1; a future change
    // may extend the verb set, at which point this assertion is the
    // place to update.
    expect(SCOPE_PATTERN.test("delete:foo")).toBe(false);
    expect(SCOPE_PATTERN.test("write:foo")).toBe(false);
    expect(SCOPE_PATTERN.test("admin:foo")).toBe(false);
    expect(SCOPE_PATTERN.test("execute:foo")).toBe(false);
  });

  it("rejects malformed scopes (missing verb, missing resource, extra colon)", () => {
    // The grammar is strict: `<verb>:<resource>`. Anything else fails.
    expect(SCOPE_PATTERN.test("readfoo")).toBe(false);
    expect(SCOPE_PATTERN.test("read:")).toBe(false);
    expect(SCOPE_PATTERN.test(":foo")).toBe(false);
    expect(SCOPE_PATTERN.test(":")).toBe(false);
    expect(SCOPE_PATTERN.test("")).toBe(false);
    expect(SCOPE_PATTERN.test("read:foo:bar")).toBe(false);
    expect(SCOPE_PATTERN.test("read : foo")).toBe(false);
  });

  it("rejects a wildcard verb (`*:<resource>` is not a v1 wildcard)", () => {
    // v1 only wildcard's the resource; `*:<resource>` is not a valid
    // scope. The matchScope implementation must treat a wildcard verb
    // as a non-match (the test below is the binding contract).
    expect(SCOPE_PATTERN.test("*:bi_catastro")).toBe(false);
  });
});

describe("isValidScope", () => {
  it("returns true for valid scope strings", () => {
    expect(isValidScope("read:bi_catastro")).toBe(true);
    expect(isValidScope("list:*")).toBe(true);
    expect(isValidScope("call:foo")).toBe(true);
  });

  it("returns false for invalid scope strings", () => {
    expect(isValidScope("delete:foo")).toBe(false);
    expect(isValidScope("readfoo")).toBe(false);
    expect(isValidScope("read:")).toBe(false);
    expect(isValidScope(":foo")).toBe(false);
    expect(isValidScope("")).toBe(false);
  });

  it("returns false for non-string inputs (defensive type guard)", () => {
    // isValidScope is a string predicate. Non-string inputs MUST be
    // rejected so a downstream `for (const s of rawScopes)` loop can
    // filter scope arrays that contain null / undefined / numbers.
    expect(isValidScope(undefined as unknown as string)).toBe(false);
    expect(isValidScope(null as unknown as string)).toBe(false);
    expect(isValidScope(42 as unknown as string)).toBe(false);
    expect(isValidScope({} as unknown as string)).toBe(false);
  });
});

describe("matchScope", () => {
  it("matches an exact verb:resource scope", () => {
    expect(matchScope(["read:bi_catastro"], "read:bi_catastro")).toBe(true);
  });

  it("matches a wildcard resource when the verb matches", () => {
    // The resource `*` permits any resource name when the verb matches.
    // This is the only wildcard in v1; the verb is always literal.
    expect(matchScope(["read:*"], "read:bi_catastro")).toBe(true);
    expect(matchScope(["read:*"], "read:reporting")).toBe(true);
    expect(matchScope(["list:*"], "list:anything-at-all")).toBe(true);
  });

  it("rejects a verb mismatch (different verbs are not interchangeable)", () => {
    // Verbs are independent: `read:<r>` does NOT satisfy `list:<r>` or
    // `call:<r>`. Callers MUST request a scope whose verb matches the
    // tool category they want to use.
    expect(matchScope(["read:bi_catastro"], "list:bi_catastro")).toBe(false);
    expect(matchScope(["read:bi_catastro"], "call:bi_catastro")).toBe(false);
  });

  it("rejects a resource mismatch", () => {
    // A read scope for `bi_catastro` MUST NOT permit a read for a
    // different resource. The wildcard `*` would, but a literal
    // resource does not.
    expect(matchScope(["read:bi_catastro"], "read:reporting")).toBe(false);
  });

  it("does NOT treat a wildcard verb as a wildcard (verbs are not wildcarded in v1)", () => {
    // A literal scope `*:bi_catastro` is not a valid SCOPE_PATTERN
    // match on its own (isValidScope returns false), but matchScope
    // also does NOT promote a leading-`*` to "any verb". The check
    // is independent of the validity check: even if a malformed
    // scope landed in the agent's resolved set, it MUST NOT widen
    // the agent's authority.
    expect(matchScope(["*:bi_catastro"], "read:bi_catastro")).toBe(false);
    expect(matchScope(["*:bi_catastro"], "list:bi_catastro")).toBe(false);
    expect(matchScope(["*:bi_catastro"], "call:bi_catastro")).toBe(false);
  });

  it("returns false when the agent scope set is empty", () => {
    // No scopes → no permission. This is the fail-closed default.
    expect(matchScope([], "read:bi_catastro")).toBe(false);
  });

  it("returns false when no entry in the scope set matches", () => {
    // The list contains a different verb or a different resource; none
    // satisfy the requested scope.
    expect(matchScope(["list:bi_catastro"], "read:bi_catastro")).toBe(false);
    expect(matchScope(["read:reporting"], "read:bi_catastro")).toBe(false);
    expect(matchScope(["read:reporting", "list:bi_catastro"], "read:bi_catastro")).toBe(false);
  });

  it("does not promote read to call across the same resource (verbs are independent)", () => {
    // The conservative posture: read-only agents MUST NOT acquire
    // call capabilities implicitly. Callers MUST request a scope
    // whose verb matches the tool category they want to use.
    expect(matchScope(["read:bi_catastro"], "call:bi_catastro")).toBe(false);
  });

  it("matches when at least one entry in the scope set is sufficient", () => {
    // Multi-entry scope sets: the agent has several scopes; the
    // request is permitted if ANY single scope entry matches.
    expect(matchScope(["list:bi_catastro", "read:bi_catastro"], "read:bi_catastro")).toBe(true);
    expect(matchScope(["read:reporting", "read:bi_catastro"], "read:bi_catastro")).toBe(true);
    expect(matchScope(["read:*", "list:bi_catastro"], "list:bi_catastro")).toBe(true);
  });

  it("is case-insensitive on the verb (the resource is case-sensitive)", () => {
    // The grammar is case-insensitive on the verb (the `i` flag on
    // SCOPE_PATTERN) but case-sensitive on the resource. A wildcard
    // resource (`*`) is the only case where the case-sensitivity of
    // the resource side does not matter.
    expect(matchScope(["READ:bi_catastro"], "read:bi_catastro")).toBe(true);
    expect(matchScope(["read:BI_CATASTRO"], "read:bi_catastro")).toBe(false);
    expect(matchScope(["read:*"], "read:bi_catastro")).toBe(true);
  });

  it("rejects a malformed required scope (missing verb or missing resource)", () => {
    // A scope with no verb, no resource, or an empty string after the
    // colon does not match anything. This is the fail-closed default.
    expect(matchScope(["read:bi_catastro"], "" as Scope)).toBe(false);
    expect(matchScope(["read:bi_catastro"], ":bi_catastro" as Scope)).toBe(false);
    expect(matchScope(["read:bi_catastro"], "read:" as Scope)).toBe(false);
    expect(matchScope(["read:bi_catastro"], "read" as Scope)).toBe(false);
  });

  it("ignores empty / malformed entries in the agent scope set", () => {
    // A defensive posture: an agent scope set that contains
    // malformed entries (e.g. a typo) MUST NOT widen the agent's
    // authority. The loop skips entries that lack a verb or
    // resource. Valid entries still match.
    expect(matchScope(["", "read:*"], "read:bi_catastro")).toBe(true);
    expect(matchScope(["readfoo", "read:bi_catastro"], "read:bi_catastro")).toBe(true);
  });
});
