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
 *     -- --client-id my-app --label "My app"
 *
 * The `--client-id` flag is required. `--label` is
 * optional. The script reads the SQLite path from
 * `MCP_OAUTH_DB_PATH` (the same env var the app reads);
 * the default is `./data/mcp-oauth.sqlite` relative to
 * the process CWD.
 *
 * PR 4 of `remove-scope-authorization`: the `--scope`
 * flag is removed. Scope authorization is inert; new
 * clients have an empty `scopes` column (the column
 * is INERT legacy storage). The output JSON no longer
 * carries a `scopes` field.
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
      "db-path": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (parsed.values.help === true) {
    process.stdout.write(
      [
        "Usage: create-client --client-id ID [--label TEXT] [--db-path PATH]",
        "",
        "  --client-id  required OAuth2 client_id",
        "  --label      human-readable label (optional)",
        "  --db-path    SQLite path; defaults to $MCP_OAUTH_DB_PATH or ./data/mcp-oauth.sqlite",
        "",
        "Output: a single JSON line with { client_id, client_secret, label }.",
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
  const db: AuthorityDatabase = openDatabase({ path: dbPath });
  try {
    await initializeSchema(db);
    const now = Math.floor(Date.now() / 1000);
    const result: CreateClientResult = await createClient(db, {
      clientId,
      label,
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
