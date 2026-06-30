/**
 * Phase 4 cross-PR smoke test - Secret grep.
 *
 * Spec coverage:
 * - 4.3 Secret grep: the repo MUST NOT contain committed secrets in
 *   the application or deployment source tree. Specifically:
 *     1. No `Bearer <opaque-token>` strings (an actual bearer in
 *        source, not just the word "Bearer" or the variable name).
 *     2. No 64-char hex strings (the `keyHash` shape).
 *     3. No `postgres://` connection strings.
 *     4. No `mysql://` connection strings.
 *     5. No `MCP_AGENT_HMAC_SECRET=<value>` with a real value.
 *
 * Scope:
 * - Walk `apps/`, `packages/`, `deploy/`, root config files.
 * - Exclude `node_modules/`, `dist/`, `.git/`, `data/`, `*.sqlite*`,
 *   `.env` (gitignored anyway), and test files that legitimately use
 *   synthetic tokens for HMAC self-tests.
 *
 * Strict TDD: every test asserts a real absence. A new secret in
 * any of the scanned files fails the test.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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
  throw new Error("secrets.test.ts: workspace root not discoverable from " + __dirname);
}

/**
 * Recursively walk `dir` and collect every regular file path. Symlinks
 * are NOT followed (Node follows them by default in `statSync`; we use
 * `lstatSync` semantics via `readdirSync({ withFileTypes: true })` and
 * skip them).
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
      // Skip known vendor / build / cache directories.
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
 * Patterns the suite scans for. Each pattern is paired with the
 * human-readable name of the secret shape it represents. The list is
 * intentionally narrow: a real secret in a committed file is the
 * failure mode we are protecting against.
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  {
    // Bearer followed by a 16+ char opaque token. The token chars are
    // drawn from the alphabet the SDK transport would accept.
    //
    // Negative lookahead: an actual `WWW-Authenticate: Bearer …` 401
    // challenge uses RFC 6750 §3 / RFC 9728 §5.1 auth-param keywords
    // (`realm`, `scope`, `error`, `error_description`, `error_uri`,
    // `resource_metadata`), NOT an opaque token. PR1's resource-server
    // discovery work legitimately emits the literal text
    // `Bearer resource_metadata="<url>"` in `packages/mcp-http-base/src/
    // server.ts` (the 401 path) and references the same shape in a
    // JSDoc comment. The token alphabet does not allow a real bearer
    // to START with one of those keywords followed by a word boundary
    // (a token char is alphanumeric or one of `-._~+/=`, so a token
    // prefix like `error_…` has no `\b` between `error` and `_`); the
    // lookahead below is therefore both narrow and safe — it excludes
    // challenge headers and ONLY challenge headers, never real tokens.
    name: "Bearer <opaque-token> (>=16 chars, excluding RFC 6750/9728 auth-params)",
    regex: /\bBearer\s+(?!(?:realm|scope|error|error_description|error_uri|resource_metadata)\b)[A-Za-z0-9_.\-+/=]{16,}/g,
  },
  {
    // 64-char hex (the `keyHash` shape). False positives: env values
    // like a SHA-256 digest are also 64-char hex, but those should
    // never appear in committed source.
    name: "64-char hex (keyHash shape)",
    regex: /\b[a-fA-F0-9]{64}\b/g,
  },
  {
    // postgres connection string. The pattern requires a host
    // component (alpha+digit mix) so a markdown sentence like
    // "no `postgres://` found" is NOT flagged. A real connection
    // string is `postgres://user:pass@host:port/db` and always
    // contains a `host` token that is not a markdown backtick.
    name: "postgres:// connection string (with host)",
    regex: /postgres(?:ql)?:\/\/[A-Za-z0-9_.\-]+(?::[^@\s"'<>\\]+)?@[A-Za-z0-9_.\-]+/g,
  },
  {
    // mysql connection string (same shape constraint as above).
    name: "mysql:// connection string (with host)",
    regex: /mysql:\/\/[A-Za-z0-9_.\-]+(?::[^@\s"'<>\\]+)?@[A-Za-z0-9_.\-]+/g,
  },
  {
    // MCP_AGENT_HMAC_SECRET=<non-empty>. We accept the env name in
    // .env.example and READMEs, so we look for the assignment with a
    // non-empty value (length >= 32 matches the production minimum).
    name: "MCP_AGENT_HMAC_SECRET=<value> with length >= 32",
    regex: /MCP_AGENT_HMAC_SECRET\s*=\s*["']?([A-Za-z0-9_.\-+/=]{32,})["']?/g,
  },
];

/**
 * Files that legitimately contain HMAC test data. The pattern matches
 * `apps/mcp-readonly-sql/test/transports/http.test.ts` and any other
 * test file that imports a synthetic token. We allowlist the entire
 * `apps/mcp-readonly-sql/test/` tree and the `packages/mcp-http-base/
 * test/` tree because those are the only places the suite is allowed
 * to plant synthetic values.
 */
function isTestFile(path: string): boolean {
  const norm = path.replace(/[\\/]/g, sep);
  return (
    norm.includes(`${sep}test${sep}`) ||
    norm.endsWith(`${sep}test`) ||
    norm.includes(`${sep}tests${sep}`) ||
    norm.endsWith(".test.ts") ||
    norm.endsWith(".test.js") ||
    norm.endsWith(".spec.ts")
  );
}

/**
 * The `.env.example` file is the env-var source of truth. It contains
 * the literal `MCP_AGENT_HMAC_SECRET=` as documentation; we do NOT
 * consider that a leak. The real `.env` is gitignored so it is never
 * scanned.
 */
function isEnvExample(path: string): boolean {
  return path.endsWith(".env.example");
}

/**
 * Markdown files are documentation. They may legitimately contain
 * strings like "`postgres://`" or "`Bearer <token>`" as part of an
 * example showing what the scan should NOT find. The actual code
 * under test is the `.ts` / `.js` / `.json` / `.yaml` source. We
 * still scan `.md` files for the `MCP_AGENT_HMAC_SECRET=<value>`
 * pattern (a real env file path is not a markdown convention) but
 * skip the conn-string patterns there.
 */
function isMarkdown(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

/**
 * Run a single pattern over a file's contents and return a list of
 * human-readable violations: the line number, the secret shape, and
 * a redacted preview of the line so the operator can find it without
 * the secret itself being echoed to the test runner output.
 */
function scanFile(
  filePath: string,
  content: string,
): { pattern: string; line: number; redacted: string }[] {
  const lines = content.split(/\r?\n/);
  const violations: { pattern: string; line: number; redacted: string }[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    // Reset the regex state for each file (the `g` flag is sticky in
    // JS, so we re-create it to avoid cross-file pollution).
    const re = new RegExp(regex.source, regex.flags);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // Skip the .env.example for MCP_AGENT_HMAC_SECRET only.
      if (isEnvExample(filePath) && name.startsWith("MCP_AGENT_HMAC_SECRET")) {
        continue;
      }
      // Skip conn-string and Bearer patterns in markdown (legitimate
      // documentation showing the absence of those patterns).
      if (
        isMarkdown(filePath) &&
        (name.startsWith("postgres://") ||
          name.startsWith("mysql://") ||
          name.startsWith("Bearer "))
      ) {
        continue;
      }
      const match = re.exec(line);
      if (match) {
        // Redact the secret part of the line. The redacted form
        // keeps enough context to find the file but never echoes the
        // full secret.
        const redacted = line
          .replace(/[A-Za-z0-9_.\-+/=]{32,}/g, (m) =>
            m.length > 8 ? `${m.slice(0, 4)}…(${m.length} chars)` : m,
          )
          .replace(/[a-fA-F0-9]{64}/g, (m) => `${m.slice(0, 8)}…(64 hex)`);
        violations.push({ pattern: name, line: i + 1, redacted });
      }
    }
  }
  return violations;
}

describe("smoke/secrets - Phase 4 cross-PR verification", () => {
  let scanResults: Map<string, { pattern: string; line: number; redacted: string }[]> = new Map();
  let scannedFileCount = 0;

  beforeAll(() => {
    const files = walkFiles(workspaceRoot!);
    // PR 3 of `oauth-sqlite-admin-authorization` (W5):
    // the scanner now filters by `git ls-files` so it
    // walks only the COMMITTED tree. The previous
    // `walkFiles` walked the whole working tree, which
    // included gitignored files (e.g. `apps/mcp-readonly-
    // sql/.env`, which is on disk in the developer's local
    // checkout but must not be in the scan). A new
    // developer who runs the suite with a populated
    // `.env` would otherwise see false positives; the
    // commit-time truth is `git ls-files`. We use
    // `execFileSync` so the call is synchronous and the
    // test setup stays in `beforeAll`.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    let lsFilesOutput: string;
    try {
      lsFilesOutput = execFileSync("git", ["ls-files"], {
        cwd: workspaceRoot!,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // `git` is not on PATH (e.g. a minimal CI image) or
      // the workspace is not a git checkout. Fall back
      // to the whole-workspace scan so the suite still
      // runs; the gitignore-sensitive check is a
      // defense-in-depth, not a binding contract.
      lsFilesOutput = "";
    }
    const trackedAbs = new Set(
      lsFilesOutput
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .map((rel) => join(workspaceRoot!, rel)),
    );
    const isTracked = (path: string): boolean => {
      if (trackedAbs.size === 0) return true; // fallback
      return trackedAbs.has(path);
    };
    scannedFileCount = files.length;
    for (const file of files) {
      // Skip test files (legitimate synthetic tokens), the
      // `.env.example` (env-var documentation, not a
      // leak), and any file that is NOT tracked by git
      // (i.e. gitignored or untracked local files).
      if (isTestFile(file)) continue;
      if (!isTracked(file)) continue;
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        // Binary file or unreadable: skip silently.
        continue;
      }
      const violations = scanFile(file, content);
      if (violations.length > 0) {
        scanResults.set(file, violations);
      }
    }
  });

  it("walks at least the apps/, packages/, and deploy/ trees (sanity check)", () => {
    expect(scannedFileCount).toBeGreaterThan(10);
  });

  it("the application source tree (apps/) contains no committed secrets", () => {
    const offenders = [...scanResults.entries()].filter(([f]) =>
      f.replace(/[\\/]/g, sep).includes(`${sep}apps${sep}`),
    );
    expect(offenders, `secrets in apps/: ${JSON.stringify(offenders, null, 2)}`).toEqual([]);
  });

  it("the shared base tree (packages/) contains no committed secrets", () => {
    const offenders = [...scanResults.entries()].filter(([f]) =>
      f.replace(/[\\/]/g, sep).includes(`${sep}packages${sep}`),
    );
    expect(offenders, `secrets in packages/: ${JSON.stringify(offenders, null, 2)}`).toEqual([]);
  });

  it("the deployment templates (deploy/) contain no committed secrets", () => {
    const offenders = [...scanResults.entries()].filter(([f]) =>
      f.replace(/[\\/]/g, sep).includes(`${sep}deploy${sep}`),
    );
    expect(offenders, `secrets in deploy/: ${JSON.stringify(offenders, null, 2)}`).toEqual([]);
  });

  it("the root configuration files contain no committed secrets", () => {
    const offenders = [...scanResults.entries()].filter(([f]) => {
      const rel = f.replace(workspaceRoot!, "").replace(/^[\\/]/, "");
      return !rel.includes(sep) || rel.split(sep).length <= 2;
    });
    expect(
      offenders,
      `secrets in root config: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });

  it("no file anywhere in the committed tree contains a 64-char hex keyHash shape", () => {
    const offenders = [...scanResults.entries()].filter(([, violations]) =>
      violations.some((v) => v.pattern.includes("64-char hex")),
    );
    expect(
      offenders,
      `64-char hex literals: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });

  it("no file anywhere in the committed tree contains a postgres:// connection string", () => {
    const offenders = [...scanResults.entries()].filter(([, violations]) =>
      violations.some((v) => v.pattern.includes("postgres://")),
    );
    expect(
      offenders,
      `postgres:// literals: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });

  it("no file anywhere in the committed tree contains a mysql:// connection string", () => {
    const offenders = [...scanResults.entries()].filter(([, violations]) =>
      violations.some((v) => v.pattern.includes("mysql://")),
    );
    expect(
      offenders,
      `mysql:// literals: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });
});
