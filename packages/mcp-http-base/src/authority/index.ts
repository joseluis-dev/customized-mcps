/**
 * Public surface of the `authority` module.
 *
 * The shared base exports the `TokenAuthority` interface and the
 * `JwksAuthority` / `OAuthAdminAuthority` implementations from
 * this module. The resource-server middleware calls
 * `authority.verify(token)` for every request; the local HMAC
 * roster backend has been removed in favour of the OAuth admin
 * authority. Adding a new backend means adding a class to this
 * module and re-exporting it here — the public API is
 * intentionally additive.
 */

export {
  AuthorityUnavailableError,
  TokenInvalidError,
  type TokenAuthority,
  type VerifiedToken,
  type VerifyContext,
} from "./types.js";
export { JwksAuthority, type JwksAuthorityOptions } from "./jwks.js";
export { OAuthAdminAuthority, type OAuthAdminAuthorityOptions } from "./oauthAdmin.js";
