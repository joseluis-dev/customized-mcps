/**
 * Unit tests for `OAuthAdminAuthority`.
 *
 * The mcp-oauth-authority spec requires:
 * - `OAuthAdminAuthority` extends `JwksAuthority` and is the
 *   production backend the resource server picks when
 *   `MCP_AUTHORITY_URL` is set.
 * - `OAuthAdminAuthority.warm()` POSTs
 *   `application/x-www-form-urlencoded` `token=` to
 *   `/oauth/introspect` against the authority URL.
 * - The startup probe exits non-zero on:
 *   - connection refused
 *   - TLS / DNS errors
 *   - 5xx responses
 *   - unexpected body (anything other than a JSON object
 *     with `active` boolean)
 *
 * The wrapper inherits the JWKS-based `verify` from
 * `JwksAuthority` (so the resource server's middleware
 * works unchanged); the only addition is the warm-time
 * probe.
 *
 * Test layer: unit. We use a real `node:http` listener
 * serving a real introspect handler so the probe exercises
 * the full network path. A `vi.stubGlobal("fetch", ...)`
 * is used to redirect the probe to the test listener.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { OAuthAdminAuthority } from "../../src/authority/oauthAdmin.js";
import type { Logger } from "../../src/index.js";

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

describe("OAuthAdminAuthority", () => {
  let server: Server;
  let baseUrl: string;
  let captured: { url?: string; method?: string; body?: string };

  beforeEach(async () => {
    captured = {};
    server = createServer((req, res) => {
      // Capture the request details for the test to assert on.
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured.url = req.url;
        captured.method = req.method;
        captured.body = Buffer.concat(chunks).toString("utf8");
        if (req.url === "/oauth/introspect" && req.method === "POST") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ active: false }));
        } else if (req.url === "/.well-known/jwks.json" && req.method === "GET") {
          // The parent JWKS class's `super.warm()` probes
          // this URL. Return an empty JWK Set so the
          // parent check succeeds; the OAuth-specific
          // probe then runs against /oauth/introspect.
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ keys: [] }));
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolveP) => server.listen(0, "127.0.0.1", () => resolveP()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolveP, rejectP) => {
      server.close((err) => (err ? rejectP(err) : resolveP()));
    });
  });

  it("warm() POSTs to /oauth/introspect with token= in form body", async () => {
    // GIVEN an OAuthAdminAuthority pointed at the test listener
    // WHEN we call warm()
    // THEN the listener sees POST /oauth/introspect with a
    //      form-encoded body that includes `token=`. The
    //      warm() does NOT throw when the response is the
    //      expected { active: false } shape.
    const auth = new OAuthAdminAuthority({
      issuer: baseUrl,
      jwksUrl: `${baseUrl}/.well-known/jwks.json`,
      audience: "mcp:readonly-sql",
      ttlSeconds: 60,
      leewaySeconds: 30,
      fetchTimeoutMs: 5000,
      logger: silentLogger(),
    });
    await expect(auth.warm()).resolves.toBeUndefined();
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/oauth/introspect");
    expect(captured.body).toMatch(/^token=/);
  });

  it("warm() throws on a 5xx response (refuse to start with a broken authority)", async () => {
    // GIVEN a server that returns 503 on /oauth/introspect
    // WHEN we call warm()
    // THEN the promise rejects. The wrapper MUST NOT silently
    //      start; the resource server's startup is fail-closed.
    const failingServer = createServer((_req, res) => {
      res.statusCode = 503;
      res.end("upstream unavailable");
    });
    await new Promise<void>((resolveP) => failingServer.listen(0, "127.0.0.1", () => resolveP()));
    const failingPort = (failingServer.address() as AddressInfo).port;
    const failingUrl = `http://127.0.0.1:${failingPort}`;
    try {
      const auth = new OAuthAdminAuthority({
        issuer: failingUrl,
        jwksUrl: `${failingUrl}/.well-known/jwks.json`,
        audience: "mcp:readonly-sql",
        ttlSeconds: 60,
        leewaySeconds: 30,
        fetchTimeoutMs: 5000,
        logger: silentLogger(),
      });
      await expect(auth.warm()).rejects.toThrow(/introspect|5\d\d|503|unavailable/i);
    } finally {
      await new Promise<void>((resolveP, rejectP) => {
        failingServer.close((err) => (err ? rejectP(err) : resolveP()));
      });
    }
  });

  it("warm() throws on a non-JSON body (unexpected body shape)", async () => {
    // GIVEN a server that returns 200 + plain text (not JSON)
    // WHEN we call warm()
    // THEN the promise rejects. The wrapper requires the
    //      canonical RFC 7662 shape; anything else is
    //      treated as a misconfiguration.
    const badServer = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("not json");
    });
    await new Promise<void>((resolveP) => badServer.listen(0, "127.0.0.1", () => resolveP()));
    const badPort = (badServer.address() as AddressInfo).port;
    const badUrl = `http://127.0.0.1:${badPort}`;
    try {
      const auth = new OAuthAdminAuthority({
        issuer: badUrl,
        jwksUrl: `${badUrl}/.well-known/jwks.json`,
        audience: "mcp:readonly-sql",
        ttlSeconds: 60,
        leewaySeconds: 30,
        fetchTimeoutMs: 5000,
        logger: silentLogger(),
      });
      await expect(auth.warm()).rejects.toThrow(/introspect|unexpected|body|json/i);
    } finally {
      await new Promise<void>((resolveP, rejectP) => {
        badServer.close((err) => (err ? rejectP(err) : resolveP()));
      });
    }
  });

  it("warm() throws on connection refused (authority down at start)", async () => {
    // GIVEN an authority URL pointing at a closed port
    // WHEN we call warm()
    // THEN the promise rejects. The resource server's
    //      startup MUST fail closed when the authority is
    //      unreachable.
    const auth = new OAuthAdminAuthority({
      issuer: "http://127.0.0.1:1", // port 1 is reserved / not bound
      jwksUrl: "http://127.0.0.1:1/.well-known/jwks.json",
      audience: "mcp:readonly-sql",
      ttlSeconds: 60,
      leewaySeconds: 30,
      fetchTimeoutMs: 1000,
      logger: silentLogger(),
    });
    await expect(auth.warm()).rejects.toThrow();
  });

  it("warm() returns a 200 + unexpected JSON shape (active is not boolean) is also rejected", async () => {
    // GIVEN a server that returns 200 + { "ok": true } (no `active`)
    // WHEN we call warm()
    // THEN the promise rejects. The probe requires the
    //      canonical shape; missing `active` is a misconfig.
    const misconfigured = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolveP) => misconfigured.listen(0, "127.0.0.1", () => resolveP()));
    const port = (misconfigured.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    try {
      const auth = new OAuthAdminAuthority({
        issuer: url,
        jwksUrl: `${url}/.well-known/jwks.json`,
        audience: "mcp:readonly-sql",
        ttlSeconds: 60,
        leewaySeconds: 30,
        fetchTimeoutMs: 5000,
        logger: silentLogger(),
      });
      await expect(auth.warm()).rejects.toThrow(/active|shape|unexpected/i);
    } finally {
      await new Promise<void>((resolveP, rejectP) => {
        misconfigured.close((err) => (err ? rejectP(err) : resolveP()));
      });
    }
  });

  // PR 3 W4 regression: the wrapper used to read `issuer` and
  // `fetchTimeoutMs` via `(this as unknown as { ... })` casts.
  // The fields are now `protected readonly` on `JwksAuthority`,
  // so the wrapper reads them directly. This test pins both the
  // type-safety (the test would not compile if the fields were
  // `private` again) and the runtime values (the wrapper's
  // introspect probe must hit the right host with the right
  // timeout).
  it("W4 regression: subclass reads protected issuer + fetchTimeoutMs without a cast and uses them in the probe", async () => {
    // Subclass that exposes the protected fields via public
    // accessors. If the parent fields were `private`, this
    // would not compile. If a future maintainer reverts them
    // to `private`, the test file would fail to type-check
    // and the regression would be caught at the build step.
    class ProbeAuthority extends OAuthAdminAuthority {
      public exposedIssuer(): string {
        return this.issuer;
      }
      public exposedFetchTimeoutMs(): number {
        return this.fetchTimeoutMs;
      }
    }
    const auth = new ProbeAuthority({
      issuer: baseUrl,
      jwksUrl: `${baseUrl}/.well-known/jwks.json`,
      audience: "mcp:readonly-sql",
      ttlSeconds: 60,
      leewaySeconds: 30,
      fetchTimeoutMs: 5000,
      logger: silentLogger(),
    });
    // The exposed values match the constructor options (no
    // mutation). This is the binding contract: the probe
    // must use the same issuer / timeout the operator wired.
    expect(auth.exposedIssuer()).toBe(baseUrl);
    expect(auth.exposedFetchTimeoutMs()).toBe(5000);
    // And the probe still works end-to-end.
    await expect(auth.warm()).resolves.toBeUndefined();
    expect(captured.url).toBe("/oauth/introspect");
  });

  // PR 3 W4 regression: the source of `OAuthAdminAuthority`
  // MUST NOT contain a TypeScript cast to `unknown` to read
  // the parent's `issuer` or `fetchTimeoutMs`. The cast was
  // the original footgun; this lint pins the new design.
  it("W4 regression: the source of OAuthAdminAuthority contains no 'as unknown as' cast for parent fields", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { resolve, dirname } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    // Walk up to the package root (test/authority/ -> package root).
    const pkgRoot = resolve(here, "..", "..");
    const source = readFileSync(
      resolve(pkgRoot, "src", "authority", "oauthAdmin.ts"),
      "utf8",
    );
    // The specific forbidden pattern: a cast to access a
    // parent's private field. Future maintainers that need
    // a value from the parent should either (a) widen the
    // parent field to `protected`, or (b) add a `protected
    // getter` on the parent.
    expect(source).not.toMatch(/\(\s*this\s+as\s+unknown\s+as\s*\{/);
  });
});
