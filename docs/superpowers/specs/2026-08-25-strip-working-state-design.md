# Strip working-state redesign: liveness over ambience

Status: approved design, not yet implemented
Date: 2026-08-25
Surface: the Agent Strip board (`app/`), plus one additive snapshot field

## Problem

A `working` card renders an 8px `#20B8FF` left edge, a blue status dot, and a
full-card blue wash breathing `0.04 → 0.14` alpha over four seconds, staggered
per session from the wall clock (`app/styles.css`, `washAnimationDelay` in
`app/src/cards.ts`). The treatment fails twice.

It spends the loudest channel on the modal state. Working is what most cards
are most of the time, so a whole-card animated tint tells the eye nothing while
costing it everything.

Worse, it is information-free. The wash is a decoration on a boolean the edge,
the word, and the timer already carry. A session that fired its last hook two
seconds ago and a session that has fired nothing for ninety minutes breathe
identically. On 2026-08-25 the board showed a pi session reading `working 1h`
whose last hook had landed 92 minutes earlier; nothing on the card said so.

## Approach

Replace ambience with liveness. Three layers, in descending order of value:

**Decay** carries the information. The edge and dot colour become a continuous
function of time since the session's last hook event. Recent work reads bright
blue; a long silence desaturates toward slate and finally hollows the card out.
This layer alone fixes the ninety-minute bug, and it animates nothing.

**Pulse** carries the peripheral cue. When a card's last-event stamp advances, a
bloom crosses the card once and fades in 520ms. Motion now means work actually
happened. Pulses coalesce at one per card per two seconds.

**Breath** carries proof of life. Every live dot breathes on one shared
four-second cycle. Synchronised motion reads as a single system heartbeat rather
than twelve competing signals, and it makes the one dot that does not breathe —
the stalled card — the salient thing on the board.

Colour encodes recency; breath modulates only alpha and scale, within a narrow
band. Keeping those channels separate matters: if breath also drove colour, a
dim dot would be ambiguous between "cooling off" and "mid-exhale."

## Data

Add one field to `ProjectedSession`:

```ts
/** ISO-8601 UTC of the row's last hook event; null when the registry has no stamp. */
lastEventAt: string | null;
```

It publishes `active_sessions.updated_at`, which already records exactly this.
Maintenance write-backs — titles, models, activity lines — deliberately never
touch that column (`src/core/registry.ts`), so it moves only on real session
events, for every provider that fires hooks.

No migration. The column exists; the projection has never selected it. Add
`updated_at` to `PROJECTION_COLUMNS`, the row validator, and the mapping in
`src/core/projection.ts`, then the field and a tolerant parse in
`src/protocol.ts` following the pattern `model` and `activityLine` already use:

```ts
const lastEventAt = "lastEventAt" in value ? value["lastEventAt"] : null;
```

The parser validates known keys and ignores unknown ones, so the field is
additive in both directions: a new daemon feeding an old consumer is safe, and
an old snapshot parsed by new code yields `null`.

Latency is better than the 5s heartbeat suggests. The daemon polls
`PRAGMA data_version` every 250ms and republishes whenever the registry
changed; the five-second rewrite exists only to keep the file's mtime fresh as
a liveness signal (`src/core/daemon.ts`). The Rust host file-watches the
snapshot and pushes `snapshot-changed` to the webview. A tool call reaches the
board in roughly 250ms.

## Visual specification

Let `age = now − lastEventAt`.

| age | edge and dot |
|---|---|
| 0–3s | `#20B8FF`, alpha 1.00 |
| 3–30s | `#20B8FF`, alpha 1.00 → 0.55 |
| 30s–10m | alpha 0.55 → 0.28, hue lerps `#20B8FF` → `#55647A` |
| ≥ 10m | quiet treatment |

Quiet treatment: the edge becomes a 2px inset `#55647A` rule instead of a solid
bar, the dot becomes a hollow `#55647A` ring, the card surface sinks to
`#171E28`, the title dims to `#8B9BB0`, and the meta row gains
`quiet <elapsed>` in `#5C6B80`, using the same compact `elapsedLabel` form as
the status timer (`quiet 12m`, `quiet 2h`).

Pulse: a `linear-gradient(90deg, rgb(32 184 255 / .34), transparent 46%)`
overlay under the text, animating opacity `0 → 1 → 0` over 520ms, `ease-out`,
peaking at 10%. It fires when `lastEventAt` advances and at most once per card
per two seconds.

Breath: the dot's decayed alpha is *multiplied* by a factor sweeping
`0.72 → 1.00`, and its transform scales `0.92 → 1.08`, on a shared four-second
cosine whose phase derives from the wall clock so every card matches. The
multiplier is essential — breath must not replace the decayed alpha, or it
overwrites the recency channel that the previous paragraph establishes. Quiet
cards do not breathe.

Removed: `.card.status-working::after`, `@keyframes wash`, `WASH_CYCLE_MS`, and
`washAnimationDelay`. The Stream Deck plugin's own wash in
`src/plugin/render.ts` is untouched.

Subagent cards keep their existing half-opacity edge treatment: the 0.5 factor
multiplies the decayed alpha, so a subagent's edge tracks recency at half
strength. Subagent dots breathe on the same shared cycle.

## Why ten minutes

`PreToolUse` and `PostToolUse` both fire the daemon event, so a tool call ticks
at its start and again at its end. A ten-minute `Bash` therefore ticks once,
goes silent for ten minutes, and ticks again. Silence does not prove a stall.

Measured against 3360 in-turn gaps from 62 real sessions on 2026-08-25, with
gaps over thirty minutes excluded as turn boundaries:

| percentile | gap | threshold | gaps exceeding it |
|---|---|---|---|
| p50 | 0.7s | 60s | 3.33% |
| p90 | 22.2s | 180s | 0.71% |
| p95 | 40.7s | 300s | 0.45% |
| p99 | 139s | 600s | 0.15% |
| p99.9 | 842s | 900s | 0.09% |

A three-minute threshold would have marked legitimate work quiet twenty-four
times in one day. Ten minutes costs five, and a tool that has run ten minutes
without an event is worth noticing even when it is working correctly.

The wording follows from this. The card says `quiet 12m`, which is a fact.
It never says stalled, hung, or stuck, which would be a claim the data cannot
support.

## Non-goals

Per-session intensity — token burn or cost per card — is deliberately out of
scope. It is wanted, and `agentsview export sessions` supplies real per-session
tokens and cost, but the session-id join fails across providers (a kimi row is
`session_dbb46c71…` in the registry and `kimi:wd_supe…` in agentsview), new
sessions lag by minutes, and omp, zcode, deepseek, and grok are absent
entirely. That investigation is its own piece of work.

Distinguishing "inside a long tool call" from "genuinely idle" is also out of
scope. The decoder already separates `PreToolUse` from `PostToolUse`
(`src/core/providers.ts`), but the registry stores neither, so tracking
in-flight tools needs a new column and a migration.

This design does not change the waiting, idle, or error treatments, the board
reducer, paging, or the rail.

## Implementation notes

`lastEventAt` must stay out of `cardContentSignature`. That signature drives
the keyed reconciler, and any field inside it that changes triggers
`replaceWith`, which restarts CSS animations. `lastEventAt` changes every few
seconds on every working card, so including it would rebuild the whole board
continuously — the exact regression `activityLine` caused before per-card
reconciliation landed. It belongs with grid position and the ticked timer:
written to the node on every pass, never part of the rebuild signature.

Decay repaints on the existing one-second interval in `app/src/main.ts`, which
already runs `renderRailNow()` and `tickStatusLines()`; `tickStatusLines`
already walks `#board .cardtimer` and mutates text in place from a `data-since`
attribute. Decay follows the same shape against a `data-last-event` attribute.
Colour moves over seconds to minutes, so one-second resolution is ample, and no
new animation loop is needed.

Pulse detection compares each card's `lastEventAt` against the previous ingest,
keyed by `cardKey`, with a per-card two-second gate.

## Testing

Pure functions carry the logic and the tests: `decayPaint(ageMs)` returns the
edge and dot colour plus the quiet flag; `shouldPulse(previous, next,
lastPulseAtMs, nowMs)` returns the gate decision. Both are exhaustively testable
at their boundaries — 3s, 30s, 10m, the two-second gate, a stamp that does not
advance, and a null stamp.

Projection tests cover `updated_at` reaching `lastEventAt`. Protocol tests cover
the field present, absent, null, and malformed. A reconciler test asserts that a
changed `lastEventAt` alone reuses the DOM node rather than replacing it —
guarding the regression above.

## Deployment

`bun run build:app` and `bun run install:app` for the strip;
`bun scripts/install-local.ts` for the daemon, since the projection changed.
That installer fails at its install-plugin step on this machine because the
Elgato Stream Deck app is not installed; the daemon swap completes first, so the
daemon still deploys.

Exactly one daemon may hold the registry. Do not start a dev daemon from a
worktree — two daemons on the shared production registry fight over the Paseo
overlay and make the strip oscillate.

## Follow-ups

Per-session intensity via agentsview, including the cross-tool id join.

In-flight tool tracking, to separate a long `Bash` from a genuine stall.

Whether the pulse survives contact with a full board. Eleven real sessions at
their busiest produce 392 publishes in 180 seconds — one every 459ms, with 39%
landing within 250ms of another card's. Coalescing at two seconds is the
mitigation; if it still reads as busy, the pulse comes out and decay plus breath
carry the design alone.
