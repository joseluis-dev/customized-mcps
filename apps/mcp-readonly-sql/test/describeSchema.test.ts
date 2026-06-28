import { describe, it, expect, beforeEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { registerReadOnlyTools } from "../src/tools/readonlyTools.js";
import type { Profile, SafetyLimits } from "../src/types.js";

interface CapturedCall {
  sql: string;
  bindings?: unknown;
}

interface ToolEntry {
  name: string;
  config: { inputSchema: z.ZodTypeAny; description?: string };
  handler: (args: unknown) => Promise<unknown>;
}

function makeServer() {
  const tools: ToolEntry[] = [];
  const fakeServer = {
    registerTool(
      name: string,
      config: { inputSchema: z.ZodTypeAny; description?: string; title?: string },
      handler: (args: unknown) => Promise<unknown>,
    ) {
      tools.push({ name, config, handler });
    },
  } as unknown as McpServer;
  return { server: fakeServer, tools };
}

const LIMITS: SafetyLimits = {
  maxRowsDefault: 100,
  maxRowsHardLimit: 1000,
  queryTimeoutMsDefault: 10_000,
  queryTimeoutMsHardLimit: 60_000,
};

function makeMysqlProfile(overrides: Partial<Profile> = {}): Profile {
  const base: Profile = {
    name: "sisgad_mad",
    alias: "sisgad_mad",
    operatorKey: "SISGAD_MAD",
    dialect: "mysql",
    client: "mysql2",
    connection: {
      kind: "mysql",
      host: "x",
      port: 3306,
      database: "sisgad_mad",
      user: "u",
      password: "p",
    },
    knexOptions: {},
    scope: "server",
    initialDatabase: "sisgad_mad",
    allowedDatabases: ["sisgad_mad"],
    requireQualifiedDatabase: true,
    capabilities: ["read-only"],
    ...overrides,
  };
  return base;
}

function makePostgresProfile(overrides: Partial<Profile> = {}): Profile {
  const base: Profile = {
    name: "pg_app",
    alias: "pg_app",
    operatorKey: "PG_APP",
    dialect: "postgres",
    client: "pg",
    connection: {
      kind: "postgres",
      host: "x",
      port: 5432,
      database: "app",
      user: "u",
      password: "p",
      ssl: false,
    },
    knexOptions: {},
    scope: "server",
    initialDatabase: "app",
    allowedDatabases: ["app"],
    requireQualifiedDatabase: true,
    capabilities: ["read-only"],
    ...overrides,
  };
  return base;
}

function makeKnexCapture() {
  const captured: CapturedCall[] = [];
  const fakeTrx = {
    raw: (sql: string, bindings?: unknown) => {
      captured.push({ sql, bindings });
      return Promise.resolve({ rows: [] });
    },
  };
  const fakeKnex = {
    transaction: async (fn: (trx: typeof fakeTrx) => Promise<unknown>) =>
      fn(fakeTrx),
  };
  return { fakeKnex, fakeTrx, captured };
}

function findTool(tools: ToolEntry[], name: string): ToolEntry {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not registered`);
  return t;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("describe_schema with a MySQL allowlist profile", () => {
  it("runs the server-generated information_schema metadata query after targetDb validation", async () => {
    const profile = makeMysqlProfile();
    const { server, tools } = makeServer();
    const { fakeKnex, captured } = makeKnexCapture();
    registerReadOnlyTools(server, {
      profiles: [profile],
      limits: LIMITS,
      connections: { get: () => fakeKnex as never, destroyAll: async () => {} } as never,
    });
    const describe = findTool(tools, "describe_schema");

    const out = (await describe.handler({
      profile: "sisgad_mad",
      database: "sisgad_mad",
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(out.isError).toBeUndefined();
    const infoSchemaCall = captured.find((c) =>
      c.sql.includes("information_schema.tables"),
    );
    expect(infoSchemaCall).toBeDefined();
    expect(infoSchemaCall!.sql).toContain("table_schema = 'sisgad_mad'");
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.profile).toBe("sisgad_mad");
    expect(parsed.database).toBe("sisgad_mad");
    expect(parsed.dialect).toBe("mysql");
  });

  it("rejects a target database that is not in the allowlist before touching the connection", async () => {
    const profile = makeMysqlProfile();
    const { server, tools } = makeServer();
    const { fakeKnex, captured } = makeKnexCapture();
    registerReadOnlyTools(server, {
      profiles: [profile],
      limits: LIMITS,
      connections: { get: () => fakeKnex as never, destroyAll: async () => {} } as never,
    });
    const describe = findTool(tools, "describe_schema");

    const out = (await describe.handler({
      profile: "sisgad_mad",
      database: "other_db",
    })) as { isError: boolean; content: Array<{ text: string }> };

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("other_db");
    expect(out.content[0]!.text).toContain("sisgad_mad");
    expect(captured).toEqual([]);
  });

  it("interpolates a validated table name into the columns query against information_schema", async () => {
    const profile = makeMysqlProfile();
    const { server, tools } = makeServer();
    const { fakeKnex, captured } = makeKnexCapture();
    registerReadOnlyTools(server, {
      profiles: [profile],
      limits: LIMITS,
      connections: { get: () => fakeKnex as never, destroyAll: async () => {} } as never,
    });
    const describe = findTool(tools, "describe_schema");

    const out = (await describe.handler({
      profile: "sisgad_mad",
      database: "sisgad_mad",
      table: "Predios",
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(out.isError).toBeUndefined();
    const columnsCall = captured.find((c) =>
      c.sql.includes("information_schema.columns"),
    );
    expect(columnsCall).toBeDefined();
    expect(columnsCall!.sql).toContain("table_schema = 'sisgad_mad'");
    expect(columnsCall!.sql).toContain("table_name = 'Predios'");
  });
});

describe("describe_schema with a PostgreSQL allowlist profile", () => {
  it("runs the server-generated information_schema metadata query for an allowlisted schema", async () => {
    const profile = makePostgresProfile();
    const { server, tools } = makeServer();
    const { fakeKnex, captured } = makeKnexCapture();
    registerReadOnlyTools(server, {
      profiles: [profile],
      limits: LIMITS,
      connections: { get: () => fakeKnex as never, destroyAll: async () => {} } as never,
    });
    const describe = findTool(tools, "describe_schema");

    const out = (await describe.handler({
      profile: "pg_app",
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(out.isError).toBeUndefined();
    const infoSchemaCall = captured.find((c) =>
      c.sql.includes("information_schema.tables"),
    );
    expect(infoSchemaCall).toBeDefined();
    expect(infoSchemaCall!.sql).toContain("table_schema = 'app'");
  });
});

describe("execute_read_query still enforces the information_schema allowlist", () => {
  it("blocks a user-supplied query that touches information_schema on a profile that does not allow it", async () => {
    const profile = makeMysqlProfile();
    const { server, tools } = makeServer();
    const { fakeKnex, captured } = makeKnexCapture();
    registerReadOnlyTools(server, {
      profiles: [profile],
      limits: LIMITS,
      connections: { get: () => fakeKnex as never, destroyAll: async () => {} } as never,
    });
    const exec = findTool(tools, "execute_read_query");

    const out = (await exec.handler({
      profile: "sisgad_mad",
      sql: "SELECT * FROM information_schema.tables",
    })) as { isError: boolean; content: Array<{ text: string }> };

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("information_schema");
    expect(out.content[0]!.text).toContain("allowlist");
    expect(captured).toEqual([]);
  });

  it("blocks a user-supplied query that joins information_schema with an allowlisted database", async () => {
    const profile = makeMysqlProfile();
    const { server, tools } = makeServer();
    const { fakeKnex, captured } = makeKnexCapture();
    registerReadOnlyTools(server, {
      profiles: [profile],
      limits: LIMITS,
      connections: { get: () => fakeKnex as never, destroyAll: async () => {} } as never,
    });
    const exec = findTool(tools, "execute_read_query");

    const out = (await exec.handler({
      profile: "sisgad_mad",
      sql: "SELECT * FROM information_schema.columns c JOIN `sisgad_mad`.users u ON u.id = c.table_name",
    })) as { isError: boolean; content: Array<{ text: string }> };

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("information_schema");
    expect(captured).toEqual([]);
  });
});
