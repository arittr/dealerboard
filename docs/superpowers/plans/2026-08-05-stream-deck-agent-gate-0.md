# Stream Deck Agents Gate 0 Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an evidence-backed capability matrix for Codex App and CLI, Claude Code CLI and background agents, Kimi Code CLI and Web, Ghostty activation, Stream Deck lifecycle, local transport, hooks, and LaunchAgent packaging without building the product.

**Architecture:** Gate 0 is an evidence campaign with one packet per independently reviewable surface and one final report. Provider probes use supported inventories and lifecycle hooks, while small Node.js utilities record only whitelisted metadata and exercise transport; a temporary diagnostic Stream Deck action and LaunchAgent prove the actual runtime boundaries. Raw observations stay in an ignored private directory, and only redacted conclusions enter git.

**Tech Stack:** macOS, zsh, Node.js 22.23.2 with the built-in test runner, `jq`, Claude Code 2.1.222, Codex CLI 0.144.4, Kimi Code 0.32.0, Ghostty for macOS, Stream Deck 7.5.1, `@elgato/streamdeck` 2.1.0, and `@elgato/cli` 1.7.4. Record the installed versions again at execution time; do not upgrade a provider or host application during Gate 0.

## Global Constraints

- Gate 0 produces evidence, not the product. Do not build the product daemon, registry, allocator, reducer, persistence format, production adapters, installer, updater, dashboard, or production Stream Deck plugin/profile.
- Use only provider-supported commands, APIs, lifecycle hooks, and documented automation. Persisted stores may falsify a hypothesis but do not establish live membership without a documented contract and a confirming live probe.
- Do not use title, working-directory, window-order, recency, LRU, accessibility scraping, screen scraping, or private IPC as a discovery or focus fallback.
- No probe may archive, close, delete, or modify a real session. Test sessions must use the exact Gate 0 workspace and be recorded before cleanup.
- Do not persist prompts, transcripts, tool arguments, tool output, error messages, environment secrets, bearer tokens, provider credentials, or browser URLs containing tokens.
- Class A read-only version, schema, supported inventory, and process observations may run directly. Class B disposable sessions and local servers must stay inside the named Gate 0 workspace and have explicit cleanup or handback recorded.
- Class C work requires Drew's explicit approval immediately before the mutation. Class C includes temporary hooks, Stream Deck plugin/profile changes, LaunchAgents, logout/login, sleep/wake, TCC, Apple Events, and browser/App activation tests.
- Back up a user-owned configuration before changing it. Record pre-change and installed hashes, restore only when the installed hash still matches, and preserve drift for Drew instead of overwriting it.
- Every positive capability claim needs a quiet pre-existing session, observer restart, and a relevant negative or ambiguity case.
- A result is one of `PASS`, `PARTIAL`, `FAIL`, `UNSUPPORTED`, or `NOT RUN`; unsupported evidence is a valid Gate 0 outcome.
- Strict provider support requires `PASS` for live membership, logical identity, incarnation, current state, lineage, and removal. Exact activation is reported separately.
- Investigate at most one documented primary interface and one clearly supported fallback per capability. Stop strict-provider work after the first indispensable capability is conclusively `UNSUPPORTED`, except for cheap independent probes that inform a truthful reduced tier.
- Do not reverse engineer encrypted traffic, bypass code signing, inject into another process, scrape UI state, or turn a disposable probe into a long-running compatibility layer.
- Raw evidence lives only under `/Users/drewritter/projects/stream-deck-agents/.gate0-private/`, which must remain ignored by git. Committed packets contain aliases and redacted excerpts only.
- Every packet labels each material claim as documented contract, live observation on the recorded version, or inference. Source inspection alone never earns `PASS`.
- Keep unit tests behavioral. Test structured inputs/outputs and real child-process behavior; do not assert large generated scripts, manifests, JSON, or Markdown strings.

## File Map

- Modify: `.gitignore` — excludes raw Gate 0 observations and tokens.
- Create: `docs/evidence/gate-0/report.md` — final version table, capability matrix, packet index, timing summary, and decision for Drew.
- Create: `docs/evidence/gate-0/packets/environment.md` — redacted machine and tool baseline.
- Create: `docs/evidence/gate-0/packets/claude.md` — Claude CLI/background evidence.
- Create: `docs/evidence/gate-0/packets/codex-app.md` — Codex App evidence.
- Create: `docs/evidence/gate-0/packets/codex-cli.md` — Codex CLI evidence.
- Create: `docs/evidence/gate-0/packets/kimi-cli.md` — Kimi CLI evidence.
- Create: `docs/evidence/gate-0/packets/kimi-web.md` — Kimi Web evidence.
- Create: `docs/evidence/gate-0/packets/ghostty.md` — terminal identity-to-target evidence.
- Create: `docs/evidence/gate-0/packets/transport.md` — Unix-socket and loopback evidence.
- Create: `docs/evidence/gate-0/packets/stream-deck.md` — SDK lifecycle and physical rendering evidence.
- Create: `docs/evidence/gate-0/packets/launch-agent-hooks.md` — owned-runtime, LaunchAgent, and real hook-executor evidence.
- Create: `probes/hook-recorder.mjs` — bounded stdin reader and metadata whitelist for temporary hooks.
- Create: `probes/hook-recorder.test.mjs` — privacy, malformed-input, closed-stdin, file-mode, and fail-open tests.
- Create: `probes/transport/echo-server.mjs` — authenticated diagnostic server for either Unix socket or loopback.
- Create: `probes/transport/echo-server.test.mjs` — real-socket authentication, limits, mode, and shutdown tests.
- Create: `probes/stream-deck-lifecycle/` — temporary official-SDK diagnostic action, pure context registry, and tests.
- Modify: `docs/design.md` — replace hypotheses only after the final evidence review; do not choose product scope for Drew.

---

### Task 1: Evidence Boundary and Environment Baseline

**Files:**
- Modify: `.gitignore`
- Create: `docs/evidence/gate-0/report.md`
- Create: `docs/evidence/gate-0/packets/environment.md`

**Interfaces:**
- Consumes: The verdict vocabulary and capability requirements in `docs/superpowers/specs/2026-08-05-stream-deck-agent-gate-0-design.md`.
- Produces: The report matrix and packet format every later task updates.

- [ ] **Step 1: Add the private evidence directory to `.gitignore`**

Use `apply_patch` to add exactly:

```gitignore
.gate0-private/
```

Run: `git check-ignore -v .gate0-private/example.json`

Expected: output names `.gitignore` and the `.gate0-private/` rule.

- [ ] **Step 2: Create the initial report**

Use `apply_patch` to create `docs/evidence/gate-0/report.md` with this structure and initialize every capability cell to `NOT RUN`:

```markdown
# Stream Deck Agents Gate 0 Report

Date started: 2026-08-05
Status: IN PROGRESS

## Versions

See [environment packet](packets/environment.md).

## Capability matrix

| Surface | Membership | Identity | Incarnation | State | Metadata | Lineage | Removal | Activation | Sleep/reconnect |
|---|---|---|---|---|---|---|---|---|---|
| Claude Code CLI/background | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Codex App | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Codex CLI | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Kimi Code CLI | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Kimi Code Web | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

## Shared runtime

| Boundary | Result | Evidence |
|---|---|---|
| Ghostty exact terminal join | NOT RUN | [packet](packets/ghostty.md) |
| Stream Deck action lifecycle | NOT RUN | [packet](packets/stream-deck.md) |
| Local transport | NOT RUN | [packet](packets/transport.md) |
| LaunchAgent and hooks | NOT RUN | [packet](packets/launch-agent-hooks.md) |

## Provider packets

- [Claude Code CLI/background](packets/claude.md)
- [Codex App](packets/codex-app.md)
- [Codex CLI](packets/codex-cli.md)
- [Kimi Code CLI](packets/kimi-cli.md)
- [Kimi Code Web](packets/kimi-web.md)

## Timing summary

Measurements are added after the corresponding probe. No universal lease is inferred.

## Decision for Drew

The evidence has not yet been synthesized. This section will list the strict-support boundary and reduced-tier options without choosing one.
```

- [ ] **Step 3: Capture a redacted environment baseline**

Run these read-only commands and record only version, architecture, bundle identifier, bundle version, and 5x3 device count in `packets/environment.md`:

```bash
sw_vers
uname -m
claude --version
codex --version
kimi --version
node --version
npm --version
defaults read '/Applications/Elgato Stream Deck.app/Contents/Info' CFBundleShortVersionString
defaults read '/Applications/ChatGPT.app/Contents/Info' CFBundleIdentifier
defaults read '/Applications/ChatGPT.app/Contents/Info' CFBundleShortVersionString
defaults read '/Applications/Ghostty.app/Contents/Info' CFBundleShortVersionString
npm view @elgato/streamdeck version --json
npm view @elgato/cli version --json
system_profiler SPUSBDataType
```

Keep the full System Information output private. Record only the Stream Deck device model and count; do not commit a USB serial number. Task 10 later verifies the SDK's connected-device view separately.

- [ ] **Step 4: Verify the evidence boundary**

Run:

```bash
git check-ignore .gate0-private/example.json
git diff --check
rg -n 'Authorizatio[n]:|Beare[r] [A-Za-z0-9._-]+|(^|[^A-Za-z])s[k]-[A-Za-z0-9_-]+' docs/evidence probes || true
```

Expected: the ignore check succeeds, `git diff --check` is silent, and the secret scan returns no credential values.

- [ ] **Step 5: Commit the evidence foundation**

```bash
git add .gitignore docs/evidence/gate-0/report.md docs/evidence/gate-0/packets/environment.md
git commit -m "Set up the Gate 0 evidence boundary"
```

### Task 2: Privacy-Safe Hook Recorder

**Files:**
- Create: `probes/hook-recorder.mjs`
- Create: `probes/hook-recorder.test.mjs`

**Interfaces:**
- Consumes: JSON on stdin plus `GATE0_PROVIDER`, `GATE0_WORKSPACE`, and `GATE0_EVENT_LOG` environment variables.
- Produces: At most one mode-`0600` JSONL record with `observedAt`, `provider`, `hookEventName`, `sessionId`, `cwdMatches`, `lifecycleSource`, `reason`, `notificationType`, `agentId`, and `agentType`. It writes nothing for malformed, oversized, or out-of-workspace input and always exits zero without stdout.

- [ ] **Step 1: Write behavioral tests for the whitelist**

Create tests using `node:test`, `node:assert/strict`, `mkdtempSync`, and `spawnSync`. The central assertion must be equivalent to:

```js
const input = {
  hook_event_name: "PermissionRequest",
  session_id: "session-test-1",
  cwd: workspace,
  agent_id: "agent-test-1",
  agent_type: "Explore",
  prompt: "must not persist",
  tool_input: { command: "must not persist" },
  tool_output: "must not persist",
  error_message: "must not persist",
};

const result = runRecorder(input, env);
assert.equal(result.status, 0);
assert.equal(result.stdout, "");
const record = JSON.parse(readFileSync(logPath, "utf8"));
assert.deepEqual(Object.keys(record).sort(), [
  "agentId",
  "agentType",
  "cwdMatches",
  "hookEventName",
  "notificationType",
  "observedAt",
  "provider",
  "reason",
  "sessionId",
  "lifecycleSource",
].sort());
assert.equal(JSON.stringify(record).includes("must not persist"), false);
```

Add cases for mismatched workspace, malformed JSON, input over 65,536 bytes, closed stdin, an unwritable/missing log parent, and an existing overly permissive log file corrected to mode `0600`.

- [ ] **Step 2: Run the tests and observe the expected failure**

Run: `node --test probes/hook-recorder.test.mjs`

Expected: FAIL because `probes/hook-recorder.mjs` does not exist.

- [ ] **Step 3: Implement the minimal recorder**

Implement these exact boundaries:

```js
const MAX_INPUT_BYTES = 65_536;
const SAFE_FIELDS = {
  hookEventName: ["hook_event_name", "hookEventName"],
  sessionId: ["session_id", "sessionId"],
  lifecycleSource: ["source"],
  reason: ["reason"],
  notificationType: ["notification_type", "notificationType"],
  agentId: ["agent_id", "agentId"],
  agentType: ["agent_type", "agentType", "agent_name"],
};

function safeString(value) {
  return typeof value === "string" ? value.slice(0, 256) : null;
}
```

Read stdin incrementally and stop buffering once the byte limit is exceeded. Resolve the configured workspace and input `cwd` with `realpathSync`; write only when they match. Open the pre-existing parent directory with append/create mode `0600`, call `fchmodSync(fd, 0o600)`, append one JSON object plus newline, close the descriptor in `finally`, catch all errors, emit no stdout/stderr, and leave `process.exitCode = 0`.

- [ ] **Step 4: Run the focused tests**

Run: `node --test probes/hook-recorder.test.mjs`

Expected: all recorder tests PASS.

- [ ] **Step 5: Run real closed-stdin and malformed-input smoke tests**

Run:

```bash
env GATE0_PROVIDER=smoke GATE0_WORKSPACE="$PWD" GATE0_EVENT_LOG="$PWD/.gate0-private/smoke.jsonl" node probes/hook-recorder.mjs <&-
printf '%s' '{not-json' | env GATE0_PROVIDER=smoke GATE0_WORKSPACE="$PWD" GATE0_EVENT_LOG="$PWD/.gate0-private/smoke.jsonl" node probes/hook-recorder.mjs
```

Expected: both commands exit zero, print nothing, and do not create `smoke.jsonl`.

- [ ] **Step 6: Commit the recorder**

```bash
git add probes/hook-recorder.mjs probes/hook-recorder.test.mjs
git commit -m "Add a privacy-safe Gate 0 hook recorder"
```

### Task 3: Claude Code CLI and Background-Agent Packet

**Files:**
- Create: `docs/evidence/gate-0/packets/claude.md`
- Modify: `docs/evidence/gate-0/report.md`
- Temporary: `.gate0-private/claude-settings.json`, `.gate0-private/claude-events.jsonl`

**Interfaces:**
- Consumes: `claude agents --json`, Claude lifecycle hooks, the Task 2 recorder, and test-session ground truth.
- Produces: Verdicts for Claude membership, identity, incarnation, state, lineage, removal, and restart recovery. Ghostty activation remains `NOT RUN` until Task 8.

- [ ] **Step 1: Record the documented and installed surface**

Read the official hook reference at `https://code.claude.com/docs/en/hooks` and environment reference at `https://code.claude.com/docs/en/env-vars`. Run:

```bash
claude --version
claude agents --help
claude agents --json | jq '{count:length, schemas:(map(keys)|unique), kinds:(map(.kind)|unique), states:(map(.state // .status)|unique)}'
```

Record the help/schema facts but no existing session IDs, names, paths, or start times.

- [ ] **Step 2: Create the shared ambiguity workspace**

Create `/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared/README.md` with `apply_patch`; its only content is `# Gate 0 Test Workspace`. Create the private log parent and ensure it is mode `0700`.

- [ ] **Step 3: Pause for Class C hook approval**

Ask Drew to approve a command-line-only Claude hook configuration for Gate 0. Explain that it is passed with `--settings`, does not edit `~/.claude`, records only the Task 2 whitelist, and is removed after the packet.

- [ ] **Step 4: Create the temporary Claude settings**

After approval, use `apply_patch` to create `.gate0-private/claude-settings.json`. Configure `SessionStart`, `SessionEnd`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, and `SubagentStop`; every entry contains one command hook with timeout `5` whose command is:

```text
env GATE0_PROVIDER=claude GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/claude-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs
```

Use this exact JSON shape:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "env GATE0_PROVIDER=claude GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/claude-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "env GATE0_PROVIDER=claude GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/claude-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs", "timeout": 5 }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "env GATE0_PROVIDER=claude GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/claude-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs", "timeout": 5 }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "env GATE0_PROVIDER=claude GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/claude-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "env GATE0_PROVIDER=claude GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/claude-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs", "timeout": 5 }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "env GATE0_PROVIDER=claude GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/claude-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs", "timeout": 5 }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "env GATE0_PROVIDER=claude GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/claude-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs", "timeout": 5 }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "env GATE0_PROVIDER=claude GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/claude-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs", "timeout": 5 }] }]
  }
}
```

Validate: `jq empty .gate0-private/claude-settings.json`

- [ ] **Step 5: Start two quiet sessions before observation**

From two PTYs in the exact shared workspace, generate and privately record two UUIDs, then launch:

```bash
claude --settings /Users/drewritter/projects/stream-deck-agents/.gate0-private/claude-settings.json --setting-sources user --session-id "$CLAUDE_GATE0_ID" --name gate0-ambiguous
```

Use the same display name and working directory in both sessions. Leave both idle before running `claude agents --json`; alias them `C1` and `C2` in committed evidence.

- [ ] **Step 6: Test quiet recovery and live arrival**

Run `claude agents --json` twice from a fresh observer process, verify `C1` and `C2` appear while quiet, then start `C3` with the same command while repeating inventory. Record whether inventory is complete; whether native `sessionId`, `pid`, `startedAt`, `kind`, and state fields give an unambiguous attachment identity; and whether title plus repository/worktree metadata are available without transcript reads.

- [ ] **Step 7: Exercise state and lineage**

In `C1`, request one harmless `sleep 10` shell command to expose busy state. In `C2`, request a harmless command that the current permission policy requires Drew to approve, leave it pending long enough to observe `blocked`/permission state, then approve it. In `C3`, request one subagent to read the test README and return its heading.

Observe both `agents --json` and the hook log before, during, and after each transition. For a safe failure, invoke a nonexistent command in the test workspace; report `PARTIAL` rather than inventing an error state if Claude continues and exposes no unrecovered-failure fact.

- [ ] **Step 8: Test background and restart recovery**

Open `claude agents`, dispatch one named background test agent in the shared workspace, and leave it quiet. In `C1`, start a long-running test descendant, wait until it is live, then restart only the inventory/observer process so the descendant predates the restarted observer. Record whether the background session and complete pre-existing descendant topology are recoverable without replaying transcript content.

While inventory is active, capture the five required ordering traces: start `C3` during repeated inventory, move `C2` from busy to blocked during inventory, exit a test attachment immediately after an inventory begins, resume it with the same logical ID, and restart the observer with all sources quiet. State which native metadata, if any, orders hooks against inventory; do not infer an order from the probe clock.

- [ ] **Step 9: Test close, resume, and incarnation**

Exit `C1`, measure removal from `agents --json`, then set `C1_NATIVE_ID` from the private alias map and resume the same logical session with `claude --resume "$C1_NATIVE_ID"` in a new PTY. Record which fields remain stable and which attachment fields change. A process `pid` plus native start identity is only an incarnation candidate if it survives observer restart and changes on reopen.

- [ ] **Step 10: Write and verify the packet**

Before writing, exercise the actual Claude hook executor with three command-line-only settings variants: the normal recorder, `/usr/bin/false`, and `/bin/sleep 5` with hook timeout `1`. For each variant, run one harmless noninteractive Gate 0 prompt with the Claude process's stdin closed, measure wall time, and confirm the agent command terminates or continues according to the documented fail-open contract. Restore the normal private settings file afterward and record no prompt text.

Write `packets/claude.md` with: hypothesis, version, documented contract, setup, scenario-by-scenario observation, timing, verdict per capability, limitations, and cleanup. Use only aliases `C1`, `C2`, `C3`, and `CB1`. Update the Claude row in `report.md`; leave activation `NOT RUN`.

Run:

```bash
git diff --check
rg -n 'Authorizatio[n]:|Beare[r] [A-Za-z0-9._-]+|(^|[^A-Za-z])s[k]-[A-Za-z0-9_-]+' docs/evidence/gate-0/packets/claude.md || true
```

Expected: no whitespace errors or credential values.

- [ ] **Step 11: Stop only the named test sessions and commit**

Exit the Gate 0 Claude sessions. If Claude exposes no supported exact-session delete operation, list the retained Gate 0 history aliases for Drew instead of deleting history files directly. Do not delete or archive unrelated history. Remove the private settings file and hook log after extracting the redacted packet.

```bash
git add docs/evidence/gate-0/packets/claude.md docs/evidence/gate-0/report.md
git commit -m "Record Claude Gate 0 capability evidence"
```

### Task 4: Codex App Packet

**Files:**
- Create: `docs/evidence/gate-0/packets/codex-app.md`
- Modify: `docs/evidence/gate-0/report.md`
- Temporary: `.gate0-private/codex-app-schema/`

**Interfaces:**
- Consumes: The installed App bundle, the bundled Codex app-server schema, documented app-server protocol, and App-visible test tasks.
- Produces: Evidence that distinguishes persisted, loaded, and live App tasks and identifies whether an external supported attachment point exists.

- [ ] **Step 1: Record the App and bundled server versions**

Run:

```bash
defaults read '/Applications/ChatGPT.app/Contents/Info' CFBundleIdentifier
defaults read '/Applications/ChatGPT.app/Contents/Info' CFBundleShortVersionString
'/Applications/ChatGPT.app/Contents/Resources/codex' --version
```

Record only the versions and bundle identifier.

- [ ] **Step 2: Generate the bundled protocol schema**

Run:

```bash
mkdir -p .gate0-private/codex-app-schema
'/Applications/ChatGPT.app/Contents/Resources/codex' app-server generate-json-schema --experimental --out .gate0-private/codex-app-schema
rg -n 'thread/loaded/list|thread/status/changed|thread/list|parentThreadId|ancestorThreadId' .gate0-private/codex-app-schema
```

Compare the installed schema with the official app-server README at `https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`. Record method presence, not generated schema bodies.

- [ ] **Step 3: Establish loaded/unloaded controls in the App**

Use two clearly named Gate 0 App tasks in the shared test workspace and one unarchived but unloaded Gate 0 control task. Do not close, archive, or modify any pre-existing task. Record aliases `A1`, `A2`, and `AH1` privately.

- [ ] **Step 4: Look for a supported external attachment point**

Use bundle documentation, `codex app-server --help`, and `codex app-server daemon version --json`. For the running bundled app-server process, inspect only `pid`, `ppid`, start time, executable path, and Unix-socket file descriptors in private evidence. Do not capture its full command line, connect to its stdio, attach a debugger, inject code, or use an undocumented socket.

If a supported external endpoint is reachable, capture start-during-inventory, state-change-during-inventory, close-then-late-event, resume, and quiet observer-restart traces. If no endpoint is reachable, record those traces as blocked by the same unsupported attachment boundary rather than probing private transport.

If the App publishes no supported endpoint that a separate per-user daemon can connect to, classify live membership, restart recovery, state, and lineage as `UNSUPPORTED`. The existence of `thread/loaded/list` in a server protocol does not pass unless the observer can reach the App's server through a supported boundary.

- [ ] **Step 5: Reconfirm the cold-history falsification**

Use the existing redacted aggregate count only: 288 unarchived top-level stored threads on 2026-08-05. Do not commit thread names, IDs, paths, or transcript data. State explicitly that `archived = false` is a negative filter, not positive liveness.

- [ ] **Step 6: Test exact App activation only if a supported route exists**

If current official documentation or an App-provided Copy Link action exposes a task route, pause for Drew's Class C approval. Test it with `A1` and `A2`, including repeated activation while the other task is frontmost. It passes only if it selects the exact existing task and does not create a duplicate. If no supported route exists, record `UNSUPPORTED` without searching the bundle for private schemes.

- [ ] **Step 7: Write, review, and commit the packet**

Write `packets/codex-app.md` and update the App matrix row, including supported title and repository/worktree metadata. Separate protocol capability from App attachment capability, and mark every unrun dependent dimension consistently after the strict stop condition. Archive or delete only the exact Gate 0 App tasks if the App exposes a supported exact action and Drew approves; otherwise list `A1`, `A2`, and `AH1` as retained test history for Drew.

```bash
git diff --check
git add docs/evidence/gate-0/packets/codex-app.md docs/evidence/gate-0/report.md
git commit -m "Record Codex App Gate 0 capability evidence"
```

### Task 5: Codex CLI Packet

**Files:**
- Create: `docs/evidence/gate-0/packets/codex-cli.md`
- Modify: `docs/evidence/gate-0/report.md`
- Temporary: `.gate0-private/codex-cli/`

**Interfaces:**
- Consumes: Default Codex CLI processes, supported CLI/app-server commands, test rollout metadata, and optionally one documented shared-app-server fallback.
- Produces: A default-mode verdict and a separately labeled shared-server fallback verdict; it never treats the fallback as normal CLI support.

- [ ] **Step 1: Start two default quiet CLI controls**

From two PTYs in the shared workspace, run:

```bash
codex --no-alt-screen -C /Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared
```

Record each TTY, process PID/start time, and native session ID as private ground truth aliases `X1` and `X2`. Start a third session `X3` only after the observer commands begin.

- [ ] **Step 2: Attempt the documented primary inventory**

Inspect `codex --help`, `codex app-server --help`, and generated schemas. Determine whether the default TUI publishes a supported inventory or attachment endpoint. Process enumeration may prove that a terminal process exists; persisted rollout metadata may explain its session ID; neither counts as a complete supported join unless a documented interface connects them.

Run process checks with selected fields only:

```bash
ps -t "$CODEX_GATE0_TTY" -o pid=,ppid=,lstart=,comm=
lsof -a -p "$CODEX_GATE0_PID" -d cwd -Fn
```

Keep raw paths private and record only whether a deterministic native join exists.

- [ ] **Step 3: Exercise state, lineage, restart, and removal only while useful**

Use the same harmless busy, approval-waiting, pre-observer descendant, post-observer descendant, and nonexistent-command scenarios as the Claude packet. Restart only the observer. Exit `X1`, resume its logical session with `codex resume "$X1_NATIVE_ID"`, and compare identities. If default-mode membership is already conclusively `UNSUPPORTED`, record cheap independent state/lineage observations but do not build a compatibility layer from rollouts.

When a supported snapshot plus event surface exists, capture start-during-inventory, state-change-during-inventory, close-then-late-event, resume, and quiet observer-restart traces. Otherwise, record the first unavailable source that prevents each trace.

- [ ] **Step 4: Probe one documented shared-server fallback**

Pause for Drew's Class C approval before starting the managed app-server daemon or changing how a test CLI launches. If approved, use `codex app-server daemon start` and launch one test TUI with the documented `--remote unix://` form. Use the documented proxy/control surface to attempt `thread/loaded/list` and `thread/status/changed` recovery.

Label this result `shared app-server launch mode`; do not generalize it to existing default CLI sessions. Stop and remove the managed daemon after the probe unless it predated Gate 0.

- [ ] **Step 5: Defer exact terminal activation to Task 8**

Record the TTY/PID/native session side of the join for `X1` and `X2`; leave activation `NOT RUN` until Ghostty IDs are tested under ambiguity.

- [ ] **Step 6: Write, clean up, and commit the packet**

Write the default and fallback results separately, including supported title and repository/worktree metadata. Exit only `X1`–`X3`. Delete Gate 0 sessions only through `codex delete "$CODEX_GATE0_NATIVE_ID"` after verifying each ID against the private alias map; never use a broad selector.

```bash
git diff --check
git add docs/evidence/gate-0/packets/codex-cli.md docs/evidence/gate-0/report.md
git commit -m "Record Codex CLI Gate 0 capability evidence"
```

### Task 6: Kimi Code CLI Packet

**Files:**
- Create: `docs/evidence/gate-0/packets/kimi-cli.md`
- Modify: `docs/evidence/gate-0/report.md`
- Temporary: `.gate0-private/kimi-events.jsonl`
- Temporary mutation: `~/.kimi-code/config.toml`, only after Class C approval.

**Interfaces:**
- Consumes: Kimi lifecycle hooks, process/TTY observations, session index metadata, and the Task 2 recorder.
- Produces: Kimi CLI membership, identity, incarnation, state, lineage, removal, and restart verdicts. Activation remains `NOT RUN` until Task 8.

- [ ] **Step 1: Record the documented Kimi surfaces**

Read `https://moonshotai.github.io/kimi-code/en/customization/hooks`, `https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html`, and current `kimi --help`. Run `test -z "${KIMI_CODE_HOME:-}"`; this plan's exact backup paths require the current default home, so stop and revise the paths with Drew if the variable is set. Record that hooks include session, permission, stop/failure, and subagent events, while persisted sessions are history until liveness is independently proven. Do not copy credentials into a synthetic Kimi home for this probe.

- [ ] **Step 2: Pause for Class C config approval**

Explain the exact config block, recorder whitelist, test-workspace filter, timeout, backup path, and rollback rule to Drew. Do not change `~/.kimi-code/config.toml` without explicit approval.

- [ ] **Step 3: Back up and append the temporary hooks safely**

After approval, run:

```bash
kimi doctor
cp -p /Users/drewritter/.kimi-code/config.toml /Users/drewritter/projects/stream-deck-agents/.gate0-private/kimi-config.before.toml
shasum -a 256 /Users/drewritter/.kimi-code/config.toml /Users/drewritter/projects/stream-deck-agents/.gate0-private/kimi-config.before.toml
```

Stop if the doctor command fails or the config is missing. Otherwise use `apply_patch` to append this exact marker-delimited block:

```toml
# stream-deck-agents-gate0:begin
[[hooks]]
event = "SessionStart"
command = "env GATE0_PROVIDER=kimi GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/kimi-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs"
timeout = 1

[[hooks]]
event = "SessionEnd"
command = "env GATE0_PROVIDER=kimi GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/kimi-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs"
timeout = 1

[[hooks]]
event = "PermissionRequest"
command = "env GATE0_PROVIDER=kimi GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/kimi-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs"
timeout = 1

[[hooks]]
event = "Stop"
command = "env GATE0_PROVIDER=kimi GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/kimi-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs"
timeout = 1

[[hooks]]
event = "StopFailure"
command = "env GATE0_PROVIDER=kimi GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/kimi-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs"
timeout = 1

[[hooks]]
event = "SubagentStart"
command = "env GATE0_PROVIDER=kimi GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/kimi-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs"
timeout = 1

[[hooks]]
event = "SubagentStop"
command = "env GATE0_PROVIDER=kimi GATE0_WORKSPACE=/Users/drewritter/projects/stream-deck-agents/.gate0-private/workspaces/shared GATE0_EVENT_LOG=/Users/drewritter/projects/stream-deck-agents/.gate0-private/kimi-events.jsonl /Users/drewritter/.local/bin/node /Users/drewritter/projects/stream-deck-agents/probes/hook-recorder.mjs"
timeout = 1
# stream-deck-agents-gate0:end
```

Run `kimi doctor` again and record the installed config hash. If parsing fails, restore the backup immediately and stop this probe.

- [ ] **Step 4: Test quiet recovery and process-to-session joining**

Start `K1` and `K2` from two PTYs in the same shared workspace, leave them quiet, then start the observer. Inspect only process PID/start time/TTY and the field names of relevant session-index entries. Start `K3` after observation begins.

Determine whether a supported inventory joins every quiet live process to a native Kimi session ID. A hook seen at startup plus a later process scan does not prove restart recovery unless the join can be reconstructed after the recorder starts fresh.

- [ ] **Step 5: Exercise state, lineage, close/resume, and background behavior**

Run harmless busy, approval-waiting, pre-observer descendant, post-observer descendant, and safe failure scenarios. Restart only the observer, then exit and resume `K1` with `kimi --session "$K1_NATIVE_ID"`. If background-task keep-alive is enabled in the installed version, create one named test background task and observe whether its membership outlives the foreground TUI through a supported interface.

Capture start-during-inventory, state-change-during-inventory, close-then-late-hook, resume, and quiet observer-restart traces. State whether the hook event and any inventory share native sequence/incarnation metadata; wall-clock arrival order is not enough.

- [ ] **Step 6: Restore the Kimi config using compare-before-change**

Before restoration, use `apply_patch` on only the marker-delimited Gate 0 block to exercise `/usr/bin/false` and `/bin/sleep 5` with timeout `1`, one variant at a time. Run one harmless noninteractive Kimi prompt with the Kimi process's stdin closed for each variant, measure wall time, verify fail-open behavior, and restore the recorder command plus a passing `kimi doctor` after each case. Record no prompt text.

Before restoration, run `shasum -a 256 /Users/drewritter/.kimi-code/config.toml` and compare it with the privately recorded installed hash. If it matches, restore with:

```bash
cp -p /Users/drewritter/projects/stream-deck-agents/.gate0-private/kimi-config.before.toml /Users/drewritter/.kimi-code/config.toml
kimi doctor
rg -n 'stream-deck-agents-gate0' /Users/drewritter/.kimi-code/config.toml
```

Expected: `kimi doctor` succeeds and `rg` finds no marker. If the pre-restore hash differs, do not overwrite it; show Drew the marker and preserve both current and backup files for manual reconciliation.

- [ ] **Step 7: Write and commit the packet**

Use aliases `K1`–`K3` and `KB1`, record supported title and repository/worktree metadata, update the Kimi CLI matrix row, and leave activation for Task 8. Exit only those sessions. If the installed Kimi CLI exposes no supported exact-session deletion command, list the retained Gate 0 history aliases for Drew instead of deleting store files directly.

```bash
git diff --check
git add docs/evidence/gate-0/packets/kimi-cli.md docs/evidence/gate-0/report.md
git commit -m "Record Kimi CLI Gate 0 capability evidence"
```

### Task 7: Kimi Code Web Packet

**Files:**
- Create: `docs/evidence/gate-0/packets/kimi-web.md`
- Modify: `docs/evidence/gate-0/report.md`
- Temporary: `.gate0-private/kimi-web/`

**Interfaces:**
- Consumes: `kimi web`, its advertised OpenAPI and AsyncAPI documents, instance registration, and browser-client controls.
- Produces: A verdict that separates server process, persisted session, and attached browser-client membership.

- [ ] **Step 1: Start the first isolated Web server**

From the shared test workspace run `kimi web --no-open --port 58628`. Keep the printed bearer token only in the private terminal/session environment. Do not save the startup URL or token in git.

- [ ] **Step 2: Capture schemas without content**

Fetch authenticated `/openapi.json` and `/asyncapi.json` into `.gate0-private/kimi-web/`. Record only operation/channel names relevant to session inventory, runtime state, agents, and browser clients. Do not record response bodies containing prompts, messages, file paths, or tokens.

- [ ] **Step 3: Create cold and attached controls**

Prepare one persisted cold Gate 0 session with no tab (`WH1`) and two live tabs (`W1`, `W2`) with duplicate visible titles. Create `W1` by switching from the known Kimi CLI test session `K1` through the documented `/web` flow so logical-session identity can be compared across CLI and Web. Compare the supported API/event stream before opening tabs, with both attached, after closing one tab, and after reconnecting it.

`PASS` for Web membership requires an authoritative client-attachment distinction. A server process plus a stored session list is not sufficient.

- [ ] **Step 4: Test multiple servers and observer restart**

Start a second server on port `58638` sharing the normal Kimi home, if the installed version documents this topology. Verify instance registration, overlapping stored sessions, source loss when one server exits, and recovery when it restarts. Restart only the API observer while both tabs remain quiet.

Capture session-start-during-inventory, state-change-during-inventory, tab-close-then-late-event, reconnect/resume, and quiet observer-restart traces. Record whether the REST and WebSocket surfaces share native ordering or client-incarnation metadata.

- [ ] **Step 5: Test state, lineage, removal, and exact existing-tab focus**

Exercise harmless working, permission-waiting, idle, safe-failure, and subagent scenarios through `W1`. For activation, first identify the current default browser and its documented automation surface. Pause for Class C approval before controlling it. Pass only if a native session/client identity joins to and focuses the exact existing `W1` tab under duplicate-title ambiguity; opening a new URL/tab fails.

- [ ] **Step 6: Stop servers and commit the packet**

Send `SIGTERM` only to the privately recorded Gate 0 server PIDs and confirm their instance registrations disappear. Remove only exact Gate 0 Web sessions through a supported session-delete action; otherwise list `WH1`, `W1`, and `W2` as retained test history for Drew. Write `packets/kimi-web.md`, including supported title and repository/worktree metadata, update the matrix, and remove token-bearing private schema/trace files.

```bash
git diff --check
git add docs/evidence/gate-0/packets/kimi-web.md docs/evidence/gate-0/report.md
git commit -m "Record Kimi Web Gate 0 capability evidence"
```

### Task 8: Ghostty Exact-Terminal Join Packet

**Files:**
- Create: `docs/evidence/gate-0/packets/ghostty.md`
- Modify: `docs/evidence/gate-0/report.md`

**Interfaces:**
- Consumes: Native provider process/session facts from Tasks 3, 5, and 6 plus Ghostty's installed AppleScript dictionary.
- Produces: A proof or first missing link for `provider session -> PID/TTY -> Ghostty terminal id -> focus`.

- [ ] **Step 1: Inspect the supported Ghostty object model**

Read `https://ghostty.org/docs/features/applescript` and run:

```bash
sdef /Applications/Ghostty.app > .gate0-private/Ghostty.sdef
rg -n 'class name="(window|tab|terminal)"|property name="(id|working directory|name|tty|process)' .gate0-private/Ghostty.sdef
```

Record the supported properties only. The documented ability to focus a known terminal ID is not yet a provider-to-terminal join.

- [ ] **Step 2: Pause for Class C Apple Events approval**

Tell Drew that macOS may show an Automation/TCC prompt and that the probe will enumerate and focus only two Gate 0 Ghostty terminals. Continue only after approval.

- [ ] **Step 3: Establish an ambiguity pair**

Open two Ghostty terminals with the same title and shared working directory. In each, privately record `tty`, shell PID, agent PID, and the AppleScript terminal/tab/window IDs obtained while that terminal is manually focused. Record only aliases `G1` and `G2` in committed evidence.

- [ ] **Step 4: Attempt the exact native join**

Check documented Ghostty environment variables by recording key names only, not values. Compare the provider PID/TTY chain with the AppleScript object properties. Do not use name or working directory to choose a terminal.

If no supported property joins TTY/PID to terminal ID, classify exact terminal activation as `UNSUPPORTED` even if `focus terminal-id` works once an ID is supplied manually.

- [ ] **Step 5: Verify focus only if the join exists**

From a third frontmost application, focus `G1`, then `G2`, using the joined native IDs. Repeat with duplicate titles and directories. Record exact-target success and TCC identity. Do not type or inject text into either terminal.

- [ ] **Step 6: Update provider activation cells and commit**

Write the first missing link clearly in `packets/ghostty.md`. Update Claude CLI, Codex CLI, and Kimi CLI activation cells consistently.

```bash
git diff --check
git add docs/evidence/gate-0/packets/ghostty.md docs/evidence/gate-0/report.md
git commit -m "Record Ghostty activation join evidence"
```

### Task 9: Authenticated Local-Transport Probe

**Files:**
- Create: `probes/transport/echo-server.mjs`
- Create: `probes/transport/echo-server.test.mjs`
- Create: `docs/evidence/gate-0/packets/transport.md`
- Modify: `docs/evidence/gate-0/report.md`

**Interfaces:**
- Consumes: `--unix /Users/drewritter/projects/stream-deck-agents/.gate0-private/transport/agent.sock` or `--tcp 127.0.0.1:47631`, `--token-file /Users/drewritter/projects/stream-deck-agents/.gate0-private/transport/token`, and authenticated `GET /health`.
- Produces: A bounded diagnostic response `{ "ok": true, "transport": "unix" | "tcp" }`; no session data and no request-body endpoint.

- [ ] **Step 1: Write real-socket tests**

Cover Unix and TCP startup, correct token, missing/wrong token, non-loopback rejection, socket parent mode `0700`, socket/token mode `0600`, second-instance address collision, clean `SIGTERM`, and a 1-second client deadline. Use temporary directories from `mkdtempSync`. Define `health()`, `unauthenticated()`, `unixClient`, `tcpClient`, and `tcpServer` as test-local helpers/fixtures in this test file.

The core assertions are:

```js
assert.deepEqual(await health(unixClient), { ok: true, transport: "unix" });
assert.equal((await unauthenticated(unixClient)).statusCode, 401);
assert.deepEqual(await health(tcpClient), { ok: true, transport: "tcp" });
assert.equal(tcpServer.address().address, "127.0.0.1");
```

- [ ] **Step 2: Run tests and observe failure**

Run: `node --test probes/transport/echo-server.test.mjs`

Expected: FAIL because the server module does not exist.

- [ ] **Step 3: Implement the minimal echo server**

Use `node:http`, `node:fs`, and `node:crypto` only. Parse the exact CLI forms above, provide a fixed `--help` usage message, reject unknown flags, cap header size through the Node server option, accept only `GET /health`, reject unequal token byte lengths before calling `timingSafeEqual`, and return fixed JSON. For Unix mode, require an existing mode-`0700` parent, remove only a stale socket owned at the exact requested path, listen, then chmod the socket `0600`. On `SIGTERM`, stop accepting, close, and unlink only that socket.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
node --test probes/transport/echo-server.test.mjs
node --test probes/**/*.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 5: Record host-runtime transport behavior**

Create the transport directory and token without printing the token:

```bash
install -d -m 700 .gate0-private/transport
(umask 077 && openssl rand -hex 32 > .gate0-private/transport/token)
chmod 600 .gate0-private/transport/token
```

Run one server in each mode from that directory, exercise both with Node clients, record latency and permission behavior, and write `packets/transport.md`. This is host evidence only; the Stream Deck runtime result comes in Task 10.

- [ ] **Step 6: Commit the transport probe**

```bash
git add probes/transport/echo-server.mjs probes/transport/echo-server.test.mjs docs/evidence/gate-0/packets/transport.md docs/evidence/gate-0/report.md
git commit -m "Add the Gate 0 local transport probe"
```

### Task 10: Stream Deck SDK and Physical-Device Packet

**Files:**
- Create: `probes/stream-deck-lifecycle/`
- Create: `docs/evidence/gate-0/packets/stream-deck.md`
- Modify: `docs/evidence/gate-0/packets/transport.md`
- Modify: `docs/evidence/gate-0/report.md`

**Interfaces:**
- Consumes: Official Stream Deck action/device lifecycle events and Task 9 `/health` endpoints.
- Produces: Ephemeral `(deviceId,row,column)->context` observations, physical render/alert evidence, and actual plugin-runtime transport results. No provider or session logic.

- [ ] **Step 1: Scaffold the diagnostic action with pinned tooling**

Read `https://docs.elgato.com/streamdeck/sdk/v1/guides/actions/`, `https://docs.elgato.com/streamdeck/sdk/guides/devices/`, and `https://docs.elgato.com/streamdeck/sdk/guides/keys/`, then run the official creation wizard:

```bash
npx --yes @elgato/cli@1.7.4 create
```

Use name `Stream Deck Agents Gate 0`, plugin UUID `com.drewritter.stream-deck-agents.gate0`, action UUID `com.drewritter.stream-deck-agents.gate0.lifecycle`, author `Drew Ritter`, Node.js plugin type, and Keypad controller only. Move the generated source under `probes/stream-deck-lifecycle/`, then run:

```bash
npm --prefix probes/stream-deck-lifecycle install --save-exact @elgato/streamdeck@2.1.0
npm --prefix probes/stream-deck-lifecycle install --save-dev --save-exact typescript@7.0.2
```

Commit the generated `package-lock.json`; do not add another framework or image library.

- [ ] **Step 2: Extract and test the pure context registry**

Create a registry whose public API is:

```ts
type Coordinate = { row: number; column: number };
type Binding = { deviceId: string; contextId: string; coordinate: Coordinate };

export class ContextRegistry {
  appear(binding: Binding): void;
  disappear(contextId: string): void;
  disconnect(deviceId: string): void;
  bindingsFor(deviceId: string): readonly Binding[];
  isReady5x3(deviceId: string): boolean;
}
```

Test replacement of an ephemeral context at the same coordinate, stale-context removal that cannot delete its replacement, device disconnect, duplicate coordinates, bounds, exactly 15 unique row-major cells, zero devices, and two-device rejection.

Run the focused test first and confirm failure, implement the minimal map-based registry, then rerun until it passes.

- [ ] **Step 3: Implement lifecycle logging and diagnostic rendering**

Handle `onWillAppear`, `onWillDisappear`, key down, device connect, and device disconnect. Log only event kind, aliased device ID, coordinate, aliased context ID, and registry count. Render a coordinate plus one of the four proposed frame colors; on key down call `showAlert()` and record the bounded result.

Use Node `http.request({ socketPath })` for the Unix probe and `http.request({ host: "127.0.0.1", port: 47631 })` for TCP. Read `/Users/drewritter/projects/stream-deck-agents/.gate0-private/transport/token` at runtime, apply a 1-second deadline, and report only success/failure and elapsed milliseconds.

- [ ] **Step 4: Validate without installing**

Run:

```bash
npm --prefix probes/stream-deck-lifecycle test
npm --prefix probes/stream-deck-lifecycle run build
npx --yes @elgato/cli@1.7.4 validate probes/stream-deck-lifecycle/*.sdPlugin
```

Expected: tests, TypeScript build, and official validation all succeed.

- [ ] **Step 5: Pause for Class C plugin/profile approval**

Explain that the next steps link a temporary plugin, create a temporary profile, exercise the physical device, restart Stream Deck, unplug/replug the device, and optionally sleep/wake. Obtain explicit approval before linking.

- [ ] **Step 6: Exercise the real 5x3 lifecycle**

After approval, set `GATE0_SDPLUGIN_PATH` to the one generated `.sdPlugin` directory and run `npx --yes @elgato/cli@1.7.4 link "$GATE0_SDPLUGIN_PATH"`. In Stream Deck, create a profile named `Stream Deck Agents Gate 0` and place the lifecycle action on all 15 keys.

Record exactly 15 contexts and row-major coordinates, then test profile switch away/back, plugin restart, Stream Deck app restart, device unplug/replug, zero-device readiness, daemon/transport offline, native alert, and stale-context rejection. If a second compatible device is physically available or the official SDK supplies a supported simulator, verify explicit two-device rejection; otherwise record that case `NOT RUN` with the hardware prerequisite. With separate approval, test sleep/wake. Do not replace Drew's normal profile.

- [ ] **Step 7: Compare Unix and loopback from the plugin runtime**

Start Task 9 in Unix mode, then TCP mode, and record success, latency, reconnect, and permission/CORS behavior from the actual plugin. Recommend one transport only from these results.

- [ ] **Step 8: Inspect physical legibility**

Render working blue `#20B8FF`, waiting amber `#FFB020`, idle slate `#94A3B8`, and error red `#FF4D67` with a dark interior, two title lines, a small provider mark, and bare numeric badge. Record a human observation for alignment, clipping, and distinction; do not turn this into a golden-image test.

- [ ] **Step 9: Unlink and commit the packet**

Switch back to Drew's prior profile, delete only the temporary profile, and run:

```bash
npx --yes @elgato/cli@1.7.4 unlink com.drewritter.stream-deck-agents.gate0
```

Confirm the temporary action no longer runs. Write `packets/stream-deck.md`, update `packets/transport.md` with plugin-runtime evidence, update the shared-runtime rows, and commit.

```bash
git add probes/stream-deck-lifecycle docs/evidence/gate-0/packets/stream-deck.md docs/evidence/gate-0/packets/transport.md docs/evidence/gate-0/report.md
git commit -m "Record Stream Deck lifecycle and transport evidence"
```

### Task 11: LaunchAgent and Real Hook-Executor Packet

**Files:**
- Create: `docs/evidence/gate-0/packets/launch-agent-hooks.md`
- Modify: `docs/evidence/gate-0/report.md`
- Temporary: `~/Library/Application Support/Stream Deck Agents Gate 0/`
- Temporary: `~/Library/LaunchAgents/com.drewritter.stream-deck-agents.gate0.plist`

**Interfaces:**
- Consumes: Task 9 echo server, the real Claude/Kimi hook-executor results from Tasks 3 and 6, and `launchd`.
- Produces: Evidence for owned runtime, absolute paths, restart, login, sleep/wake, cleanup, hook deadlines, closed stdin, and fail-open behavior.

- [ ] **Step 1: Test the installed-runtime layout without launchd**

Create the exact Gate 0 application-support directory mode `0700`, copy the current Node executable into `bin/node`, copy only `echo-server.mjs` into `lib/`, and record SHA-256 hashes. Verify `otool -L` dependencies and run the copied runtime with an empty `PATH`:

```bash
env -i HOME=/Users/drewritter PATH=/usr/bin:/bin '/Users/drewritter/Library/Application Support/Stream Deck Agents Gate 0/bin/node' '/Users/drewritter/Library/Application Support/Stream Deck Agents Gate 0/lib/echo-server.mjs' --help
```

The probe must not rely on nvm, the repo checkout, or interactive shell files.

- [ ] **Step 2: Pause for Class C LaunchAgent approval**

Show Drew the exact label, application-support directory, plist path, socket/token paths, and uninstall commands. Continue only after approval.

- [ ] **Step 3: Install and exercise the minimal LaunchAgent**

Create the mode-`0700` `run` directory and generate a random mode-`0600` token without printing it:

```bash
install -d -m 700 '/Users/drewritter/Library/Application Support/Stream Deck Agents Gate 0/run'
(umask 077 && openssl rand -hex 32 > '/Users/drewritter/Library/Application Support/Stream Deck Agents Gate 0/run/token')
chmod 600 '/Users/drewritter/Library/Application Support/Stream Deck Agents Gate 0/run/token'
```

Use `apply_patch` to create this exact plist; `/dev/null` keeps diagnostic output bounded because health is observed through the socket and `launchctl print`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.drewritter.stream-deck-agents.gate0</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/drewritter/Library/Application Support/Stream Deck Agents Gate 0/bin/node</string>
    <string>/Users/drewritter/Library/Application Support/Stream Deck Agents Gate 0/lib/echo-server.mjs</string>
    <string>--unix</string>
    <string>/Users/drewritter/Library/Application Support/Stream Deck Agents Gate 0/run/agent.sock</string>
    <string>--token-file</string>
    <string>/Users/drewritter/Library/Application Support/Stream Deck Agents Gate 0/run/token</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
```

Validate with `plutil -lint` and verify every path is absolute.

Use `launchctl bootstrap gui/$(id -u)`, `kickstart`, `print`, and `bootout`. Verify healthy startup, crash restart, missing token failure, address collision, bounded logs, and plugin behavior while absent/starting/healthy/restarting.

- [ ] **Step 4: Test login and sleep only with separate approval**

Ask Drew immediately before logout/login and sleep/wake. If approved, leave one Gate 0 session live for every surface that has not already failed the strict stop condition, then verify Background Items visibility, launch at login, socket recreation, provider source-health behavior across sleep, and reconnection. Update both the shared runtime packet and each affected provider's sleep/reconnect cell. If not approved, mark those rows `NOT RUN` with the named approval prerequisite.

- [ ] **Step 5: Audit actual hook failure evidence**

Confirm the Claude and Kimi packets each contain real-harness measurements for healthy recorder, nonzero hook command, 1-second timeout against a 5-second hook command, and provider process launched with stdin closed. If a case is missing, pause for renewed Class C approval, recreate only that provider's temporary configuration from Task 3 or 6, run the missing case, and restore it with the same compare-before-change rule. Never emit hook stdout that can enter model context.

Do not claim a harness deadline from the standalone recorder test; only the real executor result counts.

- [ ] **Step 6: Uninstall with compare-before-change checks**

Boot out the exact Gate 0 label. Compare installed hashes before removing the plist, runtime, token, socket, and logs. Remove only unchanged owned material. Preserve drift and tell Drew exactly which file remains. Confirm `launchctl print gui/$(id -u)/com.drewritter.stream-deck-agents.gate0` fails because the label is absent.

- [ ] **Step 7: Write and commit the packet**

Record separate results for owned runtime, load/restart, login, sleep, hook deadline, fail-open, cleanup, and permissions.

```bash
git diff --check
git add docs/evidence/gate-0/packets/launch-agent-hooks.md docs/evidence/gate-0/report.md
git commit -m "Record LaunchAgent and hook-executor evidence"
```

### Task 12: Causality Synthesis, Cleanup, and Product-Design Update

**Files:**
- Modify: `docs/evidence/gate-0/report.md`
- Modify: provider packets with final causality notes if required.
- Modify: `docs/design.md`

**Interfaces:**
- Consumes: Every evidence packet and private timeline.
- Produces: The reviewed Gate 0 report, an evidence-corrected candidate design, and an explicit decision request for Drew. It does not produce a product implementation plan.

- [ ] **Step 1: Complete the causality table**

For every surface exposing both inventory and events, summarize these five traces: attachment start during inventory, working-to-waiting during inventory, close followed by a late earlier event, resume with related/reused ID, and observer restart while sources are quiet.

For each surface name: membership owner, fact owner, native ordering metadata, exact-incarnation evidence, and whether local begin/commit fencing is sufficient. If the trace cannot distinguish stale results, mark the affected capability `FAIL` or `UNSUPPORTED` rather than proposing a more complex protocol.

- [ ] **Step 2: Complete and audit the matrix**

Replace every `NOT RUN` cell with a tested verdict or retain `NOT RUN` only with a named approval, hardware, or upstream prerequisite. Verify that every `PASS` cites a quiet-recovery case, restart, and negative/ambiguity case. Ensure `PARTIAL` states the exact missing clause. Set report status to `COMPLETE` and record the completion date only after this audit passes.

- [ ] **Step 3: Revise `docs/design.md` from evidence only**

Update the provider capability table, activation boundary, lease direction, Stream Deck boundary, transport choice, and packaging constraints with observed facts. Preserve Drew's locked UX and overflow decision. Do not select strict support versus capability tiers; list the evidence-backed choices for Drew.

- [ ] **Step 4: Perform privacy and consistency review**

Run:

```bash
git diff --check
rg -n '\b(T[D]O|T[B]D|F[I]XME|X[X]X)\b' docs probes || true
rg -n 'Authorizatio[n]:|Beare[r] [A-Za-z0-9._-]+|(^|[^A-Za-z])s[k]-[A-Za-z0-9_-]+' docs probes || true
git status --short
node --test probes/**/*.test.mjs
npm --prefix probes/stream-deck-lifecycle test
npm --prefix probes/stream-deck-lifecycle run build
```

Expected: no placeholders, credential values, whitespace errors, or failing tests; only intended evidence/design/probe files are changed.

- [ ] **Step 5: Clean up private and external artifacts**

Confirm the Kimi config marker is absent, temporary Claude settings are gone, Gate 0 provider processes are stopped, Kimi Web instance registrations are gone, the Stream Deck plugin/profile is removed, the LaunchAgent label is absent, and owned runtime material is removed or explicitly preserved because of drift.

After verifying the absolute repository path and extracting all redacted evidence, remove only `/Users/drewritter/projects/stream-deck-agents/.gate0-private/`. Report that the raw private evidence was deleted and is not recoverable from git.

- [ ] **Step 6: Commit the completed evidence gate**

```bash
git add docs/design.md docs/evidence/gate-0 probes
git commit -m "Complete the Stream Deck Agents Gate 0 evidence report"
```

- [ ] **Step 7: Hand the evidence decision to Drew**

Present: strict-support surfaces, reduced-tier possibilities, exact activation results, required permissions, the recommended local transport, and any `NOT RUN` prerequisites. Ask Drew to choose strict universal support, explicit capability tiers, or a narrower first version. Do not write the full product implementation plan until that decision is explicit.
