/**
 * Structured logger for the shared HTTP transport.
 *
 * Two formats:
 * - `text`: human-readable key=value pairs, one line per event.
 * - `json`: one-line JSON object per event with `ts`, `level`, `msg`, and
 *   optional `agentId` / `requestId` fields.
 *
 * In HTTP mode, log lines are written to stderr ONLY. stdout is reserved
 * for the transport stream and MUST NOT contain any diagnostic output.
 *
 * Sensitive fragments (bearer tokens, keyHash values, HMAC secret values)
 * are redacted from every log line regardless of format.
 */

import type { LogFormat } from "./config.js";

export type { LogFormat };

export type LogContext = {
  agentId?: string;
  requestId?: string;
  /**
   * The JWT `kid` (key id) for kid-miss WARN lines on the
   * JWKS authority backend. Phase 1b added this field so the
   * structured log can be indexed by the missing kid without
   * re-parsing the message body.
   */
  kid?: string;
  /**
   * The first 8 hex chars of SHA-256(token) — the token
   * fingerprint prefix. Phase 1b added this for the same
   * reason as `kid`: indexed in the structured log so
   * operators can correlate a kid-miss WARN with a captured
   * token without seeing the full token in the message body.
   */
  tokenFp?: string;
};

export type Logger = {
  info: (msg: string, ctx?: LogContext) => void;
  warn: (msg: string, ctx?: LogContext) => void;
  error: (msg: string, ctx?: LogContext) => void;
};

export type LoggerOptions = {
  format: LogFormat;
  /** Override the writer for testing; defaults to `process.stderr.write`. */
  write?: (line: string) => void;
};

/**
 * Redact sensitive fragments from a log message. The redaction is
 * deliberately conservative — when in doubt, redact.
 */
export function redactSensitive(message: string): string {
  if (typeof message !== "string" || message.length === 0) return message;
  let out = message;

  // Bearer token in an Authorization header value (case-insensitive).
  // The token is whatever non-whitespace sequence follows the keyword.
  out = out.replace(/Bearer\s+[^\s,;"'`]+/gi, "Bearer [REDACTED]");

  // Hex-shaped 64-char keyHash values (the SHA-256 of the agent token).
  // Use a negative lookahead so we don't break on a longer run of hex
  // characters that happens to contain a 64-char substring.
  out = out.replace(/[a-fA-F0-9]{64}(?![a-fA-F0-9])/g, "[REDACTED]");

  // MCP_AGENT_HMAC_SECRET values: "name: value" pairs.
  out = out.replace(
    /(MCP_AGENT_HMAC_SECRET\s*[:=]\s*)([^\s,;]+)/gi,
    "$1[REDACTED]",
  );

  return out;
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? defaultWrite;

  function emit(level: "info" | "warn" | "error", msg: string, ctx?: LogContext) {
    const safeMsg = redactSensitive(msg);
    if (options.format === "json") {
      const line: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        msg: safeMsg,
      };
      if (ctx?.agentId) line.agentId = ctx.agentId;
      if (ctx?.requestId) line.requestId = ctx.requestId;
      write(JSON.stringify(line));
    } else {
      const parts = [safeMsg];
      if (ctx?.agentId) parts.push(`agentId=${ctx.agentId}`);
      if (ctx?.requestId) parts.push(`requestId=${ctx.requestId}`);
      write(`[${level.toUpperCase()}] ${parts.join(" ")}`);
    }
  }

  return {
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
  };
}

function defaultWrite(line: string): void {
  process.stderr.write(line + "\n");
}
