import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, statSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Walk up the directory tree from a starting directory until a marker file
 * is found. Returns the directory that contains the marker, or null.
 */
function findWorkspaceRoot(start: string, marker = "pnpm-workspace.yaml"): string | null {
  let dir = start;
  // Bound the search to avoid infinite loops on filesystem roots.
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const workspaceRoot = findWorkspaceRoot(__dirname);

describe("monorepo workspace structure", () => {
  it("locates the workspace root from the test file location", () => {
    expect(workspaceRoot, "workspace root should be discoverable from this test file").not.toBeNull();
  });

  describe("monorepo-workspace spec", () => {
    it("has pnpm-workspace.yaml at the workspace root", () => {
      // Requirement: Workspace Root Scaffold — Scenario: Root scaffold present
      expect(existsSync(join(workspaceRoot!, "pnpm-workspace.yaml"))).toBe(true);
    });

    it("root package.json is private and has no bin field", () => {
      // Requirement: Workspace Root Scaffold — Scenario: Root has no deployable entrypoint
      const pkgPath = join(workspaceRoot!, "package.json");
      expect(existsSync(pkgPath)).toBe(true);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      expect(pkg.private).toBe(true);
      expect(pkg.bin, "root package.json MUST NOT declare a bin field").toBeUndefined();
    });

    it("root pyproject.toml declares [tool.uv.workspace]", () => {
      const path = join(workspaceRoot!, "pyproject.toml");
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf8");
      expect(content).toMatch(/\[tool\.uv\.workspace\]/);
    });

    it("tsconfig.base.json carries strict TypeScript flags", () => {
      // Requirement: Workspace Root Scaffold
      const path = join(workspaceRoot!, "tsconfig.base.json");
      expect(existsSync(path)).toBe(true);
      const ts = JSON.parse(readFileSync(path, "utf8")) as {
        compilerOptions: Record<string, unknown>;
      };
      expect(ts.compilerOptions.strict).toBe(true);
      expect(ts.compilerOptions.noUncheckedIndexedAccess).toBe(true);
      expect(ts.compilerOptions.noImplicitOverride).toBe(true);
      // The base must NOT pin rootDir/outDir (those belong to the app).
      expect(ts.compilerOptions.rootDir).toBeUndefined();
      expect(ts.compilerOptions.outDir).toBeUndefined();
    });

    it("does not produce a root dist/index.js (root is not deployable)", () => {
      // Requirement: Workspace Root Is Not Deployable — Scenario: No root combined artifact
      // AND Requirement: Workspace Root Scaffold — Scenario: Root has no deployable entrypoint
      // The root may have a dist/ from prior builds, but it must not contain the MCP entrypoint.
      const distIndex = join(workspaceRoot!, "dist", "index.js");
      expect(existsSync(distIndex), "root dist/index.js MUST NOT exist").toBe(false);
    });

    it(".gitignore covers recursive patterns and does not exclude .atl at root", () => {
      // Requirement: Workspace Root Scaffold (root .gitignore covering **/node_modules, **/dist, etc.)
      const path = join(workspaceRoot!, ".gitignore");
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf8");
      expect(content).toMatch(/\*\*\/node_modules/);
      expect(content).toMatch(/\*\*\/dist/);
      expect(content).toMatch(/\*\*\/\.venv/);
      expect(content).toMatch(/\*\*\/__pycache__/);
      // .env must remain ignored
      expect(content).toMatch(/^\.env$/m);
      // SQLite data files must remain ignored
      expect(content).toMatch(/\*\*\/data\/\*\.sqlite\*/);
      // The .atl skill registry directory MUST be tracked (not ignored).
      expect(content).not.toMatch(/^\.atl\b/m);
    });
  });

  describe("app-independence spec", () => {
    const appDir = () => join(workspaceRoot!, "apps", "mcp-readonly-sql");

    it("apps/mcp-readonly-sql owns package.json, tsconfig.json, src, test, .env.example", () => {
      // Requirement: App Self-Containment — Scenario: TypeScript app owns its files
      expect(existsSync(join(appDir(), "package.json"))).toBe(true);
      expect(existsSync(join(appDir(), "tsconfig.json"))).toBe(true);
      expect(existsSync(join(appDir(), "src"))).toBe(true);
      expect(existsSync(join(appDir(), "test"))).toBe(true);
      expect(existsSync(join(appDir(), ".env.example"))).toBe(true);
    });

    it("app package.json preserves the mcp-readonly-sql name (no @db/ scope)", () => {
      // Proposal: Package identity — Keep app package name `mcp-readonly-sql` (NO @db/ rename)
      const pkg = JSON.parse(readFileSync(join(appDir(), "package.json"), "utf8")) as {
        name: string;
      };
      expect(pkg.name).toBe("mcp-readonly-sql");
    });

    it("app tsconfig.json extends ../../tsconfig.base.json and pins rootDir/outDir", () => {
      // Design: app config extends base; app owns rootDir/outDir
      const ts = JSON.parse(readFileSync(join(appDir(), "tsconfig.json"), "utf8")) as {
        extends?: string;
        compilerOptions: Record<string, unknown>;
      };
      expect(ts.extends).toBe("../../tsconfig.base.json");
      expect(ts.compilerOptions.rootDir).toBe("src");
      expect(ts.compilerOptions.outDir).toBe("dist");
    });

    it("app has no cross-app relative imports in its source tree", () => {
      // Requirement: No Cross-App Code Paths + Source Layout Boundary
      const srcDir = join(appDir(), "src");
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name)) {
            const text = readFileSync(full, "utf8");
            // Look for relative imports crossing an app boundary.
            // Apps live at apps/<name>/ — a relative import like ../../other-app/src/...
            if (/\.\.\/.*\/src\//.test(text) || /\.\.\/other-app\b/.test(text)) {
              offenders.push(full);
            }
          }
        }
      };
      if (existsSync(srcDir)) walk(srcDir);
      expect(offenders, `cross-app imports found: ${offenders.join(", ")}`).toEqual([]);
    });
  });

  describe("mcp-tool-surface launch-path delta", () => {
    const appDir = () => join(workspaceRoot!, "apps", "mcp-readonly-sql");

    it("produces dist/index.js inside the app (not at the repo root)", () => {
      // Requirement: Workspace Root Is Not Deployable — Scenario: App owns its build artifact
      // AND mcp-tool-surface delta: Launch Path — Scenario: MCP host wires the new path
      // We only require the dist directory to be present after a build; existence of the
      // compiled entrypoint is verified after the build step in the apply phase.
      const distDir = join(appDir(), "dist");
      // If a build has been run, dist/index.js MUST exist inside the app.
      if (existsSync(distDir)) {
        expect(existsSync(join(distDir, "index.js"))).toBe(true);
      }
    });
  });
});
