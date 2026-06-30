/**
 * Strict-TDD tests for the `scopes: []` contract on `JwksAuthority.verify`.
 *
 * Context: the `remove-scope-authorization` SDD change (PR 1) makes scope
 * authorization inert. The resource server MUST ignore any `scopes` claim
 * on the inbound JWT and return `{ agentId, scopes: [] }` for every valid
 * token. This is the new contract; the previous contract (filter against
 * `SCOPE_PATTERN` and return the kept entries) is removed.
 *
 * What this file asserts (per the mcp-token-authority + mcp-agent-authorization
 * delta specs):
 *
 * 1. A valid JWT whose `scopes` claim is an array of "valid" pattern values
 *    (e.g. `["read:bi_catastro", "list:reporting"]`) MUST resolve to
 *    `{ agentId, scopes: [] }` — the inbound claim is ignored.
 * 2. A valid JWT whose `scopes` claim is a space-delimited string MUST
 *    resolve to `scopes: []` — the string form is also ignored.
 * 3. A valid JWT whose `scopes` claim is a mix of valid + malformed values
 *    MUST resolve to `scopes: []` — no per-entry filtering is performed.
 * 4. A valid JWT with NO `scopes` claim MUST resolve to `scopes: []` —
 *    this is the absent-claim case.
 * 5. The `scopes` claim value is NEVER logged at any level. Operators
 *    MUST NOT see the inbound scope strings in a WARN/INFO/ERROR line.
 * 6. The `verify` result does NOT echo the inbound `scopes` claim value
 *    in any form (no identity, no length, no first element).
 *
 * Approach:
 * - The crypto path is real: `jose` produces a key pair and a signed JWT.
 * - The JWKS endpoint is a real `http.createServer`. We do not stub
 *   jose's `getKey` because the test must prove the resource-server-side
 *   contract, not the underlying crypto.
 * - Each scenario signs a JWT with a deliberately different `scopes` claim
 *   shape so the assertion proves the contract against a SPECIFIC value,
 *   not just "any input that the function happened to drop".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportJWK, SignJWT, calculateJwkThumbprint } from "jose";
import { JwksAuthority, type JwksAuthorityOptions } from "../../src/authority/jwks.js";
import type { Logger } from "../../src/logging.js";

function silentLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (msg) => lines.push(`info: ${String(msg)}`),
      warn: (msg) => lines.push(`warn: ${String(msg)}`),
      error: (msg) => lines.push(`error: ${String(msg)}`),
    },
  };
}

const ISSUER = "https://auth.example.com";
const AUDIENCE = "mcp-readonly-sql";

function baseOptions(overrides: Partial<JwksAuthorityOptions> = {}): JwksAuthorityOptions {
  return {
    issuer: ISSUER,
    jwksUrl: "http://127.0.0.1:0/jwks.json",
    audience: AUDIENCE,
    ttlSeconds: 60,
    leewaySeconds: 30,
    fetchTimeoutMs: 5000,
    logger: silentLogger(),
    ...overrides,
  };
}

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

async function startJwksHarness(publicJwk: Record<string, unknown>): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/jwks.json`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Build a signed JWT with an arbitrary `scopes` claim shape.
 *
 * The `scopesClaim` parameter is set verbatim on the JWT payload:
 *  - `undefined`  → no `scopes` field is added at all.
 *  - `string`     → a single space-delimited string claim (OAuth2 convention).
 *  - `string[]`   → a JSON array claim.
 *  - other values are passed through as-is.
 */
async function signJwtWithScopes(
  privateKey: CryptoKey,
  kid: string,
  scopesClaim: unknown,
  sub: string = "agent-scope-test",
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { sub };
  if (scopesClaim !== undefined) {
    payload.scopes = scopesClaim;
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

describe("JwksAuthority.verify — scopes: [] contract (PR 1 task 1.1)", () => {
  let key: TestKeyMaterial;

  beforeEach(async () => {
    key = await makeTestKey();
  });

  it("returns scopes: [] when the JWT carries an array of well-formed scopes (the claim is ignored)", async () => {
    // GIVEN a JWT with a `scopes` claim containing two values that
    //      WOULD have matched SCOPE_PATTERN in the old contract
    // WHEN verify is called
    // THEN the resolved identity has agentId = sub AND
    //      scopes is exactly [] (NOT the inbound array, NOT a subset)
    const harness = await startJwksHarness(key.publicJwk);
    try {
      const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
      const token = await signJwtWithScopes(key.privateKey, key.kid, [
        "read:bi_catastro",
        "list:reporting",
      ]);
      const result = await auth.verify(token);
      // The contract: scopes is exactly the empty array, regardless of
      // the inbound claim. The test asserts the EXACT value (toEqual),
      // not just length — so a future regression that returns a
      // frozen or proxy array still fails this test.
      expect(result.scopes).toEqual([]);
      expect(result.agentId).toBe("agent-scope-test");
      // Additional guard: the result must not echo the inbound values
      // in any form.
      expect(result.scopes).not.toContain("read:bi_catastro");
      expect(result.scopes).not.toContain("list:reporting");
      expect(result.scopes).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("returns scopes: [] when the JWT carries a space-delimited string scope claim", async () => {
    // GIVEN a JWT with the OAuth2-convention string form of the
    //      `scopes` claim (space-delimited)
    // WHEN verify is called
    // THEN the resolved scopes is []
    const harness = await startJwksHarness(key.publicJwk);
    try {
      const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
      const token = await signJwtWithScopes(
        key.privateKey,
        key.kid,
        "read:bi_catastro list:reporting",
      );
      const result = await auth.verify(token);
      expect(result.scopes).toEqual([]);
      expect(result.agentId).toBe("agent-scope-test");
    } finally {
      await harness.close();
    }
  });

  it("returns scopes: [] when the JWT carries a mix of valid and invalid scope values (no per-entry filter)", async () => {
    // GIVEN a JWT with a `scopes` claim that mixes values which would
    //      have matched SCOPE_PATTERN with values that would not
    // WHEN verify is called
    // THEN the resolved scopes is [] (no filtering happens — the
    //      whole claim is dropped, not per-entry)
    const harness = await startJwksHarness(key.publicJwk);
    try {
      const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
      const token = await signJwtWithScopes(key.privateKey, key.kid, [
        "read:bi_catastro",
        "delete:foo",
        "list:reporting",
        "no-verb",
      ]);
      const result = await auth.verify(token);
      expect(result.scopes).toEqual([]);
      // The values that would have been KEPT under the old filter
      // contract are NOT in the result. The values that would have
      // been DROPPED are also NOT in the result. The whole claim
      // is dropped.
      expect(result.scopes).not.toContain("read:bi_catastro");
      expect(result.scopes).not.toContain("delete:foo");
    } finally {
      await harness.close();
    }
  });

  it("returns scopes: [] when the JWT has no scopes claim at all", async () => {
    // GIVEN a JWT with NO `scopes` claim
    // WHEN verify is called
    // THEN the resolved scopes is []
    const harness = await startJwksHarness(key.publicJwk);
    try {
      const auth = new JwksAuthority(baseOptions({ jwksUrl: harness.url }));
      const token = await signJwtWithScopes(key.privateKey, key.kid, undefined);
      const result = await auth.verify(token);
      expect(result.scopes).toEqual([]);
      expect(result.agentId).toBe("agent-scope-test");
    } finally {
      await harness.close();
    }
  });

  it("emits no scope-related WARN/INFO/ERROR when the inbound scopes claim has invalid entries (no scope filtering log line)", async () => {
    // GIVEN a JWT with a `scopes` claim containing values that the
    //      old contract would have rejected and logged at WARN
    // WHEN verify is called
    // THEN the captured logger does NOT receive a line about dropped
    //      scopes, invalid scopes, or scope-pattern mismatches.
    //      The audit-safe default is silent on the ignore path.
    const harness = await startJwksHarness(key.publicJwk);
    try {
      const { logger, lines } = capturingLogger();
      const auth = new JwksAuthority(
        baseOptions({ jwksUrl: harness.url, logger }),
      );
      const token = await signJwtWithScopes(key.privateKey, key.kid, [
        "read:bi_catastro",
        "delete:foo",
        "another-bad",
      ]);
      await auth.verify(token);
      const joined = lines.join("\n");
      // The contract: the inbound claim is silently ignored. No line
      // should talk about "dropped" or "invalid" or "mismatch" with
      // respect to scope filtering.
      const scopeFilterLine = lines.find((line) =>
        /scope/i.test(line) &&
        /dropped|invalid|pattern|mismatch|reject/i.test(line),
      );
      expect(scopeFilterLine).toBeUndefined();
      // Belt-and-suspenders: the inbound scope values MUST NOT appear
      // in any log line (the audit-safe redaction contract).
      expect(joined).not.toContain("delete:foo");
      expect(joined).not.toContain("another-bad");
      expect(joined).not.toContain("read:bi_catastro");
    } finally {
      await harness.close();
    }
  });

  it("emits no scope-related log line on the happy path either (silent ignore is the new default)", async () => {
    // GIVEN a JWT with all-"valid" scopes (under the old pattern)
    // WHEN verify is called
    // THEN no scope-related log line is emitted
    // The ignore path is silent regardless of the inbound shape.
    const harness = await startJwksHarness(key.publicJwk);
    try {
      const { logger, lines } = capturingLogger();
      const auth = new JwksAuthority(
        baseOptions({ jwksUrl: harness.url, logger }),
      );
      const token = await signJwtWithScopes(key.privateKey, key.kid, [
        "read:bi_catastro",
        "list:*",
      ]);
      await auth.verify(token);
      const scopeLine = lines.find((line) => /scope/i.test(line));
      expect(scopeLine).toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});
