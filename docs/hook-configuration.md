# Provider hook configuration

This is the final, manual setup step. Drew performs these edits by hand, one
provider at a time, after `bun run scripts/install-local.ts` has completed and
been verified — the registry database and the LaunchAgent daemon must already
exist so that the first hook event has a consumer.

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
hints, title, and the working directory's basename — and discards everything
else in memory. No prompt text, transcript content, or tool payload is ever
written to the registry, the snapshot, or the logs.

---

## Claude Code

Target file: `/Users/drewritter/.claude/settings.json` (user level, applies to
all projects).

Claude supports the full ten-event set. Because the installed path contains a
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
- One second fits every event's budget, including the shared 1.5-second
  `SessionEnd` budget.

### 3. Validate

Start a new Claude Code session and run `/hooks`. Each of the ten events
should list the stream-deck-agents command. The registry should show the
session within one polling interval (see "After all three providers" below).

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

Kimi supports nine of the ten events (its `Notification` event signals
background-task status, not approval requests, so it is deliberately omitted).
Kimi hook commands are shell commands, so the installed path is double-quoted
inside a TOML literal string (single quotes — no escaping needed). Each entry
sets a one-second `timeout` (valid range 1–600).

**Strict-schema warning.** Kimi Code validates `[[hooks]]` strictly: an
unknown event name, or any field beyond `event`, `matcher`, `command`, and
`timeout`, makes the entire config file fail to load. Append exactly the nine
entries below; do not add fields, events, or comments inside the entries.

### 1. Back up

```bash
cp /Users/drewritter/.kimi-code/config.toml /Users/drewritter/.kimi-code/config.toml.before-stream-deck-agents
```

### 2. Edit

Append these nine entries to the end of the file. Leave all existing content
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
event = "PermissionRequest"
command = '"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" event kimi'
timeout = 1

[[hooks]]
event = "Stop"
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

### 3. Validate

Start a new Kimi Code session. The config must load without an error; a
strict-schema failure is reported at startup and disables all configuration,
so a clean start is the check.

### 4. Compare before replace, and restore

```bash
diff /Users/drewritter/.kimi-code/config.toml.before-stream-deck-agents /Users/drewritter/.kimi-code/config.toml
cp /Users/drewritter/.kimi-code/config.toml.before-stream-deck-agents /Users/drewritter/.kimi-code/config.toml
```

Keep the backup until physical verification is complete.

---

## Codex Desktop

Codex accepts only `SessionStart`, `UserPromptSubmit`, and `SessionEnd` for
this setup, delivered through a small local plugin. Two locations are
user-owned: the plugin directory and the personal marketplace file.

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
        "path": "./stream-deck-agents-codex"
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

`source.path` is relative to the marketplace root
(`/Users/drewritter/.agents/plugins/`), so the plugin directory sits beside
the marketplace file.

### 4. Install, enable, and trust

1. Restart Codex Desktop, open the Plugins Directory, select the **Drew
   Local** source, install **Stream Deck Agents**, and enable it.
2. **Required trust step.** Codex skips non-managed command hooks until the
   exact hook definition is reviewed and trusted; trust is recorded against a
   hash of the definition. Open the Codex CLI, run `/hooks`, review the
   stream-deck-agents-codex hooks, and approve them. Codex prints a startup
   warning while review is pending. Without this step the hooks silently never
   fire and the registry receives zero Codex events. Any later edit to
   `hooks/hooks.json` changes the hash and requires re-approval.

### 5. Behavior to expect

- A Codex session appears on the grid when its `SessionStart` hook fires. If
  the start event is missed — for example the registry was not installed yet
  or the daemon was down — later `UserPromptSubmit` events for that session
  are no-ops: the registry ignores activity for sessions it never registered,
  and the matching `SessionEnd` is ignored too. The session simply never
  appears; nothing is synthesized retroactively.
- The configured subset reports session starts, submitted-message activity,
  and session ends. V1 does not synthesize Codex idle, waiting, or error
  transitions that this configured hook subset did not report: a Codex tile is
  idle at start, working after a submitted message, and is removed at
  `SessionEnd`.

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

## After all three providers

Start a session in each provider, then list what the registry recorded:

```bash
"/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents" sessions list
```

Each active session should appear with its provider, title, and project. To
remove every recorded session (for example after testing), run
`... sessions clear-all` with the same binary.
