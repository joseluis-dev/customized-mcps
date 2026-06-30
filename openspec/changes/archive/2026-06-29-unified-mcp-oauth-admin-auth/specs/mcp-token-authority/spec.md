# Delta for mcp-token-authority

## ADDED Requirements

### Requirement: Resource Server Public Base URL

`@customized-mcps/mcp-http-base` MUST read a public base URL for the resource server (e.g. `MCP_RESOURCE_SERVER_URL` or an equivalent config) used to build absolute URLs for resource metadata. When unset, the server MUST fall back to the request's `Host` header (and matching scheme) to construct the base URL. The base URL MUST NOT default to `MCP_AUTHORITY_URL` because the resource server and authorization server are separate origins.

#### Scenario: Explicit base URL honored

- GIVEN `MCP_RESOURCE_SERVER_URL=https://mcp.example.com`
- WHEN the resource server builds the `resource_metadata` URL or the protected resource metadata `resource` field
- THEN the value uses the configured base URL.

#### Scenario: Fallback to request host

- GIVEN no explicit `MCP_RESOURCE_SERVER_URL`
- WHEN a metadata URL is built for an incoming request
- THEN the URL uses the request's `Host` header and matching scheme.

### Requirement: RFC 9728 Protected Resource Metadata

`GET /.well-known/oauth-protected-resource` MUST return JSON with at least `resource`, `authorization_servers`, `bearer_methods_supported: ["header"]`, and `scopes_supported` (derived from the `scopes` catalog) per RFC 9728. `authorization_servers` MUST contain the `mcp-oauth-admin` issuer URL (from `MCP_AUTHORITY_URL`), NOT the resource server's own base URL. The `resource` field MUST be the resource server's own public base URL.

#### Scenario: Happy path discovery

- GIVEN the resource server is up and `MCP_AUTHORITY_URL` is set
- WHEN a client calls `GET /.well-known/oauth-protected-resource`
- THEN the response is `200` JSON with `resource` = the resource server's public base URL
- AND `authorization_servers` = `["<MCP_AUTHORITY_URL>"]`
- AND `bearer_methods_supported` = `["header"]`
- AND `scopes_supported` is a non-empty array of catalog scopes.

### Requirement: WWW-Authenticate Resource Metadata on 401

Every `401` returned by the resource server for an unauthenticated or invalid-token request MUST include a `WWW-Authenticate: Bearer resource_metadata="<url>"` header per RFC 6750 §3 and RFC 9728 §5.1. The `resource_metadata` URL MUST be the resource server's own protected resource metadata URL (e.g. `<resource-server-base>/.well-known/oauth-protected-resource`), NOT the authorization server issuer URL. The header MAY also include `scope` per RFC 6750 §3. The 401 body MUST remain sanitized per the existing audit-safe contract.

#### Scenario: 401 includes resource_metadata header

- GIVEN a request to a protected resource with no/invalid bearer token
- WHEN the resource server responds `401`
- THEN the response includes `WWW-Authenticate: Bearer resource_metadata="<resource-server-base>/.well-known/oauth-protected-resource"`
- AND the `resource_metadata` URL points to the resource server itself, not the authority.

#### Scenario: 401 body remains audit-safe

- GIVEN a `401` response
- WHEN the response body is inspected
- THEN it matches the existing sanitized `401` shape (no token, no `kid`, no agent id, no authority URL, no JWKS URL).

### Requirement: Typecheck Gate

`pnpm --filter mcp-http-base typecheck` and `pnpm --filter mcp-readonly-sql typecheck` MUST both exit `0` after the changes are applied.

#### Scenario: Typecheck passes

- GIVEN the new resource metadata, base URL, and `WWW-Authenticate` changes
- WHEN `pnpm --filter mcp-http-base typecheck` and `pnpm --filter mcp-readonly-sql typecheck` are run
- THEN both commands exit `0`.
