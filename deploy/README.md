# customized-mcps — Multi-app Operator Runbook

> This runbook covers the operational surface for the customized-mcps
> workspace. It complements the per-app developer-facing READMEs
> ([apps/mcp-readonly-sql/README.md](../../apps/mcp-readonly-sql/README.md)
> and the authority's own docs in
> [openspec/changes/oauth-sqlite-admin-authorization/](../../openspec/changes/oauth-sqlite-admin-authorization/)).
> For implementation details, see the delta specs under
> [openspec/changes/oauth-sqlite-admin-authorization/specs/](../../openspec/changes/oauth-sqlite-admin-authorization/specs/).

The templates in this directory (`systemd/`, `docker/`, `nginx/`)
ship with the repo. Operators may copy, modify, and redeploy them;
the contract is in
[specs/mcp-deployment-templates/spec.md](../../openspec/changes/oauth-sqlite-admin-authorization/specs/mcp-deployment-templates/spec.md).

## Table of contents

- [TL;DR](#tldr)
- [Quick path (production)](#quick-path-production)
- [Apps](#apps)
  - [mcp-readonly-sql](#mcp-readonly-sql)
  - [mcp-oauth-admin](#mcp-oauth-admin)
- [Production deployment (reverse proxy)](#production-deployment-reverse-proxy)
- [Dev / staging without TLS](#dev--staging-without-tls)
- [Configuration: where env vars come from](#configuration-where-env-vars-come-from)
- [Choose your backend](#choose-your-backend)
- [Health probe and graceful shutdown](#health-probe-and-graceful-shutdown)
- [Port allocation](#port-allocation)
- [Rotate keys](#rotate-keys)
- [Read the structured logs](#read-the-structured-logs)
- [Roll back](#roll-back)
- [Sanity checks](#sanity-checks)
- [Docker quick path](#docker-quick-path)
- [What's not in the runbook (and why)](#whats-not-in-the-runbook-and-why)

## TL;DR

- **Production**: deploy every app's `*.service` unit behind your
  existing reverse proxy; TLS terminates at the proxy, never in
  any app.
- **Dev / staging**: bind `MCP_HTTP_HOST=127.0.0.1` on every app
  and skip the proxy. Plain HTTP in a trusted network is fine;
  never expose it publicly.
- **Rollback** (resource server): set `MCP_TRANSPORT=stdio` in the
  env file and restart.
- **Rollback** (authority): stop the unit, restore the SQLite file
  from a backup, and unset `MCP_AUTHORITY_URL` on every resource
  server. The local HMAC roster is preserved as the
  dev/offline fallback.

## Quick path (production)

1. Build every app on the host:
   - `pnpm --filter mcp-readonly-sql build`
   - `pnpm --filter mcp-oauth-admin build`
2. Copy `dist/`, `package.json`, and `pnpm-lock.yaml` to each
   app's install path:
   - `/opt/mcp/db/apps/mcp-readonly-sql`
   - `/opt/mcp/oauth/apps/mcp-oauth-admin`
3. Create the unprivileged user (one per host):
   `useradd --system --no-create-home --shell /sbin/nologin mcp`.
4. Create the per-app env file at the install path
   (use `apps/<app>/.env.example` as the template).
5. Install every systemd unit:
   ```bash
   cp deploy/systemd/mcp-readonly-sql.service /etc/systemd/system/
   cp deploy/systemd/mcp-oauth-admin.service   /etc/systemd/system/
   systemctl daemon-reload
   ```
6. Start them:
   ```bash
   systemctl enable --now mcp-readonly-sql.service
   systemctl enable --now mcp-oauth-admin.service
   ```
7. Validate:
   - `curl -sS http://127.0.0.1:3001/healthz` → `200`
     `{"status":"ok","authorityBackend":"oauth"}` (or
     `"local"` when the local backend is in use).
   - `curl -sS http://127.0.0.1:3002/healthz` → `200`
     `{"status":"ok"}` (the authority's `/healthz`).
8. Front them with the proxy in
   [deploy/nginx/mcp.conf](nginx/mcp.conf) (or your existing
   reverse proxy — the spec only requires nginx or an
   equivalent; a Caddy example is welcome as a follow-up).

## Apps

### mcp-readonly-sql

The read-only MCP resource server. Binds port **3001** by default
(mcp-http-transport Port Allocation Convention). Validates bearer
tokens (HMAC for the local backend; RS256/ES256 JWT for the
JWKS or OAuth admin backend). Surfaces five read-only tools
(`list_profiles`, `test_connection`, `list_databases`,
`execute_read_query`, `describe_schema`).

| Surface | Path | Default |
| --- | --- | --- |
| systemd unit | `deploy/systemd/mcp-readonly-sql.service` | `/opt/mcp/db/apps/mcp-readonly-sql` |
| Dockerfile | `deploy/docker/Dockerfile` | `EXPOSE 3001` |
| Env file | `apps/mcp-readonly-sql/.env.example` | source of truth |
| `MCP_HTTP_PORT` | 3001 | (resource server convention) |
| Listener | `127.0.0.1:3001` | loopback default |

#### Production deployment

The unit runs the resource server behind the existing reverse
proxy. The reverse proxy MUST:
- Enforce a body-size cap (`client_max_body_size 1m`).
- Preserve the `Authorization` header verbatim.
- Not load-balance across multiple upstream instances (the app
  is single-process; one service unit per host, distinct port).
- Allow `/healthz` through unauthenticated.

#### Dev / staging without TLS

Bind loopback only:
```env
MCP_HTTP_HOST=127.0.0.1
MCP_TRANSPORT=streamableHttp
```

If you need a non-loopback bind, opt in explicitly:
```env
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_ALLOW_INSECURE_BIND=true
```

#### Env file path

- `EnvironmentFile=/opt/mcp/db/apps/mcp-readonly-sql/.env`
  (the path the unit reads; mirrors the app's own dotenv path).
- Override to `/etc/mcp/mcp-readonly-sql.env` if you prefer the
  per-app env location; the runbook documents the convention.

#### Rotate agent keys (HMAC)

The local backend is the dev/offline fallback only; production
deployments use the OAuth admin authority. When the local
backend IS in use:

1. Generate a new `MCP_AGENT_HMAC_SECRET` (32+ bytes):
   `openssl rand -hex 32`.
2. For every agent in `MCP_AGENTS_JSON`, recompute the
   `keyHash` with the new secret:
   ```bash
   echo -n "<new-bearer-token>" | openssl dgst -sha256 -hmac "<new-secret>" | awk '{print $2}'
   ```
3. Replace the `keyHash` field in the roster file.
4. Restart the service: `systemctl restart mcp-readonly-sql.service`.
5. Hand the new bearer token to the corresponding agent out of
   band.

Old bearer tokens are immediately invalid. Operators that want
zero downtime can pre-provision the new keyHashes before rotating
the secret (use `MCP_AGENTS_INLINE` as a staging path, then
promote to `MCP_AGENTS_JSON` once verified).

#### Roll back to stdio

```env
MCP_TRANSPORT=stdio
systemctl restart mcp-readonly-sql.service
```

The MCP host falls back to spawning the process directly. The
same five tools are still registered; only the transport
changes. No data is lost.

### mcp-oauth-admin

The OAuth2 authority + SQLite identity store + web admin UI.
Binds port **3002** by default (mcp-http-transport
reservation). Owns default-scope assignment for newly
registered agents and clients. The resource server
([mcp-readonly-sql](#mcp-readonly-sql)) is a resource-server
peer that talks to this authority over `/oauth/introspect`
and `/.well-known/jwks.json`.

| Surface | Path | Default |
| --- | --- | --- |
| systemd unit | `deploy/systemd/mcp-oauth-admin.service` | `/opt/mcp/oauth/apps/mcp-oauth-admin` |
| Dockerfile | `deploy/docker/Dockerfile.mcp-oauth-admin` | `EXPOSE 3002` |
| Env file | `apps/mcp-oauth-admin/.env.example` | source of truth |
| `MCP_HTTP_PORT` | 3002 | (authority reservation) |
| Listener | `127.0.0.1:3002` | loopback default |
| SQLite | `${MCP_OAUTH_DB_PATH:-./data/mcp-oauth.sqlite}` | WAL mode, `foreign_keys=ON` |
| Backup | `${MCP_OAUTH_BACKUP_TARGET}` | optional; atomic `VACUUM INTO` |

#### Production deployment

The unit runs the authority behind the existing reverse proxy.
The reverse proxy MUST:
- Enforce a body-size cap (`client_max_body_size 1m`).
- Preserve the `Cookie` and `Authorization` headers verbatim
  (the admin UI uses a session cookie; the OAuth endpoints use
  `Authorization: Basic ...` for the client_credentials grant).
- Allow `/auth/healthz` (or the upstream `127.0.0.1:3002/healthz`)
  through unauthenticated.
- Not load-balance across multiple authority instances (the
  SQLite file is the single-writer; one authority per host).

#### Dev / staging without TLS

Bind loopback only:
```env
MCP_HTTP_HOST=127.0.0.1
MCP_OAUTH_ADMIN_USERNAME=root
MCP_OAUTH_ADMIN_PASSWORD=change_me_on_first_login
```

The `MCP_OAUTH_ADMIN_*` env vars seed the bootstrap admin on
first start. The password is stored as `argon2id` and
`require_change_on_first_login` is set; the admin cannot mint
tokens until the password is rotated via the admin UI.

> **Warning**: while `MCP_OAUTH_ADMIN_USERNAME` /
> `MCP_OAUTH_ADMIN_PASSWORD` are set, the resource server
> emits a `WARN` on every start (see
> `apps/mcp-readonly-sql/src/config/http.ts`). Unset the env
> vars after the first rotation to silence the warning.

#### Env file path

- `EnvironmentFile=/opt/mcp/oauth/apps/mcp-oauth-admin/.env`
  (mirrors the app's own dotenv path).
- Override to `/etc/mcp/mcp-oauth-admin.env` if you prefer the
  per-app env location.

#### Rotate the bootstrap admin password

The bootstrap admin is created on first start when
`MCP_OAUTH_ADMIN_USERNAME` / `MCP_OAUTH_ADMIN_PASSWORD` are
set. After the first rotation (via the admin UI or
`POST /admin/agents/.../change-password`):

1. Log in to the admin UI at `https://<host>/admin/`.
2. Click "Change password" on the bootstrap admin row.
3. Pick a new password (16+ bytes, no embedded 64-char hex,
   no bearer-token-shaped values).
4. Update the `.env` file to remove
   `MCP_OAUTH_ADMIN_USERNAME` / `MCP_OAUTH_ADMIN_PASSWORD`
   (the WARN at the resource server stops when the env is
   unset; the admin row is the new source of truth).
5. Restart the authority:
   `systemctl restart mcp-oauth-admin.service`.

The rotated password is `argon2id`-hashed at write time; the
plaintext is never logged. The session secret is regenerated
on every restart (invalidating all admin sessions).

#### Rotate the OAuth signing key

The RS256 signing key is stored in the `keys` table. The
authority does NOT yet ship a key-rotation UI; rotation is
operator-driven:

1. Back up the SQLite file (the `MCP_OAUTH_BACKUP_TARGET`
   does this on a schedule; you can also run
   `sqlite3 data/mcp-oauth.sqlite ".backup '/tmp/snap.db'"`).
2. Stop the authority: `systemctl stop mcp-oauth-admin.service`.
3. Insert a new key row with the desired `kid` and
   `expiresAt` (a future-dated active key); the
   `apps/mcp-oauth-admin/src/oauth/keys.ts` module is the
   reference for the schema.
4. Start the authority: `systemctl start mcp-oauth-admin.service`.
5. The new key is active; the old key is served from the
   JWKS for the grace period (the JWKS includes both).

#### Backup

When `MCP_OAUTH_BACKUP_TARGET` is set, the authority copies the
live database to the target on startup and every
`MCP_OAUTH_BACKUP_INTERVAL_S` (default 86400 = 24h). The copy
is atomic at the file level (a partial file is never observed).
The target directory is created if missing.

```env
MCP_OAUTH_BACKUP_TARGET=/var/backups/mcp-oauth.sqlite
MCP_OAUTH_BACKUP_INTERVAL_S=86400
```

The retention sweep is independent of the backup. The sweep
deletes `audit_log` rows older than 90 days and `refresh_tokens`
rows with `revokedAt` older than 30 days. Set
`MCP_OAUTH_DISABLE_RETENTION_SWEEP=true` to disable the sweep
(operators with their own external retention policy).

## Production deployment (reverse proxy)

> **TLS terminates at the existing reverse proxy. Every app serves
> plain HTTP only.** The example in
> [nginx/mcp.conf](nginx/mcp.conf) is a complete, standalone
> nginx config. Copy the `server { ... }` block into your
> existing `http { ... }` if you already have a system nginx.

The proxy MUST:

1. **Enforce a body-size cap** (`client_max_body_size 1m;` in
   nginx). The shared HTTP base returns `411 Length Required`
   for chunked bodies by default, so the cap is the only
   place a chunked upload is bounded. Operators that opt in to
   `MCP_HTTP_ALLOW_UNBOUNDED_BODY=true` MUST also confirm
   this cap is in place — the app logs a one-shot warning on
   the first chunked request to make the missing cap visible.
2. **Preserve the Authorization / Cookie headers**
   (`proxy_set_header Authorization $http_authorization;` in
   nginx). The shared base does HMAC / JWT validation on the
   bearer token; the header MUST reach the app verbatim.
   Removing this line breaks auth; setting it to a static
   value breaks multi-agent isolation. The admin UI uses a
   session cookie; the proxy MUST forward `Cookie` /
   `Set-Cookie` headers verbatim (the default behavior).
3. **Not load-balance** across multiple upstream instances.
   Every app in the workspace is single-process. Horizontal
   scale is the host's job (one service unit per host,
   distinct ports).
4. **Allow the health probes through unauthenticated**:
   - `GET /healthz` → the resource server's `/healthz`
     (proxied to `127.0.0.1:3001`).
   - `GET /auth/healthz` → the authority's `/healthz`
     (proxied to `127.0.0.1:3002`).
5. **Reverse-proxy the authority's surfaces**:
   - `/admin/` → the admin UI on `127.0.0.1:3002`.
   - `/oauth/token`, `/oauth/introspect` → the OAuth2
     endpoints on `127.0.0.1:3002`.
   - `/.well-known/jwks.json`, `/.well-known/openid-configuration`
     → the discovery / JWKS endpoints on `127.0.0.1:3002`.

Set `MCP_HTTP_BEHIND_PROXY=true` in every env file so each
app accepts the non-loopback binding that the proxy terminates
onto.

## Dev / staging without TLS

When running outside a reverse proxy, bind the loopback only on
every app:

```env
MCP_HTTP_HOST=127.0.0.1   # default; loopback only
MCP_TRANSPORT=streamableHttp   # mcp-readonly-sql only
```

If you need to bind a non-loopback address (e.g., a shared dev
VM), you MUST opt in explicitly:

```env
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_ALLOW_INSECURE_BIND=true   # explicit acknowledgement
```

> **Warning**: any token transmitted over plain HTTP can be
> captured by anyone on the network. Use the loopback default
> whenever possible.

## Configuration: where env vars come from

The single source of truth for env var names is each app's
`.env.example` file:
- `apps/mcp-readonly-sql/.env.example` — the resource server.
- `apps/mcp-oauth-admin/.env.example` — the authority.

The app reads `.env` via dotenv at startup, and the systemd
`EnvironmentFile` directive points systemd at the same file.
The Docker image copies `.env.example` for operator reference;
the operator mounts their own `.env` (or passes `--env-file`).

The proxy config does NOT reference any `MCP_*` or `DB_*` env
var — it sets TLS / proxy behavior statically. The only
piece of cross-cutting config is the upstream `proxy_pass
http://127.0.0.1:<app-port>;` (3001 for the resource server;
3002 for the authority).

| Group | Vars | Source |
| --- | --- | --- |
| Transport (resource server) | `MCP_TRANSPORT` | `.env` (or `.env.example` for defaults) |
| HTTP listener (every app) | `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_HTTP_PATH`, `MCP_HTTP_STATELESS`, `MCP_HTTP_SHUTDOWN_TIMEOUT_MS`, `MCP_HTTP_MAX_BODY_BYTES`, `MCP_HTTP_ALLOW_UNBOUNDED_BODY`, `MCP_LOG_FORMAT`, `MCP_HTTP_BEHIND_PROXY`, `MCP_HTTP_ALLOW_INSECURE_BIND` | `.env` |
| Agent auth (local backend) | `MCP_AGENT_HMAC_SECRET`, `MCP_AGENTS_JSON` or `MCP_AGENTS_INLINE` | `.env` (HMAC secret) + JSON file or inline string |
| Agent auth (authority) | `MCP_AUTHORITY_URL`, `MCP_AUTHORITY_AUDIENCE`, `MCP_AUTHORITY_JWKS_URL`, `MCP_AUTHORITY_JWKS_TTL_S`, `MCP_AUTHORITY_LEEWAY_S`, `MCP_AUTHORITY_FETCH_TIMEOUT_MS` | `.env` |
| Authority storage | `MCP_OAUTH_DB_PATH`, `MCP_OAUTH_BACKUP_TARGET`, `MCP_OAUTH_BACKUP_INTERVAL_S`, `MCP_OAUTH_DISABLE_RETENTION_SWEEP` | `.env` (per-app) |
| Authority bootstrap | `MCP_OAUTH_ADMIN_USERNAME`, `MCP_OAUTH_ADMIN_PASSWORD` | `.env` (per-app; unset after first rotation) |
| Authority audience | `MCP_AUTHORITY_AUDIENCE` | `.env` (resource server side) |
| DB profiles (resource server) | `DB_PROFILES`, `DB_<NAME>_*` | `.env` (with optional file-backed secrets) |
| Safety limits (resource server) | `MAX_ROWS_DEFAULT`, `MAX_ROWS_HARD_LIMIT`, `QUERY_TIMEOUT_MS_DEFAULT`, `QUERY_TIMEOUT_MS_HARD_LIMIT` | `.env` |

## Choose your backend

The resource server (`mcp-readonly-sql`) supports two
token-verification backends. The selection is driven by
`MCP_AUTHORITY_URL`; the local backend is the unset-env
default (dev/offline only), the OAuth admin authority is the
recommended default for production.

| Backend | Selected when | When to use | Token shape | Roster |
| --- | --- | --- | --- | --- |
| **Local HMAC roster** (`LocalRosterAuthority`) | `MCP_AUTHORITY_URL` is **unset** | Dev / offline / single-host deployments without a shared authority | Opaque bearer (HMAC compared against `MCP_AGENTS_JSON`) | `MCP_AGENTS_JSON` or `MCP_AGENTS_INLINE` |
| **OAuth admin authority** (`OAuthAdminAuthority`) | `MCP_AUTHORITY_URL` is **set** | Production / shared deployments with the `mcp-oauth-admin` authority | RS256 JWT (signature verified against the authority's JWKS) | Owned by the authority; no roster on the resource-server side |

The selection is deterministic and is reflected in
`GET /healthz` via the `authorityBackend` field (`"local"` or
`"oauth"`). Switch backends by setting or unsetting
`MCP_AUTHORITY_URL` and restarting the service — no other
config change is required. The same MCP tools, the same
scopes, and the same `SCOPE_PATTERN` apply to both backends;
the wire contract on the resource-server side is unchanged.

The local backend is **dev/offline only** and is deprecated.
The resource server emits a one-shot `WARN` at startup naming
`MCP_AGENTS_JSON`, `MCP_AGENTS_INLINE`, and
`MCP_AGENT_HMAC_SECRET` as deprecated when the local backend
is active. Operators deploying a shared or production
environment MUST use the OAuth admin authority.

## Health probe and graceful shutdown

- `GET /healthz` (resource server, port 3001) returns `200`
  with body `{"status":"ok","authorityBackend":"local"}`
  when the app is ready to serve (the `authorityBackend` field
  is `"oauth"` when `MCP_AUTHORITY_URL` is set, per the
  mcp-token-authority spec). On shutdown or factory failure
  the response is `503` with body
  `{"status":"shutting-down"|"unhealthy","authorityBackend":
  "local"}`. The endpoint is unauthenticated; the reverse
  proxy MUST allow it through.
- `GET /auth/healthz` (authority, port 3002 via the proxy) is
  the upstream path; the authority exposes `/healthz` on
  `127.0.0.1:3002` directly. Same response shape.
- The `authorityBackend` field is the audit-safe label that
  lets operators and orchestrators confirm the selected
  backend without grepping the env file. The body MUST NOT
  include the authority URL, the JWKS URL, the token, or
  the `kid` — only the `status` + `authorityBackend` pair.
- SIGTERM triggers a graceful drain: every app stops
  accepting new connections, waits up to
  `MCP_HTTP_SHUTDOWN_TIMEOUT_MS` (default 10000) for
  in-flight requests, then force-closes. SIGINT behaves the
  same. The systemd unit sets `TimeoutStopSec=15` to allow
  the full drain plus a small buffer.

## Port allocation

| App | Default port | Convention |
| --- | --- | --- |
| `mcp-readonly-sql` | 3001 | resource server (per mcp-http-transport) |
| `mcp-oauth-admin` | 3002 | authority (reserved per mcp-http-transport) |
| Future resource server | 3003+ | distinct port per app |

Port `3002` is **reserved for the authority** and MUST NOT be
claimed by any resource-server MCP. A future resource-server
app in `apps/<app-name>/` MUST pick a distinct port (3003,
3004, etc.).

## Rotate keys

### Resource server (HMAC local backend)

The local backend is deprecated; production deployments use
the OAuth admin authority. When the local backend IS in use,
see [Rotate agent keys (HMAC)](#rotate-agent-keys-hmac) under
[mcp-readonly-sql](#mcp-readonly-sql).

### Authority (admin password + signing key)

- **Bootstrap admin password**: see
  [Rotate the bootstrap admin password](#rotate-the-bootstrap-admin-password)
  under [mcp-oauth-admin](#mcp-oauth-admin).
- **OAuth signing key**: see
  [Rotate the OAuth signing key](#rotate-the-oauth-signing-key).

## Read the structured logs

Set `MCP_LOG_FORMAT=json` in the env file for one-line JSON
objects. Every log line carries:

- `ts` (ISO-8601)
- `level` (`info` | `warn` | `error`)
- `msg`
- `agentId` (when an authenticated request is in flight;
  `[REDACTED]` otherwise)
- `requestId` (the `X-Request-Id` header value if the client
  supplied a valid one; a fresh UUID otherwise)

Tail the journal with `journalctl -u mcp-readonly-sql -f` or
`journalctl -u mcp-oauth-admin -f`, and pipe to `jq` for
filtering:

```bash
journalctl -u mcp-oauth-admin -o cat -f | jq -c 'select(.level=="error")'
```

The `text` format (default) writes key=value pairs to stderr;
stdout is reserved for the transport stream in HTTP mode.

## Roll back

### Resource server (revert to stdio)

```env
MCP_TRANSPORT=stdio
systemctl restart mcp-readonly-sql.service
```

The MCP host falls back to spawning the process directly. The
same five tools are still registered; only the transport
changes. No data is lost.

### Authority (decommission without breaking the resource server)

1. Stop the authority: `systemctl stop mcp-oauth-admin.service`.
2. The resource server's `OAuthAdminAuthority` will start
   returning 503 on the next `verify` call (the JWKS fetch
   fails). This is the correct fail-closed behavior; the
   spec requires 503 on authority unreachable.
3. To restore the resource server on the local backend,
   unset `MCP_AUTHORITY_URL` on the resource server and
   restart. The local HMAC roster is preserved as a
   fallback; restore `mcp-readonly-sql.agents.json` from
   the operator's secret store (the spec does NOT ship a
   sample roster file any more).

### Authority (full restoration from backup)

1. Stop the authority: `systemctl stop mcp-oauth-admin.service`.
2. Restore the SQLite file from `MCP_OAUTH_BACKUP_TARGET`:
   ```bash
   systemctl stop mcp-oauth-admin.service
   cp /var/backups/mcp-oauth.sqlite /opt/mcp/oauth/apps/mcp-oauth-admin/data/mcp-oauth.sqlite
   chown mcp:mcp /opt/mcp/oauth/apps/mcp-oauth-admin/data/mcp-oauth.sqlite
   systemctl start mcp-oauth-admin.service
   ```
3. The audit retention sweep is idempotent; restore a
   backup older than 90 days and the sweep will NOT re-delete
   the rows that the operator wants to keep (the sweep
   honours the row's `ts`).

## Sanity checks

### Resource server (mcp-readonly-sql)

- [ ] `systemctl status mcp-readonly-sql.service` is `active
  (running)`.
- [ ] `curl -sS http://127.0.0.1:3001/healthz` returns `200`
  with body `{"status":"ok","authorityBackend":"oauth"}` (or
  `"local"` when the local backend is in use).
- [ ] `journalctl -u mcp-readonly-sql -n 50 -o cat` shows
  the listening address and the bound port.
- [ ] The reverse proxy returns a bearer-intact JSON-RPC
  response to an authorized agent.
- [ ] A POST to `/mcp` with no `Authorization` header
  returns `401` (no JSON-RPC body).
- [ ] A POST to `/mcp` with a valid bearer but out-of-scope
  returns `403`.
- [ ] The deploy-template lint test passes (it greps the
  runbook for common secret patterns — JWT-style prefixes,
  SHA-256 keyHash literals, database connection-string
  prefixes, and bearer-token prefixes — and the runbook MUST
  contain none of them).

### Authority (mcp-oauth-admin)

- [ ] `systemctl status mcp-oauth-admin.service` is `active
  (running)`.
- [ ] `curl -sS http://127.0.0.1:3002/healthz` returns `200`
  with body `{"status":"ok"}` (the authority's `/healthz`).
- [ ] `journalctl -u mcp-oauth-admin -n 50 -o cat` shows
  the listening address and the bound port.
- [ ] The reverse proxy returns `/admin/login` to a browser
  with no session cookie; the admin UI renders.
- [ ] A POST to `/oauth/token` with the bootstrap
  admin's `MCP_OAUTH_ADMIN_PASSWORD` returns
  `400 password_change_required` (the rotation is
  enforced).
- [ ] A POST to `/oauth/introspect` with a valid token
  returns `{"active":true,"sub":"...","scope":"..."}`.
- [ ] The backup target (if `MCP_OAUTH_BACKUP_TARGET` is
  set) is updated on the configured interval.

### Sanity checks (Docker)

- [ ] `docker build -f deploy/docker/Dockerfile
  -t mcp-readonly-sql:latest .` exits `0`.
- [ ] `docker build -f deploy/docker/Dockerfile.mcp-oauth-admin
  -t mcp-oauth-admin:latest .` exits `0`.
- [ ] `docker run --rm -p 3001:3001 --env-file .env
  mcp-readonly-sql:latest` starts; the first
  `docker inspect --format '{{.State.Health.Status}}' <id>`
  becomes `healthy` within 30 s.
- [ ] `docker run --rm -p 3002:3002 --env-file .env
  mcp-oauth-admin:latest` starts; the first
  `docker inspect --format '{{.State.Health.Status}}' <id>`
  becomes `healthy` within 30 s.
- [ ] `docker exec <id> id` shows `uid=1000(node) gid=1000(node)`.

## Docker quick path

```bash
# Build
docker build -f deploy/docker/Dockerfile -t mcp-readonly-sql:latest .
docker build -f deploy/docker/Dockerfile.mcp-oauth-admin -t mcp-oauth-admin:latest .

# Run (mount your real .env; never bake secrets into the image)
docker run --rm \
  --name mcp-readonly-sql \
  -p 127.0.0.1:3001:3001 \
  --env-file /opt/mcp/db/apps/mcp-readonly-sql/.env \
  mcp-readonly-sql:latest

docker run --rm \
  --name mcp-oauth-admin \
  -p 127.0.0.1:3002:3002 \
  --env-file /opt/mcp/oauth/apps/mcp-oauth-admin/.env \
  -v /opt/mcp/oauth/apps/mcp-oauth-admin/data:/app/data \
  mcp-oauth-admin:latest
```

The `mcp-readonly-sql` image sets `MCP_TRANSPORT=streamableHttp`,
`MCP_HTTP_HOST=127.0.0.1`, `MCP_HTTP_PORT=3001`, and
`MCP_HTTP_BEHIND_PROXY=true` by default. Override any of these
with `-e NAME=value` or via `--env-file`.

The `mcp-oauth-admin` image sets `MCP_HTTP_HOST=127.0.0.1`,
`MCP_HTTP_PORT=3002`, and
`MCP_OAUTH_DISABLE_RETENTION_SWEEP=false` by default. The
operator MUST mount `/app/data` (or set `MCP_OAUTH_DB_PATH` to
a persistent path) so the SQLite file survives container
restarts. The `MCP_OAUTH_ADMIN_*` env vars and any
`MCP_OAUTH_BACKUP_*` env vars come from the operator's env.

## What's not in the runbook (and why)

- **Sample tokens, keyHashes, admin passwords, or DB
  credentials.** The repository is public and any literal
  would end up in a future secret scanner's false-positive
  pile. Operators generate their own at deploy time.
- **Cert paths.** The shipped `nginx/mcp.conf` uses standard
  `/etc/ssl/...` paths with a comment showing the operator
  how to generate a self-signed cert for testing or to swap
  in a Let's Encrypt cert for production.
- **Concrete hostnames / IPs.** The proxy example uses
  `127.0.0.1` for the upstream; the `server_name _;` wildcard
  catches any host the operator binds. Replace with your real
  hostname in production.
- **OAuth authorization-code flow.** The OAuth2 flow
  implemented in v1 is `client_credentials` and `password`
  (with `refresh_token`). The `authorization_code` grant is
  Phase 6 (post-`oauth-sqlite-admin-authorization`); see the
  proposal for the migration plan.

## Next step

After the runbook and templates are deployed:

- Run Phase 5 cross-PR verification (HTTP smoke, stdio smoke,
  secret-grep, bypass-grep) — see
  `openspec/changes/oauth-sqlite-admin-authorization/tasks.md`
  → Phase 5.
- `sdd-archive` to sync the delta specs back to the deployed
  baseline.
- For future MCPs, copy `deploy/systemd/`, `deploy/docker/`,
  and the relevant section of `deploy/nginx/mcp.conf` to the
  new app and adjust paths, ports, and the `ExecStart` /
  `ENTRYPOINT` / `proxy_pass` target. The shape of the
  templates is language-agnostic; a Python MCP in
  `apps/<py-app>/` would replace the `node:20-alpine` stages
  with `python:3.12-slim` and the systemd `ExecStart` with
  `uv --project apps/<py-app> run mcp-server`. Future
  resource-server apps MUST pick a distinct port (3003+);
  port 3002 is reserved for the authority.
