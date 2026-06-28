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

The repo MUST ship `deploy/systemd/<app-name>.service` as a template. The unit MUST run `node dist/index.js` from the app's own directory, MUST read env from `/etc/mcp/<app-name>.env`, MUST restart on failure with a backoff, MUST run as a dedicated unprivileged user, and MUST set `WorkingDirectory` to the app's install path. The unit MUST be valid per `systemd-analyze verify`.

#### Scenario: Unit verifies

- GIVEN `deploy/systemd/mcp-readonly-sql.service`
- WHEN the operator runs `systemd-analyze verify deploy/systemd/mcp-readonly-sql.service`
- THEN the command exits `0`.

#### Scenario: Restart on failure

- GIVEN the unit is enabled and the process exits non-zero
- WHEN systemd observes the exit
- THEN the unit restarts the process with a backoff
- AND a journal log records the restart.

#### Scenario: Dedicated unprivileged user

- GIVEN the unit declares `User=mcp` and `Group=mcp`
- WHEN the unit starts
- THEN the process runs as that user
- AND the user has no interactive shell.

### Requirement: Dockerfile

The repo MUST ship a multi-stage `deploy/docker/Dockerfile` per app. The runtime stage MUST use `node:20-alpine`, MUST create a non-root user, MUST copy only the app's `dist/`, `package.json`, and lockfile (no `src/`, no `test/`), MUST set `USER` to the non-root user, and MUST include a `HEALTHCHECK` that hits `/healthz`. The image MUST build with `docker build` and the resulting container MUST start and respond `200` on `GET /healthz`.

#### Scenario: Build succeeds

- GIVEN `deploy/docker/Dockerfile` and the app's build artifact
- WHEN the operator runs `docker build -f deploy/docker/Dockerfile apps/mcp-readonly-sql`
- THEN the command exits `0`
- AND a tagged image is produced.

#### Scenario: Healthcheck passes

- GIVEN the container is running with `MCP_TRANSPORT=streamableHttp`
- WHEN the operator curls `http://127.0.0.1:<port>/healthz`
- THEN the response is `200` with body `ok`.

#### Scenario: Non-root user

- GIVEN the running container
- WHEN the operator runs `docker exec <id> id`
- THEN the uid is non-zero
- AND the user has no shell.

### Requirement: Reverse Proxy Example

The repo MUST ship `deploy/nginx/mcp.conf` as an example. The example MUST terminate TLS at the proxy, MUST `proxy_pass` to `http://127.0.0.1:<app-port>`, MUST preserve the `Authorization` header (and other request headers), and MUST set reasonable proxy timeouts aligned with `MCP_HTTP_SHUTDOWN_TIMEOUT_MS`. The example MUST be valid per `nginx -t`. A Caddy example MAY ship alongside; if it does, it MUST satisfy the same requirements.

The reverse proxy MUST also enforce a request body-size cap, because the shared HTTP base in v1 returns `411 Length Required` for requests that lack a `Content-Length` header (chunked transfer-encoded requests) and the only safe place to cap a chunked body is the proxy layer. The example MUST set `client_max_body_size` (nginx) or the equivalent for the chosen proxy to a value consistent with the app's `maxBodyBytes`. Operators that opt in to `MCP_HTTP_ALLOW_UNBOUNDED_BODY=true` MUST confirm the proxy cap is in place; the app logs a one-shot warning on the first chunked request to make the missing cap visible.

#### Scenario: Proxy caps request body

- GIVEN the reverse proxy in front of the app
- WHEN a client posts a 10 MiB body to `/mcp` and the proxy `client_max_body_size` is 1 MiB
- THEN the proxy returns `413 Request Entity Too Large` BEFORE the request reaches the app
- AND the app never sees the oversized body.

#### Scenario: Proxy config validates

- GIVEN `deploy/nginx/mcp.conf`
- WHEN the operator runs `nginx -t -c deploy/nginx/mcp.conf`
- THEN the command exits `0`.

#### Scenario: Authorization header preserved

- GIVEN the proxy is in front of the app
- WHEN a client sends a request with `Authorization: Bearer <token>`
- THEN the app receives the header intact
- AND a tool call from a valid agent succeeds.

#### Scenario: TLS terminates at proxy

- GIVEN the proxy configuration
- WHEN the operator inspects it
- THEN `ssl_certificate` and `listen 443 ssl` are present
- AND the upstream `proxy_pass` is plain HTTP to `127.0.0.1`.

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
