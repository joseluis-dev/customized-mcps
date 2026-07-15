/**
 * Tests for the `/oauth/introspect` endpoint
 * (RFC 7662 introspection shape).
 *
 * PR 3 of `oauth-sqlite-admin-authorization` adds
 * a regression test for the empty-token case: the
 * spec requires the server to return 200 +
 * `{ active: false }` for an empty `token` form
 * field. The `OAuthAdminAuthority.warm()` probe
 * sends `token=` to confirm the endpoint is alive;
 * the previous handler short-circuited with 400 +
 * `{ error: "invalid_request" }`, which the
 * wrapper rejected as an unexpected body shape.
 *
 * PR 3 of `remove-scope-authorization` additionally
 * removes the `scope` field from the introspection
 * response body. The introspect endpoint MUST return
 * the canonical RFC 7662 shape (`active`, `sub`,
 * `aud`, `iss`, `iat`, `exp`) WITHOUT a `scope`
 * field. A legacy client that still expects `scope`
 * will see `undefined` (the field is omitted from
 * the JSON).
 *
 * Test layer: integration. We mount the
 * introspect handler on a real `node:http`
 * listener and POST form-encoded bodies.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase, initializeSchema } from "../../src/db/index.js";
import { createIntrospectHandler, type IntrospectHandlerDeps } from "../../src/oauth/introspect.js";

function postForm(
  port: number,
  body: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = require("node:http").request(
      {
        host: "127.0.0.1",
        port,
        path: "/oauth/introspect",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(Buffer.byteLength(body, "utf8")),
        },
      },
      (res: import("node:http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(text) as Record<string, unknown>,
            });
          } catch {
            reject(new Error(`introspect response was not JSON: ${text}`));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("oauth/introspect — empty token regression (PR 3 W4-style)", () => {
  let server: Server;
  let port: number;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    await initializeSchema(db);
    const deps: IntrospectHandlerDeps = {
      db,
      issuer: "http://127.0.0.1:3002",
      allowedResources: ["https://mcp.example.com"],
    };
    const handler = createIntrospectHandler(deps);
    server = createServer((req, res) => {
      if (req.url === "/oauth/introspect") {
        return handler(req, res);
      }
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolveP) =>
      server.listen(0, "127.0.0.1", () => resolveP()),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolveP, rejectP) => {
      server.close((err) => (err ? rejectP(err) : resolveP()));
    });
    await db.close();
  });

  it("returns 200 + { active: false } for an empty token= (RFC 7662 + OAuthAdminAuthority.warm() probe contract)", async () => {
    // Spec scenario: the `OAuthAdminAuthority.warm()`
    // probe POSTs `token=` to confirm the endpoint
    // is alive. The expected response is the
    // canonical RFC 7662 shape with `active: false`
    // (the token is empty → not active). The
    // handler MUST return 200 + the JSON shape, NOT
    // 400 + `{ error: "invalid_request" }`.
    //
    // This is the regression test for the W4-style
    // bug fixed in PR 3: the previous handler
    // short-circuited with 400 for empty tokens,
    // which the wrapper rejected as an unexpected
    // body shape. The fix delegates the empty case
    // to `introspect()`, which already returns
    // `{ active: false }`.
    const res = await postForm(port, "token=");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
    // The boolean discriminator MUST be present
    // (the wrapper checks for it specifically).
    expect(typeof res.body.active).toBe("boolean");
  });

  it("returns 200 + { active: false } for a completely missing token field", async () => {
    // The spec scenario: a request without a
    // `token` field at all. RFC 7662 says the
    // server SHOULD still respond with
    // `{ active: false }` (the token is absent →
    // not active). The handler MUST NOT return
    // 400.
    const res = await postForm(port, "");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it("returns 405 for GET (the spec mandates POST)", async () => {
    // The handler rejects non-POST with 405. The
    // wrapper does NOT probe GET; this is a
    // defense-in-depth test that the spec
    // contract is enforced.
    const res = await new Promise<{ status: number; body: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = require("node:http").request(
          {
            host: "127.0.0.1",
            port,
            path: "/oauth/introspect",
            method: "GET",
          },
          (r: import("node:http").IncomingMessage) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => {
              try {
                resolve({
                  status: r.statusCode ?? 0,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
                });
              } catch {
                reject(new Error("response was not JSON"));
              }
            });
            r.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(res.status).toBe(405);
  });
});

describe("oauth/introspect — response body has no `scope` field (PR 3 of remove-scope-authorization)", () => {
  // The mcp-oauth-authority spec requires the
  // introspection response to omit `scope`:
  //   "Introspection: `active`, `sub`, `aud`, `iss`,
  //    `iat`, `exp`. No `scope`."
  //
  // The endpoint returns the canonical RFC 7662
  // shape with the `scope` field omitted. This
  // describe pins the contract for a non-empty
  // (active) token: even when the token's payload
  // has a `scope` / `scopes` claim (e.g. a
  // pre-PR3 token), the introspection body MUST NOT
  // include `scope`.
  let server: Server;
  let port: number;
  let db: ReturnType<typeof openDatabase>;
  let deps: IntrospectHandlerDeps;

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    await initializeSchema(db);
    deps = {
      db,
      issuer: "http://127.0.0.1:3002",
      allowedResources: ["https://mcp.example.com"],
    };
    const handler = createIntrospectHandler(deps);
    server = createServer((req, res) => {
      if (req.url === "/oauth/introspect") {
        return handler(req, res);
      }
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolveP) =>
      server.listen(0, "127.0.0.1", () => resolveP()),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolveP, rejectP) => {
      server.close((err) => (err ? rejectP(err) : resolveP()));
    });
    await db.close();
  });

  it("does NOT include a `scope` field in the response body, even when the token's payload would have a `scope` claim (defensive shape)", async () => {
    // Synthesize a JWT whose payload has a `scope`
    // claim (a legacy token shape). The introspect
    // endpoint MUST NOT echo the `scope` claim into
    // the response body.
    const { generateKeyPair, exportJWK, exportPKCS8, calculateJwkThumbprint, SignJWT, importPKCS8 } = await import("jose");
    const { setActiveSigningKey } = await import("../../src/oauth/keys.js");
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    publicJwk.kid = kid;
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";
    const privatePem = await exportPKCS8(privateKey);
    await setActiveSigningKey(db, {
      id: kid,
      algorithm: "RS256",
      publicJwk,
      privatePem,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub: "user:1",
      aud: "mcp:readonly-sql",
      iss: "http://127.0.0.1:3002",
      // The legacy `scope` and `scopes` claims are
      // present in the payload, but the introspect
      // endpoint MUST NOT surface them.
      scope: "read:bi_catastro",
      scopes: ["read:bi_catastro"],
      iat: now,
      nbf: now,
      exp: now + 3600,
    })
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .sign(await importPKCS8(privatePem, "RS256"));

    const res = await postForm(port, `token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    // The `active` field is present.
    expect(res.body["active"]).toBe(true);
    // The `scope` field is OMITTED from the body.
    expect(res.body["scope"]).toBeUndefined();
  });
});
