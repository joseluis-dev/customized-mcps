const SENSITIVE_KEYS = [
  "password",
  "pass",
  "pwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "connectionstring",
  "connection_string",
];

const SECRET_REF_LITERAL = /\$\{secret:[^}]*\}/g;
const CONN_STRING_INLINE = /([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)([^@\s]+)@/g;
const BARE_CREDENTIALS = /(?<![A-Za-z0-9._+\-/])([A-Za-z0-9._+-]+):([A-Za-z0-9._+-]+)@/g;
const DSN_CRED_PAIR =
  /((?:password|passwd|pwd|user|uid)\s*=\s*)([^;\s]+)/gi;

function maskValue(key: string, value: unknown): unknown {
  const k = key.toLowerCase();
  if (SENSITIVE_KEYS.some((s) => k.includes(s))) {
    return "***";
  }
  return value;
}

function scrubValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") {
    if (/(?:password|passwd|pwd)\s*=\s*[^;\s]+/i.test(v)) {
      return v.replace(/(password|passwd|pwd)\s*=\s*[^;\s]+/gi, "$1=***");
    }
    if (/(?:user|uid)\s*=\s*[^;\s]+/i.test(v) && /(?:password|passwd|pwd)/i.test(v)) {
      return v;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(scrubValue);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = maskValue(k, scrubValue(val));
    }
    return out;
  }
  return v;
}

export function sanitizeErrorMessage(message: string): string {
  if (typeof message !== "string") return String(message);
  return message
    .replace(SECRET_REF_LITERAL, "${secret:***}")
    .replace(CONN_STRING_INLINE, "$1***@")
    .replace(BARE_CREDENTIALS, "***@")
    .replace(DSN_CRED_PAIR, (m, k) => `${k}***`)
    .replace(/(password|passwd|pwd)\s*=\s*[^;\s]+/gi, "$1=***")
    .replace(/(user|uid)\s*=\s*([^;\s]+)/gi, (m, p1, p2) => {
      if (/(password|passwd|pwd)/i.test(message)) return `${p1}=${p2}`;
      return m;
    });
}

export function sanitizeError(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) {
    return { message: sanitizeErrorMessage(err.message), name: err.name };
  }
  return { message: sanitizeErrorMessage(String(err)) };
}
