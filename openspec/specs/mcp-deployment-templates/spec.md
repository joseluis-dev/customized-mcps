# mcp-deployment-templates Specification

## Purpose

Defines the operational templates — systemd unit, Dockerfile, reverse proxy example, and runbook — that ship with this change for the first MCP and that future MCPs in this workspace MUST adopt. Templates are infrastructure, not code; the contract here lets operators deploy any MCP app in this workspace consistently.

## Requirements

### Requirement: Environment File Is Single Source Of Truth

`.env.example` inside the app MUST list every env var the app reads at startup, including the new `MCP_TRANSPORT`, `MCP_HTTP_*`, `MCP_AGENTS_*`, and `MCP_LOG_FORMAT` variables. Operational templates (systemd `EnvironmentFile`, Docker `--env-file`, reverse proxy passthrough) MUST reference the same variable names; no template is allowed to introduce a new variable name that is not documented in `.env.example`. A CI lint step SHOULD fail the PR if any template references an undocumented variable.

#### Scenario: Template references documented var

- GIVEN the systemd unit sets `EnvironmentFile=/etc/mcp/mcp-readonly-sql.env`
- WHEN the lint step greps the unit for env var names
- THEN every referenced name appears in `apps/mcp-readonly-sql/.env.example`.

#### Scenario: Undocumented var rejected

- GIVEN a template that references `MCP_HTTP_FOO`
- WHEN the lint step greps `.env.example`
- THEN the build fails with a message naming `MCP_HTTP_FOO`.

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

### Requirement: Production TLS Boundary

Production TLS MUST terminate at the existing reverse proxy layer, NOT inside the MCP app. The runbook MUST state this explicitly. The app MUST NOT ship its own certificate, private key, or TLS configuration in v1. The `MCP_HTTP_BEHIND_PROXY=true` opt-in (from `mcp-http-transport`) is the operator's explicit acknowledgement of this boundary.

#### Scenario: No TLS in app

- GIVEN the app's source tree
- WHEN an operator greps for `tls`, `https.createServer`, or `cert`
- THEN no matches appear in `packages/mcp-http-base/` or `apps/<app>/src/`.

#### Scenario: Runbook states the boundary

- GIVEN `deploy/README.md`
- WHEN the operator reads the "Production" section
- THEN it states that TLS terminates at the existing reverse proxy
- AND it names the proxy that is in scope.

### Requirement: Dev/Staging Without TLS

When an operator runs the app without a reverse proxy in dev or staging, the runbook MUST instruct them to set `MCP_HTTP_HOST=127.0.0.1` (the default) OR to set `MCP_HTTP_ALLOW_INSECURE_LOOPBACK=true` explicitly when binding to a non-loopback address. The runbook MUST include a prominent warning that any token transmitted over plain HTTP in non-production environments can be captured by anyone on the network.

#### Scenario: Loopback only

- GIVEN dev/staging with no proxy
- WHEN the operator uses default `MCP_HTTP_HOST=127.0.0.1`
- THEN the app binds the loopback interface only
- AND no insecure-loopback warning is printed.

#### Scenario: Explicit opt-in

- GIVEN dev/staging with `MCP_HTTP_HOST=0.0.0.0` and `MCP_HTTP_ALLOW_INSECURE_LOOPBACK=true`
- WHEN the app starts
- THEN the warning is printed
- AND the runbook cross-references the env var.

### Requirement: Runbook Contents

`deploy/README.md` MUST be the operator runbook for this change. It MUST cover at minimum: production deployment via the existing reverse proxy, dev/staging deployment without TLS, where env vars are loaded from, how to rotate agent keys, how to read the structured JSON logs, how to interpret `/healthz` and shutdown, and how to roll back to `MCP_TRANSPORT=stdio` if the HTTP path is unstable. The runbook MUST NOT contain DB credentials, sample tokens, or any secret.

#### Scenario: Runbook covers rotation

- GIVEN `deploy/README.md`
- WHEN the operator searches for "rotate"
- THEN the section names `MCP_AGENTS_JSON` and the reload procedure.

#### Scenario: Runbook covers rollback

- GIVEN `deploy/README.md`
- WHEN the operator searches for "rollback" or "stdio"
- THEN the section explains reverting `MCP_TRANSPORT=stdio` in the env file and restarting the unit.

#### Scenario: No secrets in runbook

- GIVEN `deploy/README.md`
- WHEN an automated scanner greps for `password`, `token`, `keyHash`, or `Bearer ` literals
- THEN no real or sample secrets are present.

### Requirement: Language-Agnostic Templates

Templates (systemd, Docker, nginx) MUST be authored so a future Python MCP in `apps/<py-app>/` can adopt them by copying the file and changing the `ExecStart` / `ENTRYPOINT` / `proxy_pass` target. The specs above MUST NOT depend on TypeScript-specific tools or build outputs in a way that blocks the Python path. A future change MAY add a per-app generator; v1 ships copy-pasteable templates.

#### Scenario: Python app reuses Dockerfile shape

- GIVEN a future `apps/mcp-write-audit` Python app
- WHEN the operator copies `deploy/docker/Dockerfile` and replaces the Node stage with a `python:3.12-slim` stage
- THEN the resulting image builds and runs
- AND `/healthz` works the same way.

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
