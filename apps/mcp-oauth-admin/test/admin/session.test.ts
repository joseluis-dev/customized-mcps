/**
 * Unit tests for the admin UI session module.
 *
 * The mcp-admin-ui spec requires:
 * - Session cookie: `HttpOnly`, `SameSite=Strict`, `Secure` (when not
 *   loopback), signed with a server-side secret. The secret is
 *   `node:crypto.randomBytes(32)`; restarting the process invalidates
 *   all sessions.
 * - Double-submit CSRF: every state-changing form has a hidden CSRF
 *   token input AND the matching `X-CSRF-Token` header on fetch
 *   requests; the server rejects requests missing either. CSRF
 *   token rotates on login and on privilege change.
 *
 * The session module is PURE: it has no DB dependency. The router
 * (test/admin/router.test.ts) wires it to the database; here we
 * test the cryptographic primitives in isolation.
 *
 * Test layer: unit. We do not need a real `node:http` listener —
 * the functions are pure.
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  generateSessionSecret,
  generateCsrfToken,
  signSessionCookie,
  verifySessionCookie,
  verifyCsrfToken,
  parseCookies,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  buildSetCookieHeader,
  type SessionData,
} from "../../src/admin/session.js";

const fixedNow = 1_700_000_000;
const sampleSession: SessionData = {
  username: "root",
  userId: 42,
  csrfToken: "csrf-abcdef-1234567890",
  createdAt: fixedNow,
};

describe("admin/session — secret + token generation", () => {
  it("generateSessionSecret returns a 64-char hex string (32 bytes)", () => {
    // GIVEN a fresh process
    // WHEN we generate a session secret
    // THEN the secret is 64 hex chars (32 bytes) and is non-empty.
    const secret = generateSessionSecret();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(secret.length).toBe(64);
  });

  it("generateSessionSecret returns a different secret on every call", () => {
    // GIVEN two consecutive calls
    // WHEN we compare the secrets
    // THEN they are NOT equal (the entropy source is random).
    const s1 = generateSessionSecret();
    const s2 = generateSessionSecret();
    expect(s1).not.toBe(s2);
  });

  it("generateCsrfToken returns a 64-char hex string (32 bytes)", () => {
    // GIVEN a fresh process
    // WHEN we generate a CSRF token
    // THEN the token is 64 hex chars and is non-empty.
    const token = generateCsrfToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(token.length).toBe(64);
  });

  it("generateCsrfToken returns a different token on every call", () => {
    const t1 = generateCsrfToken();
    const t2 = generateCsrfToken();
    expect(t1).not.toBe(t2);
  });
});

describe("admin/session — sign + verify", () => {
  it("signSessionCookie returns a base64url payload.signature string", () => {
    // GIVEN a session payload
    // WHEN we sign it
    // THEN the output is `<base64url-payload>.<base64url-signature>`
    //      with no newlines or whitespace.
    const secret = generateSessionSecret();
    const cookie = signSessionCookie(secret, sampleSession);
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const parts = cookie.split(".");
    expect(parts).toHaveLength(2);
  });

  it("verifySessionCookie accepts a valid signed cookie and returns the payload", () => {
    // GIVEN a cookie signed with a known secret
    // WHEN we verify it with the same secret
    // THEN the original SessionData roundtrips.
    const secret = generateSessionSecret();
    const cookie = signSessionCookie(secret, sampleSession);
    const verified = verifySessionCookie(secret, cookie);
    expect(verified).not.toBeNull();
    expect(verified).toEqual(sampleSession);
  });

  it("verifySessionCookie returns null for a cookie signed with a different secret", () => {
    // GIVEN a cookie signed with secret A
    // WHEN we verify with secret B (a process restart)
    // THEN verify returns null. This is the
    //      "secret rotation invalidates sessions" guarantee.
    const secretA = generateSessionSecret();
    const secretB = generateSessionSecret();
    const cookie = signSessionCookie(secretA, sampleSession);
    const verified = verifySessionCookie(secretB, cookie);
    expect(verified).toBeNull();
  });

  it("verifySessionCookie returns null for a tampered payload", () => {
    // GIVEN a signed cookie
    // WHEN the payload is tampered with (e.g. userId changed)
    // THEN verify returns null — the HMAC will not match.
    const secret = generateSessionSecret();
    const cookie = signSessionCookie(secret, sampleSession);
    const [payload, sig] = cookie.split(".");
    // Flip a character in the payload (decode → mutate → re-encode).
    const decoded = Buffer.from(payload ?? "", "base64url").toString("utf8");
    const tampered = decoded.replace('"userId":42', '"userId":99');
    const reencoded = Buffer.from(tampered, "utf8").toString("base64url");
    const tamperedCookie = `${reencoded}.${sig ?? ""}`;
    const verified = verifySessionCookie(secret, tamperedCookie);
    expect(verified).toBeNull();
  });

  it("verifySessionCookie returns null for a tampered signature", () => {
    // GIVEN a signed cookie
    // WHEN the signature is tampered with
    // THEN verify returns null.
    const secret = generateSessionSecret();
    const cookie = signSessionCookie(secret, sampleSession);
    const [payload, sig] = cookie.split(".");
    const badSig = (sig ?? "x").split("").reverse().join("") + "A";
    const verified = verifySessionCookie(secret, `${payload ?? ""}.${badSig}`);
    expect(verified).toBeNull();
  });

  it("verifySessionCookie returns null for a malformed cookie (no dot)", () => {
    const secret = generateSessionSecret();
    expect(verifySessionCookie(secret, "not-a-cookie")).toBeNull();
  });

  it("verifySessionCookie returns null for an empty cookie", () => {
    const secret = generateSessionSecret();
    expect(verifySessionCookie(secret, "")).toBeNull();
  });

  it("verifySessionCookie returns null when the payload is not valid JSON", () => {
    // GIVEN a cookie whose payload is not valid JSON
    // WHEN we verify it
    // THEN verify returns null (the cookie is rejected as
    //      malformed, not as a wrong-secret).
    const secret = generateSessionSecret();
    const payload = Buffer.from("not json", "utf8").toString("base64url");
    // Compute a real signature so the failure is on JSON, not on HMAC.
    const sig = createHmac("sha256", secret).update(payload).digest("base64url");
    const verified = verifySessionCookie(secret, `${payload}.${sig}`);
    expect(verified).toBeNull();
  });
});

describe("admin/session — CSRF verification", () => {
  it("verifyCsrfToken accepts a matching token (constant-time)", () => {
    const session = sampleSession;
    expect(verifyCsrfToken(session, session.csrfToken)).toBe(true);
  });

  it("verifyCsrfToken rejects a mismatched token", () => {
    expect(verifyCsrfToken(sampleSession, "wrong-token")).toBe(false);
  });

  it("verifyCsrfToken rejects an empty token", () => {
    expect(verifyCsrfToken(sampleSession, "")).toBe(false);
  });

  it("verifyCsrfToken rejects a token of different length (constant-time safe)", () => {
    // GIVEN a 22-char token in the session
    // WHEN we submit a 23-char token
    // THEN verify returns false.
    // The function MUST NOT short-circuit on length to preserve
    // constant-time semantics.
    const session: SessionData = { ...sampleSession, csrfToken: "a".repeat(22) };
    expect(verifyCsrfToken(session, "a".repeat(23))).toBe(false);
  });
});

describe("admin/session — cookie header", () => {
  it("buildSetCookieHeader includes HttpOnly + SameSite=Strict + Path=/", () => {
    // GIVEN a signed cookie value
    // WHEN we build the Set-Cookie header
    // THEN the value includes HttpOnly, SameSite=Strict, Path=/.
    //      Secure is added by the caller when not loopback.
    const cookieValue = "abc.def";
    const header = buildSetCookieHeader({
      name: SESSION_COOKIE_NAME,
      value: cookieValue,
      secure: false,
    });
    expect(header).toContain(`${SESSION_COOKIE_NAME}=${cookieValue}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    // No Secure flag when loopback.
    expect(header).not.toContain("Secure");
  });

  it("buildSetCookieHeader includes Secure when the caller signals non-loopback", () => {
    const header = buildSetCookieHeader({
      name: SESSION_COOKIE_NAME,
      value: "abc.def",
      secure: true,
    });
    expect(header).toContain("Secure");
  });

  it("the CSRF cookie name is distinct from the session cookie name", () => {
    // GIVEN the two cookie names
    // THEN they are different. The CSRF token could be sent as a
    //      non-HttpOnly cookie (read by JS) and the session is
    //      HttpOnly. They MUST be different names so the browser
    //      does not collapse them.
    expect(SESSION_COOKIE_NAME).not.toBe(CSRF_COOKIE_NAME);
  });
});

describe("admin/session — parseCookies", () => {
  it("parseCookies returns a map of cookie name → value", () => {
    const headers = new Headers();
    headers.append("Cookie", "a=1; b=2; c=hello%20world");
    const cookies = parseCookies(headers);
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("2");
    expect(cookies.get("c")).toBe("hello world");
  });

  it("parseCookies returns an empty map when no Cookie header is present", () => {
    const headers = new Headers();
    const cookies = parseCookies(headers);
    expect(cookies.size).toBe(0);
  });
});
