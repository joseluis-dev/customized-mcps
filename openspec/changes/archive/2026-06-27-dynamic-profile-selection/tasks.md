# Tasks: Dynamic Profile Selection

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 400-550 (per proposal: ~200 source, ~200 tests, ~50 docs) |
| 800-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR; 4 work-unit commit groups (foundation, core, wiring, docs) |
| Delivery strategy | auto-forecast |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
800-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Commit Group | Notes |
|------|------|--------------|-------|
| 1 | `SecretProvider` + non-leaking error | Group 1 | New `src/secrets/SecretProvider.ts` + `test/secretRefs.test.ts`; ~120 LoC. |
| 2 | Profile alias/display/capabilities/collisions | Group 2 | `src/types.ts` + `src/config/profiles.ts` + extend `test/profiles.test.ts`; ~180 LoC. |
| 3 | Tool surface summary, lookup, strict zod, sanitization | Group 3 | `readonlyTools.ts` + `sanitizeError.ts` + `index.ts` + new `test/profileAlias.test.ts`; ~180 LoC. |
| 4 | Docs + verification | Group 4 | `README.md` + `.env.example`; ~50 LoC. |

Chain skill: not needed at this forecast. Load `chained-pr` if forecast flips to High.

Gate findings folded in: F1 = per-resolve timeout via `AbortSignal.timeout(ms)` to async `resolve`; F2 = default `capabilities: ["read-only"]`; F3 = unsafe display metadata predicate; F4 = tag-dedupe test.

## Phase 1: Foundation — SecretProvider

- [x] 1.1 RED: in `test/secretRefs.test.ts`, add cases for `FileSecretProvider` success, missing file, relative path, and timeout via `AbortSignal.timeout(ms)` passed into async `resolve` (Gate F1)
- [x] 1.2 GREEN: create `src/secrets/SecretProvider.ts` with async `SecretProvider.resolve(ref, { signal? }): Promise<string>`, `parseSecretRef`, and `FileSecretProvider.resolve` using `node:fs/promises.readFile(path, { encoding: "utf8", signal })`; timeout via `AbortSignal.timeout(secretTimeoutMs)` (async I/O only)
- [x] 1.3 RED: add test asserting `ProfileError` from a failing resolve masks path/host/user/password/port
- [x] 1.4 GREEN: emit masked `ProfileError(kind="file", alias)`; extend `sanitizeError` sensitive-key list with secret-ref literal

## Phase 2: Core — Profile + Alias + Display

- [x] 2.1 RED: extend `test/profiles.test.ts` for alias default, explicit alias override, invalid alias regex, display/description/tags parsing (trim+dedupe), default `capabilities: ["read-only"]` (Gate F2, F4)
- [x] 2.2 GREEN: extend `src/types.ts` with `Profile.alias`, `operatorKey`, `displayName?`, `description?`, `tags?[]`, `capabilities`; extend `ProfileSummary` additively; make `loadProfile`/`loadAllProfiles` async; `await` both at every call site; parse `DB_<NAME>_ALIAS/_DISPLAY_NAME/_DESCRIPTION/_TAGS/_CAPABILITIES`; default alias=operator key; trim/dedupe tags
- [x] 2.3 RED: collision test — duplicate alias and alias-equals-other-operator-key both fail non-leaking
- [x] 2.4 GREEN: implement collision check in `loadAllProfiles`; non-leaking `ProfileError` names colliding alias only
- [x] 2.5 RED: test `isUnsafeDisplayMetadata` predicate matches password/host/user/port regex without echoing the value (Gate F3)
- [x] 2.6 GREEN: implement predicate; warn to stderr with alias+field only; omit unsafe `displayName`/`description`/tag values from `ProfileSummary`
- [x] 2.7 REFACTOR: confirm `pnpm test` green; extract tag/display parsers

## Phase 3: Integration — Tool Surface + Logging

- [x] 3.1 RED: create `test/profileAlias.test.ts` covering `ProfileSummary` shape, alias-first then operator-key lookup, unknown-profile error keyed to caller, strict zod rejection of extra keys
- [x] 3.2 GREEN: in `src/tools/readonlyTools.ts`, build `aliasMap`+`operatorKeyMap`; `name===alias` in summaries; error keyed to caller value; `.strict()` on every zod input schema
- [x] 3.3 RED: test that sanitized errors never echo `${secret:...}` literal or distinct operator key
- [x] 3.4 GREEN: extend `src/security/sanitizeError.ts` to mask secret literals and operator key when distinct from alias
- [x] 3.5 GREEN: in `src/index.ts`, `await loadAllProfiles` and log aliases only
- [x] 3.6 REFACTOR: confirm `pnpm test` + `pnpm exec tsc -p tsconfig.json --noEmit` pass

## Phase 4: Docs + Verification

- [x] 4.1 Update `.env.example` with new vars and one `${secret:file:...}` example
- [x] 4.2 Update `README.md` "Configure profiles", "Tools exposed", "Tests" (alias vs operator key, safe summaries, secret ref pattern, default capabilities)
- [x] 4.3 VERIFY: `pnpm test`, `pnpm build`, `pnpm exec tsc -p tsconfig.json --noEmit` all pass
- [x] 4.4 VERIFY: legacy `.env` loads alias=operator key; `list_profiles` backward-compatible with five-field consumers
