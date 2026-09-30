# Pi sessions in Paseo: match oh-my-pi's visibility rule

## Problem

A pi session driven by Paseo never produces a board card, while an oh-my-pi
(omp) session in the same Paseo workspace does. Verified live on 2026-09-29:

- The Paseo agent process tree is `Paseo Daemon` → `pi` with **no controlling
  TTY** (`ps` shows `TTY ??`), so pi runs headless.
- Pi's `ExtensionContext` reports `mode: "rpc"` and `hasUI: true` in that mode
  (`docs/rpc-extension-ui.md`: *"ctx.mode is `"rpc"` and ctx.hasUI is `true` in
  RPC mode"*; `hasUI` is documented as *"Whether dialog-capable UI is available
  (true in TUI and RPC modes)"*).
- `extensions/pi/dealerboard.ts` gates every handler on
  `ctx.mode !== "tui" || sessionId === undefined || sessionFile === undefined`
  and returns early — the shim's deliberate ghost filter. Paseo's `rpc` mode
  fails the first clause, so **every Paseo pi session is discarded**.
- `extensions/omp/dealerboard.ts` gates the same concept on
  `ctx.hasUI !== true` instead, so omp's RPC sessions are reported. That is the
  entire behavioral difference between the two shims.
- Consequence in the registry: no `provider: "pi"` row has ever existed, and
  `logs/cli.log` contains `claude`, `codex`, `kimi`, `omp`, and `qwen` events
  but zero `provider: "pi"` events.
- The daemon is not at fault: a synthetic `dealerboard event pi` payload
  registered a row immediately (and was cleared). Decode, validation, and
  persistence already accept pi. Only the shim's gate suppresses emission.

The gate exists for a real reason: pi extensions load in *every* pi process,
including print (`pi -p`), JSON, and headless subagent subprocesses. Registering
those would fill the board with phantom cards. The defect is the *predicate*,
not the policy — `mode === "tui"` is narrower than "this process serves a user",
and `hasUI` is the field pi provides for exactly that question.

## Goal

A pi session under Paseo registers a board card and tracks its lifecycle
exactly as an omp session under Paseo does, while print, JSON, and headless
subprocesses stay invisible.

Concretely: report any pi session whose context has `hasUI === true` and that
exposes both a session id and a session file. That is the same rule omp already
applies, expressed with the same field.

## Non-goals

- No change to the daemon, registry, projection, snapshot protocol, or CLI.
  They already accept pi; the synthetic-event experiment proved it.
- No change to the omp shim or its behavior.
- No Paseo-specific or environment-based detection (`PASEO_AGENT_ID` and
  friends). See Alternatives.
- No change to which events the shim emits, their payload shapes, the spawn
  queue, or the terminal-outcome latch.
- No attempt to make pi subagents *more* or *less* visible than omp's
  equivalent. Parity with omp is the bar.
- No change to the interactive TUI behavior; `hasUI` is true there too.

## Requirements

1. In `extensions/pi/dealerboard.ts`, `liveSession` must accept a context when
   `ctx.hasUI === true` and both `sessionId` and `sessionFile` are defined, and
   reject it otherwise. It must no longer require `ctx.mode === "tui"`.
2. The structural `PiContext` type must declare `hasUI: boolean`, and `mode`
   must be removed from it: the predicate was its only reader.
3. The module header comment must describe the new rule in the same terms omp
   uses ("sessions with a UI and a session file"), not "interactive TUI
   sessions".
4. No other logic in the shim changes: the event registrations, the
   `errorLatched` terminal-outcome latch, `readSource(event) !== "interactive"`
   prompt gating, the FIFO spawn queue, and the fail-soft wrappers all stay as
   they are.
5. `docs/hook-configuration.md` must stop claiming that RPC processes never
   produce tiles. The pi "Behavior to expect" bullet currently reads *"only
   interactive TUI sessions are reported — print (`pi -p`), JSON, and RPC
   processes never produce tiles"*; it must reflect the `hasUI` rule.
6. The shim's tests must be restated as a `hasUI` matrix rather than a `mode`
   matrix, and must include an explicit regression case for the reported
   defect: **an RPC-mode context with `hasUI: true` and a session file emits
   `SessionStart` and prompt/tool activity**.
7. Deployment must be documented: the change reaches an installed machine only
   by re-running `bun scripts/install-local.ts` (which re-copies the shim under
   its managed-marker rule) and restarting pi. A stale installed shim keeps the
   old behavior.

## Files and boundaries

- `extensions/pi/dealerboard.ts` — the predicate, the `PiContext` type, and
  the header comment.
- `test/pi-shim.test.ts` — the ghost-filter suite's contexts and a new RPC
  regression test.
- `docs/hook-configuration.md` — the pi "Behavior to expect" bullet.
- `CHANGELOG.md` — an `### Fixed` entry under `[Unreleased]`.

Deliberately unchanged: `extensions/omp/dealerboard.ts`, `src/core/**`,
`src/protocol.ts`, `app/**`, and the daemon.

## Testing

Unit (bun:test, `test/pi-shim.test.ts`):

- **Visible:** a context with `hasUI: true`, a session id, and a session file
  emits for the ordinary event set — covering both a TUI context and an RPC
  context (the new regression case).
- **Ghost:** a context with `hasUI: false` emits nothing for any event, whether
  or not it has a session file; a context with `hasUI: true` but no session
  file emits nothing.
- **Latch hygiene unchanged:** ghost events still never latch the visible
  session, and a ghost `agent_end` never contaminates the next turn's outcome.

Manual acceptance (documented, not automated — it needs a live Paseo):

1. `bun scripts/install-local.ts`, then restart pi (or the Paseo workspace).
2. Run a Paseo pi session and submit a prompt: a pi card must appear, go
   `working`, and settle to `idle` with its result.
3. Run `pi -p "hello"` from a terminal: no card appears.
4. Confirm `sessions list` shows the pi row from step 2 and nothing from step 3.
5. Run `bun run check`.

## Acceptance criteria

1. A Paseo-driven pi session registers a card, shows `working` during a turn,
   and settles to `idle`/`error` — matching omp's behavior in the same
   environment.
2. `pi -p` (print) and JSON-mode pi processes produce no rows or events.
3. Interactive TUI pi behavior is unchanged.
4. omp behavior is unchanged.
5. No daemon, registry, protocol, or CLI change is introduced.
6. `docs/hook-configuration.md` and the shim header describe the `hasUI` rule,
   and the shim tests encode it.
7. `bun run check` passes, and the manual acceptance run above is recorded
   before completion is claimed.

## Alternatives considered

- **Keep `mode === "tui"`.** Rejected: it is the defect — Paseo's RPC sessions
  stay invisible, which is the reported problem.
- **Gate on `PASEO_AGENT_ID` / `PASEO_AGENT_CWD`.** The environment does expose
  these, so it would work, but it couples the shim to one host's variable
  names, breaks for any other RPC client, and is likely inherited by pi
  subagents (making the ghost filter unreliable). Rejected in favour of the
  provider-native field that omp already uses.
- **Gate on `mode` in `{ "tui", "rpc" }`.** Functionally close, but it
  re-implements `hasUI`'s meaning by hand and will drift if pi adds modes.
  `hasUI` is the documented predicate for "this process serves a user".
- **Drop the gate entirely.** Would surface print, JSON, and headless subagent
  processes as phantom cards — the exact outcome the filter exists to prevent.

## Open questions

- If pi subagents ever run with `hasUI: true`, they would register — exactly as
  an omp subagent would under the same rule. Parity with omp is the accepted
  bar for this change; separating UI-bearing subagents from main sessions is a
  follow-up if it turns out to matter in practice.

## Golden-question checklist

- [x] Data migration / existing-data impact: none; the shim emits the same
      events with the same payloads, only for more sessions.
- [x] Auth / permissions: none; the extension already runs with the user's
      permissions and the helper is the existing local binary.
- [x] Failure / retry behavior: unchanged; every handler stays fail-soft and
      the spawn queue is untouched.
- [x] Rollback path: revert the shim commit and re-run
      `bun scripts/install-local.ts`; no stored state changes.
- [x] Observability / logging: no new logs; success is visible as
      `provider: "pi"` entries in `logs/cli.log` and a `sessions list` row.
- [x] Backward compatibility: interactive TUI sessions keep working (`hasUI`
      is true there); only non-TUI UI-capable sessions gain visibility.
- [x] Physical-display legibility: N/A; the acceptance run checks card
      presence and state transitions, not layout.
