# Xeneon Edge strip app — design

Date: 2026-08-18
Status: approved (brainstorming), pending implementation plan

## Goal

A standalone macOS app that renders the stream-deck-agents session grid on a
Corsair Xeneon Edge (2560×720 touchscreen strip), replacing the Stream Deck as
the primary surface. Session-grid port only — not a general dashboard.

## Hardware / platform constraints (researched)

- The Edge is a standard 2560×720@60 external display to macOS; one USB-C
  DP-Alt-Mode cable carries video, power, and touch. No Corsair software is
  involved (iCUE and its widget platform are Windows-only).
- Touch does not work natively on macOS. A third-party driver (free
  "Touchscreen Gestures" app, or paid Touch-Base UPDD) translates the HID
  digitizer into ordinary clicks. The app therefore only needs normal click
  handlers and must be fully usable with a mouse.
- ~183 DPI: users may run a scaled 1280×360 HiDPI mode. Layout must render
  identically at both point densities (viewport-relative sizing).
- The panel is identifiable by its monitor model string ("XENEON EDGE"),
  with the 2560×720 (or scaled 1280×360) resolution as fallback.
- Prior art proving the fullscreen-borderless-window pattern on macOS:
  Kira Edge (Swift, MIT). Gotcha it documents: macOS will drop dialogs and
  notifications on the strip; a pinned frameless window is the answer.

## Decisions (from brainstorming)

- Framework: **Tauri 2** (WKWebView shell; low 24/7 idle footprint; Bun-native
  tooling; plugins for autostart, window control, shell-out, URL opening).
- Layout: **4 large tiles + fixed right rail** ("layout C").
- Rail: functional panels only (daemon health, clock, unread count, paging).
  Provider quota panels are a follow-up project, not this one; the rail is a
  plain vertical stack of sections so adding them later is additive markup.
- Rendering: **web-native tiles** (HTML/CSS), not the Stream Deck SVG
  renderer. Rationale: the SVG renderer is shaped by Stream Deck constraints
  (144×144 data-URL images, SDK-pushed animation frames) that don't exist in a
  webview; CSS gives GPU-composited animation, real text at any DPI, and
  flexbox/grid layout. Consequence: `docs/design.md` is no longer
  single-sourced — it gains a strip section, and sharing happens at the data
  layer (protocol, validation, staleness, paging), where drift would hurt.

## Architecture

The app is a third consumer of the existing snapshot contract. **The daemon
(`src/core/`) and the Stream Deck plugin (`src/plugin/`) are unchanged in
behavior**; both frontends may run simultaneously during the transition.

```
daemon (launchd, unchanged)
  └─ writes ~/Library/Application Support/com.drewritter.stream-deck-agents/snapshot-v2.json
       ├─ Stream Deck plugin (unchanged)
       └─ Xeneon app (new, Tauri 2)
            ├─ Rust: one command `read_snapshot` → {mtimeMs, contents}  (~20 lines)
            └─ Webview (TS):
                 poll every 2s → parse with shared validator → layout reducer → DOM tiles + rail
                 click → ack (shell plugin) + press routing (shell/opener plugins)
```

### Shared code (imported as-is)

- `src/protocol.ts` — `SessionSnapshotV2` types and the strict
  `parseSessionSnapshot` validator (src/protocol.ts:93,214). Runtime-agnostic.
- Staleness contract: snapshot older than 10s, unreadable, invalid, or
  `health.status != "ok"` ⇒ degraded view with last-good snapshot
  (semantics of `src/plugin/snapshot-reader.ts`; the file-I/O tail is
  reimplemented over the Rust command since node:fs doesn't exist in a
  webview). Constants shared, reader logic ported.
- `src/plugin/layout.ts` — the pure paging reducer, parameterized so page
  size / slot count aren't hardcoded to 15 keys (constants at
  layout.ts:48-50). Strip uses 4 tiles/page. Stream Deck behavior unchanged
  (existing tests must pass unmodified).

### New code

- `app/` — webview frontend (TS, bundled with the repo's existing Bun/rollup
  toolchain; no Vite): strip renderer, rail, poller, interaction handlers.
- `app/src-tauri/` — the Tauri crate: window config, autostart plugin, shell
  plugin (scoped to the installed daemon binary for `sessions ack`), opener
  plugin (paseo://, codex://, http(s)), plus the `read_snapshot` command.

## Tiles (web-native)

- CSS grid: `repeat(4, 1fr)` tiles + fixed-width rail, sized in viewport
  units (cqw/vh) so 2560×720 native and 1280×360 scaled render identically.
- Tile anatomy, ported from `render.ts` with identical colors and meaning:
  status frame = colored border + CSS keyframe animation (working wash
  `#20B8FF`, waiting breathe `#FFB020`, idle static `#4ADE80`, error fast
  pulse `#FF4D67`; neutral chrome `#94A3B8`); provider chip letter +
  `PROVIDER_COLORS`; model id text right of chip (vendor prefix stripped,
  capped); title via CSS `line-clamp: 2` with ellipsis (replaces the manual
  12-code-point wrap); descendant badge; Paseo origin pip (filled disc =
  parent, hollow ring = subagent, `#A78BFA`, bottom-right).
- Effective status per tile remains the max over its subtree
  (`error > waiting > working > idle`), computed by the daemon's projection —
  the app renders what the snapshot says; it does not re-derive status.
- CSS keyframes replace the plugin's phase-scheduler pushes
  (`src/plugin/scheduler.ts` is not reused).
- Degraded treatment mirrors the plugin: OFFLINE / "!" flags over the
  last-good snapshot when the daemon is stale or unhealthy.

## Rail

Vertical stack of `<section>` panels, top to bottom:

1. Daemon health: ok (green dot + last-heartbeat age) / OFFLINE.
2. Clock.
3. Unread count.
4. Page dots + tap-to-page zones (prev/next); current page persisted.

## Interaction

Click (mouse or driver-translated touch) on a tile = exactly what a Stream
Deck `keyDown` does today (`src/plugin/controller.ts:156-228`):

1. Fire-and-forget ack: run the installed daemon binary
   `sessions ack <provider> <sessionId>` (semantics of
   `src/plugin/session-ack.ts`) via the Tauri shell plugin, scoped to that
   one executable.
2. Press routing, same rules as the plugin: Paseo origin with known ref →
   open `paseo://h/<serverId>/agent/<agentId>` (server id re-read from
   `~/.paseo/server-id`); Claude → Ghostty focus via osascript; Codex →
   `codex://threads/<id>`; Kimi → `http://127.0.0.1:58627/sessions/<id>`;
   anything else → brief tile flash (the app's equivalent of the SDK alert).
   Routing failures stay silent, matching the plugin.
- Paging controls live in the rail. No keyboard required; all targets are
  finger-sized (touch arrives as clicks).

## Window shell

- Frameless (`decorations: false`), not always-on-top.
- On launch: enumerate monitors; pin fullscreen-borderless to the monitor
  whose model string contains "XENEON EDGE" (fallback: exact 2560×720 /
  1280×360 resolution match). If the panel is absent: open as a normal
  window on the primary display, so the app remains usable and testable
  without the hardware. Re-pin automatically on display reconnect.
- Autostart at login via the Tauri autostart plugin, on by default.
- Ad-hoc signed local build; no Gatekeeper friction for same-machine use.

## Error handling

- Snapshot stale (>10s) / unreadable / invalid / `health.status != "ok"`:
  degraded rail state (OFFLINE) + dimmed last-good tiles — same semantics as
  the plugin's snapshot reader.
- Ack or routing command failure: silent (parity with the plugin).
- Edge display disconnected: window parks on the primary display; re-pins on
  reconnect (display-change events).
- Touch driver absent: everything still clickable by mouse.

## Build, test, docs

- `bun run build:app` → frontend bundle + Tauri release build;
  `scripts/install-app.ts` installs the app bundle (alongside, not replacing,
  `scripts/install-local.ts`).
- `bun test` covers the pure parts: parameterized layout reducer (Stream
  Deck cases unchanged + strip cases), tile-model mapping, reader staleness
  logic. The DOM layer stays thin.
- Biome lint/format scope extends to `app/` (not `app/src-tauri/`, which is
  Rust). tsconfig strictness applies.
- `docs/design.md` gains a "Strip app" section (the strip's visible tile
  contract lives there). `AGENTS.md` gains an app paragraph (build commands,
  layout C, rail).
- Manual on-hardware verification checklist (touch driver, DPI mode, display
  auto-detect, autostart) — run by the user; new dated record under
  `docs/verification/` when done.

## Out of scope

- Provider quota/usage panels (rail is built so they slot in later).
- Any daemon or Stream Deck plugin behavior change.
- iCUE widget format compatibility; Windows/Linux support.
- Retiring or uninstalling the Stream Deck plugin (user's call, later).

## Risks / open questions

- Touch-on-macOS depends on a third-party driver ("Touchscreen Gestures" per
  Kira Edge's README; not independently verified). Mitigation: full mouse
  usability; verify on hardware first.
- Monitor model-string detection ("XENEON EDGE") unverified on this unit;
  resolution fallback covers it.
- Tauri shell-plugin scoping for the osascript Ghostty focus path may need
  iteration; worst case the Claude route falls back to a silent no-op.
