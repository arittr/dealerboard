# Glorp Companion on the Xeneon — Cohabitation Design

Date: 2026-08-19
Status: approved-in-discussion (pending spec review)
Related: `2026-08-19-xeneon-strip-features-design.md` (rail contents referenced below)

## Context

The Xeneon Edge panel (2560×720 physical, driven as 1280×360 logical HiDPI)
currently shows only the agent strip app (`app/`), whose Tauri window pins to
the full monitor. glorp (`~/projects/glorp`) already ships a native round
companion window (`glorp companion` → Glorp.app): 360×360 pt by default,
AppKit, normal window level, and self-feeding — it is a glorp facade that
polls usage and applies deltas on its own 30s cadence.

Goal: the glorp pet visible on the panel alongside the strip.

## Decision

**Two cooperating windows sharing the panel.** The strip window narrows to
make room; glorp's existing native window parks in the freed square. No
porting, no embedding, no new transport.

Alternatives discussed and set aside:

- **TS/canvas port of the round scene** — permanently duplicates glorp's Rust
  scene/motion logic; rejected.
- **glorp-as-library embedded as a native subview** inside the Tauri window
  (strip becomes a fourth glorp facade, in-process feeding, swipeable card
  rail) — the right long-term shape if cohabitation proves annoying;
  deliberately deferred. Nothing in this spec forecloses it.
- **Scene-JSON file transport** — solves scene *state* but not *motion*
  (glorp's motion lives in its Rust render tick); died with the port.
- **Zero-code overlap** (glorp floats over the strip's right side) — covers
  the rail (clock, unread, pager); rejected.

## Design

### Strip: reserve the right square (`app/src/window.ts`, `app/src/monitors.ts`)

- When the strip monitor is found, the window pins to the monitor's size
  **minus a right-side reserve of 360 pt converted to physical px via the
  monitor's scale factor** (720 physical px at the panel's usual 2× HiDPI),
  positioned at the monitor's origin (left edge). The freed zone is a square
  the full height of the panel, matching glorp's 360 pt default window at
  the same scale factor — so the reserve tracks the scale factor rather than
  hardcoding 720.
- The rect computation becomes a pure function next to `isStripMonitor` in
  `app/src/monitors.ts` (e.g. `stripWindowRect(monitor)`), unit-tested from
  `test/monitors.test.ts` (TDD).
- The 5s re-pin drift check compares against the **narrowed** rect — it must
  use the same computation or the repinner fights the reserve.
- No strip monitor attached: unchanged behavior (normal floating window at
  the config size).
- No CSS work. All strip layout is vw/vh-relative; tiles and rail rescale in
  the narrower window on their own. The rail stays at 24% of the narrower
  window (~442 physical px on the Xeneon) — decision A1 from the mockup
  review. If the planned quota panels feel cramped there, the single
  `grid-template-columns` value in `app/styles.css` is the adjustment knob.

### Glorp: window position persistence (separate repo, `~/projects/glorp`)

- One amendment: the companion window gets a frame autosave name
  (`setFrameAutosaveName` or the objc2 equivalent) so its frame persists
  across launches. The user drags it into the reserved square once.
- The window stays at its 360×360 pt default — exactly the reserve. No
  sizing, window-level, or transparency changes. Both windows are normal
  level and nothing else uses the panel, so z-order is stable once placed.
- Implementation verifies whether the companion window is opaque-square or
  circle-masked outside the scene; either is acceptable (square reads as a
  card, circle as a porthole).

### Lifecycle

- Feeding: Glorp.app is a facade and feeds itself (30s usage poll). The
  strip supervises nothing.
- Autostart: the strip already autostarts at login
  (tauri-plugin-autostart). Glorp.app is added to Login Items manually in
  System Settings — no launchd plist, no installer work.
- If glorp isn't running, the reserved square shows the desktop through.
  Accepted v1 behavior — a fixed reserve is predictable; dynamic resizing to
  chase glorp's process state is not worth it.

### Coordination contract

The reserve (360 pt) and glorp's default window size (360 pt) are a
convention spanning two repos; if either changes, the pair overlaps or gaps.
This repo's `AGENTS.md` strip paragraph gains a line documenting the reserve
and its reason. Glorp's own docs may note the cohabitation; that's the glorp
repo's call.

### Interaction with the 2026-08-19 feature spec

- Lane A (rich tile fields) and Lane B (file watch, gestures): unaffected.
- Lane C (quota panels): designs against the narrowed 24% rail.
- No changes to the daemon, the Stream Deck plugin, the snapshot format, or
  `docs/design.md` (the tile contract is untouched).

## Out of scope

Embedding or porting glorp into the strip, swipeable cards, always-on-top
for either window, click-through, Tauri-side glorp process management, any
glorp renderer changes.

## Verification

- `bun run check` (Biome, typecheck, build, tests).
- Unit: the rect function maps a 2560×720 strip monitor at scale factor 2 to
  its origin plus a 1840×720 size (and honors other scale factors); the
  no-strip-monitor path is untouched (window left as-is, function not
  called).
- Manual on-panel checklist: strip pins to the left with the right square
  free; tiles and rail rescaled and readable; glorp window persists its
  position across relaunch; both apps come back after logout/login.
- Deploy: `bun run install:app`. The Stream Deck plugin is untouched.
