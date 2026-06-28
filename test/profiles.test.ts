import { describe, it, expect } from "vitest";
import { loadAllProfiles, loadProfile, ProfileError } from "../src/config/profiles.js";

function withEnv(env: Record<string, string>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    previous[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("loadProfile", () => {
  it("loads a postgres profile with server scope and allowlist", () => {
    withEnv(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_PORT: "5432",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_SSL: "true",
        DB_PG_ALLOWED_DATABASES: "app,analytics",
        DB_PG_REQUIRE_QUALIFIED_DATABASE: "true",
      },
      () => {
        const p = loadProfile("PG", process.env);
        expect(p.scope).toBe("server");
        expect(p.initialDatabase).toBe("postgres");
        expect(p.allowedDatabases).toEqual(["app", "analytics"]);
        expect(p.requireQualifiedDatabase).toBe(true);
        if (p.connection.kind === "postgres") {
          expect(p.connection.database).toBe("postgres");
          expect(p.connection.ssl).toBe(true);
        } else {
          throw new Error("Expected postgres connection");
        }
      },
    );
  });

  it("honors DB_<NAME>_INITIAL_DATABASE for postgres", () => {
    withEnv(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_PORT: "5432",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_INITIAL_DATABASE: "app",
        DB_PG_ALLOWED_DATABASES: "app,analytics",
      },
      () => {
        const p = loadProfile("PG", process.env);
        expect(p.initialDatabase).toBe("app");
      },
    );
  });

  it("loads a sqlite profile from a relative path (database scope)", () => {
    withEnv(
      {
        DB_SQLITE_CLIENT: "sqlite",
        DB_SQLITE_FILENAME: "./data/demo.sqlite",
        DB_SQLITE_ALLOWED_DATABASES: "main",
      },
      () => {
        const p = loadProfile("SQLITE", process.env);
        expect(p.scope).toBe("database");
        expect(p.dialect).toBe("sqlite");
        if (p.connection.kind === "sqlite") {
          expect(p.connection.filename.replace(/\\/g, "/").endsWith("data/demo.sqlite")).toBe(true);
        } else {
          throw new Error("Expected sqlite connection");
        }
      },
    );
  });

  it("rejects sqlite with absolute path", () => {
    withEnv(
      {
        DB_SQLITE_CLIENT: "sqlite",
        DB_SQLITE_FILENAME: "/etc/passwd",
        DB_SQLITE_ALLOWED_DATABASES: "main",
      },
      () => {
        expect(() => loadProfile("SQLITE", process.env)).toThrow(ProfileError);
      },
    );
  });

  it("rejects sqlite with path traversal", () => {
    withEnv(
      {
        DB_SQLITE_CLIENT: "sqlite",
        DB_SQLITE_FILENAME: "./../escape.sqlite",
        DB_SQLITE_ALLOWED_DATABASES: "main",
      },
      () => {
        expect(() => loadProfile("SQLITE", process.env)).toThrow(ProfileError);
      },
    );
  });

  it("loads a mssql profile with trustServerCertificate", () => {
    withEnv(
      {
        DB_MS_CLIENT: "mssql",
        DB_MS_HOST: "localhost",
        DB_MS_PORT: "1433",
        DB_MS_USER: "readonly",
        DB_MS_PASSWORD: "secret",
        DB_MS_ENCRYPT: "true",
        DB_MS_TRUST_SERVER_CERTIFICATE: "true",
        DB_MS_ALLOWED_DATABASES: "catastral,catastro",
      },
      () => {
        const p = loadProfile("MS", process.env);
        expect(p.scope).toBe("server");
        expect(p.allowedDatabases).toEqual(["catastral", "catastro"]);
        if (p.connection.kind === "mssql") {
          expect(p.connection.encrypt).toBe(true);
          expect(p.connection.trustServerCertificate).toBe(true);
          expect(p.connection.database).toBe("master");
        } else {
          throw new Error("Expected mssql connection");
        }
      },
    );
  });

  it("rejects invalid profile names", () => {
    expect(() => loadProfile("bad name", process.env)).toThrow(ProfileError);
  });

  it("rejects missing ALLOWED_DATABASES for server-scope profile", () => {
    withEnv(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
      },
      () => {
        expect(() => loadProfile("PG", process.env)).toThrow(ProfileError);
      },
    );
  });

  it("accepts '*' as a wildcard for ALLOWED_DATABASES", () => {
    withEnv(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_ALLOWED_DATABASES: "*",
      },
      () => {
        const p = loadProfile("PG", process.env);
        expect(p.allowedDatabases).toBe("all");
      },
    );
  });

  it("rejects invalid characters in ALLOWED_DATABASES entries", () => {
    withEnv(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_ALLOWED_DATABASES: "good; DROP TABLE x",
      },
      () => {
        expect(() => loadProfile("PG", process.env)).toThrow(ProfileError);
      },
    );
  });
});

describe("loadAllProfiles", () => {
  it("returns empty list when no names are provided", () => {
    expect(loadAllProfiles([], process.env)).toEqual([]);
  });
});
