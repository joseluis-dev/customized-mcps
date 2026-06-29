/**
 * Unit + integration tests for the RS256 access-token signer
 * and the OAuth2 token endpoint.
 *
 * The mcp-oauth-authority spec requires:
 * - Access tokens are RS256-signed JWTs.
 * - Claims: `iss` (the authority URL), `aud` (= `mcp:<app>`),
 *   `sub` (the agent id), `scope` (space-delimited), `iat`,
 *   `nbf`, `exp`, `kid` in the header.
 * - TTL: 3600 seconds (1 hour).
 * - Token endpoint supports `client_credentials` and
 *   `password` grants. `refresh_token` is supported in v1
 *   (the spec lists it in `grant_types_supported`); the
 *   refresh grant rejects tokens with a non-null
 *   `revokedAt` (Phase 1/2 wiring).
 * - New agents/clients default to `read:<bound-profile>`
 *   (the spec's default-scope assignment). A request that
 *   mixes `*` with a specific scope is rejected with
 *   `400 invalid_scope`.
 *
 * Test layer: integration. We mount the token handler on a
 * real `node:http` listener and POST to it. The signer is
 * the production code; we verify the issued JWT with a real
 * `jwtVerify` against the same signing key.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportJWK, exportPKCS8, calculateJwkThumbprint, jwtVerify, importPKCS8 } from "jose";
import { createHmac } from "node:crypto";
import { createHash } from "node:crypto";
import { openDatabase, initializeSchema, withSingleWriter } from "../../src/db/index.js";
import { createTokenHandler, type TokenHandlerDeps } from "../../src/oauth/token.js";
import { createIntrospectHandler } from "../../src/oauth/introspect.js";
import { setActiveSigningKey, type SigningKeyRecord } from "../../src/oauth/keys.js";
import { hashPassword, verifyPassword } from "../../src/oauth/passwords.js";

async function makeTestKey(): Promise<SigningKeyRecord> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const privatePem = await exportPKCS8(privateKey);
  return { id: kid, algorithm: "RS256", publicJwk, privatePem };
}

async function makeArgonHash(plain: string): Promise<string> {
  return hashPassword(plain);
}

async function setupApp(opts: {
  audience: string;
  issuer: string;
  defaultScope: string;
}): Promise<{ baseUrl: string; db: ReturnType<typeof openDatabase>; key: SigningKeyRecord; server: Server }> {
  const db = openDatabase({ path: ":memory:" });
  await initializeSchema(db);
  const key = await makeTestKey();
  await setActiveSigningKey(db, key);

  const deps: TokenHandlerDeps = {
    db,
    issuer: opts.issuer,
    audience: opts.audience,
    defaultScope: opts.defaultScope,
    accessTokenTtlSeconds: 3600,
    activeKey: key,
  };
  const tokenHandler = createTokenHandler(deps);
  const introspectHandler = createIntrospectHandler(deps);
  const server = createServer((req, res) => {
    if (req.url === "/oauth/token" && req.method === "POST") {
      return tokenHandler(req, res);
    }
    if (req.url === "/oauth/introspect" && req.method === "POST") {
      return introspectHandler(req, res);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolveP) => server.listen(0, "127.0.0.1", () => resolveP()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { baseUrl, db, key, server };
}

async function teardownApp(ctx: { db: ReturnType<typeof openDatabase>; server: Server }): Promise<void> {
  await new Promise<void>((resolveP, rejectP) => {
    ctx.server.close((err) => (err ? rejectP(err) : resolveP()));
  });
  await ctx.db.close();
}

describe("oauth/token (RS256 + claims + TTL)", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    ctx = await setupApp({
      audience: "mcp:readonly-sql",
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
    });
  });

  afterEach(async () => {
    await teardownApp(ctx);
  });

  it("client_credentials grant: returns a JWT with the spec claims, header kid, TTL 3600", async () => {
    // GIVEN a registered client with no specific scope request
    // WHEN we POST grant_type=client_credentials
    // THEN the response is 200 + a JWT whose:
    //   - header is { alg: RS256, kid, typ: JWT }
    //   - payload has iss, aud=mcp:readonly-sql, sub, scope, iat, nbf, exp
    //   - exp - iat = 3600 (TTL)
    const clientId = "client-a";
    const clientSecret = "s3cret";
    const clientSecretHash = createHmac("sha256", clientSecret).update("").digest("hex");
    void clientSecretHash;
    // Use the password module's hash for the client secret
    // (the token endpoint verifies against the stored hash).
    const stored = await makeArgonHash(clientSecret);
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        [clientId, stored, "test", JSON.stringify(["read:bi_catastro"]), Math.floor(Date.now() / 1000)],
      );
    });

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(3600);
    expect(json.scope).toBe("read:bi_catastro");
    expect(typeof json.access_token).toBe("string");

    // Decode + verify the JWT.
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      {
        issuer: "http://127.0.0.1:3002",
        audience: "mcp:readonly-sql",
        algorithms: ["RS256"],
      },
    );
    const header = verified.protectedHeader;
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe(ctx.key.id);
    expect(header.typ).toBe("JWT");
    const payload = verified.payload;
    expect(payload.iss).toBe("http://127.0.0.1:3002");
    expect(payload.aud).toBe("mcp:readonly-sql");
    expect(typeof payload.sub).toBe("string");
    expect(payload.scope).toBe("read:bi_catastro");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.nbf).toBe("number");
    expect(typeof payload.exp).toBe("number");
    const ttl = (payload.exp as number) - (payload.iat as number);
    expect(ttl).toBe(3600);
  });

  it("password grant: returns a JWT for a registered user (argon2id-stored hash)", async () => {
    // GIVEN a registered user with an argon2id password hash
    //      + a registered client
    // WHEN we POST grant_type=password
    // THEN the response is 200 + a JWT with the spec claims.
    const username = "alice";
    const password = "p4ssw0rd";
    const passwordHash = await makeArgonHash(password);
    const clientSecret = "s3cret";
    const clientHash = await makeArgonHash(clientSecret);
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        [username, passwordHash, JSON.stringify(["read:bi_catastro"]), 1, 0, Math.floor(Date.now() / 1000)],
      );
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-a", clientHash, "test", JSON.stringify(["read:bi_catastro"]), Math.floor(Date.now() / 1000)],
      );
    });

    const body = new URLSearchParams({
      grant_type: "password",
      username,
      password,
      client_id: "client-a",
      client_secret: clientSecret,
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { access_token: string; scope: string };
    expect(json.scope).toBe("read:bi_catastro");
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      {
        issuer: "http://127.0.0.1:3002",
        audience: "mcp:readonly-sql",
        algorithms: ["RS256"],
      },
    );
    expect(verified.payload.sub).toBeDefined();
  });

  it("password grant: returns 400 invalid_grant on wrong password", async () => {
    // GIVEN a user with hash(password) + a registered client
    // WHEN we POST with the wrong password
    // THEN the response is 400 + { error: invalid_grant }.
    const passwordHash = await makeArgonHash("right");
    const clientHash = await makeArgonHash("s3cret");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        ["alice", passwordHash, JSON.stringify(["read:bi_catastro"]), 1, 0, Math.floor(Date.now() / 1000)],
      );
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-a", clientHash, "test", JSON.stringify(["read:bi_catastro"]), Math.floor(Date.now() / 1000)],
      );
    });
    const body = new URLSearchParams({
      grant_type: "password",
      username: "alice",
      password: "wrong",
      client_id: "client-a",
      client_secret: "s3cret",
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_grant");
  });

  it("client_credentials grant: refuses `*` mixed with a specific scope (400 invalid_scope)", async () => {
    // GIVEN a registered client
    // WHEN we POST with scope=* read:bi_catastro (mixed wildcard + specific)
    // THEN the response is 400 + { error: invalid_scope }. The
    //      spec says `*` MUST NOT be mixed with specific scopes.
    const stored = await makeArgonHash("s3cret");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-a", stored, "test", JSON.stringify(["read:bi_catastro"]), Math.floor(Date.now() / 1000)],
      );
    });
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "client-a",
      client_secret: "s3cret",
      scope: "* read:bi_catastro",
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_scope");
  });

  it("client_credentials grant: a new client defaults to `read:<bound-profile>` (no `*`)", async () => {
    // GIVEN a new client whose `scopes` column is the default
    //      empty array (the test pre-registers with [])
    // WHEN we POST with NO scope param
    // THEN the issued token's `scope` is the authority's
    //      default: `read:bi_catastro` (the spec's
    //      `read:<bound-profile>`). The token's scope MUST
    //      NOT include `*`.
    const stored = await makeArgonHash("s3cret");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-default", stored, "default-test", "[]", Math.floor(Date.now() / 1000)],
      );
    });
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "client-default",
      client_secret: "s3cret",
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope: string };
    expect(json.scope).toBe("read:bi_catastro");
    expect(json.scope.split(/\s+/)).not.toContain("*");
  });

  it("refresh_token grant: rejects revoked refresh tokens with 400 invalid_grant", async () => {
    // GIVEN a refresh token whose revokedAt is set
    // WHEN we POST grant_type=refresh_token
    // THEN the response is 400 + { error: invalid_grant }.
    //      The spec says non-null `revokedAt` is rejected.
    const clientId = "client-a";
    const clientSecret = "s3cret";
    const stored = await makeArgonHash(clientSecret);
    // Insert the client + a refresh token (revoked) + a user.
    const now = Math.floor(Date.now() / 1000);
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        [clientId, stored, "test", JSON.stringify(["read:bi_catastro"]), now],
      );
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        ["alice", "argon2id-stub", JSON.stringify(["read:bi_catastro"]), 1, 0, now],
      );
      await trx.execute(
        "INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)",
        [1, 1, JSON.stringify(["read:bi_catastro"]), "revoked-token-hash", now - 1000, now - 500],
      );
    });
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "revoked-token-plaintext",
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_grant");
  });

  it("refresh_token grant: issues a new access token for a non-revoked refresh token", async () => {
    // GIVEN a refresh token whose revokedAt is null
    // WHEN we POST grant_type=refresh_token
    // THEN the response is 200 + a new access token.
    const clientId = "client-a";
    const clientSecret = "s3cret";
    const stored = await makeArgonHash(clientSecret);
    const now = Math.floor(Date.now() / 1000);
    const refreshPlaintext = "fresh-refresh-token";
    const refreshHash = createHash("sha256").update(refreshPlaintext).digest("hex");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        [clientId, stored, "test", JSON.stringify(["read:bi_catastro"]), now],
      );
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        ["alice", "argon2id-stub", JSON.stringify(["read:bi_catastro"]), 1, 0, now],
      );
      await trx.execute(
        "INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)",
        [1, 1, JSON.stringify(["read:bi_catastro"]), refreshHash, now - 1000, null],
      );
    });
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshPlaintext,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { access_token: string; scope: string };
    expect(json.scope).toBe("read:bi_catastro");
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", audience: "mcp:readonly-sql", algorithms: ["RS256"] },
    );
    expect(verified.payload.aud).toBe("mcp:readonly-sql");
  });
});

describe("oauth/introspect", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    ctx = await setupApp({
      audience: "mcp:readonly-sql",
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
    });
  });

  afterEach(async () => {
    await teardownApp(ctx);
  });

  it("introspect: returns { active: true, ... } for a valid token", async () => {
    // GIVEN a client_credentials grant that returned a token
    // WHEN we POST /oauth/introspect with the token
    // THEN the response is 200 + { active: true, sub, aud, iss, scope }.
    const stored = await makeArgonHash("s3cret");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-a", stored, "test", JSON.stringify(["read:bi_catastro"]), Math.floor(Date.now() / 1000)],
      );
    });
    const tokenRes = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "client-a",
        client_secret: "s3cret",
      }),
    });
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const introspect = await fetch(`${ctx.baseUrl}/oauth/introspect`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: access_token }),
    });
    expect(introspect.status).toBe(200);
    const body = (await introspect.json()) as {
      active: boolean;
      sub?: string;
      aud?: string;
      iss?: string;
      scope?: string;
    };
    expect(body.active).toBe(true);
    expect(body.aud).toBe("mcp:readonly-sql");
    expect(body.iss).toBe("http://127.0.0.1:3002");
    expect(body.scope).toBe("read:bi_catastro");
  });

  it("introspect: returns { active: false } for a malformed/expired token", async () => {
    // GIVEN an obviously-bogus token
    // WHEN we POST it to /oauth/introspect
    // THEN the response is 200 + { active: false }. The
    //      endpoint MUST NOT 4xx on a bad token (the spec
    //      leaves the error shape to the implementation;
    //      OAuth2 RFC 7662 requires 200 + active: false).
    const res = await fetch(`${ctx.baseUrl}/oauth/introspect`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "not-a-jwt" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });
});
