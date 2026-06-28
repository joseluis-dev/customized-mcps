import knex, { Knex } from "knex";
import type { Profile } from "../types.js";
import { knexDialectFor } from "./dialects.js";

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbError";
  }
}

function buildKnexConfig(profile: Profile): Knex.Config {
  const client = knexDialectFor(profile.dialect);
  switch (profile.connection.kind) {
    case "postgres":
      return {
        client,
        connection: {
          host: profile.connection.host,
          port: profile.connection.port,
          database: profile.connection.database,
          user: profile.connection.user,
          password: profile.connection.password,
          ssl: profile.connection.ssl,
          application_name: "mcp-readonly-sql",
        },
        pool: { min: 0, max: 5, idleTimeoutMillis: 30_000 },
        ...profile.knexOptions,
      };
    case "mysql":
      return {
        client,
        connection: {
          host: profile.connection.host,
          port: profile.connection.port,
          database: profile.connection.database,
          user: profile.connection.user,
          password: profile.connection.password,
        },
        pool: { min: 0, max: 5, idleTimeoutMillis: 30_000 },
        ...profile.knexOptions,
      };
    case "sqlite": {
      return {
        client,
        connection: {
          filename: profile.connection.filename,
        },
        pool: { min: 0, max: 1, afterCreate: enableSqliteQueryOnly },
        useNullAsDefault: true,
        ...profile.knexOptions,
      };
    }
    case "mssql": {
      return {
        client,
        connection: {
          server: profile.connection.host,
          port: profile.connection.port,
          database: profile.connection.database,
          user: profile.connection.user,
          password: profile.connection.password,
          options: {
            encrypt: profile.connection.encrypt,
            trustServerCertificate: profile.connection.trustServerCertificate,
            enableArithAbort: true,
          },
        },
        pool: { min: 0, max: 5, idleTimeoutMillis: 30_000 },
        ...profile.knexOptions,
      };
    }
  }
}

export class ConnectionManager {
  private readonly instances = new Map<string, Knex>();

  get(profile: Profile): Knex {
    const existing = this.instances.get(profile.name);
    if (existing) return existing;
    const k = knex(buildKnexConfig(profile));
    this.instances.set(profile.name, k);
    return k;
  }

  async destroyAll(): Promise<void> {
    const all = Array.from(this.instances.values());
    this.instances.clear();
    for (const k of all) {
      try {
        await k.destroy();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export async function withReadOnlyTransaction<T>(
  k: Knex,
  dialect: Profile["dialect"],
  fn: (trx: Knex.Transaction) => Promise<T>,
  beforeStatement?: (trx: Knex.Transaction) => Promise<void>,
): Promise<T> {
  return k.transaction(async (trx) => {
    if (dialect === "postgres") {
      await trx.raw("SET TRANSACTION READ ONLY");
    } else if (dialect === "mysql" || dialect === "mariadb") {
      await trx.raw("SET SESSION TRANSACTION READ ONLY");
    } else if (dialect === "sqlite") {
      await trx.raw("PRAGMA query_only = ON");
    } else if (dialect === "mssql") {
      try {
        await trx.raw("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED");
      } catch {
        // some Azure SQL setups reject this; isolation is not the safety net, the guard is
      }
    }
    if (beforeStatement) {
      await beforeStatement(trx);
    }
    return fn(trx);
  });
}

function enableSqliteQueryOnly(conn: unknown, done: (err: Error | null) => void): void {
  try {
    const c = conn as { all?: (sql: string, cb: (err: Error | null) => void) => void };
    if (typeof c.all === "function") {
      c.all("PRAGMA query_only = ON", (err) => done(err ?? null));
      return;
    }
    done(null);
  } catch (e) {
    done(e as Error);
  }
}
