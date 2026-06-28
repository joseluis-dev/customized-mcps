/**
 * HTTP runtime config loader for the mcp-readonly-sql app.
 *
 * This module is the app-side glue between:
 * - the env contract documented in `.env.example` (single source of truth)
 * - the shared `@customized-mcps/mcp-http-base` package, which owns the actual
 *   `parseHttpConfig` and `loadAgents` primitives
 *
 * The function is pure from a dependency-injection point of view: it
 * reads `process.env` directly because env vars are the only source of
 * truth for runtime configuration, but it does NOT mutate env, register
 * signal handlers, or start any transport. The entrypoint calls this,
 * then hands the result to `transports/http.ts` which calls
 * `createHttpMcpServer`.
 *
 * Error policy (per the `mcp-agent-authorization` spec): every failure
 * is fatal at startup. The shared base already enforces strict numeric
 * parsing, loopback-only default, and HMAC secret length; this module
 * adds the agents loader (JSON or INLINE) on top of that, and maps
 * missing/invalid agent config to a clear stderr-friendly error.
 *
 * The `sessionMode` field is derived from the `MCP_HTTP_STATELESS` flag
 * so the app side never has to remember the boolean-to-string mapping.
 * PR1 re-review flipped the default to stateless; the app honors that
 * by mapping `undefined` to "stateless".
 */

import { readFileSync } from "node:fs";
import {
  parseHttpConfig,
  HttpConfigError,
  loadAgents,
  type AgentRecord,
  type HttpConfig,
  type SessionMode,
} from "@customized-mcps/mcp-http-base";

/**
 * The runtime config the HTTP transport needs to start the shared server.
 * It is the union of the validated `HttpConfig` (from the shared base)
 * plus the loaded `AgentRecord[]` and the derived `sessionMode` literal
 * that the shared base expects on the wire.
 */
export type HttpRuntimeConfig = HttpConfig & {
  agents: AgentRecord[];
  sessionMode: SessionMode;
  /**
   * Chunked-body opt-in. The shared base treats `false` and `undefined`
   * identically (rejects with 411). The app reads
   * `MCP_HTTP_ALLOW_UNBOUNDED_BODY` from the env and defaults to
   * `false` (the safe closed-by-default). The HTTP transport forwards
   * this value verbatim to `createHttpMcpServer`.
   */
  allowUnboundedBody: boolean;
};

export class HttpRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpRuntimeConfigError";
  }
}

/**
 * Strict boolean parser that mirrors the shared base's `parseBoolean`
 * semantics: only the literal string "true" (trimmed, case-insensitive)
 * is truthy. Every other value (including "1", "yes", "on", "") is
 * false. The shared base does not export this helper, so we keep a
 * private copy here to avoid leaking app internals into the public API
 * of `@customized-mcps/mcp-http-base`.
 */
function parseBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.trim().toLowerCase() === "true";
}

/**
 * Pure-from-the-outside function that reads the relevant env vars and
 * returns a validated `HttpRuntimeConfig`. Throws on any constraint
 * violation; the entrypoint is responsible for translating the error
 * to a non-zero process exit.
 */
export function loadHttpRuntimeConfig(): HttpRuntimeConfig {
  const httpInput: Parameters<typeof parseHttpConfig>[0] = {
    MCP_TRANSPORT: process.env.MCP_TRANSPORT,
    MCP_HTTP_HOST: process.env.MCP_HTTP_HOST,
    // Spec "Port Allocation Convention": mcp-readonly-sql MUST default to
    // MCP_HTTP_PORT=3001. The shared base defaults to 3000, so the app
    // overrides the default here. Explicit `MCP_HTTP_PORT` env still wins.
    MCP_HTTP_PORT: process.env.MCP_HTTP_PORT ?? "3001",
    MCP_HTTP_PATH: process.env.MCP_HTTP_PATH,
    MCP_HTTP_STATELESS: process.env.MCP_HTTP_STATELESS,
    MCP_HTTP_SHUTDOWN_TIMEOUT_MS: process.env.MCP_HTTP_SHUTDOWN_TIMEOUT_MS,
    MCP_LOG_FORMAT: process.env.MCP_LOG_FORMAT,
    MCP_AGENT_HMAC_SECRET: process.env.MCP_AGENT_HMAC_SECRET,
    MCP_AGENTS_JSON: process.env.MCP_AGENTS_JSON,
    MCP_AGENTS_INLINE: process.env.MCP_AGENTS_INLINE,
    MCP_HTTP_BEHIND_PROXY: process.env.MCP_HTTP_BEHIND_PROXY,
    MCP_HTTP_ALLOW_INSECURE_BIND: process.env.MCP_HTTP_ALLOW_INSECURE_BIND,
    MCP_HTTP_ALLOW_INSECURE_LOOPBACK: process.env.MCP_HTTP_ALLOW_INSECURE_LOOPBACK,
  };

  let http: HttpConfig;
  try {
    http = parseHttpConfig(httpInput);
  } catch (e) {
    if (e instanceof HttpConfigError) {
      throw new HttpRuntimeConfigError(e.message);
    }
    throw e;
  }

  // Resolve the agents source: MCP_AGENTS_JSON wins, MCP_AGENTS_INLINE
  // is the dev fallback. Per the mcp-agent-authorization spec, missing
  // both fails closed.
  let agentsJson: string;
  if (http.agentsJsonPath) {
    try {
      agentsJson = readFileSync(http.agentsJsonPath, "utf8");
    } catch (e) {
      throw new HttpRuntimeConfigError(
        `Failed to read MCP_AGENTS_JSON file at "${http.agentsJsonPath}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  } else if (http.agentsInline !== undefined) {
    agentsJson = http.agentsInline;
  } else {
    throw new HttpRuntimeConfigError(
      "HTTP mode requires at least one agent configured. " +
        "Set MCP_AGENTS_JSON (path to a JSON file) or MCP_AGENTS_INLINE (raw JSON string) " +
        "in the env. See apps/mcp-readonly-sql/.env.example for the format.",
    );
  }

  let agents: AgentRecord[];
  try {
    agents = loadAgents(agentsJson);
  } catch (e) {
    // The shared base throws plain Errors with parse/validation context.
    // Wrap so the entrypoint only needs to catch one error type.
    const message = e instanceof Error ? e.message : String(e);
    throw new HttpRuntimeConfigError(`Failed to load agent config: ${message}`);
  }

  if (agents.length === 0) {
    throw new HttpRuntimeConfigError(
      "HTTP mode requires at least one agent in MCP_AGENTS_JSON or MCP_AGENTS_INLINE; " +
        "received an empty list. Add at least one record with id, keyHash, and scopes.",
    );
  }

  return {
    ...http,
    agents,
    sessionMode: http.stateless ? "stateless" : "stateful",
    // Chunked-body opt-in (spec "Chunked POST with the opt-in"). The
    // .env.example and README document MCP_HTTP_ALLOW_UNBOUNDED_BODY;
    // the shared base already accepts the `allowUnboundedBody` option on
    // `createHttpMcpServer`. The app reads the env here, defaults to
    // false (the safe closed-by-default), and the HTTP transport forwards
    // it to the shared base.
    allowUnboundedBody: parseBoolean(process.env.MCP_HTTP_ALLOW_UNBOUNDED_BODY),
  };
}
