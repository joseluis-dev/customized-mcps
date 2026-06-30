/**
 * Integration tests for the operator CLI
 * (`scripts/create-client.ts`).
 *
 * The mcp-oauth-admin spec requires:
 * - The CLI writes a one-time `client_secret` to stdout
 *   and persists the `argon2id` hash to the `clients`
 *   table.
 * - The CLI does NOT log the secret to any other stream
 *   (stderr, debug, etc.).
 * - The CLI accepts `--client-id`, `--label`, and
 *   `--db-path` flags.
 *
 * PR 4 of `remove-scope-authorization`: the `--scope`
 * flag is removed (scope authorization is inert). The
 * output JSON no longer carries a `scopes` field; the
 * persisted `scopes` column is `[]` (legacy/inert).
 *
 * Test layer: subprocess. We spawn the script with
 * `node --import tsx` so the TypeScript entrypoint runs
 * directly (no build step). The test exercises the
 * end-to-end CLI contract against a fresh temp DB.
 *
 * Audit-safety contract: the test NEVER logs the
 * plaintext secret to the test reporter. The shape is
 * asserted (`typeof`, length, presence of the
 * argon2id hash in the DB) and the plaintext is used
 * in-process only to verify the persisted hash. The
 * captured stdout + stderr are checked to confirm the
 * secret is on stdout ONLY and not on stderr.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, initializeSchema } from "../../src/db/index.js";
import { verifyPassword } from "../../src/oauth/passwords.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = join(__dirname, "..", "..");
const SCRIPT_PATH = join(APP_ROOT, "scripts", "create-client.ts");

interface CliOutput {
  client_id: string;
  client_secret: string;
  label: string;
}

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mcp-oauth-admin-cli-"));
  dbPath = join(tempDir, "cli.sqlite");
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCli(args: string[]): SpawnSyncReturns<Buffer> {
  // Invoke the TypeScript entrypoint via Node's
  // `--import tsx` hook. The hook is a registered loader
  // (the `tsx` package is a workspace devDependency);
  // no `npm run build` step is required to run the
  // CLI. The spawned process inherits the test
  // process's CWD so any default paths resolve the
  // same way the production path would.
  return spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT_PATH, ...args],
    {
      cwd: APP_ROOT,
      encoding: "buffer",
      // No shell. The args are passed verbatim so the
      // child receives the exact token stream the test
      // built (no Windows `.cmd` resolution issues).
      shell: false,
    },
  );
}

describe("scripts/create-client.ts — operator CLI", () => {
  it("writes a single JSON line to stdout with { client_id, client_secret, label }", () => {
    // GIVEN the CLI is invoked with --client-id
    // WHEN the script exits 0
    // THEN stdout is exactly one JSON line with the
    //      expected shape. The plaintext is captured
    //      but NEVER asserted against by string value
    //      (the test must not log / store the secret in
    //      CI output).
    const res = runCli([
      "--client-id",
      "cli-test-1",
      "--label",
      "CLI test",
      "--db-path",
      dbPath,
    ]);
    expect(res.status).toBe(0);
    const stdout = res.stdout?.toString("utf8") ?? "";
    // Exactly one JSON line (no extra noise).
    const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]!) as CliOutput;
    expect(typeof out.client_id).toBe("string");
    expect(out.client_id).toBe("cli-test-1");
    expect(typeof out.client_secret).toBe("string");
    // The auto-generated secret is 32 random bytes
    // → 43 base64url chars; assert the shape, not the
    // value (the secret is opaque to the test).
    expect(out.client_secret.length).toBeGreaterThanOrEqual(16);
    expect(out.label).toBe("CLI test");
    // PR 4 contract: the output JSON no longer carries
    // a `scopes` field.
    expect((out as Record<string, unknown>).scopes).toBeUndefined();
  });

  it("persists the client in the database with the argon2id hash (not the plaintext)", async () => {
    // GIVEN the CLI ran with --client-id
    // WHEN we read the row back from the database
    // THEN the row exists, the hash is the argon2id
    //      of the plaintext, and the plaintext is
    //      NOT stored as the hash. The script
    //      generates + writes the secret; the
    //      test verifies the secret works (proof
    //      the hash is correct) WITHOUT storing the
    //      plaintext past the local variable.
    const res = runCli([
      "--client-id",
      "cli-test-2",
      "--db-path",
      dbPath,
    ]);
    expect(res.status).toBe(0);
    const stdout = res.stdout?.toString("utf8") ?? "";
    const out = JSON.parse(stdout.trim()) as CliOutput;
    // The plaintext is consumed locally; the test does
    // NOT log it or persist it. The variable goes out
    // of scope when this `it` block ends.
    const plaintext = out.client_secret;
    expect(plaintext.length).toBeGreaterThanOrEqual(16);
    // Read the row back and verify the hash.
    // (This uses a fresh connection so the script's
    // already-closed DB is not assumed open.)
    const db = openDatabase({ path: dbPath });
    try {
      await initializeSchema(db);
      const rows = await db.select<{ clientSecretHash: string; scopes: string }>(
        "SELECT clientSecretHash, scopes FROM clients WHERE clientId = ?",
        [out.client_id],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // The hash is NOT the plaintext.
      expect(row.clientSecretHash).not.toBe(plaintext);
      // The hash verifies the plaintext.
      const ok = await verifyPassword(row.clientSecretHash, plaintext);
      expect(ok).toBe(true);
      // The scopes column is the JSON-encoded empty
      // array (PR 4: scope is INERT legacy storage;
      // the CLI does not write a non-empty list).
      expect(JSON.parse(row.scopes)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("does NOT write the client_secret to stderr (audit-safety contract)", () => {
    // GIVEN the CLI ran with --client-id
    // WHEN the script exits
    // THEN stderr is empty (no diagnostic noise) AND
    //      the plaintext is NEVER in stderr. The
    //      spec-mandated contract is "single stdout
    //      write; capture it once". A leak to stderr
    //      would be a real audit-safety regression.
    const res = runCli([
      "--client-id",
      "cli-test-3",
      "--db-path",
      dbPath,
    ]);
    expect(res.status).toBe(0);
    const stderr = res.stderr?.toString("utf8") ?? "";
    // The CLI does not currently write to stderr on
    // the success path; the assertion pins the
    // contract.
    expect(stderr).toBe("");
  });

  it("returns a non-zero exit code on an invalid --client-id and writes a diagnostic to stderr", () => {
    // GIVEN the CLI is invoked with an empty
    //      --client-id (the script requires a
    //      non-empty value)
    // WHEN the script exits
    // THEN the exit code is non-zero AND stderr
    //      carries a sanitized diagnostic. The
    //      plaintext is NEVER in the diagnostic (we
    //      did not pass a secret here).
    const res = runCli([
      "--client-id",
      "",
      "--db-path",
      dbPath,
    ]);
    expect(res.status).not.toBe(0);
    const stderr = res.stderr?.toString("utf8") ?? "";
    expect(stderr).toMatch(/create-client:/);
  });

  it("rejects a missing --client-id (the script requires it)", () => {
    // GIVEN the CLI is invoked without --client-id
    // WHEN the script exits
    // THEN the exit code is non-zero AND a sanitized
    //      diagnostic names the missing flag. The
    //      script MUST NOT silently default to a
    //      generated id (an operator who forgets the
    //      flag would never know).
    const res = runCli(["--db-path", dbPath]);
    expect(res.status).not.toBe(0);
    const stderr = res.stderr?.toString("utf8") ?? "";
    expect(stderr).toMatch(/create-client:/);
  });
});
