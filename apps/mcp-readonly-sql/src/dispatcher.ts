/**
 * Transport dispatcher for the mcp-readonly-sql app.
 *
 * The app's wire entrypoint (`src/index.ts`) reads `MCP_TRANSPORT` from the
 * environment and dispatches to either the stdio transport (the historical
 * default that MCP hosts spawn as a child process) or the Streamable HTTP
 * transport (the new opt-in that lets several agents share one process
 * behind a reverse proxy).
 *
 * The decision is encapsulated in the pure function `selectTransport` so it
 * is trivial to unit-test without mutating `process.env`. The caller
 * (the entrypoint) is responsible for translating an unknown value to a
 * non-zero process exit with a stderr message — keeping the failure mode
 * in one place means the test surface stays narrow.
 *
 * Per the `mcp-http-transport` spec:
 * - Default is `stdio` (so existing desktop hosts keep working with no
 *   configuration change).
 * - Allowed values are `stdio` and `streamableHttp` (case-insensitive;
 *   surrounding whitespace is trimmed).
 * - Any other value is an error: the entrypoint exits non-zero and the
 *   stderr message names the allowed values.
 */

export type Transport = "stdio" | "streamableHttp";

const ALLOWED_VALUES: ReadonlyArray<Transport> = ["stdio", "streamableHttp"];

/**
 * Pure function that turns the env-shaped input into the chosen transport.
 *
 * - `undefined`, empty string, or whitespace-only → `"stdio"` (the default).
 * - `"stdio"` / `"streamableHttp"` (case-insensitive, trimmed) → the
 *   matching canonical value.
 * - Anything else throws an `Error` whose message names the allowed values
 *   so the entrypoint can surface the error to stderr verbatim.
 *
 * The function is intentionally pure: no `process.env` reads, no side
 * effects. Tests pass a string in directly; the entrypoint reads
 * `process.env.MCP_TRANSPORT` and forwards the value here.
 */
export function selectTransport(value: string | undefined): Transport {
  if (value === undefined) return "stdio";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "stdio";
  const lower = trimmed.toLowerCase();
  if (lower === "stdio" || lower === "streamablehttp") {
    // Normalize the case so the rest of the code never has to.
    return lower === "stdio" ? "stdio" : "streamableHttp";
  }
  throw new Error(
    `MCP_TRANSPORT must be one of: ${ALLOWED_VALUES.join(", ")}; got "${value}".`,
  );
}
