/**
 * Public API of @customized-mcps/mcp-http-base.
 *
 * The package is consumed by MCP apps in this workspace (PR2 wires
 * mcp-readonly-sql against it). The exports below are the only surface
 * the apps are expected to use.
 *
 * Canonical types:
 * - `LogFormat` is defined in `./config.ts` and re-exported by `./logging.ts`
 *   so the public surface has a single source of truth.
 * - `Scope` / `SCOPE_PATTERN` / `isValidScope` / `matchScope` are defined
 *   in `./auth.ts` and consumed by the authority implementations
 *   (`./authority/jwks.ts` and the OAuth admin apps) so the public
 *   surface has a single source of truth on the scope grammar.
 *
 * Application error codes (named JSON-RPC -3200x) live on `JSON_RPC_ERROR_CODES`
 * in `./errors.ts` so the envelope factories and any consumer code share
 * the same constants.
 */

export {
  parseHttpConfig,
  resolveResourceServerBaseUrl,
  HttpConfigError,
  type HttpConfig,
  type HttpConfigInput,
  type LogFormat,
  type ProtectedResourceMetadata,
  type ResourceServerRequestLike,
} from "./config.js";

export {
  matchScope,
  isValidScope,
  SCOPE_PATTERN,
  type Scope,
} from "./auth.js";

/**
 * Phase 1a of `external-token-authority-verification` introduces the
 * `TokenAuthority` interface. The shared base ships the production
 * backends: `JwksAuthority` (Phase 1b) and `OAuthAdminAuthority`
 * (PR 1 of `oauth-sqlite-admin-authorization`). The local HMAC
 * roster backend was removed when the OAuth admin authority became
 * the only token-verify surface; the resource server is now required
 * to wire `MCP_AUTHORITY_URL` against an external authority.
 */
export {
  JwksAuthority,
  OAuthAdminAuthority,
  AuthorityUnavailableError,
  TokenInvalidError,
  type JwksAuthorityOptions,
  type OAuthAdminAuthorityOptions,
  type TokenAuthority,
  type VerifiedToken,
  type VerifyContext,
} from "./authority/index.js";

export {
  createLogger,
  redactSensitive,
  type Logger,
  type LoggerOptions,
  type LogContext,
} from "./logging.js";

export {
  createShutdownController,
  type ShutdownController,
  type ShutdownDeps,
} from "./shutdown.js";

export {
  unauthorizedError,
  forbiddenError,
  serviceUnavailableError,
  sendJsonError,
  JSON_RPC_ERROR_CODES,
  type ErrorEnvelope,
  type JsonRpcErrorBody,
} from "./errors.js";

export {
  createHttpMcpServer,
  type HttpMcpServerOptions,
  type HttpMcpServerHandle,
  type McpServerFactory,
  type SessionMode,
} from "./server.js";
