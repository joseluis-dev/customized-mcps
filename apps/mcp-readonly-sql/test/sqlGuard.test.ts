import { describe, it, expect } from "vitest";
import { assertReadOnlySql, SqlGuardError } from "../src/security/sqlGuard.js";
import type { SupportedDialect } from "../src/types.js";

const READONLY_DIALECTS: SupportedDialect[] = ["postgres", "mysql", "sqlite", "mssql"];

const ALLOWED: Record<SupportedDialect, string[]> = {
  postgres: [
    "SELECT 1",
    "SELECT id, name FROM users WHERE active = true",
    "WITH active AS (SELECT id FROM users WHERE active) SELECT * FROM active",
    'SELECT * FROM "public"."users"',
    'SELECT * FROM "app"."public"."users"',
  ],
  mysql: [
    "SELECT 1",
    "SELECT id FROM users WHERE created_at > '2024-01-01'",
    "WITH t AS (SELECT 1 AS x) SELECT x FROM t",
    "SELECT * FROM `app`.`users`",
  ],
  sqlite: [
    "SELECT 1",
    "SELECT name FROM sqlite_master",
    "WITH t AS (SELECT 1 AS x) SELECT x FROM t",
  ],
  mssql: [
    "SELECT 1",
    "SELECT TOP 10 id FROM dbo.Users",
    "WITH t AS (SELECT 1 AS x) SELECT x FROM t",
    "SELECT * FROM [catastral].[dbo].[Predios] p JOIN [catastro].[dbo].[Titulares] t ON t.id = p.id",
  ],
  mariadb: [
    "SELECT 1",
    "SELECT id FROM users",
  ],
};

const BLOCKED: Array<{ dialect: SupportedDialect; sql: string; reason: string }> = [
  { dialect: "postgres", sql: "DROP TABLE users", reason: "DROP" },
  { dialect: "postgres", sql: "DELETE FROM users WHERE id = 1", reason: "DELETE" },
  { dialect: "postgres", sql: "UPDATE users SET name = 'x'", reason: "UPDATE" },
  { dialect: "postgres", sql: "INSERT INTO users (id) VALUES (1)", reason: "INSERT" },
  { dialect: "postgres", sql: "TRUNCATE users", reason: "TRUNCATE" },
  { dialect: "postgres", sql: "ALTER TABLE users ADD COLUMN x int", reason: "ALTER" },
  { dialect: "postgres", sql: "CREATE TABLE x (id int)", reason: "CREATE" },
  { dialect: "postgres", sql: "GRANT SELECT ON x TO y", reason: "GRANT" },
  { dialect: "postgres", sql: "REVOKE SELECT ON x FROM y", reason: "REVOKE" },
  { dialect: "postgres", sql: "MERGE INTO x USING y ON x.id = y.id", reason: "MERGE" },
  { dialect: "postgres", sql: "SELECT 1; DROP TABLE users", reason: "multiple statements" },
  { dialect: "postgres", sql: "SELECT 1; SELECT 2", reason: "multiple statements" },
  { dialect: "postgres", sql: "-- comment\nSELECT 1; DROP TABLE users", reason: "multiple statements" },
  { dialect: "postgres", sql: "/* hint */ SELECT 1; DELETE FROM x", reason: "multiple statements" },
  { dialect: "mysql", sql: "DROP DATABASE foo", reason: "DROP" },
  { dialect: "mysql", sql: "DELETE FROM x", reason: "DELETE" },
  { dialect: "mysql", sql: "LOAD DATA INFILE '/etc/passwd' INTO TABLE x", reason: "LOAD" },
  { dialect: "mysql", sql: "SELECT 1 INTO OUTFILE '/tmp/x'", reason: "INTO OUTFILE" },
  { dialect: "mssql", sql: "DROP TABLE x", reason: "DROP" },
  { dialect: "mssql", sql: "DELETE FROM x", reason: "DELETE" },
  { dialect: "mssql", sql: "EXEC sp_something", reason: "EXEC" },
  { dialect: "mssql", sql: "TRUNCATE TABLE x", reason: "TRUNCATE" },
  { dialect: "sqlite", sql: "DROP TABLE x", reason: "DROP" },
  { dialect: "sqlite", sql: "DELETE FROM x", reason: "DELETE" },
  { dialect: "sqlite", sql: "ATTACH DATABASE 'other.db' AS aux", reason: "ATTACH" },
];

describe("assertReadOnlySql", () => {
  for (const dialect of READONLY_DIALECTS) {
    describe(`dialect ${dialect}`, () => {
      for (const sql of ALLOWED[dialect]) {
        it(`allows: ${sql}`, () => {
          expect(() => assertReadOnlySql(dialect, sql)).not.toThrow();
        });
      }
    });
  }

  for (const { dialect, sql, reason } of BLOCKED) {
    it(`blocks [${dialect}] ${reason}: ${sql}`, () => {
      expect(() => assertReadOnlySql(dialect, sql)).toThrow(SqlGuardError);
    });
  }

  it("rejects empty sql", () => {
    expect(() => assertReadOnlySql("postgres", "   ")).toThrow(SqlGuardError);
  });

  it("rejects overly long sql", () => {
    const huge = "SELECT '" + "a".repeat(200_000) + "'";
    expect(() => assertReadOnlySql("postgres", huge)).toThrow(SqlGuardError);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error testing runtime guard
    expect(() => assertReadOnlySql("postgres", 123)).toThrow(SqlGuardError);
  });

  it("rejects multiple statements even with trailing semicolon", () => {
    expect(() => assertReadOnlySql("postgres", "SELECT 1;")).not.toThrow();
  });

  it("rejects stacked queries separated by ;", () => {
    expect(() => assertReadOnlySql("postgres", "SELECT 1; SELECT 2")).toThrow(SqlGuardError);
  });
});

describe("assertReadOnlySql with database allowlist", () => {
  const policy = { allowed: ["catastral", "catastro"], requireQualified: true };

  it("allows SQL Server cross-database query inside allowlist", () => {
    const sql =
      "SELECT * FROM [catastral].[dbo].[Predios] p JOIN [catastro].[dbo].[Titulares] t ON t.id = p.id";
    expect(() => assertReadOnlySql("mssql", sql, policy)).not.toThrow();
  });

  it("blocks SQL Server query against a database not in the allowlist", () => {
    const sql = "SELECT * FROM [otra_base].[dbo].[Usuarios]";
    expect(() => assertReadOnlySql("mssql", sql, policy)).toThrow(SqlGuardError);
  });

  it("blocks unqualified SQL Server table when requireQualified is true", () => {
    const sql = "SELECT * FROM dbo.Predios";
    expect(() => assertReadOnlySql("mssql", sql, policy)).toThrow(SqlGuardError);
  });

  it("allows MySQL cross-database query inside allowlist", () => {
    const sql = "SELECT * FROM `catastral`.`Predios` p JOIN `catastro`.`Titulares` t ON t.id = p.id";
    expect(() => assertReadOnlySql("mysql", sql, policy)).not.toThrow();
  });

  it("blocks MySQL query against a database not in the allowlist", () => {
    const sql = "SELECT * FROM `otra`.`Usuarios`";
    expect(() => assertReadOnlySql("mysql", sql, policy)).toThrow(SqlGuardError);
  });

  it("blocks unqualified MySQL table when requireQualified is true", () => {
    const sql = "SELECT * FROM Predios";
    expect(() => assertReadOnlySql("mysql", sql, policy)).toThrow(SqlGuardError);
  });

  it("allows PostgreSQL schema-qualified query inside allowlist", () => {
    const sql = 'SELECT * FROM "app"."public"."users"';
    const pgPolicy = { allowed: ["app"], requireQualified: true };
    expect(() => assertReadOnlySql("postgres", sql, pgPolicy)).not.toThrow();
  });

  it("blocks PostgreSQL query against a database not in the allowlist", () => {
    const sql = 'SELECT * FROM "otra"."public"."users"';
    const pgPolicy = { allowed: ["app"], requireQualified: true };
    expect(() => assertReadOnlySql("postgres", sql, pgPolicy)).toThrow(SqlGuardError);
  });

  it("does not enforce policy when not provided", () => {
    const sql = "SELECT * FROM dbo.Predios";
    expect(() => assertReadOnlySql("mssql", sql)).not.toThrow();
  });

  it("allows any database when policy.allowed is all", () => {
    const sql = "SELECT * FROM [anywhere].[dbo].[Users]";
    const openPolicy = { allowed: "all" as const, requireQualified: false };
    expect(() => assertReadOnlySql("mssql", sql, openPolicy)).not.toThrow();
  });

  it("blocks forbidden statements even with database policy", () => {
    const sql = "DELETE FROM [catastral].[dbo].[Predios]";
    expect(() => assertReadOnlySql("mssql", sql, policy)).toThrow(SqlGuardError);
  });
});
