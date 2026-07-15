/**
 * Canonical resource URI handling for RFC 8707 / RFC 9728.
 *
 * The shared base exposes a single canonicalization function so every
 * component (config parser, JWKS verifier, RFC 9728 metadata handler,
 * 401 `WWW-Authenticate` writer) compares the same way. The rules are:
 *
 *   - The URI MUST be an absolute HTTP/HTTPS URL.
 *   - HTTPS is REQUIRED in production. Loopback HTTP is permitted
 *     for local development only when `allowInsecure` is true.
 *   - The path and query components MUST NOT contain userinfo, a
 *     fragment, or a query component.
 *   - Hostname is lower-cased; trailing slashes on the path are
 *     stripped only when the path is empty.
 *
 * The canonicalization is intentionally narrow: it MUST NOT redirect
 * hostnames, normalize away path components, or transform a query
 * that an operator intentionally configured. The single normalization
 * is the trailing-slash strip, which exists so concatenation with
 * `/.well-known/...` produces a clean URL.
 */
export type CanonicalResourceErrorCode =
  | "invalid_scheme"
  | "invalid_host"
  | "invalid_userinfo"
  | "invalid_fragment"
  | "invalid_query";

export class ResourceUriError extends Error {
  public readonly code: CanonicalResourceErrorCode;
  constructor(code: CanonicalResourceErrorCode, message: string) {
    super(message);
    this.name = "ResourceUriError";
    this.code = code;
  }
}

export type CanonicalizeOptions = {
  /**
   * When true, permits `http://` and `http://127.0.0.1`, `http://[::1]`,
   * and `http://localhost`. Required for local dev / CI where HTTPS is
   * not terminated inside the test. Production callers MUST leave this
   * false.
   */
  allowInsecure?: boolean;
};

/**
 * Parse + canonicalize a resource URI. Throws `ResourceUriError` with a
 * stable `code` discriminator when the input violates the contract.
 *
 * Canonical form:
 *   - scheme: lowercase
 *   - host:   lowercase (no IDN to-ASCII conversion; the operator is
 *     responsible for the ASCII form)
 *   - port:   omitted when the default for the scheme; kept otherwise
 *   - path:   the original path; if empty, no trailing `/` is added
 */
export function canonicalizeResourceUri(
  raw: string,
  options: CanonicalizeOptions = {},
): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ResourceUriError(
      "invalid_scheme",
      "Resource URI must be a non-empty string",
    );
  }
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ResourceUriError(
      "invalid_scheme",
      `Resource URI is not a valid absolute URL: "${raw}"`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ResourceUriError(
      "invalid_scheme",
      `Resource URI scheme MUST be https (or http on loopback for dev); got "${url.protocol}"`,
    );
  }
  if (url.protocol === "http:" && !(options.allowInsecure === true)) {
    throw new ResourceUriError(
      "invalid_scheme",
      `Resource URI scheme MUST be https in production; got "${trimmed}". ` +
        `Set MCP_OAUTH_ALLOW_INSECURE_RESOURCE_HTTP=true only for local development.`,
    );
  }
  if (url.protocol === "http:" && options.allowInsecure === true) {
    const host = url.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      throw new ResourceUriError(
        "invalid_host",
        `Insecure HTTP resource URIs are only permitted on loopback hosts; got "${host}".`,
      );
    }
  }
  if (url.username !== "" || url.password !== "") {
    throw new ResourceUriError(
      "invalid_userinfo",
      `Resource URI MUST NOT include userinfo; got "${trimmed}".`,
    );
  }
  if (url.hash !== "") {
    throw new ResourceUriError(
      "invalid_fragment",
      `Resource URI MUST NOT include a fragment component; got "${trimmed}".`,
    );
  }
  if (url.search !== "") {
    throw new ResourceUriError(
      "invalid_query",
      `Resource URI MUST NOT include a query component; got "${trimmed}".`,
    );
  }
  // Normalize: lowercase scheme + host, strip trailing slash on empty path.
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  const canonical = url.toString();
  if (canonical.endsWith("/") && url.pathname === "/") {
    return canonical.slice(0, -1);
  }
  return canonical;
}

/**
 * Test whether `value` is a syntactically valid resource URI without
 * throwing. Used by config layers to produce aggregated error messages.
 */
export function isCanonicalResourceUri(value: string): boolean {
  try {
    canonicalizeResourceUri(value);
    return true;
  } catch {
    return false;
  }
}