/**
 * LocalRosterAuthority — the dev/offline token-verify backend.
 *
 * Wraps the existing v1 `loadAgents` + `validateBearer` path:
 * - `loadAgents` parses the JSON roster and validates every record
 *   at config-load time. A malformed roster crashes the app at
 *   startup; this authority does NOT change that behavior.
 * - `validateBearer` runs the constant-time HMAC compare. The
 *   middleware's v1 guarantees — no token in error shapes, no
 *   keyHash in error shapes, no agent id in error shapes — are
 *   preserved.
 *
 * New behavior (defense-in-depth):
 * - The constructor filters every agent's `scopes` array through
 *   `SCOPE_PATTERN` and drops invalid entries. The runtime filter
 *   catches scopes that slipped past the type system (e.g. a
 *   record constructed by hand in a test, or a future change that
 *   relaxes `loadAgents`). Dropped scopes are logged at `WARN`
 *   with the agent id and the count of dropped entries; the
 *   rejected values themselves are NEVER included in the log
 *   line (per the audit-safe redaction contract in
 *   `mcp-token-authority`).
 *
 * Bit-for-bit equivalence with v1:
 * - Same agent is accepted for the same token (HMAC compare).
 * - Same token is rejected with `TokenInvalidError` (mapped to 401
 *   by the middleware). v1's `validateBearer` returned
 *   `{ ok: false, reason: "invalid" | "missing" }`; the typed
 *   error replaces the discriminated union.
 * - The HMAC secret, the agent's keyHash, and the supplied token
 *   are NEVER included in the error message.
 */

import { SCOPE_PATTERN, validateBearer, type AgentRecord } from "../auth.js";
import {
  AuthorityUnavailableError,
  TokenInvalidError,
  type LocalRosterAuthorityOptions,
  type TokenAuthority,
  type VerifiedToken,
} from "./types.js";

/**
 * Minimum HMAC secret length. Mirrors the shared base's
 * `parseHttpConfig` check (32 bytes of entropy). The constructor
 * enforces this defensively so a hand-rolled `LocalRosterAuthority`
 * cannot bypass the env-validator's guard. Phase 1b's
 * `JwksAuthority` does not need this constraint (it never sees
 * the secret), so the check is local to this class.
 */
const MIN_HMAC_SECRET_LENGTH = 32;

/**
 * LocalRosterAuthority — the dev/offline `TokenAuthority`
 * implementation.
 *
 * Construction is strict: an empty agent list or a short HMAC
 * secret crashes the constructor so the middleware cannot be
 * wired against a permissive default. This is a fail-closed
 * guarantee; the operator MUST configure at least one agent and
 * a 32+ byte HMAC secret before the shared base will accept
 * the local backend.
 */
export class LocalRosterAuthority implements TokenAuthority {
  private readonly agents: AgentRecord[];
  private readonly hmacSecret: string;

  constructor(options: LocalRosterAuthorityOptions) {
    const { agents, hmacSecret, logger } = options;
    if (!Array.isArray(agents) || agents.length === 0) {
      throw new Error(
        "LocalRosterAuthority requires at least one agent; " +
          "an empty roster would permit any token to fail open at the verify step. " +
          "Configure at least one record in MCP_AGENTS_JSON or MCP_AGENTS_INLINE " +
          "before constructing the authority.",
      );
    }
    if (typeof hmacSecret !== "string" || hmacSecret.length < MIN_HMAC_SECRET_LENGTH) {
      throw new Error(
        `LocalRosterAuthority: MCP_AGENT_HMAC_SECRET must be at least ${MIN_HMAC_SECRET_LENGTH} bytes; ` +
          `got ${hmacSecret.length}. Generate one with: openssl rand -hex 32`,
      );
    }
    // Defense-in-depth scope filter. `loadAgents` already enforces
    // `SCOPE_PATTERN` at config-load time, but the runtime filter
    // catches scopes that bypass the type system. Invalid entries
    // are dropped from the resolved set; a WARN is emitted with the
    // agent id and the count of dropped entries, NEVER the rejected
    // values themselves.
    this.agents = agents.map((agent) => filterAgentScopes(agent, logger));
    this.hmacSecret = hmacSecret;
  }

  /**
   * Verify a bearer token against the configured roster.
   *
   * Returns `{ agentId, scopes }` on success; throws
   * `TokenInvalidError` for missing or mismatched tokens. The
   * error message is the same audited-safe `validateBearer`
   * shape: it never includes the supplied token, the agent's
   * keyHash, the agent id, or the HMAC secret.
   *
   * The authority does not throw `AuthorityUnavailableError` —
   * the local backend is always available by construction. The
   * typed error is exported from this package so a future
   * `IntrospectionAuthority` (out of scope for this change) can
   * throw it from the same surface.
   */
  async verify(token: string): Promise<VerifiedToken> {
    // v1's `validateBearer` returns a discriminated union; the
    // middleware used to translate that to the HTTP envelope. The
    // typed-error contract flattens the union into a single
    // `TokenInvalidError` so the middleware's catch block is the
    // same for every backend (LocalRosterAuthority, JwksAuthority,
    // future IntrospectionAuthority).
    const result = validateBearer(token, this.hmacSecret, this.agents);
    if (!result.ok) {
      // `reason` is "missing" or "invalid". v1 logged them
      // separately; the typed error keeps the reason in the
      // message so structured logs (which redact the message)
      // preserve the discrimination without leaking the token.
      throw new TokenInvalidError(`bearer token rejected: ${result.reason}`);
    }
    return {
      agentId: result.agent.id,
      scopes: result.agent.scopes,
    };
  }
}

/**
 * Filter an agent's `scopes` array through `SCOPE_PATTERN` and
 * log a WARN for any dropped entries. The agent's `id` and the
 * count of dropped entries are included in the log line; the
 * rejected values themselves are NEVER included.
 *
 * Split out as a module-private helper so the filter behavior
 * is testable in isolation and the constructor body stays
 * readable. The function is pure w.r.t. its inputs (the only
 * side effect is the WARN log; the returned agent is a fresh
 * object with the filtered scopes).
 */
function filterAgentScopes(agent: AgentRecord, logger: import("../logging.js").Logger): AgentRecord {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const scope of agent.scopes) {
    if (typeof scope === "string" && SCOPE_PATTERN.test(scope)) {
      kept.push(scope);
    } else {
      // Capture the dropped value locally so we can count it, but
      // never include it in the log line.
      dropped.push(typeof scope === "string" ? scope : "<non-string>");
    }
  }
  if (dropped.length > 0) {
    // Operator-friendly WARN: the agent id lets operators locate
    // the offending record; the count of dropped entries is the
    // actionable signal. The rejected values themselves are
    // omitted to honor the audit-safe redaction contract.
    logger.warn(
      `LocalRosterAuthority: agent "${agent.id}" has ${dropped.length} scope(s) ` +
        `that do not match SCOPE_PATTERN; the entries are dropped from the resolved ` +
        `scopes set. Update the roster to use "<verb>:<resource>" where verb is ` +
        `one of {read, list, call}.`,
    );
  }
  return { ...agent, scopes: kept };
}

// Re-export AuthorityUnavailableError from this module so
// LocalRosterAuthority consumers that only import the local class
// can still reference the typed error. The shared base's middleware
// relies on the discriminator (`name` property) being the same
// across the package.
export { AuthorityUnavailableError, TokenInvalidError };
