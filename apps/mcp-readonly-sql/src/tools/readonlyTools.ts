import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Profile, ProfileSummary, SafetyLimits } from "../types.js";
import { assertReadOnlySql, SqlGuardError } from "../security/sqlGuard.js";
import { sanitizeError } from "../security/sanitizeError.js";
import { ConnectionManager, withReadOnlyTransaction } from "../db/knexFactory.js";
import { normalizeBindings, runReadQuery } from "../db/resultNormalizer.js";

const profileNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_]+$/, "Invalid profile name");

const databaseNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_\-$]+$/, "Invalid database name");

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const { message, name } = sanitizeError(err);
  const isGuard = name === "SqlGuardError" || err instanceof SqlGuardError;
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: isGuard
          ? `Refused: ${message}`
          : `Error: ${message}`,
      },
    ],
  };
}

function policyFor(p: Profile) {
  if (p.dialect === "sqlite") return undefined;
  return {
    allowed: p.allowedDatabases,
    requireQualified: p.requireQualifiedDatabase,
  };
}

export function registerReadOnlyTools(
  server: McpServer,
  args: {
    profiles: Profile[];
    limits: SafetyLimits;
    connections: ConnectionManager;
  },
): void {
  const { profiles, limits, connections } = args;
  const aliasMap = new Map<string, Profile>();
  const operatorKeyMap = new Map<string, Profile>();
  for (const p of profiles) {
    aliasMap.set(p.alias, p);
    if (p.alias !== p.operatorKey) {
      operatorKeyMap.set(p.operatorKey, p);
    }
  }
  const lookupProfile = (value: string): Profile | undefined => {
    return aliasMap.get(value) ?? operatorKeyMap.get(value);
  };
  const summaries: ProfileSummary[] = profiles.map((p) => {
    const summary: ProfileSummary = {
      name: p.alias,
      alias: p.alias,
      dialect: p.dialect,
      scope: p.scope,
      allowedDatabases: p.allowedDatabases,
      requireQualifiedDatabase: p.requireQualifiedDatabase,
      capabilities: p.capabilities,
    };
    if (p.displayName !== undefined) summary.displayName = p.displayName;
    if (p.description !== undefined) summary.description = p.description;
    if (p.tags !== undefined && p.tags.length > 0) summary.tags = p.tags;
    return summary;
  });

  server.registerTool(
    "list_profiles",
    {
      title: "List connection profiles",
      description:
        "Returns the connection profiles configured in .env. For server-scope profiles (PostgreSQL, MySQL/MariaDB, SQL Server), the listed `allowedDatabases` are the only databases the agent can query. No credentials are returned. Each entry has `name` equal to `alias`; the operator key is server-side.",
      inputSchema: z.object({}).strict(),
    },
    async () => jsonResult({ profiles: summaries }),
  );

  server.registerTool(
    "test_connection",
    {
      title: "Test a connection profile",
      description:
        "Opens a short-lived check (SELECT 1) against the profile's initial database to confirm reachability. Does not return any data.",
      inputSchema: z
        .object({
          profile: profileNameSchema,
        })
        .strict(),
    },
    async ({ profile }) => {
      const p = lookupProfile(profile);
      if (!p) {
        return errorResult(new Error(`Unknown profile: ${profile}`));
      }
      try {
        const k = connections.get(p);
        await withReadOnlyTransaction(k, p.dialect, async (trx) => {
          await trx.raw("SELECT 1");
        });
        return textResult(`Connection OK for profile "${p.alias}" (${p.dialect})`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_databases",
    {
      title: "List allowed databases for a server-scope profile",
      description:
        "Returns the list of databases the agent is allowed to query through this profile (per the .env allowlist). For database-scope profiles, only the initial database is returned.",
      inputSchema: z
        .object({
          profile: profileNameSchema,
        })
        .strict(),
    },
    async ({ profile }) => {
      const p = lookupProfile(profile);
      if (!p) {
        return errorResult(new Error(`Unknown profile: ${profile}`));
      }
      if (p.allowedDatabases === "all") {
        return jsonResult({
          profile: p.alias,
          scope: p.scope,
          allowed: "all (per the read-only database user)",
          requireQualifiedDatabase: p.requireQualifiedDatabase,
        });
      }
      return jsonResult({
        profile: p.alias,
        scope: p.scope,
        allowed: p.allowedDatabases,
        requireQualifiedDatabase: p.requireQualifiedDatabase,
      });
    },
  );

  server.registerTool(
    "execute_read_query",
    {
      title: "Execute a read-only SQL query",
      description:
        "Runs a single SELECT (or WITH ... SELECT) statement against the chosen profile. The MCP rejects INSERT/UPDATE/DELETE and any other write or admin statement. For server-scope profiles, every referenced database must be in the allowlist; fully-qualified names are required when requireQualifiedDatabase is true. Use parameter bindings to inject values. Row results are capped by maxRows.",
      inputSchema: z
        .object({
          profile: profileNameSchema,
          database: databaseNameSchema.optional(),
          sql: z.string().min(1).max(100_000),
          bindings: z
            .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
            .optional(),
          maxRows: z.number().int().positive().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .strict(),
    },
    async ({ profile, database, sql, bindings, maxRows, timeoutMs }) => {
      const p = lookupProfile(profile);
      if (!p) {
        return errorResult(new Error(`Unknown profile: ${profile}`));
      }
      const policy = policyFor(p);
      if (policy && database && policy.allowed !== "all" && !policy.allowed.includes(database)) {
        return errorResult(
          new Error(
            `Database "${database}" is not in the allowlist for profile "${p.alias}"`,
          ),
        );
      }
      try {
        assertReadOnlySql(p.dialect, sql, policy);
      } catch (e) {
        return errorResult(e instanceof SqlGuardError ? e : e);
      }
      const requestedRows = maxRows ?? limits.maxRowsDefault;
      const cappedRows = Math.min(requestedRows, limits.maxRowsHardLimit);
      const requestedTimeout = timeoutMs ?? limits.queryTimeoutMsDefault;
      const cappedTimeout = Math.min(requestedTimeout, limits.queryTimeoutMsHardLimit);
      const normalizedBindings = normalizeBindings(bindings);
      try {
        const k = connections.get(p);
        const beforeStatement =
          p.dialect === "mssql" && database
            ? async (trx: import("knex").Knex.Transaction): Promise<void> => {
                await trx.raw(`USE [${database.replace(/]/g, "]]")}]`);
              }
            : p.dialect === "mysql" || p.dialect === "mariadb"
              ? database
                ? async (trx: import("knex").Knex.Transaction): Promise<void> => {
                    await trx.raw(`USE \`${database.replace(/`/g, "``")}\``);
                  }
                : undefined
              : p.dialect === "postgres" && database
                ? async (trx: import("knex").Knex.Transaction): Promise<void> => {
                    await trx.raw(`SET search_path TO "${database.replace(/"/g, '""')}", public`);
                  }
                : undefined;
        const result = await withTimeout(
          withReadOnlyTransaction(k, p.dialect, (trx) =>
            runReadQuery(trx, sql, normalizedBindings, cappedRows),
            beforeStatement,
          ),
          cappedTimeout,
        );
        return jsonResult({
          profile: p.alias,
          database: database ?? p.initialDatabase,
          dialect: p.dialect,
          ...result,
          appliedMaxRows: cappedRows,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "describe_schema",
    {
      title: "List tables and columns for a profile",
      description:
        "Returns a best-effort list of tables (and columns when a `table` is given) using read-only metadata queries. For server-scope profiles, the optional `database` argument selects which allowed database to inspect; it must be in the allowlist.",
      inputSchema: z
        .object({
          profile: profileNameSchema,
          database: databaseNameSchema.optional(),
          table: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9_.$-]+$/)
            .optional(),
        })
        .strict(),
    },
    async ({ profile, database, table }) => {
      const p = lookupProfile(profile);
      if (!p) {
        return errorResult(new Error(`Unknown profile: ${profile}`));
      }
      const targetDb = database ?? p.initialDatabase;
      if (p.allowedDatabases !== "all" && !p.allowedDatabases.includes(targetDb)) {
        return errorResult(
          new Error(
            `Database "${targetDb}" is not in the allowlist for profile "${p.alias}"`,
          ),
        );
      }
      const sql = buildDescribeSql(p.dialect, p.scope, targetDb, table);
      // The SQL is server-generated and references the system metadata
      // schema (`information_schema` / `INFORMATION_SCHEMA`), not a user-
      // controlled table. The user's actual `targetDb` has already been
      // validated against the profile allowlist above, and `buildDescribeSql`
      // only interpolates the validated, regex-checked `database`/`table`
      // values into string literals. The standard read-only AST/keyword
      // checks still apply, so we deliberately skip the database allowlist
      // check for this server-built query.
      try {
        assertReadOnlySql(p.dialect, sql);
      } catch (e) {
        return errorResult(e);
      }
      try {
        const k = connections.get(p);
        const beforeStatement =
          p.dialect === "mssql"
            ? async (trx: import("knex").Knex.Transaction): Promise<void> => {
                await trx.raw(`USE [${targetDb.replace(/]/g, "]]")}]`);
              }
            : p.dialect === "mysql" || p.dialect === "mariadb"
              ? async (trx: import("knex").Knex.Transaction): Promise<void> => {
                  await trx.raw(`USE \`${targetDb.replace(/`/g, "``")}\``);
                }
              : p.dialect === "postgres"
                ? async (trx: import("knex").Knex.Transaction): Promise<void> => {
                    await trx.raw(`SET search_path TO "${targetDb.replace(/"/g, '""')}", public`);
                  }
                : undefined;
        const result = await withReadOnlyTransaction(
          k,
          p.dialect,
          (trx) => runReadQuery(trx, sql, [], limits.maxRowsHardLimit),
          beforeStatement,
        );
        return jsonResult({ profile: p.alias, database: targetDb, dialect: p.dialect, ...result });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildDescribeSql(
  dialect: Profile["dialect"],
  scope: Profile["scope"],
  database: string,
  table?: string,
): string {
  const safeDb = database.replace(/]/g, "]]");
  const safeT = table ? table.replace(/]/g, "]]") : undefined;
  if (dialect === "postgres") {
    if (table) {
      return `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = '${escapeSqlString(database)}' AND table_name = '${escapeSqlString(stripBrackets(table))}' ORDER BY ordinal_position`;
    }
    return `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = '${escapeSqlString(database)}' ORDER BY table_name`;
  }
  if (dialect === "mysql" || dialect === "mariadb") {
    if (table) {
      return `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = '${escapeSqlString(database)}' AND table_name = '${escapeSqlString(stripBrackets(table))}' ORDER BY ordinal_position`;
    }
    return `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = '${escapeSqlString(database)}' ORDER BY table_name`;
  }
  if (dialect === "mssql") {
    if (table) {
      return `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM [${safeDb}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${escapeSqlString(stripBrackets(table))}' ORDER BY ORDINAL_POSITION`;
    }
    return `SELECT TABLE_SCHEMA, TABLE_NAME FROM [${safeDb}].INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`;
  }
  if (dialect === "sqlite") {
    if (table) {
      return `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${escapeSqlString(stripBrackets(table))}')`;
    }
    return "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
  }
  throw new Error(`Unsupported dialect: ${dialect}`);
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

function stripBrackets(s: string): string {
  if (s.startsWith("[") && s.endsWith("]")) return s.slice(1, -1);
  return s;
}
