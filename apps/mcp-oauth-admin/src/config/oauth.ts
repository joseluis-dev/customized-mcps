/**
 * OAuth configuration loader for the `mcp-oauth-admin` app.
 *
 * Centralizes the env-to-config mapping for the issuer + the
 * `protected_resources` allowlist. The shared `mcp-http-base` package
 * already owns the listener / host / port / log-format parsing; this
 * module only adds the OAuth-specific contract:
 *
 *   - `MCP_AUTHORITY_URL` is REQUIRED when the app is enabled. The
 *     value is the canonical issuer advertised in every JWT minted
 *     by the authority and the sole entry of `issuer` in the
 *     OIDC + OAuth metadata documents.
 *   - `MCP_OAUTH_ALLOWED_RESOURCES` is REQUIRED when
 *     `MCP_AUTHORITY_URL` is set. The value is a comma-separated
 *     list of canonical RFC 8707 resource URIs the authority is
 *     willing to mint tokens for. Every `aud` claim in a minted
 *     JWT is one of these canonical URIs.
 *   - When neither variable is set, the loader is permissive so
 *     tests can spin up the admin app without the OAuth wiring.
 *
 * The loader is intentionally separate from `mcp-readonly-sql`'s
 * HTTP config loader — the apps are independent peer processes and
 * do not import each other. The shared `mcp-http-base` package
 * provides the resource URI canonicalization primitive
 * (`canonicalizeResourceUri`); this module is the only place that
 * uses it for the issuer-side allowlist.
 */

import {
  canonicalizeResourceUri,
  ResourceUriError,
} from "@customized-mcps/mcp-http-base";

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthConfigError";
  }
}

/**
 * The parsed OAuth configuration the entrypoint hands to the
 * `/oauth/token`, `/oauth/introspect`, and discovery handlers.
 *
 * `allowedResources` is the canonicalized set of RFC 8707 URIs the
 * authority is willing to mint tokens for. The set is empty when
 * the OAuth wiring is disabled (no `MCP_AUTHORITY_URL`).
 */
export type OAuthConfig = {
  /** The canonical issuer URL (RFC 8414 §2). */
  issuer: string | undefined;
  /** Allowed canonical resource URIs (RFC 8707). */
  allowedResources: string[];
};

/**
 * Read the OAuth configuration from `process.env`. The function is
 * pure-from-the-outside: it never throws on the absence of the OAuth
 * wiring (it is an opt-in feature). When the OAuth wiring is set,
 * every input that violates the canonicalization contract surfaces
 * as an `OAuthConfigError`.
 */
export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const rawIssuer = env["MCP_AUTHORITY_URL"];
  const rawResources = env["MCP_OAUTH_ALLOWED_RESOURCES"];

  const issuer = rawIssuer === undefined || rawIssuer.trim().length === 0
    ? undefined
    : canonicalizeResourceUri(rawIssuer);

  const allowedResources: string[] = [];
  if (rawResources !== undefined && rawResources.trim().length > 0) {
    const entries = rawResources.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (entries.length === 0) {
      throw new OAuthConfigError(
        "MCP_OAUTH_ALLOWED_RESOURCES is set but contains no entries.",
      );
    }
    for (const entry of entries) {
      try {
        allowedResources.push(canonicalizeResourceUri(entry));
      } catch (e) {
        if (e instanceof ResourceUriError) {
          throw new OAuthConfigError(
            `MCP_OAUTH_ALLOWED_RESOURCES contains an invalid resource URI "${entry}": ${e.message}`,
          );
        }
        throw e;
      }
    }
    // Detect duplicates after canonicalization so an operator who
    // configures `https://MCP.example.com,https://mcp.example.com`
    // gets a clear error rather than two indistinguishable entries.
    const seen = new Set<string>();
    for (const uri of allowedResources) {
      if (seen.has(uri)) {
        throw new OAuthConfigError(
          `MCP_OAUTH_ALLOWED_RESOURCES contains a duplicate resource URI: ${uri}`,
        );
      }
      seen.add(uri);
    }
  }

  // When the issuer is set, the resource allowlist MUST be set too.
  // An authority without a protected_resources list cannot bind any
  // tokens to a specific resource; per RFC 9728 §4, the resource
  // server's metadata lists the authority's identifiers and the
  // authority's metadata lists the resources it serves. We fail
  // closed so a misconfigured deploy cannot mint tokens that no
  // resource server will accept.
  if (issuer !== undefined && allowedResources.length === 0) {
    throw new OAuthConfigError(
      "MCP_OAUTH_ALLOWED_RESOURCES is required when MCP_AUTHORITY_URL is set. " +
        "Specify a comma-separated list of canonical RFC 8707 resource URIs " +
        "(e.g. https://sql.example.com,https://memos.example.com).",
    );
  }
  // And vice versa: when the resource allowlist is set, the issuer
  // MUST be set. An allowlist without an issuer would mean the
  // authority advertises resources it cannot bind tokens to.
  if (issuer === undefined && allowedResources.length > 0) {
    throw new OAuthConfigError(
      "MCP_AUTHORITY_URL is required when MCP_OAUTH_ALLOWED_RESOURCES is set.",
    );
  }

  return { issuer, allowedResources };
}

/**
 * Test whether a canonical resource URI is in the allowlist. Pure
 * function; the handler consults it on every `aud` derivation and
 * every `resource` parameter validation.
 */
export function isResourceAllowed(
  config: OAuthConfig,
  canonicalResource: string,
): boolean {
  return config.allowedResources.includes(canonicalResource);
}