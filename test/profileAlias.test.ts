import { describe, it, expect, beforeEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerReadOnlyTools } from "../src/tools/readonlyTools.js";
import type { Profile, SafetyLimits } from "../src/types.js";

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

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  const base: Profile = {
    name: "bi_catastro",
    alias: "bi_catastro",
    operatorKey: "SQLSERVER_BI",
    dialect: "mssql",
    client: "mssql",
    connection: {
      kind: "mssql",
      host: "x",
      port: 1433,
      database: "master",
      user: "u",
      password: "p",
      encrypt: true,
      trustServerCertificate: false,
    },
    knexOptions: {},
    scope: "server",
    initialDatabase: "master",
    allowedDatabases: ["catastral"],
    requireQualifiedDatabase: true,
    capabilities: ["read-only"],
    ...overrides,
  };
  return base;
}

const LIMITS: SafetyLimits = {
  maxRowsDefault: 100,
  maxRowsHardLimit: 1000,
  queryTimeoutMsDefault: 10_000,
  queryTimeoutMsHardLimit: 60_000,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("registerReadOnlyTools", () => {
  it("registers list_profiles, test_connection, list_databases, execute_read_query, describe_schema", () => {
    const { server, tools } = makeServer();
    registerReadOnlyTools(server, {
      profiles: [makeProfile()],
      limits: LIMITS,
      connections: { get: () => ({}), destroyAll: async () => {} } as never,
    });
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_profiles",
        "test_connection",
        "list_databases",
        "execute_read_query",
        "describe_schema",
      ]),
    );
  });

  it("emits ProfileSummary with name === alias and never includes host/user/password/port", async () => {
    const { server, tools } = makeServer();
    registerReadOnlyTools(server, {
      profiles: [makeProfile()],
      limits: LIMITS,
      connections: { get: () => ({}), destroyAll: async () => {} } as never,
    });
    const list = tools.find((t) => t.name === "list_profiles")!;
    const out = (await list.handler({})) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(out.content[0]!.text);
    const summary = parsed.profiles[0];
    expect(summary.name).toBe("bi_catastro");
    expect(summary.alias).toBe("bi_catastro");
    expect(summary.dialect).toBe("mssql");
    expect(summary.capabilities).toEqual(["read-only"]);
    const raw = JSON.stringify(summary);
    expect(raw).not.toContain("host");
    expect(raw).not.toContain("user");
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("port");
    expect(raw).not.toContain("${secret:");
    expect(raw).not.toContain("SQLSERVER_BI");
  });
});

describe("profile argument resolution", () => {
  it("resolves alias first, then operator key (alias wins)", async () => {
    const a = makeProfile({
      name: "bi_catastro",
      alias: "bi_catastro",
      operatorKey: "SQLSERVER_BI",
      allowedDatabases: ["catastral"],
    });
    const b = makeProfile({
      name: "reporting",
      alias: "reporting",
      operatorKey: "PG_REPORTING",
      dialect: "postgres",
      connection: {
        kind: "postgres",
        host: "y",
        port: 5432,
        database: "postgres",
        user: "u",
        password: "p",
        ssl: false,
      },
      allowedDatabases: ["app"],
    });
    const { server, tools } = makeServer();
    const fakeTrx = { raw: async () => ({}) };
    const fakeKnex = {
      transaction: async (fn: (trx: typeof fakeTrx) => Promise<unknown>) =>
        fn(fakeTrx),
      raw: async () => ({}),
    };
    registerReadOnlyTools(server, {
      profiles: [a, b],
      limits: LIMITS,
      connections: {
        get: () => fakeKnex as never,
        destroyAll: async () => {},
      } as never,
    });
    const test = tools.find((t) => t.name === "test_connection")!;
    const out = await test.handler({ profile: "bi_catastro" });
    const text = (out as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("bi_catastro");
    expect(text).not.toContain("SQLSERVER_BI");
  });

  it("accepts the operator key as a synonym for alias", async () => {
    const a = makeProfile({
      name: "bi_catastro",
      alias: "bi_catastro",
      operatorKey: "SQLSERVER_BI",
    });
    const { server, tools } = makeServer();
    const fakeTrx = { raw: async () => ({}) };
    const fakeKnex = {
      transaction: async (fn: (trx: typeof fakeTrx) => Promise<unknown>) =>
        fn(fakeTrx),
    };
    registerReadOnlyTools(server, {
      profiles: [a],
      limits: LIMITS,
      connections: {
        get: () => fakeKnex as never,
        destroyAll: async () => {},
      } as never,
    });
    const test = tools.find((t) => t.name === "test_connection")!;
    const out = await test.handler({ profile: "SQLSERVER_BI" });
    const text = (out as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("bi_catastro");
  });

  it("returns an error keyed to caller value when the profile is unknown", async () => {
    const a = makeProfile({ alias: "bi_catastro" });
    const b = makeProfile({ alias: "reporting" });
    const { server, tools } = makeServer();
    registerReadOnlyTools(server, {
      profiles: [a, b],
      limits: LIMITS,
      connections: { get: () => ({}), destroyAll: async () => {} } as never,
    });
    const test = tools.find((t) => t.name === "test_connection")!;
    const out = (await test.handler({ profile: "nope" })) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(out.isError).toBe(true);
    const text = out.content[0]!.text;
    expect(text).toContain("nope");
    expect(text).not.toContain("bi_catastro");
    expect(text).not.toContain("reporting");
  });

  it("references only the caller value when the database is not in the allowlist", async () => {
    const a = makeProfile({
      alias: "bi_catastro",
      operatorKey: "SQLSERVER_BI",
      allowedDatabases: ["catastral"],
    });
    const { server, tools } = makeServer();
    registerReadOnlyTools(server, {
      profiles: [a],
      limits: LIMITS,
      connections: { get: () => ({}), destroyAll: async () => {} } as never,
    });
    const exec = tools.find((t) => t.name === "execute_read_query")!;
    const out = (await exec.handler({
      profile: "bi_catastro",
      database: "other",
      sql: "SELECT 1",
    })) as { isError: boolean; content: Array<{ text: string }> };
    expect(out.isError).toBe(true);
    const text = out.content[0]!.text;
    expect(text).toContain("other");
    expect(text).toContain("bi_catastro");
    expect(text).not.toContain("SQLSERVER_BI");
  });
});

describe("strict zod input schemas", () => {
  it("rejects extra host/user/password/port fields on test_connection", () => {
    const { server, tools } = makeServer();
    registerReadOnlyTools(server, {
      profiles: [makeProfile()],
      limits: LIMITS,
      connections: { get: () => ({}), destroyAll: async () => {} } as never,
    });
    const test = tools.find((t) => t.name === "test_connection")!;
    const schema = test.config.inputSchema;
    const result = schema.safeParse({
      profile: "bi_catastro",
      host: "evil",
      user: "evil",
      password: "evil",
      port: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra host/user/password/port fields on execute_read_query", () => {
    const { server, tools } = makeServer();
    registerReadOnlyTools(server, {
      profiles: [makeProfile()],
      limits: LIMITS,
      connections: { get: () => ({}), destroyAll: async () => {} } as never,
    });
    const exec = tools.find((t) => t.name === "execute_read_query")!;
    const result = exec.config.inputSchema.safeParse({
      profile: "bi_catastro",
      sql: "SELECT 1",
      host: "evil",
      user: "evil",
      password: "evil",
      port: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields on list_profiles", () => {
    const { server, tools } = makeServer();
    registerReadOnlyTools(server, {
      profiles: [makeProfile()],
      limits: LIMITS,
      connections: { get: () => ({}), destroyAll: async () => {} } as never,
    });
    const list = tools.find((t) => t.name === "list_profiles")!;
    const result = list.config.inputSchema.safeParse({ profile: "x" });
    expect(result.success).toBe(false);
  });
});
