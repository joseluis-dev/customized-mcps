# mcp-readonly-sql — Operator Runbook

> **This runbook covers the operational surface for `mcp-readonly-sql` in HTTP mode.** It complements the developer-facing [`apps/mcp-readonly-sql/README.md`](../../apps/mcp-readonly-sql/README.md). For implementation details, see [`openspec/changes/dedicated-mcp-server-deployment/`](../../openspec/changes/dedicated-mcp-server-deployment/).

The templates in this directory (`systemd/`, `docker/`, `nginx/`) ship with the repo. Operators may copy, modify, and redeploy them; the contract is in [`specs/mcp-deployment-templates/spec.md`](../../openspec/changes/dedicated-mcp-server-deployment/specs/mcp-deployment-templates/spec.md).

## TL;DR

- **Production**: deploy `mcp-readonly-sql.service` behind your existing reverse proxy; TLS terminates at the proxy, never in the app.
- **Dev / staging**: bind `MCP_HTTP_HOST=127.0.0.1` and skip the proxy. Plain HTTP in a trusted network is fine; never expose it publicly.
- **Rollback**: set `MCP_TRANSPORT=stdio` in the env file and restart.

## Quick path (production)

1. Build the app on the host: `pnpm --filter mcp-readonly-sql build`.
2. Copy `dist/`, `package.json`, and `pnpm-lock.yaml` to the install path (default `/opt/mcp/db/apps/mcp-readonly-sql`).
3. Create the unprivileged user: `useradd --system --no-create-home --shell /sbin/nologin mcp`.
4. Create the env file at `/opt/mcp/db/apps/mcp-readonly-sql/.env` (use `apps/mcp-readonly-sql/.env.example` as the template).
5. Install the systemd unit: `cp deploy/systemd/mcp-readonly-sql.service /etc/systemd/system/` then `systemctl daemon-reload`.
6. Start it: `systemctl enable --now mcp-readonly-sql.service`.
7. Validate: `curl -sS http://127.0.0.1:3001/healthz` returns `200` with body `{"status":"ok","authorityBackend":"local"}` (the `authorityBackend` field is `"jwks"` when `MCP_AUTHORITY_URL` is set).
8. Front it with the proxy in [`deploy/nginx/mcp.conf`](nginx/mcp.conf) (or your existing reverse proxy — the spec only requires nginx or an equivalent; a Caddy example is welcome as a follow-up).

## Production deployment (reverse proxy)

> **TLS terminates at the existing reverse proxy. The app serves plain HTTP only.** The example in [`nginx/mcp.conf`](nginx/mcp.conf) is a complete, standalone nginx config. Copy the `server { ... }` block into your existing `http { ... }` if you already have a system nginx.

The proxy MUST:

1. **Enforce a body-size cap** (`client_max_body_size 1m;` in nginx). The shared HTTP base returns `411 Length Required` for chunked bodies by default, so the cap is the only place a chunked upload is bounded. Operators that opt in to `MCP_HTTP_ALLOW_UNBOUNDED_BODY=true` MUST also confirm this cap is in place — the app logs a one-shot warning on the first chunked request to make the missing cap visible.
2. **Preserve the Authorization header** (`proxy_set_header Authorization $http_authorization;` in nginx). The shared base does HMAC validation on the bearer token; the header MUST reach the app verbatim. Removing this line breaks auth; setting it to a static value breaks multi-agent isolation.
3. **Not load-balance** across multiple upstream instances. The app is single-process; horizontal scale is the host's job (one service unit per host, distinct ports).
4. **Allow `/healthz` through unauthenticated**. The probe returns `200` with body `{"status":"ok","authorityBackend":"local"}` (or `{"authorityBackend":"jwks"}` when the JWKS backend is selected) when the app is ready, and `503` with body `{"status":"unhealthy"|"shutting-down","authorityBackend":"local"}` on shutdown / factory failure. The probe MUST be reachable from the orchestrator (Kubernetes liveness/readiness, load balancer health check, etc.).

Set `MCP_HTTP_BEHIND_PROXY=true` in the env file so the app accepts the non-loopback binding that the proxy terminates onto.

## Dev / staging without TLS

When running outside a reverse proxy, bind the loopback only:

```env
MCP_HTTP_HOST=127.0.0.1   # default; loopback only
MCP_TRANSPORT=streamableHttp
```

If you need to bind a non-loopback address (e.g., a shared dev VM), you MUST opt in explicitly:

```env
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_ALLOW_INSECURE_BIND=true   # explicit acknowledgement that TLS is the operator's responsibility
```

> **Warning**: any token transmitted over plain HTTP can be captured by anyone on the network. Use the loopback default whenever possible.

## Configuration: where env vars come from

The single source of truth is [`apps/mcp-readonly-sql/.env.example`](../../apps/mcp-readonly-sql/.env.example). The app reads it via dotenv at startup, and the systemd `EnvironmentFile` directive points systemd at the same file. The Docker image copies `.env.example` for operator reference; the operator mounts their own `.env` (or passes `--env-file`).

The proxy config does NOT reference any `MCP_*` or `DB_*` env var — it sets TLS / proxy behavior statically. The only piece of cross-cutting config is the upstream `proxy_pass http://127.0.0.1:3001;` (port 3001 is the app's `MCP_HTTP_PORT` default).

| Group | Vars | Source |
| --- | --- | --- |
| Transport | `MCP_TRANSPORT` | `.env` (or `.env.example` for defaults) |
| HTTP listener | `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_HTTP_PATH`, `MCP_HTTP_STATELESS`, `MCP_HTTP_SHUTDOWN_TIMEOUT_MS`, `MCP_HTTP_MAX_BODY_BYTES`, `MCP_HTTP_ALLOW_UNBOUNDED_BODY`, `MCP_LOG_FORMAT`, `MCP_HTTP_BEHIND_PROXY`, `MCP_HTTP_ALLOW_INSECURE_BIND` | `.env` |
| Agent auth (local) | `MCP_AGENT_HMAC_SECRET`, `MCP_AGENTS_JSON` or `MCP_AGENTS_INLINE` | `.env` (HMAC secret) + JSON file or inline string |
| Agent auth (JWKS authority) | `MCP_AUTHORITY_URL`, `MCP_AUTHORITY_AUDIENCE`, `MCP_AUTHORITY_JWKS_URL`, `MCP_AUTHORITY_JWKS_TTL_S`, `MCP_AUTHORITY_LEEWAY_S`, `MCP_AUTHORITY_FETCH_TIMEOUT_MS` | `.env` |
| DB profiles | `DB_PROFILES`, `DB_<NAME>_*` | `.env` (with optional file-backed secrets) |
| Safety limits | `MAX_ROWS_DEFAULT`, `MAX_ROWS_HARD_LIMIT`, `QUERY_TIMEOUT_MS_DEFAULT`, `QUERY_TIMEOUT_MS_HARD_LIMIT` | `.env` |

## Choose your backend

The app supports two token-verification backends. The selection is driven by a single env var (`MCP_AUTHORITY_URL`); the local backend is the unset-env default, the JWKS backend is the recommended default for production and shared deployments.

| Backend | Selected when | When to use | Token shape | Roster |
| --- | --- | --- | --- | --- |
| **Local HMAC roster** (`LocalRosterAuthority`) | `MCP_AUTHORITY_URL` is **unset** | Dev / offline / single-host deployments without a shared authority | Opaque bearer (HMAC compared against `MCP_AGENTS_JSON`) | `MCP_AGENTS_JSON` or `MCP_AGENTS_INLINE` |
| **External JWKS authority** (`JwksAuthority`) | `MCP_AUTHORITY_URL` is **set** | Production / shared deployments with a sibling authority MCP or third-party IdP | RS256/ES256 JWT (signature verified against the authority's JWKS) | Owned by the authority; not required on the app side |

The selection is deterministic and is reflected in `GET /healthz` via the `authorityBackend` field (`"local"` or `"jwks"`). Switch backends by setting or unsetting `MCP_AUTHORITY_URL` and restarting the service — no other config change is required. The same MCP tools, the same scopes, and the same `SCOPE_PATTERN` apply to both backends; the wire contract on the resource-server side is unchanged.

The full contract for the JWKS backend (JWKS fetch + cache, claim validation, kid-miss refetch, fail-closed 503 on authority unreachable) is defined in [`openspec/specs/mcp-token-authority/spec.md`](../../openspec/changes/external-token-authority-verification/specs/mcp-token-authority/spec.md).

The local backend is **dev/offline only**. Operators deploying a shared or production environment MUST use the JWKS backend. The local backend is preserved because it keeps the dev loop fast (no need to stand up a sibling authority) and because it is the v1 contract — the operator's existing `.agents.local.json` keeps working without any change.

## Health probe and graceful shutdown

- `GET /healthz` returns `200` with body `{"status":"ok","authorityBackend":"local"}` when the app is ready to serve (the `authorityBackend` field is `"jwks"` when `MCP_AUTHORITY_URL` is set, per the `mcp-token-authority` spec). On shutdown or factory failure the response is `503` with body `{"status":"shutting-down"|"unhealthy","authorityBackend":"local"}`. The endpoint is unauthenticated; the reverse proxy MUST allow it through.
- The `authorityBackend` field is the audit-safe label that lets operators and orchestrators confirm the selected backend without grepping the env file. The body MUST NOT include the authority URL, the JWKS URL, the token, or the `kid` — only the `status` + `authorityBackend` pair.
- SIGTERM triggers a graceful drain: the app stops accepting new connections, waits up to `MCP_HTTP_SHUTDOWN_TIMEOUT_MS` (default 10000) for in-flight requests, then force-closes. SIGINT behaves the same. The systemd unit sets `TimeoutStopSec=15` to allow the full drain plus a small buffer.

## Port reservation for the future authority MCP

If a sibling authority MCP is added to this workspace later, it MUST use port `3002` per the `mcp-http-transport` Port Allocation Convention. The reservation is documented in the future authority MCP's `.env.example` and `deploy/README.md`; the `mcp-readonly-sql` app (port 3001 by default) and the future authority MCP (port 3002) are designed to coexist on the same host behind a single reverse proxy.

## Rotate agent keys (HMAC)

1. Generate a new `MCP_AGENT_HMAC_SECRET` (at least 32 bytes of entropy):
   `openssl rand -hex 32`. Store it in the env file.
2. For every agent in `MCP_AGENTS_JSON`, recompute the `keyHash` with the new secret:
   ```bash
   echo -n "<new-bearer-token>" | openssl dgst -sha256 -hmac "<new-secret>" | awk '{print $2}'
   ```
3. Replace the `keyHash` field in `MCP_AGENTS_JSON` (or in the `MCP_AGENTS_INLINE` JSON string) with the new 64-character hex digest.
4. Restart the service: `systemctl restart mcp-readonly-sql.service`.
5. Hand the new bearer token to the corresponding agent out of band.

The old bearer tokens are immediately invalid. Operators that want zero downtime can pre-provision the new keyHashes before rotating the secret (use `MCP_AGENTS_INLINE` as a staging path, then promote to `MCP_AGENTS_JSON` once verified).

## Read the structured logs

Set `MCP_LOG_FORMAT=json` in the env file for one-line JSON objects. Every log line carries:

- `ts` (ISO-8601)
- `level` (`info` | `warn` | `error`)
- `msg`
- `agentId` (when an authenticated request is in flight; `[REDACTED]` otherwise)
- `requestId` (the `X-Request-Id` header value if the client supplied a valid one; a fresh UUID otherwise)

Tail the journal with `journalctl -u mcp-readonly-sql -f` and pipe to `jq` for filtering:

```bash
journalctl -u mcp-readonly-sql -o cat -f | jq -c 'select(.level=="error")'
```

The `text` format (default) writes key=value pairs to stderr; stdout is reserved for the transport stream in HTTP mode.

## Health probe and graceful shutdown

The full health-probe contract (response shape, `authorityBackend` field, audit-safe body) is documented in the [Health probe and graceful shutdown](#health-probe-and-graceful-shutdown) section above. The block here is a short reminder that the probe is unauthenticated and drains on SIGTERM.

- `GET /healthz` is unauthenticated; the reverse proxy MUST allow it through. SIGTERM triggers a graceful drain: the app stops accepting new connections, waits up to `MCP_HTTP_SHUTDOWN_TIMEOUT_MS` (default 10000) for in-flight requests, then force-closes. SIGINT behaves the same. The systemd unit sets `TimeoutStopSec=15` to allow the full drain plus a small buffer.

## Roll back to stdio

If the HTTP path is unstable, revert the env file:

```env
MCP_TRANSPORT=stdio
```

then restart:

```bash
systemctl restart mcp-readonly-sql.service
```

The MCP host falls back to spawning the process directly. The same five tools are still registered; only the transport changes. No data is lost.

## Sanity checks

- [ ] `systemctl status mcp-readonly-sql.service` is `active (running)`.
- [ ] `curl -sS http://127.0.0.1:3001/healthz` returns `200` with body `{"status":"ok","authorityBackend":"local"}`.
- [ ] `journalctl -u mcp-readonly-sql -n 50 -o cat` shows the listening address and the bound port.
- [ ] The reverse proxy returns a bearer-intact JSON-RPC response to an authorized agent.
- [ ] A POST to `/mcp` with no `Authorization` header returns `401` (no JSON-RPC body).
- [ ] A POST to `/mcp` with a valid bearer but out-of-scope returns `403`.
- [ ] The deploy-template lint test passes (it greps the runbook for common secret patterns — JWT-style prefixes, SHA-256 keyHash literals, database connection-string prefixes, and bearer-token prefixes — and the runbook MUST contain none of them).

## Sanity checks (Docker)

- [ ] `docker build -f deploy/docker/Dockerfile -t mcp-readonly-sql:latest .` exits `0`.
- [ ] `docker run --rm -p 3001:3001 --env-file .env mcp-readonly-sql:latest` starts; the first `docker inspect --format '{{.State.Health.Status}}' <id>` becomes `healthy` within 30 s.
- [ ] `docker exec <id> id` shows `uid=1000(node) gid=1000(node)`.
- [ ] `docker exec <id> sh -c 'echo $NODE_ENV'` returns empty (the image sets only the four spec'd `MCP_*` env vars; no Node conventions leak in).

## Docker quick path

```bash
# Build
docker build -f deploy/docker/Dockerfile -t mcp-readonly-sql:latest .

# Run (mount your real .env; never bake secrets into the image)
docker run --rm \
  --name mcp-readonly-sql \
  -p 127.0.0.1:3001:3001 \
  --env-file /opt/mcp/db/apps/mcp-readonly-sql/.env \
  mcp-readonly-sql:latest
```

The image sets `MCP_TRANSPORT=streamableHttp`, `MCP_HTTP_HOST=127.0.0.1`, `MCP_HTTP_PORT=3001`, and `MCP_HTTP_BEHIND_PROXY=true` by default. Override any of these with `-e NAME=value` or via `--env-file`.

## What's not in the runbook (and why)

- **Sample tokens, keyHashes, or DB credentials.** The repository is public and any literal would end up in a future secret scanner's false-positive pile. Operators generate their own at deploy time.
- **Cert paths.** The shipped `nginx/mcp.conf` uses standard `/etc/ssl/...` paths with a comment showing the operator how to generate a self-signed cert for testing or to swap in a Let's Encrypt cert for production.
- **Concrete hostnames / IPs.** The proxy example uses `127.0.0.1` for the upstream; the `server_name _;` wildcard catches any host the operator binds. Replace with your real hostname in production.

## Next step

After the runbook and templates are deployed:

- Run Phase 4 cross-PR verification (HTTP smoke, stdio smoke, secret-grep, bypass-grep) — see `openspec/changes/dedicated-mcp-server-deployment/tasks.md` → Phase 4.
- `sdd-archive` to sync the delta specs back to the deployed baseline.
- For future MCPs, copy `deploy/systemd/`, `deploy/docker/`, and `deploy/nginx/` to the new app and adjust paths, ports, and the `ExecStart` / `ENTRYPOINT` / `proxy_pass` target. The shape of the templates is language-agnostic; a Python MCP in `apps/<py-app>/` would replace the `node:20-alpine` stages with `python:3.12-slim` and the systemd `ExecStart` with `uv --project apps/<py-app> run mcp-server`.
