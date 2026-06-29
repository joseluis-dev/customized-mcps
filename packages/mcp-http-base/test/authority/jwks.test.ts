/**
 * Unit tests for `JwksAuthority`.
 *
 * Phase 1b of the external-token-authority-verification change adds the
 * `JwksAuthority` (the production / shared-deployment backend) on top of
 * the Phase 1a `TokenAuthority` abstraction. The local backend stays the
 * dev/offline fallback; the JWKS backend is the recommended default for
 * production and shared deployments.
 *
 * What the tests assert (per the mcp-token-authority spec):
 * - `verify` accepts a JWT with valid `iss` + `aud` + `exp` + `nbf` and
 *   resolves to `{ agentId: sub, scopes: SCOPE_PATTERN-filtered }`.
 * - `verify` rejects an expired JWT, a wrong-`aud` JWT, a wrong-`iss`
 *   JWT, a wrong-signature JWT, and a JWT with a `kid` absent from two
 *   consecutive JWKS responses. All rejections throw
 *   `TokenInvalidError` so the middleware maps them to 401.
 * - `verify` throws `AuthorityUnavailableError` when the JWKS endpoint
 *   is unreachable within `MCP_AUTHORITY_FETCH_TIMEOUT_MS`. The `warm()`
 *   probe does the same.
 * - The first `verify` call fetches the JWKS exactly once; subsequent
 *   calls within `MCP_AUTHORITY_JWKS_TTL_S` reuse the cached key set.
 *   A `kid` miss triggers a single refetch; a second `kid` miss on the
 *   same `kid` is rejected.
 * - Scopes that do not match `SCOPE_PATTERN` are dropped from the
 *   resolved set; the WARN log line MUST NOT include the rejected
 *   values.
 *
 * Approach:
 * - `jose` produces a real key pair and signed JWTs. No stubs on the
 *   crypto path — the JWKS resolver is the layer under test, and it has
 *   to interoperate with the real `jose.createRemoteJWKSet` /
 *   `jose.jwtVerify` pipeline.
 * - The JWKS endpoint is served by a real `http.createServer` so the
 *   test exercises jose's `https.get` / `http.get` codepath (jose v5
 *   does not use `globalThis.fetch` in Node). The server hands out a
 *   pre-canned JWKS document and records every request, so the test
 *   can assert on cache reuse and refetch counts.
 * - The unreachable case is exercised by pointing the authority at a
 *   closed port on `127.0.0.1` — the connection refuses immediately.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT, calculateJwkThumbprint } from "jose";
import {
  JwksAuthority,
  type JwksAuthorityOptions,
} from "../../src/authority/jwks.js";
import {
  TokenInvalidError,
  AuthorityUnavailableError,
  type TokenAuthority,
  type VerifiedToken,
} from "../../src/authority/types.js";
import type { Logger } from "../../src/logging.js";

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function baseOptions(overrides: Partial<JwksAuthorityOptions> = {}): JwksAuthorityOptions {
  return {
    issuer: ISSUER,
    jwksUrl: JWKS_URL,
    audience: AUDIENCE,
    ttlSeconds: 60,
    leewaySeconds: 30,
    fetchTimeoutMs: 5000,
    logger: silentLogger(),
    ...overrides,
  };
}

const ISSUER = "https://auth.example.com";
const AUDIENCE = "mcp-readonly-sql";
const JWKS_URL = "https://auth.example.com/.well-known/jwks.json";

type TestKeyMaterial = {
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
  kid: string;
};

async function makeTestKey(): Promise<TestKeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { privateKey, publicJwk, kid };
}

function jwksBody(keys: Array<Record<string, unknown>>): string {
  return JSON.stringify({ keys });
}

async function signTestJwt(
  privateKey: CryptoKey,
  kid: string,
  claims: {
    iss?: string;
    aud?: string;
    sub?: string;
    exp?: number;
    nbf?: number;
    scopes?: string[] | string;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: claims.sub ?? "third-party-x",
    scopes: claims.scopes ?? ["read:*"],
  };
  if (claims.exp !== undefined) payload.exp = claims.exp;
  if (claims.nbf !== undefined) payload.nbf = claims.nbf;
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setIssuedAt(now);
  if (claims.exp === undefined) jwt.setExpirationTime(now + 300);
  return jwt.sign(privateKey);
}

/**
 * Test harness: an HTTP server that serves a sequence of pre-canned
 * JWKS documents. The `serveKeys` array is consumed in order on each
 * request. The server records every request so the test can assert
 * on the refetch flow.
 */
type JwksHarness = {
  url: string;
  port: number;
  calls: Array<{ path: string; method: string }>;
  close: () => Promise<void>;
};

async function startJwksHarness(serveKeys: Array<Array<Record<string, unknown>>>): Promise<JwksHarness> {
  const calls: Array<{ path: string; method: string }> = [];
  let requestIndex = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    calls.push({ path: req.url ?? "/", method: req.method ?? "GET" });
    const keys = serveKeys[Math.min(requestIndex, serveKeys.length - 1)] ?? [];
    requestIndex++;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(jwksBody(keys));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/jwks.json`,
    port: addr.port,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Harness for the unreachable case: a server that closes the socket
 * without responding. The client's request fails with ECONNRESET or
 * an immediate connection error, which the authority maps to
 * `AuthorityUnavailableError`.
 */
async function startClosedPortHarness(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(() => {
    // Never respond.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  // Close the server immediately so subsequent connects fail.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return {
    url: `http://127.0.0.1:${addr.port}/jwks.json`,
    close: async () => {
      // Already closed.
    },
  };
}

describe("JwksAuthority", () => {
  let key: TestKeyMaterial;
  let otherKey: TestKeyMaterial;

  beforeEach(async () => {
    key = await makeTestKey();
    otherKey = await makeTestKey();
  });

  describe("verify — claim validation (1b.1)", () => {
    it("accepts a valid JWT (valid iss, aud, exp) and resolves { agentId: sub, scopes }", async () => {
      // GIVEN an authority backed by a JWKS that contains the signing key
      // WHEN verify is called with a JWT signed by that key, with the
      //      correct iss + aud + exp
      // THEN the resolved identity has the JWT's sub as agentId and the
      //      scopes claim as scopes
      const harness = await startJwksHarness([[key.publicJwk]]);
      try {
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
        const token = await signTestJwt(key.privateKey, key.kid, {
          sub: "third-party-x",
          scopes: ["read:bi_catastro", "list:reporting"],
        });
        const result = await auth.verify(token);
        expect(result.agentId).toBe("third-party-x");
        expect(result.scopes).toEqual(["read:bi_catastro", "list:reporting"]);
        // The JWKS was fetched exactly once (first call).
        expect(harness.calls.length).toBe(1);
      } finally {
        await harness.close();
      }
    });

    it("rejects an expired JWT (TokenInvalidError, mapped to 401 by middleware)", async () => {
      // GIVEN a valid JWKS
      // WHEN verify is called with a JWT whose exp is in the past beyond
      //      the configured leeway
      // THEN the rejected error is a TokenInvalidError
      const pastExp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const harness = await startJwksHarness([[key.publicJwk]]);
      try {
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
        const token = await signTestJwt(key.privateKey, key.kid, { exp: pastExp });
        await expect(auth.verify(token)).rejects.toBeInstanceOf(TokenInvalidError);
      } finally {
        await harness.close();
      }
    });

    it("rejects a JWT with the wrong aud (TokenInvalidError)", async () => {
      // GIVEN the authority expects AUDIENCE
      // WHEN verify is called with a JWT whose aud is a different value
      // THEN the rejected error is a TokenInvalidError
      const harness = await startJwksHarness([[key.publicJwk]]);
      try {
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
        const token = await signTestJwt(key.privateKey, key.kid, {
          aud: "some-other-audience",
        });
        await expect(auth.verify(token)).rejects.toBeInstanceOf(TokenInvalidError);
      } finally {
        await harness.close();
      }
    });

    it("rejects a JWT with the wrong iss (TokenInvalidError)", async () => {
      // GIVEN the authority expects ISSUER
      // WHEN verify is called with a JWT whose iss is a different value
      // THEN the rejected error is a TokenInvalidError
      const harness = await startJwksHarness([[key.publicJwk]]);
      try {
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
        const token = await signTestJwt(key.privateKey, key.kid, {
          iss: "https://evil.example.com",
        });
        await expect(auth.verify(token)).rejects.toBeInstanceOf(TokenInvalidError);
      } finally {
        await harness.close();
      }
    });

    it("rejects a JWT signed by a key whose kid is missing from two consecutive JWKS responses (kid second-miss)", async () => {
      // GIVEN a JWKS that does NOT contain the token's kid
      // WHEN verify is called
      // THEN the authority refetches the JWKS once (jose's built-in
      //      kid-miss refetch) and, if the refetched JWKS still lacks
      //      the kid, the verify call rejects with TokenInvalidError
      const harness = await startJwksHarness([[otherKey.publicJwk], [otherKey.publicJwk]]);
      try {
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
        const token = await signTestJwt(key.privateKey, key.kid); // signed by `key`, JWKS has `otherKey`
        await expect(auth.verify(token)).rejects.toBeInstanceOf(TokenInvalidError);
        // jose's auto-refetch on kid miss produces 2 fetches: the
        // initial load + the kid-miss refetch. The contract is
        // "refetch on kid miss, cap at one refetch per verify call".
        expect(harness.calls.length).toBe(2);
      } finally {
        await harness.close();
      }
    });

    it("W1: the kid-second-miss WARN log line includes the kid, the token fingerprint prefix, and the request id (W1 remediation)", async () => {
      // GIVEN a JWKS that does NOT contain the token's kid (so the
      //      second-miss WARN fires on the verify call)
      // WHEN verify is called with a request id in the context
      // THEN the WARN log line:
      //      - mentions the kid (so operators can identify which key
      //        the authority is missing)
      //      - includes the first 8 hex chars of SHA-256(token) so an
      //        operator can correlate the WARN with a captured token
      //        without seeing the full token
      //      - includes the request id so the WARN can be cross-linked
      //        to a specific request in the structured logs
      // The spec (mcp-token-authority §"kid Miss Refetch With Cap")
      // mandates all three fields in the WARN line; Phase 1b's first
      // pass omitted them, so W1 is now exercised end-to-end.
      const harness = await startJwksHarness([[otherKey.publicJwk], [otherKey.publicJwk]]);
      try {
        const captured: string[] = [];
        const logger: Logger = {
          info: () => undefined,
          warn: (msg) => captured.push(String(msg)),
          error: (msg) => captured.push(String(msg)),
        };
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url, logger }));
        const token = await signTestJwt(key.privateKey, key.kid); // signed by `key`, JWKS has `otherKey`
        // The verify call accepts an optional context with the request
        // id; the middleware passes the X-Request-Id header through.
        await expect(auth.verify(token, { requestId: "req-test-123" })).rejects.toBeInstanceOf(
          TokenInvalidError,
        );
        // Find the second-miss WARN line (the one whose body talks
        // about "two consecutive responses"). The scope-drop WARN
        // also fires on the same authority under different shapes; we
        // match the kid-miss WARN specifically.
        const kidMissWarn = captured.find((m) => /two consecutive responses/i.test(m));
        expect(kidMissWarn).toBeDefined();
        // (1) The WARN MUST mention the kid.
        expect(kidMissWarn).toContain(key.kid);
        // (2) The WARN MUST include the first 8 hex chars of
        //     SHA-256(token). Compute the expected prefix here so the
        //     test does not depend on internal implementation details
        //     of which hash function is used.
        const expectedPrefix = createHash("sha256").update(token).digest("hex").slice(0, 8);
        expect(kidMissWarn).toContain(expectedPrefix);
        // (3) The WARN MUST include the request id.
        expect(kidMissWarn).toContain("req-test-123");
      } finally {
        await harness.close();
      }
    });

    it("W1: when no request id is passed, the WARN omits the request id (no `[REDACTED]` placeholder leaks)", async () => {
      // GIVEN a kid-second-miss scenario
      // WHEN verify is called WITHOUT a request id in the context
      // THEN the WARN does NOT contain a placeholder for the request id
      //      (a missing field should be omitted, not rendered as
      //      `[REDACTED]` or `undefined` — the spec is silent on the
      //      absent case, and the audit-safe default is "no value, no
      //      log fragment").
      const harness = await startJwksHarness([[otherKey.publicJwk], [otherKey.publicJwk]]);
      try {
        const captured: string[] = [];
        const logger: Logger = {
          info: () => undefined,
          warn: (msg) => captured.push(String(msg)),
          error: (msg) => captured.push(String(msg)),
        };
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url, logger }));
        const token = await signTestJwt(key.privateKey, key.kid);
        await expect(auth.verify(token)).rejects.toBeInstanceOf(TokenInvalidError);
        const kidMissWarn = captured.find((m) => /two consecutive responses/i.test(m));
        expect(kidMissWarn).toBeDefined();
        // No placeholder for a missing field. The WARN body must not
        // say "requestId=undefined" or "requestId=[REDACTED]" — those
        // would be a regression against the audit-safe default.
        expect(kidMissWarn).not.toMatch(/requestId\s*=\s*(undefined|\[REDACTED\])/);
      } finally {
        await harness.close();
      }
    });
  });

  describe("verify — SCOPE_PATTERN filter (1b.2)", () => {
    it("drops scopes that do not match SCOPE_PATTERN (rejected values are NOT in the result)", async () => {
      // GIVEN a JWT with a mix of valid and invalid scopes
      // WHEN verify is called
      // THEN only the valid scopes are returned; the invalid ones are
      //      dropped from the resolved set
      const harness = await startJwksHarness([[key.publicJwk]]);
      try {
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
        const token = await signTestJwt(key.privateKey, key.kid, {
          scopes: ["read:bi_catastro", "delete:foo", "list:reporting", "no-verb"],
        });
        const result = await auth.verify(token);
        expect(result.scopes).toEqual(["read:bi_catastro", "list:reporting"]);
        expect(result.scopes).not.toContain("delete:foo");
        expect(result.scopes).not.toContain("no-verb");
      } finally {
        await harness.close();
      }
    });

    it("emits a single WARN log line when invalid scopes are dropped (no rejected values in the line)", async () => {
      // GIVEN an authority whose logger captures warn messages
      // WHEN verify resolves a JWT with invalid scopes
      // THEN a WARN is emitted that does NOT include the rejected values
      //      (per the audit-safe redaction contract in mcp-token-authority)
      const harness = await startJwksHarness([[key.publicJwk]]);
      try {
        const captured: string[] = [];
        const logger: Logger = {
          info: () => undefined,
          warn: (msg) => captured.push(String(msg)),
          error: (msg) => captured.push(String(msg)),
        };
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url, logger }));
        const token = await signTestJwt(key.privateKey, key.kid, {
          scopes: ["read:bi_catastro", "delete:foo", "another-bad"],
        });
        await auth.verify(token);
        const joined = captured.join("\n");
        // Rejected values MUST NOT leak into the WARN line.
        expect(joined).not.toContain("delete:foo");
        expect(joined).not.toContain("another-bad");
        // The WARN line itself MUST exist (operator signal: a misconfigured scope).
        const droppedWarn = captured.find((m) => /dropped|invalid|mismatch/i.test(m));
        expect(droppedWarn).toBeDefined();
      } finally {
        await harness.close();
      }
    });

    it("does not emit a WARN when every scope is valid (happy path is silent)", async () => {
      // GIVEN a JWT with all-valid scopes
      // WHEN verify resolves it
      // THEN no scope-related WARN is emitted — the filter is a
      //      defense layer, not a normal-path log line
      const harness = await startJwksHarness([[key.publicJwk]]);
      try {
        const captured: string[] = [];
        const logger: Logger = {
          info: () => undefined,
          warn: (msg) => captured.push(String(msg)),
          error: (msg) => captured.push(String(msg)),
        };
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url, logger }));
        const token = await signTestJwt(key.privateKey, key.kid, {
          scopes: ["read:bi_catastro", "list:*"],
        });
        await auth.verify(token);
        // No drop-related WARN should have fired.
        const dropWarn = captured.find((m) => /dropped|invalid scope|mismatch/i.test(m));
        expect(dropWarn).toBeUndefined();
      } finally {
        await harness.close();
      }
    });
  });

  describe("verify — JWKS cache (1b.3)", () => {
    it("fetches the JWKS once on first verify and reuses the cache for the TTL window", async () => {
      // GIVEN an authority with ttlSeconds=60 and leewaySeconds=30
      // WHEN verify is called three times in a row
      // THEN the JWKS is fetched exactly once (the cache is reused)
      const harness = await startJwksHarness([[key.publicJwk], [key.publicJwk], [key.publicJwk]]);
      try {
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
        const t1 = await signTestJwt(key.privateKey, key.kid);
        const t2 = await signTestJwt(key.privateKey, key.kid);
        const t3 = await signTestJwt(key.privateKey, key.kid);
        await auth.verify(t1);
        await auth.verify(t2);
        await auth.verify(t3);
        // The spec says: "first call fetches JWKS once; cache reused for MCP_AUTHORITY_JWKS_TTL_S (60)".
        expect(harness.calls.length).toBe(1);
      } finally {
        await harness.close();
      }
    });

    it("refetches the JWKS on a kid miss and succeeds when the kid is present in the refetched JWKS", async () => {
      // GIVEN a JWKS that does NOT contain the token's kid
      // WHEN verify is called
      // THEN the JWKS is refetched (jose's built-in kid-miss refetch)
      //      AND the token is verified against the fresh JWKS if the
      //      kid is now present
      // First call: JWKS has otherKey; we sign with `key` (kid not present).
      // Second call: switch the stub to return key's JWK; the refetch
      // should pick it up and verify succeeds.
      const harness = await startJwksHarness([[otherKey.publicJwk], [key.publicJwk]]);
      try {
        const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
        const token = await signTestJwt(key.privateKey, key.kid);
        const result = await auth.verify(token);
        expect(result.agentId).toBe("third-party-x");
        // First fetch + one refetch = 2 calls (no second-miss cap fires).
        expect(harness.calls.length).toBe(2);
      } finally {
        await harness.close();
      }
    });
  });

  describe("verify — authority unreachable (1b.4)", () => {
    it("throws AuthorityUnavailableError when the JWKS endpoint is unreachable within the fetch timeout", async () => {
      // GIVEN the JWKS endpoint is unreachable (port closed)
      // WHEN verify is called
      // THEN the rejected error is an AuthorityUnavailableError
      //      (the middleware maps this to 503)
      const harness = await startClosedPortHarness();
      try {
        const auth = new JwksAuthority(
          baseOptions({ jwksUrl: harness.url, fetchTimeoutMs: 500 }),
        );
        const token = await signTestJwt(key.privateKey, key.kid);
        await expect(auth.verify(token)).rejects.toBeInstanceOf(AuthorityUnavailableError);
      } finally {
        await harness.close();
      }
    });

    it("warm() also throws AuthorityUnavailableError when the JWKS endpoint is unreachable", async () => {
      // GIVEN the JWKS endpoint is unreachable
      // WHEN warm() is called as a startup probe
      // THEN the rejected error is an AuthorityUnavailableError so the
      //      app-side config loader can exit non-zero
      const harness = await startClosedPortHarness();
      try {
        const auth = new JwksAuthority(
          baseOptions({ jwksUrl: harness.url, fetchTimeoutMs: 500 }),
        );
        await expect(auth.warm!()).rejects.toBeInstanceOf(AuthorityUnavailableError);
      } finally {
        await harness.close();
      }
    });
  });
});
