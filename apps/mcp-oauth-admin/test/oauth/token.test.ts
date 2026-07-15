/**
 * Unit + integration tests for the RS256 access-token signer
 * and the OAuth2 token endpoint.
 *
 * The mcp-oauth-authority spec requires (post `remove-scope-authorization`):
 * - Access tokens are RS256-signed JWTs.
 * - Claims: `iss` (the authority URL), `aud` (= `mcp:<app>`),
 *   `sub` (the agent id), `iat`, `nbf`, `exp`, `kid` in the
 *   header. The JWT MUST NOT include a `scope` or `scopes`
 *   claim; the authority mints scope-free tokens by design
 *   (scope authorization is removed).
 * - TTL: 3600 seconds (1 hour).
 * - Token endpoint supports `client_credentials`, `password`,
 *   `refresh_token`, and `authorization_code` grants.
 * - The `refresh_token` grant rejects tokens with a non-null
 *   `revokedAt` with `400 invalid_grant`.
 * - Incoming `scope` request parameters (on any of the four
 *   grants) are tolerated and ignored. The authority MUST
 *   NOT reject the request with `invalid_scope` and MUST NOT
 *   include `scope` in the issued token, the token response
 *   body, the introspection response, or the authorization
 *   code.
 * - The token response body is the standard OAuth2 shape
 *   (`access_token`, `token_type`, `expires_in`). The
 *   `scope` field is omitted; callers MUST treat the token
 *   as scope-free by construction.
 *
 * Test layer: integration. We mount the token handler on a
 * real `node:http` listener and POST to it. The signer is
 * the production code; we verify the issued JWT with a real
 * `jwtVerify` against the same signing key.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK, exportPKCS8, calculateJwkThumbprint, jwtVerify, importPKCS8 } from "jose";
import { openDatabase, initializeSchema, withSingleWriter } from "../../src/db/index.js";
import { createTokenHandler, type TokenHandlerDeps } from "../../src/oauth/token.js";
import { createIntrospectHandler } from "../../src/oauth/introspect.js";
import { setActiveSigningKey, type SigningKeyRecord } from "../../src/oauth/keys.js";
import { hashPassword } from "../../src/oauth/passwords.js";
import { _resetCodeStore, getCodeStore, type CodeRecord } from "../../src/oauth/authorize.js";

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
  issuer: string;
  defaultScope: string;
  now?: () => number;
}): Promise<{ baseUrl: string; db: ReturnType<typeof openDatabase>; key: SigningKeyRecord; server: Server; now: () => number }> {
  const db = openDatabase({ path: ":memory:" });
  await initializeSchema(db);
  const key = await makeTestKey();
  await setActiveSigningKey(db, key);

  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const deps: TokenHandlerDeps = {
    db,
    issuer: opts.issuer,
    allowedResources: ["https://mcp.example.com"],
    defaultScope: opts.defaultScope,
    accessTokenTtlSeconds: 3600,
    activeKey: key,
    now,
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
  return { baseUrl, db, key, server, now };
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
      allowedResources: ["https://mcp.example.com"],
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
    });
  });

  afterEach(async () => {
    await teardownApp(ctx);
  });

  it("client_credentials grant: returns a JWT with the spec claims, header kid, TTL 3600 (no scope claims)", async () => {
    // GIVEN a registered client with no specific scope request
    // WHEN we POST grant_type=client_credentials
    // THEN the response is 200 + a JWT whose:
    //   - header is { alg: RS256, kid, typ: JWT }
    //   - payload has iss, aud=mcp:readonly-sql, sub, iat, nbf, exp
    //     and MUST NOT include a `scope` or `scopes` claim
    //   - exp - iat = 3600 (TTL)
    //   - the response body MUST NOT include a `scope` field
    const clientId = "client-a";
    const clientSecret = "s3cret";
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
      scope?: string;
    };
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(3600);
    // The body MUST NOT include a `scope` field (PR 3 of
    // `remove-scope-authorization` removes the field).
    expect(json.scope).toBeUndefined();
    expect(typeof json.access_token).toBe("string");

    // Decode + verify the JWT.
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      {
        issuer: "http://127.0.0.1:3002",
        allowedResources: ["https://mcp.example.com"],
        algorithms: ["RS256"],
      },
    );
    const header = verified.protectedHeader;
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe(ctx.key.id);
    expect(header.typ).toBe("JWT");
    const payload = verified.payload;
    expect(payload.iss).toBe("http://127.0.0.1:3002");
    expect(payload.aud).toBe("https://mcp.example.com");
    expect(typeof payload.sub).toBe("string");
    // The JWT MUST NOT include a `scope` or `scopes` claim.
    // The `remove-scope-authorization` change mints
    // scope-free tokens by design (no wildcard, no
    // empty-string fallback).
    expect(payload.scope).toBeUndefined();
    expect(payload.scopes).toBeUndefined();
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.nbf).toBe("number");
    expect(typeof payload.exp).toBe("number");
    const ttl = (payload.exp as number) - (payload.iat as number);
    expect(ttl).toBe(3600);
  });

  it("password grant: returns a JWT for a registered user (argon2id-stored hash, no scope claims)", async () => {
    // GIVEN a registered user with an argon2id password hash
    //      + a registered client
    // WHEN we POST grant_type=password
    // THEN the response is 200 + a JWT with the spec
    //      claims (iss, aud, sub, iat, nbf, exp) and NO
    //      `scope` / `scopes` claims. The response body
    //      does NOT include a `scope` field.
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
    const json = (await res.json()) as { access_token: string; scope?: string };
    // The body MUST NOT include a `scope` field.
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      {
        issuer: "http://127.0.0.1:3002",
        allowedResources: ["https://mcp.example.com"],
        algorithms: ["RS256"],
      },
    );
    expect(verified.payload.sub).toBeDefined();
    // The JWT MUST NOT include a `scope` or `scopes` claim.
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });

  it("password grant: returns 400 password_change_required when requireChangeOnFirstLogin=1 (gate W3 remediation)", async () => {
    // GIVEN a user whose `requireChangeOnFirstLogin` flag
    //      is set (the bootstrap admin flow / first-login
    //      rotation case)
    // WHEN we POST grant_type=password with the user's
    //      CURRENT password (the spec is clear: the agent
    //      must NOT be able to bypass rotation by
    //      presenting a working password at the token
    //      endpoint)
    // THEN the response is 400 + { error:
    //      "password_change_required" } — the agent MUST
    //      rotate via the admin UI before being allowed
    //      to mint an access token.
    const username = "alice-bootstrap";
    const password = "p4ssw0rd";
    const passwordHash = await makeArgonHash(password);
    const clientSecret = "s3cret";
    const clientHash = await makeArgonHash(clientSecret);
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        // requireChangeOnFirstLogin = 1 → must reject
        [username, passwordHash, JSON.stringify(["read:bi_catastro"]), 1, 1, Math.floor(Date.now() / 1000)],
      );
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-a", clientHash, "test", JSON.stringify(["read:bi_catastro"]), Math.floor(Date.now() / 1000)],
      );
    });

    const body = new URLSearchParams({
      grant_type: "password",
      username,
      password, // the password is correct — the flag is what trips
      client_id: "client-a",
      client_secret: clientSecret,
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    // THEN the response is 400 + password_change_required
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("password_change_required");
    // No access_token is returned.
    expect((json as Record<string, unknown>).access_token).toBeUndefined();
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

  it("client_credentials grant: incoming `scope=* read:bi_catastro` is tolerated and ignored (no invalid_scope)", async () => {
    // GIVEN a registered client (the wildcard-vs-specific
    //      behavior is removed; incoming scope is tolerated
    //      and ignored, NOT validated).
    // WHEN we POST with scope=* read:bi_catastro (mixed wildcard + specific)
    // THEN the response is 200 + a JWT. The handler does
    //      NOT reject with `invalid_scope` (the spec
    //      `incoming-scope-tolerated` rule for PR 3 of
    //      `remove-scope-authorization`).
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
    expect(res.status).toBe(200);
    const json = (await res.json()) as { access_token: string; scope?: string };
    expect(json.scope).toBeUndefined();
    // The JWT MUST NOT include a `scope` or `scopes` claim.
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });

  it("client_credentials grant: a new client with no stored scopes still mints a scope-free token", async () => {
    // GIVEN a new client whose `scopes` column is the
    //      default empty array (the test pre-registers
    //      with `[]`).
    // WHEN we POST with NO `scope` param
    // THEN the response is 200 + a JWT with NO `scope`
    //      field in the body and NO `scope` / `scopes`
    //      claim in the JWT. The pre-PR behavior
    //      (defaulting to `read:<bound-profile>`) is
    //      removed: the authority no longer assigns a
    //      default scope.
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
    const json = (await res.json()) as { scope?: string; access_token: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
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

  it("refresh_token grant: issues a new scope-free access token for a non-revoked refresh token", async () => {
    // GIVEN a refresh token whose revokedAt is null AND
    //      whose bound `scopes` column is a legacy value
    //      (`["read:bi_catastro"]`) from a pre-PR
    //      deployment.
    // WHEN we POST grant_type=refresh_token
    // THEN the response is 200 + a new access token.
    //      The minted token is scope-free (no `scope` /
    //      `scopes` claims, no `scope` in the body). The
    //      legacy stored `scopes` value is inert — it
    //      MUST NOT influence the new access token.
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
    const json = (await res.json()) as { access_token: string; scope?: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.aud).toBe("https://mcp.example.com");
    // The JWT MUST NOT include a `scope` or `scopes` claim
    // even though the refresh token's bound `scopes` column
    // holds a legacy value.
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });
});

describe("oauth/token (authorization_code grant — PKCE S256)", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let userId: number;
  let clientId: string;
  const clientSecret = "s3cret";
  const redirectUri = "http://127.0.0.1:8080/cb";
  let verifier: string;
  let challenge: string;
  let nowRef: { value: number };

  beforeEach(async () => {
    _resetCodeStore();
    // Use a recent past second as the base. The
    // `mintAccessToken` helper derives the JWT `iat` /
    // `nbf` / `exp` claims from the injected clock
    // (the deterministic-clock change in `token.ts`).
    // The pre-PR code used `Date.now()` directly, so
    // this value could be any fixed past time. The new
    // code uses the injected clock, so a fixed past
    // time would mint a JWT whose `exp` is in the past
    // by the time the test calls `jwtVerify`.
    nowRef = { value: Math.floor(Date.now() / 1000) - 60 };
    ctx = await setupApp({
      allowedResources: ["https://mcp.example.com"],
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
      now: () => nowRef.value,
    });
    // Pre-register the user + client. The agent's id is
    // captured for the `sub=user:<id>` assertion.
    const userHash = await makeArgonHash("p4ssw0rd");
    const clientHash = await makeArgonHash(clientSecret);
    clientId = "client-a";
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        ["alice", userHash, JSON.stringify(["read:bi_catastro"]), 1, 0, nowRef.value],
      );
      const userRows = await trx.select<{ id: number }>(
        "SELECT id FROM users WHERE username = ?",
        ["alice"],
      );
      userId = userRows[0]!.id;
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        [clientId, clientHash, "test", JSON.stringify(["read:bi_catastro"]), nowRef.value],
      );
    });
    verifier = randomBytes(32).toString("base64url");
    challenge = createHash("sha256").update(verifier).digest("base64url");
  });

  afterEach(async () => {
    _resetCodeStore();
    await teardownApp(ctx);
  });

  function seedCode(overrides: Partial<CodeRecord> = {}): string {
    const code = `code-${Math.random().toString(36).slice(2, 10)}`;
    getCodeStore().set(code, {
      clientId,
      agentId: userId,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scopes: ["read:bi_catastro"],
      expiresAt: nowRef.value + 60,
      ...overrides,
    });
    return code;
  }

  it("happy path: returns a JWT with sub=user:<agentId> (no scope claims, no scope in body)", async () => {
    // GIVEN a freshly-issued code (the `code` is bound
    //      to clientId + agentId + redirectUri +
    //      codeChallenge; in the PR 3 contract it is
    //      NOT bound to a scope set).
    // WHEN we POST grant_type=authorization_code with
    //      the matching code_verifier
    // THEN the response is 200 + a JWT whose:
    //   - sub is `user:<id>` (the agent's id)
    //   - aud and iss match the authority config
    //   - payload MUST NOT include a `scope` or `scopes`
    //     claim
    //   - body MUST NOT include a `scope` field
    const code = seedCode();
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
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope?: string;
    };
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(3600);
    // The body MUST NOT include a `scope` field.
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      {
        issuer: "http://127.0.0.1:3002",
        allowedResources: ["https://mcp.example.com"],
        algorithms: ["RS256"],
      },
    );
    expect(verified.payload.sub).toBe(`user:${userId}`);
    expect(verified.payload.iss).toBe("http://127.0.0.1:3002");
    expect(verified.payload.aud).toBe("https://mcp.example.com");
    // The JWT MUST NOT include a `scope` or `scopes` claim.
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });

  it("PKCE S256: wrong code_verifier returns 400 invalid_grant (sanitized)", async () => {
    const code = seedCode();
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: "a-wrong-verifier-of-sufficient-length-for-the-grammar",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_grant");
    // Sanitized: no code, no verifier, no challenge, no
    // authority / JWKS URL leaked.
    expect(JSON.stringify(body)).not.toMatch(/code/i);
    expect(JSON.stringify(body)).not.toMatch(/verifier/i);
    expect(JSON.stringify(body)).not.toMatch(/challenge/i);
    expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1/);
    expect(JSON.stringify(body)).not.toMatch(/mcp:readonly-sql/);
    // The minted token's `aud` is the canonical resource URI
    // (RFC 8707); the previous legacy audience value MUST NOT
    // appear anywhere in the response body.
    expect(JSON.stringify(body)).not.toMatch(/https:\/\/mcp\.example\.com/);
    // No access_token.
    expect(body.access_token).toBeUndefined();
  });

  it("redirect_uri byte-equal: a different redirect_uri returns 400 invalid_grant", async () => {
    const code = seedCode();
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:9999/different",
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("client_id mismatch: a code bound to client-a is rejected when exchanged by client-b", async () => {
    // Pre-register a second client.
    const otherHash = await makeArgonHash("s3cret-b");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-b", otherHash, "test", JSON.stringify(["read:bi_catastro"]), nowRef.value],
      );
    });
    const code = seedCode();
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: "client-b",
        client_secret: "s3cret-b",
        code_verifier: verifier,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("single-use: the second call with the same code returns 400 invalid_grant", async () => {
    const code = seedCode();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    });
    const res1 = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res1.status).toBe(200);
    const res2 = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // Build a fresh body — `URLSearchParams` is single-shot.
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      }),
    });
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: string };
    expect(body2.error).toBe("invalid_grant");
  });

  it("expiry: a code past expiresAt returns 400 invalid_grant", async () => {
    // Issue with a 1-second TTL; advance the clock past
    // the boundary; the second call returns invalid_grant.
    const code = seedCode({ expiresAt: nowRef.value + 1 });
    // Move the clock past expiry (60s + 1 per the spec
    // is the boundary; we use 2s past to avoid edge
    // flakiness).
    nowRef.value += 2;
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
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("missing required fields (no code, no redirect_uri) returns 400 invalid_request", async () => {
    // No code, no redirect_uri → 400 invalid_request.
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("non-loopback redirect_uri on the token request is rejected (400 invalid_grant)", async () => {
    // The token handler MUST enforce the same loopback
    // rule as the authorize handler. A non-loopback
    // redirect_uri on the token request is rejected
    // with sanitized `invalid_grant`.
    const code = seedCode();
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://attacker.example/cb",
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("defense in depth: a code with a legacy bound `scopes` array still mints a scope-free token", async () => {
    // Pre-PR code rows stored a `scopes: ["read:bi_catastro", "list:bi_catastro"]`
    // value at consent time. After PR 3, the token
    // endpoint MUST NOT carry that value into the new
    // access token (the `code` is no longer bound to
    // a scope set; the JWT omits `scope` / `scopes`).
    const code = seedCode({ scopes: ["read:bi_catastro", "list:bi_catastro"] });
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
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string; access_token: string };
    // The body MUST NOT include a `scope` field, and the
    // JWT MUST NOT include a `scope` or `scopes` claim
    // even though the code had a legacy `scopes` array.
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });
});

describe("oauth/token — client_secret_basic (RFC 6749 §2.3.1)", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  const clientId = "client-basic";
  const clientSecret = "basic-secret";

  beforeEach(async () => {
    ctx = await setupApp({
      allowedResources: ["https://mcp.example.com"],
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
    });
    const stored = await makeArgonHash(clientSecret);
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        [clientId, stored, "test", JSON.stringify(["read:bi_catastro"]), Math.floor(Date.now() / 1000)],
      );
    });
  });

  afterEach(async () => {
    await teardownApp(ctx);
  });

  it("accepts client credentials via the Authorization: Basic header", async () => {
    const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string };
    // The body MUST NOT include a `scope` field.
    expect(json.scope).toBeUndefined();
  });

  it("rejects a malformed Basic header (falls back to no-creds error)", async () => {
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic !!!not-base64!!!",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("header credentials take precedence over body credentials", async () => {
    // The header carries the right secret; the
    // body carries the WRONG secret. The header
    // wins (RFC 6749 §2.3.1: when both are present,
    // exactly one MUST be used; the convention is
    // header-first).
    const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: "wrong-body-secret",
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe("oauth/token — incoming `scope` parameter is tolerated and ignored (PR 3 of remove-scope-authorization)", () => {
  // The pre-PR3 implementation validated, bounded, and
  // resolved the `scope` request parameter for every
  // grant. The post-PR3 contract is: the parameter is
  // accepted, ignored, and never causes a rejection.
  // The authority MUST NOT return `invalid_scope` for
  // any scope request, and the issued token MUST NOT
  // include the requested scope in any form.
  //
  // This describe block pins the contract with one
  // test per grant (triangulation: same behavior across
  // all four grant types).
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    ctx = await setupApp({
      allowedResources: ["https://mcp.example.com"],
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
    });
  });

  afterEach(async () => {
    await teardownApp(ctx);
  });

  it("client_credentials: incoming `scope=read:bi_catastro list:bi_catastro` is ignored, JWT has no `scope`", async () => {
    const stored = await makeArgonHash("s3cret");
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
        scope: "read:bi_catastro list:bi_catastro",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string; access_token: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });

  it("password: incoming `scope=*` is tolerated (no invalid_scope), JWT has no `scope`", async () => {
    const passwordHash = await makeArgonHash("p4ssw0rd");
    const clientHash = await makeArgonHash("s3cret");
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
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });

  it("refresh_token: incoming `scope=call:secret` on a fresh refresh grant is ignored", async () => {
    // A refresh grant with a legacy refresh token that
    // had bound `scopes = []` and a NEW request that
    // includes `scope=call:secret` MUST still succeed;
    // the `scope` is ignored, the token is scope-free.
    const clientId = "client-a";
    const clientSecret = "s3cret";
    const stored = await makeArgonHash(clientSecret);
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
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });

  it("authorization_code: incoming `scope=* read:bi_catastro` on a code exchange is ignored, JWT has no `scope`", async () => {
    // The PR 3 contract: the `code` is bound to
    // clientId + agentId + redirectUri + codeChallenge
    // only; the `scope` request param on the token
    // request is tolerated and ignored. The token is
    // scope-free.
    _resetCodeStore();
    const clientIdLocal = "client-a";
    const clientSecretLocal = "s3cret";
    const redirectUriLocal = "http://127.0.0.1:8080/cb";
    const userHash = await makeArgonHash("p4ssw0rd");
    const clientHash = await makeArgonHash(clientSecretLocal);
    let userIdLocal = 0;
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        ["alice", userHash, JSON.stringify([]), 1, 0, Math.floor(Date.now() / 1000)],
      );
      const userRows = await trx.select<{ id: number }>(
        "SELECT id FROM users WHERE username = ?",
        ["alice"],
      );
      userIdLocal = userRows[0]!.id;
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        [clientIdLocal, clientHash, "test", JSON.stringify([]), Math.floor(Date.now() / 1000)],
      );
    });
    const v = randomBytes(32).toString("base64url");
    const c = createHash("sha256").update(v).digest("base64url");
    const code = `code-${Math.random().toString(36).slice(2, 10)}`;
    getCodeStore().set(code, {
      clientId: clientIdLocal,
      agentId: userIdLocal,
      redirectUri: redirectUriLocal,
      codeChallenge: c,
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
        redirect_uri: redirectUriLocal,
        client_id: clientIdLocal,
        client_secret: clientSecretLocal,
        code_verifier: v,
        scope: "* read:bi_catastro",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string; access_token: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });
});

describe("oauth/token — legacy wildcard / mixed scope storage mints a scope-free token (PR 3)", () => {
  // Pre-PR refresh tokens / authorization codes may
  // carry a legacy `scopes` column with a `*` (or
  // mixed `*` + specific) value from a pre-2026
  // deployment. The post-PR3 contract: the stored
  // value is LEGACY/INERT. The new access token is
  // ALWAYS scope-free; the `*` value MUST NOT be
  // honored, MUST NOT be carried into the JWT, and
  // MUST NOT cause a rejection.
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let userId: number;
  let clientId: string;
  const clientSecret = "s3cret";
  const redirectUri = "http://127.0.0.1:8080/cb";
  let verifier: string;
  let challenge: string;
  let nowRef: { value: number };

  beforeEach(async () => {
    _resetCodeStore();
    nowRef = { value: Math.floor(Date.now() / 1000) - 60 };
    ctx = await setupApp({
      allowedResources: ["https://mcp.example.com"],
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
      now: () => nowRef.value,
    });
    const userHash = await makeArgonHash("p4ssw0rd");
    const clientHash = await makeArgonHash(clientSecret);
    clientId = "client-a";
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO users (username, passwordHash, scopes, enabled, requireChangeOnFirstLogin, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        ["alice", userHash, JSON.stringify(["read:bi_catastro"]), 1, 0, nowRef.value],
      );
      const userRows = await trx.select<{ id: number }>(
        "SELECT id FROM users WHERE username = ?",
        ["alice"],
      );
      userId = userRows[0]!.id;
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        [clientId, clientHash, "test", JSON.stringify(["read:bi_catastro"]), nowRef.value],
      );
    });
    verifier = randomBytes(32).toString("base64url");
    challenge = createHash("sha256").update(verifier).digest("base64url");
  });

  afterEach(async () => {
    _resetCodeStore();
    await teardownApp(ctx);
  });

  it("refresh_token: a stored `*` scope mints a SCOPE-FREE token (legacy wildcard is inert)", async () => {
    // The refresh token's `scopes` is `["*"]` (a
    // pre-PR3 token). The new endpoint MUST NOT
    // carry that value into the JWT, MUST NOT
    // reject the request, and MUST NOT include a
    // `scope` or `scopes` claim. The new token is
    // scope-free by design.
    const refreshPlaintext = "stale-wildcard-refresh";
    const refreshHash = createHash("sha256").update(refreshPlaintext).digest("hex");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)",
        [userId, 1, JSON.stringify(["*"]), refreshHash, nowRef.value - 60, null],
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
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string; access_token: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });

  it("authorization_code: a stored `*` scope mints a SCOPE-FREE token (legacy wildcard is inert)", async () => {
    // Same contract on the authorization_code
    // path: the code's `scopes` is `["*"]` (a
    // legacy code issued before the change). The
    // new endpoint MUST mint a scope-free token.
    const code = `code-${Math.random().toString(36).slice(2, 10)}`;
    getCodeStore().set(code, {
      clientId,
      agentId: userId,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scopes: ["*"],
      expiresAt: nowRef.value + 60,
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
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string; access_token: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });

  it("refresh_token: a mixed `*` + specific stored scope mints a SCOPE-FREE token (legacy mixed storage is inert)", async () => {
    // The pre-PR3 storage could have a mixed
    // value. The new endpoint MUST NOT honor it.
    // The new token is scope-free.
    const refreshPlaintext = "mixed-wildcard-refresh";
    const refreshHash = createHash("sha256").update(refreshPlaintext).digest("hex");
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO refresh_tokens (agentId, clientId, scopes, tokenHash, issuedAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)",
        [userId, 1, JSON.stringify(["*", "read:bi_catastro"]), refreshHash, nowRef.value - 60, null],
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
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scope?: string; access_token: string };
    expect(json.scope).toBeUndefined();
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      { issuer: "http://127.0.0.1:3002", allowedResources: ["https://mcp.example.com"], algorithms: ["RS256"] },
    );
    expect(verified.payload.scope).toBeUndefined();
    expect(verified.payload.scopes).toBeUndefined();
  });
});

describe("oauth/token — sanitized audit_log rows for grants (success + denial)", () => {
  // The pre-PR review found that the token endpoint
  // had no audit logging at all. The fix appends
  // sanitized rows for every grant on the success
  // AND the denial path. The action set is stable:
  //   - `token.client_credentials`
  //   - `token.password`
  //   - `token.refresh_token`
  //   - `token.authorization_code`
  //   - `token.unknown_grant` (unrecognized grant_type)
  // The outcome is `ok` for success and `denied` for
  // every failure mode. The actor is the principal on
  // success (`client:<id>` or `user:<id>`) and
  // `system:token:<ip>` on denial when no principal
  // is known. The `ip` column is the trust-controlled
  // client IP (the helper gates XFF on `trustProxy`).
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    ctx = await setupApp({
      allowedResources: ["https://mcp.example.com"],
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
    });
  });

  afterEach(async () => {
    await teardownApp(ctx);
  });

  async function readAuditRows(actionPrefix: string): Promise<
    Array<{ action: string; outcome: string; actor: string; target: string | null; ip: string | null }>
  > {
    return ctx.db.select<{
      action: string;
      outcome: string;
      actor: string;
      target: string | null;
      ip: string | null;
    }>(
      `SELECT action, outcome, actor, target, ip FROM audit_log
       WHERE action LIKE ? ORDER BY id ASC`,
      [`${actionPrefix}%`],
    );
  }

  it("client_credentials success → audit row with action=token.client_credentials and outcome=ok", async () => {
    const clientSecret = "s3cret";
    const stored = await makeArgonHash(clientSecret);
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-a", stored, "test", JSON.stringify(["read:bi_catastro"]), Math.floor(Date.now() / 1000)],
      );
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "client-a",
        client_secret: clientSecret,
      }),
    });
    expect(res.status).toBe(200);
    const rows = await readAuditRows("token.");
    const okRow = rows.find(
      (r) => r.action === "token.client_credentials" && r.outcome === "ok",
    );
    expect(okRow).toBeDefined();
    // The actor is the principal (`client:<id>`). The
    // target is null for `client_credentials` (no user).
    expect(okRow!.actor).toBe("client:client-a");
    expect(okRow!.target).toBeNull();
    // The IP is the loopback peer (the test binds to
    // 127.0.0.1). The shape is the Node socket value
    // (`::ffff:127.0.0.1` or `127.0.0.1`).
    expect(okRow!.ip).toMatch(/^127\.0\.0\.1|^::ffff:127\.0\.0\.1$|^::1$/);
  });

  it("client_credentials denied → audit row with outcome=denied and the actor is the IP", async () => {
    // No client registered. The supplied `client_id` is
    // NEVER echoed in the actor (an attacker probing for
    // valid clientIds would otherwise learn which IDs
    // exist from the audit log).
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "ghost-client",
        client_secret: "s3cret",
      }),
    });
    expect(res.status).toBe(401);
    const rows = await readAuditRows("token.");
    const deniedRow = rows.find(
      (r) => r.action === "token.client_credentials" && r.outcome === "denied",
    );
    expect(deniedRow).toBeDefined();
    expect(deniedRow!.actor).toMatch(/^system:token:/);
    // The supplied `client_id` is NOT in the actor.
    expect(deniedRow!.actor).not.toContain("ghost-client");
  });

  it("password denied → audit row with outcome=denied (no body, no password in any field)", async () => {
    // The user exists but the password is wrong.
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
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        username: "alice",
        password: "wrong",
        client_id: "client-a",
        client_secret: "s3cret",
      }),
    });
    expect(res.status).toBe(400);
    // The audit row exists; the supplied password is
    // NEVER in any audit column.
    const rows = await readAuditRows("token.");
    const deniedRow = rows.find(
      (r) => r.action === "token.password" && r.outcome === "denied",
    );
    expect(deniedRow).toBeDefined();
    // The row's `actor`, `target`, `ip` fields MUST NOT
    // contain the password plaintext, the username, the
    // raw scope, the client secret, or any other
    // attacker-controlled value.
    const text = JSON.stringify(deniedRow);
    expect(text).not.toContain("wrong");
    expect(text).not.toContain("alice");
    expect(text).not.toContain("s3cret");
  });

  it("refresh_token denied (unknown token) → audit row with action=token.refresh_token outcome=denied", async () => {
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "this-token-does-not-exist",
        client_id: "any",
        client_secret: "any",
      }),
    });
    expect(res.status).toBe(400);
    const rows = await readAuditRows("token.");
    const deniedRow = rows.find(
      (r) => r.action === "token.refresh_token" && r.outcome === "denied",
    );
    expect(deniedRow).toBeDefined();
    // The supplied refresh token is NEVER in the actor.
    const text = JSON.stringify(deniedRow);
    expect(text).not.toContain("this-token-does-not-exist");
  });

  it("authorization_code denied (bad code) → audit row with action=token.authorization_code outcome=denied", async () => {
    // Pre-register a client so the request gets past the
    // `invalid_client` gate and reaches the code-consume
    // check. The code itself is unknown, so the handler
    // returns `invalid_grant` (the spec's mandated shape).
    const clientId = "client-a";
    const clientSecret = "s3cret";
    const stored = await makeArgonHash(clientSecret);
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        [clientId, stored, "test", JSON.stringify(["read:bi_catastro"]), Math.floor(Date.now() / 1000)],
      );
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "code-that-does-not-exist",
        redirect_uri: "http://127.0.0.1:8080/cb",
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: "v".repeat(43),
      }),
    });
    expect(res.status).toBe(400);
    const rows = await readAuditRows("token.");
    const deniedRow = rows.find(
      (r) => r.action === "token.authorization_code" && r.outcome === "denied",
    );
    expect(deniedRow).toBeDefined();
    // The supplied code + verifier are NEVER in the actor.
    const text = JSON.stringify(deniedRow);
    expect(text).not.toContain("code-that-does-not-exist");
    expect(text).not.toContain("v".repeat(20));
  });

  it("unsupported grant_type → audit row with action=token.unknown_grant outcome=denied", async () => {
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:fake",
      }),
    });
    expect(res.status).toBe(400);
    const rows = await readAuditRows("token.");
    const deniedRow = rows.find(
      (r) => r.action === "token.unknown_grant" && r.outcome === "denied",
    );
    expect(deniedRow).toBeDefined();
  });
});

describe("oauth/token — audit timestamps use the injected clock (deterministic)", () => {
  // The pre-PR `recordTokenOk` / `recordTokenDenied` helpers
  // used `Math.floor(Date.now() / 1000)` directly. That
  // bypassed the handler's injected clock, so the audit
  // `ts` could land seconds AFTER the JWT `iat` / `nbf`
  // claim — defeating the deterministic-clock contract that
  // the rest of the token endpoint honors. The fix routes
  // the audit `ts` through the same `getNow(deps)` helper
  // the JWT claims use, so the verifier phase can pin a
  // single instant and assert that the audit row + the
  // JWT `iat` are bitwise-equal.
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let nowRef: { value: number };

  beforeEach(async () => {
    // Pick a recent past second (60s before the test
    // start). The JWT `exp` is `now + 3600` (1 hour
    // ahead) so it stays in the future throughout the
    // test; the `iat` / `nbf` stay in the past, which
    // is the standard shape. Using a fixed-past value
    // like 1_700_000_000 (Nov 2023) would mint a JWT
    // whose `exp` is in the past by the time
    // `jwtVerify` runs in 2026.
    nowRef = { value: Math.floor(Date.now() / 1000) - 60 };
    ctx = await setupApp({
      allowedResources: ["https://mcp.example.com"],
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
      now: () => nowRef.value,
    });
  });

  afterEach(async () => {
    await teardownApp(ctx);
  });

  it("success audit row's `ts` equals the injected clock (matches the JWT `iat` claim)", async () => {
    // GIVEN a registered client
    // WHEN we POST grant_type=client_credentials
    // THEN the audit row's `ts` is the injected clock —
    //      bitwise-equal to the JWT `iat` claim (the same
    //      `getNow(deps)` drives both). The pre-PR code
    //      used `Date.now()` for the audit row, so the
    //      values could diverge by the test runtime.
    const clientSecret = "s3cret";
    const stored = await makeArgonHash(clientSecret);
    await withSingleWriter(ctx.db, async (trx) => {
      await trx.execute(
        "INSERT INTO clients (clientId, clientSecretHash, label, scopes, createdAt) VALUES (?, ?, ?, ?, ?)",
        ["client-a", stored, "test", JSON.stringify(["read:bi_catastro"]), nowRef.value],
      );
    });
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "client-a",
        client_secret: clientSecret,
      }),
    });
    expect(res.status).toBe(200);
    // Read the audit row.
    const rows = await ctx.db.select<{ ts: number; outcome: string }>(
      "SELECT ts, outcome FROM audit_log WHERE action = 'token.client_credentials' AND outcome = 'ok'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ts).toBe(nowRef.value);
    // The JWT `iat` claim is the same `getNow(deps)`. The
    // bitwise-equal `ts === iat` is the deterministic-clock
    // contract the verifier phase depends on.
    const json = (await res.json()) as { access_token: string };
    const verified = await jwtVerify(
      json.access_token,
      await importPKCS8(ctx.key.privatePem, "RS256"),
      {
        issuer: "http://127.0.0.1:3002",
        allowedResources: ["https://mcp.example.com"],
        algorithms: ["RS256"],
      },
    );
    expect(verified.payload.iat).toBe(rows[0]!.ts);
  });

  it("denied audit row's `ts` equals the injected clock", async () => {
    // GIVEN a request with no client credentials
    // WHEN we POST grant_type=client_credentials
    // THEN the denied audit row's `ts` is the injected
    //      clock (NOT `Date.now()`).
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "ghost-client",
        client_secret: "s3cret",
      }),
    });
    expect(res.status).toBe(401);
    const rows = await ctx.db.select<{ ts: number; outcome: string }>(
      "SELECT ts, outcome FROM audit_log WHERE action = 'token.client_credentials' AND outcome = 'denied'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ts).toBe(nowRef.value);
  });
});

describe("oauth/token — oversized body returns sanitized 400 (not connection reset)", () => {
  // The pre-PR review found that `token.ts` used
  // `req.destroy()` on the body-cap-exceeded path,
  // converting a 400 into a connection reset. The
  // fix pauses the stream and returns a sanitized
  // 400 JSON. The test below pins the contract.
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    ctx = await setupApp({
      allowedResources: ["https://mcp.example.com"],
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
    });
  });

  afterEach(async () => {
    await teardownApp(ctx);
  });

  it("a 100 KiB body returns 400 + { error: 'invalid_request' } (no socket reset)", async () => {
    // 100 KiB body — well over the 64 KiB cap.
    const oversized = "x".repeat(100 * 1024);
    const res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: oversized,
    });
    // The handler MUST NOT crash the listener with a
    // connection reset. The response is a sanitized
    // 400 JSON.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    // The body is JSON, not a connection-reset.
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});

describe("oauth/introspect", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    ctx = await setupApp({
      allowedResources: ["https://mcp.example.com"],
      issuer: "http://127.0.0.1:3002",
      defaultScope: "read:bi_catastro",
    });
  });

  afterEach(async () => {
    await teardownApp(ctx);
  });

  it("introspect: returns { active: true, ... } for a valid token (no `scope` in body)", async () => {
    // GIVEN a client_credentials grant that returned a token
    // WHEN we POST /oauth/introspect with the token
    // THEN the response is 200 + { active: true, sub, aud, iss }
    //      and the body MUST NOT include a `scope` field
    //      (PR 3 of `remove-scope-authorization` removes
    //      `scope` from the introspection response).
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
    expect(body.aud).toBe("https://mcp.example.com");
    expect(body.iss).toBe("http://127.0.0.1:3002");
    // The body MUST NOT include a `scope` field.
    expect(body.scope).toBeUndefined();
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
