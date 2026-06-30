/**
 * TDD tests for the scope catalog builder (PR4 task 4.1).
 *
 * The resource server MUST expose its `scopes_supported` catalog at
 * `/.well-known/oauth-protected-resource` (per RFC 9728 + the
 * `mcp-token-authority` delta). The catalog source-of-truth lives in
 * this app (`mcp-readonly-sql`): it does NOT assume that
 * `Profile.scope` (the DB-scope field, `server` | `database`) maps to
 * an OAuth scope. Instead, the catalog is derived from profile
 * aliases (`read:<alias>` + `list:<alias>` per profile) OR an explicit
 * `MCP_RESOURCE_SCOPES` env override.
 *
 * The tests below pin the two source-priority branches, the
 * validation filter on the env branch, the alias->scope expansion on
 * the profile branch, the dedup order, and the empty-input contract.
 */

import { describe, it, expect } from "vitest";
import { buildScopeCatalog } from "../../src/config/scopeCatalog.js";
import type { Profile } from "../../src/types.js";

const PG_PROFILE: Profile = {
  name: "bi_catastro",
  alias: "bi_catastro",
  operatorKey: "PG_LOCAL",
  dialect: "postgres",
  client: "pg",
  scope: "server",
  initialDatabase: "postgres",
  allowedDatabases: ["app", "analytics"],
  requireQualifiedDatabase: true,
  capabilities: ["read-only"],
  connection: {
    kind: "postgres",
    host: "localhost",
    port: 5432,
    database: "postgres",
    user: "readonly",
    password: "redacted",
    ssl: false,
  },
  knexOptions: {},
};

const SQLITE_PROFILE: Profile = {
  ...PG_PROFILE,
  name: "demo",
  alias: "demo",
  operatorKey: "SQLITE_DEMO",
  dialect: "sqlite",
  client: "sqlite3",
  scope: "database",
  initialDatabase: "main",
  allowedDatabases: ["main"],
  connection: { kind: "sqlite", filename: "./data/demo.sqlite" },
};

describe("buildScopeCatalog", () => {
  describe("profile-derived catalog (MCP_RESOURCE_SCOPES unset)", () => {
    it("emits read:<alias> and list:<alias> for a single profile", () => {
      // GIVEN one postgres profile named "bi_catastro" and no env override
      // WHEN we build the catalog
      // THEN the catalog is exactly ["read:bi_catastro", "list:bi_catastro"]
      const out = buildScopeCatalog([PG_PROFILE], {});
      expect(out).toEqual(["read:bi_catastro", "list:bi_catastro"]);
    });

    it("emits per-alias scopes for multiple profiles, preserving order", () => {
      // GIVEN two profiles with distinct aliases
      // WHEN we build the catalog
      // THEN the catalog lists each profile's read+list scopes in the
      //      input order, deduped if any alias collides
      const out = buildScopeCatalog([PG_PROFILE, SQLITE_PROFILE], {});
      expect(out).toEqual([
        "read:bi_catastro",
        "list:bi_catastro",
        "read:demo",
        "list:demo",
      ]);
    });

    it("deduplicates when two profiles share an alias (first-seen wins)", () => {
      // GIVEN two profiles with the same alias
      // WHEN we build the catalog
      // THEN the resulting scope set contains the alias's scopes exactly
      //      once (first-seen wins). The shape mirrors how the alias
      //      collision check in loadAllProfiles() handles duplicates.
      const dup: Profile = { ...PG_PROFILE, operatorKey: "PG_LOCAL_2" };
      const out = buildScopeCatalog([PG_PROFILE, dup], {});
      expect(out).toEqual(["read:bi_catastro", "list:bi_catastro"]);
    });

    it("returns an empty array when the profile list is empty", () => {
      // GIVEN no profiles configured
      // WHEN we build the catalog
      // THEN the catalog is [] (the resource server advertises no
      //      scopes; clients see the empty list at the well-known
      //      endpoint).
      const out = buildScopeCatalog([], {});
      expect(out).toEqual([]);
    });

    it("does NOT use Profile.scope as a scope — it is the DB scope (server|database), not an OAuth scope", () => {
      // GIVEN a profile with scope="server"
      // WHEN we build the catalog
      // THEN the catalog contains only `read:<alias>` / `list:<alias>`;
      //      it MUST NOT contain "server" or "database" as a scope.
      //      (This is the explicit guard the spec asks for in 4.1.)
      const out = buildScopeCatalog([PG_PROFILE], {});
      expect(out).not.toContain("server");
      expect(out).not.toContain("database");
      expect(out).not.toContain("read:server");
      expect(out).not.toContain("list:database");
    });
  });

  describe("env-override catalog (MCP_RESOURCE_SCOPES set)", () => {
    it("uses the env value verbatim when every entry is valid", () => {
      // GIVEN MCP_RESOURCE_SCOPES is set to a clean comma list
      // WHEN we build the catalog
      // THEN the catalog is exactly the parsed list, in the same order
      const out = buildScopeCatalog(
        [PG_PROFILE],
        { MCP_RESOURCE_SCOPES: "read:* , list:demo" },
      );
      expect(out).toEqual(["read:*", "list:demo"]);
    });

    it("ignores profile aliases when the env override is set (env wins)", () => {
      // GIVEN a profile is loaded AND MCP_RESOURCE_SCOPES is set
      // WHEN we build the catalog
      // THEN the env value wins: the profile's read+list scopes do not
      //      appear, only the env value does.
      const out = buildScopeCatalog(
        [PG_PROFILE],
        { MCP_RESOURCE_SCOPES: "call:agent" },
      );
      expect(out).toEqual(["call:agent"]);
      expect(out).not.toContain("read:bi_catastro");
      expect(out).not.toContain("list:bi_catastro");
    });

    it("trims and deduplicates env entries (first-seen wins)", () => {
      // GIVEN MCP_RESOURCE_SCOPES has whitespace + duplicate values
      // WHEN we build the catalog
      // THEN the catalog is trimmed and deduped in first-seen order
      const out = buildScopeCatalog(
        [],
        { MCP_RESOURCE_SCOPES: "  read:a , list:b , read:a , call:c" },
      );
      expect(out).toEqual(["read:a", "list:b", "call:c"]);
    });

    it("filters out invalid scope strings and keeps the valid ones", () => {
      // GIVEN MCP_RESOURCE_SCOPES has a mix of valid and invalid values
      // WHEN we build the catalog
      // THEN invalid values are filtered out (so a typo in the operator's
      //      env does not poison the well-known response with malformed
      //      scopes); the valid values are returned in the original order.
      const out = buildScopeCatalog(
        [],
        { MCP_RESOURCE_SCOPES: "read:foo, not-a-scope, list:bar, bogus:1:2" },
      );
      expect(out).toEqual(["read:foo", "list:bar"]);
    });

    it("returns [] when the env value contains only invalid scopes (no fallback to profiles)", () => {
      // GIVEN MCP_RESOURCE_SCOPES is set but every entry is invalid
      // WHEN we build the catalog
      // THEN the env branch still wins: the catalog is [] and the
      //      profile-derived list does NOT sneak in. The well-known
      //      document will honestly advertise an empty catalog so the
      //      operator sees the misconfiguration through the absence of
      //      expected scopes.
      const out = buildScopeCatalog(
        [PG_PROFILE],
        { MCP_RESOURCE_SCOPES: "nope, still-nope, also-nope" },
      );
      expect(out).toEqual([]);
    });

    it("treats MCP_RESOURCE_SCOPES='' the same as unset (falls back to profiles)", () => {
      // GIVEN MCP_RESOURCE_SCOPES is an empty string
      // WHEN we build the catalog
      // THEN the env branch is treated as "no override" and the
        //      profile-derived catalog is returned.
      const out = buildScopeCatalog([PG_PROFILE], { MCP_RESOURCE_SCOPES: "" });
      expect(out).toEqual(["read:bi_catastro", "list:bi_catastro"]);
    });

    it("treats MCP_RESOURCE_SCOPES='   ' the same as unset", () => {
      // GIVEN MCP_RESOURCE_SCOPES is whitespace-only
      // WHEN we build the catalog
      // THEN the env branch is treated as "no override".
      const out = buildScopeCatalog([PG_PROFILE], { MCP_RESOURCE_SCOPES: "   " });
      expect(out).toEqual(["read:bi_catastro", "list:bi_catastro"]);
    });
  });
});
