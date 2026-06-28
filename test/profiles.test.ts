import { describe, it, expect, vi } from "vitest";
import { loadAllProfiles, loadProfile, ProfileError } from "../src/config/profiles.js";

describe("loadProfile", () => {
  it("loads a postgres profile with server scope and allowlist", async () => {
    await withEnvAsync(
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
      async () => {
        const p = await loadProfile("PG", process.env);
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

  it("honors DB_<NAME>_INITIAL_DATABASE for postgres", async () => {
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_PORT: "5432",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_INITIAL_DATABASE: "app",
        DB_PG_ALLOWED_DATABASES: "app,analytics",
      },
      async () => {
        const p = await loadProfile("PG", process.env);
        expect(p.initialDatabase).toBe("app");
      },
    );
  });

  it("loads a sqlite profile from a relative path (database scope)", async () => {
    await withEnvAsync(
      {
        DB_SQLITE_CLIENT: "sqlite",
        DB_SQLITE_FILENAME: "./data/demo.sqlite",
        DB_SQLITE_ALLOWED_DATABASES: "main",
      },
      async () => {
        const p = await loadProfile("SQLITE", process.env);
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

  it("rejects sqlite with absolute path", async () => {
    await withEnvAsync(
      {
        DB_SQLITE_CLIENT: "sqlite",
        DB_SQLITE_FILENAME: "/etc/passwd",
        DB_SQLITE_ALLOWED_DATABASES: "main",
      },
      async () => {
        await expect(loadProfile("SQLITE", process.env)).rejects.toBeInstanceOf(ProfileError);
      },
    );
  });

  it("rejects sqlite with path traversal", async () => {
    await withEnvAsync(
      {
        DB_SQLITE_CLIENT: "sqlite",
        DB_SQLITE_FILENAME: "./../escape.sqlite",
        DB_SQLITE_ALLOWED_DATABASES: "main",
      },
      async () => {
        await expect(loadProfile("SQLITE", process.env)).rejects.toBeInstanceOf(ProfileError);
      },
    );
  });

  it("loads a mssql profile with trustServerCertificate", async () => {
    await withEnvAsync(
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
      async () => {
        const p = await loadProfile("MS", process.env);
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

  it("rejects invalid profile names", async () => {
    await expect(loadProfile("bad name", process.env)).rejects.toBeInstanceOf(ProfileError);
  });

  it("rejects missing ALLOWED_DATABASES for server-scope profile", async () => {
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
      },
      async () => {
        await expect(loadProfile("PG", process.env)).rejects.toBeInstanceOf(ProfileError);
      },
    );
  });

  it("accepts '*' as a wildcard for ALLOWED_DATABASES", async () => {
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_ALLOWED_DATABASES: "*",
      },
      async () => {
        const p = await loadProfile("PG", process.env);
        expect(p.allowedDatabases).toBe("all");
      },
    );
  });

  it("rejects invalid characters in ALLOWED_DATABASES entries", async () => {
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_ALLOWED_DATABASES: "good; DROP TABLE x",
      },
      async () => {
        await expect(loadProfile("PG", process.env)).rejects.toBeInstanceOf(ProfileError);
      },
    );
  });

  it("defaults alias to operator key when DB_<NAME>_ALIAS is not set", async () => {
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_ALLOWED_DATABASES: "app",
      },
      async () => {
        const p = await loadProfile("PG", process.env);
        expect(p.alias).toBe("PG");
        expect(p.name).toBe("PG");
        expect(p.operatorKey).toBe("PG");
        expect(p.capabilities).toEqual(["read-only"]);
      },
    );
  });

  it("uses explicit DB_<NAME>_ALIAS when set, with operator key kept server-side", async () => {
    await withEnvAsync(
      {
        DB_SQLSERVER_BI_CLIENT: "mssql",
        DB_SQLSERVER_BI_HOST: "localhost",
        DB_SQLSERVER_BI_USER: "readonly",
        DB_SQLSERVER_BI_PASSWORD: "secret",
        DB_SQLSERVER_BI_ALLOWED_DATABASES: "catastral",
        DB_SQLSERVER_BI_ALIAS: "bi_catastro",
      },
      async () => {
        const p = await loadProfile("SQLSERVER_BI", process.env);
        expect(p.alias).toBe("bi_catastro");
        expect(p.name).toBe("bi_catastro");
        expect(p.operatorKey).toBe("SQLSERVER_BI");
      },
    );
  });

  it("rejects invalid alias characters", async () => {
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_ALLOWED_DATABASES: "app",
        DB_PG_ALIAS: "bi-catastro!",
      },
      async () => {
        let caught: unknown;
        try {
          await loadProfile("PG", process.env);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ProfileError);
        const msg = (caught as Error).message;
        expect(msg).toContain("alias");
        expect(msg).not.toContain("localhost");
        expect(msg).not.toContain("readonly");
        expect(msg).not.toContain("password");
      },
    );
  });

  it("rejects alias longer than 64 characters", async () => {
    const long = "a".repeat(65);
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_ALLOWED_DATABASES: "app",
        DB_PG_ALIAS: long,
      },
      async () => {
        await expect(loadProfile("PG", process.env)).rejects.toBeInstanceOf(ProfileError);
      },
    );
  });

  it("parses displayName, description, and trims/dedupes tags", async () => {
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_ALLOWED_DATABASES: "app",
        DB_PG_ALIAS: "bi_catastro",
        DB_PG_DISPLAY_NAME: "Catastro BI",
        DB_PG_DESCRIPTION: "Catastro data warehouse",
        DB_PG_TAGS: "bi, finance, ",
      },
      async () => {
        const p = await loadProfile("PG", process.env);
        expect(p.displayName).toBe("Catastro BI");
        expect(p.description).toBe("Catastro data warehouse");
        expect(p.tags).toEqual(["bi", "finance"]);
      },
    );
  });

  it("deduplicates tags (first-seen wins)", async () => {
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_ALLOWED_DATABASES: "app",
        DB_PG_TAGS: "bi, finance, bi, ops, finance",
      },
      async () => {
        const p = await loadProfile("PG", process.env);
        expect(p.tags).toEqual(["bi", "finance", "ops"]);
      },
    );
  });

  it("parses explicit capabilities", async () => {
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: "secret",
        DB_PG_ALLOWED_DATABASES: "app",
        DB_PG_CAPABILITIES: "read-only,explain",
      },
      async () => {
        const p = await loadProfile("PG", process.env);
        expect(p.capabilities).toEqual(["read-only", "explain"]);
      },
    );
  });

  it("warns to stderr with alias (not operator key) when displayName matches an unsafe pattern", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await withEnvAsync(
        {
          DB_SQLSERVER_BI_CLIENT: "postgres",
          DB_SQLSERVER_BI_HOST: "localhost",
          DB_SQLSERVER_BI_USER: "readonly",
          DB_SQLSERVER_BI_PASSWORD: "secret",
          DB_SQLSERVER_BI_ALLOWED_DATABASES: "app",
          DB_SQLSERVER_BI_ALIAS: "bi_catastro",
          DB_SQLSERVER_BI_DISPLAY_NAME: "Server=db;password=hunter2;",
        },
        async () => {
          const p = await loadProfile("SQLSERVER_BI", process.env);
          // Unsafe value is dropped from the profile
          expect(p.displayName).toBeUndefined();
          const joined = stderrSpy.mock.calls
            .map((c) => String(c[0] ?? ""))
            .join("");
          expect(joined).toContain("bi_catastro");
          expect(joined).not.toContain("SQLSERVER_BI");
          expect(joined).not.toContain("hunter2");
          expect(joined).not.toContain("password=");
        },
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("warns to stderr with alias (not operator key) when a tag matches an unsafe pattern", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await withEnvAsync(
        {
          DB_SQLSERVER_BI_CLIENT: "postgres",
          DB_SQLSERVER_BI_HOST: "localhost",
          DB_SQLSERVER_BI_USER: "readonly",
          DB_SQLSERVER_BI_PASSWORD: "secret",
          DB_SQLSERVER_BI_ALLOWED_DATABASES: "app",
          DB_SQLSERVER_BI_ALIAS: "bi_catastro",
          DB_SQLSERVER_BI_TAGS: "bi,password=hunter2",
        },
        async () => {
          const p = await loadProfile("SQLSERVER_BI", process.env);
          expect(p.tags).toEqual(["bi"]);
          const joined = stderrSpy.mock.calls
            .map((c) => String(c[0] ?? ""))
            .join("");
          expect(joined).toContain("bi_catastro");
          expect(joined).not.toContain("SQLSERVER_BI");
          expect(joined).not.toContain("hunter2");
        },
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("isUnsafeDisplayMetadata", () => {
  it("flags a raw secret ref literal", async () => {
    const { isUnsafeDisplayMetadata } = await import(
      "../src/config/profiles.js"
    );
    expect(isUnsafeDisplayMetadata("${secret:file:/etc/pw}")).toBe(true);
  });

  it("flags a value containing a DSN credential pair", async () => {
    const { isUnsafeDisplayMetadata } = await import(
      "../src/config/profiles.js"
    );
    expect(isUnsafeDisplayMetadata("Server=db;password=secret123;")).toBe(true);
  });

  it("flags a URI with embedded credentials", async () => {
    const { isUnsafeDisplayMetadata } = await import(
      "../src/config/profiles.js"
    );
    expect(isUnsafeDisplayMetadata("postgres://user:pass@db/app")).toBe(true);
  });

  it("flags case-insensitive sensitive labels", async () => {
    const { isUnsafeDisplayMetadata } = await import(
      "../src/config/profiles.js"
    );
    expect(isUnsafeDisplayMetadata("PASSWORD=foo")).toBe(true);
    expect(isUnsafeDisplayMetadata("api-key:bar")).toBe(true);
  });

  it("does not flag a clean display value", async () => {
    const { isUnsafeDisplayMetadata } = await import(
      "../src/config/profiles.js"
    );
    expect(isUnsafeDisplayMetadata("Catastro BI")).toBe(false);
    expect(isUnsafeDisplayMetadata("bi")).toBe(false);
  });
});

describe("loadAllProfiles", () => {
  it("returns empty list when no names are provided", async () => {
    const out = await loadAllProfiles([], process.env);
    expect(out).toEqual([]);
  });

  it("resolves a ${secret:file:...} password from disk", async () => {
    const { mkdtempSync, writeFileSync, rmSync, existsSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const dir = mkdtempSync(nodePath.default.join(tmpdir(), "pw-"));
    try {
      const pwFile = nodePath.default.join(dir, "pw.txt");
      writeFileSync(pwFile, "from-disk", "utf8");
      await withEnvAsync(
        {
          DB_PG_CLIENT: "postgres",
          DB_PG_HOST: "localhost",
          DB_PG_USER: "readonly",
          DB_PG_PASSWORD: `\${secret:file:${pwFile}}`,
          DB_PG_ALLOWED_DATABASES: "app",
        },
        async () => {
          const p = await loadProfile("PG", process.env);
          if (p.connection.kind === "postgres") {
            expect(p.connection.password).toBe("from-disk");
          } else {
            throw new Error("Expected postgres connection");
          }
        },
      );
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits non-leaking ProfileError when a ${secret:file:...} is missing", async () => {
    const nodePath = await import("node:path");
    const missing = nodePath.default.join("/nonexistent", "pw.txt");
    await withEnvAsync(
      {
        DB_PG_CLIENT: "postgres",
        DB_PG_HOST: "localhost",
        DB_PG_USER: "readonly",
        DB_PG_PASSWORD: `\${secret:file:${missing}}`,
        DB_PG_ALLOWED_DATABASES: "app",
      },
      async () => {
        let caught: unknown;
        try {
          await loadProfile("PG", process.env);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ProfileError);
        const msg = (caught as Error).message;
        expect(msg).not.toContain(missing);
        expect(msg).not.toContain("password=");
        expect(msg).not.toContain("localhost");
        expect(msg).not.toContain("readonly");
        expect(msg).not.toContain("${secret:file:");
      },
    );
  });

  it("names the alias (not the operator key) in ProfileError when a ${secret:file:...} fails to resolve", async () => {
    const nodePath = await import("node:path");
    const missing = nodePath.default.join("/nonexistent", "pw.txt");
    await withEnvAsync(
      {
        DB_SQLSERVER_BI_CLIENT: "postgres",
        DB_SQLSERVER_BI_HOST: "localhost",
        DB_SQLSERVER_BI_USER: "readonly",
        DB_SQLSERVER_BI_PASSWORD: `\${secret:file:${missing}}`,
        DB_SQLSERVER_BI_ALLOWED_DATABASES: "app",
        DB_SQLSERVER_BI_ALIAS: "bi_catastro",
      },
      async () => {
        let caught: unknown;
        try {
          await loadProfile("SQLSERVER_BI", process.env);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ProfileError);
        const err = caught as ProfileError;
        expect(err.alias).toBe("bi_catastro");
        expect(err.alias).not.toBe("SQLSERVER_BI");
        const msg = err.message;
        expect(msg).toContain("bi_catastro");
        expect(msg).not.toContain("SQLSERVER_BI");
        expect(msg).not.toContain(missing);
        expect(msg).not.toContain("localhost");
        expect(msg).not.toContain("readonly");
        expect(msg).not.toContain("${secret:file:");
      },
    );
  });

  it("rejects duplicate aliases across profiles (non-leaking)", async () => {
    await withEnvAsync(
      {
        DB_A_CLIENT: "postgres",
        DB_A_HOST: "localhost",
        DB_A_USER: "readonly",
        DB_A_PASSWORD: "secret",
        DB_A_ALLOWED_DATABASES: "app",
        DB_A_ALIAS: "shared",
        DB_B_CLIENT: "postgres",
        DB_B_HOST: "localhost",
        DB_B_USER: "readonly",
        DB_B_PASSWORD: "secret",
        DB_B_ALLOWED_DATABASES: "app",
        DB_B_ALIAS: "shared",
      },
      async () => {
        let caught: unknown;
        try {
          await loadAllProfiles(["A", "B"], process.env);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ProfileError);
        const msg = (caught as Error).message;
        expect(msg).toContain("shared");
        expect(msg).not.toContain("A");
        expect(msg).not.toContain("B");
        expect(msg).not.toContain("localhost");
        expect(msg).not.toContain("readonly");
        expect(msg).not.toContain("password");
      },
    );
  });

  it("rejects alias that collides with another profile's operator key (non-leaking)", async () => {
    await withEnvAsync(
      {
        DB_STAGING_SQL_CLIENT: "postgres",
        DB_STAGING_SQL_HOST: "localhost",
        DB_STAGING_SQL_USER: "readonly",
        DB_STAGING_SQL_PASSWORD: "secret",
        DB_STAGING_SQL_ALLOWED_DATABASES: "app",
        DB_STAGING_SQL_ALIAS: "bi_catastro",
        DB_BI_CATASTRO_CLIENT: "postgres",
        DB_BI_CATASTRO_HOST: "localhost",
        DB_BI_CATASTRO_USER: "readonly",
        DB_BI_CATASTRO_PASSWORD: "secret",
        DB_BI_CATASTRO_ALLOWED_DATABASES: "app",
      },
      async () => {
        let caught: unknown;
        try {
          await loadAllProfiles(["STAGING_SQL", "BI_CATASTRO"], process.env);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ProfileError);
        const msg = (caught as Error).message;
        expect(msg).toContain("bi_catastro");
        expect(msg).not.toContain("STAGING_SQL");
        expect(msg).not.toContain("localhost");
        expect(msg).not.toContain("readonly");
      },
    );
  });
});

async function withEnvAsync(
  env: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    previous[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
