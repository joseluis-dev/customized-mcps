/**
 * Shared client-IP helper for the OAuth handlers.
 *
 * Why this exists:
 * - The DCR, token, and authorize handlers all need the
 *   request IP for the per-IP rate limit and the audit
 *   `actor` / `ip` columns. The pre-PR audit found that
 *   `register.ts` and `authorize.ts` consulted
 *   `X-Forwarded-For` UNCONDITIONALLY. A spoofed header
 *   bypassed the per-IP DCR rate limit and the audit actor
 *   attribution (an attacker could mint audit rows under an
 *   arbitrary IP, or hold a single client behind a flood of
 *   spoofed XFF values).
 *
 * Policy:
 * - The default is to ignore `X-Forwarded-For` and read
 *   `req.socket.remoteAddress` (the direct TCP peer).
 * - The `trustProxy` flag (wired from the operator's
 *   `MCP_HTTP_BEHIND_PROXY=true` env) is the ONLY opt-in
 *   that activates the XFF path. There is no per-handler
 *   override; the policy is uniform.
 * - When the trust flag is set, the LEFTMOST entry of
 *   `X-Forwarded-For` is used (the convention most reverse
 *   proxies follow: each proxy appends the client IP, the
 *   most-recent hop is the rightmost).
 * - When neither XFF nor `remoteAddress` is available, the
 *   function returns `null`. The handler maps `null` to the
 *   same `unknown` actor shape the other audit fields use.
 *
 * The function is a thin wrapper so the handler-side logic
 * is uniform. A future change to the "rightmost untrusted"
 * pattern is a one-line edit here.
 */

import type { IncomingMessage } from "node:http";

/**
 * Read the request's effective client IP. Honors
 * `X-Forwarded-For` ONLY when `trustProxy` is true.
 *
 * @param req        The incoming HTTP request.
 * @param trustProxy When `true`, the function consults the
 *                   LEFTMOST `X-Forwarded-For` entry. When
 *                   `false` (the default), the function
 *                   returns `req.socket.remoteAddress` so a
 *                   spoofed XFF cannot bypass the per-IP
 *                   rate limit or the audit actor.
 * @returns The effective client IP, or `null` when no IP
 *          can be determined.
 */
export function readClientIp(
  req: IncomingMessage,
  trustProxy: boolean,
): string | null {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      const first = xff.split(",")[0]?.trim();
      if (first && first.length > 0) return first;
    }
    if (Array.isArray(xff) && xff.length > 0 && typeof xff[0] === "string") {
      const first = xff[0]?.trim();
      if (first && first.length > 0) return first;
    }
  }
  return req.socket.remoteAddress ?? null;
}
