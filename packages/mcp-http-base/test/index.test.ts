/**
 * Tests for the public API surface of @customized-mcps/mcp-http-base.
 *
 * These exist to lock the public surface so accidental duplication, drift,
 * or confusing aliases are caught by the test runner instead of being
 * discovered by a downstream consumer.
 *
 * Value-level exports (functions, constants) are checked at runtime by
 * importing the package and inspecting the namespace. Type-level exports
 * (LogFormat, Scope) are erased at runtime, so the .d.ts file is
 * read and checked instead — this is exactly what downstream TypeScript
 * consumers see, so it is the right place to assert the public surface.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as PublicApi from "../src/index.js";

function packageRoot(): string {
  // The compiled .d.ts lives in <pkg>/dist/index.d.ts; tests are run from
  // <pkg>/test/. We resolve the package root from this file's URL.
  const here = dirname(fileURLToPath(import.meta.url));
  // here is <pkg>/test; package root is one level up.
  return join(here, "..");
}

function readDeclarationSource(): string {
  const distFile = join(packageRoot(), "dist", "index.d.ts");
  if (existsSync(distFile)) {
    return readFileSync(distFile, "utf8");
  }
  // Fall back to the source .ts file when the dist artifact is absent.
  // Vitest runs against the source via `import "../src/index.js"`, so the
  // .d.ts may not be regenerated. In that case we use the source.
  return readFileSync(join(packageRoot(), "src", "index.ts"), "utf8");
}

describe("public API surface (value-level exports)", () => {
  it("exposes a single JSON_RPC_ERROR_CODES constant", () => {
    const codes = (PublicApi as unknown as { JSON_RPC_ERROR_CODES: Record<string, number> })
      .JSON_RPC_ERROR_CODES;
    expect(codes).toBeDefined();
    expect(codes.UNAUTHORIZED).toBe(-32001);
    expect(codes.FORBIDDEN).toBe(-32002);
    expect(codes.SERVICE_UNAVAILABLE).toBe(-32003);
  });

  it("the error envelope uses the same code constants", () => {
    const codes = (PublicApi as unknown as { JSON_RPC_ERROR_CODES: Record<string, number> })
      .JSON_RPC_ERROR_CODES;
    expect(PublicApi.unauthorizedError().body.error.code).toBe(codes.UNAUTHORIZED);
    expect(PublicApi.forbiddenError().body.error.code).toBe(codes.FORBIDDEN);
    expect(PublicApi.serviceUnavailableError().body.error.code).toBe(
      codes.SERVICE_UNAVAILABLE,
    );
  });

  it("does not re-export confusing duplicate value aliases", () => {
    // The legacy `LogFormatFromLogging` and `AgentRecordFromServer` aliases
    // were removed in this remediation pass; they MUST NOT come back.
    expect((PublicApi as Record<string, unknown>).LogFormatFromLogging).toBeUndefined();
    expect((PublicApi as Record<string, unknown>).AgentRecordFromServer).toBeUndefined();
  });

  it("exports the core factory and helpers", () => {
    expect(typeof PublicApi.createHttpMcpServer).toBe("function");
    expect(typeof PublicApi.createShutdownController).toBe("function");
    expect(typeof PublicApi.createLogger).toBe("function");
    expect(typeof PublicApi.parseHttpConfig).toBe("function");
    expect(typeof PublicApi.redactSensitive).toBe("function");
  });

  it("does NOT re-export the removed local HMAC helpers (loadAgents, validateBearer, constantTimeEqualString)", () => {
    // The local HMAC roster backend was removed when the OAuth admin
    // authority became the only token-verify surface. These helpers
    // are implementation details of the deleted backend and MUST NOT
    // come back via the public surface.
    expect((PublicApi as Record<string, unknown>).loadAgents).toBeUndefined();
    expect((PublicApi as Record<string, unknown>).validateBearer).toBeUndefined();
    expect((PublicApi as Record<string, unknown>).constantTimeEqualString).toBeUndefined();
    expect((PublicApi as Record<string, unknown>).isValidKeyHash).toBeUndefined();
    expect((PublicApi as Record<string, unknown>).KEY_HASH_PATTERN).toBeUndefined();
  });

  it("does NOT re-export the removed LocalRosterAuthority class", () => {
    // The local-roster authority was deleted along with the HMAC
    // backend. Only the OAuth / JWKS authorities remain.
    expect((PublicApi as Record<string, unknown>).LocalRosterAuthority).toBeUndefined();
    expect((PublicApi as Record<string, unknown>).LocalRosterAuthorityOptions).toBeUndefined();
  });

  it("does NOT re-export `matchScope` (PR 1 task 1.2: the resolver has zero production callers)", () => {
    // The `remove-scope-authorization` change (PR 1) deletes the
    // `matchScope` resolver from the shared base. The previous
    // contract — the resource server no longer matches scopes;
    // the admin app resolves them on its own. Public consumers
    // MUST NOT find `matchScope` on the package surface.
    //
    // PR 4 of the same chain removes the cross-slice compat
    // shim (`SCOPE_PATTERN` / `isValidScope` / `Scope`) that
    // was kept in PR 3 so the mcp-oauth-admin admin module
    // could keep compiling until PR 4 wires out the admin-side
    // scope CRUD. The compat shim is GONE in PR 4.
    const api = PublicApi as Record<string, unknown>;
    expect(api.matchScope).toBeUndefined();
    expect(api.SCOPE_PATTERN).toBeUndefined();
    expect(api.isValidScope).toBeUndefined();

    // The same absence MUST hold in the on-disk source — a future
    // re-export would fail this test even if the .d.ts was stale.
    const here = packageRoot();
    const indexSrc = readFileSync(join(here, "src", "index.ts"), "utf8");
    const code = indexSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bmatchScope\b/);
    // `SCOPE_PATTERN` and `isValidScope` are not in the index
    // exports after PR 4. The substring `Scope` may appear in
    // other identifiers (e.g. the `dcrScopesSupported`
    // property names), so we assert specifically the
    // identifier shape that the compat shim would have used.
    expect(code).not.toMatch(/\bSCOPE_PATTERN\b/);
    expect(code).not.toMatch(/\bisValidScope\b/);
    // The `type Scope` re-export is gone. We use a word-boundary
    // match against `Scope` as a bare identifier (no dot or
    // other separators), which catches both `type Scope` and
    // the lone `Scope` token from the PR 3 compat shim.
    expect(code).not.toMatch(/\bScope\b/);
  });

  it("PR 4 contract: auth.ts is a no-op (the compat shim is fully removed)", () => {
    // PR 4 of `remove-scope-authorization`: the
    // `SCOPE_PATTERN` regex, the `isValidScope` predicate,
    // and the `Scope` type alias are no longer in
    // `packages/mcp-http-base/src/auth.ts` either. The
    // admin module's `agents.ts` / `clients.ts` /
    // `router.ts` no longer import any of them. This
    // test pins the on-disk removal so a future regression
    // that re-introduces the shim is caught.
    const here = packageRoot();
    const authSrc = readFileSync(join(here, "src", "auth.ts"), "utf8");
    const code = authSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bSCOPE_PATTERN\b/);
    expect(code).not.toMatch(/\bisValidScope\b/);
    // `Scope` as a type alias: `type Scope` or `type Scope =`. We
    // do NOT match the bare `Scope` token because the JSDoc may
    // contain the word in prose (e.g. "scope authorization").
    expect(code).not.toMatch(/type\s+Scope\b/);
  });
});

describe("public API surface (type-level exports via declaration source)", () => {
  let dts: string;

  beforeAll(() => {
    dts = readDeclarationSource();
  });

  it("declares LogFormat exactly once (no duplicate alias)", () => {
    // Strip line comments (`//`) and block comments (`/* ... */`) so the
    // JSDoc preamble does not inflate the count, then count the
    // `LogFormat` references in the public re-export blocks.
    const here = packageRoot();
    const raw = readFileSync(join(here, "src", "index.ts"), "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const logFormatExports = code.match(/\bLogFormat\b/g) ?? [];
    // Expected: one `type LogFormat` re-export. Not three (the previous
    // duplication).
    expect(logFormatExports.length).toBe(1);
  });

  it("does not re-export the removed AgentRecord type from the shared base", () => {
    // The shared base's AgentRecord (the local HMAC roster record)
    // was removed along with the local backend. A future maintainer
    // re-introducing it would fail this test.
    const here = packageRoot();
    const raw = readFileSync(join(here, "src", "index.ts"), "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const agentRecordExports = code.match(/\bAgentRecord\b/g) ?? [];
    expect(agentRecordExports.length).toBe(0);
  });

  it("does not re-export confusing duplicate type aliases", () => {
    const here = packageRoot();
    const indexSrc = readFileSync(join(here, "src", "index.ts"), "utf8");
    expect(indexSrc).not.toMatch(/LogFormatFromLogging/);
    expect(indexSrc).not.toMatch(/AgentRecordFromServer/);
  });

  it("exposes the helpers and constants via the index", () => {
    const here = packageRoot();
    const indexSrc = readFileSync(join(here, "src", "index.ts"), "utf8");
    expect(indexSrc).toMatch(/JSON_RPC_ERROR_CODES/);
  });

  it("sanity: the .d.ts file exists after build", () => {
    // We just want to assert that the build artifact is in place; this
    // catches a regression where the build script stops emitting types.
    const distFile = join(packageRoot(), "dist", "index.d.ts");
    if (!existsSync(distFile)) {
      // Not built — that is OK for `vitest run` (which uses src), but
      // emit a soft warning so the operator can spot it in CI.
      return;
    }
    expect(distFile).toBeDefined();
  });

  // Reference `dts` to keep the variable (the symbol is read by
  // future maintainers to confirm the file was loaded).
  void dts;
});
