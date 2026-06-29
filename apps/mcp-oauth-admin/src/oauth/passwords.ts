/**
 * Password hashing using argon2id.
 *
 * The mcp-oauth-authority spec requires:
 * - Passwords (admin bootstrap + user passwords) are stored
 *   as `argon2id` hashes. No env plaintext in any row.
 * - `requireChangeOnFirstLogin=true` is honored by the
 *   token endpoint: the bootstrap admin authenticates with
 *   the env password and the response is `400` with a
 *   sanitized error (no token is issued).
 *
 * The argon2id implementation lives in the `argon2` npm
 * package; we keep the wrapper thin so the token / admin
 * modules can stay algorithm-agnostic.
 *
 * Implementation note: the spec mandates `argon2id`. We
 * use the `argon2` package's `hash` / `verify` pair. The
 * encoded hash is self-describing (it includes the
 * algorithm, parameters, salt, and digest) so we can
 * verify without a separate config column.
 */

import argon2 from "argon2";

/**
 * Hash a password with argon2id. The returned string is the
 * encoded hash; we store it verbatim in the `users.passwordHash`
 * column.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("hashPassword: empty input");
  }
  return argon2.hash(plain, { type: argon2.argon2id });
}

/**
 * Verify a password against an encoded argon2id hash. The
 * function is constant-time (argon2 handles the comparison
 * internally).
 */
export async function verifyPassword(
  encoded: string,
  plain: string,
): Promise<boolean> {
  if (typeof encoded !== "string" || encoded.length === 0) return false;
  if (typeof plain !== "string" || plain.length === 0) return false;
  try {
    return await argon2.verify(encoded, plain);
  } catch {
    return false;
  }
}
