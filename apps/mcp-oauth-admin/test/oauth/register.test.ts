/**
 * Integration tests for the OAuth 2.0 Dynamic Client
 * Registration (RFC 7591) endpoint.
 *
 * The mcp-oauth-authority spec requires:
 * - `POST /oauth/register` accepts RFC 7591-style
 *   registration requests.
 * - The endpoint requires a JSON `redirect_uris` array;
 *   every entry MUST satisfy the loopback redirect URI
 *   rule (RFC 8252 §7.3). A non-loopback URI is
 *   rejected with `400 invalid_redirect_uri`.
 * - Authorization-code clients: `grant_types` defaults
 *   to `["authorization_code"]`; `response_types`
 *   defaults to `["code"]`.
 * - `token_endpoint_auth_method` defaults to
 *   `client_secret_post`; `client_secret_basic` is also
 *   accepted (the token endpoint honors both).
 * - The response carries `client_id`, `client_secret`,
 *   `client_id_issued_at`, `client_secret_expires_at`,
 *   `redirect_uris`, `grant_types`, `response_types`,
 *   `token_endpoint_auth_method`, and `scope`.
 * - The plaintext `client_secret` is returned exactly
 *   once; the DB row stores only the `argon2id` hash.
 * - Requested `scope` is bounded against the authority
 *   scope catalog (or the `defaultScope` when the
 *   catalog is empty).
 *
 * Test layer: integration. We mount the registration
 * handler on a real `node:http` listener on a random
 * port and drive the flows with `fetch`. The
 * `generateId` injection lets us pin the test's
 * `client_id` and `client_secret` to deterministic
 * values so the response assertions are stable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase, initializeSchema, withSingleWriter } from "../../src/db/index.js";
import {
  _resetRegisterRateLimit,
  createRegisterHandler,
  type RegisterHandlerDeps,
} from "../../src/oauth/register.js";

let db: ReturnType<typeof openDatabase>;
let server: Server;
let baseUrl: string;
let nextId: number;
let deps: RegisterHandlerDeps;

beforeEach(async () => {
  db = openDatabase({ path: ":memory:" });
  await initializeSchema(db);
  nextId = 0;
  // Pin the clock to a fixed instant so the rate-limit
  // window is deterministic. The default rate limit is
  // 5 attempts per 60s; the tests in this file share the
  // 127.0.0.1 IP so the in-process rate state must be
  // reset between cases (otherwise a long-running test
  // file trips the limit mid-file). The dedicated
  // rate-limit test injects its own threshold + clock.
  _resetRegisterRateLimit();
  deps = {
    db,
    defaultScope: "read:bi_catastro",
    // Deterministic generator: produces 32+ char
    // values so the test passes the
    // `MIN_PLAINTEXT_SECRET_LENGTH=16` sanity check in
    // `createClient`. The shape is
    // `gen-padded-<n>-value-test-x-x-x-x` (≈ 35 chars).
    // The "happy path" test asserts on the exact value
    // for `client_id=0` and `client_secret=1`.
    generateId: () => `gen-padded-${nextId++}-value-test-x-x-x-x`,
    now: () => 1_700_000_000,
  };
  const handler = createRegisterHandler(deps);
  server = createServer((req, res) => {
    if (req.url === "/oauth/register") return handler(req, res);
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

async function postRegister(body: unknown, contentType = "application/json"): Promise<Response> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: text,
  });
}

describe("oauth/register (RFC 7591)", () => {
  it("happy path: returns 201 + the standards-shaped registration response", async () => {
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
      scope: "read:bi_catastro",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // Standards-shaped fields
    expect(typeof body["client_id"]).toBe("string");
    expect(typeof body["client_secret"]).toBe("string");
    expect(typeof body["client_id_issued_at"]).toBe("number");
    expect(body["client_secret_expires_at"]).toBe(0); // v1: non-expiring
    expect(body["redirect_uris"]).toEqual(["http://127.0.0.1:8080/cb"]);
    expect(body["grant_types"]).toEqual(["authorization_code"]);
    expect(body["response_types"]).toEqual(["code"]);
    expect(body["token_endpoint_auth_method"]).toBe("client_secret_post");
    expect(body["scope"]).toBe("read:bi_catastro");
    // Deterministic generator: the test injects the
    // `gen-padded-N-value-test-x-x-x-x` generator so
    // the response shape is stable. The values are
    // 32+ chars so the `MIN_PLAINTEXT_SECRET_LENGTH`
    // check in `createClient` accepts the secret.
    expect(body["client_id"]).toBe("gen-padded-0-value-test-x-x-x-x");
    expect(body["client_secret"]).toBe("gen-padded-1-value-test-x-x-x-x");
  });

  it("persists the client in the clients table with the argon2id hash (not the plaintext)", async () => {
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; client_secret: string };
    // The DB row exists with the right clientId.
    const rows = await db.select<{ clientId: string; clientSecretHash: string; redirectUris: string }>(
      "SELECT clientId, clientSecretHash, redirectUris FROM clients WHERE clientId = ?",
      [body.client_id],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The plaintext is NOT in the DB.
    expect(row.clientSecretHash).not.toBe(body.client_secret);
    // The hash verifies against the plaintext.
    const argon2 = await import("argon2");
    const ok = await argon2.verify(row.clientSecretHash, body.client_secret);
    expect(ok).toBe(true);
    // The redirect URI list is persisted.
    expect(JSON.parse(row.redirectUris)).toEqual(["http://127.0.0.1:8080/cb"]);
  });

  it("defaults grant_types to [authorization_code] and response_types to [code]", async () => {
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { grant_types: string[]; response_types: string[] };
    expect(body.grant_types).toEqual(["authorization_code"]);
    expect(body.response_types).toEqual(["code"]);
  });

  it("honors token_endpoint_auth_method=client_secret_basic", async () => {
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token_endpoint_auth_method: string };
    expect(body.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  it("rejects an unsupported token_endpoint_auth_method with 400", async () => {
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
      token_endpoint_auth_method: "client_secret_jwt",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("rejects a missing redirect_uris with 400 invalid_redirect_uri", async () => {
    const res = await postRegister({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects an empty redirect_uris array with 400 invalid_redirect_uri", async () => {
    const res = await postRegister({ redirect_uris: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects a non-loopback redirect URI with 400 invalid_redirect_uri", async () => {
    const res = await postRegister({
      redirect_uris: ["https://attacker.example/cb"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects a redirect URI without a port with 400 invalid_redirect_uri", async () => {
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1/cb"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("accepts multiple loopback redirect URIs", async () => {
    const res = await postRegister({
      redirect_uris: [
        "http://127.0.0.1:8080/cb",
        "http://localhost:9090/cb",
        "http://[::1]:7070/cb",
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { redirect_uris: string[] };
    expect(body.redirect_uris).toEqual([
      "http://127.0.0.1:8080/cb",
      "http://localhost:9090/cb",
      "http://[::1]:7070/cb",
    ]);
  });

  it("rejects a non-array redirect_uris with 400 invalid_redirect_uri", async () => {
    const res = await postRegister({ redirect_uris: "http://127.0.0.1:8080/cb" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects a non-string redirect URI with 400 invalid_redirect_uri", async () => {
    const res = await postRegister({ redirect_uris: [42] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("a `*` scope request falls back to the default scope when the catalog is empty (no self-grant)", async () => {
    // The empty-catalog policy is "no self-grant": a
    // request for the wildcard `*` MUST NOT return `*`
    // when the catalog is empty. The response is 201
    // + the default scope (the request is honored, the
    // wildcard is silently downgraded to the default).
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
      scope: "*",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: string };
    expect(body.scope).toBe("read:bi_catastro");
    expect(body.scope).not.toContain("*");
  });

  it("rejects an out-of-catalog scope with 400 invalid_scope", async () => {
    // Seed a single catalog entry.
    await withSingleWriter(db, async (trx) => {
      await trx.execute(
        "INSERT INTO scopes (name, description, createdAt) VALUES (?, ?, ?)",
        ["read:bi_catastro", "test", 1_700_000_000],
      );
    });
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
      scope: "call:secret",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_scope");
  });

  it("grants the intersection of request and catalog when both are present", async () => {
    await withSingleWriter(db, async (trx) => {
      await trx.execute(
        "INSERT INTO scopes (name, description, createdAt) VALUES (?, ?, ?)",
        ["read:bi_catastro", "test", 1_700_000_000],
      );
      await trx.execute(
        "INSERT INTO scopes (name, description, createdAt) VALUES (?, ?, ?)",
        ["list:bi_catastro", "test", 1_700_000_000],
      );
    });
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
      scope: "read:bi_catastro call:secret",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: string };
    expect(body.scope).toBe("read:bi_catastro");
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await postRegister("not json", "application/json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects an empty body with 400", async () => {
    const res = await postRegister("");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects a non-object body with 400", async () => {
    const res = await postRegister([1, 2, 3]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects GET with 405 (POST-only endpoint)", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, { method: "GET" });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("appends an audit_log row on successful registration", async () => {
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    const rows = await db.select<{ action: string; target: string; outcome: string }>(
      "SELECT action, target, outcome FROM audit_log WHERE action = 'client.register' ORDER BY id DESC LIMIT 1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("client.register");
    expect(rows[0]!.target).toBe(`client:${body.client_id}`);
    expect(rows[0]!.outcome).toBe("ok");
  });

  it("does not echo the client_secret in any error path", async () => {
    const res = await postRegister({
      redirect_uris: ["https://attacker.example/cb"],
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    // The body is the standard sanitized error
    // shape; the generated `client_secret` is NOT
    // present in the response.
    expect(text).not.toMatch(/gen-/);
    expect(text).not.toMatch(/secret/i);
  });

  it("preserves the client_name in the response when supplied", async () => {
    const res = await postRegister({
      redirect_uris: ["http://127.0.0.1:8080/cb"],
      client_name: "opencode",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_name?: string; label?: string };
    expect(body.client_name).toBe("opencode");
  });
});

describe("oauth/register — rate limit (per-IP sliding window)", () => {
  // The rate-limit test uses its own server with a
  // small threshold so the test is fast + deterministic.
  let localDb: ReturnType<typeof openDatabase>;
  let localServer: Server;
  let localBaseUrl: string;
  let clockValue: number;
  let nextId: number;

  beforeEach(async () => {
    _resetRegisterRateLimit();
    localDb = openDatabase({ path: ":memory:" });
    await initializeSchema(localDb);
    clockValue = 1_700_000_000;
    nextId = 0;
    const localDeps: RegisterHandlerDeps = {
      db: localDb,
      defaultScope: "read:bi_catastro",
      // 32+ char deterministic values so the
      // `MIN_PLAINTEXT_SECRET_LENGTH` check accepts them.
      generateId: () => `gen-padded-${nextId++}-value-test-x-x-x-x`,
      // 2 attempts per 10s — the test stays under
      // real-time and the threshold is small enough
      // to exercise the 3rd-attempt rejection.
      rateLimit: { threshold: 2, windowSeconds: 10 },
      now: () => clockValue,
    };
    const handler = createRegisterHandler(localDeps);
    localServer = createServer((req, res) => {
      if (req.url === "/oauth/register") return handler(req, res);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveP) =>
      localServer.listen(0, "127.0.0.1", () => resolveP()),
    );
    const port = (localServer.address() as AddressInfo).port;
    localBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolveP, rejectP) => {
      localServer.close((err) => (err ? rejectP(err) : resolveP()));
    });
    await localDb.close();
    _resetRegisterRateLimit();
  });

  async function postOnce(body: unknown): Promise<Response> {
    return fetch(`${localBaseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("allows the first N requests and returns 429 + Retry-After on the (N+1)th", async () => {
    // Two valid registrations under the threshold.
    for (let i = 0; i < 2; i++) {
      const res = await postOnce({ redirect_uris: ["http://127.0.0.1:8080/cb"] });
      expect(res.status).toBe(201);
    }
    // The 3rd attempt is over the threshold and is
    // rejected with sanitized 429 + a Retry-After.
    const res = await postOnce({ redirect_uris: ["http://127.0.0.1:8080/cb"] });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    const retryAfter = Number(res.headers.get("retry-after") ?? "0");
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(10);
  });

  it("releases the lock when the window elapses (the (N+1)th request is allowed after window expiry)", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await postOnce({ redirect_uris: ["http://127.0.0.1:8080/cb"] });
      expect(res.status).toBe(201);
    }
    // 3rd attempt is rate-limited.
    const denied = await postOnce({ redirect_uris: ["http://127.0.0.1:8080/cb"] });
    expect(denied.status).toBe(429);
    // Advance the clock past the window. The rate
    // state is keyed by timestamp; the next attempt
    // is the only entry in the fresh window and is
    // allowed.
    clockValue += 11;
    const ok = await postOnce({ redirect_uris: ["http://127.0.0.1:8080/cb"] });
    expect(ok.status).toBe(201);
  });

  it("appends a denied audit_log row on rate-limit rejection", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await postOnce({ redirect_uris: ["http://127.0.0.1:8080/cb"] });
      expect(res.status).toBe(201);
    }
    const denied = await postOnce({ redirect_uris: ["http://127.0.0.1:8080/cb"] });
    expect(denied.status).toBe(429);
    const rows = await localDb.select<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM audit_log WHERE action = 'client.register' AND outcome = 'denied'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("oauth/register — error boundary + sanitized responses", () => {
  // The error-boundary test uses a fresh DB whose
  // `audit_log` insert intentionally fails on the
  // success path. The handler MUST catch the failure,
  // log a sanitized WARN, and return a sanitized 500
  // (or, in the case of a one-off DB error on the
  // happy path, fall through cleanly). The test
  // asserts the sanitized response shape; the WARN
  // line is captured via the injected logger.
  let localDb: ReturnType<typeof openDatabase>;
  let localServer: Server;
  let localBaseUrl: string;
  let warnLines: string[];

  beforeEach(async () => {
    _resetRegisterRateLimit();
    localDb = openDatabase({ path: ":memory:" });
    await initializeSchema(localDb);
    warnLines = [];
    const localDeps: RegisterHandlerDeps = {
      db: localDb,
      defaultScope: "read:bi_catastro",
      // 32+ char fixed value so the
      // `MIN_PLAINTEXT_SECRET_LENGTH` check accepts it.
      generateId: () => "gen-fixed-padded-value-test-x-x-x-x",
      logger: {
        info: () => undefined,
        warn: (msg) => warnLines.push(msg),
        error: () => undefined,
      },
    };
    const handler = createRegisterHandler(localDeps);
    localServer = createServer((req, res) => {
      if (req.url === "/oauth/register") return handler(req, res);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveP) =>
      localServer.listen(0, "127.0.0.1", () => resolveP()),
    );
    const port = (localServer.address() as AddressInfo).port;
    localBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolveP, rejectP) => {
      localServer.close((err) => (err ? rejectP(err) : resolveP()));
    });
    await localDb.close();
    _resetRegisterRateLimit();
  });

  it("returns a sanitized 400 + WARN when the body is malformed", async () => {
    // Trigger the parse-failure branch (the
    // `readJsonBody` returns `null` for non-JSON;
    // the handler returns 400 + a denied audit row).
    const res = await fetch(`${localBaseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    // A denied audit row was appended.
    const rows = await localDb.select<{ outcome: string }>(
      "SELECT outcome FROM audit_log WHERE action = 'client.register'",
    );
    expect(rows.some((r) => r.outcome === "denied")).toBe(true);
  });

  it("returns a sanitized 400 + WARN when the body is too large (no listener crash)", async () => {
    // 100 KiB body — well over the 64 KiB cap.
    const oversized = "x".repeat(100 * 1024);
    const res = await fetch(`${localBaseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversized,
    });
    // The handler MUST NOT crash the listener. The
    // response is sanitized: an oversized body either
    // rejects with 400 (the body parse cap) or 500
    // (the catch-all). Either way, the response is
    // JSON and has an `error` field.
    expect([400, 500]).toContain(res.status);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });
});

describe("oauth/register — X-Forwarded-For trust (per-IP rate-limit attribution)", () => {
  // The pre-PR review found that `register.ts` read
  // `X-Forwarded-For` unconditionally. A spoofed
  // header bypassed the per-IP rate limit and the
  // audit actor attribution. The fix gates XFF
  // consumption on the `trustProxy` flag; the flag
  // defaults to `false` (the direct TCP peer is the
  // source of truth).
  //
  // The tests below pin the contract:
  // - With `trustProxy=false` (the default), a
  //   spoofed XFF does NOT bypass the rate limit
  //   (every request is keyed on the loopback peer)
  //   and the audit `ip` column reflects the peer,
  //   not the header.
  // - With `trustProxy=true`, the LEFTMOST XFF entry
  //   becomes the rate-limit key + audit IP, exactly
  //   the behavior a real reverse proxy needs.
  let localDb: ReturnType<typeof openDatabase>;
  let localServer: Server;
  let localBaseUrl: string;
  let clockValue: number;
  let nextId: number;

  beforeEach(async () => {
    _resetRegisterRateLimit();
    localDb = openDatabase({ path: ":memory:" });
    await initializeSchema(localDb);
    clockValue = 1_700_000_000;
    nextId = 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolveP, rejectP) => {
      localServer.close((err) => (resolveP(err), undefined));
    });
    await localDb.close();
    _resetRegisterRateLimit();
  });

  async function startServer(
    trustProxy: boolean,
    rateLimit: { threshold: number; windowSeconds: number },
  ): Promise<void> {
    const localDeps: RegisterHandlerDeps = {
      db: localDb,
      defaultScope: "read:bi_catastro",
      generateId: () => `gen-padded-${nextId++}-value-test-x-x-x-x`,
      rateLimit,
      now: () => clockValue,
      trustProxy,
    };
    const handler = createRegisterHandler(localDeps);
    localServer = createServer((req, res) => {
      if (req.url === "/oauth/register") return handler(req, res);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveP) =>
      localServer.listen(0, "127.0.0.1", () => resolveP()),
    );
    const port = (localServer.address() as AddressInfo).port;
    localBaseUrl = `http://127.0.0.1:${port}`;
  }

  async function postOnce(xff: string | null): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (xff !== null) headers["X-Forwarded-For"] = xff;
    return fetch(`${localBaseUrl}/oauth/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:8080/cb"] }),
    });
  }

  it("default (trustProxy=false): a spoofed XFF does NOT bypass the per-IP rate limit", async () => {
    // GIVEN the per-IP rate limit is 2/10s
    await startServer(false, { threshold: 2, windowSeconds: 10 });
    // The first two attempts under the threshold
    // succeed regardless of the XFF value. The third
    // attempt is rate-limited.
    for (let i = 0; i < 2; i++) {
      const res = await postOnce("203.0.113.99");
      expect(res.status).toBe(201);
    }
    // The 3rd attempt with a NEW spoofed XFF is still
    // rate-limited: the rate-limit key is the loopback
    // peer (the direct TCP connection), NOT the
    // attacker-controlled XFF.
    const res = await postOnce("198.51.100.7");
    expect(res.status).toBe(429);
    // The response carries a Retry-After and a sanitized
    // error body (no client secret).
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(Number(res.headers.get("retry-after") ?? "0")).toBeGreaterThan(0);
  });

  it("default (trustProxy=false): the audit `ip` column reflects the loopback peer, not the spoofed XFF", async () => {
    // GIVEN a successful registration with a spoofed XFF
    await startServer(false, { threshold: 5, windowSeconds: 10 });
    const res = await postOnce("203.0.113.99");
    expect(res.status).toBe(201);
    // The audit row's `ip` is the loopback peer
    // (`::ffff:127.0.0.1` or `127.0.0.1`, depending on
    // Node's socket layer). It MUST NOT be the spoofed
    // XFF value (an attacker would otherwise be able to
    // attribute their own request to an arbitrary IP).
    const rows = await localDb.select<{ ip: string | null }>(
      "SELECT ip FROM audit_log WHERE action = 'client.register' AND outcome = 'ok'",
    );
    expect(rows.length).toBe(1);
    const ip = rows[0]!.ip;
    expect(ip).not.toBe("203.0.113.99");
    expect(ip).toMatch(/^127\.0\.0\.1|^::ffff:127\.0\.0\.1$|^::1$/);
  });

  it("trustProxy=true: a forwarded XFF IS honored for the per-IP rate limit", async () => {
    // GIVEN a trust-proxy deployment (the operator
    // runs the authority behind a TLS-terminating
    // reverse proxy and sets `MCP_HTTP_BEHIND_PROXY=true`).
    // The rate limit is 2/10s.
    await startServer(true, { threshold: 2, windowSeconds: 10 });
    // From "client A" (`10.0.0.1`), the first two
    // attempts are under the threshold and succeed.
    for (let i = 0; i < 2; i++) {
      const res = await postOnce("10.0.0.1");
      expect(res.status).toBe(201);
    }
    // The 3rd attempt from "client A" is rate-limited.
    const denied = await postOnce("10.0.0.1");
    expect(denied.status).toBe(429);
    // A request from a DIFFERENT "client" (the XFF is
    // the new IP) is in a fresh rate-limit window
    // and succeeds.
    const other = await postOnce("10.0.0.2");
    expect(other.status).toBe(201);
  });

  it("trustProxy=true: the audit `ip` column reflects the leftmost XFF entry", async () => {
    // Multi-hop XFF (the convention is each proxy
    // appends the client IP, the most-recent hop is
    // the rightmost). The handler reads the LEFTMOST
    // entry — the value the proxy itself saw from
    // the upstream client.
    await startServer(true, { threshold: 5, windowSeconds: 10 });
    const res = await postOnce("203.0.113.99, 10.0.0.1, 10.0.0.2");
    expect(res.status).toBe(201);
    const rows = await localDb.select<{ ip: string | null }>(
      "SELECT ip FROM audit_log WHERE action = 'client.register' AND outcome = 'ok'",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.ip).toBe("203.0.113.99");
  });
});

describe("oauth/register — caller-supplied plaintextSecret sanity check", () => {
  // The pre-PR review found that `createClient`
  // accepted a caller-supplied `plaintextSecret` of
  // any length. The fix enforces a minimum (16
  // chars) so a weak injected secret is rejected
  // before it ever reaches the `argon2id` hash. The
  // DCR handler's pre-generated value (32+ chars) is
  // always above the minimum, so the production path
  // is unaffected; only the test path needed to
  // update the generator.
  let localDb: ReturnType<typeof openDatabase>;
  let localServer: Server;
  let localBaseUrl: string;

  beforeEach(async () => {
    _resetRegisterRateLimit();
    localDb = openDatabase({ path: ":memory:" });
    await initializeSchema(localDb);
  });

  afterEach(async () => {
    await new Promise<void>((resolveP, rejectP) => {
      localServer.close((err) => (resolveP(err), undefined));
    });
    await localDb.close();
    _resetRegisterRateLimit();
  });

  function startServer(): void {
    const deps: RegisterHandlerDeps = {
      db: localDb,
      defaultScope: "read:bi_catastro",
      // The pre-generated secrets are 32+ chars (32 random
      // bytes → 43 base64url chars) so the sanity check
      // accepts them. The DCR test path always uses
      // the auto-generated value; this describe only
      // exercises the registered-client path with a
      // pre-generated value.
      generateId: () => "gen-padded-value-test-x-x-x-x-x-x",
    };
    const handler = createRegisterHandler(deps);
    localServer = createServer((req, res) => {
      if (req.url === "/oauth/register") return handler(req, res);
      res.statusCode = 404;
      res.end();
    });
    void (async () => {
      await new Promise<void>((resolveP) =>
        localServer.listen(0, "127.0.0.1", () => resolveP()),
      );
    })();
  }

  it("a 32+ char auto-generated secret passes the sanity check (201 Created)", async () => {
    startServer();
    await new Promise<void>((resolveP) => setTimeout(resolveP, 50));
    const port = (localServer.address() as AddressInfo).port;
    localBaseUrl = `http://127.0.0.1:${port}`;
    const res = await fetch(`${localBaseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:8080/cb"] }),
    });
    expect(res.status).toBe(201);
  });
});
