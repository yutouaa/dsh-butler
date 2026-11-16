# dsh-butler — a workspace butler for DSH

[中文](./README.md)

A plugin for DeepSeek Harness (DSH) that gives each workspace a dedicated "butler" session. The butler
sees what every other session in the workspace is doing, hands a task to the right session by role name
or title, and gives a single digest of session highlights, memory and skills instead of opening sessions
one by one. Pick "Enable butler" in a workspace's sidebar menu and a session named "管家" appears in
that workspace; from then on, talk to it:

> "Which sessions are in this workspace and what are they working on?"
> "Send 'run the regression suite' to the testing session."
> "Session session-xxxx pulls code; call it 'pull' from now on."

Tool descriptions, tool output and the bundled skill are written in Chinese.

## What you get

| Tool | Purpose |
|---|---|
| `butler_sessions` | Session overview: title, status (running / active / idle), last activity, recent turns |
| `butler_digest` | One-shot digest: per-session highlights + skill list + memory size (≤ 12 KB by default) |
| `butler_roles` | Role table: give a session a role name, then dispatch by that name |
| `butler_dispatch` | Cross-session dispatch: deliver a self-contained task to another session and wake it |

A `butler` skill ships with the package ([skills/butler/SKILL.md](./skills/butler/SKILL.md)) and tells the
model when to use which tool and which rules apply to dispatching.

## One dedicated butler session per workspace

- **Enable**: open the workspace's "…" menu (or context menu) in the sidebar and pick "Enable butler".
  The plugin creates a session called "管家" in that workspace and sends it an opening message asking it
  to report what the workspace's sessions are doing. If a usable butler session already exists it is
  reused, never duplicated.
- **Only that session can use the tools**: every other session, in this or any other workspace, is
  refused by all four tools, and the error tells the model which session to use instead.
- **Workspace-only**: listing, digests, roles and dispatch apply only to sessions of the butler's own
  workspace. Other workspaces are invisible and cannot be dispatched to. Roles are per workspace, so
  each workspace can have its own "testing" role.
- **Disable**: pick "Disable butler" in the same menu. The tools immediately refuse everything for that
  workspace. The butler session itself is an ordinary session and is left alone; enabling again reuses
  it. Delete or archive it yourself if you no longer want it; the next enable creates a new one.
- A workspace that never enabled the butler is untouched: no session is created and the tools refuse.

Only a person in the DSH window can flip the switch: the change request must carry the window's session
cookie, so a model with shell access cannot enable it for itself.

> Tool descriptions appear in every session's context (a few hundred characters) but only the butler
> session can actually call them; DSH has no per-session tool switch today.

## Install

**Plugin market** (once listed): Plugins → Discover, search `dsh-butler`.

**Manually (npm)**: install into the profile, add it to the bundles, restart DSH.

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-butler
```

```jsonc
// ~/.dsh/profiles/desktop/package.json
{ "dsh": { "profile": { "bundles": ["…", "dsh-butler"] } } }
```

**From source** (development, Windows / PowerShell 7): `pwsh -File scripts/install.ps1`, and
`scripts/uninstall.ps1` to remove it.

After loading, `~/.dsh/butler/last-load.json` records the version and the four tool names.

## Tool parameters

- `butler_sessions`: `full`, `includeSubagents` (booleans), `limit` (integer, default 20).
- `butler_digest`: `full`, `includeSubagents`.
- `butler_roles`: `action` (`list` | `set` | `remove`, required), `sessionId` (a top-level `session-…` id
  in this workspace, required for `set` / `remove`), `role` (required for `set`, unique within the
  workspace), `job`.
- `butler_dispatch`: `target` (required: session id, role name or title fragment), `message` (required,
  must be self-contained), `title`, `dryRun`.

## How dispatch works

Target resolution order: `session-` id → role name → session title (exact match first, then a unique
fuzzy match), all within the caller's workspace. Multiple matches are an error that lists the candidates.

Delivery uses the host's own two channels, in this order:

1. **In-process**: `sessionController.resolveAgent` → `agent.followup` → `sessions.flush`. No delay, cold
   sessions are resumed, and success is reported only after persistence acknowledges the message.
2. **Schedule fallback**: `schedule.create({ timing: { kind: "after" }, target: { kind: "session" } })`.

The target session receives a user message prefixed with `【管家派活 · 来自会话 xxxxxxxx】` (the short id of
the sending session), so it is clear the text was relayed rather than typed there. Dispatch is
asynchronous: a successful return means delivered, not finished.

### Guardrails

- The tools accept only the butler session designated for the workspace; a workspace without an enabled
  butler refuses everything.
- Only **top-level sessions of the same workspace** can be targets. Sessions of other workspaces,
  sub-agent sessions, archived sessions and the butler itself are rejected.
- At most `maxDispatchesPerHour` deliveries per hour (default 20); only successful deliveries count.
- Every attempt is appended to `~/.dsh/butler/audit.jsonl`: delivered, failed, rate-limited and dry runs.
- `dryRun` can be passed per call or switched on globally in the config.
- The plugin never dispatches on its own; it acts only when the model calls `butler_dispatch`.

## Configuration

Override in the profile's `cordis.patch.yml`:

```yaml
- id: butler
  config:
    maxDispatchesPerHour: 20   # across all workspaces
    dispatchDelaySeconds: 3    # delay for the schedule fallback, in seconds
    dryRun: false
    # dshHome: D:\dsh-home     # defaults to $DSH_HOME or ~/.dsh
```

## What it reads and writes

Read-only: the session projection cache (`~/.dsh/storages/session_projcache/sessions/*.json`),
`~/.dsh/storages/workspace.json`, `MEMORY.md` / `USER.md` under `~/.dsh` or `~/.mnemon/runtime`, and
`SKILL.md` files under `~/.dsh/skills` and `<workspace>/.dsh/skills`.

Writes only under `~/.dsh/butler/`: `roles.json`, `workspaces.json` (whether each workspace is enabled
and the id of its butler session), `audit.jsonl`, `last-load.json`. In addition, "Enable butler" asks the
host's session service to create one session in that workspace (and rename it and send the opening
message); no other session is touched, and nothing is sent on your behalf apart from dispatch. The plugin
never contacts the internet; its only HTTP traffic is the UI half reading and writing the switch on the
local host (`/dsh-butler/workspaces`). Note that a digest brings prompt snippets from other sessions of the
same workspace into the butler session's context.

## Compatibility

| DSH | Status |
|---|---|
| 0.2.2-rc.3 | experimental: automated tests pass; verify real cross-session delivery, the workspace menu switch and butler-session creation in your own setup first (`dryRun` helps for dispatch) |

Requires Node ≥ 22. Session data comes from the host's projection cache, an internal format that may
change between host releases.

## Known limits

- A session's workspace is derived from its working directory (which workspace folder it sits under).
  Two workspaces pointing at the same folder cannot be told apart.
- A session whose directory belongs to no registered workspace has no menu to click, so it has no butler.
- The menu switch exists only in the Web / desktop UI; a headless host cannot create butler sessions.
- Creating the session and the opening message rely on the host's `sessionController` service. If it is
  missing, enabling fails with an error instead of leaving a half-set switch.
- If the opening message fails to send, the butler session is just an empty session; talk to it directly
  and the tools work as usual.
- The menu label is Chinese or English, chosen from the browser language.
- Session titles are generated by DSH from the first prompt and can be long.
- A host crash can leave a stale `running` status; check the last-activity time as well.
- The rate limit is not strictly atomic under concurrent calls.
- `audit.jsonl` is not rotated.

## Development

```bash
npm test
node --test --test-name-pattern "限流" "test/*.test.mjs"
node lib/indexer.mjs list --top-level --workspace <path>
```

`@deepseek-ai/*` packages are injected by the host at runtime and are not on disk; tests replace them
with the stubs in [test/stub-host.mjs](./test/stub-host.mjs) (needs Node ≥ 22.15).

## License

[MIT](./LICENSE)
