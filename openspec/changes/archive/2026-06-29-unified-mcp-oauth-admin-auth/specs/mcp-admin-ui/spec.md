# Delta for mcp-admin-ui

## ADDED Requirements

### Requirement: Agent And Client Scope Editing

The agent detail page and the client detail page MUST expose an inline form to edit the assigned scope set. `POST /admin/agents/:id/scopes` MUST update the agent's scopes via the existing `setAgentScopes()` helper and append an `audit_log` row with `action="agent.set_scopes"`, the new scope set, and the acting admin. `POST /admin/clients/:id/scopes` MUST behave symmetrically with `setClientScopes()` and `action="client.set_scopes"`. Submitted scope strings MUST be validated against `SCOPE_PATTERN`; invalid values MUST be rejected with a sanitized error and no DB write. Pages MUST re-render with the new scope set after a successful POST.

#### Scenario: Edit agent scopes succeeds

- GIVEN an admin viewing agent `a1` with current scopes `["read:foo"]`
- WHEN the admin submits `["read:foo", "list:foo"]` to `POST /admin/agents/a1/scopes`
- THEN the agent's scope set is updated
- AND an `audit_log` row records the change with actor, target, and new scope set.

#### Scenario: Invalid scope rejected

- GIVEN a form submission containing `not-a-scope`
- WHEN the form posts
- THEN the response is `400` with a sanitized error
- AND no `audit_log` row is written
- AND the agent's scope set is unchanged.

### Requirement: Scope Usage Display

The scopes list page MUST display the `inUse` count (number of agents + clients currently bound to each scope) next to each scope row. The count MUST be derived from the existing `scopeInUse()` helper.

#### Scenario: inUse count shown

- GIVEN `read:bi_catastro` is assigned to 3 agents and 1 client
- WHEN the admin views the scopes list
- THEN the `read:bi_catastro` row shows `inUse: 4`.

### Requirement: Dark-Only Color Scheme

The admin UI layout (`renderLayout`) MUST emit `<meta name="color-scheme" content="dark">` and the HTML root element MUST declare `color-scheme: dark` so browsers render native controls in dark mode. All CSS in `apps/mcp-oauth-admin/src/admin/templates.ts` MUST use a dark palette (background, text, borders, focus rings, form controls, warning/error boxes) and MUST NOT include a light theme or theme toggle. Class names MUST remain unchanged. Text vs. background contrast MUST meet WCAG AA (4.5:1 for normal text, 3:1 for large text).

#### Scenario: color-scheme declared, palette dark

- GIVEN any admin page
- WHEN the page renders
- THEN the HTML includes `color-scheme: dark` declaration
- AND no light theme rules remain in the styles.

### Requirement: Typecheck Gate

`pnpm --filter mcp-oauth-admin typecheck` MUST exit `0` after the changes are applied.

#### Scenario: Typecheck passes

- GIVEN the admin UI changes are in `apps/mcp-oauth-admin`
- WHEN `pnpm --filter mcp-oauth-admin typecheck` is run
- THEN the command exits `0`.
