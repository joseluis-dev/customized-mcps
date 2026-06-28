import type { SupportedDialect } from "../types.js";

export function parserDialectFor(dialect: SupportedDialect): string {
  switch (dialect) {
    case "postgres":
      return "PostgreSQL";
    case "mysql":
    case "mariadb":
      return "MySQL";
    case "sqlite":
      return "SQLite";
    case "mssql":
      return "TransactSQL";
  }
}

export function knexDialectFor(dialect: SupportedDialect): string {
  switch (dialect) {
    case "postgres":
      return "pg";
    case "mysql":
    case "mariadb":
      return "mysql2";
    case "sqlite":
      return "sqlite3";
    case "mssql":
      return "mssql";
  }
}
