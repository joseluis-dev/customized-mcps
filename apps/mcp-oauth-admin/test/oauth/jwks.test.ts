/**
 * Unit tests for the JWKS + OIDC discovery endpoints.
 *
 * The mcp-oauth-authority spec requires:
 * - `/.well-known/jwks.json` exposes the public JWK Set
 *   (kty, n, e, kid, use, alg). Private components (d, p, q,
 *   dp, dq, qi) MUST NOT appear.
 * - `/.well-known/openid-configuration` advertises the
 *   authorization endpoint, token endpoint, JWKS URI,
 *   supported grant types (including `authorization_code`),
 *   `code_challenge_methods_supported: ["S256"]`, supported
 *   response types, and the issuer (= MCP_AUTHORITY_URL).
 * - The `authorization_endpoint` URL is
 *   `<issuer>/oauth/authorize` and the `code_challenge_methods_supported`
 *   array contains `"S256"` (the only PKCE method v1 accepts).
 *
 * Test layer: unit + integration. The JWKS endpoint is a
 * pure handler over the public-key store. We use a real
 * `node:http` listener on a random port for the
 * integration assertions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportJWK, calculateJwkThumbprint } from "jose";
import {
  createJwksHandler,
  createOidcDiscoveryHandler,
  createOAuthAuthorizationServerMetadataHandler,
} from "../../src/oauth/jwks.js";
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
    const oauthConfig = {
      issuer,
      allowedResources: ["https://mcp.example.com"],
    };
    const oidcHandler = createOidcDiscoveryHandler({ issuer, oauth: oauthConfig });
    const oauthMetadataHandler = createOAuthAuthorizationServerMetadataHandler({
      issuer,
      oauth: oauthConfig,
    });
    server = createServer((req, res) => {
      if (req.url === "/.well-known/jwks.json") return jwksHandler(req, res);
      if (req.url === "/.well-known/openid-configuration") return oidcHandler(req, res);
      if (req.url === "/.well-known/oauth-authorization-server") {
        return oauthMetadataHandler(req, res);
      }
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "not_found" }));
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
    // The spec advertises the authorization-code endpoint
    // in v1 (PR 2 of `unified-mcp-oauth-admin-auth`).
    // The URL is `<issuer>/oauth/authorize` so the
    // resource server's discovery handshake lands on
    // the same host:port as the issuer.
    expect(body["authorization_endpoint"]).toBe(`${body["issuer"]}/oauth/authorize`);
    // Supported grant types include the auth-code flow.
    const grantTypes = body["grant_types_supported"];
    expect(Array.isArray(grantTypes)).toBe(true);
    expect(grantTypes).toEqual(
      expect.arrayContaining(["client_credentials", "password", "refresh_token", "authorization_code"]),
    );
    // PKCE method advertised: S256 only (`plain` is
    // forbidden by OAuth 2.1 and the spec).
    const challengeMethods = body["code_challenge_methods_supported"];
    expect(Array.isArray(challengeMethods)).toBe(true);
    expect(challengeMethods).toEqual(["S256"]);
    // The supported response types are exactly `["code"]`
    // (the authorization-code + PKCE S256 flow). The
    // implicit `token` flow is out of scope and MUST NOT
    // be advertised; an OIDC client that requires `token`
    // would discover it does not apply here and fall back
    // to the standard code flow.
    const responseTypes = body["response_types_supported"];
    expect(Array.isArray(responseTypes)).toBe(true);
    expect(responseTypes).toEqual(["code"]);
    // Signing algs.
    const algs = body["id_token_signing_alg_values_supported"];
    expect(Array.isArray(algs)).toBe(true);
    expect(algs).toContain("RS256");
    // subject_types_supported: the authority issues stable
    // local subjects (e.g. `user:<agentId>`, `client:<id>`),
    // so the only advertised subject type is `public`. The
    // field is required by OIDC discovery consumers that
    // validate the schema (e.g. opencode's MCP auth flow).
    const subjectTypes = body["subject_types_supported"];
    expect(Array.isArray(subjectTypes)).toBe(true);
    expect(subjectTypes).toEqual(["public"]);
  });

  it("GET /.well-known/openid-configuration advertises the registration_endpoint (RFC 7591)", async () => {
    // The discovery doc MUST advertise the DCR
    // endpoint so OIDC clients (e.g. opencode) can
    // find it during the auth handshake. The
    // `registration_endpoint` field is a single
    // string with the absolute URL.
    const res = await fetch(`${baseUrl}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["registration_endpoint"]).toBe("string");
    expect(body["registration_endpoint"]).toBe(`${body["issuer"]}/oauth/register`);
  });

  it("GET /.well-known/openid-configuration advertises protected_resources (RFC 9728 §4)", async () => {
    // RFC 9728 §4: the authorization server metadata MAY
    // advertise the protected resources it serves. The
    // authority uses this field so a client that follows
    // the discovery chain (resource metadata → AS metadata)
    // can confirm the resource URIs it intends to access
    // are recognized by the AS.
    const res = await fetch(`${baseUrl}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const protectedResources = body["protected_resources"];
    expect(Array.isArray(protectedResources)).toBe(true);
    expect(protectedResources).toEqual(["https://mcp.example.com"]);
  });

  it("GET /.well-known/openid-configuration omits protected_resources when no allowlist is configured", async () => {
    // The field is OPTIONAL per RFC 9728 §4. An authority
    // with the OAuth wiring disabled (no allowlist) MUST
    // NOT advertise a stray empty array.
    const fallbackIssuer = "http://127.0.0.1:0";
    const noOauthHandler = createOidcDiscoveryHandler({ issuer: fallbackIssuer });
    const noOauthServer = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        return noOauthHandler(req, res);
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveP) =>
      noOauthServer.listen(0, "127.0.0.1", () => resolveP()),
    );
    try {
      const res = await fetch(
        `http://127.0.0.1:${(noOauthServer.address() as AddressInfo).port}/.well-known/openid-configuration`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["protected_resources"]).toBeUndefined();
    } finally {
      await new Promise<void>((resolveP, rejectP) => {
        noOauthServer.close((err) => (err ? rejectP(err) : resolveP()));
      });
    }
  });

  it("GET /.well-known/oauth-authorization-server returns the RFC 8414 metadata shape", async () => {
    // The MCP authorization spec requires support for both
    // the OIDC discovery endpoint and the RFC 8414
    // authorization server metadata endpoint. The body
    // shape is the same as openid-configuration minus the
    // OIDC-only fields (`subject_types_supported`,
    // `id_token_signing_alg_values_supported`).
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["issuer"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(body["token_endpoint"]).toBe(`${body["issuer"]}/oauth/token`);
    expect(body["authorization_endpoint"]).toBe(`${body["issuer"]}/oauth/authorize`);
    expect(body["jwks_uri"]).toBe(`${body["issuer"]}/.well-known/jwks.json`);
    expect(body["introspection_endpoint"]).toBe(`${body["issuer"]}/oauth/introspect`);
    expect(body["registration_endpoint"]).toBe(`${body["issuer"]}/oauth/register`);
    expect(body["grant_types_supported"]).toEqual(
      expect.arrayContaining(["authorization_code", "refresh_token"]),
    );
    expect(body["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(body["subject_types_supported"]).toBeUndefined();
    expect(body["id_token_signing_alg_values_supported"]).toBeUndefined();
    expect(body["protected_resources"]).toEqual(["https://mcp.example.com"]);
  });
});
