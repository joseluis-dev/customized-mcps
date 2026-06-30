/**
 * TDD tests for PR 2 of `remove-scope-authorization`:
 * the mcp-readonly-sql tool surface must drop the scope catalog
 * entirely and treat `requiredScope` as decorative metadata.
 *
 * Acceptance criteria (from the `mcp-tool-surface` and
 * `mcp-agent-authorization` deltas, plus the design and tasks
 * artifacts):
 *
 *  1. `apps/mcp-readonly-sql/src/config/scopeCatalog.ts` is GONE.
 *  2. `apps/mcp-readonly-sql/src/index.ts` does NOT import
 *     `buildScopeCatalog` and does NOT pass a `scopeCatalog` closure
 *     to the HTTP transport.
 *  3. `apps/mcp-readonly-sql/src/transports/http.ts` does NOT accept
 *     a `scopeCatalog` option and does NOT forward one to the shared
 *     base.
 *  4. The well-known endpoint (`/.well-known/oauth-protected-resource`)
 *     always advertises `scopes_supported: []` — regardless of how
 *     many profiles are configured and regardless of any
 *     `MCP_RESOURCE_SCOPES` env override.
 *  5. Any authenticated agent can call any tool — no `403` is
 *     produced by a scope mismatch (scope enforcement is removed).
 *  6. The `requiredScope` field on a tool definition is decorative:
 *     if a tool ever ships with a value (existing tools keep theirs
 *     as-is), the runtime MUST NOT use it to make an access decision.
 *
 * These tests are the safety net for tasks 2.1, 2.2, and 2.3 of the
 * tasks.md. They run on the source tree (the test framework resolves
 * the shared base via the workspace's `dist/` because pnpm links
 * the package to the compiled output, so the runtime contract is
 * verified against the shared base as installed; the source-level
 * guarantees are verified by reading the source files directly).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { runHttpTransport } from "../src/transports/http.js";
import { buildReadOnlyMcpServer } from "../src/serverFactory.js";
import {
  type HttpRuntimeConfig,
} from "../src/config/http.js";
import {
  TokenInvalidError,
  type TokenAuthority,
  type VerifiedToken,
} from "@customized-mcps/mcp-http-base";
import type { Profile, SafetyLimits } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const SRC = (rel: string): string => resolve(APP_ROOT, "src", rel);

function readSource(rel: string): string {
  return readFileSync(SRC(rel), "utf8");
}

/**
 * A hand-rolled `TokenAuthority` that accepts any non-empty token
 * and maps it to a fixed agent id. The shared base resolves the
 * scope claim as `[]` regardless of input (per PR 1). This is the
 * mirror of the test helper in `transports/http.test.ts`; we keep
 * a local copy because the test file must stand alone in the
 * strict-TDD evidence table.
 */
function anyAgentAuthority(): TokenAuthority {
  return {
    verify: async (token: string): Promise<VerifiedToken> => {
      if (token.length === 0) {
        throw new TokenInvalidError("empty token");
      }
      return { agentId: "agent-pr2", scopes: [] };
    },
  };
}

const TEST_LIMITS: SafetyLimits = {
  maxRowsDefault: 100,
  maxRowsHardLimit: 1000,
  queryTimeoutMsDefault: 10_000,
  queryTimeoutMsHardLimit: 60_000,
};

const FAKE_SQLITE_PROFILE: Profile = {
  name: "SQLITE_FAKE",
  alias: "SQLITE_FAKE",
  operatorKey: "SQLITE_FAKE",
  dialect: "sqlite",
  client: "sqlite",
  scope: "database",
  initialDatabase: "main",
  allowedDatabases: ["main"],
  requireQualifiedDatabase: true,
  capabilities: ["read-only"],
  connection: { kind: "sqlite", filename: ":memory:" },
  knexOptions: {},
};

const SECOND_SQLITE_PROFILE: Profile = {
  ...FAKE_SQLITE_PROFILE,
  name: "SECOND",
  alias: "SECOND",
  operatorKey: "SECOND",
};

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function makeConfig(overrides: Partial<HttpRuntimeConfig> = {}): HttpRuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    stateless: true,
    sessionMode: "stateless",
    shutdownTimeoutMs: 1000,
    logFormat: "text",
    behindProxy: false,
    allowInsecureBind: false,
    allowUnboundedBody: false,
    authority: anyAgentAuthority(),
    authorityBackend: "oauth",
    authorityUrl: "https://auth.example.com",
    authorityJwksUrl: undefined,
    authorityAudience: "mcp-readonly-sql",
    authorityJwksTtlSeconds: 60,
    authorityLeewaySeconds: 30,
    authorityFetchTimeoutMs: 5000,
    ...overrides,
  };
}

function http(
  port: number,
  method: "GET" | "POST",
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolveP, rejectP) => {
    const finalHeaders: Record<string, string> = { ...headers };
    if (body !== undefined && finalHeaders["Content-Length"] === undefined) {
      finalHeaders["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
    }
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: finalHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolveP({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", rejectP);
      },
    );
    if (body !== undefined) req.write(body);
    req.on("error", rejectP);
    req.end();
  });
}

/**
 * Parse an SSE response body into a list of `data:` payloads.
 * The SDK's StreamableHTTPServerTransport writes:
 *
 *   event: message
 *   data: {"jsonrpc":"2.0",...}
 *
 *   event: message
 *   data: ...
 *
 * Lines without a `data:` prefix are ignored. Each `data:` line
 * becomes one element of the result array. The parser is intentionally
 * minimal — it covers the SDK's actual wire format and nothing more.
 */
function parseSseMessages(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      out.push(line.slice("data:".length).trim());
    }
  }
  return out;
}

describe("PR 2: mcp-readonly-sql tool surface (remove-scope-authorization)", () => {
  describe("source-level: scope catalog is removed", () => {
    it("deletes apps/mcp-readonly-sql/src/config/scopeCatalog.ts", () => {
      // GIVEN the scope catalog builder lived in
      //   src/config/scopeCatalog.ts
      // WHEN PR 2 lands
      // THEN the file MUST be gone (it imports a removed
      //      `isValidScope` helper from the shared base, so it
      //      cannot survive the PR 1 surface changes).
      expect(existsSync(SRC("config/scopeCatalog.ts"))).toBe(false);
    });

    it("src/index.ts does NOT import buildScopeCatalog or scopeCatalog", () => {
      // GIVEN the entrypoint used to import `buildScopeCatalog`
      //      and pass a `scopeCatalog` closure to the HTTP
      //      transport
      // WHEN PR 2 lands
      // THEN the source MUST NOT mention either symbol — the
      //      catalog is gone end-to-end.
      const src = readSource("index.ts");
      expect(src).not.toMatch(/buildScopeCatalog/);
      expect(src).not.toMatch(/from\s+["']\.\/config\/scopeCatalog\.js["']/);
    });

    it("src/index.ts does NOT pass a scopeCatalog closure to runHttpTransport", () => {
      // GIVEN the entrypoint used to wire a `scopeCatalog`
      //      closure into the transport — either as the
      //      shorthand `scopeCatalog,` or the explicit
      //      `scopeCatalog: someFn,`
      // WHEN PR 2 lands
      // THEN no such property is on the `runHttpTransport` call
      //      site (the transport no longer accepts it either).
      const src = readSource("index.ts");
      // A bare `scopeCatalog` token on the runHttpTransport call
      // site (shorthand OR explicit) is the smell we are testing
      // for. The earlier import test already covers the
      // `./config/scopeCatalog.js` import path.
      expect(src).not.toMatch(/\bscopeCatalog\b/);
    });

    it("src/transports/http.ts does NOT accept a scopeCatalog option", () => {
      // GIVEN the transport used to accept `scopeCatalog?` on
      //      `RunHttpTransportOptions`
      // WHEN PR 2 lands
      // THEN the option is gone (the shared base also dropped
      //      it; the app side must mirror).
      const src = readSource("transports/http.ts");
      expect(src).not.toMatch(/scopeCatalog/);
    });

    it("src/tools/readonlyTools.ts has NO scope-related enforcement (requiredScope is decorative / no source change required)", () => {
      // GIVEN the design rationale: `readonlyTools.ts` never
      //      called `matchScope` and never read `requiredScope`,
      //      so task 2.3 ("no-op requiredScope enforcement")
      //      has no source change — there was no enforcement to
      //      no-op. The `requiredScope` field on a tool is
      //      preserved as decorative metadata.
      // WHEN PR 2 lands
      // THEN the source MUST NOT call `matchScope`, MUST NOT
      //      import `matchScope`/`SCOPE_PATTERN`/`isValidScope`,
      //      and MUST NOT consult the request `auth.scopes` (the
      //      value is always `[]` per PR 1 and MUST NOT be read
      //      for an access decision per the
      //      `mcp-agent-authorization` delta).
      const src = readSource("tools/readonlyTools.ts");
      expect(src).not.toMatch(/matchScope/);
      expect(src).not.toMatch(/SCOPE_PATTERN/);
      expect(src).not.toMatch(/isValidScope/);
      // The `scopes` field on `req.auth` is `[]`; the runtime MUST
      // NOT use it to make an access decision. We assert the
      // absence of a `req.auth.scopes` lookup as a regex match.
      expect(src).not.toMatch(/auth\.scopes/);
    });
  });

  describe("runtime contract: well-known advertises scopes_supported: []", () => {
    it("well-known returns scopes_supported: [] with zero profiles configured", async () => {
      // GIVEN a server started with no profiles
      // WHEN a client calls `GET /.well-known/oauth-protected-resource`
      // THEN `scopes_supported` is `[]` (PR 2 — the scope catalog is
      //      gone; the well-known field is retained for RFC 9728
      //      schema compliance).
      const cfg = makeConfig({ port: 0 });
      const handle = runHttpTransport({
        config: cfg,
        serverFactory: () =>
          buildReadOnlyMcpServer({ profiles: [], limits: TEST_LIMITS }).server,
      });
      try {
        await handle.start();
        const port = Number(new URL(handle.url).port);
        const res = await http(port, "GET", "/.well-known/oauth-protected-resource");
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as { scopes_supported?: unknown };
        expect(body.scopes_supported).toEqual([]);
      } finally {
        await handle.stop();
      }
    });

    it("well-known returns scopes_supported: [] even with multiple profiles configured (no profile-derived catalog)", async () => {
      // GIVEN a server started with TWO profiles (which used to
      //      contribute `read:<alias>` + `list:<alias>` per profile
      //      to the catalog)
      // WHEN a client calls the well-known endpoint
      // THEN `scopes_supported` is STILL `[]` (the profile-derived
      //      branch is removed; only the empty catalog remains).
      const cfg = makeConfig({ port: 0 });
      const handle = runHttpTransport({
        config: cfg,
        serverFactory: () =>
          buildReadOnlyMcpServer({
            profiles: [FAKE_SQLITE_PROFILE, SECOND_SQLITE_PROFILE],
            limits: TEST_LIMITS,
          }).server,
      });
      try {
        await handle.start();
        const port = Number(new URL(handle.url).port);
        const res = await http(port, "GET", "/.well-known/oauth-protected-resource");
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as { scopes_supported?: unknown };
        expect(body.scopes_supported).toEqual([]);
        // Negative assertion: the previous profile-derived
        // `read:<alias>` / `list:<alias>` values MUST NOT appear in
        // the well-known body.
        const asString = JSON.stringify(body);
        expect(asString).not.toContain("read:SQLITE_FAKE");
        expect(asString).not.toContain("list:SQLITE_FAKE");
        expect(asString).not.toContain("read:SECOND");
        expect(asString).not.toContain("list:SECOND");
      } finally {
        await handle.stop();
      }
    });

    it("well-known returns scopes_supported: [] even when MCP_RESOURCE_SCOPES env override is set (no env-derived catalog)", async () => {
      // GIVEN the operator has set `MCP_RESOURCE_SCOPES` to a
      //      comma-separated list of valid scope strings (the
      //      pre-PR2 env branch that won over the profile branch)
      // WHEN a client calls the well-known endpoint
      // THEN `scopes_supported` is STILL `[]` — the env branch is
      //      removed; no scope string from `MCP_RESOURCE_SCOPES`
      //      appears in the well-known body.
      //
      // This is the second triangulation case for the
      // `scopes_supported: []` contract. Combined with the two
      // profile-count cases above, the contract is pinned across
      // the three source-priority inputs the previous design
      // honored (zero profiles, many profiles, env override).
      const previous = process.env.MCP_RESOURCE_SCOPES;
      process.env.MCP_RESOURCE_SCOPES = "read:foo, list:bar, call:baz";
      try {
        const cfg = makeConfig({ port: 0 });
        const handle = runHttpTransport({
          config: cfg,
          serverFactory: () =>
            buildReadOnlyMcpServer({
              profiles: [FAKE_SQLITE_PROFILE],
              limits: TEST_LIMITS,
            }).server,
        });
        try {
          await handle.start();
          const port = Number(new URL(handle.url).port);
          const res = await http(port, "GET", "/.well-known/oauth-protected-resource");
          expect(res.status).toBe(200);
          const body = JSON.parse(res.body) as { scopes_supported?: unknown };
          expect(body.scopes_supported).toEqual([]);
          // The env-derived values MUST NOT appear in the body.
          expect(res.body).not.toContain("read:foo");
          expect(res.body).not.toContain("list:bar");
          expect(res.body).not.toContain("call:baz");
        } finally {
          await handle.stop();
        }
      } finally {
        if (previous === undefined) {
          delete process.env.MCP_RESOURCE_SCOPES;
        } else {
          process.env.MCP_RESOURCE_SCOPES = previous;
        }
      }
    });
  });

  describe("runtime contract: requiredScope is decorative", () => {
    it("authenticated request can call list_profiles regardless of any legacy scope strings", async () => {
      // GIVEN a server with a profile configured
      // WHEN an authenticated client calls `tools/call` with
      //      `list_profiles` (a tool that used to be subject to a
      //      `requiredScope` tag, though the source had no runtime
      //      enforcement anyway)
      // THEN the response is `200` with a JSON-RPC success envelope
      //      and the tool returns the configured profile list. No
      //      `403` is produced for the lack of any scope string.
      const cfg = makeConfig({ port: 0 });
      const handle = runHttpTransport({
        config: cfg,
        serverFactory: () =>
          buildReadOnlyMcpServer({ profiles: [FAKE_SQLITE_PROFILE], limits: TEST_LIMITS }).server,
      });
      try {
        await handle.start();
        const port = Number(new URL(handle.url).port);
        const reqBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_profiles", arguments: {} },
        });
        const res = await http(port, "POST", "/mcp", {
          "Authorization": "Bearer some-token",
          "Content-Type": "application/json",
          // The MCP SDK transport requires both JSON and SSE in
          // the Accept header; without it, the SDK returns 406
          // "Not Acceptable" before the tool handler ever runs.
          "Accept": "application/json, text/event-stream",
        }, reqBody);
        // The agent is authenticated; the tool returns 200. A
        // 403 from scope mismatch would be a contract violation.
        expect(res.status).toBe(200);
        // The SDK writes the response in SSE format when
        // `text/event-stream` is acceptable. Parse the `data:`
        // line(s) and locate the JSON-RPC envelope.
        const messages = parseSseMessages(res.body);
        const envelope = messages
          .map((m) => {
            try {
              return JSON.parse(m) as {
                jsonrpc?: string;
                id?: number;
                result?: { content?: Array<{ text?: string }> };
                error?: { code?: number; message?: string };
              };
            } catch {
              return {};
            }
          })
          .find((m) => m.jsonrpc === "2.0" && m.id === 1);
        expect(envelope).toBeDefined();
        expect(envelope?.error).toBeUndefined();
        expect(envelope?.result).toBeDefined();
        // The tool payload is the serialized profile list — assert
        // it is non-empty so we know the tool body went through the
        // handler (not a default empty success).
        const text = envelope?.result?.content?.[0]?.text ?? "";
        expect(text.length).toBeGreaterThan(0);
        expect(text).toContain("SQLITE_FAKE");
      } finally {
        await handle.stop();
      }
    });
  });
});
