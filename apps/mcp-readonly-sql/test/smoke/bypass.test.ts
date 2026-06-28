/**
 * Phase 4 cross-PR smoke test - Bypass grep.
 *
 * Spec coverage:
 * - 4.4 Bypass grep: the HTTP transport source MUST NOT contain any
 *   auth-bypass flag, opt-out, or shortcut. Specifically, the
 *   following identifiers MUST NOT appear in the HTTP path source:
 *     - `trusted` (would-be allowlist of "trusted" callers)
 *     - `internal` (would-be allowlist of "internal" callers)
 *     - `isLocal` (would-be skip-auth when the request comes from
 *       localhost)
 *     - `skipAuth` / `bypassAuth` / `noAuth` (explicit opt-outs)
 *
 * Scope:
 * - `apps/mcp-readonly-sql/src/transports/http.ts`
 * - `apps/mcp-readonly-sql/src/config/http.ts`
 * - `packages/mcp-http-base/src/server.ts`
 * - `packages/mcp-http-base/src/auth.ts`
 *
 * Strict TDD: every test is a real assertion that a forbidden
 * identifier is absent from the named source file. Adding any of
 * these identifiers to the HTTP path fails the suite.
 *
 * The scan is whole-word (case-sensitive) so that e.g. `trustees` or
 * `untrusted` is not flagged.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Walk up from this test file until we hit `pnpm-workspace.yaml` so
 * the scan starts at the workspace root regardless of how vitest
 * resolves the path.
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
  throw new Error("bypass.test.ts: workspace root not discoverable from " + __dirname);
}

/**
 * The four files under test. Each path is resolved relative to the
 * workspace root using the platform-native separator. The assertion
 * file MUST exist - a missing file is a test bug, not a green light.
 */
const HTTP_PATH_FILES = [
  "apps/mcp-readonly-sql/src/transports/http.ts",
  "apps/mcp-readonly-sql/src/config/http.ts",
  "packages/mcp-http-base/src/server.ts",
  "packages/mcp-http-base/src/auth.ts",
].map((rel) => join(workspaceRoot!, rel));

/**
 * Forbidden identifiers. The regex uses word boundaries so a token
 * like `skipAuthed` is NOT flagged. The list intentionally does NOT
 * include `disabled` or `enabled` because those are common in config
 * and would over-fire.
 */
const FORBIDDEN_IDENTIFIERS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "trusted", regex: /\btrusted\b/g },
  { name: "internal", regex: /\binternal\b/g },
  { name: "isLocal", regex: /\bisLocal\b/g },
  { name: "skipAuth", regex: /\bskipAuth\b/g },
  { name: "bypassAuth", regex: /\bbypassAuth\b/g },
  { name: "noAuth", regex: /\bnoAuth\b/g },
];

function scanForBypassFlags(filePath: string): { name: string; line: number; excerpt: string }[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(
      `bypass.test.ts: cannot read ${filePath}; expected the HTTP path source to exist: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  const lines = content.split(/\r?\n/);
  const hits: { name: string; line: number; excerpt: string }[] = [];
  for (const { name, regex } of FORBIDDEN_IDENTIFIERS) {
    const re = new RegExp(regex.source, regex.flags);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (re.test(line)) {
        hits.push({ name, line: i + 1, excerpt: line.trim().slice(0, 120) });
      }
      // Reset lastIndex for the next iteration.
      re.lastIndex = 0;
    }
  }
  return hits;
}

describe("smoke/bypass - Phase 4 cross-PR verification", () => {
  it.each(HTTP_PATH_FILES)("%s exists (sanity check)", (file) => {
    expect(existsSync(file), `expected HTTP path source to exist: ${file}`).toBe(true);
  });

  it.each(HTTP_PATH_FILES)(
    "%s contains no `trusted` / `internal` / `isLocal` / `skipAuth` / `bypassAuth` / `noAuth` bypass flags",
    (file) => {
      const hits = scanForBypassFlags(file);
      expect(
        hits,
        `bypass flags in ${file.replace(workspaceRoot!, "").replace(/^[\\/]/, "")}:\n` +
          hits
            .map((h) => `  - ${h.name} at line ${h.line}: ${h.excerpt}`)
            .join("\n"),
      ).toEqual([]);
    },
  );
});
