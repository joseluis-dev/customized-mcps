/**
 * Auth helpers for the shared HTTP transport.
 *
 * The `remove-scope-authorization` change makes scope authorization
 * inert. The previous surface — `SCOPE_PATTERN` regex, `isValidScope`
 * predicate, `matchScope` resolver, and `Scope` alias — is GONE from
 * the public API. The `matchScope` resolver has zero production
 * callers. The `SCOPE_PATTERN` / `isValidScope` / `Scope` symbols
 * are no longer re-exported.
 *
 * The authority implementations still call `authority.verify(token)` and
 * the middleware still maps `TokenInvalidError` → 401 and
 * `AuthorityUnavailableError` → 503. The `verify` contract returns
 * `{ agentId, scopes: [] }` for every successful call; the inbound
 * `scopes` claim (in any shape) is ignored.
 */
