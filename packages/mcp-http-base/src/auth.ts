/**
 * Agent authorization helpers for the shared HTTP transport.
 *
 * - Tokens are opaque to the client. The server stores only the HMAC of the
 *   token in `keyHash`; we never persist the plaintext.
 * - Validation runs in middleware before the MCP transport, so unauthorized
 *   traffic never reaches a tool handler.
 * - Failure shapes never include the supplied token, agent id, keyHash, or
 *   HMAC secret — see the `validateBearer` contract below.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Canonical `AgentRecord` type. The shared HTTP base uses this same shape
 * everywhere; there is intentionally no other definition of `AgentRecord`
 * (previously `server.ts` had a duplicate type with `scopes: Scope[]`).
 */
export type AgentRecord = {
  id: string;
  keyHash: string;
  scopes: string[];
};

export type AuthorizedAgent = AgentRecord;

export type ValidateBearerResult =
  | { ok: true; agent: AuthorizedAgent }
  | { ok: false; reason: "missing" | "invalid" };

/**
 * Parse and validate the JSON-encoded agent configuration. The shape is
 * intentionally narrow: extra fields are dropped silently so the operator
 * can add comments-incompatible metadata in v1.
 */
export function loadAgents(json: string): AgentRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `Failed to parse agent config JSON: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Agent config must be a JSON array of records");
  }
  const seen = new Set<string>();
  const out: AgentRecord[] = [];
  for (const [i, raw] of parsed.entries()) {
    const record = parseAgentRecord(raw, i);
    if (seen.has(record.id)) {
      throw new Error(
        `Duplicate agent id "${record.id}" in agent config (agents MUST have unique ids)`,
      );
    }
    seen.add(record.id);
    out.push(record);
  }
  return out;
}

function parseAgentRecord(raw: unknown, index: number): AgentRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Agent record at index ${index} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim() === "") {
    throw new Error(`Agent record at index ${index} is missing a string "id"`);
  }
  if (typeof r.keyHash !== "string" || r.keyHash.trim() === "") {
    throw new Error(
      `Agent record at index ${index} is missing a string "keyHash"`,
    );
  }
  if (!Array.isArray(r.scopes)) {
    throw new Error(`Agent record at index ${index} must have a "scopes" array`);
  }
  const scopes: string[] = [];
  for (const [j, s] of (r.scopes as unknown[]).entries()) {
    if (typeof s !== "string") {
      throw new Error(
        `Agent record at index ${index} scope ${j} must be a string`,
      );
    }
    const trimmed = s.trim();
    if (!isValidScope(trimmed)) {
      throw new Error(
        `Agent record at index ${index} scope ${j} ("${trimmed}") is not a valid "<verb>:<resource>" ` +
          `where <verb> ∈ {read, list, call} and <resource> is "*" or an identifier.`,
      );
    }
    scopes.push(trimmed);
  }
  const trimmedHash = r.keyHash.trim();
  if (!isValidKeyHash(trimmedHash)) {
    throw new Error(
      `Agent record at index ${index} keyHash must be exactly 64 hex characters.`,
    );
  }
  return {
    id: r.id.trim(),
    keyHash: trimmedHash,
    scopes,
  };
}

/** A 64-char SHA-256 hex digest, the same shape used for `keyHash`. */
export const KEY_HASH_PATTERN = /^[a-f0-9]{64}$/i;

export function isValidKeyHash(value: string): boolean {
  return typeof value === "string" && KEY_HASH_PATTERN.test(value);
}

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

/**
 * Validate a bearer token against the configured agents.
 *
 * The function runs in O(n) over the agent list and uses
 * `crypto.timingSafeEqual` for the byte comparison. It returns a
 * discriminated union so callers can map `missing` and `invalid` to
 * different log lines without leaking the reason to the client.
 */
export function validateBearer(
  token: string,
  hmacSecret: string,
  agents: readonly AgentRecord[],
): ValidateBearerResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing" };
  }
  for (const agent of agents) {
    if (matchesToken(token, agent.keyHash, hmacSecret)) {
      return { ok: true, agent };
    }
  }
  return { ok: false, reason: "invalid" };
}

function matchesToken(
  token: string,
  expectedKeyHash: string,
  hmacSecret: string,
): boolean {
  const candidate = createHmac("sha256", hmacSecret).update(token).digest("hex");
  return constantTimeEqualString(candidate, expectedKeyHash);
}

/**
 * Constant-time string comparison backed by `crypto.timingSafeEqual`.
 * Returns false on length mismatch without short-circuiting on the first
 * byte; we still feed both buffers to `timingSafeEqual` whenever the
 * lengths match.
 */
export function constantTimeEqualString(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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
