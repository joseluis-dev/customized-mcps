/**
 * Shared body reader for the OAuth handlers.
 *
 * Why this exists:
 * - The DCR handler (`oauth/register.ts`) already had a typed
 *   `BodyTooLargeError` path: on an oversized body, the request
 *   stream is `pause()`d (NOT `destroy()`d) and the handler's
 *   top-level catch returns a sanitized 400 JSON.
 * - The token, authorize, and introspect handlers historically
 *   used `req.destroy()` on the cap-exceeded path. That converted
 *   an oversize 400 into a connection reset and broke the spec's
 *   sanitized-error contract (the client never sees the JSON).
 *   The pre-PR review flagged this as a production hardening gap.
 *
 * The helpers here are the single source of truth for the
 * "oversized body" boundary across every OAuth handler. The
 * shape mirrors the DCR handler so future maintainers do not
 * reinvent a different error model.
 *
 * Audit-safety:
 * - The reader is non-validating: it returns the parsed value
 *   verbatim. A malformed body returns `null` for JSON and an
 *   empty `URLSearchParams` for form-encoded. The handler is
 *   responsible for shaping the sanitized error response.
 * - The reader NEVER logs the body. The error message is a
 *   stable reason code; the cap is a number. No body bytes,
 *   no client secrets, no tokens.
 *
 * Implementation note: the request stream is `pause()`d on the
 * cap-exceeded path so the handler can write the sanitized 400
 * before the client finishes sending. The socket is closed by
 * the normal `end` event when the client is done; the spec's
 * "respond before the body is fully received" rule is honored.
 */

import type { IncomingMessage } from "node:http";

/**
 * The default body cap for OAuth handlers. 64 KiB is more than
 * enough for the largest documented `redirect_uris` list (well
 * under 1 KiB) and is the same cap the DCR handler used.
 */
export const DEFAULT_BODY_CAP = 64 * 1024;

/**
 * The error raised when the request body exceeds the cap. The
 * handler's top-level `catch` distinguishes this from a generic
 * `Error` so the response is the spec-mandated sanitized 400
 * (JSON for the token endpoint, HTML for the authorize flow),
 * not a 500.
 *
 * The `cap` field is exposed for tests / log lines that need to
 * surface the cap verbatim. The handler MUST NOT include the
 * actual received byte count in the response (that would let an
 * attacker probe the cap by observing the response shape).
 */
export class BodyTooLargeError extends Error {
  readonly cap: number;
  constructor(cap: number) {
    super(`request body exceeded ${cap} bytes`);
    this.name = "BodyTooLargeError";
    this.cap = cap;
  }
}

/**
 * Read the request body as JSON. The function is deliberately
 * defensive: a malformed body, an empty body, or a non-JSON
 * body returns `null` (the caller maps this to
 * `400 invalid_request`). A body that exceeds the cap rejects
 * with a typed `BodyTooLargeError` so the handler can return
 * a sanitized 400 without crashing the listener.
 *
 * The `cap` parameter is optional; the default is
 * `DEFAULT_BODY_CAP`.
 *
 * Implementation note: the `settled` flag prevents the
 * promise from being settled twice (e.g. when a late
 * `error` event fires after a `BodyTooLargeError` rejection,
 * which would otherwise surface as an unhandled rejection).
 * The flag is set immediately BEFORE the settle call so a
 * `JSON.parse` failure inside the settle call does not leave
 * the promise in a half-settled state.
 */
export async function readJsonBody(
  req: IncomingMessage,
  cap: number = DEFAULT_BODY_CAP,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolveP, rejectP) => {
    let aborted = false;
    let settled = false;
    const settleResolve = (value: unknown): void => {
      if (settled) return;
      settled = true;
      resolveP(value);
    };
    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      rejectP(err);
    };
    req.on("data", (chunk: Buffer) => {
      if (aborted || settled) return;
      total += chunk.length;
      if (total > cap) {
        aborted = true;
        // Pause the stream instead of destroying it.
        // The handler will write a sanitized 400 + the
        // request socket is closed cleanly by the
        // `end` event when the client is done sending.
        req.pause();
        settleReject(new BodyTooLargeError(cap));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted || settled) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) {
        settleResolve(null);
        return;
      }
      // Parse the JSON OUTSIDE the settle call so a
      // parse failure can fall through to a `null`
      // resolve (the caller maps `null` to a sanitized
      // 400). Calling `resolveP(JSON.parse(...))` in a
      // single statement would let the `JSON.parse`
      // throw escape and the promise would never
      // settle.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      settleResolve(parsed);
    });
    req.on("error", (e) => {
      if (settled) return;
      settleReject(e);
    });
  });
}

/**
 * Read the request body as form-encoded data. The function
 * returns a `URLSearchParams` instance; missing fields are
 * looked up with the standard `.get()` API (which returns
 * `null`). An empty body returns an empty params set (this
 * matches the introspect endpoint's RFC 7662 probe contract:
 * the resource server's `OAuthAdminAuthority.warm()` sends
 * `token=` to confirm the endpoint is alive).
 *
 * A body that exceeds the cap rejects with a typed
 * `BodyTooLargeError` so the handler can return a sanitized
 * 400 without crashing the listener.
 */
export async function readFormBody(
  req: IncomingMessage,
  cap: number = DEFAULT_BODY_CAP,
): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolveP, rejectP) => {
    let aborted = false;
    let settled = false;
    const settleResolve = (value: URLSearchParams): void => {
      if (settled) return;
      settled = true;
      resolveP(value);
    };
    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      rejectP(err);
    };
    req.on("data", (chunk: Buffer) => {
      if (aborted || settled) return;
      total += chunk.length;
      if (total > cap) {
        aborted = true;
        req.pause();
        settleReject(new BodyTooLargeError(cap));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted || settled) return;
      const text = Buffer.concat(chunks).toString("utf8");
      settleResolve(new URLSearchParams(text));
    });
    req.on("error", (e) => {
      if (settled) return;
      settleReject(e);
    });
  });
}
