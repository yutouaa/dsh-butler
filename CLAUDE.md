# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dsh-butler` is a **DeepSeek Harness (DSH) plugin** (cordis 4), not a standalone Node library. It registers four tools — `butler_sessions`, `butler_digest`, `butler_roles`, `butler_dispatch` — plus a bundled `butler` skill, so one DSH session can see the other sessions in its workspace and dispatch work to them. The model is **one butler per workspace**: every tool is confined to the caller's workspace, and a sidebar menu item switches the butler on or off per workspace. Tool descriptions, tool output, the skill and the primary README are in Chinese; keep them that way (`README.en.md` is the English mirror — update both).

The `@deepseek-ai/*` imports are injected by the host at runtime and **do not exist on disk**. `npm install`, `tsc` and static analysis will report "Cannot find module" — expected. Do not add them as dependencies or bundle them. There is no build step and no linter.

## Commands

Node ≥ 22 (tests need ≥ 22.15 for `module.registerHooks`).

```bash
npm test                                                     # plugin tests (node:test) + indexer self-test
node --test "test/*.test.mjs"                                # plugin tests only
node --test --test-name-pattern "限流" "test/*.test.mjs"     # a single test by name
node test/indexer.selftest.mjs                               # data-layer self-test only (40 asserts)
node --check lib/index.mjs                                   # syntax only; the file can't be imported without the stubs
node lib/indexer.mjs list --top-level --workspace <path>     # indexer CLI: list | digest | stats | json
npm pack --dry-run                                           # confirm what would be published
```

Deploying into a running host (Windows, PowerShell 7) — this modifies the user's live DSH profile, so ask first:

```powershell
pwsh -File scripts\install.ps1      # backup profile config -> copy to ~/.dsh/profiles/desktop/node_modules/dsh-butler -> add to dsh.profile.bundles
Add-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" "# reload $(Get-Date -Format HHmmss)"   # trigger HMR
Get-Content "$env:USERPROFILE\.dsh\butler\last-load.json"   # version + 4 tool names = loaded
pwsh -File scripts\uninstall.ps1
```

The host runs the **installed copy**, not this directory; edits here do nothing until reinstalled, and edits to the installed copy are overwritten on the next install. `scripts/install.ps1` has its own list of files to copy — keep it in step with `files` in `package.json`.

## Tests

- `test/stub-host.mjs` replaces the three `@deepseek-ai/*` imports with minimal stubs via a resolve hook; it must be imported before `lib/index.mjs`.
- `test/plugin.test.mjs` builds a throwaway `DSH_HOME` fixture per test (two workspaces, so isolation is exercised) and a cordis-like `ctx` whose service access **throws unless declared through `ctx.inject`** — that strictness is the point, it mirrors the host. It also drives the HTTP route with a fake request/response and loads `lib/client.js` against a fake `window.__ModuleLoader__` and `fetch`.
- `test/indexer.selftest.mjs` is a single script of sequential `check()` calls on temp fixtures; its last section does a read-only timing pass over the real `~/.dsh` if present.
- Nothing here exercises a real host. Loading, skill registration, the workspace menu item and real cross-session delivery can only be confirmed after installing into DSH.

## Architecture

```
lib/index.mjs      plugin entry: name / inject / Config / apply(ctx, config); registers the 4 tools inline
lib/indexer.mjs    data layer (zero deps, also a CLI): session projection cache, memory, skills -> byte-budgeted markdown
lib/resolve.mjs    target string -> top-level sessionId (id | role | exact title | unique fuzzy title)
lib/dispatch.mjs   self/empty guard -> rate limit -> dryRun -> in-process delivery -> schedule fallback; audits every outcome
lib/roles.mjs      <dshHome>/butler/roles.json  (sessionId -> {role, job}); role names unique among workspace peers
lib/state.mjs      readJson/writeJson + <dshHome>/butler/workspaces.json (workspaceId -> enabled)
lib/route.mjs      HTTP handler for /dsh-butler/workspaces (GET state, POST toggle)
lib/audit.mjs      <dshHome>/butler/audit.jsonl (also the rate-limit counter)
lib/skill.mjs      skill provider serving skills/butler/SKILL.md
lib/client.js      UI half (browser script, not ESM): adds the enable/disable item to the workspace menu
```

`butler_dispatch` flow: `index.mjs` → `scopeOf` → `resolveTarget` → `dispatchToSession`. The other tools go `scopeOf` → `indexer.mjs` / `roles.mjs`. `dshHome` is resolved once in `apply` and passed explicitly everywhere; none of the helpers has a default for it.

### Workspace scope and the per-workspace switch

- Every tool starts with `scopeOf(exec)` in `index.mjs`: session cwd → `findWorkspace` (longest registered workspace path containing it) → refuse if that workspace is disabled → return the workspace id as the session filter. A cwd outside every registered workspace follows `defaultEnabled` and is scoped to that directory.
- All session lookups (`listSessions`, `buildDigest`, `resolveTarget`, role peers) take that filter, so a target in another workspace is simply "not found here". There is deliberately no cross-workspace escape hatch.
- Membership is derived from cwd, not from the host's `workspace.json` `sessionIds` lists. The two agreed exactly on real data; they can diverge only when two workspaces share or nest paths.
- The switch has two halves. Host: `ctx.inject(["webServer"], …)` registers `workspacesHandler`; a POST must come from the DSH window (`connection.browserAuth.isAuthenticated`), so a model with shell access cannot enable the butler for itself — when the host has no `connection` service the check is skipped. UI: `lib/client.js` is loaded by the web client via `exports["./client"]` and `dsh.client` in `package.json`; it must stay a dependency-free `window.__ModuleLoader__.load({ id, factory })` script returning `{ inject, apply }`, and it registers one data-only item through `ctx.contextMenus.register({ target: "workspace", … })`. If the route is unreachable it returns no item rather than breaking the menu.

### Service access (the thing most likely to break silently)

- Top-level `inject` is `["tools"]` only. Adding `schedule` / `sessionController` there makes the whole plugin wait for services that resolve lazily per scope.
- Reading an undeclared service straight off `ctx` (`ctx.sessionController`, `ctx.schedule`, `ctx.skills`, `ctx.webServer`) **throws** in cordis 4 (`cannot get property "x" without inject`); optional chaining does not help.
- So every optional service is obtained with `ctx.inject([...], (sub) => { ... })` inside `apply`. The sub-context is kept and read at call time inside a try/catch, because it goes inactive (and throws) when the dependency is unloaded.

### Host contracts

- `Config` uses schemastery (`z` from `@deepseek-ai/schemastery`), not zod. Defaults are duplicated in `cordis.patch.yml`.
- Tool `parameters` use the DSH dialect: `{ field: { type, required, description, enum } }` with `required` on the property, not a JSON-Schema array. `output` is `{ schema, render(args, value) => [{type:"text", text}] }`.
- `execute(args, exec)`: `exec.agent.session.id` is the actor session, `exec.agent.session.cwd` the default workspace filter.
- The plugin page title/description come from `locale/<lang>.json` → `meta.title` / `meta.description`.

### Dispatch (order matters)

1. **In-process (preferred):** `sessionController.resolveAgent(id)` → `agent.followup(createUserMessage(...))` → `await sessions.flush(agent.session)`. `resolveAgent` may return `{agent}`, a bare agent, or `{error:{code}}` — handle all three; `flush` returning `false` is a failure. If this channel exists and fails, the error is surfaced, not retried through the schedule channel (it is the same primitive underneath).
2. **Fallback:** `schedule.create({title, prompt, timing:{kind:"after", afterSeconds}, target:{kind:"session", sessionId}}, actorSessionId, signal)`. The host rejects it when the actor is a sub-agent session.

Only top-level sessions (`session-<uuid>`) of the caller's workspace are valid targets; bare `<uuid>` ids are sub-agent sessions. `resolve.mjs` also rejects archived sessions, and `dispatch.mjs` rejects the actor's own session. The delivered text is prefixed with `【管家派活 · 来自会话 <shortId>】`. `createUserMessage` is imported dynamically so the module loads without `@deepseek-ai/dsh-llm`.

### Data sources (all read-only)

- Sessions: `<dshHome>/storages/session_projcache/sessions/*.json`, shape `{version, record:{identity:{cwd,createdAt}, rows:{<key>:{ver,seq,val}}}}`. Rows used: `title`, `turnOutline`, `sessionStats`, `sessionListMetadata`, `workingDirectory`, `goal`, `todos`. The host writes these concurrently — the indexer retries on `EBUSY/EPERM/EACCES`, re-reads half-written JSON once, then **skips and counts** corrupt files; it must never throw for one bad file.
- Workspace table / archived ids: `<dshHome>/storages/workspace.json`.
- Memory: `<dshHome>/MEMORY.md` then `~/.mnemon/runtime/MEMORY.md` (first hit wins); `USER.md` likewise. Skills: `<dshHome>/skills/*/SKILL.md` and `<workspace>/.dsh/skills/*/SKILL.md`.
- Every path is overridable via `resolvePaths(options)` or `DSH_HOME` / `MNEMON_HOME`; the tests rely on this.
- Rendering has a hard byte budget and degrades by dropping whole session blocks rather than cutting mid-line. In real data most cache files are sub-agent sessions, which is why the tools pass `topLevelOnly` by default.

### Invariants

- The plugin writes **only** under `<dshHome>/butler/` (`roles.json`, `workspaces.json`, `audit.jsonl`, `last-load.json`). The indexer CLI's `--out` refuses paths inside `DSH_HOME`.
- Every dispatch attempt appends to `audit.jsonl` (`scheduled` / `failed` / `rate-limited` / `dry-run`); the hourly limit counts `scheduled` entries only.
- No outbound network access; the only HTTP is the UI half calling the local host route.

## Publishing layout

`files` in `package.json` is the whitelist: `lib/`, `skills/`, `locale/`, `cordis.patch.yml`, both READMEs, `CHANGELOG.md`, `LICENSE`. Bump `version` and add a `CHANGELOG.md` entry together; `last-load.json` reports the version from `package.json`.

Market listing is not done from this repo: the DSH plugin market reads the curated `awesome-dsh-plugin/awesome-dsh-plugin` registry on GitHub, so a plugin is listed by publishing to npm and opening a PR there. `dsh.compatibility.dshReleases` is `experimental` until real cross-session delivery has been confirmed in a host.

`_local/` is gitignored and unpublished: one-off host-inspection scripts, reverse-engineering notes on the host's delivery API (`_local/recon/delivery-api.md` is the evidence behind the dispatch contract), the pre-0.2 data layer, and sample output generated from real sessions. It contains personal paths and session content — never move anything from it into the published tree without scrubbing.
