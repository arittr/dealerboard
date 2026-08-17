# Grok hook payload probe (live capture)

Probe timestamp: 2026-08-16 (local; capture events stamped 2026-08-17T06:47–06:52Z)
Worktree: `/Users/drewritter/.paseo/worktrees/1au9borw/grok-provider`
Branch: `grok-provider`
Subject: grok 1.0.4 (`grok --version` → `grok 1.0.4 (d846eb93d94d) [stable]`), local install at `~/.grok`.

## Method

A temporary capture hook `~/.grok/hooks/zz-sda-capture.json` (removed after the probe;
see Cleanup) registered a `tee -a` observer for every hook event, writing one JSONL
file per event under `/tmp/grok-hook-capture/`. The hook file also carried a
deliberate unknown top-level key `x-capture-probe` (marker-tolerance probe, below).
Eight headless sessions ran from `/tmp/grok-probe-cwd`:

| # | Trigger | Purpose |
|---|---------|---------|
| 1 | `grok -p "Reply with the single word pong."` | minimum capture set |
| 2 | `grok -p "Use the terminal to run: echo sda-probe-ok — then tell me what it printed."` | force PreToolUse/PostToolUse |
| 3 | `grok -p "Use the terminal to run: exit 3 — then report what happened."` | try for PostToolUseFailure (not fired — see below) |
| 4 | `grok --max-turns 1 -p "Use the terminal to run: echo step-one — then run a second command: echo step-two — then summarize both outputs."` | scripted StopCancelled (`--max-turns` cut the turn; run errored "max turns reached") |
| 5 | `grok -p "Spawn a subagent (use your subagent-spawning capability) to determine what 7 times 8 is, then report the subagent's answer."` | SubagentStart/SubagentStop + child SessionEnd |
| 6 | `grok --permission-mode default -p "Use the terminal to run: echo perm-probe"` | try for Notification permission_prompt (not fired) |
| 7 | `grok --permission-mode default -p "Use the terminal to run this exact command: curl -s --max-time 5 https://example.com — then report the HTTP status only."` | second permission-mode attempt + coherent fixture session |
| 8 | `grok -m nonexistent-model-sda-probe -p "Say hi."` | try for StopFailure via invalid_request (run aborted at model resolution) |

`tee -a` appends each payload without a trailing newline, so per-file JSONL was parsed
by streaming `JSONDecoder.raw_decode`, not line-splitting.

## Headless firing: YES

The lifecycle hooks this project's design depends on fire headless (the ACP-fidelity
signal the design's Paseo path depends on); `PostToolUseFailure` and `Notification`
were **not** observed headless (see Not fired, below). All 8 sessions fired
`session_start`/`session_end`; every turn reported `stop` (end-turn + a
session-scoped teardown fire). Session 8 (invalid
model id) fired `session_start`, one teardown `stop`, and `session_end` with **no**
`user_prompt_submit` and no turn — `session_start` fires before model resolution, so
a start hook always lands even for a run that dies at startup.

## Marker-key tolerance: PASS

The capture hook file carried `"x-capture-probe": "stream-deck-agents probe v1"` as
an unknown top-level key alongside `hooks`, and grok loaded the file without complaint
and executed the hooks for 9 of the 12 registered events across the 8 sessions (the
remaining three — StopFailure, Notification, PostToolUseFailure — never fired; see
Not fired, below). An unknown top-level key in a hook file is tolerated — the
installer's ownership-marker scheme is safe.

## Captured vs synthesized

Captured verbatim (fixtures in `test/fixtures/grok/`, redacted — see Redaction):

| Fixture | Trigger | Notes |
|---|---|---|
| `session-start.json` | run 7 | from the coherent fixture session below |
| `user-prompt-submit.json` | run 7 | `prompt` carries a `<user_query>` XML wrapper |
| `pre-tool-use.json` | run 7, 2nd tool call | `run_terminal_command` (curl status probe) |
| `post-tool-use.json` | run 7, 2nd tool call | 12-field `toolResult`, byte-array `output` |
| `stop-end-turn.json` | run 7 | `reason: "end_turn"` |
| `stop-session-teardown.json` | run 7 | `reason: "shutdown"`, no `promptId` |
| `session-end.json` | run 7 | `reason: "shutdown"` |
| `stop-cancelled.json` | run 4 (`--max-turns 1`) | **captured live**, no synthesis needed |
| `subagent-activity.json` | run 5 | `subagent_stop` (see Subagents) |

Coherent-session note: the brief says "last line per file", but the literal last
`session_start`/`session_end`/teardown-`stop` in the logs came from run 8 — an
aborted session whose shape is identical but which never ran a turn. The captured
fixtures above instead all come from run 7 — `grok --permission-mode default -p "Use the terminal to run this exact command: curl -s --max-time 5 https://example.com — then report the HTTP status only."`
(`sessionId` `01a00e7d-588a-7de0-88a1-d9c0848594c1`), the last complete session, so
every captured fixture shares one sessionId. No field was altered by this choice; the shapes are the
same either way.

Synthesized from the §10 envelope (`~/.grok/docs/user-guide/10-hooks.md`) plus
documented per-event fields, with synthetic session/prompt ids
(`00000000-0000-4000-8000-…`) and probe-window timestamps:

| Fixture | Why synthesized |
|---|---|
| `stop-failure.json` | StopFailure needs a genuine mid-turn API error. The invalid-model run (8) aborted at model resolution before any turn, and tampering with auth was out of scope. Fields per doc: `error` (`rate_limit`), `errorDetails`, `lastAssistantMessage`. |
| `notification-permission-prompt.json` | Permission UI never waits headless: runs 6/7 under `--permission-mode default` auto-approved the tool calls without firing Notification. Fields per doc: `notificationType`, `message`; turn-scoped so `promptId` present. |
| `notification-idle-prompt.json` | `idle_prompt` fires ~1 min after a session settles; headless `-p` exits immediately. Session-scoped per doc, so no `promptId`. |

Not fired at all across all 8 runs (no fixture; none required by the interface):
`PostToolUseFailure` (run 3's `exit 3` completed as a *successful* tool call —
`toolResult.exit_code: 3` with `PostToolUse` firing, so a non-zero shell exit is not
a tool failure), `Notification` of any type, `PermissionDenied`, `PreCompact`,
`PostCompact`.

## Observed `hookEventName` values (snake_case confirmed)

`session_start`, `user_prompt_submit`, `pre_tool_use`, `post_tool_use`, `stop`,
`stop_cancelled`, `subagent_start`, `subagent_stop`, `session_end`. All snake_case;
all keys camelCase (`hookEventName`, `sessionId`, `transcriptPath`, `promptId`,
`toolName`, `toolUseId`, `toolInput`, `toolInputTruncated`, `toolResult`,
`toolResultTruncated`, `isBackgrounded`, `stopHookActive`, `lastAssistantMessage`,
`backgroundTasks`, `sessionCrons`, `permissionMode`, `subagentId`, `subagentType`).

## Envelope facts (per event)

- Common fields on every observed payload: `hookEventName`, `sessionId`, `cwd`,
  `workspaceRoot`, `timestamp` (RFC 3339 with microseconds, `+00:00` offset),
  `permissionMode`. `transcriptPath` appears on every event **except**
  `session_start`. `promptId` is absent from `session_start`/`session_end` and from
  the session-end teardown `stop` (session-scoped, per doc).
- **Deviation from doc:** `pre_tool_use`/`post_tool_use` carried **no `promptId`**
  in any capture, though the doc describes `promptId` as present on turn-scoped
  events. Decoder must not rely on `promptId` for tool events.
- `session_start`: **no `model` field.** Carries `source: "new"` (doc's matcher list
  says `startup`/`resume`; observed value is `new`). Model ids are not on the hook
  wire — the daemon must resolve them elsewhere (mirrors Claude/Codex title/model
  resolution).
- `user_prompt_submit`: `prompt` is wrapped — `<user_query>\n…\n</user_query>`.
- `pre_tool_use`: `toolName: "run_terminal_command"` (grok-native name; `Bash` is
  only a matcher alias), `toolUseId` shaped `call-<uuid>-<n>`, `toolInput` object
  (`command`, `description`), `toolInputTruncated: false`.
- `post_tool_use`: adds `toolResult` (`type: "Bash"`, `output` as a **byte array**,
  `output_for_prompt` rendered summary, `exit_code`, `command`, `truncated`,
  `signal: null`, `timed_out`, `description`, `current_dir`, `output_file` path,
  `total_bytes`), plus `toolResultTruncated`, `isBackgrounded`.
- `stop`: `reason: "end_turn"` on the turn-end fire (with `promptId`,
  `stopHookActive`, `lastAssistantMessage`, `backgroundTasks: []`,
  `sessionCrons: []`); `reason: "shutdown"` on the session-scoped teardown fire.
  The teardown fire DID carry `stopHookActive: false` — per
  `stop-session-teardown.json` its fields are exactly the common envelope
  (`hookEventName`, `sessionId`, `cwd`, `workspaceRoot`, `timestamp`,
  `permissionMode`) plus `transcriptPath`, `reason`, and `stopHookActive: false`; it
  did NOT carry `promptId`, `lastAssistantMessage`, `backgroundTasks`, or
  `sessionCrons`. **Observed stop reasons: `end_turn`,
  `shutdown`.** `channel_closed` documented but not observed headless (every
  teardown reported `shutdown`).
- `stop_cancelled` (captured via `--max-turns 1`): `reason: "max_turns"`,
  `cancelledBy: "runtime"`, `lastAssistantMessage` present, **no `cancelTrigger`**
  (doc: omitted for runtime-initiated reasons), `promptId` present.
- `session_end`: `reason: "shutdown"` (only value observed).
- `notificationType`: **none observed** — no Notification fired headless. Fixture
  values (`permission_prompt`, `idle_prompt`) are from the doc.

## Subagents (live sighting)

Run 5 spawned one subagent; three payloads fired:

- `subagent_start` — in the **parent's** session: parent `sessionId`, plus
  `subagentId`, `subagentType: "general-purpose"`, `description`. Redacted capture
  (not a fixture; the interface ships only `subagent-activity.json`):

  ```json
  {
    "hookEventName": "subagent_start",
    "sessionId": "01a00e7c-703d-7873-b3d2-f0542b99e795",
    "cwd": "/Users/you/project",
    "workspaceRoot": "/Users/you/project",
    "timestamp": "2026-08-17T06:50:42.287430+00:00",
    "transcriptPath": "/Users/you/project/.grok-sessions/01a00e7c-703d-7873-b3d2-f0542b99e795/updates.jsonl",
    "permissionMode": "auto",
    "subagentId": "01a00e7c-9ae8-7940-89d3-1cf71edcbe63",
    "subagentType": "general-purpose",
    "description": "Compute 7 times 8"
  }
  ```

- `subagent_stop` (this is `subagent-activity.json`) — fires under the **subagent's
  own** `sessionId` (== `subagentId`), with `promptId`, `phase: "gate"`,
  `subagentType`, `stopHookActive`, `lastAssistantMessage`.
- `session_end` for the child — also under the subagent's own `sessionId`, `reason:
  "shutdown"`, carrying `subagentType: "general-purpose"` (the 9th session-end vs 8
  session-starts). This confirms the design's drop rule has real traffic to catch:
  a child session's `session_end` is distinguishable only by `subagentType`
  presence. The subagent fired no `session_start` of its own, as the design assumes.

`subagentType` value sighted: `general-purpose` (only value observed).

## Redaction

All path-valued fields redacted, key casing verbatim: directory values (`cwd`,
`workspaceRoot`, `toolResult.current_dir`) → `/Users/you/project`; file paths
(`transcriptPath`, `toolResult.output_file`) → clearly synthetic paths under it:
`/Users/you/project/.grok-sessions/<sessionId>/updates.jsonl` and
`/Users/you/project/.grok-sessions/<sessionId>/terminal/<toolUseId>.log`
respectively — the ids re-embedded there are the payload's own already-verbatim
session/tool ids, so no real filesystem location survives. Every non-path field is
byte-identical to the capture. Session/prompt/tool ids and timestamps kept verbatim
in captured fixtures; synthesized fixtures use obviously-zeroed ids. A repo-wide
sweep over `test/fixtures/grok/` for `drewritter`, `/private/tmp`, `grok-probe-cwd`,
`.grok/sessions`, `%2F` found nothing.

## Cleanup

Confirmed by inspection after the probe: `~/.grok/hooks/zz-sda-capture.json`,
`/tmp/grok-hook-capture/`, and `/tmp/grok-probe-cwd/` all removed;
`~/.grok/hooks/` contains only the pre-existing untouched `orca-status.json`.
Nothing else under `~/.grok` was modified.

## Concerns for Task 4 (decoder)

1. Tool events lack `promptId` — do not correlate turns via tool events.
2. `session_start` has no model and `source` is `new` (not `startup`).
3. `stop` fires twice per headless session (`end_turn` + `shutdown` teardown); the
   teardown fire is distinguishable by `reason` and missing `promptId`.
4. `toolResult.output` is a byte array; `toolResult.signal` is `null` (not omitted).
5. A non-zero shell exit is a successful tool call (no PostToolUseFailure).
6. Synthesized fixtures carry `synthesized: true` semantics only via this note
   (zeroed ids); their `hookEventName` (`stop_failure`, `notification`) and field
   shapes come from the §10 doc, not observation.
