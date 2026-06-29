# Delta for app-independence

## Purpose

Append an `Authority Isolation` requirement so a future HTTP-served MCP app never imports from, depends on, or symlinks to `apps/mcp-oauth-admin/`. The authority is a peer app; resource servers consume only the wire contract from `mcp-oauth-authority` and the verification contract from `mcp-token-authority`.

## ADDED Requirements

### Requirement: Authority Isolation

`apps/mcp-oauth-admin/` is a peer app, not a shared package. A resource-server app under `apps/<app-name>/` MUST NOT import from `apps/mcp-oauth-admin/src/`, MUST NOT add it as a workspace dependency, and MUST NOT symlink to it. The resource server MAY import from `@customized-mcps/mcp-http-base`; it MUST NOT import the authority's templates, UI, DB layer, or OAuth handlers directly. The authority MAY depend on shared packages; the resource server MUST NOT depend on the authority.

#### Scenario: No app-to-app import

- GIVEN any resource-server app under `apps/<app-name>/src/`
- WHEN the operator greps for imports referencing `apps/mcp-oauth-admin` or `mcp-oauth-admin/`
- THEN no matches exist.

#### Scenario: No workspace dependency on authority

- GIVEN any resource-server app's `package.json` (or `pyproject.toml`)
- WHEN the operator inspects the `dependencies` field
- THEN no entry references `mcp-oauth-admin` as a workspace package.

#### Scenario: No symlink to authority

- GIVEN any resource-server app's build artifact
- WHEN the operator inspects it for symlinks
- THEN no symlink points to `apps/mcp-oauth-admin/`.

#### Scenario: Authority may depend on shared base

- GIVEN `apps/mcp-oauth-admin/package.json`
- WHEN the operator inspects the `dependencies` field
- THEN shared packages like `@customized-mcps/mcp-http-base` MAY be listed
- AND no resource-server app is listed.

### Requirement: Per-App Deploy Templates Are Authoritative

The `mcp-deployment-templates` runbook MUST ship one per-app indexed section per MCP app, including the authority. A future resource-server app MUST get its own systemd unit, Dockerfile, and reverse-proxy snippet; the authority MUST get its own variants. Templates MUST NOT be shared across apps; the only shared element is the env-var vocabulary (the `.env.example` lint rule from `mcp-deployment-templates` still applies).

#### Scenario: Authority has its own systemd unit

- GIVEN `deploy/systemd/mcp-oauth-admin.service`
- WHEN the operator inspects the unit
- THEN `ExecStart` runs the authority's entrypoint
- AND `WorkingDirectory` points to `apps/mcp-oauth-admin/`
- AND `EnvironmentFile=/etc/mcp/mcp-oauth-admin.env`.

#### Scenario: Resource server has its own Dockerfile

- GIVEN `deploy/docker/Dockerfile.mcp-readonly-sql`
- WHEN the operator builds it
- THEN only the resource server's `dist/` is copied
- AND no copy step references `apps/mcp-oauth-admin/`.

#### Scenario: Runbook index lists every app

- GIVEN `deploy/README.md`
- WHEN the operator reads the TOC
- THEN each MCP app (resource servers and the authority) has its own anchored section.

## MODIFIED Requirements

None.

## REMOVED Requirements

None.

## RENAMED Requirements

None.
