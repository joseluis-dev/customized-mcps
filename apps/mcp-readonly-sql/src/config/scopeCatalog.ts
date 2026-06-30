/**
 * Scope catalog builder for the `mcp-readonly-sql` resource server
 * (PR4 task 4.1).
 *
 * The resource server exposes its `scopes_supported` catalog at
 * `/.well-known/oauth-protected-resource` (per RFC 9728 + the
 * `mcp-token-authority` delta). The catalog source-of-truth lives in
 * this app: it does NOT assume that `Profile.scope` (the DB-scope
 * field, `server` | `database`) maps to an OAuth scope. Instead, the
 * catalog is derived from profile aliases (`read:<alias>` +
 * `list:<alias>` per profile) OR an explicit `MCP_RESOURCE_SCOPES`
 * env override.
 *
 * Design note: the function is pure. It does not read `process.env`
 * directly so unit tests pass an env-shaped input object. The HTTP
 * transport wires the result into the shared base's
 * `HttpMcpServerOptions.scopeCatalog` so the well-known handler can
 * advertise a fresh catalog per request.
 */

import { isValidScope } from "@customized-mcps/mcp-http-base";
import type { Profile } from "../types.js";

/**
 * Shape of the env input the function reads. Keeping the surface
 * narrow (`MCP_RESOURCE_SCOPES` only) means a future caller cannot
 * accidentally read a different env var inside this pure function.
 */
export type ScopeCatalogEnv = {
  MCP_RESOURCE_SCOPES?: string | undefined;
};

/**
 * Pure function: derive the OAuth scope catalog for the resource server.
 *
 * Resolution order (operator-controllable):
 *
 * 1. If `MCP_RESOURCE_SCOPES` is set to a non-whitespace value, parse
 *    it as a comma-separated list. The list is trimmed, deduped
 *    (first-seen wins), and validated against `SCOPE_PATTERN` (via
 *    `isValidScope` from the shared base). Invalid values are
 *    filtered out so a typo in the operator's env does not poison the
 *    well-known response. If every value is invalid, the env branch
 *    STILL wins: the catalog is `[]` and the profile-derived list
 *    does NOT sneak in. The well-known document will honestly
 *    advertise an empty catalog so the operator sees the
 *    misconfiguration through the absence of expected scopes.
 *
 * 2. Otherwise, derive from the loaded profile aliases. Each profile
 *    contributes two scopes: `read:<alias>` and `list:<alias>`.
 *    Aliases are already validated against `ALIAS_REGEX` in
 *    `config/profiles.ts`, so the resulting scopes always match
 *    `SCOPE_PATTERN`. The list is deduped (first-seen wins) so a
 *    config that accidentally assigns the same alias twice still
 *    produces a valid catalog.
 *
 * 3. Empty profile list AND no env override → `[]`.
 *
 * @param profiles - The loaded profiles from `loadAllProfiles`.
 * @param env - The env-shaped input. Only `MCP_RESOURCE_SCOPES` is read.
 * @returns A non-null array of scope strings matching `SCOPE_PATTERN`.
 */
export function buildScopeCatalog(
  profiles: ReadonlyArray<Profile>,
  env: ScopeCatalogEnv,
): string[] {
  const explicit = parseExplicitScopes(env.MCP_RESOURCE_SCOPES);
  if (explicit !== undefined) {
    return explicit;
  }
  return deriveFromProfiles(profiles);
}

/**
 * Parse the explicit `MCP_RESOURCE_SCOPES` value. Returns `undefined`
 * when the env is unset or whitespace-only (so the caller falls back
 * to the profile-derived catalog). Otherwise returns the parsed list
 * with invalid values filtered out.
 */
function parseExplicitScopes(
  raw: string | undefined,
): string[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of trimmed.split(",")) {
    const value = part.trim();
    if (value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (isValidScope(value)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * Derive a scope catalog from the loaded profiles. Each profile
 * contributes `read:<alias>` and `list:<alias>`. Aliases are
 * pre-validated by `config/profiles.ts` so the resulting scopes
 * always match `SCOPE_PATTERN`. The output is deduped (first-seen
 * wins) to absorb a config that accidentally lists the same alias
 * twice.
 */
function deriveFromProfiles(profiles: ReadonlyArray<Profile>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of profiles) {
    for (const verb of ["read", "list"] as const) {
      const value = `${verb}:${p.alias}`;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}
