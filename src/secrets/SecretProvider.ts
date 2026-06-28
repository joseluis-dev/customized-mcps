import { readFile } from "node:fs/promises";

export type ParsedSecretRef = {
  kind: string;
  value: string;
};

export const SECRET_REF_PREFIX = "${secret:";

export class SecretRefError extends Error {
  readonly kind: string;
  readonly alias: string | undefined;
  constructor(kind: string, alias: string | undefined, message: string) {
    super(message);
    this.name = "SecretRefError";
    this.kind = kind;
    this.alias = alias;
  }
}

export interface SecretProvider {
  readonly kind: string;
  resolve(
    ref: string,
    options?: { alias?: string; signal?: AbortSignal },
  ): Promise<string>;
}

export interface FileSecretProviderOptions {
  secretTimeoutMs?: number;
}

export class FileSecretProvider implements SecretProvider {
  readonly kind = "file";
  private readonly secretTimeoutMs: number | undefined;

  constructor(options: FileSecretProviderOptions = {}) {
    this.secretTimeoutMs = options.secretTimeoutMs;
  }

  async resolve(
    ref: string,
    options: { alias?: string; signal?: AbortSignal } = {},
  ): Promise<string> {
    const parsed = parseSecretRef(ref);
    if (!parsed || parsed.kind !== "file") {
      throw new SecretRefError(
        parsed?.kind ?? "unknown",
        options.alias,
        `Unsupported secret reference`,
      );
    }
    if (!isAbsolutePath(parsed.value)) {
      throw new SecretRefError("file", options.alias, `Secret path must be absolute`);
    }
    const signal = composeSignal(options.signal, this.secretTimeoutMs);
    try {
      const buf = await readFile(parsed.value, { encoding: "utf8", signal });
      return buf;
    } catch (e) {
      const name = (e as NodeJS.ErrnoException).name ?? "";
      const code = (e as NodeJS.ErrnoException).code ?? "";
      const kind =
        name === "AbortError" || signal?.aborted ? "timeout" : "file";
      if (kind === "timeout") {
        throw new SecretRefError("file", options.alias, `Secret resolution timed out`);
      }
      if (code === "ENOENT") {
        throw new SecretRefError("file", options.alias, `Secret file is not available`);
      }
      throw new SecretRefError("file", options.alias, `Secret file could not be read`);
    }
  }
}

function isAbsolutePath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  return false;
}

function composeSignal(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (external && typeof timeoutMs === "number" && timeoutMs > 0) {
    return AbortSignal.any([external, AbortSignal.timeout(timeoutMs)]);
  }
  if (external) return external;
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

export function parseSecretRef(input: string): ParsedSecretRef | null {
  if (typeof input !== "string") return null;
  if (!input.startsWith(SECRET_REF_PREFIX) || !input.endsWith("}")) {
    return null;
  }
  const inner = input.slice(SECRET_REF_PREFIX.length, -1);
  const colon = inner.indexOf(":");
  if (colon <= 0) return null;
  const kind = inner.slice(0, colon).trim();
  const value = inner.slice(colon + 1).trim();
  if (kind.length === 0 || value.length === 0) return null;
  return { kind, value };
}
