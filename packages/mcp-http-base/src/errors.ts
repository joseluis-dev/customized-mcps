/**
 * Sanitized error envelopes for the shared HTTP transport.
 *
 * The 401, 403, and 503 responses are produced from fixed factories that
 * accept only the information we want to expose. Any "context" parameter
 * MUST be ignored; the function is here to guarantee the response body
 * never leaks the supplied token, the agent's id, the resolved keyHash,
 * the list of valid agents, or the list of valid scopes.
 */

import type { ServerResponse } from "node:http";

/**
 * Named JSON-RPC error codes. The wire numbers are part of the contract
 * (clients SHOULD NOT depend on them, but the values are stable) — they
 * live in the -32000 application-error range reserved by JSON-RPC 2.0.
 *
 * Exposed as a single constant so the envelope factories and any future
 * test or consumer code share the same source of truth.
 */
export const JSON_RPC_ERROR_CODES = Object.freeze({
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32002,
  SERVICE_UNAVAILABLE: -32003,
} as const);

export type JsonRpcErrorBody = {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
};

export type ErrorEnvelope = {
  status: number;
  body: JsonRpcErrorBody;
};

/**
 * 401 Unauthorized. Returned for missing or invalid bearer tokens.
 *
 * The optional context is ignored on purpose. We never want to log the
 * supplied token, the agent id, the keyHash, or anything else here.
 */
export function unauthorizedError(_context?: unknown): ErrorEnvelope {
  return {
    status: 401,
    body: {
      jsonrpc: "2.0",
      error: { code: JSON_RPC_ERROR_CODES.UNAUTHORIZED, message: "unauthorized" },
      id: null,
    },
  };
}

/**
 * 403 Forbidden. Returned when the agent's scope set does not include
 * the scope required for the requested operation.
 *
 * We do not include the attempted operation, the agent's actual scopes,
 * or any other agent's scopes. Operators who need the full picture MUST
 * inspect the structured log line (which is itself sanitized).
 */
export function forbiddenError(_context?: unknown): ErrorEnvelope {
  return {
    status: 403,
    body: {
      jsonrpc: "2.0",
      error: { code: JSON_RPC_ERROR_CODES.FORBIDDEN, message: "forbidden" },
      id: null,
    },
  };
}

/**
 * 503 Service Unavailable. Returned when the process is draining for
 * shutdown, or when a new request arrives after a shutdown signal.
 */
export function serviceUnavailableError(_context?: unknown): ErrorEnvelope {
  return {
    status: 503,
    body: {
      jsonrpc: "2.0",
      error: {
        code: JSON_RPC_ERROR_CODES.SERVICE_UNAVAILABLE,
        message: "shutting-down",
      },
      id: null,
    },
  };
}

/**
 * Convenience helper: write an error envelope to a Node ServerResponse.
 * Always sets the Content-Type to application/json and calls end() so
 * the response is flushed.
 */
export function sendJsonError(res: ServerResponse, env: ErrorEnvelope): void {
  res.statusCode = env.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(env.body));
}
