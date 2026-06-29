/**
 * Signing key management for the OAuth2 authority.
 *
 * The mcp-oauth-authority spec requires:
 * - RS256 access tokens, signed with a key generated on first
 *   start and stored in the `keys` table.
 * - The private key NEVER leaves the process (the public JWK
 *   is what JWKS exposes).
 * - The `kid` is the JWK thumbprint; the JWT header includes
 *   the `kid` so resource servers can find the right key.
 *
 * The first-start key generation is wired into the app
 * startup. The current implementation keeps a single active
 * key (rotation policy is left for a later phase; the spec
 * for v1 does not require key rotation, just stable signing).
 *
 * The `SigningKeyRecord` is the in-memory shape we pass to
 * the JWT signer. The public JWK is the same document we
 * serve via `/.well-known/jwks.json`; the private PEM is
 * loaded by jose at sign time.
 */

import { generateKeyPair, exportJWK, exportPKCS8, calculateJwkThumbprint, importPKCS8, type KeyLike } from "jose";
import { withSingleWriter, type AuthorityDatabase } from "../db/connection.js";

/**
 * The in-memory shape of a signing key. `publicJwk` is what
 * JWKS serves; `privatePem` is loaded by jose at sign time
 * and never serialized to any HTTP response.
 */
export type SigningKeyRecord = {
  id: string;
  algorithm: "RS256";
  publicJwk: Record<string, unknown>;
  privatePem: string;
};

/**
 * Generate a fresh RS256 signing key. The kid is the
 * JWK thumbprint per RFC 7638; resource servers that cache
 * the JWKS can match by thumbprint.
 */
export async function generateSigningKey(): Promise<SigningKeyRecord> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const privatePem = await exportPKCS8(privateKey);
  return {
    id: kid,
    algorithm: "RS256",
    publicJwk: publicJwk as unknown as Record<string, unknown>,
    privatePem,
  };
}

/**
 * Persist a signing key in the `keys` table. Replaces any
 * existing key with the same `id` (idempotent).
 */
export async function persistSigningKey(
  db: AuthorityDatabase,
  key: SigningKeyRecord,
): Promise<void> {
  await withSingleWriter(db, async (trx) => {
    await trx.execute(
      `INSERT INTO keys (id, algorithm, publicJwk, privatePem, createdAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         algorithm = excluded.algorithm,
         publicJwk = excluded.publicJwk,
         privatePem = excluded.privatePem`,
      [
        key.id,
        key.algorithm,
        JSON.stringify(key.publicJwk),
        key.privatePem,
        Math.floor(Date.now() / 1000),
      ],
    );
  });
}

/**
 * Set the active signing key. If the database has no key,
 * a new one is generated and persisted; otherwise the most
 * recently created key is reused. The returned record is
 * the active key for subsequent JWT signing.
 */
export async function setActiveSigningKey(
  db: AuthorityDatabase,
  preset?: SigningKeyRecord,
): Promise<SigningKeyRecord> {
  const existing = await loadActiveSigningKey(db);
  if (existing) return existing;
  const key = preset ?? (await generateSigningKey());
  await persistSigningKey(db, key);
  return key;
}

/**
 * Load the most-recently-created signing key from the
 * `keys` table. Returns `null` when the table is empty.
 */
export async function loadActiveSigningKey(
  db: AuthorityDatabase,
): Promise<SigningKeyRecord | null> {
  const rows = await db.select<{
    id: string;
    algorithm: string;
    publicJwk: string;
    privatePem: string;
  }>(
    "SELECT id, algorithm, publicJwk, privatePem FROM keys ORDER BY createdAt DESC LIMIT 1",
  );
  const r = rows[0];
  if (!r) return null;
  let publicJwk: Record<string, unknown>;
  try {
    publicJwk = JSON.parse(r.publicJwk) as Record<string, unknown>;
  } catch {
    throw new Error(`keys.publicJwk for kid "${r.id}" is not valid JSON`);
  }
  return {
    id: r.id,
    algorithm: "RS256",
    publicJwk,
    privatePem: r.privatePem,
  };
}

/**
 * Load the private key as a `KeyLike` (the jose API
 * expects this for `SignJWT` and `jwtVerify`). The PEM is
 * re-imported on each call so a key rotation is picked up
 * without restart.
 */
export async function importSigningPrivateKey(
  key: SigningKeyRecord,
): Promise<KeyLike> {
  return importPKCS8(key.privatePem, key.algorithm);
}
