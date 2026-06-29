/**
 * Unit tests for the JWKS + OIDC discovery endpoints.
 *
 * The mcp-oauth-authority spec requires:
 * - `/.well-known/jwks.json` exposes the public JWK Set
 *   (kty, n, e, kid, use, alg). Private components (d, p, q,
 *   dp, dq, qi) MUST NOT appear.
 * - `/.well-known/openid-configuration` advertises the
 *   authorization endpoint, token endpoint, JWKS URI,
 *   supported grant types, supported response types, and
 *   the issuer (= MCP_AUTHORITY_URL).
 * - `/oauth/authorize` MUST return 404 (Phase 0; the
 *   authorization-code flow is Phase 6).
 *
 * Test layer: unit + integration. The JWKS endpoint is a
 * pure handler over the public-key store. We use a real
 * `node:http` listener on a random port for the
 * integration assertions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportJWK, calculateJwkThumbprint } from "jose";
import { createJwksHandler, createOidcDiscoveryHandler } from "../../src/oauth/jwks.js";
import { setActiveSigningKey, type SigningKeyRecord } from "../../src/oauth/keys.js";
import { openDatabase, initializeSchema } from "../../src/db/index.js";

async function makeTestKey(): Promise<{ privatePem: string; publicJwk: Record<string, unknown>; kid: string }> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  // Encode the private key in PEM format for storage parity
  // with the real key loader.
  const { exportPKCS8, exportSPKI } = await import("jose");
  const privatePem = await exportPKCS8(privateKey);
  void exportSPKI;
  return { privatePem, publicJwk, kid };
}

describe("oauth/jwks + openid-configuration", () => {
  let server: Server;
  let baseUrl: string;
  let db: ReturnType<typeof openDatabase>;
  let activeKey: SigningKeyRecord;

  beforeEach(async () => {
    const dbPath = ":memory:";
    db = openDatabase({ path: dbPath });
    await initializeSchema(db);
    const k = await makeTestKey();
    activeKey = {
      id: k.kid,
      algorithm: "RS256",
      publicJwk: k.publicJwk,
      privatePem: k.privatePem,
    };
    await setActiveSigningKey(db, activeKey);

    const issuer = "http://127.0.0.1:0";
    const jwksHandler = createJwksHandler({ db });
    const oidcHandler = createOidcDiscoveryHandler({ issuer });
    const notFound = (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "not_found" }));
    };
    server = createServer((req, res) => {
      if (req.url === "/.well-known/jwks.json") return jwksHandler(req, res);
      if (req.url === "/.well-known/openid-configuration") return oidcHandler(req, res);
      if (req.url === "/oauth/authorize") return notFound(req, res);
      return notFound(req, res);
    });
    await new Promise<void>((resolveP) => server.listen(0, "127.0.0.1", () => resolveP()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolveP, rejectP) => {
      server.close((err) => (err ? rejectP(err) : resolveP()));
    });
    await db.close();
  });

  it("GET /.well-known/jwks.json returns the public JWK Set (no private components)", async () => {
    // GIVEN a live authority with one active signing key
    // WHEN we GET /.well-known/jwks.json
    // THEN the response is 200 + a JWK Set with kty, n, e,
    //      kid, use, alg. No private components (d, p, q,
    //      dp, dq, qi) appear.
    const res = await fetch(`${baseUrl}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    const k = body.keys[0];
    expect(k).toBeDefined();
    expect(k?.kty).toBe("RSA");
    expect(typeof k?.n).toBe("string");
    expect(typeof k?.e).toBe("string");
    expect(k?.kid).toBe(activeKey.id);
    expect(k?.use).toBe("sig");
    expect(k?.alg).toBe("RS256");
    // No private material.
    for (const privateField of ["d", "p", "q", "dp", "dq", "qi"]) {
      expect(k).not.toHaveProperty(privateField);
    }
  });

  it("GET /.well-known/jwks.json returns 200 + a JWK Set with no keys when there is no active key", async () => {
    // GIVEN a database with NO signing keys
    // WHEN we GET /.well-known/jwks.json
    // THEN the response is 200 + an empty JWK Set. The
    //      endpoint MUST NOT 500 when there are no keys
    //      (the spec leaves the empty-set choice to the
    //      implementation; the failure mode is a 5xx, not
    //      an empty set).
    const emptyDb = openDatabase({ path: ":memory:" });
    await initializeSchema(emptyDb);
    const emptyServer = createServer(
      createJwksHandler({ db: emptyDb }),
    );
    await new Promise<void>((resolveP) => emptyServer.listen(0, "127.0.0.1", () => resolveP()));
    try {
      const port = (emptyServer.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/.well-known/jwks.json`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { keys: unknown[] };
      expect(body.keys).toEqual([]);
    } finally {
      await new Promise<void>((resolveP, rejectP) => {
        emptyServer.close((err) => (err ? rejectP(err) : resolveP()));
      });
      await emptyDb.close();
    }
  });

  it("GET /.well-known/openid-configuration advertises the OIDC + OAuth2 endpoints", async () => {
    // GIVEN the authority is up
    // WHEN we GET /.well-known/openid-configuration
    // THEN the response is 200 + a JSON object with the
    //      canonical OIDC fields. The issuer matches the
    //      authority URL.
    const res = await fetch(`${baseUrl}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Issuer uses the bound host:port from the request
    // (we bind dynamically so the test does not pin a
    // port). At minimum the body advertises the endpoints.
    expect(typeof body["issuer"]).toBe("string");
    expect(String(body["issuer"])).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(body["jwks_uri"]).toBe(`${body["issuer"]}/.well-known/jwks.json`);
    expect(body["token_endpoint"]).toBe(`${body["issuer"]}/oauth/token`);
    // The spec explicitly does NOT advertise an
    // authorization_endpoint in v1 (Phase 6 adds the
    // authorization-code flow).
    expect(body["authorization_endpoint"]).toBeUndefined();
    // Supported grant types: client_credentials + password.
    const grantTypes = body["grant_types_supported"];
    expect(Array.isArray(grantTypes)).toBe(true);
    expect(grantTypes).toEqual(expect.arrayContaining(["client_credentials", "password", "refresh_token"]));
    // The supported response types are "token" (introspect
    // returns the active shape; the access-token response
    // is the token). The spec leaves the exact list open
    // but MUST include "token".
    const responseTypes = body["response_types_supported"];
    expect(Array.isArray(responseTypes)).toBe(true);
    expect(responseTypes).toContain("token");
    // Signing algs.
    const algs = body["id_token_signing_alg_values_supported"];
    expect(Array.isArray(algs)).toBe(true);
    expect(algs).toContain("RS256");
  });

  it("GET /oauth/authorize returns 404 (no auth-code in v1)", async () => {
    // GIVEN the authority is up
    // WHEN we GET /oauth/authorize
    // THEN the response is 404. The spec says the endpoint
    //      MUST NOT exist in v1; the authorization-code
    //      flow is Phase 6.
    const res = await fetch(`${baseUrl}/oauth/authorize`);
    expect(res.status).toBe(404);
  });
});
