# Delta for mcp-deployment-templates

## Purpose

Convert the runbook from a single-app document to a multi-app, indexed runbook covering the resource-server MCP (`mcp-readonly-sql`) and the authority MCP (`mcp-oauth-admin`). Env-var vocabulary, TLS boundary, and secret-scrub rules are unchanged.

## ADDED Requirements

### Requirement: Indexed Runbook With One Section Per App

`deploy/README.md` MUST be a multi-app, indexed runbook. The top MUST contain a table of contents with one anchored section per MCP app, including the authority. Each app section MUST cover: production deployment via the existing reverse proxy, dev/staging deployment without TLS, env file path, credential rotation, structured JSON logs, `/healthz` and shutdown, and rollback. Shared sections MAY live above the per-app index; per-app variations MUST live inside the per-app section.

#### Scenario: TOC, rotation, rollback, no secrets

- GIVEN `deploy/README.md`
- WHEN the operator reads the top, searches for "rotate", searches for "rollback" or "stdio", and a scanner greps for `password`/`token`/`keyHash`/`Bearer `
- THEN the TOC lists at least `[mcp-readonly-sql]` and `[mcp-oauth-admin]`, the authority section names the bootstrap admin rotation, the resource-server section explains reverting `MCP_TRANSPORT=stdio`, and no secrets are found.

### Requirement: Per-App Env File And Per-App EnvironmentFile

The env file path `/etc/mcp/<app-name>.env` is per-app, created by the operator at install time, and referenced from the systemd `EnvironmentFile=` directive of the per-app unit. The `.env.example` inside each app's directory is the single source of truth.

#### Scenario: Per-app env file path

- GIVEN `mcp-readonly-sql` and `mcp-oauth-admin` deployed on one host
- WHEN the operator inspects `/etc/mcp/`
- THEN the directory contains `mcp-readonly-sql.env` and `mcp-oauth-admin.env` and each unit references its own `EnvironmentFile`.

## MODIFIED Requirements

### Requirement: Systemd Unit

The repo MUST ship `deploy/systemd/<app-name>.service` as a template for every MCP app in the workspace, including the authority. The unit runs the app's own entrypoint from the app's own directory, reads env from `/etc/mcp/<app-name>.env`, restarts on failure with a backoff, runs as a dedicated unprivileged user, and sets `WorkingDirectory` to the app's install path. The unit MUST be valid per `systemd-analyze verify`.

(Previously: the requirement named a single unit per repo. The repo now ships one unit per app.)

#### Scenario: Units verify, restart, run unprivileged

- GIVEN `deploy/systemd/mcp-oauth-admin.service` and `deploy/systemd/mcp-readonly-sql.service`
- WHEN the operator runs `systemd-analyze verify` on each, the process exits non-zero, and the unit declares `User=mcp` / `Group=mcp`
- THEN both exit `0`, the unit restarts with a journal log, and the user has no interactive shell.

### Requirement: Dockerfile

The repo MUST ship a multi-stage `deploy/docker/Dockerfile.<app-name>` per app, including the authority. The runtime stage uses `node:20-alpine` (or the language-appropriate base for future Python apps), creates a non-root user, copies only the app's built artifact and manifest/lockfile, sets `USER` to the non-root user, and includes a `HEALTHCHECK` that hits `/healthz`. The image MUST build with `docker build` and the resulting container MUST respond `200` on `GET /healthz`.

(Previously: the requirement named a single Dockerfile per repo. The repo now ships one Dockerfile per app.)

#### Scenario: Build and healthcheck

- GIVEN `deploy/docker/Dockerfile.mcp-oauth-admin` and `deploy/docker/Dockerfile.mcp-readonly-sql`
- WHEN the operator builds each and the authority container is running
- THEN both exit `0` and the authority container responds `200` on `http://127.0.0.1:3002/healthz`.

### Requirement: Reverse Proxy Example

The repo MUST ship `deploy/nginx/mcp.conf` as an example that covers every app. The example terminates TLS at the proxy, `proxy_pass`es to `http://127.0.0.1:<app-port>` for each app (resource servers on `3001`; the authority on `3002`), preserves the `Authorization` header, and sets proxy timeouts aligned with `MCP_HTTP_SHUTDOWN_TIMEOUT_MS`. The example MUST be valid per `nginx -t` and MUST enforce a request body-size cap.

(Previously: the example assumed a single app. The example is now a multi-app snippet.)

#### Scenario: Validates and proxies both apps

- GIVEN `deploy/nginx/mcp.conf`
- WHEN the operator runs `nginx -t -c deploy/nginx/mcp.conf` and an admin's browser loads `/admin/`
- THEN the command exits `0`, `proxy_pass` entries target `127.0.0.1:3001` and `127.0.0.1:3002`, and the authority's `/admin/` is reachable through the proxy.

## REMOVED Requirements

None.
