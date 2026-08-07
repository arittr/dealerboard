# Smoother tile animation via 125 ms scheduler tick

Date: 2026-08-06
Status: approved by user (design phase)

## Goal

Make the working-spinner animation visibly smoother on the Stream Deck by
doubling the animation frame rate from 4 fps to 8 fps, while keeping the
visual design pixel-identical: same colors, same layout, same motion tempos.

## Current state

- `src/plugin/scheduler.ts` runs one shared 250 ms interval (`TICK_MS`) that
  increments an integer `phase` and re-renders every active key context.
  Per-key sends are capped at one start per 250 ms (4 starts/sec), below the
  Elgato SDK guidance of 10 image updates/sec per key cited in the module
  comment. Identical frames are suppressed, so non-animating tiles cost
  nothing.
- `src/plugin/render.ts` renders each tile as a pure function of the key
  model and the integer phase:
  - `working`: a bright border segment advances `WORKING_SEGMENT_STEP = 34`
    units per phase around a 544-unit perimeter — 16 phases = one 4 s lap.
    The 34-unit jump per 250 ms frame reads as visible stepping.
  - `waiting`: frame opacity follows `0.55 + 0.35 * sin(phase * pi / 8)` —
    16 phases = one 4 s breath.
  - `error`: same curve with divisor 4 — 8 phases = one 2 s pulse.
  - `idle`: static frame.

## Design

Double the sampling rate and halve the per-phase motion rates so every
wall-clock tempo is preserved:

1. `src/plugin/scheduler.ts`
   - `TICK_MS`: 250 -> 125.
   - The per-key send ceiling becomes 8 starts/sec, still below the Elgato
     10/sec guidance.
   - Update the module doc comment (250 ms -> 125 ms, 4 starts/sec -> 8).

2. `src/plugin/render.ts`
   - `WORKING_SEGMENT_STEP`: 34 -> 17. Lap time unchanged: 32 phases x
     125 ms = 4 s.
   - waiting sine divisor: 8 -> 16. Breath unchanged: 32 phases = 4 s.
   - error sine divisor: 4 -> 8. Pulse unchanged: 16 phases = 2 s.
   - Update comments that reference the 250 ms cadence and the per-cycle
     phase counts.

3. Tests
   - `test/scheduler.test.ts`: local `TICK_MS` constant 250 -> 125. Existing
     `clock.advance(250)` calls now fire two ticks; re-derive expected start
     counts and timestamps accordingly.
   - `test/controller.test.ts`: `intervalCalls` assertions that expect two
     equal 250 ms intervals (animation scheduler + snapshot poller) become
     `[125, 250]`. The snapshot poller itself stays at 250 ms.
   - `test/render.test.ts`: working dash-offset expectations scale to the
     17-unit step; breathing cycle-length expectations double (waiting 32
     phases, error 16 phases per full cycle).

## Explicitly out of scope

- The daemon's 250 ms snapshot poller (`DAEMON_POLL_INTERVAL_MS`) — unrelated
  to animation.
- The snapshot poller in the controller.
- Protocol, layout, colors, tile geometry, and `docs/design.md` (it does not
  document animation cadence).
- Time-based rendering (passing `now` instead of an integer phase):
  permanently decouples render from tick rate but rewrites the
  scheduler/render contract and every test for no visible gain. Rejected.
- 100 ms tick (10 fps): sits exactly at the Elgato guidance ceiling with no
  headroom when several keys animate at once. Rejected by user.

## Error handling

No new failure modes. The scheduler already swallows send rejections and
suppresses identical frames; doubling the tick does not change those paths.

## Verification

- `bun test` green (all three touched test files updated as above).
- `bun run typecheck` green.
- Optional on-device check via the AGENTS.md deploy loop (bump manifest
  `Version`, `bun run build:plugin`, copy bundle + manifest, `streamdeck
  restart`) — only after asking the user, since it restarts their local
  plugin process.
