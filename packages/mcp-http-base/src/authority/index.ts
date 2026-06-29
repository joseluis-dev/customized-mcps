/**
 * Public surface of the `authority` module.
 *
 * The shared base exports the `TokenAuthority` interface and
 * `LocalRosterAuthority` from this module. `JwksAuthority` lands
 * in Phase 1b and is exported from the same module to keep the
 * public API additive.
 */

export {
  AuthorityUnavailableError,
  TokenInvalidError,
  type LocalRosterAuthorityOptions,
  type TokenAuthority,
  type VerifiedToken,
} from "./types.js";
export { LocalRosterAuthority } from "./localRoster.js";
