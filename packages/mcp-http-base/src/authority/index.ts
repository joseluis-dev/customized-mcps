/**
 * Public surface of the `authority` module.
 *
 * The shared base exports the `TokenAuthority` interface,
 * `LocalRosterAuthority` (dev/offline fallback, Phase 1a), and
 * `JwksAuthority` (production / shared-deployment backend, Phase 1b)
 * from this module. Adding a new backend means adding a class to
 * this module and re-exporting it here — the public API is
 * intentionally additive.
 */

export {
  AuthorityUnavailableError,
  TokenInvalidError,
  type LocalRosterAuthorityOptions,
  type TokenAuthority,
  type VerifiedToken,
  type VerifyContext,
} from "./types.js";
export { LocalRosterAuthority } from "./localRoster.js";
export { JwksAuthority, type JwksAuthorityOptions } from "./jwks.js";
