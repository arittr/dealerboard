# Grid defrag: pack tiles by slot rank, count-based overflow latch

Date: 2026-08-06
Status: approved by user (design phase)

## Goal

The visible grid never shows blank holes between session tiles. Live sessions
pack densely onto keys in slot order; when a session ends, later tiles shift
one key left; when a new session reuses a freed slot, it inserts at that rank
and later tiles shift one key right. Overflow paging triggers on live session
count instead of highest occupied slot. This reverses the earlier
"no live-session movement" decision recorded in `docs/design.md` — the user
now wants reflow because the scattered grid fills up too fast in practice.

## Current state

- The daemon registry (`src/core/registry.ts`) assigns each top-level session
  a stable `logical_slot` — the lowest free positive integer — and never
  compacts; ending a session frees its slot for the next arrival.
- The plugin layout reducer (`src/plugin/layout.ts`) treats the slot as a
  *position*: slot N maps to physical key N-1, gaps render blank ("sessions
  never compact"), and overflow paging is slot-anchored (page 0 = slots
  1..14, further 14-slot blocks from slot 15).
- The overflow latch engages when the highest live slot exceeds 15, holds
  while any slot >= 15 is live, and is persisted in `LayoutSettingsV1`
  (`overflowLatched`, `currentPage`) via Stream Deck global settings.
- `docs/design.md` ("Stable logical placement", "Overflow") documents the
  no-compaction contract, including "Moving slot 15 into overflow is the only
  permitted live-session movement."

## Design

Treat `logicalSlot` as an *ordering key only* in the plugin. All changes are
in the plugin; the daemon, registry, projection, and protocol are untouched,
and registry slot stability is preserved.

1. `src/plugin/layout.ts` — rewrite the reducer around rank packing:
   - Sort live sessions by `logicalSlot` (as today); a session's *rank* is
     its index in that order.
   - Without overflow: ranks 0..14 map to keys 0..14; keys past the last
     rank render blank. Fifteen live sessions still fit without paging.
   - The latch becomes count-based with the same hysteresis shape as today:
     engages when the live count exceeds 15, holds while the count is at
     least 15, releases at 14 or fewer.
   - With overflow latched: pages are uniform dense 14-rank slices (page p
     covers ranks `p*14 .. p*14+13`), keys 0..13 show the current page, key
     14 is NEXT. The slot-anchored `pageStartSlot`/`pageForSlot` math is
     deleted.
   - Non-empty pages become the dense range `0 .. ceil(count/14) - 1`; every
     page in range is non-empty by construction. Clamping the current page
     reduces to `min(currentPage, pageCount - 1)` (the nearest-earlier rule
     collapses to this under dense pages).
   - `LayoutSettingsV1`, `KeyModel`, NEXT wrap-around, empty-snapshot reset,
     and the `dirty`-only-persist contract are unchanged. The module header
     comment is rewritten to describe rank packing.

2. Tests
   - `test/layout.test.ts`: rewrite around packing semantics. The
     "gaps stay blank" expectations invert (holes are filled by rank);
     slot-anchored paging cases become dense-slice cases; latch threshold
     cases move from slot numbers to counts (engage at 16 live, hold at 15,
     release at 14).
   - `test/controller.test.ts`: audit fixtures for gap assumptions
     (e.g. snapshots with holes mapping to blank keys) and adjust to packed
     expectations.

3. Docs — `docs/design.md`:
   - "Stable logical placement": registry slot allocation/stability stays as
     written, but the "not compacted into gaps" bullet and the
     slot-1..15-to-key-1..15 mapping move to a description of the packed
     visible grid (rank order, insert/removal shifts).
   - "Overflow": rewrite for count-based paging; remove the
     "only permitted live-session movement" sentence, which this change
     supersedes.

Movement semantics accepted by the user: tiles may shift one key left when an
earlier session ends, and one key right when a new session inserts at a freed
rank. Tiles never move for any other reason (status, title, and descendant
changes never re-rank).

## Explicitly out of scope

- Daemon, registry, projection, and protocol changes — slot allocation stays
  exactly as-is.
- Append-at-end ordering (pack by `openedAt` so inserts never shift existing
  tiles): calmer visually but needs `openedAt` plumbed through the protocol.
  Rejected by the user in favor of slot-rank packing; a possible follow-up if
  insert shifts prove annoying.
- Compacting `logical_slot` in the daemon on session end: churns the DB
  inside the hook transaction, fights the partial unique index, and buys
  nothing the plugin can't do. Rejected.
- Settings schema migration: `LayoutSettingsV1` is unchanged; existing stored
  settings keep working.
- NEXT key visuals, colors, tile geometry, and the 250 ms poll cadence.

## Error handling

No new failure modes. The reducer stays pure and total: stored settings are
validated and defaulted as today, the current page is clamped into the dense
page range, and an empty snapshot resets settings to defaults. Persist
failures remain best-effort in the controller.

## Verification

- `bun test` green (layout tests rewritten, controller fixtures audited).
- `bun run typecheck` green.
- `bun run build:plugin` to confirm the bundle builds.
- On-device check via the AGENTS.md deploy loop (bump manifest `Version`,
  `bun run build:plugin`, copy bundle + manifest, `streamdeck restart`) —
  only after asking the user, since it restarts their local plugin process:
  end a middle session and watch later tiles shift left; start a new session
  and watch it fill the lowest freed rank; cross 16 live sessions to confirm
  the count-based latch and NEXT paging.
