import path from "node:path";
import { readBool, readInt, readOptionalString, readString } from "./env.js";
import type { KnexConnectionConfig, Profile, SupportedDialect } from "../types.js";

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

const SUPPORTED_DIALECTS: SupportedDialect[] = [
  "postgres",
  "mysql",
  "mariadb",
  "sqlite",
  "mssql",
];

function toDialect(client: string): SupportedDialect {
  const c = client.toLowerCase();
  if (c === "pg" || c === "postgres" || c === "postgresql") return "postgres";
  if (c === "mysql" || c === "mysql2") return "mysql";
  if (c === "mariadb") return "mariadb";
  if (c === "sqlite" || c === "sqlite3") return "sqlite";
  if (c === "mssql" || c === "sqlserver" || c === "tedious") return "mssql";
  throw new ProfileError(`Unsupported client: ${client}`);
}

function knexClientFor(dialect: SupportedDialect): string {
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

function defaultInitialDatabase(dialect: SupportedDialect): string {
  switch (dialect) {
    case "postgres":
      return "postgres";
    case "mysql":
    case "mariadb":
      return "mysql";
    case "sqlite":
      return "main";
    case "mssql":
      return "master";
  }
}

const projectRoot = path.resolve(process.cwd());

function resolveRelativeToProject(rel: string, profileName: string): string {
  if (path.isAbsolute(rel)) {
    throw new ProfileError(
      `Profile "${profileName}": SQLite filename must be a relative path`,
    );
  }
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.includes("..")) {
    throw new ProfileError(
      `Profile "${profileName}": SQLite filename must not contain '..' segments`,
    );
  }
  const resolved = path.resolve(projectRoot, rel);
  const relToRoot = path.relative(projectRoot, resolved);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new ProfileError(
      `Profile "${profileName}": resolved SQLite path escapes the project root`,
    );
  }
  return resolved;
}

function buildConnection(
  name: string,
  raw: Record<string, string | undefined>,
  dialect: SupportedDialect,
  initialDatabase: string,
): KnexConnectionConfig {
  switch (dialect) {
    case "postgres": {
      const host = readString(`DB_${name}_HOST`);
      const port = readInt(`DB_${name}_PORT`, 5432);
      const user = readString(`DB_${name}_USER`);
      const password = readString(`DB_${name}_PASSWORD`);
      const ssl = readBool(`DB_${name}_SSL`, false);
      return { kind: "postgres", host, port, database: initialDatabase, user, password, ssl };
    }
    case "mysql": {
      const host = readString(`DB_${name}_HOST`);
      const port = readInt(`DB_${name}_PORT`, 3306);
      const user = readString(`DB_${name}_USER`);
      const password = readString(`DB_${name}_PASSWORD`);
      return { kind: "mysql", host, port, database: initialDatabase, user, password };
    }
    case "sqlite": {
      const filename = readString(`DB_${name}_FILENAME`);
      const resolved = resolveRelativeToProject(filename, name);
      return { kind: "sqlite", filename: resolved };
    }
    case "mariadb": {
      const host = readString(`DB_${name}_HOST`);
      const port = readInt(`DB_${name}_PORT`, 3306);
      const user = readString(`DB_${name}_USER`);
      const password = readString(`DB_${name}_PASSWORD`);
      return { kind: "mysql", host, port, database: initialDatabase, user, password };
    }
    case "mssql": {
      const host = readString(`DB_${name}_HOST`);
      const port = readInt(`DB_${name}_PORT`, 1433);
      const user = readString(`DB_${name}_USER`);
      const password = readString(`DB_${name}_PASSWORD`);
      const encrypt = readBool(`DB_${name}_ENCRYPT`, true);
      const trustServerCertificate = readBool(`DB_${name}_TRUST_SERVER_CERTIFICATE`, false);
      return {
        kind: "mssql",
        host,
        port,
        database: initialDatabase,
        user,
        password,
        encrypt,
        trustServerCertificate,
      };
    }
  }
}

function parseAllowedDatabases(
  raw: Record<string, string | undefined>,
  name: string,
): string[] | "all" {
  const value = readOptionalString(`DB_${name}_ALLOWED_DATABASES`);
  if (value === undefined || value === "") {
    throw new ProfileError(
      `Profile "${name}": DB_${name}_ALLOWED_DATABASES is required (use "*" to allow all visible to the read-only user)`,
    );
  }
  const trimmed = value.trim();
  if (trimmed === "*") return "all";
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new ProfileError(
      `Profile "${name}": DB_${name}_ALLOWED_DATABASES must list at least one database or be "*"`,
    );
  }
  for (const p of parts) {
    if (!/^[A-Za-z0-9_\-$]+$/.test(p)) {
      throw new ProfileError(
        `Profile "${name}": invalid database identifier "${p}" in DB_${name}_ALLOWED_DATABASES`,
      );
    }
  }
  return parts;
}

function parseInitialDatabase(
  raw: Record<string, string | undefined>,
  name: string,
  dialect: SupportedDialect,
): string {
  const v = readOptionalString(`DB_${name}_INITIAL_DATABASE`) ??
    readOptionalString(`DB_${name}_DATABASE`);
  if (v && v.trim().length > 0) return v.trim();
  return defaultInitialDatabase(dialect);
}

export function loadProfile(name: string, raw: Record<string, string | undefined>): Profile {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new ProfileError(`Invalid profile name: ${name}`);
  }
  const clientRaw = readString(`DB_${name}_CLIENT`);
  const dialect = toDialect(clientRaw);
  if (!SUPPORTED_DIALECTS.includes(dialect)) {
    throw new ProfileError(`Unsupported dialect for profile ${name}: ${dialect}`);
  }
  const scope: "server" | "database" =
    dialect === "sqlite" ? "database" : "server";
  const allowedDatabases = parseAllowedDatabases(raw, name);
  const requireQualifiedDatabase = readBool(
    `DB_${name}_REQUIRE_QUALIFIED_DATABASE`,
    scope === "server",
  );
  const initialDatabase = parseInitialDatabase(raw, name, dialect);
  const connection = buildConnection(name, raw, dialect, initialDatabase);
  const client = knexClientFor(dialect);
  const knexOptions: Record<string, unknown> = {};
  if (dialect === "sqlite") {
    knexOptions.useNullAsDefault = true;
  }
  return {
    name,
    dialect,
    client,
    connection,
    knexOptions,
    scope,
    initialDatabase,
    allowedDatabases,
    requireQualifiedDatabase,
  };
}

export function loadAllProfiles(
  profileNames: string[],
  raw: Record<string, string | undefined>,
): Profile[] {
  if (profileNames.length === 0) {
    return [];
  }
  return profileNames.map((n) => loadProfile(n, raw));
}
