/**
 * Operator CLI for pre-registering an OAuth2 client.
 *
 * The script writes a one-time `client_secret` to stdout
 * (the operator captures it once) and persists the
 * `argon2id` hash to the `clients` table. The script
 * does NOT log the secret except for the single stdout
 * write at the end.
 *
 * Usage:
 *   pnpm --filter mcp-oauth-admin create:client \
 *     -- --client-id my-app --label "My app" --scope "read:bi_catastro"
 *
 * The `--client-id` flag is required. `--label` and
 * `--scope` are optional. `--label` defaults to the empty
 * string; `--scope` defaults to the authority's
 * `MCP_OAUTH_DEFAULT_SCOPE` (or `read:bi_catastro` when
 * the env is unset). Multiple `--scope` flags are
 * space-joined.
 *
 * The script reads the SQLite path from
 * `MCP_OAUTH_DB_PATH` (the same env var the app reads);
 * the default is `./data/mcp-oauth.sqlite` relative to
 * the process CWD.
 *
 * Audit-safety: the script NEVER logs the plaintext
 * secret to any stream other than the single stdout
 * write at the end. There is no `--verbose` flag; the
 * diagnostic output is fixed-shape and contains no
 * secrets.
 */

import { parseArgs } from "node:util";
import { openDatabase, initializeSchema, defaultDatabasePath } from "../src/db/index.js";
import { createClient, type CreateClientResult } from "../src/admin/clients.js";
import type { AuthorityDatabase } from "../src/db/index.js";

function fail(message: string): never {
  process.stderr.write(`create-client: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      "client-id": { type: "string" },
      label: { type: "string" },
      scope: { type: "string", multiple: true },
      "db-path": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (parsed.values.help === true) {
    process.stdout.write(
      [
        "Usage: create-client --client-id ID [--label TEXT] [--scope SCOPE] [--db-path PATH]",
        "",
        "  --client-id  required OAuth2 client_id",
        "  --label      human-readable label (optional)",
        "  --scope      space-delimited scope string; may be passed multiple times",
        "  --db-path    SQLite path; defaults to $MCP_OAUTH_DB_PATH or ./data/mcp-oauth.sqlite",
        "",
        "Output: a single JSON line with { client_id, client_secret, scopes, label }.",
        "The client_secret is shown ONCE; capture it now.",
        "",
        "Redirect URI policy: clients created by this script are",
        "pre-registered. Their `redirectUris` column is empty by",
        "default and the authorize handler enforces the loopback-",
        "only rule (RFC 8252 §7.3) for them. To register a client",
        "with an explicit redirect URI list, use the Dynamic Client",
        "Registration endpoint (`POST /oauth/register`) — that path",
        "stores the supplied list and the authorize handler enforces",
        "byte-equal membership. Pre-registered clients cannot be",
        "promoted to an explicit list from this script; rotate",
        "the client's secret and re-register via DCR if the loopback-",
        "only behavior is not what you want.",
        "",
      ].join("\n"),
    );
    return;
  }
  const dbPath = (parsed.values["db-path"] as string | undefined) ?? defaultDatabasePath();
  const clientId = (parsed.values["client-id"] as string | undefined) ?? "";
  const label = (parsed.values.label as string | undefined) ?? "";
  // The `scope` option is `multiple: true`, so its value
  // is either `string | string[] | undefined` depending
  // on how many flags the operator passed. We coerce to
  // a `string[]` for the dedup-free split.
  const scopeFlags: string[] = Array.isArray(parsed.values.scope)
    ? (parsed.values.scope as string[])
    : typeof parsed.values.scope === "string"
      ? [parsed.values.scope]
      : [];
  const scopes = scopeFlags
    .join(" ")
    .split(/\s+/)
    .filter((s: string) => s.length > 0);
  const db: AuthorityDatabase = openDatabase({ path: dbPath });
  try {
    await initializeSchema(db);
    const now = Math.floor(Date.now() / 1000);
    const result: CreateClientResult = await createClient(db, {
      clientId,
      label,
      scopes,
      now,
    });
    if (!result.ok) {
      const reason = result.reason;
      await db.close();
      fail(reason);
    }
    const out = {
      client_id: result.client.clientId,
      client_secret: result.plaintextSecret,
      label: result.client.label,
      scopes: result.client.scopes,
    };
    // Single stdout write; the operator captures it.
    process.stdout.write(`${JSON.stringify(out)}\n`);
    await db.close();
  } catch (e) {
    try {
      await db.close();
    } catch {
      // Ignore: the original error wins.
    }
    fail(e instanceof Error ? e.message : String(e));
  }
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg);
});
