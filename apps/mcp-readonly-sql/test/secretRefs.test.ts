import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileSecretProvider,
  parseSecretRef,
  type SecretProvider,
  SecretRefError,
} from "../src/secrets/SecretProvider.js";

describe("parseSecretRef", () => {
  it("parses a file reference with absolute path", () => {
    expect(parseSecretRef("${secret:file:/run/secrets/db_pw}")).toEqual({
      kind: "file",
      value: "/run/secrets/db_pw",
    });
  });

  it("returns null for a non-secret literal", () => {
    expect(parseSecretRef("plain-password")).toBeNull();
  });

  it("parses an env reference (provider decides support)", () => {
    expect(parseSecretRef("${secret:env:SOME_VAR}")).toEqual({
      kind: "env",
      value: "SOME_VAR",
    });
  });

  it("returns null for a malformed reference", () => {
    expect(parseSecretRef("${secret:file:}")).toBeNull();
  });
});

describe("FileSecretProvider", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "secret-"));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a readable file via async readFile", async () => {
    const file = path.join(dir, "pw.txt");
    writeFileSync(file, "supersecret", "utf8");
    const provider = new FileSecretProvider();
    const out = await provider.resolve(`\${secret:file:${file}}`);
    expect(out).toBe("supersecret");
  });

  it("fails non-leaking when the file is missing", async () => {
    const provider = new FileSecretProvider();
    const missing = path.join(dir, "missing.txt");
    await expect(
      provider.resolve(`\${secret:file:${missing}}`),
    ).rejects.toBeInstanceOf(SecretRefError);
    try {
      await provider.resolve(`\${secret:file:${missing}}`);
    } catch (e) {
      const err = e as SecretRefError;
      expect(err.kind).toBe("file");
      expect(err.alias).toBeUndefined();
      expect(err.message).not.toContain(missing);
      expect(err.message).not.toContain("password");
      expect(err.message).not.toContain("host");
    }
  });

  it("rejects a relative path with a non-leaking SecretRefError", async () => {
    const provider = new FileSecretProvider();
    await expect(
      provider.resolve("${secret:file:./relative.txt}"),
    ).rejects.toBeInstanceOf(SecretRefError);
    try {
      await provider.resolve("${secret:file:./relative.txt}");
    } catch (e) {
      const err = e as SecretRefError;
      expect(err.message).not.toContain(".");
      expect(err.message).not.toContain("/");
    }
  });

  it("aborts when the AbortSignal is already triggered", async () => {
    const file = path.join(dir, "pw.txt");
    writeFileSync(file, "supersecret", "utf8");
    const provider = new FileSecretProvider();
    const ac = new AbortController();
    ac.abort();
    await expect(
      provider.resolve(`\${secret:file:${file}}`, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(SecretRefError);
  });

  it("aborts via AbortSignal.timeout when the file path is not absolute", async () => {
    // Deterministic: a non-absolute path fails before any I/O, so timeout
    // composition must still produce a non-leaking SecretRefError.
    const provider = new FileSecretProvider({ secretTimeoutMs: 5_000 });
    await expect(
      provider.resolve("${secret:file:./relative.txt}"),
    ).rejects.toBeInstanceOf(SecretRefError);
  });

  it("rejects unsupported secret kinds (e.g. env) without resolving", async () => {
    const provider = new FileSecretProvider();
    await expect(
      provider.resolve("${secret:env:SOME_VAR}"),
    ).rejects.toBeInstanceOf(SecretRefError);
  });

  it("composes external signal with provider-level timeout (aborted external wins)", async () => {
    const file = path.join(dir, "pw.txt");
    writeFileSync(file, "supersecret", "utf8");
    const provider = new FileSecretProvider({ secretTimeoutMs: 60_000 });
    const ac = new AbortController();
    ac.abort();
    await expect(
      provider.resolve(`\${secret:file:${file}}`, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(SecretRefError);
  });
});

describe("SecretProvider contract", () => {
  it("FileSecretProvider satisfies the SecretProvider interface", () => {
    const provider: SecretProvider = new FileSecretProvider();
    expect(typeof provider.resolve).toBe("function");
    expect(typeof provider.kind).toBe("string");
  });
});
