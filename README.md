# db-workspace

A pnpm + uv monorepo that hosts multiple Model Context Protocol (MCP) apps. The repo
root is a non-deployable scaffold; each MCP app is its own self-contained package
under `apps/`.

## Apps

| App | Type | Path | Purpose |
| --- | ---- | ---- | ------- |
| `mcp-oauth-admin` | TypeScript (NodeNext ESM) | `apps/mcp-oauth-admin/` | SQLite-backed OAuth2 authorization server and server-rendered admin UI for MCP resource servers. |
| `mcp-readonly-sql` | TypeScript (NodeNext ESM) | `apps/mcp-readonly-sql/` | Read-only MCP server for PostgreSQL, MySQL/MariaDB, SQL Server, and SQLite. |

See [`deploy/README.md`](deploy/README.md) for the multi-app OAuth deployment
runbook and [`apps/mcp-readonly-sql/README.md`](apps/mcp-readonly-sql/README.md)
for the resource server's configuration, run instructions, and MCP host wiring.

## Workspace layout

```
.
├── apps/
│   ├── mcp-oauth-admin/      # OAuth2 authority + admin UI
│   └── mcp-readonly-sql/     # read-only SQL MCP resource server
├── openspec/                 # spec-driven change tracking
├── .atl/                     # skill registry cache (tracked)
├── package.json              # workspace root: private, no bin/main
├── pnpm-workspace.yaml       # pnpm members: ["apps/*"]
├── pyproject.toml            # uv workspace root: [tool.uv.workspace] members = []
├── tsconfig.base.json        # shared strict TS flags; apps extend it
├── pnpm-lock.yaml            # pnpm lockfile (workspace-wide)
└── README.md                 # this file
```

## Quick path

```bash
# 1. Install dependencies for the whole workspace
pnpm install

# 2. Build all apps and shared packages
pnpm build

# 3. Test the workspace
pnpm test

# 4. Launch the resource server via the MCP Inspector
pnpm --filter mcp-readonly-sql inspect
```

Root-level `pnpm test`, `pnpm typecheck`, and `pnpm build` run across the
workspace. Root-level `pnpm dev`, `pnpm start`, and `pnpm inspect` remain
ergonomic shortcuts for `mcp-readonly-sql`.

## Adding a new app

1. Create the directory: `apps/<new-app>/`.
2. For TypeScript apps: drop in a `package.json` (with a unique `name` — do **not**
   scope it to `@customized-mcps/`), a `tsconfig.json` that extends `../../tsconfig.base.json`,
   and the usual `src/` / `test/` folders.
3. For Python apps: drop in a `pyproject.toml` with a `[project.scripts]` entry
   pointing at the wire entrypoint, and add the app to `[tool.uv.workspace]`
   `members` in the root `pyproject.toml`.
4. Run `pnpm install` (or `uv sync`) from the repo root to refresh the lockfile.
5. Document the app in the table above and link its README.

Apps do **not** import from each other. Each app is installable, testable, and
deployable using only its own files plus declared dependencies.

## Breaking change for MCP host operators

If you wired this server into Claude Desktop, Cursor, or any other MCP host before
the monorepo migration, update your `mcpServers` entry to point at the new path
and set `cwd` to the app directory so SQLite `process.cwd()` lookups keep working:

| Before | After |
| ------ | ----- |
| `args`: `<repo>/dist/index.js` | `args`: `<repo>/apps/mcp-readonly-sql/dist/index.js` |
| `cwd`: not set (host default) | `cwd`: `<repo>/apps/mcp-readonly-sql` |
| `env.DOTENV_CONFIG_PATH`: `<repo>/.env` | `env.DOTENV_CONFIG_PATH`: `<repo>/apps/mcp-readonly-sql/.env` |

The five tools, the JSON-RPC wire format, and the read-only safety contract are
unchanged — only the launch path moved.

## Testing capabilities

- **Test runner:** vitest 2.1 (per app, run with `pnpm --filter <app> test`)
- **Typecheck:** `pnpm --filter <app> typecheck`
- **Coverage:** not wired (`@vitest/coverage` is not a devDependency)
- **Lint / format:** not wired (style enforced by `tsc` + manual review)

See `openspec/config.yaml` for the full testing capabilities cache.

## License

ISC
