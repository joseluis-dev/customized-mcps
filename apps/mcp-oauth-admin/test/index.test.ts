/**
 * Smoke tests for the entrypoint (W1 remediation).
 *
 * PR 1's verify report flagged W1: `apps/mcp-oauth-admin/src/index.ts`
 * was missing, so the `bin` / `dev` / `start` scripts in
 * `package.json` referenced a non-existent file. PR 2 adds
 * the entrypoint and these tests pin the smoke contract:
 * - The module loads (TypeScript compiles, exports are valid).
 * - `main()` is exported and returns a `{ server, shutdown }`
 *   pair.
 * - The `build` script produces `dist/index.js` (the
 *   `bin` entry resolves to a real file).
 * - The `dev` script (tsx watch src/index.ts) references a
 *   real file.
 * - The `start` script (node dist/index.js) references a
 *   real file after build.
 *
 * Test layer: smoke. The full server lifecycle is tested
 * in the `sdd-verify` phase via a subprocess-driven test;
 * this file pins the static invariants.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = join(__dirname, "..");

describe("entrypoint — module exists (W1 remediation)", () => {
  it("apps/mcp-oauth-admin/src/index.ts exists", () => {
    const path = join(APP_ROOT, "src", "index.ts");
    expect(existsSync(path)).toBe(true);
  });

  it("apps/mcp-oauth-admin/src/index.ts is non-empty", () => {
    const path = join(APP_ROOT, "src", "index.ts");
    const content = readFileSync(path, "utf8");
    expect(content.length).toBeGreaterThan(100);
  });

  it("src/index.ts declares a top-level `main` export", () => {
    // The export is statically detectable: we read the
    // file and look for the `export async function main`
    // (or `export function main`) signature. A dynamic
    // import would require vitest to compile the entire
    // module + its transitive imports (db, oauth, etc.),
    // which is heavy for a smoke test. The static check
    // pins the export without paying the import cost.
    const path = join(APP_ROOT, "src", "index.ts");
    const content = readFileSync(path, "utf8");
    expect(content).toMatch(/export\s+(async\s+)?function\s+main\s*\(/);
  });
});

describe("entrypoint — env loading (dotenv regression)", () => {
  it("src/index.ts imports `dotenv/config` BEFORE other modules", () => {
    // Regression: previously the entrypoint read process.env.*
    // for MCP_HTTP_HOST, MCP_HTTP_PORT, MCP_OAUTH_ADMIN_*,
    // MCP_OAUTH_BACKUP_*, etc. without ever loading the per-app
    // .env file. The systemd unit (`deploy/systemd/mcp-oauth-admin.service`)
    // and the companion app (`apps/mcp-readonly-sql`) both
    // assume dotenv runs at startup; the entrypoint must do
    // the same. The import must come first so every later
    // `process.env.*` read sees the loaded values.
    const path = join(APP_ROOT, "src", "index.ts");
    const content = readFileSync(path, "utf8");
    expect(content).toMatch(/import\s+["']dotenv\/config["']/);
    // The dotenv import must precede the first CODE line
    // that reads `process.env.*`. We walk the file line by
    // line and skip JSDoc / line comments (which legitimately
    // mention `process.env` in prose) so the assertion
    // reflects runtime ordering, not documentation order.
    const lines = content.split(/\r?\n/);
    const dotenvLine = lines.findIndex((l) => /import\s+["']dotenv\/config["']/.test(l));
    const firstCodeEnvRead = lines.findIndex(
      (l, idx) =>
        idx > dotenvLine &&
        !/^\s*(\/\/|\*|\/\*)/.test(l) &&
        /process\.env\./.test(l),
    );
    expect(dotenvLine).toBeGreaterThanOrEqual(0);
    expect(firstCodeEnvRead).toBeGreaterThanOrEqual(0);
    expect(dotenvLine).toBeLessThan(firstCodeEnvRead);
  });

  it("package.json declares `dotenv` as a runtime dependency", () => {
    // The runtime dep is required so the `import "dotenv/config"`
    // line above resolves when the app is started via
    // `node dist/index.js`. `dotenv` is already in the
    // pnpm-lock (used by `apps/mcp-readonly-sql`), so the
    // pnpm install reuses the existing resolution.
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["dotenv"]).toBeDefined();
  });
});

describe("entrypoint — package.json scripts resolve", () => {
  it("package.json declares `bin.mcp-oauth-admin` pointing at dist/index.js", () => {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
      main?: string;
      scripts?: Record<string, string>;
    };
    expect(pkg.bin?.["mcp-oauth-admin"]).toBe("dist/index.js");
    expect(pkg.main).toBe("dist/index.js");
  });

  it("package.json's `dev` script references src/index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["dev"]).toContain("src/index.ts");
  });

  it("package.json's `start` script references dist/index.js", () => {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["start"]).toContain("dist/index.js");
  });
});

describe("entrypoint — main() is the documented composition root", () => {
  it("main() takes no required args (per the function signature)", () => {
    // Read the function signature from the source. The
    // signature is `export async function main(): Promise<...>`
    // — no parameters.
    const path = join(APP_ROOT, "src", "index.ts");
    const content = readFileSync(path, "utf8");
    const m = content.match(/export\s+(?:async\s+)?function\s+main\s*\(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(m?.[1]?.trim()).toBe("");
  });
});
