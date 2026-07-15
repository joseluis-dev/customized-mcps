/**
 * Tests for the canonical resource URI helpers.
 *
 * The contract is locked here so a future refactor of the
 * canonicalization rules is caught by the test runner. The single
 * normalization is the lowercase scheme/host + trailing-slash strip on
 * an empty path. Anything else MUST be rejected with a stable
 * `code` discriminator.
 */

import { describe, it, expect } from "vitest";
import {
  canonicalizeResourceUri,
  isCanonicalResourceUri,
  ResourceUriError,
} from "../src/resource.js";

describe("canonicalizeResourceUri", () => {
  it("returns the input unchanged for a clean https URL", () => {
    expect(canonicalizeResourceUri("https://mcp.example.com")).toBe(
      "https://mcp.example.com",
    );
  });

  it("preserves the path component (MUST NOT silently drop it)", () => {
    // RFC 8707 §2 says: "The client SHOULD use the base URI of the
    // API as the `resource` parameter value". A multi-segment path
    // identifies a specific resource server and MUST survive
    // canonicalization.
    expect(
      canonicalizeResourceUri("https://mcp.example.com/api/v1"),
    ).toBe("https://mcp.example.com/api/v1");
  });

  it("lowercases the scheme and host", () => {
    expect(canonicalizeResourceUri("HTTPS://MCP.Example.COM")).toBe(
      "https://mcp.example.com",
    );
  });

  it("strips the trailing slash only when the path is empty", () => {
    expect(canonicalizeResourceUri("https://mcp.example.com/")).toBe(
      "https://mcp.example.com",
    );
    // A trailing slash on a non-empty path is kept — it is semantically
    // distinct from the version without the slash per RFC 3986.
    expect(canonicalizeResourceUri("https://mcp.example.com/api/")).toBe(
      "https://mcp.example.com/api/",
    );
  });

  it("preserves an explicit non-default port", () => {
    expect(canonicalizeResourceUri("https://mcp.example.com:8443")).toBe(
      "https://mcp.example.com:8443",
    );
  });

  it("rejects http:// by default (production must use https)", () => {
    expect(() => canonicalizeResourceUri("http://mcp.example.com")).toThrow(
      ResourceUriError,
    );
    try {
      canonicalizeResourceUri("http://mcp.example.com");
    } catch (e) {
      const err = e as ResourceUriError;
      expect(err.code).toBe("invalid_scheme");
    }
  });

  it("permits http:// only on loopback hosts when allowInsecure=true", () => {
    expect(
      canonicalizeResourceUri("http://127.0.0.1:3001", { allowInsecure: true }),
    ).toBe("http://127.0.0.1:3001");
    expect(
      canonicalizeResourceUri("http://[::1]:3001", { allowInsecure: true }),
    ).toBe("http://[::1]:3001");
    expect(
      canonicalizeResourceUri("http://localhost:3001", {
        allowInsecure: true,
      }),
    ).toBe("http://localhost:3001");
  });

  it("rejects http:// on a non-loopback host even with allowInsecure=true", () => {
    expect(() =>
      canonicalizeResourceUri("http://mcp.example.com", {
        allowInsecure: true,
      }),
    ).toThrow(/loopback/);
  });

  it("rejects userinfo in the URL", () => {
    expect(() =>
      canonicalizeResourceUri("https://user:pass@mcp.example.com"),
    ).toThrow(ResourceUriError);
    try {
      canonicalizeResourceUri("https://user:pass@mcp.example.com");
    } catch (e) {
      const err = e as ResourceUriError;
      expect(err.code).toBe("invalid_userinfo");
    }
  });

  it("rejects a fragment component", () => {
    expect(() =>
      canonicalizeResourceUri("https://mcp.example.com#section"),
    ).toThrow(ResourceUriError);
    try {
      canonicalizeResourceUri("https://mcp.example.com#section");
    } catch (e) {
      const err = e as ResourceUriError;
      expect(err.code).toBe("invalid_fragment");
    }
  });

  it("rejects a query component", () => {
    // RFC 8707 §2: "It SHOULD NOT include a query component".
    // The resource URI is an identifier; including a query makes it a
    // locator that the auth server would interpret as scoped to that
    // query — refusing it keeps the wire contract narrow.
    expect(() =>
      canonicalizeResourceUri("https://mcp.example.com?foo=bar"),
    ).toThrow(ResourceUriError);
    try {
      canonicalizeResourceUri("https://mcp.example.com?foo=bar");
    } catch (e) {
      const err = e as ResourceUriError;
      expect(err.code).toBe("invalid_query");
    }
  });

  it("rejects unsupported schemes (file, ws, ftp)", () => {
    expect(() => canonicalizeResourceUri("ws://mcp.example.com")).toThrow(
      ResourceUriError,
    );
    expect(() => canonicalizeResourceUri("ftp://mcp.example.com")).toThrow(
      ResourceUriError,
    );
    expect(() => canonicalizeResourceUri("file:///etc/passwd")).toThrow(
      ResourceUriError,
    );
  });

  it("rejects empty / non-string input", () => {
    expect(() => canonicalizeResourceUri("")).toThrow(ResourceUriError);
    expect(() => canonicalizeResourceUri("   ")).toThrow(ResourceUriError);
  });

  it("rejects malformed URLs", () => {
    expect(() =>
      canonicalizeResourceUri("not-a-url"),
    ).toThrow(ResourceUriError);
  });
});

describe("isCanonicalResourceUri", () => {
  it("returns true for valid URIs", () => {
    expect(isCanonicalResourceUri("https://mcp.example.com")).toBe(true);
  });

  it("returns false for invalid URIs (no throw)", () => {
    expect(isCanonicalResourceUri("http://mcp.example.com")).toBe(false);
    expect(isCanonicalResourceUri("not-a-url")).toBe(false);
    expect(isCanonicalResourceUri("")).toBe(false);
  });
});