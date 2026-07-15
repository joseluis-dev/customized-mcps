/**
 * Tests for the `/healthz` endpoint.
 *
 * The endpoint is unauthenticated (the load balancer cannot
 * carry bearer tokens). The body reports the canonical issuer
 * when set, plus the allowlist length (the URIs themselves are
 * NOT echoed so the endpoint can be scraped without leaking the
 * deploy topology).
 *
 * Status:
 *   - 200 when the authority has an active signing key
 *   - 503 when the database has no active signing key
 *   - 503 when the `unhealthy` test hook is true
 *   - 405 for non-GET
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  generateKeyPair,
  exportJWK,
  exportPKCS8,
  calculateJwkThumbprint,
} from "jose";
import { openDatabase, initializeSchema } from "../src/db/index.js";
import { setActiveSigningKey, type SigningKeyRecord } from "../src/oauth/keys.js";
import { createHealthHandler } from "../src/oauth/health.js";

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

async function startServer(
  options: Parameters<typeof createHealthHandler>[0],
): Promise<{ url: string; close: () => Promise<void> }> {
  const handler = createHealthHandler(options);
  const server: Server = createServer((req, res) => {
    if (req.url === "/healthz") return handler(req, res);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/healthz`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("health — happy path", () => {
  let db: ReturnType<typeof openDatabase>;
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    await initializeSchema(db);
    const key = await makeTestKey();
    await setActiveSigningKey(db, key);
    server = await startServer({
      db,
      oauth: {
        issuer: "https://auth.example.com",
        allowedResources: [
          "https://sql.example.com",
          "https://memos.example.com",
        ],
      },
    });
  });

  afterEach(async () => {
    await server.close();
    await db.close();
  });

  it("returns 200 + status=ok + issuer + allowlist length", async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["issuer"]).toBe("https://auth.example.com");
    expect(body["protectedResources"]).toBe(2);
  });

  it("does NOT echo the full allowlist URIs (audit-safe)", async () => {
    const res = await fetch(server.url);
    const body = (await res.json()) as Record<string, unknown>;
    const text = JSON.stringify(body);
    expect(text).not.toContain("https://sql.example.com");
    expect(text).not.toContain("https://memos.example.com");
  });

  it("returns 405 + Allow: GET for non-GET requests", async () => {
    const res = await fetch(server.url, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("health — degraded", () => {
  it("returns 503 when the authority has no active signing key", async () => {
    const db = openDatabase({ path: ":memory:" });
    await initializeSchema(db);
    const server = await startServer({
      db,
      oauth: { issuer: "https://auth.example.com", allowedResources: [] },
    });
    try {
      const res = await fetch(server.url);
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["status"]).toBe("unhealthy");
    } finally {
      await server.close();
      await db.close();
    }
  });

  it("returns 503 when the test hook forces unhealthy", async () => {
    const db = openDatabase({ path: ":memory:" });
    await initializeSchema(db);
    const key = await makeTestKey();
    await setActiveSigningKey(db, key);
    const server = await startServer({
      db,
      unhealthy: () => true,
    });
    try {
      const res = await fetch(server.url);
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["status"]).toBe("unhealthy");
    } finally {
      await server.close();
      await db.close();
    }
  });

  it("omits issuer + allowlist fields when OAuth wiring is disabled", async () => {
    const db = openDatabase({ path: ":memory:" });
    await initializeSchema(db);
    const key = await makeTestKey();
    await setActiveSigningKey(db, key);
    const server = await startServer({ db });
    try {
      const res = await fetch(server.url);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["status"]).toBe("ok");
      expect(body["issuer"]).toBeUndefined();
      expect(body["protectedResources"]).toBeUndefined();
    } finally {
      await server.close();
      await db.close();
    }
  });
});