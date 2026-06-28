import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReadOnlyMcpServer,
  type ReadOnlyMcpServerHandle,
} from "../src/serverFactory.js";
import type { Profile, SafetyLimits } from "../src/types.js";

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

describe("serverFactory", () => {
  describe("buildReadOnlyMcpServer", () => {
    it("returns a handle with an McpServer, a connections manager, and an onShutdown hook", () => {
      // GIVEN a profile and safety limits
      // WHEN we build the server
      // THEN the handle exposes a McpServer, the connections manager, and an onShutdown callback
      const handle: ReadOnlyMcpServerHandle = buildReadOnlyMcpServer({
        profiles: [FAKE_SQLITE_PROFILE],
        limits: TEST_LIMITS,
      });
      expect(handle.server).toBeDefined();
      expect(handle.connections).toBeDefined();
      expect(typeof handle.onShutdown).toBe("function");
    });

    it("registers all five read-only tools on the McpServer", async () => {
      // GIVEN a built server
      // WHEN we list the tools registered on the McpServer
      // THEN all five expected tools are present
      const handle = buildReadOnlyMcpServer({
        profiles: [FAKE_SQLITE_PROFILE],
        limits: TEST_LIMITS,
      });
      // The MCP SDK exposes registered tools via `server._registeredTools`
      // (private but stable in 1.x). We assert on the names so a future
      // SDK rename forces a deliberate test update.
      const registered = handle.server as unknown as {
        _registeredTools: Record<string, unknown>;
      };
      const names = Object.keys(registered._registeredTools);
      expect(names).toEqual(
        expect.arrayContaining([
          "list_profiles",
          "test_connection",
          "list_databases",
          "execute_read_query",
          "describe_schema",
        ]),
      );
      expect(names).toHaveLength(5);
    });

    it("onShutdown closes the connection pool (returns a resolved promise)", async () => {
      // GIVEN a built server
      // WHEN onShutdown is called
      // THEN the returned promise resolves (no throw) and the connections manager is destroyed
      const handle = buildReadOnlyMcpServer({
        profiles: [FAKE_SQLITE_PROFILE],
        limits: TEST_LIMITS,
      });
      // Smoke: a second call to onShutdown is a no-op (the connection manager's
      // destroyAll is idempotent) — verifies the handle's hook is safe to call.
      await expect(handle.onShutdown()).resolves.toBeUndefined();
      await expect(handle.onShutdown()).resolves.toBeUndefined();
    });

    it("McpServer name and version match the package identity", () => {
      // GIVEN a built server
      // WHEN we inspect the McpServer identity
      // THEN the name is "mcp-readonly-sql" and the version is the package version
      const handle = buildReadOnlyMcpServer({
        profiles: [FAKE_SQLITE_PROFILE],
        limits: TEST_LIMITS,
      });
      // The MCP SDK stores the server identity on the inner `Server` instance
      // as `_serverInfo` (private, but stable across 1.x). McpServer exposes
      // it as `.server._serverInfo`.
      const innerServer = handle.server as unknown as {
        server: { _serverInfo?: { name?: string; version?: string } };
      };
      expect(innerServer.server._serverInfo?.name).toBe("mcp-readonly-sql");
      // Version is sourced from this package.json so we read the file rather
      // than hardcoding the version in two places.
      const pkg = JSON.parse(
        readFileSync(
          join(process.cwd(), "package.json"),
          "utf8",
        ),
      ) as { version: string };
      expect(innerServer.server._serverInfo?.version).toBe(pkg.version);
    });

    it("accepts an empty profile list (server starts with zero profiles)", () => {
      // GIVEN no profiles configured
      // WHEN we build the server
      // THEN it still returns a valid handle (matches the pre-PR2 behavior
      // where `runServer` logs "No DB_PROFILES configured" and continues)
      const handle = buildReadOnlyMcpServer({
        profiles: [],
        limits: TEST_LIMITS,
      });
      const registered = handle.server as unknown as {
        _registeredTools: Record<string, unknown>;
      };
      // The five tools are still registered; they just cannot resolve a
      // profile at call time. The server-side ProfileSummary list will be
      // empty.
      expect(Object.keys(registered._registeredTools)).toHaveLength(5);
    });
  });
});
