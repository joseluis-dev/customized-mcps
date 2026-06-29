/**
 * Scope grammar and matching for the shared HTTP transport.
 *
 * The shared base no longer ships a local HMAC roster backend. Token
 * verification is delegated to a `TokenAuthority` (e.g. the
 * `OAuthAdminAuthority` / `JwksAuthority` implementations). The
 * module keeps the scope grammar (`SCOPE_PATTERN`, `isValidScope`,
 * `matchScope`) because every authority implementation filters its
 * resolved scope set against the same grammar — the `SCOPE_PATTERN`
 * is the single source of truth for what "a valid scope" means on
 * the resource-server side.
 *
 * Audit safety: failures from any authority implementation MUST NOT
 * include the supplied token or the resolved agent id. The middleware
 * in `server.ts` redacts whatever leaks via the `sanitizeError`
 * path; the authority itself is the primary defense.
 */

/**
 * Scope grammar: `<verb>:<resource>` where
 * - `<verb>` is one of `read`, `list`, `call` (case-insensitive)
 * - `<resource>` is `*` or an identifier `[A-Za-z0-9_.-]+`
 *
 * v1 does not wildcard verbs; only resources.
 */
export const SCOPE_PATTERN = /^(read|list|call):(\*|[A-Za-z0-9_.-]+)$/i;

export function isValidScope(scope: string): boolean {
  return typeof scope === "string" && SCOPE_PATTERN.test(scope);
}

export type Scope = string;

/**
 * Returns true iff the agent's scope set permits the requested scope.
 *
 * Rules (v1):
 * - exact `<verb>:<resource>` match → permit
 * - agent has `<verb>:*` and the verb matches → permit
 * - `*` as the verb is NOT a wildcard — only resources are wildcarded in v1
 * - verbs are independent: `read:<r>` does NOT satisfy `list:<r>` or
 *   `call:<r>`. Callers MUST request a scope whose verb matches the tool
 *   category they want to use.
 */
export function matchScope(agentScopes: readonly Scope[], required: Scope): boolean {
  const [reqVerbRaw, reqResource] = required.split(":", 2);
  const reqVerb = (reqVerbRaw ?? "").toLowerCase();
  if (!reqVerb || !reqResource) return false;

  for (const raw of agentScopes) {
    const [verbRaw, resource] = raw.split(":", 2);
    const verb = (verbRaw ?? "").toLowerCase();
    if (!verb || !resource) continue;

    // Resource match: exact or wildcard.
    const resourceMatches = resource === "*" || resource === reqResource;
    if (!resourceMatches) continue;

    // Verb match: exact, with case-insensitive comparison.
    if (verb === reqVerb) return true;
  }
  return false;
}
