# Grok provider — design

Date: 2026-08-16
Status: approved by Drew on 2026-08-16 (brainstorming dialogue, scope option A), pre-plan

Extends: [`2026-08-15-four-new-providers-design.md`](2026-08-15-four-new-providers-design.md)
(P0 provider-locked-site pattern) and sequences after
[`2026-08-16-pi-omp-ghostty-activation-design.md`](2026-08-16-pi-omp-ghostty-activation-design.md)
(schema v10). Trigger: Paseo can now dispatch `grok/grok-4.6` agents (used in
the 2026-08-16 review swarm), and their sessions are invisible on the deck.

## Summary

Add `grok` (xAI Grok Build CLI, binary `grok`, installed from x.ai/cli; local
install is 1.0.4) as an eighth session provider. Grok Build natively supports
Claude-Code-vocabulary lifecycle hooks declared as JSON files under
`~/.grok/hooks/*.json` (global, always trusted, merged additively), so ingest
is a managed hook file — no shim code, no host-extension API. Titles and
models are pulled from the per-session `summary.json` that Grok maintains
under `~/.grok/sessions/`.

Research is dated 2026-08-16 against the locally installed 1.0.4 user guide
(`~/.grok/docs/user-guide/10-hooks.md`, `17-sessions.md`) and live session
artifacts (`~/.grok/sessions/*/summary.json`, the existing third-party
`~/.grok/hooks/orca-status.json`). Every external contract cited here is
re-verified by the payload-capture probe in §Live verification before the
decoder fixtures are frozen.

## Decisions

- **Scope (option A, full fidelity):** hook ingest with nine event
  registrations, a grok decoder branch, a `summary.json` title/model
  resolver, chip/letter/model-prefix, controller alert case, and the schema
  rebuild. Rejected: minimal status-only (loses titles, models, and the
  `waiting` state — the most valuable state for headless review agents) and
  maximal (grok-native subagent rows, Ghostty binding, `idle_prompt`
  backstop — see §Out of scope).
- **Install:** installer-managed hook file (Drew's call), the same managed
  artifact pattern as the pi/omp shims: token substitution, ownership marker,
  atomic write, provider-dir-exists gating, runs last.
- **Schema:** independent of the ghostty spec; grok takes the next rebuild
  (v11, assuming the approved ghostty v10 lands first; renumber to v10 if
  grok implements first). No coupling between the two changes.
- **Grok-native subagents invisible in v1:** any hook payload carrying
  `subagentType` is dropped. Subagent sessions never fire `SessionStart`, so
  they never register; dropping their events also blocks a phantom top-level
  row if a subagent session ever emits `user_prompt_submit` (which the
  late-join path would otherwise admit). Paseo-dispatched grok subagents are
  unaffected: each is its own top-level grok session with its own
  `SessionStart`, and the Paseo overlay stamps the subagent bit as today.

## Research basis (grok 1.0.4)

Hook mechanics (user guide §10):

- Discovery: `~/.grok/hooks/*.json` (global, always trusted) plus project
  `.grok/hooks/` (trust-gated), plugin hooks, and TOML config layers. All
  sources merge additively; identical handlers dedupe. Our file coexists with
  unrelated third-party files (e.g. `orca-status.json`) without conflict.
- File shape: `{ "hooks": { "<Event>": [ { "matcher"?, "hooks": [ { "type":
  "command", "command": "...", "timeout": 5 } ] } ] } }`.
- Stdin envelope is camelCase throughout: `hookEventName` (snake_case value,
  e.g. `"session_start"`, `"stop"`), `sessionId`, `cwd`, `workspaceRoot`,
  `timestamp`, `permissionMode`, `promptId`, plus event fields (`toolName`,
  `toolInput`, `notificationType`, `reason`, `error`, `subagentType`,
  `stopHookActive`, …). The runner also injects `GROK_HOOK_EVENT` /
  `GROK_SESSION_ID` env vars (unused here; the stdin envelope suffices).
- Hook failures fail open; observe hooks default to a 5s timeout. Our
  always-exit-0 helper contract matches.
- Compat scanning is on by default: grok also loads `~/.claude/settings.json`
  hooks. Under grok those fire our claude commands with a camelCase payload,
  which fails the claude decode (no `hook_event_name`) and exits 0 — harmless
  today and after this change. We do not touch the user's compat setting.

Session storage (user guide §17, verified live):

- `~/.grok/sessions/<encoded-cwd>/<session-id>/summary.json` records
  `generated_title`, `session_summary`, `current_model_id`, `info.id`,
  `info.cwd`, timestamps. `GROK_HOME` overrides the base directory. The
  `<encoded-cwd>` group name has a 255-byte slug+hash fallback, which never
  concerns us: we glob by session id, never reconstruct the encoding.

## Ingest: managed hook file

Target: `~/.grok/hooks/stream-deck-agents.json`. Nine event registrations,
each a single observe-only command handler:

```json
{
  "x-stream-deck-agents": "managed hook v1",
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "<exe> event grok", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "<exe> event grok", "timeout": 5 }] }],
    "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "<exe> event grok", "timeout": 5 }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "<exe> event grok", "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "<exe> event grok", "timeout": 5 }] }],
    "StopFailure":      [{ "hooks": [{ "type": "command", "command": "<exe> event grok", "timeout": 5 }] }],
    "StopCancelled":    [{ "hooks": [{ "type": "command", "command": "<exe> event grok", "timeout": 5 }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "<exe> event grok", "timeout": 5 }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "<exe> event grok", "timeout": 5 }] }]
  }
}
```

(`<exe>` is the `__STREAM_DECK_AGENTS_EXECUTABLE__` token in the repo
template; no matchers — we want every invocation, and a matcher on
`Stop`/`UserPromptSubmit` is ignored by grok anyway.)

Not registered, deliberately:

- `PostToolUseFailure`: a failed tool call does not end a grok turn; the
  zcode `is_interrupt` special case has no grok analog. Zero events.
- `PermissionDenied`: fires on automatic denials, not user-facing prompts.
  The `permission_prompt` Notification covers the waiting state.
- `SubagentStart`/`SubagentStop`, `PreCompact`/`PostCompact`: no v1 consumer.

Registering `Stop` makes every completed turn report (grok deliberately
leaves turns unreported when no stop hook ran to completion), which is what
we want; our hook never gates (exit 0, no output).

## Decoder (`src/core/providers.ts`)

A grok branch normalizes the camelCase envelope to the existing canonical
hook names before the shared mapping runs, keyed on `hookEventName`:

| Grok value | Canonical | Extra rules |
|---|---|---|
| `session_start` | `SessionStart` | `sessionId`→`session_id`; `project` = basename of `cwd`; `model` passed through if the probe shows it in the payload |
| `user_prompt_submit` | `UserPromptSubmit` | late-join (`SessionObserved` + `Activity`) comes free |
| `pre_tool_use`, `post_tool_use` | `PreToolUse`/`PostToolUse` | `Activity`; no `AskUserQuestion` analog |
| `stop` | `Stop` | **only when `reason` is absent or `"end_turn"`** — the session-teardown observe fire (`channel_closed`/`shutdown`) is dropped; `SessionEnd` owns teardown |
| `stop_failure` | `StopFailure` | error status + unread, as today |
| `stop_cancelled` | `Stop` | grok's interrupt/declined-permission/max-turns turn end; same settle as Kimi's `Interrupt` |
| `notification` | `Notification` | `Attention` only when `notificationType === "permission_prompt"` (mirrors the Claude branch) |
| `session_end` | `SessionEnd` | row deleted regardless of `reason` |

- Any payload with `subagentType` present is dropped before mapping (see
  §Decisions).
- `idle_prompt` notifications are not mapped: the ping refires about a minute
  after *every* settle (completed, errored, or interrupted), and mapping it
  to `Stop` would re-stamp `unread_since` on already-read tiles. The missed
  settles it would have caught (bash-mode-only turns, superseded turns) age
  out via the next event, `SessionEnd`, or the 24h prune.
- `stopHookActive: true` continuation fires pass through as `Stop`. A
  continuation fire settles the tile idle while a third-party blocking gate
  keeps the turn going — a transient false idle that self-corrects on the
  next event. Dropping them is worse: after any block, the *final* fire also
  carries `stopHookActive: true`, so filtered configs would never settle.
  Documented, not handled.
- All consumed fields already fit the `SAFE_FIELDS` privacy shape (canonical
  names after normalization; `cwd`→basename only). No new classified fields.

## Titles and models (`src/core/titles.ts`)

Grok joins the `createSessionFactsResolver` switch, wired in `cli.ts` with a
`grokRoot` dependency honoring `GROK_HOME` (mirrors `ZCODE_HOME`):

1. Glob `<grokRoot>/sessions/*/<sessionId>/summary.json` for each grok
   target from `listTitleTargets`.
2. Stat-cache on `(mtime, size)` like the omp/claude readers; re-read only on
   change.
3. Title = `generated_title`, falling back to `session_summary`; model =
   `current_model_id`. Malformed/missing file → no opinion. Write-back keeps
   the existing rules: additive, null never clears, `updated_at` untouched.
4. The probe confirms which field `/rename` writes; if it writes neither
   (e.g. a separate override file), that lands as a finding in the
   verification record and the resolver follows the probe, not this line.

## Registry schema v11

SQLite cannot alter a CHECK, so widening
`provider IN ('claude', 'codex', 'kimi', 'pi', 'omp', 'zcode', 'deepseek')`
to include `'grok'` is a table rebuild. It clones the ghostty spec's v10
pattern verbatim, assuming v10 has landed (if grok implements first,
renumber: this rebuild is v10 and ghostty becomes v11):

- `LATEST_SCHEMA_VERSION` becomes 11. The `migrateToV8` gate
  (`if (version < 8)`) introduced by v10 is untouched.
- `migrateToV11` is not a `MIGRATIONS` entry; it runs strictly last in
  `initializeDatabase`, special-cased like v5/v10: `PRAGMA foreign_keys =
  OFF`, one transaction, `foreign_key_check` before commit, enforcement
  restored after. Archive table `active_sessions_v10_archived`.
- The v11 `CREATE TABLE` is a verbatim clone of the v10 DDL — `WITHOUT
  ROWID`, composite primary key, self-FK with `ON DELETE CASCADE`,
  slot/parent CHECKs, the widened ghostty CHECK — changing *only* the
  provider list. Rows copy via an explicit full column list; the partial
  unique slot index is recreated after the archive drop.
- Older binaries refuse a v11 database via `UnsupportedSchemaVersion`; the
  installer's newer-database refusal adapts without logic changes.
- The `test/schema.test.ts` CHECK↔`PROVIDER_KEYS` lockstep test updates
  itself.

## Plugin surface

- `src/protocol.ts`: `"grok"` appended to `PROVIDER_KEYS` — snapshot parser,
  projection guard, CLI arg grammar, and the Paseo overlay
  (`isKnownProviderState`) all derive from it.
- `src/plugin/render.ts`: `PROVIDER_LETTERS.grok = "G"`;
  `PROVIDER_COLORS.grok = "#F472B6"` (pink — the most-distinct remaining hue
  against the seven taken chips, the four status frames, and the violet Paseo
  pip; brand fidelity is explicitly not the goal). `MODEL_LABEL_PREFIXES`
  gains `"grok-"`, so `grok-4.6` renders as `4.6` under the existing caps.
- `src/plugin/controller.ts`: `grok` joins the `showActivationAlert` group
  with pi/omp/zcode/deepseek; the exhaustiveness `never` proof enforces the
  case. No activation route in v1. A grok tile with Paseo origin still routes
  paseo-first through the existing deep-link branch.
- Ghostty binding: grok is not bindable; the v10 whitelist
  (`GHOSTTY_BINDABLE_PROVIDERS`) is unchanged.

## Install (`scripts/install-local.ts`)

- New repo template `extensions/grok/stream-deck-agents.hook.json` (the
  §Ingest JSON with `__STREAM_DECK_AGENTS_EXECUTABLE__` in place of `<exe>`).
- The installer substitutes the token and writes
  `~/.grok/hooks/stream-deck-agents.json` atomically (temp + rename, mode
  0600), only when `~/.grok` exists. Runs last, alongside the shim step,
  after the plugin-then-core lockstep ordering the amended ghostty spec
  establishes.
- Ownership: refuse to overwrite an existing target that lacks the
  `"x-stream-deck-agents": "managed hook v1"` marker. The payload probe
  confirms grok tolerates the unknown top-level key; if it does not, the
  ownership check keys off the `stream-deck-agents` command string instead.
  Reinstalls and upgrades rewrite the managed file in place.
- The deploy-lockstep rule applies as always: manifest `Version` bump and
  full `bun scripts/install-local.ts`, since the snapshot parser on old
  plugins rejects the new provider key.

## Testing

- Existing `test.each` lists gain `grok`: snapshot parser accept
  (`test/protocol.test.ts`), CLI event-arg accept + USAGE text
  (`test/cli.test.ts`), projection admit (`test/projection.test.ts`), chip
  letter/color pins (`test/render.test.ts`), controller press → alert
  (`test/controller.test.ts`).
- `test/schema.test.ts`: v10→v11 rebuild with a full-field fixture (every
  nullable/defaulted column non-default, plus a grok row post-migration);
  fault injection (failed rebuild keeps `user_version = 10` and the original
  table; retry converges); fresh-init composition v1→v11; idempotent re-init;
  future-version refusal.
- `test/providers.test.ts`: grok fixtures built from the captured live
  payloads — each registered event; `stop` reason filter (`end_turn` passes,
  absent passes, `channel_closed`/`shutdown` dropped); notification filter
  (`permission_prompt` → `Attention`; `idle_prompt`/`task_complete` → none);
  `subagentType` drop across event types; unknown fields ignored; camelCase
  envelope never misread as snake_case.
- `test/titles.test.ts`: tmpdir `GROK_HOME` fixture tree — found/missing
  `summary.json`, `(mtime,size)` cache skip, `generated_title` →
  `session_summary` fallback, malformed JSON tolerated, null never clears,
  `GROK_HOME` override honored.
- Installer: managed-hook write, marker-refusal, and idempotent-rewrite
  tests, following the shim install step's harness if one exists; otherwise a
  focused tmpdir test for the hook-file step.

## Live verification

Recorded in a dated `docs/verification/` file, before deploy and after:

1. **Payload-capture probe (first implementation step, gates the decoder
   fixtures):** install a temporary capture hook (`tee` stdin to a file per
   event) in `~/.grok/hooks/`, run one TUI session (prompt, a tool call, an
   Esc interrupt, `/quit`) and one headless `grok -p` turn. Pin per event:
   exact key casing, `session_start` fields (`model`? `source`?), `stop`
   `reason` values, `notificationType` values, `subagentType` presence, and
   grok's tolerance of the `x-stream-deck-agents` marker key.
2. **TUI lifecycle:** tile appears on session start (correct chip, project
   label), working on prompt, idle + unread on stop, waiting on a permission
   prompt, removed on `/quit`. StopFailure is replayed via
   `stream-deck-agents event grok < fixture` if no natural API error occurs.
3. **Paseo dispatch:** a Paseo-run grok agent fires hooks under ACP, the
   overlay stamps the origin pip (and subagent ring when applicable),
   attention mirrors both ways under the `acked_at` watermark, and a tile
   press opens the `paseo://` deep link.
4. **Titles/models:** `generated_title` and `current_model_id` appear within
   one maintenance pass; `/rename` behavior probed (which field it writes)
   and reflected or documented.

## Docs

- `docs/design.md`: chip letter/color sentence and the model-label source
  sentence (grok has a model source, via `summary.json`).
- `docs/hook-configuration.md`: grok section — what the installer manages,
  the event table, the camelCase payload note, the compat-scanning note
  (grok also runs `~/.claude/settings.json` hooks by default; ours fail the
  claude decode and exit 0, harmless), the manual repair/restore ritual, and
  `GROK_HOME`.
- `AGENTS.md`: chip letters/colors bullet, status-model bullet (grok has
  `error` via `StopFailure` and `waiting` via `permission_prompt`; no
  `background_outstanding` tracking, no subagent rows, no `SessionTitleChanged`
  push — titles/models are pulled), lifecycle bullet (real `SessionEnd`, so
  the standard 24h prune; no special lease), the managed-artifacts bullet
  (hook file alongside the shims), and the schema-version sentence.

## Out of scope (v1)

- Grok-native subagent child rows (`subagentType` payloads are dropped;
  revisit if probes show a stable per-instance identity).
- Ghostty terminal binding for grok (whitelist unchanged by design).
- `idle_prompt` backstop mapping, `PermissionDenied`, `PostToolUseFailure`
  wiring.
- Disabling grok's claude/cursor compat scanning.
- deepseek ingest (still the deferred P3 of the four-providers spec).

## Risks

- **Doc-vs-reality payload drift.** The camelCase envelope and event values
  come from the bundled 1.0.4 user guide; the capture probe runs before
  fixtures are frozen, and the decoder treats unrecognized shapes as zero
  events (fail-open), so drift degrades to invisibility, never corruption.
- **Hooks under ACP unproven.** If Paseo's headless dispatch does not fire
  hooks, Paseo grok sessions stay invisible while TUI works — the probe in
  §Live verification (3) is the gate; a failure there pauses launch for
  redesign (poll-based ingest) rather than shipping a half-supported
  provider.
- **Third-party Stop gates.** A blocking gate from another tool causes
  transient false idle via continuation fires (documented in §Decoder).
- **`/rename` field unknown.** Resolver prefers `generated_title`; the probe
  settles where manual renames live.
