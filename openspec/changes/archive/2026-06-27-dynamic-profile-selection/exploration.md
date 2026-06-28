## Exploration: dynamic-profile-selection

### Current State

`mcp-readonly-sql` already implements most of the requested surface, but the public tool surface is metadata-thin and the env-driven model is rigid.

**What is already in place (verified against source):**

- **Per-profile env loading** (`src/config/profiles.ts:179-213`): each profile is read from `DB_<NAME>_CLIENT`, `DB_<NAME>_HOST`, `DB_<NAME>_PORT`, `DB_<NAME>_USER`, `DB_<NAME>_PASSWORD`, `DB_<NAME>_SSL`/`ENCRYPT`/`TRUST_SERVER_CERTIFICATE`, `DB_<NAME>_INITIAL_DATABASE` (or `..._DATABASE`), `DB_<NAME>_ALLOWED_DATABASES`, `DB_<NAME>_REQUIRE_QUALIFIED_DATABASE`.
- **Dialect-defaulted ports** (`profiles.ts:91,99,111,118`): `postgres` 5432, `mysql`/`mariadb` 3306, `mssql` 1433 — port is fully optional.
- **Per-profile allowlist** (`profiles.ts:137-166`): comma-separated list, validates each identifier against `^[A-Za-z0-9_\-$]+$`, accepts `*` for "all visible to the read-only user", and is **required** for server-scope profiles.
- **Credentials stay server-side**: `ProfileSummary` (`src/types.ts:48-54`) exposes only `name`, `dialect`, `scope`, `allowedDatabases`, `requireQualifiedDatabase` — never `host`, `user`, `password`, `port`. `list_profiles` (`readonlyTools.ts:73-82`) returns this sanitized view. `sanitizeError` (`src/security/sanitizeError.ts`) scrubs `password=...`, `user=...`, and any key whose name contains `password`/`secret`/`token`/`apikey`/etc.
- **Tool input is already an alias**: every tool (`list_databases`, `test_connection`, `execute_read_query`, `describe_schema`) takes a `profile: profileNameSchema` argument validated against `^[A-Za-z0-9_]+$` length 1-64. The agent never types credentials; it types a name.
- **Read-only safety is layered**: `sqlGuard` (`src/security/sqlGuard.ts`) blocks write statements at keyword + AST level, enforces single-statement, and verifies the per-profile database allowlist (`assertDatabasePolicy:221-245`). `withReadOnlyTransaction` (`src/db/knexFactory.ts:100-125`) sets `READ ONLY` (PG/MySQL), `PRAGMA query_only=ON` (SQLite), or `READ UNCOMMITTED` (MSSQL). Engine grants are an explicit defense in depth per the README.

**What is missing relative to the user's intent:**

1. **The agent has no way to choose dynamically among profiles by *role* / *purpose*.** `list_profiles` returns `name`, `dialect`, `scope`, `allowedDatabases`, `requireQualifiedDatabase` — no human-friendly label, no description, no tags, no read-only capability hint, no connection-health indicator. The agent must reason over env-var-style names like `SQLSERVER_BI` and guess what they connect to.
2. **Operator name and MCP alias are coupled.** The alias the agent sees (`SQLSERVER_BI`) is the same string the operator types as the `DB_<NAME>` suffix. Renaming the env block changes the alias. There is no indirection.
3. **No secret references.** The loader only reads raw env values via `readString`/`readInt`/`readBool`. Operators who want to source `PASSWORD` from a KMS, vault, or a file must do so *outside* the process (e.g., a sidecar that injects env). There is no pluggable `SecretProvider`.
4. **No per-call alias resolution independence from operator key.** Today, two env blocks that happen to share a name collide at startup, but the failure mode is a `ProfileError`. There is no documented "alias" concept the operator can use to expose `bi_catastro` while keeping the env block named `STAGING_SQLSERVER_PRD_01`.
5. **No "logical database" aliases inside a profile.** `ALLOWED_DATABASES` is a list of raw DB names (`catastral,catastro`). The agent has no way to ask "which database is the cadastral parcels one?"; it has to use the raw name in SQL. (This is mostly fine — the DB name is meaningful in queries — but a small label could help discovery.)
6. **No profile-context pinning.** The agent re-passes `profile` on every call. A `select_profile` helper that returns the same identity and could later be extended to a session binding is absent.

### Affected Areas

- `src/config/profiles.ts` — `loadProfile`, `loadAllProfiles`, `Profile`/`ProfileSummary` shapes, validation regex. Will need: optional `ALIAS`, `DISPLAY_NAME`, `DESCRIPTION`; secret-reference resolver hook; alias-vs-operator-name separation in `ProfileSummary`.
- `src/config/env.ts` — `readString` semantics need a thin secret-reference layer (`${env:NAME}` / `${file:/path}`) without changing the public signature for non-reference values.
- `src/types.ts` — extend `Profile` and `ProfileSummary` with alias/display/description/capabilities; introduce a `ResolvedSecret` type that never serializes its raw value.
- `src/tools/readonlyTools.ts` — `list_profiles` output gains alias/display/description/capabilities (no secrets). All tool inputs continue to accept the **alias**, not the operator key. Error messages must reference the alias the caller sent.
- `src/security/sanitizeError.ts` — extend the sensitive-key list with `alias`, `displayName` to be safe; verify alias-rejection errors never echo operator key + secret.
- `src/index.ts` — minor: log line "Loaded N profile(s): ..." should list aliases, not operator keys.
- `test/profiles.test.ts` and **new** `test/profileAlias.test.ts`, `test/secretRefs.test.ts` (strict TDD: red → green).
- `README.md` and `.env.example` — document alias/display/description/secret-reference patterns.
- `openspec/config.yaml` rules — add a "profile alias invariants" rule (alias must match `^[A-Za-z0-9_]+$` 1-64, must be unique, must never serialize the operator key or connection fields).
- `openspec/specs/` — current domain spec is empty (only `changes/` exists from `sdd-init`). The proposal phase will create `openspec/specs/profiles/spec.md` and `openspec/specs/mcp-surface/spec.md` deltas.

### Approaches

1. **Alias + display metadata on top of the existing env model (Recommended)**
   - Add optional `DB_<NAME>_ALIAS`, `DB_<NAME>_DISPLAY_NAME`, `DB_<NAME>_DESCRIPTION`, `DB_<NAME>_TAGS` (comma list).
   - Introduce a new `Profile.alias` field; default it to the operator key when not set. The `ProfileSummary` exposes `alias`, `displayName`, `description`, `tags`, `dialect`, `scope`, `allowedDatabases`, `requireQualifiedDatabase`. The operator key stays in `Profile` for logging only and is never serialized to MCP.
   - All tool inputs accept the alias (today the regex matches both). Add an alias-collision check at startup.
   - **Pros**: minimal blast radius; backward compatible (alias defaults to operator key); preserves the "agent never sees secrets" guarantee; gives the agent a discoverable, human-meaningful target.
   - **Cons**: two strings per profile to keep straight; needs a `DISTINCT(alias)` test.
   - **Effort**: Low (2-3 small PRs).

2. **Config-file-plus-secret-references (bigger surface)**
   - Add `profiles.config.json` (or YAML) as an *alternative* source. Each entry has `name`, `alias`, `host`, `user`, `passwordRef` (`{ kind: "env", name: "..." }` / `{ kind: "file", path: "..." }` / `{ kind: "provider", name: "vault", key: "..." }`).
   - Implement a `SecretProvider` interface with two built-in providers: `EnvSecretProvider` (default) and `FileSecretProvider`. Pluggable for Vault later.
   - **Pros**: native support for KMS/Vault/file-based secrets; clean separation of config and secrets; lets operators stop putting passwords in `.env`.
   - **Cons**: introduces a new config artifact, a new schema, error paths for missing/invalid secret refs, and a second code path next to the env loader. Risk of over-engineering v1.
   - **Effort**: Medium (4-6 PRs, plus docs and tests).

3. **Hybrid: env primary + opt-in secret references (pragmatic middle ground)**
   - Keep env as the source of truth, but allow `DB_<NAME>_PASSWORD=${secret:env:MY_PW}` or `DB_<NAME>_PASSWORD=${secret:file:/run/secrets/db_pw}` inline. The env loader detects the prefix, delegates to a `SecretProvider`, and the raw value is never logged or surfaced.
   - **Pros**: opt-in; no new config file; operators can keep the rest of the env vars as-is; trivially extendable with a `VaultSecretProvider` later.
   - **Cons**: prefix syntax must be documented and tested; careless operators could still put raw passwords in env (status quo).
   - **Effort**: Low-Medium (1-2 PRs).

4. **Add a `select_profile` tool that returns the chosen alias and capabilities**
   - The agent calls `select_profile({ alias: "bi_catastro" })` once per session, and the tool returns the sanitized `ProfileSummary`. All other tools remain profile-per-call.
   - **Pros**: gives the agent an explicit "I picked this" signal; foundation for a future session-bound default.
   - **Cons**: mostly cosmetic in v1; risk of confusion if the agent assumes session state when there is none.
   - **Effort**: Low (1 PR).

5. **Defer everything and only add `displayName`/`description` (minimal change)**
   - No alias indirection, no secret references, no new tool. Just enrich `ProfileSummary` with operator-provided display strings.
   - **Pros**: smallest possible diff.
   - **Cons**: does not address the operator-name-coupling concern; no secret flexibility.
   - **Effort**: Trivial (1 PR) but does not deliver most of the user intent.

### Recommendation

**Combine Approach 1 + Approach 3, defer Approach 2 and Approach 4 to a follow-up change.**

The user's intent is "agent picks a connection by a safe MCP-assigned profile name/alias, secrets stay hidden, secrets don't have to live in env." Approach 1 (alias + display/description/tags) addresses the *agent-discoverability* half directly: the alias is what the agent types, the display name is what the agent reasons about, and the operator key stays operator-side. Approach 3 (env + opt-in `${secret:...}` references) addresses the *secret flexibility* half without forcing a config file: operators who want Vault or file-based secrets can switch by changing one value, and the rest of the env stays as-is. Both fit behind the existing `loadProfile` signature, the existing TDD discipline, and the existing `ProfileSummary` contract.

Concretely the recommended scope for this change is:

1. Add `Profile.alias` (defaults to operator key), `displayName?`, `description?`, `tags?[]` to env loader and types.
2. `ProfileSummary` exposes `alias`, `displayName`, `description`, `tags` (no operator key, no connection fields).
3. Tool inputs continue to take a `profile` argument; the regex check passes both alias and operator key for backward compatibility, but the canonical value the agent should pass is the alias. Error messages use the alias.
4. Add a `SecretProvider` interface and two built-in providers: `EnvSecretProvider` (default, no prefix) and `FileSecretProvider` (`${secret:file:/abs/path}`). The loader recognizes the prefix in `DB_<NAME>_PASSWORD` (and any other secret-bearing field) and resolves at startup. Failures throw `ProfileError` with a non-leaking message.
5. Startup validates: alias is unique; alias matches the same regex as today; secrets are resolvable; `ProfileError` messages reference the alias, never the operator key.
6. `list_profiles` and `test_connection` descriptions and outputs are updated; README and `.env.example` document the new vars and the secret prefix.

**Explicitly out of scope for this change** (deferred to follow-ups):

- New file-based config format (`profiles.json`/YAML). Approach 2 is the right home for that.
- `select_profile` tool and any session-bound default. Approach 4.
- Live credential rotation without restart. Keep "restart to pick up new credentials" as the documented contract.
- Per-profile read-only role grants at the engine level (already covered by README guidance and outside this server's responsibility).
- Multi-tenant isolation beyond `ALLOWED_DATABASES`. The allowlist is the v1 authorization model.
- Profile-level RBAC, audit logging, telemetry, billing. None of these are in scope.

### Risks

- **Alias collision**: two env blocks with the same `ALIAS` (or one with `_ALIAS` matching another operator key). Must fail at startup with a non-leaking error.
- **Information disclosure through display fields**: a careless operator may paste a host or password into `DISPLAY_NAME`/`DESCRIPTION`. The MCP layer must document this and the loader should warn (not block) when `displayName` matches the `password` regex from `sanitizeError`.
- **Alias leakage in error paths**: when the agent passes an invalid profile, the error must say "Unknown alias 'X'" without listing valid aliases in a way that helps an attacker enumerate. Return a generic message and (optionally) suggest `list_profiles`.
- **Secret reference resolution timing**: file reads at startup can race with secret rotation; KV/Vault HTTP at startup can hang. Wrap resolution in a startup timeout and a clear `ProfileError`.
- **Backward compatibility**: existing `.env` files must keep working. Alias defaults to operator key; secret references are opt-in; no breaking change to `list_profiles` consumers (additive fields only).
- **`describe_schema`/`execute_read_query` error wording**: today, the allowlist denial says `Database "X" is not in the allowlist for profile "Y"`. With aliases, the "Y" must be the alias the caller sent, not the operator key — otherwise the agent cannot correlate the error.
- **TDD coverage**: every new env variable and every secret-reference branch must ship with a vitest case in `test/profiles.test.ts` (or a new `test/profileAlias.test.ts` / `test/secretRefs.test.ts`). The strict TDD rule in `openspec/config.yaml` is non-negotiable.
- **Operator key vs alias logging**: `process.stderr.write` lines today print operator keys. Decide explicitly: log alias, not operator key, going forward. If kept for debugging, mask the operator key in non-debug logs.
- **Plugin surface for `SecretProvider`**: the prefix syntax is a small DSL. A future Vault provider must integrate without re-architecting. Keep `SecretProvider` minimal: `resolve(ref: string) -> Promise<string>` and a `kind` discriminator.
- **Review budget (800 lines)**: alias + secret-ref work is a single chainable PR (≈300-500 LoC), well under the 800-line budget. No chained PR strategy needed unless a follow-up adds the `select_profile` tool.

### Ready for Proposal

Yes. The change has a clear shape (alias + display metadata + opt-in secret references), fits inside the existing `loadProfile` and `ProfileSummary` contracts, is fully unit-testable with vitest, and does not require new external dependencies. The next phase is `sdd-propose` (intents, scope, approach, rollback plan). After that: `sdd-spec` for the profile + mcp-surface delta specs, then `sdd-design`, then `sdd-tasks`. No new external library is required; everything is stdlib + the existing `dotenv` + `node:fs/promises` + `node:path`.
