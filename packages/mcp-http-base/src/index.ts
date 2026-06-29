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
 * - `AgentRecord` is defined in `./auth.ts` and used by `./server.ts` so
 *   the public surface has a single source of truth.
 *
 * Application error codes (named JSON-RPC -3200x) live on `JSON_RPC_ERROR_CODES`
 * in `./errors.ts` so the envelope factories and any consumer code share
 * the same constants.
 */

export {
  parseHttpConfig,
  HttpConfigError,
  type HttpConfig,
  type HttpConfigInput,
  type LogFormat,
} from "./config.js";

export {
  loadAgents,
  validateBearer,
  constantTimeEqualString,
  matchScope,
  isValidKeyHash,
  isValidScope,
  KEY_HASH_PATTERN,
  SCOPE_PATTERN,
  type AgentRecord,
  type AuthorizedAgent,
  type ValidateBearerResult,
  type Scope,
} from "./auth.js";

/**
 * Phase 1a of `external-token-authority-verification` introduces the
 * `TokenAuthority` interface and the `LocalRosterAuthority`
 * implementation. `JwksAuthority` (Phase 1b) will be added to the
 * same module. The middleware in `server.ts` calls
 * `authority.verify(token)`; apps configure the backend in
 * `config/http.ts` and pass the result into `createHttpMcpServer`.
 */
export {
  LocalRosterAuthority,
  JwksAuthority,
  AuthorityUnavailableError,
  TokenInvalidError,
  type JwksAuthorityOptions,
  type LocalRosterAuthorityOptions,
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
