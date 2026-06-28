import path from "node:path";
import { readBool, readInt, readOptionalString, readString } from "./env.js";
import type { KnexConnectionConfig, Profile, SupportedDialect } from "../types.js";
import { FileSecretProvider, parseSecretRef } from "../secrets/SecretProvider.js";

export class ProfileError extends Error {
  readonly kind: string | undefined;
  readonly alias: string | undefined;
  constructor(
    message: string,
    options: { kind?: string; alias?: string } = {},
  ) {
    super(message);
    this.name = "ProfileError";
    this.kind = options.kind;
    this.alias = options.alias;
  }
}

const ALIAS_REGEX = /^[A-Za-z0-9_]+$/;
const ALIAS_MAX_LENGTH = 64;
const UNSAFE_DISPLAY_PATTERNS: RegExp[] = [
  /\$\{secret:[^}]*\}/i,
  /[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\s@]+:[^\s@]+@/i,
  /\b(password|passwd|pwd|secret|token|api[_-]?key|connection[_-]?string)\b\s*[=:]\s*[^\s;]+/i,
  /\b(?:password|passwd|pwd)\s*=\s*[^;\s]+/i,
  /\b(?:user|uid)\s*=\s*[^;\s]+/i,
];

export function isUnsafeDisplayMetadata(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  for (const p of UNSAFE_DISPLAY_PATTERNS) {
    if (p.test(value)) return true;
  }
  return false;
}

function parseAlias(name: string): string {
  const v = readOptionalString(`DB_${name}_ALIAS`);
  if (v === undefined) return name;
  const trimmed = v.trim();
  if (trimmed.length === 0) return name;
  if (trimmed.length > ALIAS_MAX_LENGTH) {
    throw new ProfileError(
      `Invalid alias for profile "${name}": alias exceeds ${ALIAS_MAX_LENGTH} characters`,
      { kind: "alias" },
    );
  }
  if (!ALIAS_REGEX.test(trimmed)) {
    throw new ProfileError(
      `Invalid alias for profile "${name}": alias must match ${ALIAS_REGEX.source}`,
      { kind: "alias" },
    );
  }
  return trimmed;
}

function parseCommaList(value: string | undefined): string[] {
  if (value === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const t = raw.trim();
    if (t.length === 0) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseMetadata(name: string, alias: string): {
  displayName?: string;
  description?: string;
  tags?: string[];
  capabilities: string[];
} {
  const rawDisplay = readOptionalString(`DB_${name}_DISPLAY_NAME`);
  const rawDescription = readOptionalString(`DB_${name}_DESCRIPTION`);
  const rawTags = readOptionalString(`DB_${name}_TAGS`);
  const rawCapabilities = readOptionalString(`DB_${name}_CAPABILITIES`);

  const displayName =
    rawDisplay !== undefined && !isUnsafeDisplayMetadata(rawDisplay)
      ? rawDisplay
      : undefined;
  const description =
    rawDescription !== undefined && !isUnsafeDisplayMetadata(rawDescription)
      ? rawDescription
      : undefined;
  const tagsAll = rawTags !== undefined ? parseCommaList(rawTags) : [];
  const tags = tagsAll.filter((t) => !isUnsafeDisplayMetadata(t));

  const capabilities =
    rawCapabilities !== undefined
      ? parseCommaList(rawCapabilities)
      : ["read-only"];
  if (capabilities.length === 0) capabilities.push("read-only");

  const out: ReturnType<typeof parseMetadata> = { capabilities };
  if (displayName !== undefined) out.displayName = displayName;
  if (description !== undefined) out.description = description;
  if (tags.length > 0) out.tags = tags;
  if (rawDisplay !== undefined && displayName === undefined) {
    warnUnsafeMetadata(alias, "displayName");
  }
  if (rawDescription !== undefined && description === undefined) {
    warnUnsafeMetadata(alias, "description");
  }
  for (const t of tagsAll) {
    if (isUnsafeDisplayMetadata(t)) {
      warnUnsafeMetadata(alias, "tags");
      break;
    }
  }
  return out;
}

function warnUnsafeMetadata(alias: string, field: string): void {
  process.stderr.write(
    `[mcp-readonly-sql] Profile "${alias}": omitted unsafe ${field} (value matched a sensitive pattern)\n`,
  );
}

function checkAliasCollisions(
  candidates: Array<{ alias: string; operatorKey: string }>,
): void {
  const aliasOwners = new Map<string, string>(); // lower -> original
  const operatorOwners = new Map<string, string>(); // lower -> original
  for (const c of candidates) {
    operatorOwners.set(c.operatorKey.toLowerCase(), c.operatorKey);
  }
  for (const c of candidates) {
    const aliasKey = c.alias.toLowerCase();
    const dup = aliasOwners.get(aliasKey);
    if (dup !== undefined) {
      throw new ProfileError(
        `Duplicate alias "${c.alias}"`,
        { kind: "alias", alias: c.alias },
      );
    }
    if (operatorOwners.has(aliasKey) && aliasKey !== c.operatorKey.toLowerCase()) {
      throw new ProfileError(
        `Alias "${c.alias}" collides with another profile's operator key`,
        { kind: "alias", alias: c.alias },
      );
    }
    aliasOwners.set(aliasKey, c.alias);
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
  alias: string,
  raw: Record<string, string | undefined>,
  dialect: SupportedDialect,
  initialDatabase: string,
  secretProvider: FileSecretProvider,
): Promise<KnexConnectionConfig> | KnexConnectionConfig {
  switch (dialect) {
    case "postgres": {
      const host = readString(`DB_${name}_HOST`);
      const port = readInt(`DB_${name}_PORT`, 5432);
      const user = readString(`DB_${name}_USER`);
      const ssl = readBool(`DB_${name}_SSL`, false);
      return resolvePassword(`DB_${name}_PASSWORD`, alias, secretProvider).then(
        (password) => ({
          kind: "postgres" as const,
          host,
          port,
          database: initialDatabase,
          user,
          password,
          ssl,
        }),
      );
    }
    case "mysql": {
      const host = readString(`DB_${name}_HOST`);
      const port = readInt(`DB_${name}_PORT`, 3306);
      const user = readString(`DB_${name}_USER`);
      return resolvePassword(`DB_${name}_PASSWORD`, alias, secretProvider).then(
        (password) => ({
          kind: "mysql" as const,
          host,
          port,
          database: initialDatabase,
          user,
          password,
        }),
      );
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
      return resolvePassword(`DB_${name}_PASSWORD`, alias, secretProvider).then(
        (password) => ({
          kind: "mysql" as const,
          host,
          port,
          database: initialDatabase,
          user,
          password,
        }),
      );
    }
    case "mssql": {
      const host = readString(`DB_${name}_HOST`);
      const port = readInt(`DB_${name}_PORT`, 1433);
      const user = readString(`DB_${name}_USER`);
      const encrypt = readBool(`DB_${name}_ENCRYPT`, true);
      const trustServerCertificate = readBool(`DB_${name}_TRUST_SERVER_CERTIFICATE`, false);
      return resolvePassword(`DB_${name}_PASSWORD`, alias, secretProvider).then(
        (password) => ({
          kind: "mssql" as const,
          host,
          port,
          database: initialDatabase,
          user,
          password,
          encrypt,
          trustServerCertificate,
        }),
      );
    }
  }
}

async function resolvePassword(
  envName: string,
  alias: string,
  provider: FileSecretProvider,
): Promise<string> {
  const raw = readString(envName);
  const ref = parseSecretRef(raw);
  if (!ref) return raw;
  try {
    return await provider.resolve(raw, { alias });
  } catch (e) {
    const err = e as Error & { kind?: string };
    throw new ProfileError(
      `Profile "${alias}": could not resolve the connection password (${err.kind ?? "secret"} kind)`,
      { kind: err.kind ?? "secret", alias },
    );
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

export function loadProfile(
  name: string,
  raw: Record<string, string | undefined>,
  options: { secretProvider?: FileSecretProvider } = {},
): Promise<Profile> {
  try {
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      throw new ProfileError(`Invalid profile name: ${name}`);
    }
    const alias = parseAlias(name);
    const clientRaw = readString(`DB_${name}_CLIENT`);
    const dialect = toDialect(clientRaw);
    if (!SUPPORTED_DIALECTS.includes(dialect)) {
      throw new ProfileError(
        `Unsupported dialect for profile ${name}: ${dialect}`,
      );
    }
    const scope: "server" | "database" =
      dialect === "sqlite" ? "database" : "server";
    const allowedDatabases = parseAllowedDatabases(raw, name);
    const requireQualifiedDatabase = readBool(
      `DB_${name}_REQUIRE_QUALIFIED_DATABASE`,
      scope === "server",
    );
    const initialDatabase = parseInitialDatabase(raw, name, dialect);
    const metadata = parseMetadata(name, alias);
    const secretProvider =
      options.secretProvider ?? new FileSecretProvider();
    const connectionResult = buildConnection(
      name,
      alias,
      raw,
      dialect,
      initialDatabase,
      secretProvider,
    );
    return Promise.resolve(connectionResult).then(
      (connection): Profile => {
        const client = knexClientFor(dialect);
        const knexOptions: Record<string, unknown> = {};
        if (dialect === "sqlite") {
          knexOptions.useNullAsDefault = true;
        }
        const profile: Profile = {
          name: alias,
          alias,
          operatorKey: name,
          dialect,
          client,
          connection,
          knexOptions,
          scope,
          initialDatabase,
          allowedDatabases,
          requireQualifiedDatabase,
          capabilities: metadata.capabilities,
        };
        if (metadata.displayName !== undefined) {
          profile.displayName = metadata.displayName;
        }
        if (metadata.description !== undefined) {
          profile.description = metadata.description;
        }
        if (metadata.tags !== undefined) {
          profile.tags = metadata.tags;
        }
        return profile;
      },
    );
  } catch (e) {
    return Promise.reject(e);
  }
}

export function loadAllProfiles(
  profileNames: string[],
  raw: Record<string, string | undefined>,
  options: { secretProvider?: FileSecretProvider } = {},
): Promise<Profile[]> {
  if (profileNames.length === 0) {
    return Promise.resolve([]);
  }
  const secretProvider = options.secretProvider ?? new FileSecretProvider();
  return Promise.all(
    profileNames.map((n) => loadProfile(n, raw, { secretProvider })),
  ).then((profiles) => {
    checkAliasCollisions(
      profiles.map((p) => ({ alias: p.alias, operatorKey: p.operatorKey })),
    );
    return profiles;
  });
}
