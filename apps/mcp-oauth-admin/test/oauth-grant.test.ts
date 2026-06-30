/**
 * Focused integration tests for the OAuth2 grant flow
 * (PR 3 of `remove-scope-authorization`).
 *
 * The mcp-oauth-authority spec requires the
 * `remove-scope-authorization` contract:
 *
 *   "When a client includes a `scope` (or `scopes`)
 *   parameter in any of the four grant requests
 *   (`/oauth/token` with `grant_type` in
 *   `client_credentials`, `password`, `refresh_token`,
 *   `authorization_code`), the `/oauth/authorize`
 *   request, or the Dynamic Client Registration
 *   request, the authority MUST accept and ignore
 *   the value. The authority MUST NOT reject the
 *   request with `invalid_scope` and MUST NOT
 *   include the requested scopes in the issued
 *   token, the token response body, the
 *   introspection response, or the user-info
 *   response."
 *
 * This file is the dedicated regression target for
 * the "incoming `scope` is ignored" contract. The
 * four `token.test.ts` tests in the
 *   "incoming `scope` parameter is tolerated and
 *   ignored (PR 3 of remove-scope-authorization)"
 * describe block exercise the same contract from
 * the per-grant angle; this file pins the contract
 * end-to-end with the wire-level flow
 * (token-grant → introspect).
 *
 * Test layer: integration. We mount the token
 * handler + introspect handler on a real
 * `node:http` listener and POST to it. The signer
 * is the production code; we verify the issued JWT
 * with a real `jwtVerify` against the same signing
 * key.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK, exportPKCS8, calculateJwkThumbprint, jwtVerify, importPKCS8 } from "jose";
import { openDatabase, initializeSchema, withSingleWriter } from "../src/db/index.js";
import { createTokenHandler, type TokenHandlerDeps } from "../src/oauth/token.js";
import { createIntrospectHandler } from "../src/oauth/introspect.js";
import { setActiveSigningKey, type SigningKeyRecord } from "../src/oauth/keys.js";
import { hashPassword } from "../src/oauth/passwords.js";
import { _resetCodeStore, getCodeStore } from "../src/oauth/authorize.js";

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

async function setupApp(): Promise<{
  baseUrl: string;
  db: ReturnType<typeof openDatabase>;
  key: SigningKeyRecord;
  server: Server;
}> {
  const db = openDatabase({ path: ":memory:" });
  await initializeSchema(db);
  const key = await makeTestKey();
  await setActiveSigningKey(db, key);
  const deps: TokenHandlerDeps = {
    db,
    issuer: "http://127.0.0.1:3002",
    audience: "mcp:readonly-sql",
    defaultScope: "read:bi_catastro",
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
  return { baseUrl: `http://127.0.0.1:${port}`, db, key, server };
}

async function teardownApp(ctx: { db: ReturnType<typeof openDatabase>; server: Server }): Promise<void> {
  await new Promise<void>((resolveP, rejectP) => {
    ctx.server.close((err) => (err ? rejectP(err) : resolveP()));
  });
  await ctx.db.close();
}

describe("oauth/oauth-grant (PR 3 of remove-scope-authorization) — incoming `scope` is ignored", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    _resetCodeStore();
    ctx = await setupApp();
  });

  afterEach(async () => {
    _resetCodeStore();
    await teardownApp(ctx);
  });

  it("client_credentials: scope=read:bi_catastro list:bi_catastro call:secret is ignored; token is scope-free; introspect has no `scope`", async () => {
    // GIVEN a registered client
    // WHEN we POST grant_type=client_credentials with a
    //      list of scope values the client is NOT
    //      allowed to grant (and the pre-PR enforcement
    //      would have rejected with `invalid_scope`).
    // THEN the response is 200, the JWT has NO `scope`
    //      or `scopes` claim, and the introspection
    //      body has NO `scope` field.
    const stored = await hashPassword("s3cret");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-a", stored, "test", JSON.stringify([]), Math.floor(Date.now() / 1000)],
      );
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "client-a",
        client_secret: "s3cret",
        scope: "read:bi_catastro list:bi_catastro call:secret",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string; access_token: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", audience: "mcp:readonly-sql", algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
    // The introspection endpoint mirrors the contract:
    // the body has NO `scope` field.
    const introspect = await fetch(`${ctx.baseUrl}/oauth/introspect`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: json.access_token }),
    });
    expect(introspect.status).toBe(200);
    const introBody = (await introspect.json()) as { active: boolean; scope?: string };
    expect(introBody.active).toBe(true);
    expect(introBody.scope).toBeUndefined();
  });

  it("password: scope=* is tolerated and ignored; token is scope-free", async () => {
    // GIVEN a registered user + a registered client
    // WHEN we POST grant_type=password with scope=*
    // THEN the response is 200, the JWT has NO
    //      `scope` / `scopes` claim.
    const passwordHash = await hashPassword("p4ssw0rd");
    const clientHash = await hashPassword("s3cret");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        ["alice", passwordHash, JSON.stringify([]), 1, 0, Math.floor(Date.now() / 1000)],
      );
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-a", clientHash, "test", JSON.stringify([]), Math.floor(Date.now() / 1000)],
      );
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        username: "alice",
        password: "p4ssw0rd",
        client_id: "client-a",
        client_secret: "s3cret",
        scope: "*",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string; access_token: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", audience: "mcp:readonly-sql", algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });

  it("refresh_token: scope=call:secret is tolerated; legacy stored `scopes` is inert; token is scope-free", async () => {
    // GIVEN a refresh token whose `scopes` column is
    //      empty (the post-PR3 default), and a request
    //      that includes a `scope=call:secret` param
    // WHEN we POST grant_type=refresh_token
    // THEN the response is 200, the JWT has NO
    //      `scope` / `scopes` claim.
    const clientId = "client-a";
    const clientSecret = "s3cret";
    const stored = await hashPassword(clientSecret);
    const now = Math.floor(Date.now() / 1000);
    const refreshPlaintext = "fresh-refresh-token";
    const refreshHash = createHash("sha256").update(refreshPlaintext).digest("hex");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        [clientId, stored, "test", JSON.stringify([]), now],
      );
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        ["alice", "argon2id-stub", JSON.stringify([]), 1, 0, now],
      );
      await trx.execute(
        "INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)",
        [1, 1, JSON.stringify([]), refreshHash, now - 1000, null],
      );
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshPlaintext,
        client_id: clientId,
        client_secret: clientSecret,
        scope: "call:secret",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string; access_token: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", audience: "mcp:readonly-sql", algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });

  it("authorization_code: a code with empty bound `scopes` + a request with `scope=*` mints a scope-free token", async () => {
    // GIVEN a freshly-issued code with `scopes: []`
    //      (the post-PR3 default) and a request that
    //      includes a `scope=*` param
    // WHEN we POST grant_type=authorization_code
    // THEN the response is 200, the JWT has NO
    //      `scope` / `scopes` claim.
    const clientId = "client-a";
    const clientSecret = "s3cret";
    const redirectUri = "http://127.0.0.1:8080/cb";
    const clientHash = await hashPassword(clientSecret);
    let userId = 0;
    await withSingleWriter(ctx.db, async (trx) => {
      const userHash = await hashPassword("p4ssw0rd");
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        ["alice", userHash, JSON.stringify([]), 1, 0, Math.floor(Date.now() / 1000)],
      );
      const userRows = await trx.select<{ id: number }>(
        "SELECT id FROM users WHERE username = ?",
        ["alice"],
      );
      userId = userRows[0]!.id;
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        [clientId, clientHash, "test", JSON.stringify([]), Math.floor(Date.now() / 1000)],
      );
    });
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const code = `code-${Math.random().toString(36).slice(2, 10)}`;
    getCodeStore().set(code, {
      clientId,
      agentId: userId,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
        scope: "*",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string; access_token: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", audience: "mcp:readonly-sql", algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
    // The introspection endpoint mirrors the contract:
    // the body has NO `scope` field.
    const introspect = await fetch(`${ctx.baseUrl}/oauth/introspect`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: json.access_token }),
    });
    expect(introspect.status).toBe(200);
    const introBody = (await introspect.json()) as { active: boolean; scope?: string };
    expect(introBody.active).toBe(true);
    expect(introBody.scope).toBeUndefined();
  });
});
