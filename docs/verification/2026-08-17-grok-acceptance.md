# grok provider live acceptance

Verification run: 2026-08-17 (`date +%F`), probes 17:51–18:05 UTC (10:51–11:05 local).
Worktree: `/Users/drewritter/.paseo/worktrees/1au9borw/grok-provider`
Branch: `grok-provider` (HEAD `11946a6` at deploy; this record + the version bump
commit on top)

## Deploy

`bun run check` green first (496 pass / 0 fail / 2800 expect() across 21 files; the
rollup `"this" has been rewritten to "undefined"` notice is the long-standing build
warning). Then `bun scripts/install-local.ts` from the worktree — verbatim key lines:

```
✔ Validation successful
📦 Stream Deck Agents (v0.4.2.1)
✔ Successfully packaged plugin
/Users/drewritter/Library/LaunchAgents/com.drewritter.stream-deck-agents.plist: OK
install-local: waiting for the Stream Deck app to install plugin v0.4.2.1 (accept its confirmation dialog if shown)
install-local: plugin v0.4.2.1 confirmed installed
Restarting com.drewritter.stream-deck-agents
✔ Restarted com.drewritter.stream-deck-agents
install-local: installed grok hook → /Users/drewritter/.grok/hooks/stream-deck-agents.json
install-local: complete
```

No schema-preflight refusal; the plugin confirmed on the first wait (no re-run).
Post-deploy assertions, all observed:

- Manifest bumped 0.4.2.0 → 0.4.2.1; the installed copy at
  `~/Library/Application Support/com.elgato.StreamDeck/Plugins/…/manifest.json`
  reads `0.4.2.1` and the plugin process restarted.
- Registry `PRAGMA user_version` = 10 (live DB migrated by the installer);
  LaunchAgent `state = running`; snapshot heartbeat fresh (1.8s mtime age);
  `health: {"status": "ok"}` throughout the probes.
- Managed hook file `~/.grok/hooks/stream-deck-agents.json`: valid JSON, marker
  `x-stream-deck-agents: "managed hook v1"`, executable token substituted to the
  canonical bin (`…/com.drewritter.stream-deck-agents/bin/stream-deck-agents`),
  all nine hook events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  Stop, StopFailure, StopCancelled, Notification, SessionEnd) each invoking
  `event grok` with timeout 5, mode `600`.
- Pre-existing rows (16 kimi/codex/claude, several Paseo-origin) survived the
  daemon bootout/bring-up untouched.

## Probe 1 — headless lifecycle (`grok -p`, live registry/snapshot)

Headless single-turn equivalent of the TUI probe: `grok -p "<prompt using the shell
tool>"` in a scratch dir, snapshot polled at 0.5s
(`/tmp/task8-grok-probe/poll.log`, 196 samples). All observed:

- Row appears on start: provider grok, project label, slot 16, `status=working`
  with `model=grok-4.6` already present.
- `working` held for the whole turn (~26s).
- Title visible **~6.3s end-to-end** after first appearance (hook event →
  title in the snapshot; `'List current directory files via shell'`). This is
  an end-to-end bound, not a resolver measurement: the poll has no timestamp
  for when `summary.json` became readable, so resolver-within-one-pass is
  UNMEASURED — the ~6.3s bounds grok's own summary-write latency plus the
  resolver pass (daemon maintenance interval ~2s), not the resolver alone.
  Model from first appearance.
- Turn end: `status=idle`; registry `unread_since` stamped (direct unread evidence
  under Probe 2); the idle row stayed in the snapshot (unread ⟺ admitted).
- Process exit: row removed within ~0.5s (SessionEnd).

A second headless session from the scratch cwd re-confirmed appearance (~3s),
title visible ~6s end-to-end (same bound as above; `"Run sleep 150 then reply done"` /
`grok-4.6`), and
that `grok -p` fires the full hook set including SessionStart/SessionEnd. Live
`summary.json` for that session, verbatim:

```json
{
 "generated_title": "Run sleep 150 then reply done",
 "session_summary": "Run sleep 150 then reply done",
 "current_model_id": "grok-4.6"
}
```

## Probe 2 — waiting / error via fixture replay (live row)

With the second session held open by a long tool call (`sleep 150`), the four
fixtures — only `sessionId` edited to the live id `01a010dc-e184-7ee2-8cc3-5d78b7f56404` —
were piped into the installed binary's `event grok` stdin:

| Fixture | Snapshot result | Notes |
| --- | --- | --- |
| `stop-end-turn` | `idle` | registry `unreadSince: 2026-08-17T17:55:35.680Z` |
| `notification-permission-prompt` | `waiting` | |
| `stop-failure` | `error` | StopFailure re-stamped unread (`17:55:49.803Z`) |
| `session-end` | row removed | |

After the replayed SessionEnd, the real turn's own trailing Stop/SessionEnd fired
against the already-removed row: no resurrection, registry and snapshot both at zero
grok rows, health ok. Every `event grok` invocation exited 0.

Timing observation (recorded as a live note, not a defect): the unread stamp uses
daemon receive time, not the payload `timestamp` — the fixtures' historical
timestamps were accepted without rejection or misordering.

## Probe 3 — Paseo dispatch (controller-run, live)

Dispatched a grok/grok-4.6 Paseo agent (id `448bf040-295a-445a-8749-a14ee2ab29ae`,
prompt: reply with a token; it replied `PASEO-GROK-PROBE-OK`) in the grok-provider
workspace. Verified against the deployed daemon:

1. **Hooks fire under Paseo's grok launch** — registry row appeared for
   provider=grok, session `01a010e1-54ac-7042-a855-c0f9e07de426`. (The risk-table
   fail mode — hooks not firing under Paseo's launch mode — did not occur; no
   redesign pause.)
2. **Origin stamping** — row carried `origin_kind=paseo`,
   `origin_ref=448bf040-…`, `origin_subagent=1`. The overlay joined the Paseo
   record on `runtimeInfo.sessionId` (the fallback path — `persistence.sessionId`
   absent) and read the subagent bit from `labels["paseo.parent-agent-id"]`
   (= `e2882493-…`, the dispatching parent).
3. **Title + model resolved live** — `"Exact token probe reply request"` /
   `grok-4.6`.
4. **Attention mirror out** — turn end stamped `unread_since` (row idle, unread,
   `acked_at` null), and the overlay mirrored it to the Paseo record:
   `"requiresAttention": true`.
5. **Projection exclusion held** — the snapshot carried ZERO grok rows while the
   unread idle subagent sat in the registry (the "idle Paseo subagent is never
   admitted" rule), snapshot health ok.
6. **Cleanup** — `sessions clear grok 01a010e1-…` (registry back to zero grok
   rows); the probe agent was archived.

Incidental corroboration from Probe 1/2: grok processes launched under a Paseo
environment inherit `PASEO_AGENT_ID` and stamp `originKind: paseo` with the
launching agent's ref (subagent=false) — observed live on the held-open replay
session before the intentional probes ran.

## Scope notes (honest limits)

- **Viewed-in-Paseo clears unread** was not exercised: it needs a human Paseo-UI
  view. The overlay code path is provider-agnostic and covered by the v9 wave's
  tests plus prior live use.
- **Tile-press → `paseo://` deep link** is physical-device behavior, not exercised
  in this run; the routing logic (paseo-first when origin ref is known) is
  unit-test-covered.
- **waiting/error states** were verified via fixture replay against a live row
  (auto-approve/dontAsk configs prevented a live permission prompt); teardown was
  verified by the real SessionEnd removing replayed rows.
- **`/rename` storage field — OPEN.** The spec's question (does a rename
  rewrite `generated_title` in `summary.json`?) stays unanswered. It could not
  be answered headless: two scripted attempts to drive the grok TUI through a
  pty (burst keystrokes and per-character keystrokes, both piped through
  macOS `script(1)`) never reached the TUI's input — zero trace of the rename
  marker in the session transcript or `summary.json` of either attempt — and
  grok exposes no headless rename verb (`grok sessions` offers only
  list/search/delete). Both probe sessions were deleted and the registry left
  clean. Residual risk: if `/rename` writes only `session_summary` and leaves
  `generated_title` stale, a renamed session shows its stale auto title under
  the resolver's `generated_title`-first preference; the preference order gets
  revisited the day a stale-rename is observed in the wild.

## Deviations and detours found live

- **Probe-cwd slip (execution detour, cleaned up):** one `grok -p` turn ran with
  cwd = the worktree instead of the scratch dir due to a shell-quoting mistake in
  the probe launcher (`cd scratch && nohup poll &` backgrounds the whole list).
  Effect: that turn's project label read `grok-provider` (cosmetic; lifecycle
  findings unaffected), two stray files landed in the repo (`grok-out.log`,
  `stop-poll` — both removed; `git status` clean before commit), and a grok
  session dir exists under `~/.grok/sessions/%2F…grok-provider` (grok's own
  storage, harmless). No repo or provider-config pollution remains.
- **grok session directories URL-encode the workspace path and resolve `/tmp` →
  `/private/tmp`** (`%2Fprivate%2Ftmp%2Ftask8-grok-probe`); the resolver matches
  this — model and title resolved live from exactly that session's
  `summary.json`. Cosmetic, no action.
- No functional deviations from the spec were observed live: status mapping
  (working/waiting/error/idle), unread ledger behavior, title/model resolution
  timing, origin stamping, and the subagent projection exclusion all matched the
  implementation contract.

Evidence artifacts: `/tmp/task8-install.log`, `/tmp/task8-check.log`,
`/tmp/task8-grok-probe/poll.log`, `/tmp/task8-grok-probe/replay-*.json`,
`/tmp/task8-grok-probe/{grok-out,replay-grok-out}.log`; full execution detail in
`.superpowers/sdd/2026-08-16-grok-provider/task-8-report.md` (not committed).

## Interactive TUI lifecycle (addendum, 2026-08-17)

The review's remaining acceptance gate — one real interactive TUI session
lifecycle against the live deployed daemon — was run after the probes above: a
pexpect-driven grok TUI session in a scratch dir (`/private/tmp/grok-tui-probe`,
grok build 1.0.4, model grok-4.6), with the registry polled every 2s. The
verified sequence, verbatim from the probe's `transitions.log` (local times;
row format `status|unread|title|model`):

```
11:37:45 boot: '(no grok rows)'
11:37:48 turn1-running: 'working|0||grok-4.6'
11:37:50 after-esc+2s: 'idle|1|300-Word Essay About Octopuses|grok-4.6'
11:37:58 turn2+2s: 'working|1|300-Word Essay About Octopuses|grok-4.6'
11:38:13 turn3+2s: 'working|1|300-Word Essay About Octopuses|grok-4.6'
11:38:19 turn3+8s: 'idle|1|300-Word Essay About Octopuses|grok-4.6'
```

Observed end to end:

- **Boot** — zero grok rows; the TUI itself rendered `session_start [hooks: 3/3]`,
  so the hooks visibly ran in the interactive TUI (its footer also showed
  `user_prompt_submit [hooks: 2/4]`, `stop_cancelled [hooks: 1]`, and
  `stop [hooks: 2/4]` as the session progressed).
- **Turn 1** — essay prompt submitted 11:37:48: `working`, model present from
  the start, title empty. Esc mid-turn: by 11:37:50 the native `stop_cancelled`
  had settled the row `idle`, stamped it unread (`1`), and the resolver had the
  title ("300-Word Essay About Octopuses") — all within one 2s maintenance pass.
- **Turn 2** — echo prompt ("run exactly: echo SDA-TUI-PROBE"): `working` for the
  whole turn. **No permission prompt was raised** — grok auto-approved the safe
  command — so the `waiting` state remains replay-verified only, exactly as
  already documented in Scope notes above.
- **Turn 3** — short turn settled `idle` (11:38:19), still unread.
- **`/quit`** — the TUI exited cleanly ("Resume this session with:
  `grok --resume 01a01103-edc2-7750-8a7e-e89499bd4162`"); the registry polled
  immediately after showed **0 grok rows** — SessionEnd removed the row.

This closes the spec's interactive-TUI acceptance gate: a full real lifecycle
(start → working → cancel → idle+unread → working → idle → quit → removal) on
the deployed stack, complementing the headless and fixture-replay probes. The
`/rename` storage-field question (Scope notes) was not part of this probe and
remains open. Cleanup: the probe session was deleted via `grok sessions delete`,
and the pexpect venv plus the `/tmp/grok-tui-probe` scratch dir were removed
after this record was written (the table above is the retained evidence).
