/**
 * Centralized scope resolution for the OAuth2 authority.
 *
 * The mcp-oauth-authority spec REQUIRES a uniform scope policy across
 * all three grants (`client_credentials`, `password`,
 * `authorization_code`). The pre-2026 implementation let each grant
 * resolve scopes on its own, which produced three different policies:
 *
 *   - `client_credentials`: intersected requested scopes with the
 *     client's allowed scopes, with a `*` / no-mixing rule.
 *   - `password`: used the user's scopes verbatim (the client's scopes
 *     were verified but never enforced). A user with `*` could mint a
 *     token whose `scope` was `*` even when the client had no scopes
 *     (a privilege-escalation side channel between the user roster
 *     and the client roster).
 *   - `authorization_code`: bound the URL-requested scopes to the
 *     code verbatim. The token endpoint then minted the code's scopes
 *     without intersecting them with the client or user scopes. An
 *     attacker who could convince a registered user to consent with
 *     a crafted `scope=` URL parameter would mint a token with
 *     arbitrary scopes (the user did not need to have them and the
 *     client did not need to allow them).
 *
 * The `resolveGrantedScopes` function collapses all three grants into
 * one policy:
 *
 *   1. Validate the request shape (every token matches the scope
 *      grammar; bare `*` is only allowed when both relevant principals
 *      allow it).
 *   2. Compute the **allowed set** for the grant:
 *      - `client_credentials`: the client's `scopes` column verbatim.
 *      - `password` / `authorization_code`: the intersection of the
 *        user's `scopes` and the client's `scopes`. When either side
 *        is empty, the non-empty side is used; when both are empty,
 *        the resolved set is `[]` and the caller falls back to the
 *        authority's `defaultScope`.
 *   3. Apply the `*` rules: the request may be `*` alone (the only
 *      way to grant `*`); mixed `*` + specific is rejected; a `*`
 *      request against an allowed set that does NOT include `*` is
 *      rejected.
 *   4. Filter the specific-scope request against the allowed set and
 *      the `SCOPE_PATTERN` (defense in depth).
 *
 * The function is a pure helper: no I/O, no DB. The caller passes the
 * `principal` shape (client + user scopes + catalog + default), and
 * the helper returns the granted set. This shape lets us unit-test
 * the policy without spinning up SQLite.
 *
 * Wildcard semantics:
 *
 *   - `SCOPE_PATTERN` does NOT match a bare `*`; the helper treats
 *     `*` as a meta-scope (a request for "everything the principal
 *     allows") rather than as a `<verb>:<resource>` literal.
 *   - The helper preserves the `*`-only grant shape (the granted set
 *     is `["*"]`, NOT a list of every allowed scope). Resource
 *     servers consume the `*` claim via `matchScope`, which maps
 *     `*` to "any resource".
 *   - Mixing `*` with a specific scope is REJECTED with
 *     `invalid_scope` (the spec is explicit).
 *
 * Audit-safety: the function NEVER echoes the supplied scopes in its
 * error path; the `error` shape is a stable reason code, not a leak.
 */

import { SCOPE_PATTERN } from "@customized-mcps/mcp-http-base";
import type { AuthorityDatabase } from "../db/connection.js";
import { listScopes as listCatalogScopes } from "../admin/scopes.js";

/**
 * The grant mode. The `authorization_code` mode is the same policy
 * as `password` (both are user-bound); the explicit enum keeps the
 * caller honest about the intent.
 */
export type ScopeGrantMode = "client_credentials" | "password" | "authorization_code";

/**
 * The principal scopes the policy is bound by. The helper does NOT
 * read from a DB; the caller reads the rows and passes the decoded
 * JSON arrays.
 *
 *   - `clientScopes`: the OAuth client's `clients.scopes` JSON array.
 *     Empty when the client has no scope restrictions (the spec
 *     default for a freshly-registered client).
 *   - `userScopes`: the agent's `users.scopes` JSON array. Empty
 *     when the user has no scope restrictions. Only used for
 *     `password` and `authorization_code` grants.
 *   - `defaultScope`: the authority's `defaultScope` (from env
 *     `MCP_OAUTH_DEFAULT_SCOPE`). Used as the granted scope when
 *     both `clientScopes` and `userScopes` are empty.
 *   - `catalogScopes`: the scope catalog (`scopes` table) names. The
 *     helper does NOT enforce the catalog here — the catalog gate is
 *     applied at registration time. The field is included for
 *     forward-compat (a future mode may want to use the catalog as
 *     the authoritative source).
 */
export type ScopePrincipal = {
  clientScopes: string[];
  userScopes: string[];
  defaultScope: string;
  catalogScopes: string[];
};

/**
 * The shape returned by `resolveGrantedScopes`. The success shape
 * carries the granted set; the failure shape carries the stable
 * error reason code (`invalid_scope`).
 */
export type ScopeGrantResult =
  | { ok: true; scopes: string[] }
  | { ok: false; error: "invalid_scope" };

/**
 * The character class the request side honors. We deliberately
 * accept the same alphabet the legacy `client_credentials` resolver
 * accepted (`A-Za-z0-9_*.:\s-` plus whitespace) so legacy callers
 * (the admin UI, opencode, etc.) that pass space-delimited scope
 * strings keep working. `SCOPE_PATTERN` is the stricter grammar
 * (`<verb>:<resource>`) and is applied as a defense-in-depth filter
 * on the granted set.
 */
const REQUEST_SCOPE_PATTERN = /^[A-Za-z0-9_*.:\s-]+$/;

/**
 * Resolve the granted scope set for a token request. The function
 * is the single source of truth for "what scope is the issued JWT
 * allowed to claim". Each of the three grant handlers in
 * `oauth/token.ts` and the consent handler in `oauth/authorize.ts`
 * delegates here.
 *
 * Failure modes:
 *   - `invalid_scope`: the request shape is invalid (mixing `*`
 *     with specific scopes, or asking for `*` when the principal
 *     does not allow it, or the resolved set is empty). The caller
 *     maps this to a 400 with `{ error: "invalid_scope" }`.
 *
 * Edge cases:
 *   - Empty request, empty `clientScopes`, empty `userScopes`:
 *     the granted set is `[defaultScope]`. The spec is explicit:
 *     the default scope is `read:<bound-profile>`, never `*`.
 *   - `*` request against an allowed set that contains `*`: the
 *     granted set is `["*"]` (the literal `*`).
 *   - Specific-scope request against an empty allowed set: the
 *     request is rejected with `invalid_scope` (the user is asking
 *     for something the principal cannot allow).
 */
export function resolveGrantedScopes(
  mode: ScopeGrantMode,
  requestedRaw: string,
  principal: ScopePrincipal,
): ScopeGrantResult {
  // 1. Parse the request. Empty / whitespace-only → `[]` (the caller
  //    will get the principal's allowed set as the granted set).
  const requested = parseRequestScopes(requestedRaw);
  for (const s of requested) {
    if (!REQUEST_SCOPE_PATTERN.test(s)) {
      return { ok: false, error: "invalid_scope" };
    }
  }

  // 2. Compute the allowed set for this grant mode.
  const allowed = computeAllowedSet(mode, principal);
  const allowedHasWildcard = allowed.includes("*");

  // 3. Empty request → use the allowed set, or fall back to the
  //    default scope when the allowed set is empty.
  if (requested.length === 0) {
    if (allowed.length > 0) {
      return { ok: true, scopes: [...allowed] };
    }
    return { ok: true, scopes: [principal.defaultScope] };
  }

  // 4. Wildcard-only request: `*` alone.
  const hasWildcard = requested.includes("*");
  const hasSpecific = requested.some((s) => s !== "*");
  if (hasWildcard && hasSpecific) {
    return { ok: false, error: "invalid_scope" };
  }
  if (hasWildcard) {
    if (allowedHasWildcard) {
      return { ok: true, scopes: ["*"] };
    }
    return { ok: false, error: "invalid_scope" };
  }

  // 5. Specific-scope request: filter against the allowed set AND
  //    `SCOPE_PATTERN` (defense in depth — the granted set MUST
  //    be valid `<verb>:<resource>` shapes, even if the request
  //    was loose). An empty result is `invalid_scope`.
  const granted = requested.filter(
    (s) => allowed.includes(s) && SCOPE_PATTERN.test(s),
  );
  if (granted.length === 0) {
    return { ok: false, error: "invalid_scope" };
  }
  return { ok: true, scopes: granted };
}

/**
 * Parse a request's `scope` field into a token list. Whitespace is
 * the canonical delimiter. Empty / whitespace-only input is `[]`.
 * Duplicates are preserved (the `resolveGrantedScopes` caller
 * doesn't dedupe; the spec leaves the choice to the implementation,
 * and the original `client_credentials` resolver preserved them too).
 */
function parseRequestScopes(raw: string): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw.split(/\s+/).filter((s) => s.length > 0);
}

/**
 * Parse a JSON-encoded string array. The schema stores `scopes` as
 * a JSON string; we tolerate `null` / undefined / non-string /
 * malformed JSON as `[]`. The function is the single source of
 * truth for the storage-shape → list decoding used by every
 * scope-loading call site (token, authorize, etc.).
 *
 * The shape of the returned list is the same as the input: an
 * array of strings. Non-string elements are filtered out; an
 * empty / missing / malformed input is `[]`. The caller is
 * expected to treat `[]` as "no scope restrictions" (the
 * resolver handles the empty side by falling back to the other
 * principal's set or the `defaultScope`).
 */
export function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/**
 * The handler-agnostic scope-loading helper. Reads the user row's
 * `scopes` JSON (when `agentId` is non-null; the
 * `client_credentials` path passes `null`), the client row's
 * `scopes` JSON, the scope catalog (for forward-compat with the
 * `catalogScopes` field), and the authority's `defaultScope`. The
 * function is async because the rows are read via the DB; tests
 * inject a DB to drive it.
 *
 * Tolerates a missing user row (the `agentId` is for a user that
 * was deleted between issue and exchange) and a missing client row
 * — both yield `[]` for the missing side, and the resolver handles
 * the empty side by falling back to the other side or the
 * `defaultScope`. The function never throws on a missing row; the
 * only failure mode is a DB error, which propagates to the caller.
 *
 * Centralized here so the token and authorize handlers do not
 * duplicate the same JSON-parse + DB-read + defaultScope-bundle
 * pipeline. The previous duplication was a maintainability hazard
 * (and was the source of the `*`-bypass review finding — the
 * `token.ts` and `authorize.ts` copies diverged on the wildcard
 * handling).
 */
export async function loadScopePrincipal(
  db: AuthorityDatabase,
  defaultScope: string,
  clientId: string,
  agentId: number | null,
): Promise<ScopePrincipal> {
  const userScopes = agentId === null
    ? []
    : parseJsonStringArray(
        (await db.select<{ scopes: string }>(
          "SELECT scopes FROM users WHERE id = ? LIMIT 1",
          [agentId],
        ))[0]?.scopes,
      );
  const clientScopes = parseJsonStringArray(
    (await db.select<{ scopes: string }>(
      "SELECT scopes FROM clients WHERE clientId = ? LIMIT 1",
      [clientId],
    ))[0]?.scopes,
  );
  const catalog = await listCatalogScopes(db);
  return {
    userScopes,
    clientScopes,
    defaultScope,
    catalogScopes: catalog.map((s) => s.name),
  };
}

/**
 * Convert a JSON-encoded scope list to a space-delimited string
 * suitable for the `requested` argument of `resolveGrantedScopes`.
 * Empty / missing / non-array input is the empty string. The
 * helper exists so the refresh-token and authorization-code
 * token paths can pass the stored `scopes` (a JSON array) through
 * the centralized resolver without each path re-implementing the
 * JSON → space-delimited string conversion.
 *
 * The output is NOT deduplicated. `resolveGrantedScopes` does not
 * dedupe either, so this preserves the original semantics.
 */
export function joinScopeList(raw: string | null | undefined): string {
  const list = parseJsonStringArray(raw);
  if (list.length === 0) return "";
  return list.join(" ");
}

/**
 * Compute the allowed scope set for a grant. The function is the
 * spec-mandated intersection rule:
 *
 *   - `client_credentials`: the client's scopes (no user row in the
 *     loop, so user scopes are irrelevant).
 *   - `password` / `authorization_code`: the intersection of the
 *     user scopes and the client scopes. When either side is
 *     empty, the non-empty side is used; when both are empty, the
 *     allowed set is `[]` (the caller falls back to
 *     `defaultScope`).
 *
 * The intersection is the conservative policy: a token MUST be
 * grantable to BOTH the user and the client. The "use the
 * non-empty side when the other is empty" branch is the
 * pre-existing behavior the operator expects from a freshly-created
 * agent or client (the admin UI seeds both with `[]`; the resolved
 * scope defaults to the defaultScope on the empty case).
 */
function computeAllowedSet(mode: ScopeGrantMode, principal: ScopePrincipal): string[] {
  if (mode === "client_credentials") {
    return [...principal.clientScopes];
  }
  // password + authorization_code: user AND client.
  if (principal.userScopes.length === 0) {
    return [...principal.clientScopes];
  }
  if (principal.clientScopes.length === 0) {
    return [...principal.userScopes];
  }
  return principal.userScopes.filter((s) => principal.clientScopes.includes(s));
}

/**
 * The shape returned by `boundRegistrationScope`. Used by the
 * Dynamic Client Registration handler to cap the scope set a
 * freshly-registered client can self-grant. The policy is
 * intentionally tighter than the runtime grants: an unauthenticated
 * registration MUST NOT self-grant arbitrary scopes. The function
 * returns the granted scope string (space-delimited) for the
 * registration response, plus a reason code on failure.
 */
export type RegistrationScopeResult =
  | { ok: true; granted: string }
  | { ok: false; error: "invalid_scope" };

/**
 * Bound the scope a DCR client is allowed to self-grant. The
 * policy is the strictest of the runtime policies:
 *
 *   - When the scope catalog is non-empty, the granted scope is
 *     the intersection of the request and the catalog. The
 *     catalog is the authoritative source for which scopes the
 *     authority is willing to mint; DCR is unauthenticated, so
 *     the request cannot grant scopes outside the catalog.
 *   - When the catalog is empty, the granted scope is the
 *     authority's `defaultScope` (the spec default). The request
 *     is ignored — a DCR caller cannot self-grant `*` or any
 *     catalog-free scope the operator has not blessed.
 *
 * The wildcard rules are the same as `resolveGrantedScopes`:
 * `*` alone grants `*` (only when the catalog / default allows
 * it); mixing `*` with specific scopes is rejected.
 */
export function boundRegistrationScope(
  requestedRaw: string,
  catalogScopes: string[],
  defaultScope: string,
): RegistrationScopeResult {
  const requested = parseRequestScopes(requestedRaw);
  for (const s of requested) {
    if (!REQUEST_SCOPE_PATTERN.test(s)) {
      return { ok: false, error: "invalid_scope" };
    }
  }

  // Empty catalog → the granted scope is the default scope, the
  // request is ignored. This is the safe default: an authority
  // that hasn't curated a catalog cannot self-grant arbitrary
  // scopes via DCR.
  if (catalogScopes.length === 0) {
    return { ok: true, granted: defaultScope };
  }

  // Non-empty catalog → intersect the request with the catalog.
  const catalogHasWildcard = catalogScopes.includes("*");
  const hasWildcard = requested.includes("*");
  const hasSpecific = requested.some((s) => s !== "*");

  // Empty request → grant the default scope (the catalog is
  // informational here; the default scope is the operator's
  // stated intent for new clients).
  if (requested.length === 0) {
    return { ok: true, granted: defaultScope };
  }

  if (hasWildcard && hasSpecific) {
    return { ok: false, error: "invalid_scope" };
  }
  if (hasWildcard) {
    if (catalogHasWildcard) {
      return { ok: true, granted: "*" };
    }
    return { ok: false, error: "invalid_scope" };
  }
  const granted = requested.filter(
    (s) => catalogScopes.includes(s) && SCOPE_PATTERN.test(s),
  );
  if (granted.length === 0) {
    return { ok: false, error: "invalid_scope" };
  }
  return { ok: true, granted: granted.join(" ") };
}
