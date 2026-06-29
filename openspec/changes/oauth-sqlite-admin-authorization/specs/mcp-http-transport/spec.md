# Delta for mcp-http-transport

## Purpose

Allocate port `3002` to `mcp-oauth-admin` per the Port Allocation Convention. The listener, health, and shutdown guarantees already apply to every HTTP-served MCP, so the authority inherits them. This delta only fixes the port-allocation table.

## ADDED Requirements

### Requirement: Authority Default Port Is 3002

`apps/mcp-oauth-admin/` MUST default to `MCP_HTTP_PORT=3002` and MUST document that default in its `.env.example` and `README.md`. The chosen port MUST be reflected in the deploy templates (systemd `EnvironmentFile`, Dockerfile `EXPOSE`, reverse-proxy `proxy_pass`). Port `3002` MUST NOT be claimed by any future resource-server MCP.

#### Scenario: Authority binds 3002 by default

- GIVEN `apps/mcp-oauth-admin/` with no `MCP_HTTP_PORT` override
- WHEN the operator starts the app
- THEN the listener binds `127.0.0.1:3002`
- AND `GET /healthz` responds `200 ok`.

#### Scenario: Port 3002 documented

- GIVEN `apps/mcp-oauth-admin/.env.example`
- WHEN the operator reads it
- THEN `MCP_HTTP_PORT=3002` is the default value
- AND the comment cross-references `mcp-http-transport` Port Allocation Convention.

#### Scenario: Deploy template targets 3002

- GIVEN `deploy/systemd/mcp-oauth-admin.service` and `deploy/nginx/mcp.conf`
- WHEN the operator inspects the `proxy_pass` and `EnvironmentFile`
- THEN the port is `3002`
- AND no entry references `3001` for the authority.

#### Scenario: No future resource server claims 3002

- GIVEN a future resource-server app under `apps/<app-name>/`
- WHEN the operator inspects its `.env.example`
- THEN the default port is NOT `3002`
- AND a port distinct from `3001` and `3002` is selected.

## MODIFIED Requirements

### Requirement: Port Allocation Convention

To avoid collisions when several MCPs share one host, each app MUST document a default port in its `.env.example` and `README.md`. `mcp-readonly-sql` MUST default to `MCP_HTTP_PORT=3001`. `mcp-oauth-admin` (the authority) MUST default to `MCP_HTTP_PORT=3002`. Future resource-server apps MUST pick distinct ports (e.g., `3003`, `3004`); the chosen port MUST be reflected in the deploy templates for that app. Port `3002` is reserved for the authority and MUST NOT be claimed by any resource-server MCP.

(Previously: the convention reserved `3001` for `mcp-readonly-sql` and named `3002`, `3003` as illustrative future ports. The convention now reserves `3002` for the authority and forbids resource servers from claiming it.)

#### Scenario: No collision across apps

- GIVEN `mcp-readonly-sql` on `3001` and `mcp-oauth-admin` on `3002`
- WHEN both are started on the same host
- THEN both bind successfully
- AND no `EADDRINUSE` error is logged.

#### Scenario: Authority port survives override

- GIVEN `MCP_HTTP_PORT=3102` on the authority
- WHEN the operator starts the app
- THEN the listener binds `127.0.0.1:3102`
- AND the deploy template's `proxy_pass` matches.

## REMOVED Requirements

None.

## RENAMED Requirements

None.
