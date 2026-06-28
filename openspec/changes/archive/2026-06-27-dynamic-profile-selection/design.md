# Design: Dynamic Profile Selection

## Technical Approach

Keep profiles server-side, split the internal env operator key from the MCP-facing alias, and make profile loading async so file secret resolution can enforce a real per-resolve timeout. `loadProfile(operatorKey, raw, options)` and `loadAllProfiles(...)` return promises; `runServer()` already awaits startup work and will `await loadAllProfiles`. Tool handlers still resolve caller `profile` alias-first, then legacy operator key. Responses and logs use aliases only.

No SQL parsing or cross-database routing changes are required; existing `sqlGuard` and dialect routing remain unchanged.

## Architecture Decisions

| Topic | Choice | Alternatives considered | Rationale |
|------|--------|--------------------------|-----------|
| Alias model | `Profile.name` and `Profile.alias` equal the MCP alias; add server-only `operatorKey` | Keep `name` as operator key | Keeps `ProfileSummary.name === alias` and minimizes leaks from existing `p.name` usage. |
| Lookup maps | Build `aliasMap` and `operatorKeyMap`; resolve alias first | Single mixed map | Makes backward compatibility explicit and pairs with startup collision checks. |
| Collision validation | `loadAllProfiles` rejects duplicate aliases and aliases matching another profile's operator key | Handler-time ambiguity | Fail-closed startup keeps routing deterministic and non-leaking. |
| Secret contract | `SecretProvider.resolve(ref, options): Promise<string>`; `FileSecretProvider` uses `node:fs/promises.readFile(path, { encoding: "utf8", signal })` with `AbortSignal.timeout(secretTimeoutMs)` | Synchronous `readFileSync` or no timeout | A blocking sync read cannot be reliably timed out; async I/O makes timeout behavior implementable and testable with Node >=20. |
| Secret placement | Add `src/secrets/SecretProvider.ts`; call it only from `profiles.ts` secret-bearing field readers | Put secret logic in `env.ts` | `env.ts` remains generic; secret resolution is profile-domain behavior. |
| Metadata safety | Omit and warn for unsafe display fields/tags when value contains a raw secret ref (`${secret:`), case-insensitive sensitive labels (`password`, `passwd`, `pwd`, `secret`, `token`, `api[_-]?key`, `connection[_-]?string`), URI credentials (`://user:pass@`), or DSN credential pairs (`password=`, `pwd=`, `user=` plus password) | Reject startup or echo sanitized values | Metadata should not break connections; warnings name only alias + field and never echo unsafe values. |
| Tags/capabilities | Tags are trim → drop blanks → first-seen dedupe; capabilities parse the same and default explicitly to `["read-only"]` | Preserve duplicates or omit default | Summaries stay predictable and the read-only posture is visible. |
| Zod input safety | Add `.strict()` to every tool input schema, including `list_profiles` | Rely on Zod stripping | Specs require extra-key rejection. |

## Data Flow

```text
.env DB_<KEY>_* -> loadRawEnv -> await loadAllProfiles
                                ├─ alias/default + metadata validation
                                ├─ password fields -> await SecretProvider(file, timeout)
                                └─ collision checks -> Profile[]

MCP profile value -> aliasMap.get(value) -> operatorKeyMap fallback -> existing DB flow
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/types.ts` | Modify | Add `alias`, server-only `operatorKey`, display metadata, and explicit `capabilities: string[]` to `Profile`; add safe additive fields to `ProfileSummary`. |
| `src/config/profiles.ts` | Modify | Make `loadProfile`/`loadAllProfiles` async; parse alias/metadata/capabilities; resolve password secrets; warn safely; validate alias collisions. |
| `src/secrets/SecretProvider.ts` | Create | Define async provider contract, prefix parser, timeout options, and `${secret:file:/abs/path}` provider using `fs/promises`. |
| `src/tools/readonlyTools.ts` | Modify | Build alias-safe summaries; alias-first lookup; caller-keyed errors; strict zod schemas. |
| `src/security/sanitizeError.ts` | Modify | Mask raw secret refs, host/user/port patterns, connection-string fragments, and file secret paths. |
| `src/index.ts` | Modify | `await loadAllProfiles`; log loaded aliases only. |
| `test/profiles.test.ts` | Modify | Update async tests; cover alias defaults, metadata predicate, tag/capability defaults, and collisions. |
| `test/profileAlias.test.ts` | Create | Cover summary shape, alias/operator-key resolution, unknown errors, and strict schemas. |
| `test/secretRefs.test.ts` | Create | Cover async file success, missing file, timeout via fake provider/abort signal, and non-leaking errors. |
| `README.md`, `.env.example` | Modify | Document aliases, safe summaries, capabilities default, and file secret refs. |

## Interfaces / Contracts

```ts
type Profile = { name: string; alias: string; operatorKey: string; capabilities: string[]; /* ... */ };
type ProfileSummary = { name: string; alias: string; capabilities: string[]; /* existing safe fields */ };
interface SecretProvider { kind: string; resolve(ref: string, options: { signal?: AbortSignal }): Promise<string>; }
```

`loadProfile`, `loadAllProfiles`, and `runServer` are async at the loading boundary. `ProfileError` messages use stable non-sensitive reason codes, alias when available, and never include host/user/password/port, raw secret refs, file paths, or distinct operator keys.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Async profile parsing, metadata predicate, tag/capability defaults, collisions, secret refs | TDD red tests in `profiles.test.ts` and `secretRefs.test.ts`. |
| Unit | Tool summary/lookup/error contracts and strict schemas | Mock `McpServer.registerTool` in `profileAlias.test.ts` and call handlers directly. |
| Integration | Build/type safety | Run `pnpm test`, `pnpm build`, and `pnpm exec tsc -p tsconfig.json --noEmit`. |
| E2E | Not applicable | No E2E harness exists. |

## Migration / Rollout

No migration required. Existing env profiles keep working because alias defaults to operator key and tools still accept operator keys. Rollback is a normal revert; no feature flag should re-expose operator keys or secrets.

## Open Questions

None.
