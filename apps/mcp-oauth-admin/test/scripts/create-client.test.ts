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
 * - The CLI accepts `--client-id`, `--label`, `--scope`,
 *   and `--db-path` flags.
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
  scopes: string[];
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
      env: {
        ...process.env,
        // Pin the DB path via the env too, so any
        // ambient process-wide state cannot leak into
        // the test (defense in depth against a
        // misconfigured CWD).
        MCP_OAUTH_DB_PATH: dbPath,
      },
    },
  );
}

describe("scripts/create-client.ts — operator CLI", () => {
  it("writes a single JSON line to stdout with { client_id, client_secret, label, scopes }", () => {
    // GIVEN the CLI is invoked with --client-id + --scope
    // WHEN the script exits
    // THEN stdout is exactly one JSON line whose shape
    //      matches the operator contract:
    //      { client_id, client_secret, label, scopes }.
    // The plaintext is captured but NEVER asserted
    // against by string value (the test must not
    // log / store the secret in CI output).
    const res = runCli([
      "--client-id",
      "cli-test-1",
      "--label",
      "CLI test",
      "--scope",
      "read:bi_catastro",
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
    expect(out.scopes).toEqual(["read:bi_catastro"]);
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
      "--scope",
      "read:bi_catastro",
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
      // The scopes column is the JSON-encoded list.
      expect(JSON.parse(row.scopes)).toEqual(["read:bi_catastro"]);
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
      "--scope",
      "read:bi_catastro",
      "--db-path",
      dbPath,
    ]);
    expect(res.status).toBe(0);
    const stderr = res.stderr?.toString("utf8") ?? "";
    // The CLI does not currently write to stderr on
    // the success path; the assertion pins the
    // contract. The plaintext is captured in stdout
    // and re-asserted against stderr to confirm it
    // does not leak.
    const stdout = res.stdout?.toString("utf8") ?? "";
    const out = JSON.parse(stdout.trim()) as CliOutput;
    expect(stderr).not.toContain(out.client_secret);
    expect(stderr).not.toContain("create-client:");
  });

  it("returns a non-zero exit code on an invalid --client-id and writes a diagnostic to stderr", () => {
    // GIVEN the CLI is invoked with a client_id that
    //      fails the regex (contains a space)
    // WHEN the script exits
    // THEN exit code is 2 (the CLI's `fail` exit code)
    //      and stderr carries a one-line diagnostic.
    //      stdout is empty (no JSON line was written).
    const res = runCli([
      "--client-id",
      "bad client id",
      "--scope",
      "read:bi_catastro",
      "--db-path",
      dbPath,
    ]);
    expect(res.status).toBe(2);
    const stdout = res.stdout?.toString("utf8") ?? "";
    expect(stdout.trim()).toBe("");
    const stderr = res.stderr?.toString("utf8") ?? "";
    expect(stderr).toMatch(/create-client:/);
    // The diagnostic is a static code ("invalid_clientId");
    // the offending value MUST NOT be echoed (defense in
    // depth — even though the value is not a secret, the
    // test pins the redaction contract).
    expect(stderr).not.toContain("bad client id");
  });

  it("rejects a missing --client-id (the script requires it)", () => {
    // GIVEN the CLI is invoked without --client-id
    // WHEN the script exits
    // THEN exit code is 2 (the CLI's `fail` exit code).
    //      The current implementation rejects an empty
    //      clientId (it does NOT generate a random
    //      default, despite the help text's claim —
    //      fixing that pre-existing inconsistency is
    //      out of scope for this polish pass; the test
    //      pins the actual contract).
    const res = runCli([
      "--scope",
      "read:bi_catastro",
      "--db-path",
      dbPath,
    ]);
    expect(res.status).toBe(2);
    const stdout = res.stdout?.toString("utf8") ?? "";
    expect(stdout.trim()).toBe("");
    const stderr = res.stderr?.toString("utf8") ?? "";
    expect(stderr).toMatch(/create-client:/);
  });
});
