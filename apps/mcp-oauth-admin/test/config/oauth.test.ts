/**
 * Tests for `loadOAuthConfig`.
 *
 * The OAuth wiring is opt-in: an authority that is NOT an OAuth
 * server (e.g. legacy / disabled mode) still boots. The hard
 * requirements are:
 *   - When `MCP_AUTHORITY_URL` is set, `MCP_OAUTH_ALLOWED_RESOURCES`
 *     MUST also be set (and vice versa).
 *   - Every value MUST canonicalize via the shared
 *     `canonicalizeResourceUri` helper.
 *   - Duplicates (post-canonicalization) MUST be rejected so a
 *     misconfigured operator sees a single source of truth.
 */

import { describe, it, expect } from "vitest";
import {
  loadOAuthConfig,
  isResourceAllowed,
  OAuthConfigError,
} from "../../src/config/oauth.js";

describe("loadOAuthConfig — defaults (OAuth wiring disabled)", () => {
  it("returns an empty allowlist + undefined issuer when neither env var is set", () => {
    const cfg = loadOAuthConfig({});
    expect(cfg.issuer).toBeUndefined();
    expect(cfg.allowedResources).toEqual([]);
  });

  it("treats whitespace-only MCP_AUTHORITY_URL as unset", () => {
    const cfg = loadOAuthConfig({
      MCP_AUTHORITY_URL: "   ",
      MCP_OAUTH_ALLOWED_RESOURCES: undefined,
    });
    expect(cfg.issuer).toBeUndefined();
    expect(cfg.allowedResources).toEqual([]);
  });
});

describe("loadOAuthConfig — happy path", () => {
  it("canonicalizes the issuer (lowercases scheme + host, strips trailing slash)", () => {
    const cfg = loadOAuthConfig({
      MCP_AUTHORITY_URL: "HTTPS://Auth.Example.com/",
      MCP_OAUTH_ALLOWED_RESOURCES: "https://mcp.example.com",
    });
    expect(cfg.issuer).toBe("https://auth.example.com");
    expect(cfg.allowedResources).toEqual(["https://mcp.example.com"]);
  });

  it("parses multiple comma-separated resources and canonicalizes each", () => {
    const cfg = loadOAuthConfig({
      MCP_AUTHORITY_URL: "https://auth.example.com",
      MCP_OAUTH_ALLOWED_RESOURCES:
        "https://sql.example.com, https://MEMOS.example.com/,https://sql.example.com/mcp",
    });
    expect(cfg.allowedResources).toEqual([
      "https://sql.example.com",
      "https://memos.example.com",
      "https://sql.example.com/mcp",
    ]);
  });

  it("deduplicates entries that canonicalize to the same URI", () => {
    // Trailing slash + uppercase host canonicalize to the same
    // value; the loader MUST reject the duplicates so the
    // allowlist does not carry redundant entries.
    expect(() =>
      loadOAuthConfig({
        MCP_AUTHORITY_URL: "https://auth.example.com",
        MCP_OAUTH_ALLOWED_RESOURCES:
          "https://mcp.example.com,https://MCP.EXAMPLE.COM/",
      }),
    ).toThrow(OAuthConfigError);
  });

  it("treats whitespace around comma-separated entries as insignificant", () => {
    const cfg = loadOAuthConfig({
      MCP_AUTHORITY_URL: "https://auth.example.com",
      MCP_OAUTH_ALLOWED_RESOURCES: "  https://a.example.com ,   https://b.example.com",
    });
    expect(cfg.allowedResources).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });
});

describe("loadOAuthConfig — fail-closed checks", () => {
  it("rejects MCP_AUTHORITY_URL without MCP_OAUTH_ALLOWED_RESOURCES", () => {
    expect(() =>
      loadOAuthConfig({
        MCP_AUTHORITY_URL: "https://auth.example.com",
        MCP_OAUTH_ALLOWED_RESOURCES: undefined,
      }),
    ).toThrow(/MCP_OAUTH_ALLOWED_RESOURCES/);
  });

  it("rejects MCP_OAUTH_ALLOWED_RESOURCES without MCP_AUTHORITY_URL", () => {
    expect(() =>
      loadOAuthConfig({
        MCP_AUTHORITY_URL: undefined,
        MCP_OAUTH_ALLOWED_RESOURCES: "https://mcp.example.com",
      }),
    ).toThrow(/MCP_AUTHORITY_URL/);
  });

  it("rejects an MCP_AUTHORITY_URL that is not a canonical resource URI (http://)", () => {
    expect(() =>
      loadOAuthConfig({
        MCP_AUTHORITY_URL: "http://auth.example.com",
        MCP_OAUTH_ALLOWED_RESOURCES: "https://mcp.example.com",
      }),
    ).toThrow(/https/);
  });

  it("rejects an MCP_OAUTH_ALLOWED_RESOURCES entry that contains a fragment", () => {
    expect(() =>
      loadOAuthConfig({
        MCP_AUTHORITY_URL: "https://auth.example.com",
        MCP_OAUTH_ALLOWED_RESOURCES: "https://mcp.example.com#frag",
      }),
    ).toThrow(/fragment|ResourceUriError/i);
  });

  it("rejects an MCP_OAUTH_ALLOWED_RESOURCES entry with userinfo", () => {
    expect(() =>
      loadOAuthConfig({
        MCP_AUTHORITY_URL: "https://auth.example.com",
        MCP_OAUTH_ALLOWED_RESOURCES: "https://u:p@mcp.example.com",
      }),
    ).toThrow(/userinfo|ResourceUriError/i);
  });

  it("rejects an MCP_OAUTH_ALLOWED_RESOURCES entry with a query component", () => {
    expect(() =>
      loadOAuthConfig({
        MCP_AUTHORITY_URL: "https://auth.example.com",
        MCP_OAUTH_ALLOWED_RESOURCES: "https://mcp.example.com?foo=bar",
      }),
    ).toThrow(/query|ResourceUriError/i);
  });

  it("rejects an MCP_OAUTH_ALLOWED_RESOURCES value with empty entries", () => {
    expect(() =>
      loadOAuthConfig({
        MCP_AUTHORITY_URL: "https://auth.example.com",
        MCP_OAUTH_ALLOWED_RESOURCES: ",,",
      }),
    ).toThrow(/no entries/);
  });
});

describe("isResourceAllowed", () => {
  it("returns true when the canonical resource is in the allowlist", () => {
    const cfg = loadOAuthConfig({
      MCP_AUTHORITY_URL: "https://auth.example.com",
      MCP_OAUTH_ALLOWED_RESOURCES: "https://sql.example.com,https://memos.example.com",
    });
    expect(isResourceAllowed(cfg, "https://sql.example.com")).toBe(true);
    expect(isResourceAllowed(cfg, "https://memos.example.com")).toBe(true);
  });

  it("returns false when the canonical resource is not in the allowlist", () => {
    const cfg = loadOAuthConfig({
      MCP_AUTHORITY_URL: "https://auth.example.com",
      MCP_OAUTH_ALLOWED_RESOURCES: "https://sql.example.com",
    });
    expect(isResourceAllowed(cfg, "https://other.example.com")).toBe(false);
  });

  it("requires the caller to canonicalize the resource first (byte-equal compare)", () => {
    // The handler is responsible for canonicalizing the inbound
    // `resource` parameter before calling isResourceAllowed. The
    // loader exposes the allowlist verbatim; the comparison is
    // exact-equality so two strings that canonicalize to the same
    // value but are byte-different (e.g. uppercase host) MUST NOT
    // be accepted by accident.
    const cfg = loadOAuthConfig({
      MCP_AUTHORITY_URL: "https://auth.example.com",
      MCP_OAUTH_ALLOWED_RESOURCES: "https://mcp.example.com",
    });
    expect(isResourceAllowed(cfg, "https://MCP.EXAMPLE.COM")).toBe(false);
  });
});