# Provider hook configuration

This is the final, manual setup step. Drew performs these edits by hand, one
provider at a time, after `bun run scripts/install-local.ts` has completed and
been verified — the registry database and the LaunchAgent daemon must already
exist so that the first hook event has a consumer. pi and oh-my-pi are the
exceptions: the installer places their reporting shim itself, so their
sections below describe what to expect from the installed shim, not a config
edit.

Every provider invokes the same installed helper with one JSON event object on
standard input:

```text
/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents event <provider>
```

The helper reads at most 65,536 bytes of stdin, prints nothing, and always
exits zero, so a registry problem can never block, delay, or alter a provider
turn. The snippets below contain no wrapper scripts, no background processes,
and no standard-output output.

**Privacy note.** Hook payloads can carry message text, session file paths,
and tool-call details. The helper decodes only the fields needed to place a
session on the grid — event name, session and subagent identifiers, status
hints, title, the model id, the working directory's basename, and the
transcript path — and discards everything else in memory. The transcript
path is stored so the daemon can resolve the session's title and model id
from the transcript file; transcript *content* is only ever read for its
title record and its raw model id. Three signals are classified in place,
never stored: the Claude-only `run_in_background` boolean
of a Bash tool input and the constant `<task-notification>` prefix that opens
a background task's completion prompt, and zcode's `is_interrupt` boolean on
a `PostToolUseFailure` — whose `error` payload is never read. The only
transcript-derived facts that persist are the session title (Claude's
`ai-title` record) and the bounded raw model id, both extracted and bounded
by design; everything else in the transcript — prompt text, message bodies,
tool output, whole raw lines — is never written to the registry, the
snapshot, or the logs.

---

## Claude Code

Target file: `/Users/drewritter/.claude/settings.json` (user level, applies to
all projects).

Claude supports the full eleven-event set. Because the installed path contains a
space, each handler uses Claude's exec form (`command` plus `args`): Claude
spawns the executable directly with no shell, so the path needs no quoting and
nothing is shell-interpreted. Each handler sets a one-second `timeout`.

### 1. Back up

```bash
cp /Users/drewritter/.claude/settings.json /Users/drewritter/.claude/settings.json.before-stream-deck-agents
```

### 2. Edit

Merge the following top-level `"hooks"` object into the existing settings.
Keep every existing key; if a `"hooks"` object already exists, add these ten
event arrays inside it without removing any existing entries.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents",
            "args": ["event", "claude"],
            "timeout": 1
          }
        ]
      }
    ]
  }
}
```

Notes:

- Only `Notification` takes a `matcher` (`permission_prompt`); the other events
  either have no matcher support or should fire for every tool and source.
- `PostToolUse` is what clears a permission/question prompt: it fires the
  moment an answered prompt unblocks the tool call, mapping the session back
  to working. Without it a tile stays in the waiting color until the next
  `PreToolUse` or `Stop` happens to arrive.
- Background shells keep the tile in the working color: a Bash
  `run_in_background` `PreToolUse` arms a per-session flag, and `Stop` then
  maps to working instead of idle while the shell lives. A finished shell's
  completion arrives as a `UserPromptSubmit` whose prompt opens with
  `<task-notification>` and disarms the flag; a `TaskStop` `PreToolUse`
  disarms it directly. The flag is per session, not per shell, so overlapping
  background shells can idle the tile once the first completion lands. No
  extra hook entries are needed — the existing `PreToolUse`,
  `UserPromptSubmit`, and `Stop` handlers carry both signals.
- One second fits every event's budget, including the shared 1.5-second
  `SessionEnd` budget.

### Claude tile activation

Run ordinary `claude` directly in Ghostty. Ghostty must expose its native
terminal `pid` and `tty` properties for SessionStart discovery. tmux and other
terminals remain display-only and unbound. If discovery fails, the session tile
remains visible, but pressing it alerts. The hook snippets above remain
unchanged; no wrapper is installed.

### 3. Validate

Start a new Claude Code session and run `/hooks`. Each of the eleven events
should list the stream-deck-agents command. The registry should show the
session within one polling interval (see "After every provider" below).

### 4. Compare before replace, and restore

```bash
diff /Users/drewritter/.claude/settings.json.before-stream-deck-agents /Users/drewritter/.claude/settings.json
cp /Users/drewritter/.claude/settings.json.before-stream-deck-agents /Users/drewritter/.claude/settings.json
```

Keep the backup until physical verification is complete.

---

## Kimi Code

Target file: `/Users/drewritter/.kimi-code/config.toml` (current Kimi Code —
not the legacy `/Users/drewritter/.kimi/config.toml`, which belongs to the
older Python CLI and will not work).

Kimi supports ten of the eleven events (its `Notification` event signals
background-task status, not approval requests, so it is deliberately omitted)
and additionally wires `Interrupt`, which Kimi fires instead of `Stop` when a
turn is interrupted — including when a question prompt is dismissed. Kimi hook
commands are shell commands, so the installed path is double-quoted inside a
TOML literal string (single quotes — no escaping needed). Each entry sets a
one-second `timeout` (valid range 1–600).

**Strict-schema warning.** Kimi Code validates `[[hooks]]` strictly: an
unknown event name, or any field beyond `event`, `matcher`, `command`, and
`timeout`, makes the entire config file fail to load. Append exactly the eleven
entries below; do not add fields, events, or comments inside the entries.

### 1. Back up

```bash
cp /Users/drewritter/.kimi-code/config.toml /Users/drewritter/.kimi-code/config.toml.before-stream-deck-agents
```

### 2. Edit

Append these eleven entries to the end of the file. Leave all existing content
untouched.

```toml
[[hooks]]
event = "SessionStart"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "UserPromptSubmit"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "PreToolUse"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "PostToolUse"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "PermissionRequest"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "Stop"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "Interrupt"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "StopFailure"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "SessionEnd"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "SubagentStart"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "SubagentStop"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1
```

Notes:

- Kimi Web emits a titleless `SessionStart` as soon as a blank page opens and
  may never close that unused session. The helper ignores that start. The first
  `UserPromptSubmit` creates the registry session and marks it working; a
  titled `SessionStart` still restores an existing session immediately.
- A pending `AskUserQuestion` prompt needs no extra entry: `PreToolUse` carries
  `tool_name`, and the helper maps a question call to the waiting color while
  it blocks the turn; the answering `PostToolUse` maps back to working.
- `Interrupt` is wired because Kimi fires it in place of `Stop` when a turn is
  interrupted or a question dismissed — without it a dismissed prompt would
  leave the tile stuck in the waiting color until the next event.
- `SessionStart` payloads also carry `model` (and `profile`); the helper
  decodes and stores the bounded `model` value, and the tile renders it as
  small neutral text right of the provider chip. `UserPromptSubmit` carries
  no model field, so a session whose `SessionStart` was missed shows no
  model for its lifetime.

### 3. Validate

Start a new Kimi Code session. The config must load without an error; a
strict-schema failure is reported at startup and disables all configuration,
so a clean start is the check. In Kimi Web, opening and abandoning a blank page
must not add a tile; submitting its first prompt must add one.

### 4. Compare before replace, and restore

```bash
diff /Users/drewritter/.kimi-code/config.toml.before-stream-deck-agents /Users/drewritter/.kimi-code/config.toml
cp /Users/drewritter/.kimi-code/config.toml.before-stream-deck-agents /Users/drewritter/.kimi-code/config.toml
```

Keep the backup until physical verification is complete.

---

## Codex Desktop

This setup registers nine Codex lifecycle events — `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`,
`SubagentStart`, `SubagentStop`, `Stop`, and `SessionEnd` — through a small
local plugin. Codex has no `Notification` approval event or `StopFailure`;
the registry does not need the compact hooks. Two locations are user-owned:
the plugin directory and the personal marketplace file.

- Plugin directory: `/Users/drewritter/.agents/plugins/stream-deck-agents-codex/`
- Marketplace file: `/Users/drewritter/.agents/plugins/marketplace.json`

Codex runs hook command strings through a shell, so the installed path is
double-quoted inside the JSON string. Each handler sets a one-second
`timeout`, which is within the `SessionEnd` ceiling (default 1 second, maximum
3).

### 1. Back up

The marketplace file may not exist yet. If it does, back it up:

```bash
cp /Users/drewritter/.agents/plugins/marketplace.json /Users/drewritter/.agents/plugins/marketplace.json.before-stream-deck-agents
```

If it does not exist, the edit below creates it, and there is nothing to back
up. The plugin directory is new; there is nothing to back up there either.

### 2. Create the plugin

Create `/Users/drewritter/.agents/plugins/stream-deck-agents-codex/.codex-plugin/plugin.json`:

```json
{
  "name": "stream-deck-agents-codex",
  "version": "1.0.0",
  "description": "Reports Codex session lifecycle events to the local Stream Deck Agents registry.",
  "interface": {
    "displayName": "Stream Deck Agents",
    "category": "Productivity"
  }
}
```

Create `/Users/drewritter/.agents/plugins/stream-deck-agents-codex/hooks/hooks.json`
(the default hook location, so the manifest needs no `hooks` key):

```json
{
  "description": "Stream Deck Agents session registry hooks.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents\" event codex",
            "timeout": 1
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents\" event codex",
            "timeout": 1
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents\" event codex",
            "timeout": 1
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents\" event codex",
            "timeout": 1
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents\" event codex",
            "timeout": 1
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents\" event codex",
            "timeout": 1
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents\" event codex",
            "timeout": 1
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents\" event codex",
            "timeout": 1
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents\" event codex",
            "timeout": 1
          }
        ]
      }
    ]
  }
}
```

### 3. Register the marketplace

Create or edit `/Users/drewritter/.agents/plugins/marketplace.json`. If it
already exists, merge only the `plugins` entry below into the existing
`plugins` array and keep every existing key:

```json
{
  "name": "drew-local",
  "interface": {
    "displayName": "Drew Local"
  },
  "plugins": [
    {
      "name": "stream-deck-agents-codex",
      "source": {
        "source": "local",
        "path": "./.agents/plugins/stream-deck-agents-codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

`source.path` is relative to the **registered marketplace root**, not to the
marketplace file. The root is `/Users/drewritter` for the personal
marketplace (Codex discovers the file at `<root>/.agents/plugins/marketplace.json`),
so the path must reach down through `.agents/plugins/`.

Then register the marketplace once (it is not auto-discovered):

```bash
codex plugin marketplace add /Users/drewritter
```

Verify resolution before installing — the printed path must be the real
plugin directory:

```bash
codex plugin list
```

### 4. Install, enable, and trust

1. Install and enable with `codex plugin add stream-deck-agents-codex@drew-local`,
   or restart Codex Desktop, open the Plugins Directory, select the **Drew
   Local** source, install **Stream Deck Agents**, and enable it.
2. Codex runs the installed copy under `~/.codex/plugins/cache`, not the local
   marketplace source directly. After changing `hooks/hooks.json`, refresh that
   copy before looking for an approval prompt:

   ```bash
   codex plugin remove stream-deck-agents-codex@drew-local
   codex plugin add stream-deck-agents-codex@drew-local
   ```

3. **Required trust step.** Codex skips non-managed command hooks until the
   exact hook definition is reviewed and trusted. Trust is recorded per event
   entry (a hash of each entry), not per file: adding events to
   `hooks/hooks.json` later leaves the existing entries trusted, but the new
   entries are silently skipped until approved, and editing an existing entry
   rehashes that entry and requires its re-approval. Open the Codex CLI, run
   `/hooks`, review the stream-deck-agents-codex hooks, and approve every
   listed event. Codex prints a startup warning while review is pending.
   Without this step the untrusted events silently never fire — a tile that
   never receives `Stop` stays working forever, so the review must cover all
   nine entries, not just the first three.

### 5. Behavior to expect

- A Codex session appears on the grid when its `SessionStart` hook fires. If
  the start event is missed — for example the registry was not installed yet
  or the daemon was down — the next `UserPromptSubmit` for that session
  late-joins it: the prompt proves membership, so the session appears then
  instead of staying invisible forever.
- The configured subset reports session starts, submitted-message and tool
  activity, approval waits, live subagent starts and stops, turn completions,
  and session ends: a Codex tile is idle at start, working while a turn runs,
  waiting while an approval is pending, back to idle when the turn stops, and
  removed at `SessionEnd`. Every live child increments the tile's descendant
  badge; `SubagentStop` removes that child and its active descendants. Error
  transitions are not reported (Codex has no `StopFailure` event). A missed
  `SubagentStop` leaves a stale badge until the parent ends or the row is
  repaired, and a missed `SessionEnd` leaves a stale session until the
  daemon's 24-hour prune removes it — or `sessions clear` / `sessions prune`
  repairs it first.
- Tile titles come from `~/.codex/session_index.jsonl`: the daemon reads the
  thread's `thread_name` and shows it instead of the project name once Codex
  has named the thread.
- Codex Desktop spawns hidden ambient-suggestion threads that fire the same
  start and prompt hooks as real chats; left unfiltered they would add a
  phantom tile per real chat. Their payloads carry an explicit
  `"transcript_path": null` (they keep no transcript and are never
  user-visible), and the decoder drops any event that declares no transcript,
  so these threads never reach the registry.

### 6. Compare before replace, and restore

```bash
diff /Users/drewritter/.agents/plugins/marketplace.json.before-stream-deck-agents /Users/drewritter/.agents/plugins/marketplace.json
cp /Users/drewritter/.agents/plugins/marketplace.json.before-stream-deck-agents /Users/drewritter/.agents/plugins/marketplace.json
```

Then disable or remove the plugin in Codex Desktop, delete
`/Users/drewritter/.agents/plugins/stream-deck-agents-codex/`, and keep the
backup until physical verification is complete. (If the marketplace file did
not exist before, delete it instead of restoring.)

---

## ZCode

Target file: `~/.zcode/cli/config.json` (created in the back-up step below
if it does not exist yet).

ZCode supports seven events — `SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, and
`Stop`. It has no `SessionEnd`, `StopFailure`, or subagent events and no
dedicated interrupt event: a `PostToolUseFailure` carrying `is_interrupt` is
the only interrupt signal, and the helper maps it to a Stop when it arrives.
An interrupt that fires no such event leaves the tile working until the
next event or the 1-hour lease (see "Behavior to expect" below). A
`"type": "process"` hook is spawned directly with no shell, so the
executable path needs no quoting; each handler sets a two-second `timeoutMs`.

### 1. Back up

The config directory or file may not exist yet. The snippet below creates
them only when absent — an existing config is never touched — then backs it
up:

```bash
mkdir -p ~/.zcode/cli
if [ ! -e ~/.zcode/cli/config.json ]; then
  printf '{}\n' > ~/.zcode/cli/config.json
fi
cp ~/.zcode/cli/config.json ~/.zcode/cli/config.json.bak
```

### 2. Edit

Merge the following top-level `"hooks"` object into the config, keeping
every existing key. Replace every `<helper>` with the installed executable
path — `/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents`,
the same helper every provider above invokes:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart":      [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "UserPromptSubmit":  [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PreToolUse":        [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PostToolUse":       [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PostToolUseFailure":[{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PermissionRequest": [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "Stop":              [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }]
    }
  }
}
```

Warnings — these are the traps to know before editing:

- The matcher-group wrapper is required: every `events.<Event>` value is a
  list of `{ "hooks": [...] }` objects, optionally with a `matcher`. A flat
  list of executors in its place is silently ignored — zcode loads the
  config without any error and the hooks never fire.
- `timeoutMs` is **milliseconds**; `timeout` is **seconds** — never write
  `timeout` in this file.
- Hooks are snapshotted at session start: existing zcode sessions never pick
  the hooks up. Start a new session to test.
- Some 2026-06/07 builds reject the `args` array (validation bug). If zcode
  refuses to start or logs a config error, fall back to one shell string per
  event — `{ "type": "command", "command": "\"<helper>\" event zcode", "timeoutMs": 2000 }` —
  quote the path, it contains a space.
- If hooks seem inert after a zcode update, re-check this file: older builds
  silently dropped the whole section on one unknown key.

### 3. Validate

Parse the merged file before trusting it — a typo can silently disable every
hook:

```bash
bun -e 'try { JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")) } catch { process.exit(1) }' ~/.zcode/cli/config.json
```

The command prints nothing and exits zero when the JSON is valid. Then start
a NEW zcode session and confirm its tile appears (see "After every provider"
below).

### Headless and CLI use (optional)

The hooks above are all the desktop app needs. Driving zcode headlessly —
`--prompt` one-shots or the `app-server` protocol — additionally requires an
explicit model provider in this same file; without one the CLI refuses to
start (`Model config is missing`). The desktop app keeps its providers in
`~/.zcode/v2/config.json`, which the CLI does not read. Merge two more
top-level keys, mirroring the enabled provider entry from that file:

```json
{
  "model": { "main": "builtin:zai-coding-plan/GLM-5.3" },
  "provider": {
    "builtin:zai-coding-plan": {
      "name": "Z.ai - Coding Plan",
      "kind": "anthropic",
      "options": {
        "apiKey": "<key>",
        "baseURL": "https://api.z.ai/api/anthropic",
        "apiKeyRequired": true
      },
      "enabled": true,
      "source": "custom"
    }
  }
}
```

- `model.main` is a `provider/model` string ref. The object form
  (`{ "provider": ..., "model": ... }`) is silently ignored and the CLI
  keeps reporting the config missing.
- Replace `<key>` with the API key from the same entry in
  `~/.zcode/v2/config.json` — never a literal key in documentation or
  scripts. The file now carries a credential: keep it mode 0600
  (`chmod 600 ~/.zcode/cli/config.json`).
- The back-up, diff, and restore ritual in this section now handles a
  key-bearing file — treat `config.json.bak` with the same care and delete
  it once verification is complete.

### Behavior to expect

- A tile appears at the first prompt, not at session creation: zcode
  materializes hooks lazily, and the live probes saw no event (and no
  registry row) from creating a session until `UserPromptSubmit` fired.
  From there the tile goes working on prompt and tool activity, waiting
  while a permission prompt is pending, and idle when the turn ends. (All
  of this is registry-row evidence; the physical key face itself was not
  part of the live observation.)
- The helper maps a `PostToolUseFailure` carrying `is_interrupt` to a Stop
  when one arrives, but the live probes on 0.16.3 never saw one: stopping a
  session both mid-tool-call and between tool calls delivered no hook event
  at all, leaving the tile working until the next event or the 1-hour
  lease. That is the behavior to expect from an interrupt (recorded in the
  [dated verification record](verification/2026-08-15-zcode-p1.md)).
- In a headless `--mode plan` run, denying a permission prompt strands the
  tile at waiting until the next event or the 1-hour lease — the deny path
  delivers no event after `PermissionRequest` (observed live on 0.16.3);
  interactive sessions return to working and idle after the prompt is
  answered.
- Quitting zcode leaves the tile until the 1-hour lease prunes it — zcode
  has no `SessionEnd` hook, so the daemon presumes a zcode row with no hook
  event for an hour dead and removes it then.
- Titles arrive from zcode's own database a few seconds after zcode generates
  them: the daemon re-queries `~/.zcode/cli/db/db.sqlite` (`ZCODE_HOME`
  override) on its title cadence.

### 4. Compare before replace, and restore

```bash
diff ~/.zcode/cli/config.json.bak ~/.zcode/cli/config.json
cp ~/.zcode/cli/config.json.bak ~/.zcode/cli/config.json
```

Keep the backup until physical verification is complete.

---

## pi

Target file: `~/.pi/agent/extensions/stream-deck-agents.ts` — placed by the
installer, not by hand.

pi needs no config edits. The installer copies one extension file into pi's
auto-discovered extensions directory; pi loads it on every start, and it
reports session lifecycle to the daemon through the same helper every
provider above invokes.

**Ownership marker.** The file's first line is
`// stream-deck-agents: managed shim v1`. The installer re-copies any
same-named file that still starts with that marker line — customizations kept
beneath a retained marker are overwritten on the next install. To customize
the file, delete its first-line marker: the installer then treats the file as
yours, never touches it again, and it stops receiving updates.

### Behavior to expect

- A tile appears when a session starts. Extensions load in every pi process,
  but only interactive TUI sessions are reported — print (`pi -p`), JSON, and
  RPC processes never produce tiles.
- The tile goes working on prompt and tool activity, and idle when the turn
  settles.
- A failed turn shows the error tile, and it stays: the shim reports exactly
  one terminal event per turn, so the error is never overwritten by a later
  idle — it persists until the next turn's first activity.
- `/name` retitles the tile.
- `/new`, `/resume`, and `/fork` close the old row and open the new session's
  — pi reports the old session's shutdown whatever the reason.
- Escape during a streaming response settles the tile to idle. Escape during
  a tool call shows the error tile: pi records the aborted tool as an errored
  turn (live-probed on 0.84.2 — the abort fires the same terminal event pair
  as a real failure, with the error outcome). The shim serializes its helper
  spawns, so the tool-end and terminal writes always reach the registry in
  emission order — re-probed live, 6/6 abort trials showed the error tile
  with no stuck-working outcome.
- Quitting pi removes the tile.

### Known gaps

- pi has no permission or question surface, so the tile never shows waiting.
- pi reports no subagent rows.

### Verify and remove

Start a new pi session and watch its tile appear (see "After every provider"
below). To remove pi reporting, delete the file.

---

## oh-my-pi (omp)

Target file: `~/.omp/agent/extensions/stream-deck-agents.ts` — placed by the
installer, not by hand.

Same shape as pi: omp needs no config edits, the installer places one
extension file in omp's auto-discovered extensions directory, and omp loads it
on every start. The same ownership-marker rule applies — the file's first line
is `// stream-deck-agents: managed shim v1`; the installer re-copies any
same-named file that still starts with that line, and to customize the file
you delete the marker, making it yours (untouched, and no longer updated).

### Behavior to expect

- A tile appears when a session starts, goes working on prompt and tool
  activity, and idle when the turn ends.
- Approval prompts show waiting, and omp's ask question shows waiting. The
  approval UX is unchanged: the shim observes the approval event and never
  intercepts it. Live caveat (17.3.4): the task tool's Change/Acceptance
  spec dialog does not reliably raise the approval event — in most probed
  runs the tile stayed working while that dialog was open; ordinary tool
  approvals (e.g. bash) showed waiting every time.
- Subagent runs show the descendant badge on the parent tile.
- Auto-generated titles appear a few seconds after the first message: the
  daemon reads them from the title slot at the head of the session file.
- Switching sessions mid-process keeps parentage correct — the shim follows
  the visible session. The previous session's row is not closed by an
  in-process switch (omp signals session end only at process exit), so it
  lingers with its last status until the 24-hour lease prunes it — or until
  that session is resumed and quit.
- Quitting omp removes the tile.

### Known gaps

- omp has no StopFailure-equivalent event, so there is no error tile;
  interrupted turns settle the tile to idle.

**Fork churn.** omp ships multiple builds a day. If tiles stop updating after
an omp upgrade, reinstall (`bun scripts/install-local.ts`) and re-check — the
shim's host-event surface is re-verified per upgrade.

### Verify and remove

Start a new omp session and watch its tile appear (see "After every provider"
below). To remove omp reporting, delete the file.

---

## After every provider

Start a session in each provider, then list what the registry recorded:

```bash
"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" sessions list
```

Each active session should appear with its provider, title, and project. To
remove every recorded session (for example after testing), run
`... sessions clear-all` with the same binary. `... sessions prune
[max-age-hours]` deletes only sessions whose last hook is older than the
cutoff (default 24 hours); that one operator cutoff applies to every
provider alike. The daemon's automatic pass — the same prune, once a minute
— is split by provider instead: zcode rows are pruned at 1 hour, every
other provider at 24 hours.
