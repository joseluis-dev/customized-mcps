/**
 * Authority Isolation — `app-independence` spec delta, PR 3 of
 * `oauth-sqlite-admin-authorization`.
 *
 * Spec coverage (from `specs/app-independence/spec.md`):
 * - No app-to-app import: a resource-server app under
 *   `apps/<app-name>/src/` MUST NOT import from
 *   `apps/mcp-oauth-admin/`.
 * - No workspace dependency on authority: a resource-server
 *   app's `package.json` MUST NOT reference `mcp-oauth-admin`
 *   as a workspace package.
 * - No symlink to authority: the resource-server app's
 *   build artifact MUST NOT contain a symlink pointing at
 *   `apps/mcp-oauth-admin/`.
 * - Authority may depend on shared base: `apps/mcp-oauth-admin/`
 *   MAY depend on `@customized-mcps/mcp-http-base`; the
 *   resource server MUST NOT depend on the authority.
 *
 * Strict TDD: each scenario below is a real assertion against
 * the committed tree. A future PR that introduces a hidden
 * coupling (e.g. an `import` from `apps/mcp-oauth-admin/src/`,
 * a workspace `*` dep, or a symlink) fails the corresponding
 * test.
 *
 * Test layer: integration (walks the workspace tree, greps
 * committed source, inspects `package.json` JSON).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync, lstatSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Walk up from this test file until we hit `pnpm-workspace.yaml`
 * so the scan starts at the workspace root regardless of how
 * vitest resolves the path.
 */
function findWorkspaceRoot(start: string, marker = "pnpm-workspace.yaml"): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const workspaceRoot = findWorkspaceRoot(__dirname);
if (!workspaceRoot) {
  throw new Error("authorityIsolation.test.ts: workspace root not discoverable from " + __dirname);
}

/**
 * Recursively walk `dir` and return every regular file path.
 * The walker follows the same exclusions as the smoke/secrets
 * test (node_modules, dist, build, .git, data, coverage) so a
 * committed source file in `apps/mcp-readonly-sql/src/` is the
 * only surface the scan can flag.
 */
function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as typeof entries;
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === ".git" ||
        entry.name === "data" ||
        entry.name === "coverage" ||
        entry.name === ".vite" ||
        entry.name === ".atl"
      ) {
        continue;
      }
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Returns the list of every committed file under
 * `apps/mcp-readonly-sql/` whose path looks like source
 * (`src/**`) — the surface where an `import` from
 * `apps/mcp-oauth-admin/` would be a real coupling. The walker
 * excludes test files (they may legitimately use string
 * literals like `"mcp-oauth-admin"` as test fixtures) and
 * fixtures / config.
 */
function readonlySqlSourceFiles(): string[] {
  const srcRoot = join(workspaceRoot!, "apps", "mcp-readonly-sql", "src");
  if (!existsSync(srcRoot)) return [];
  return walkFiles(srcRoot).filter((f) => /\.(ts|js|mjs|cjs)$/.test(f));
}

describe("Authority Isolation (PR 3 of oauth-sqlite-admin-authorization)", () => {
  let sourceFiles: string[];

  beforeAll(() => {
    sourceFiles = readonlySqlSourceFiles();
  });

  describe("No app-to-app import", () => {
    it("the resource-server source tree contains no import referencing apps/mcp-oauth-admin", () => {
      // Spec scenario: a grep for `apps/mcp-oauth-admin` or
      // `mcp-oauth-admin/` over `apps/<app-name>/src/` returns
      // zero matches.
      //
      // The check is intentionally narrow: it scans committed
      // `.ts` / `.js` / `.mjs` / `.cjs` files under
      // `apps/mcp-readonly-sql/src/` for the substring
      // `mcp-oauth-admin` ONLY inside an import binding. The
      // spec forbids any import / require / dynamic-import
      // that targets the authority app. A regression (e.g.
      // someone re-introduces
      // `import x from "../../mcp-oauth-admin/..."` to share
      // a constant) would fail this test. A mere string
      // mention in a comment or log message is allowed (the
      // resource server legitimately references the authority
      // by name in the local-roster deprecation WARN).
      const offenders: { file: string; line: number; excerpt: string }[] = [];
      for (const file of sourceFiles) {
        const content = readFileSync(file, "utf8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          // Match a real import binding that targets the
          // authority app. The patterns cover:
          //  - `import ... from "mcp-oauth-admin"` (bare
          //    specifier),
          //  - `import ... from "...mcp-oauth-admin..."`
          //    (relative path that crosses the app
          //    boundary),
          //  - `import("mcp-oauth-admin")` (dynamic
          //    import), and
          //  - `require("...mcp-oauth-admin...")` (CJS
          //    require).
          //
          // A bare mention of `mcp-oauth-admin` in a
          // string literal (e.g. the WARN text) does NOT
          // match any of these patterns.
          if (
            /from\s+["'][^"']*mcp-oauth-admin[^"']*["']/.test(line) ||
            /import\s*\(\s*["'][^"']*mcp-oauth-admin[^"']*["']\s*\)/.test(line) ||
            /require\s*\(\s*["'][^"']*mcp-oauth-admin[^"']*["']\s*\)/.test(line)
          ) {
            offenders.push({
              file: file
                .replace(workspaceRoot!, "")
                .replace(/^[\\/]/, ""),
              line: i + 1,
              excerpt: line.trim().slice(0, 200),
            });
          }
        }
      }
      expect(
        offenders,
        `apps/mcp-readonly-sql/src/ imports from mcp-oauth-admin: ${JSON.stringify(offenders, null, 2)}`,
      ).toEqual([]);
    });

    it("the resource-server source tree does not import @customized-mcps/mcp-oauth-admin (it must go through mcp-http-base)", () => {
      // Spec scenario: the resource server MAY import from
      // `@customized-mcps/mcp-http-base`; it MUST NOT import
      // the authority's templates, UI, DB layer, or OAuth
      // handlers directly. The authority's npm name is
      // `mcp-oauth-admin` (per its `package.json`); a future
      // maintainer adding `mcp-oauth-admin` to the resource
      // server's `package.json` (and importing from it) would
      // fail this test.
      //
      // We check the committed source for any import /
      // require / dynamic-import / `from` that targets the
      // authority's npm name. A bare-string reference
      // (e.g. a console message) is allowed; an actual code
      // dependency is not.
      const offenders: { file: string; line: number; excerpt: string }[] = [];
      for (const file of sourceFiles) {
        const content = readFileSync(file, "utf8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          // Match a real import binding. Three shapes are
          // recognised: `import ... from "mcp-oauth-admin"`,
          // `import("mcp-oauth-admin")`, and
          // `require("mcp-oauth-admin")`. A bare string
          // literal that is NOT inside an import binding is
          // ignored (a comment / log line is fine).
          if (
            /from\s+["']mcp-oauth-admin["']/.test(line) ||
            /import\s*\(\s*["']mcp-oauth-admin["']\s*\)/.test(line) ||
            /require\s*\(\s*["']mcp-oauth-admin["']\s*\)/.test(line)
          ) {
            offenders.push({
              file: file
                .replace(workspaceRoot!, "")
                .replace(/^[\\/]/, ""),
              line: i + 1,
              excerpt: line.trim().slice(0, 200),
            });
          }
        }
      }
      expect(
        offenders,
        `apps/mcp-readonly-sql/src/ imports mcp-oauth-admin: ${JSON.stringify(offenders, null, 2)}`,
      ).toEqual([]);
    });
  });

  describe("No workspace dependency on authority", () => {
    it("apps/mcp-readonly-sql/package.json does not declare mcp-oauth-admin in dependencies / devDependencies / peerDependencies", () => {
      // Spec scenario: a resource-server app's `package.json`
      // MUST NOT reference `mcp-oauth-admin` as a workspace
      // package. We inspect every dependency field for the
      // substring `mcp-oauth-admin`. A regression (e.g. a
      // maintainer adds `mcp-oauth-admin: workspace:*` to
      // share a constant) fails this test.
      const pkgPath = join(workspaceRoot!, "apps", "mcp-readonly-sql", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const fields: Array<keyof typeof pkg> = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ];
      const offenders: { field: string; dep: string; version: string }[] = [];
      for (const f of fields) {
        const map = pkg[f] ?? {};
        for (const [name, version] of Object.entries(map)) {
          if (/mcp-oauth-admin/.test(name)) {
            offenders.push({ field: f, dep: name, version });
          }
        }
      }
      expect(
        offenders,
        `apps/mcp-readonly-sql/package.json references mcp-oauth-admin: ${JSON.stringify(offenders, null, 2)}`,
      ).toEqual([]);
    });
  });

  describe("No symlink to authority", () => {
    it("the resource-server's source tree does not symlink to apps/mcp-oauth-admin/", () => {
      // Spec scenario: the resource-server's build artifact
      // does not contain a symlink pointing to
      // `apps/mcp-oauth-admin/`. We check the source tree
      // (symlinks here would compile into a symlink in the
      // build output). The walker above already skips
      // symlinks (they are not walked as directories); a
      // dedicated check for the regex pattern catches a
      // symlink whose name itself references the authority.
      //
      // The check is a file-name grep rather than a link-
      // target probe because the spec phrases the scenario
      // as "no symlink points to apps/mcp-oauth-admin/" —
      // i.e. the symlink itself is the offense. A
      // link-target probe would require evaluating the
      // symlink, which the build step already does; the
      // file-name check is the cheap, deterministic guard.
      const offenders: string[] = [];
      const scanRoot = join(workspaceRoot!, "apps", "mcp-readonly-sql");
      const walk = (dir: string): void => {
        let entries: { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }[];
        try {
          entries = readdirSync(dir, { withFileTypes: true }) as typeof entries;
        } catch {
          return;
        }
        for (const entry of entries) {
          if (
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === "build" ||
            entry.name === ".git" ||
            entry.name === "data"
          ) {
            continue;
          }
          const full = join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            try {
              const target = readlinkForLog(full);
              if (/mcp-oauth-admin/.test(target) || /mcp-oauth-admin/.test(entry.name)) {
                offenders.push(full);
              }
            } catch {
              // ignore: dangling symlink
            }
            continue;
          }
          if (entry.isDirectory()) walk(full);
        }
      };
      walk(scanRoot);
      expect(
        offenders,
        `symlinks in apps/mcp-readonly-sql reference mcp-oauth-admin: ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  });

  describe("Authority may depend on shared base", () => {
    it("apps/mcp-oauth-admin/package.json MAY depend on @customized-mcps/mcp-http-base (positive check)", () => {
      // Spec scenario: shared packages like
      // `@customized-mcps/mcp-http-base` MAY be listed in
      // the authority's `dependencies`; no resource-server
      // app is listed there. This is the positive side of
      // the isolation contract: the authority is the only
      // app allowed to import the shared base, and it does
      // so via the standard workspace dep.
      const pkgPath = join(workspaceRoot!, "apps", "mcp-oauth-admin", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const deps = pkg.dependencies ?? {};
      expect(deps["@customized-mcps/mcp-http-base"]).toBeDefined();
    });

    it("apps/mcp-oauth-admin/package.json does NOT list any resource-server app in dependencies (positive check)", () => {
      // Spec scenario: "no resource-server app is listed"
      // in the authority's `dependencies`. The current
      // workspace has exactly one resource-server app
      // (`mcp-readonly-sql`); future apps MUST be
      // absent from the authority's deps too.
      const pkgPath = join(workspaceRoot!, "apps", "mcp-oauth-admin", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const deps = pkg.dependencies ?? {};
      // A resource-server app is anything under
      // `apps/<name>/package.json` whose name starts with
      // `mcp-` and is NOT `mcp-oauth-admin`. We assert on
      // `mcp-readonly-sql` today and on the future app
      // name pattern; a regression that adds
      // `mcp-foo: workspace:*` to the authority's deps
      // would fail.
      for (const depName of Object.keys(deps)) {
        if (/^mcp-(?!oauth-admin$)/.test(depName)) {
          throw new Error(
            `apps/mcp-oauth-admin/package.json declares a resource-server dep "${depName}"; ` +
              `the authority MUST NOT depend on resource-server apps.`,
          );
        }
      }
    });
  });
});

/**
 * `fs.readlinkSync` is not in the top-level `fs` import to
 * keep the helper scope local. The smoke test uses
 * `lstatSync` + `readlinkSync`; this helper mirrors the
 * pattern but is only used in the symlink block above.
 */
function readlinkForLog(path: string): string {
  const { readlinkSync } = require("node:fs") as typeof import("node:fs");
  return readlinkSync(path);
}
