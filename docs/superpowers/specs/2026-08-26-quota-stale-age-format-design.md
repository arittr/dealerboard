# Quota panel stale-age format — design

## Problem

An unavailable quota panel with a pending reset renders the note
`resets 21h 7m · updated 1h 31m ago` ahead of the percent. That string is long
enough to wrap inside `.quota-right`, producing an orphaned `ago ·` second line
(observed on the Qwen row). The ok-state note is a bare countdown (`6d ·`); the
words "resets" and "updated … ago" are later accretions that broke the row's
compactness budget.

## Design

Show the same two facts — binding reset countdown and data age — with far
fewer characters, and make wrapping impossible.

**Age format** (`app/src/quota.ts`): replace `formatUpdatedAge` with a coarse
formatter that drops minute precision at the hour scale:

- `< 1h`: `${ceil minutes}m old` (minutes are the natural sub-hour unit)
- `1h–24h`: `${floor hours}h+ old` — the `+` preserves "at least this stale"
- `>= 24h`: `${floor days}d+ old`

**Note strings** (`formatBindingNote`, unavailable state):

- pending reset, probe within the stale threshold: `2h 21m` (bare countdown —
  drops "resets", matching the ok-state format)
- pending reset, past the stale threshold: `21h 7m · 1h+ old`
- reset passed or absent: `2h+ old`
- never fetched: `unavailable` (unchanged)

The reset countdown itself keeps its existing minute precision
(`formatResetCountdown` is untouched).

**CSS** (`app/styles.css`): `.quota-note` gets `white-space: nowrap` so the
note can never wrap into a second line again.

## Scope

- `app/src/quota.ts`: new coarse age formatter; `formatBindingNote` unavailable
  branches reworded.
- `app/styles.css`: nowrap on `.quota-note`.
- `test/strip-quota.test.ts`: updated `formatBindingNote` expectations,
  including the sub-hour, hour-plus, day-plus, and reset-passed cases.
- `docs/design.md`: the quota-row section's unavailable-panel sentence updated
  to the new note format.

No daemon, protocol, or snapshot changes. Rendering in `app/src/rail.ts` is
untouched — it consumes `formatBindingNote`'s string as-is.
