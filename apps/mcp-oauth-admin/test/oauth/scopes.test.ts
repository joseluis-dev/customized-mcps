/**
 * Unit tests for the centralized scope resolution helper
 * (`src/oauth/scopes.ts`).
 *
 * The mcp-oauth-authority spec REQUIRES a uniform scope
 * policy across all three grants. The pre-2026
 * implementation let each grant resolve scopes on its
 * own, which produced three different policies (the
 * `password` grant used user scopes verbatim; the
 * `authorization_code` grant bound URL-requested
 * scopes to the code verbatim). The new helper is the
 * single source of truth for the policy.
 *
 * Test layer: unit. The helper is pure (no I/O, no
 * DB); the tests exercise every branch of the policy
 * without spinning up SQLite.
 */

import { describe, it, expect } from "vitest";
import {
  resolveGrantedScopes,
  boundRegistrationScope,
  type ScopePrincipal,
} from "../../src/oauth/scopes.js";

function principal(overrides: Partial<ScopePrincipal> = {}): ScopePrincipal {
  return {
    clientScopes: [],
    userScopes: [],
    defaultScope: "read:bi_catastro",
    catalogScopes: [],
    ...overrides,
  };
}

describe("resolveGrantedScopes — client_credentials grant", () => {
  it("empty request + empty client scopes → defaultScope (never `*`)", () => {
    const r = resolveGrantedScopes("client_credentials", "", principal());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["read:bi_catastro"]);
    expect(r.scopes).not.toContain("*");
  });

  it("empty request + client has scopes → client's scopes verbatim", () => {
    const r = resolveGrantedScopes(
      "client_credentials",
      "",
      principal({ clientScopes: ["read:bi_catastro", "list:bi_catastro"] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["read:bi_catastro", "list:bi_catastro"]);
  });

  it("specific request + client has the scope → granted", () => {
    const r = resolveGrantedScopes(
      "client_credentials",
      "read:bi_catastro",
      principal({ clientScopes: ["read:bi_catastro", "list:bi_catastro"] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["read:bi_catastro"]);
  });

  it("specific request + client lacks the scope → invalid_scope", () => {
    const r = resolveGrantedScopes(
      "client_credentials",
      "call:secret",
      principal({ clientScopes: ["read:bi_catastro"] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("` * ` request + client has `*` → granted as `*`", () => {
    const r = resolveGrantedScopes(
      "client_credentials",
      "*",
      principal({ clientScopes: ["*"] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["*"]);
  });

  it("` * ` request + client lacks `*` → invalid_scope", () => {
    const r = resolveGrantedScopes(
      "client_credentials",
      "*",
      principal({ clientScopes: ["read:bi_catastro"] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("mixed `*` + specific request → invalid_scope", () => {
    const r = resolveGrantedScopes(
      "client_credentials",
      "* read:bi_catastro",
      principal({ clientScopes: ["*", "read:bi_catastro"] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("request shape is not the SCOPE_PATTERN alphabet → invalid_scope", () => {
    const r = resolveGrantedScopes(
      "client_credentials",
      "delete:bi_catastro", // `delete` is not a valid verb
      principal({ clientScopes: ["read:bi_catastro"] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("request shape with bogus characters → invalid_scope", () => {
    const r = resolveGrantedScopes(
      "client_credentials",
      "read:bi_catastro!",
      principal({ clientScopes: ["read:bi_catastro"] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });
});

describe("resolveGrantedScopes — password grant (user AND client intersection)", () => {
  it("empty request + user + client non-empty → intersection", () => {
    const r = resolveGrantedScopes(
      "password",
      "",
      principal({
        userScopes: ["read:bi_catastro", "list:bi_catastro"],
        clientScopes: ["read:bi_catastro", "call:foo"],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["read:bi_catastro"]);
  });

  it("specific request + user + client non-empty → intersection with request", () => {
    const r = resolveGrantedScopes(
      "password",
      "read:bi_catastro list:bi_catastro",
      principal({
        userScopes: ["read:bi_catastro", "list:bi_catastro"],
        clientScopes: ["read:bi_catastro", "list:bi_catastro"],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["read:bi_catastro", "list:bi_catastro"]);
  });

  it("specific request when user has the scope but client does NOT → invalid_scope", () => {
    // Privilege-escalation regression: a user with
    // `*` could previously mint a token with `*`
    // through a client with no scopes. The fix is the
    // intersection; without the client's `*`, the
    // `*` is not grantable.
    const r = resolveGrantedScopes(
      "password",
      "read:secret",
      principal({
        userScopes: ["read:secret", "read:bi_catastro"],
        clientScopes: ["read:bi_catastro"],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("empty user scopes + client has scopes → use client scopes (the pre-2026 fallback)", () => {
    const r = resolveGrantedScopes(
      "password",
      "",
      principal({
        userScopes: [],
        clientScopes: ["read:bi_catastro"],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["read:bi_catastro"]);
  });

  it("empty client scopes + user has scopes → use user scopes (the pre-2026 fallback)", () => {
    const r = resolveGrantedScopes(
      "password",
      "",
      principal({
        userScopes: ["read:bi_catastro"],
        clientScopes: [],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["read:bi_catastro"]);
  });

  it("both empty + empty request → defaultScope (the spec's safe default)", () => {
    const r = resolveGrantedScopes("password", "", principal());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["read:bi_catastro"]);
  });

  it("` * ` request + both have `*` → granted as `*`", () => {
    const r = resolveGrantedScopes(
      "password",
      "*",
      principal({
        userScopes: ["*"],
        clientScopes: ["*"],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["*"]);
  });

  it("` * ` request + user has `*` but client does NOT → invalid_scope (privilege escalation closed)", () => {
    // The exact bug from the user's report: a user
    // with `*` could previously mint a token with
    // `*` through a client with `read:bi_catastro`
    // only. The fix is the intersection.
    const r = resolveGrantedScopes(
      "password",
      "*",
      principal({
        userScopes: ["*"],
        clientScopes: ["read:bi_catastro"],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("mixed `*` + specific request → invalid_scope", () => {
    const r = resolveGrantedScopes(
      "password",
      "* read:bi_catastro",
      principal({
        userScopes: ["*"],
        clientScopes: ["*", "read:bi_catastro"],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });
});

describe("resolveGrantedScopes — authorization_code grant (user AND client intersection)", () => {
  it("empty request + user + client non-empty → intersection (matches the consent handler)", () => {
    const r = resolveGrantedScopes(
      "authorization_code",
      "",
      principal({
        userScopes: ["read:bi_catastro", "list:bi_catastro"],
        clientScopes: ["read:bi_catastro", "call:foo"],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["read:bi_catastro"]);
  });

  it("URL request + user + client non-empty → intersection with request", () => {
    // The user's exact bug scenario: a crafted
    // `scope=call:secret` URL is bounded by the
    // user + client intersection. The consent handler
    // calls this helper at issue time.
    const r = resolveGrantedScopes(
      "authorization_code",
      "call:secret",
      principal({
        userScopes: ["read:bi_catastro"],
        clientScopes: ["read:bi_catastro"],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("URL request with a scope BOTH principals allow → granted", () => {
    const r = resolveGrantedScopes(
      "authorization_code",
      "read:bi_catastro",
      principal({
        userScopes: ["read:bi_catastro"],
        clientScopes: ["read:bi_catastro", "list:bi_catastro"],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toEqual(["read:bi_catastro"]);
  });

  it("` * ` URL request + only one principal allows `*` → invalid_scope", () => {
    // The exact bug from the user's report.
    const r = resolveGrantedScopes(
      "authorization_code",
      "*",
      principal({
        userScopes: ["*"],
        clientScopes: ["read:bi_catastro"],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });
});

describe("boundRegistrationScope — DCR scope policy", () => {
  it("empty catalog + empty request → defaultScope", () => {
    // The DCR safety default: an authority that
    // hasn't curated a catalog cannot self-grant
    // arbitrary scopes.
    const r = boundRegistrationScope("", [], "read:bi_catastro");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.granted).toBe("read:bi_catastro");
  });

  it("empty catalog + non-empty request → defaultScope (request ignored)", () => {
    // The pre-2026 permissive DCR was a security
    // hole. The fix: when the catalog is empty, the
    // request cannot self-elevate; the default is
    // the only granted scope.
    const r = boundRegistrationScope("*", [], "read:bi_catastro");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.granted).toBe("read:bi_catastro");
  });

  it("non-empty catalog + empty request → defaultScope", () => {
    const r = boundRegistrationScope(
      "",
      ["read:bi_catastro", "list:bi_catastro"],
      "read:bi_catastro",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.granted).toBe("read:bi_catastro");
  });

  it("non-empty catalog + in-catalog request → granted (intersection)", () => {
    const r = boundRegistrationScope(
      "read:bi_catastro call:secret",
      ["read:bi_catastro", "list:bi_catastro"],
      "read:bi_catastro",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.granted).toBe("read:bi_catastro");
  });

  it("non-empty catalog + out-of-catalog request → invalid_scope", () => {
    const r = boundRegistrationScope(
      "call:secret",
      ["read:bi_catastro"],
      "read:bi_catastro",
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("non-empty catalog including `*` + `*` request → granted as `*`", () => {
    const r = boundRegistrationScope("*", ["*", "read:bi_catastro"], "read:bi_catastro");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.granted).toBe("*");
  });

  it("non-empty catalog without `*` + `*` request → invalid_scope", () => {
    const r = boundRegistrationScope("*", ["read:bi_catastro"], "read:bi_catastro");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });

  it("mixed `*` + specific request → invalid_scope", () => {
    const r = boundRegistrationScope(
      "* read:bi_catastro",
      ["*", "read:bi_catastro"],
      "read:bi_catastro",
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_scope");
  });
});
