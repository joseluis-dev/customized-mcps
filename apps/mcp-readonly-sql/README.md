# mcp-readonly-sql

A read-only [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for SQL databases. It lets MCP-compatible agents run safe, read-only queries against pre-configured connection profiles. **No write, schema, or admin operations are possible through this server.**

Supported dialects:

- PostgreSQL (`pg`) — server-scope
- MySQL / MariaDB (`mysql2`) — server-scope
- SQL Server / Azure SQL (`mssql` + `tedious`) — server-scope
- SQLite (`sqlite3`) — database-scope

> This package now lives in a pnpm + uv monorepo. Run all commands from the **repo root**
> using `pnpm --filter mcp-readonly-sql <script>`. The previous top-level `pnpm <script>`
> shortcuts still work because the workspace root scripts delegate to this app.

## How safety is enforced

This server is intentionally narrow:

- The agent can only select a profile **name** that exists in `.env`. Credentials, host, port, user, and password are never accepted from the agent.
- All SQL is parsed with `node-sql-parser` and **must** be a single `SELECT` (or a `WITH` whose body resolves to a single `SELECT`).
- DDL, DML, transaction control, session config, copy/load, calls, grants, etc. are explicitly rejected at both keyword and AST level.
- For server-scope profiles, every database referenced in the query must be in the profile's `ALLOWED_DATABASES` allowlist. If `REQUIRE_QUALIFIED_DATABASE=true`, all table names must be qualified with their database.
- Queries are executed inside a `READ ONLY` transaction (PostgreSQL/MySQL) or with the driver in read-only mode (SQLite).
- Results are capped by `maxRows` and the query by `timeoutMs`.
- Errors are sanitized so credentials are never leaked.

> For defense in depth, **also create the database user with read-only grants** at the engine level. The MCP server enforces what it can; the engine is the last line of defense.

## Server-scope vs database-scope

A profile is **server-scope** for PostgreSQL, MySQL/MariaDB, and SQL Server. This means the agent can run cross-database read queries inside the allowlist, e.g.:

```sql
SELECT p.*, t.*
FROM [catastral].[dbo].[Predios] p
JOIN [catastro].[dbo].[Titulares] t ON t.id = p.titular_id;
```

For MySQL/MariaDB:

```sql
SELECT p.*, t.*
FROM `catastral`.`Predios` p
JOIN `catastro`.`Titulares` t ON t.id = p.titular_id;
```

For PostgreSQL, a query inside a single database with a 3-part name is supported:

```sql
SELECT * FROM "app"."public"."users";
```

SQLite profiles are database-scope (one file per profile). They always set `PRAGMA query_only = ON` and you can additionally set the file as read-only at the OS level.

## Project layout

```
apps/mcp-readonly-sql/
  src/
    config/
      env.ts            environment variable loading
      profiles.ts       profile loader and validation
    db/
      dialects.ts       dialect mapping
      knexFactory.ts    connection manager + read-only transactions
      resultNormalizer.ts  result shaping
    secrets/
      SecretProvider.ts async secret resolution (file-backed)
    security/
      sqlGuard.ts       SQL allowlist + cross-DB enforcement
      sanitizeError.ts  error scrubbing
    tools/
      readonlyTools.ts  MCP tool definitions
    index.ts            MCP server entrypoint
  test/                 vitest unit tests
  .env.example          example configuration
```

## Configure profiles

Copy `apps/mcp-readonly-sql/.env.example` to `apps/mcp-readonly-sql/.env` and fill in one or more profiles. A profile is a set of `DB_<NAME>_*` variables referenced from `DB_PROFILES`.

The prefix `DB_<NAME>` is the **server-side operator key** — the name the operator uses in `DB_PROFILES` and in env var names. The MCP-facing **alias** is what agents see and pass to tool calls. By default, the alias equals the operator key. Set `DB_<NAME>_ALIAS` to expose a different, friendlier identifier (e.g. `DB_SQLSERVER_BI_ALIAS=bi_catastro`). The alias must match `^[A-Za-z0-9_]+$` and be 1–64 characters; startup fails closed on duplicates and on aliases that collide with another profile's operator key.

### SQL Server example (your case)

```env
DB_PROFILES=CATASTRO_SERVER

DB_CATASTRO_SERVER_CLIENT=sqlserver
DB_CATASTRO_SERVER_HOST=10.10.0.12
DB_CATASTRO_SERVER_PORT=1433
DB_CATASTRO_SERVER_INITIAL_DATABASE=master
DB_CATASTRO_SERVER_USER=readonly_user
DB_CATASTRO_SERVER_PASSWORD=secret
DB_CATASTRO_SERVER_ENCRYPT=true
DB_CATASTRO_SERVER_TRUST_SERVER_CERTIFICATE=true
DB_CATASTRO_SERVER_ALLOWED_DATABASES=catastral,catastro
DB_CATASTRO_SERVER_REQUIRE_QUALIFIED_DATABASE=true
DB_CATASTRO_SERVER_ALIAS=bi_catastro
DB_CATASTRO_SERVER_DISPLAY_NAME=Catastro BI
DB_CATASTRO_SERVER_TAGS=bi,finance
```

`TRUST_SERVER_CERTIFICATE=true` is what fixes the *self-signed certificate* error you saw in the inspector. The connection still uses TLS, it just does not validate the server's certificate against a trusted CA.

### PostgreSQL example

```env
DB_PROFILES=PG_LOCAL

DB_PG_LOCAL_CLIENT=postgres
DB_PG_LOCAL_HOST=localhost
DB_PG_LOCAL_PORT=5432
DB_PG_LOCAL_INITIAL_DATABASE=postgres
DB_PG_LOCAL_USER=readonly_user
DB_PG_LOCAL_PASSWORD=secret
DB_PG_LOCAL_SSL=false
DB_PG_LOCAL_ALLOWED_DATABASES=app,analytics
DB_PG_LOCAL_REQUIRE_QUALIFIED_DATABASE=true
```

### MySQL / MariaDB example

```env
DB_PROFILES=MYSQL_REPORTING

DB_MYSQL_REPORTING_CLIENT=mysql
DB_MYSQL_REPORTING_HOST=localhost
DB_MYSQL_REPORTING_PORT=3306
DB_MYSQL_REPORTING_INITIAL_DATABASE=mysql
DB_MYSQL_REPORTING_USER=readonly_user
DB_MYSQL_REPORTING_PASSWORD=secret
DB_MYSQL_REPORTING_ALLOWED_DATABASES=reporting,staging
DB_MYSQL_REPORTING_REQUIRE_QUALIFIED_DATABASE=true
```

### SQLite example

```env
DB_PROFILES=SQLITE_DEMO

DB_SQLITE_DEMO_CLIENT=sqlite
DB_SQLITE_DEMO_FILENAME=./data/demo.sqlite
DB_SQLITE_DEMO_ALLOWED_DATABASES=main
```

### File-backed secrets

Any secret-bearing field (currently `DB_<NAME>_PASSWORD`) can point at a file using the `${secret:file:/abs/path}` syntax. The loader resolves the file at startup using async I/O with a per-resolve timeout (default 5s). The literal never appears in logs, errors, or `ProfileSummary`; only the resolved value is held in memory.

```env
DB_SQLSERVER_BI_PASSWORD=${secret:file:/run/secrets/db_pw}
```

Rules:

- Profile names (operator keys) must match `^[A-Za-z0-9_]+$`.
- Aliases (`DB_<NAME>_ALIAS`) must match `^[A-Za-z0-9_]+$`, 1–64 characters.
- For server-scope profiles, `DB_<NAME>_ALLOWED_DATABASES` is **required**. Use a comma-separated list of database names, or `*` to allow any database the read-only user can see. Database identifiers must match `^[A-Za-z0-9_\-$]+$`.
- `DB_<NAME>_INITIAL_DATABASE` (or the legacy `DB_<NAME>_DATABASE`) sets the database used at connection time. Defaults are `master` for SQL Server, `postgres` for PostgreSQL, `mysql` for MySQL/MariaDB.
- `DB_<NAME>_REQUIRE_QUALIFIED_DATABASE` defaults to `true` for server-scope profiles. Set `false` to allow unqualified `SELECT * FROM t` style queries.
- `DB_<NAME>_DISPLAY_NAME`, `DB_<NAME>_DESCRIPTION`, and `DB_<NAME>_TAGS` are optional display fields. Tags are comma-separated, trimmed, deduped, and order-preserving. If a value matches a sensitive pattern (e.g. contains `${secret:...}`, a `password=…` pair, or a `user:pass@` URI fragment), the value is omitted from `list_profiles` and a warning is written to stderr.
- `DB_<NAME>_CAPABILITIES` defaults to `["read-only"]`.
- For SQLite, `DB_<NAME>_FILENAME` must be a **relative** path; absolute paths and `..` traversal are rejected at startup. The resolved file must remain inside the app directory. As an extra defense, every SQLite connection sets `PRAGMA query_only = ON`, and you can additionally set the file as read-only at the OS level.
- Safety caps: `MAX_ROWS_DEFAULT`, `MAX_ROWS_HARD_LIMIT`, `QUERY_TIMEOUT_MS_DEFAULT`, `QUERY_TIMEOUT_MS_HARD_LIMIT`.

## Install and run

All commands run from the **repo root** with pnpm filters. The MCP host entrypoint is
`apps/mcp-readonly-sql/dist/index.js` — a path that **changed** from the pre-monorepo
layout (it used to be `<repo>/dist/index.js`).

```bash
# one-time install for the whole workspace
pnpm install

# build this app (compiles to apps/mcp-readonly-sql/dist/index.js)
pnpm --filter mcp-readonly-sql build

# run from the compiled output
pnpm --filter mcp-readonly-sql start
```

For development with auto-reload:

```bash
pnpm --filter mcp-readonly-sql dev
```

To exercise the server with the MCP Inspector:

```bash
pnpm --filter mcp-readonly-sql inspect
```

## Tools exposed

| Tool | Purpose |
| ---- | ------- |
| `list_profiles` | Lists the configured profile aliases and their scope/allowlist, plus optional `displayName`, `description`, `tags`, and `capabilities`. No credentials. |
| `list_databases` | Returns the allowlist (or `*`) for a given server-scope profile. |
| `test_connection` | Runs `SELECT 1` against the initial database to confirm reachability. |
| `execute_read_query` | Runs a read-only `SELECT`/`WITH` query, optionally with a `database` argument. |
| `describe_schema` | Returns tables (and columns when a `table` is given) for the given `database`. |

Tools accept the **alias** (default = operator key) for the `profile` argument; the operator key is also accepted as a synonym for backward compatibility. The `profile` value is never enriched with connection fields, host, port, user, or password — those are server-side only. The zod input schemas are `.strict()` so extra fields (including `host`/`user`/`password`/`port`) are rejected.

### Example: execute_read_query (SQL Server, two databases)

```json
{
  "profile": "bi_catastro",
  "sql": "SELECT TOP 100 p.*, t.* FROM [catastral].[dbo].[Predios] p JOIN [catastro].[dbo].[Titulares] t ON t.id = p.titular_id",
  "maxRows": 100
}
```

### Example: execute_read_query (PostgreSQL, single database)

```json
{
  "profile": "PG_LOCAL",
  "database": "app",
  "sql": "SELECT * FROM public.users WHERE active = ?",
  "bindings": [true],
  "maxRows": 50
}
```

### Example: describe_schema

```json
{
  "profile": "bi_catastro",
  "database": "catastral",
  "table": "Predios"
}
```

Notes:

- `bindings` is preferred for any user-supplied values.
- `maxRows` is optional; defaults to `MAX_ROWS_DEFAULT` and capped at `MAX_ROWS_HARD_LIMIT`.
- `timeoutMs` is optional; defaults to `QUERY_TIMEOUT_MS_DEFAULT` and capped at `QUERY_TIMEOUT_MS_HARD_LIMIT`.

## Cross-database limitation in PostgreSQL

PostgreSQL does not allow joining two databases in a single `SELECT` without `postgres_fdw` or `dblink`. The MCP lets the agent pick a database per call and rejects cross-database joins, which keeps the read-only guarantee at the engine level.

## Wire it into an MCP client

> **Breaking change vs pre-monorepo:** the `args` path moved from
> `<repo>/dist/index.js` to `<repo>/apps/mcp-readonly-sql/dist/index.js`. Update any
> existing `mcpServers` config accordingly.

For stdio-based clients (Claude Desktop, Cursor, etc.), add the server to the client configuration. Example for Claude Desktop:

```json
{
  "mcpServers": {
    "readonly-sql": {
      "command": "node",
      "args": ["D:/path/to/this/repo/apps/mcp-readonly-sql/dist/index.js"],
      "cwd": "D:/path/to/this/repo/apps/mcp-readonly-sql",
      "env": {
        "DOTENV_CONFIG_PATH": "D:/path/to/this/repo/apps/mcp-readonly-sql/.env"
      }
    }
  }
}
```

Three details matter for the host wiring:

- `args` points at the app's compiled entrypoint, not the repo root.
- `cwd` is set to the app directory so `process.cwd()`-relative paths (e.g. SQLite
  `DB_SQLITE_DEMO_FILENAME=./data/demo.sqlite`) resolve next to `apps/mcp-readonly-sql/data/`.
- `DOTENV_CONFIG_PATH` points at the app's `.env` so profile credentials load
  correctly even if the host's own cwd differs.

## Tests

```bash
pnpm --filter mcp-readonly-sql test
```

The test suite covers:

- `sqlGuard` blocks every form of write/admin statement and allows only `SELECT`/`WITH`.
- `sqlGuard` enforces the database allowlist for server-scope profiles across dialects.
- `profiles` loader handles PostgreSQL, MySQL, SQLite, MSSQL, rejects unsafe SQLite paths and missing allowlists, parses alias/display/tags/capabilities, rejects collisions, and resolves `${secret:file:...}` password refs without leaking path/host/user/password/port.
- `profileAlias` covers `ProfileSummary` shape (no host/user/password/port, `name === alias`), alias-first lookup with operator-key fallback, caller-keyed error messages, and strict zod rejection of extra fields on every tool.
- `secretRefs` covers the `FileSecretProvider` (success, missing file, relative path rejection, pre-aborted signal, unsupported kinds, signal+timeout composition).
- `sanitizeError` masks `${secret:...}` literals, DSN-style credential pairs, and `user:pass@` URI fragments.
- `monorepoStructure` covers the workspace root contract (pnpm + uv scaffold, recursive
  `.gitignore` patterns, no root deployable artifact) and the app contract
  (package name preserved, `tsconfig.json` extends base, no cross-app imports,
  build artifact lives under `apps/mcp-readonly-sql/dist/`).

## License

ISC
