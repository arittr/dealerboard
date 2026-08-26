# Strip Working-State Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the working card's ambient wash with liveness: edge/dot color decays with time since the session's last hook, a one-shot pulse crosses the card when the stamp advances, all live dots breathe on one shared wall-clock cycle, and a ≥10-minute-silent card hollows out to a "quiet" treatment.

**Architecture:** One additive snapshot field (`lastEventAt`, publishing `active_sessions.updated_at`) flows daemon→projection→protocol→app. All visual logic lives in pure functions in a new `app/src/liveness.ts` (`decayPaint`, `livenessFrame`, `shouldPulse`, `planPulses`, `breathAnimationDelay`); `main.ts` applies frames on its existing 1s tick and fires pulses on ingest; `cards.ts` keeps `lastEventAt` out of the rebuild signature and writes it to the node on every pass, exactly like grid position.

**Tech Stack:** Bun + TypeScript, bun:test with `test/support/fake-dom.ts`, plain CSS in `app/styles.css`.

**Spec:** `docs/superpowers/specs/2026-08-25-strip-working-state-design.md` — the plan argues from it; read both.

## Global Constraints

- `lastEventAt` must NOT enter `cardContentSignature` (spec "Implementation notes"): a per-few-seconds field inside the rebuild signature restarts every CSS animation continuously.
- The Stream Deck plugin's own wash in `src/plugin/render.ts` is untouched; `washCycleOffset` stays exported there.
- Decay bands (spec "Visual specification"): 0–3s `#20B8FF` alpha 1.00; 3–30s alpha 1.00→0.55; 30s–10m alpha 0.55→0.28 with rgb-lerp `#20B8FF`→`#55647A`; ≥10m quiet. Live rgb `[32,184,255]`, slate `[85,100,122]`.
- Quiet colors: edge rule `#55647A` (2px inset), surface `#171E28`, title `#8B9BB0`, label `#5C6B80`. The card says `quiet <elapsed>` — a fact — never "stalled"/"stuck".
- Pulse: `linear-gradient(90deg, rgb(32 184 255 / .34), transparent 46%)`, opacity 0→1→0 over 520ms, ease-out, peak at 10%, at most once per card per 2 seconds, only when `lastEventAt` advances.
- Breath: dot opacity factor 0.72→1.00 and scale 0.92→1.08 on a shared 4s cycle phased from the wall clock; it MULTIPLIES the decayed alpha (CSS `opacity` on the dot, never a color rewrite). Quiet cards do not breathe.
- Subagent edges multiply decayed alpha by 0.5; subagent dots breathe at full decayed alpha.
- The waiting, idle, and error treatments, the board reducer, paging, and the rail are unchanged.
- Exactly one daemon may hold the registry — never start a dev daemon from this worktree.
- Every task ends green: `bun test`, `bun run typecheck`, `bunx biome check <touched files>`; commit with lefthook hooks passing.

---

### Task 1: `lastEventAt` through protocol parse

**Files:**
- Modify: `src/protocol.ts` (ProjectedSession ~line 92-115; parseSession ~line 243-269)
- Test: `test/protocol.test.ts`

**Interfaces:**
- Produces: `ProjectedSession.lastEventAt: string | null` — required field, tolerant parse (missing key → null), consumed by every later task.

- [ ] **Step 1: Write the failing tests** — in `test/protocol.test.ts`, next to the other tolerant-field tests (find the `statusSince` ones and mirror them). The file's `firstSession()` builder and the `valid` fixture will not have the key yet, which is exactly the absent case:

```ts
test("lastEventAt parses when present, defaults to null when the key is absent", () => {
  const withStamp = {
    ...valid,
    sessions: [{ ...firstSession(), lastEventAt: "2026-08-25T05:10:08.055Z" }],
  };
  expect(parseSessionSnapshot(withStamp).sessions[0]?.lastEventAt).toBe("2026-08-25T05:10:08.055Z");
  expect(parseSessionSnapshot(valid).sessions[0]?.lastEventAt).toBeNull();
});

test("lastEventAt rejects non-string non-null values", () => {
  const malformed = { ...valid, sessions: [{ ...firstSession(), lastEventAt: 12 }] };
  expect(() => parseSessionSnapshot(malformed)).toThrow("session.lastEventAt");
  const explicitNull = { ...valid, sessions: [{ ...firstSession(), lastEventAt: null }] };
  expect(parseSessionSnapshot(explicitNull).sessions[0]?.lastEventAt).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure** — `bun test test/protocol.test.ts`. Expected: first test fails because the parsed session has no `lastEventAt` property (undefined ≠ string / null).

- [ ] **Step 3: Implement** — in `src/protocol.ts`:

In the `ProjectedSession` type, after `originParentRef`:
```ts
  /** ISO-8601 UTC of the row's last hook event; null when the registry has no stamp. */
  lastEventAt: string | null;
```

In `parseSession`, after the `originParentRef` block and before the `return`:
```ts
  const lastEventAt = "lastEventAt" in value ? value["lastEventAt"] : null;
  if (!isNullableBoundedString(lastEventAt)) {
    return invalid("session.lastEventAt must be null or a bounded string");
  }
```
and add `lastEventAt,` to the returned object.

- [ ] **Step 4: Fix the type ripple** — `bun run typecheck` now enumerates every test fixture literal missing the required key (expect `test/protocol.test.ts`'s `firstSession`, `test/strip-cards.test.ts`'s `session()`, and builders in `test/strip-board.test.ts`, `test/projection.test.ts`, `test/press.test.ts`, `test/strip-tile-identity.test.ts`, `test/strip-action-sheet.test.ts`, `test/snapshot-view` fixtures if present — fix exactly what tsc lists). Add `lastEventAt: null,` to each listed literal. Do not change any assertion.

- [ ] **Step 5: Verify** — `bun test && bun run typecheck`. Expected: all green.

- [ ] **Step 6: Commit** — `git add -u && git commit -m "feat(protocol): add lastEventAt to ProjectedSession with tolerant parse"`

---

### Task 2: publish `updated_at` as `lastEventAt` from the projection

**Files:**
- Modify: `src/core/projection.ts` (ProjectionRow ~34-52; toProjectionRow ~316-411; StoredRow ~293-311; PROJECTION_COLUMNS ~413; projectRows emit ~269-287)
- Test: `test/projection.test.ts`

**Interfaces:**
- Consumes: `ProjectedSession.lastEventAt` (Task 1).
- Produces: snapshot sessions carrying the row's `updated_at`; the daemon needs no other change (it already republishes whenever the registry changes).

- [ ] **Step 1: Write the failing tests** — `test/projection.test.ts` builds `ProjectionRow` fixtures (find its row builder; it gained `lastEventAt: null` in Task 1's ripple pass if tsc flagged it — otherwise add the field now). Add:

```ts
test("publishes the row's lastEventAt on the projected session", () => {
  const projected = projectRows([row({ status: "working", lastEventAt: "2026-08-25T05:10:08.055Z" })]);
  expect(projected[0]?.lastEventAt).toBe("2026-08-25T05:10:08.055Z");
  expect(projectRows([row({ status: "working", lastEventAt: null })])[0]?.lastEventAt).toBeNull();
});
```
(`row(...)` is the file's existing top-level-row builder at `test/projection.test.ts:18` — it gained `lastEventAt: null` in Task 1's ripple pass if tsc flagged it; otherwise add the field to its defaults now.) `toProjectionRow` is not exported, so the stored-row mapping is covered through the existing `readProjection` describe block (~line 617), whose fixtures write real rows via `applyRegistryEvents`: inside that block, add one assertion that the published stamp is the row's `updated_at` — the last event's `observedAt`:

```ts
test("publishes the row's updated_at as lastEventAt", () => {
  // Use the block's existing db/paths setup verbatim; start one session and
  // give it a later Activity so updated_at ≠ the start stamp.
  applyRegistryEvents(db, [
    start("s1", { at: "2026-08-06T00:00:01.000Z" }),
    simple("Activity", "s1", { at: "2026-08-06T00:00:07.000Z" }),
  ]);
  const snapshot = readProjection(reader);
  expect(snapshot.sessions[0]?.lastEventAt).toBe("2026-08-06T00:00:07.000Z");
});
```
(Adapt the event helpers to the ones this file actually defines for its readProjection fixtures — it seeds through `applyRegistryEvents` per its imports; reuse its local helper names and db/reader handles exactly as the neighboring tests do.)

- [ ] **Step 2: Run to verify failure** — `bun test test/projection.test.ts`. Expected: `lastEventAt` missing from `ProjectionRow` type (compile error under tsc, undefined at runtime) and from the projected output.

- [ ] **Step 3: Implement** — in `src/core/projection.ts`:

`ProjectionRow`, after `originParentRef`:
```ts
  /** ISO-8601 UTC of the row's last hook event (`updated_at`); null tolerated defensively. */
  lastEventAt: string | null;
```

`StoredRow`: add `updated_at: unknown;`

`toProjectionRow`: extend the existing `isStringOrNull` gate group that covers `transcript_path`/`origin_parent_ref`/`activity_line` with `row.updated_at`:
```ts
  if (
    !isStringOrNull(row.transcript_path) ||
    !isStringOrNull(row.origin_parent_ref) ||
    !isStringOrNull(row.activity_line) ||
    !isStringOrNull(row.updated_at)
  ) {
    throw new ProjectionError("corrupt-row");
  }
```
and map `lastEventAt: row.updated_at,` in its return.

`PROJECTION_COLUMNS`: append `, updated_at`.

`projectRows` visible-root emit: add `lastEventAt: root.lastEventAt,`.

- [ ] **Step 4: Verify** — `bun test && bun run typecheck`. Expected: all green (Task 1's ripple already stamped `lastEventAt: null` into this file's fixtures; tsc lists any stragglers).

- [ ] **Step 5: Commit** — `git add -u && git commit -m "feat(projection): publish updated_at as lastEventAt"`

---

### Task 3: pure liveness functions

**Files:**
- Create: `app/src/liveness.ts`
- Modify: `app/src/cards.ts` (move `elapsedLabel` out; re-import), `app/src/main.ts` (import `elapsedLabel` from `./liveness`), `test/strip-cards.test.ts` (import path)
- Test: `test/strip-liveness.test.ts` (new)

**Interfaces:**
- Produces (all exported from `app/src/liveness.ts`, consumed by Tasks 4–5):
  - `elapsedLabel(elapsedMs: number): string` (moved verbatim from cards.ts)
  - `QUIET_AFTER_MS = 600_000`, `BREATH_CYCLE_MS = 4000`, `PULSE_GATE_MS = 2000`, `PULSE_SWEEP_MS = 520`
  - `decayPaint(ageMs: number): { quiet: boolean; color: [number, number, number]; alpha: number }`
  - `livenessFrame(lastEventAt: string | null, subagent: boolean, nowMs: number): { quiet: boolean; edgeColor: string | null; dotColor: string | null; quietLabel: string | null }`
  - `shouldPulse(previous: string | null, next: string | null, lastPulseAtMs: number | null, nowMs: number): boolean`
  - `type PulseEntry = { lastEventAt: string | null; lastPulseAtMs: number | null }`
  - `planPulses(prior: ReadonlyMap<string, PulseEntry>, cards: readonly { key: string; lastEventAt: string | null }[], nowMs: number): { fire: string[]; next: Map<string, PulseEntry> }`
  - `breathAnimationDelay(nowMs: number): string`

- [ ] **Step 1: Write the failing tests** — create `test/strip-liveness.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  breathAnimationDelay,
  decayPaint,
  livenessFrame,
  planPulses,
  type PulseEntry,
  shouldPulse,
} from "../app/src/liveness";

describe("decayPaint", () => {
  test("holds full-alpha live blue through the first three seconds", () => {
    expect(decayPaint(0)).toEqual({ quiet: false, color: [32, 184, 255], alpha: 1 });
    expect(decayPaint(2999)).toEqual({ quiet: false, color: [32, 184, 255], alpha: 1 });
    expect(decayPaint(-500)).toEqual({ quiet: false, color: [32, 184, 255], alpha: 1 });
  });

  test("fades alpha 1.00 to 0.55 between 3s and 30s at constant hue", () => {
    expect(decayPaint(3000).alpha).toBeCloseTo(1, 5);
    const mid = decayPaint(16_500); // midpoint of the band
    expect(mid.alpha).toBeCloseTo(0.775, 5);
    expect(mid.color).toEqual([32, 184, 255]);
    expect(decayPaint(30_000).alpha).toBeCloseTo(0.55, 5);
  });

  test("fades 0.55 to 0.28 and lerps toward slate between 30s and 10m", () => {
    const mid = decayPaint(315_000); // midpoint of the band
    expect(mid.alpha).toBeCloseTo(0.415, 5);
    expect(mid.color).toEqual([59, 142, 189]); // per-channel round of the halfway lerp
    expect(mid.quiet).toBe(false);
    expect(decayPaint(599_999).quiet).toBe(false);
    expect(decayPaint(599_999).alpha).toBeCloseTo(0.28, 3);
  });

  test("goes quiet at exactly ten minutes", () => {
    expect(decayPaint(600_000)).toEqual({ quiet: true, color: [85, 100, 122], alpha: 0.28 });
  });
});

describe("livenessFrame", () => {
  const NOW = Date.parse("2026-08-25T00:10:00.000Z");
  const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

  test("paints edge and dot from the decay, halving only the edge for subagents", () => {
    const primary = livenessFrame(at(30_000), false, NOW);
    expect(primary).toEqual({
      quiet: false,
      edgeColor: "rgb(32 184 255 / 0.55)",
      dotColor: "rgb(32 184 255 / 0.55)",
      quietLabel: null,
    });
    const sub = livenessFrame(at(30_000), true, NOW);
    expect(sub.edgeColor).toBe("rgb(32 184 255 / 0.275)");
    expect(sub.dotColor).toBe("rgb(32 184 255 / 0.55)");
  });

  test("a quiet frame drops inline colors and states the silence as a fact", () => {
    expect(livenessFrame(at(12 * 60_000), false, NOW)).toEqual({
      quiet: true,
      edgeColor: null,
      dotColor: null,
      quietLabel: "quiet 12m",
    });
  });

  test("a null or unparseable stamp paints nothing (old-daemon fallback)", () => {
    const empty = { quiet: false, edgeColor: null, dotColor: null, quietLabel: null };
    expect(livenessFrame(null, false, NOW)).toEqual(empty);
    expect(livenessFrame("not-a-date", false, NOW)).toEqual(empty);
  });
});

describe("shouldPulse", () => {
  test("fires only when the stamp strictly advances", () => {
    expect(shouldPulse("2026-08-25T00:00:01.000Z", "2026-08-25T00:00:02.000Z", null, 0)).toBe(true);
    expect(shouldPulse("2026-08-25T00:00:02.000Z", "2026-08-25T00:00:02.000Z", null, 0)).toBe(false);
    expect(shouldPulse("2026-08-25T00:00:03.000Z", "2026-08-25T00:00:02.000Z", null, 0)).toBe(false);
    expect(shouldPulse(null, "2026-08-25T00:00:02.000Z", null, 0)).toBe(false);
    expect(shouldPulse("2026-08-25T00:00:01.000Z", null, null, 0)).toBe(false);
  });

  test("coalesces to at most one pulse per card per two seconds", () => {
    const previous = "2026-08-25T00:00:01.000Z";
    const next = "2026-08-25T00:00:02.000Z";
    expect(shouldPulse(previous, next, 10_000, 11_999)).toBe(false);
    expect(shouldPulse(previous, next, 10_000, 12_000)).toBe(true);
  });
});

describe("planPulses", () => {
  const CARD = "claude s1";

  test("seeds silently, fires on advance, and stamps the gate", () => {
    const seeded = planPulses(new Map(), [{ key: CARD, lastEventAt: "2026-08-25T00:00:01.000Z" }], 1000);
    expect(seeded.fire).toEqual([]);

    const advanced = planPulses(seeded.next, [{ key: CARD, lastEventAt: "2026-08-25T00:00:02.000Z" }], 2000);
    expect(advanced.fire).toEqual([CARD]);
    expect(advanced.next.get(CARD)).toEqual({ lastEventAt: "2026-08-25T00:00:02.000Z", lastPulseAtMs: 2000 });

    // A second advance inside the gate updates the stamp but does not fire.
    const gated = planPulses(advanced.next, [{ key: CARD, lastEventAt: "2026-08-25T00:00:03.000Z" }], 3000);
    expect(gated.fire).toEqual([]);
    expect(gated.next.get(CARD)?.lastEventAt).toBe("2026-08-25T00:00:03.000Z");
  });

  test("drops entries for cards no longer on the page", () => {
    const prior = new Map<string, PulseEntry>([[CARD, { lastEventAt: "2026-08-25T00:00:01.000Z", lastPulseAtMs: null }]]);
    const { next } = planPulses(prior, [], 1000);
    expect(next.size).toBe(0);
  });
});

describe("breathAnimationDelay", () => {
  test("derives a shared phase from the wall clock", () => {
    expect(breathAnimationDelay(0)).toBe("-0.000s");
    expect(breathAnimationDelay(1234)).toBe("-1.234s");
    expect(breathAnimationDelay(4000)).toBe("-0.000s");
    expect(breathAnimationDelay(5234)).toBe("-1.234s");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test test/strip-liveness.test.ts`. Expected: module `../app/src/liveness` not found.

- [ ] **Step 3: Implement** — create `app/src/liveness.ts`:

```ts
/**
 * Pure liveness logic for the board's working cards: colour decay from the
 * session's last hook stamp, the advance-triggered pulse gate, and the shared
 * breath phase. No DOM here — main.ts applies frames, cards.ts stamps nodes.
 */

/** Compact elapsed label shared by the status timer and the quiet label: 42s, 12m, 3h, 2d. */
export const elapsedLabel = (elapsedMs: number): string => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
};

/** Silence this long is the quiet treatment's threshold (see the spec's gap percentiles). */
export const QUIET_AFTER_MS = 10 * 60 * 1000;
/** One shared breath cycle; phase derives from the wall clock so every dot matches. */
export const BREATH_CYCLE_MS = 4000;
/** At most one pulse per card per this many milliseconds. */
export const PULSE_GATE_MS = 2000;
/** The pulse overlay's full sweep duration. */
export const PULSE_SWEEP_MS = 520;

const LIVE: readonly [number, number, number] = [32, 184, 255]; // #20B8FF
const SLATE: readonly [number, number, number] = [85, 100, 122]; // #55647A

const FRESH_MS = 3000;
const FADE_MS = 30_000;
const FRESH_ALPHA = 1;
const FADE_ALPHA = 0.55;
const QUIET_ALPHA = 0.28;

export type DecayPaint = { quiet: boolean; color: [number, number, number]; alpha: number };

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

/** Edge/dot paint as a function of silence. Bands and endpoints are the spec's. */
export const decayPaint = (ageMs: number): DecayPaint => {
  const age = Math.max(0, ageMs);
  if (age >= QUIET_AFTER_MS) {
    return { quiet: true, color: [...SLATE], alpha: QUIET_ALPHA };
  }
  if (age < FRESH_MS) {
    return { quiet: false, color: [...LIVE], alpha: FRESH_ALPHA };
  }
  if (age < FADE_MS) {
    const t = (age - FRESH_MS) / (FADE_MS - FRESH_MS);
    return { quiet: false, color: [...LIVE], alpha: lerp(FRESH_ALPHA, FADE_ALPHA, t) };
  }
  const t = (age - FADE_MS) / (QUIET_AFTER_MS - FADE_MS);
  const color = LIVE.map((channel, index) => Math.round(lerp(channel, SLATE[index] ?? channel, t))) as [
    number,
    number,
    number,
  ];
  return { quiet: false, color, alpha: lerp(FADE_ALPHA, QUIET_ALPHA, t) };
};

const rgb = ([red, green, blue]: readonly [number, number, number], alpha: number): string =>
  `rgb(${red} ${green} ${blue} / ${Number(alpha.toFixed(4))})`;

export type LivenessFrame = {
  quiet: boolean;
  /** Inline edge color, or null to fall back to the stylesheet (no stamp, or quiet). */
  edgeColor: string | null;
  dotColor: string | null;
  /** "quiet 12m" — the silence age as a fact; null while live. */
  quietLabel: string | null;
};

const EMPTY_FRAME: LivenessFrame = { quiet: false, edgeColor: null, dotColor: null, quietLabel: null };

/**
 * One card's liveness for this tick. A null or unparseable stamp paints
 * nothing — an old daemon's snapshot degrades to the static stylesheet
 * treatment. Subagents halve the edge's decayed alpha (their existing
 * half-strength edge language); their dots keep full decayed alpha and
 * breathe on the shared cycle.
 */
export const livenessFrame = (lastEventAt: string | null, subagent: boolean, nowMs: number): LivenessFrame => {
  if (lastEventAt === null) {
    return EMPTY_FRAME;
  }
  const eventMs = Date.parse(lastEventAt);
  if (Number.isNaN(eventMs)) {
    return EMPTY_FRAME;
  }
  const age = nowMs - eventMs;
  const paint = decayPaint(age);
  if (paint.quiet) {
    return { quiet: true, edgeColor: null, dotColor: null, quietLabel: `quiet ${elapsedLabel(age)}` };
  }
  return {
    quiet: false,
    edgeColor: rgb(paint.color, paint.alpha * (subagent ? 0.5 : 1)),
    dotColor: rgb(paint.color, paint.alpha),
    quietLabel: null,
  };
};

/**
 * Fire when the stamp strictly advances (canonical UTC ISO-8601 compares
 * lexically) outside the per-card gate. Null stamps on either side never
 * fire: a first sighting is not an advance, and a stampless daemon has no
 * advances to report.
 */
export const shouldPulse = (
  previous: string | null,
  next: string | null,
  lastPulseAtMs: number | null,
  nowMs: number,
): boolean => {
  if (previous === null || next === null || next <= previous) {
    return false;
  }
  return lastPulseAtMs === null || nowMs - lastPulseAtMs >= PULSE_GATE_MS;
};

export type PulseEntry = { lastEventAt: string | null; lastPulseAtMs: number | null };

/**
 * One ingest's pulse decisions against the previous ingest, keyed by card.
 * The returned map holds exactly the current page's cards, so entries for
 * departed cards never accumulate — and a card returning to the page reseeds
 * silently instead of pulsing on arrival.
 */
export const planPulses = (
  prior: ReadonlyMap<string, PulseEntry>,
  cards: readonly { key: string; lastEventAt: string | null }[],
  nowMs: number,
): { fire: string[]; next: Map<string, PulseEntry> } => {
  const fire: string[] = [];
  const next = new Map<string, PulseEntry>();
  for (const { key, lastEventAt } of cards) {
    const entry = prior.get(key);
    if (entry !== undefined && shouldPulse(entry.lastEventAt, lastEventAt, entry.lastPulseAtMs, nowMs)) {
      fire.push(key);
      next.set(key, { lastEventAt, lastPulseAtMs: nowMs });
      continue;
    }
    next.set(key, { lastEventAt, lastPulseAtMs: entry?.lastPulseAtMs ?? null });
  }
  return { fire, next };
};

/**
 * Negative delay aligning a dot's breath to the shared wall-clock phase, so
 * a rebuilt card resumes mid-cycle in step with every other dot.
 */
export const breathAnimationDelay = (nowMs: number): string =>
  `-${((((nowMs % BREATH_CYCLE_MS) + BREATH_CYCLE_MS) % BREATH_CYCLE_MS) / 1000).toFixed(3)}s`;
```

Then in `app/src/cards.ts`: delete the `elapsedLabel` definition, add `import { elapsedLabel } from "./liveness";`, and keep re-exporting nothing — update the two importers instead: `app/src/main.ts` changes `import { boardRenderSignature, elapsedLabel, renderBoard } from "./cards"` to import `elapsedLabel` from `./liveness`; `test/strip-cards.test.ts` moves its `elapsedLabel` import (if any) to `../app/src/liveness`. `cards.ts` keeps exporting `statusLineText` unchanged (it now calls the imported `elapsedLabel`).

- [ ] **Step 4: Verify** — `bun test && bun run typecheck`. Expected: all green, including the moved-import sites.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(app): pure liveness functions — decay, pulse gate, shared breath phase"`

---

### Task 4: card DOM — stamp on every pass, wash removal, pulse/quiet/breath hooks

**Files:**
- Modify: `app/src/cards.ts`
- Test: `test/strip-cards.test.ts`

**Interfaces:**
- Consumes: `breathAnimationDelay` (Task 3), `ProjectedSession.lastEventAt` (Task 1).
- Produces: `applyCardFrame(element: HTMLElement, card: PlacedCard, index: number): void` (exported; renderBoard applies it on every pass); cards carry `data-last-event`, a `.pulse-overlay` span, a `.meta-item.quiet-elapsed` span, and `--breath-delay`; `WASH_CYCLE_MS`/`washAnimationDelay` are gone.

- [ ] **Step 1: Write the failing tests** — in `test/strip-cards.test.ts` (its `session()`/`placed()` builders already carry `lastEventAt: null` from Task 1's ripple):

```ts
describe("liveness reconciliation", () => {
  test("a changed lastEventAt alone reuses the DOM node", () => {
    const before = placed({}, { lastEventAt: "2026-08-25T00:00:01.000Z" });
    const after = placed({}, { lastEventAt: "2026-08-25T00:00:09.000Z" });
    expect(cardContentSignature(before)).toBe(cardContentSignature(after));
    const previous = new Map([[cardKey(before), cardContentSignature(before)]]);
    expect(planCardPatches(previous, [after])[0]?.action).toBe("reuse");
  });

  test("applyCardFrame writes the stamp, position, and index on every pass", () => {
    const element = new FakeElement("div") as unknown as HTMLElement;
    applyCardFrame(element, placed({ column: 2, row: 1 }, { lastEventAt: "2026-08-25T00:00:01.000Z" }), 5);
    expect(element.dataset["lastEvent"]).toBe("2026-08-25T00:00:01.000Z");
    expect(element.dataset["cardIndex"]).toBe("5");
    expect(element.style.gridColumn).toBe("3");
    expect(element.style.gridRow).toBe("2");
    applyCardFrame(element, placed({ column: 2, row: 1 }, { lastEventAt: null }), 5);
    expect(element.dataset["lastEvent"]).toBe("");
  });
});
```
Add `import { FakeElement } from "./support/fake-dom";` and `applyCardFrame` to the cards import list. Delete the existing `washAnimationDelay`/`WASH_CYCLE_MS` tests in this file (the exports are removed by this task — deleting a test for a deleted export is the feature, not lost coverage; the breath phase that replaces the stagger is covered by Task 3's `breathAnimationDelay` tests).

- [ ] **Step 2: Run to verify failure** — `bun test test/strip-cards.test.ts`. Expected: `applyCardFrame` not exported; the signature test fails because `cardContentSignature` still serializes `lastEventAt` (signatures differ).

- [ ] **Step 3: Implement** — in `app/src/cards.ts`:

Imports: drop `washCycleOffset` from the `../../src/plugin/render` import (keep `modelLabel`, `PROVIDER_LETTERS`); add `import { breathAnimationDelay, elapsedLabel } from "./liveness";` (elapsedLabel already moved in Task 3).

Delete `WASH_CYCLE_MS` and `washAnimationDelay` entirely, and in `cardElement` delete the `--wash-delay` block:
```ts
  if (model.status === "working") {
    element.style.setProperty("--wash-delay", washAnimationDelay(card.session.sessionId, nowMs));
  }
```
replacing it with the shared breath phase (every card gets it; CSS scopes which dots animate):
```ts
  element.style.setProperty("--breath-delay", breathAnimationDelay(nowMs));
```

In `cardElement`'s meta row, before `meta.append(metaRight);`, add the quiet label slot (empty while live; the 1s ticker owns its text):
```ts
  appendText(meta, "meta-item quiet-elapsed", "");
```

At the end of `cardElement`, before `return element;`, add the pulse overlay (a permanent, invisible layer the ingest path animates):
```ts
  const pulse = document.createElement("span");
  pulse.className = "pulse-overlay";
  element.append(pulse);
```

Change `cardContentSignature` to exclude the stamp (the node-frame writer below owns it):
```ts
/**
 * The per-card rebuild signature: everything cardElement bakes into the node
 * except its page position and its liveness stamp — both are (re)applied on
 * every pass by applyCardFrame, so a card that merely moves or ticks keeps
 * its DOM node, its CSS animation phase, and its in-place-painted decay.
 */
export const cardContentSignature = ({ column: _column, row: _row, ...content }: PlacedCard): string => {
  const { lastEventAt: _lastEventAt, ...session } = content.session;
  return JSON.stringify({ ...content, session });
};
```

Add the every-pass frame writer and use it in `renderBoard` (replacing the three inline lines under the "Position and index sit outside the content signature" comment):
```ts
/**
 * Everything outside the rebuild signature, (re)written on every pass: grid
 * position, the dense index, and the liveness stamp the 1s decay ticker
 * reads. A reused node gets fresh values without re-inserting.
 */
export const applyCardFrame = (element: HTMLElement, card: PlacedCard, index: number): void => {
  element.dataset["cardIndex"] = String(index);
  element.style.gridColumn = String(card.column + 1);
  element.style.gridRow = String(card.row + 1);
  element.dataset["lastEvent"] = card.session.lastEventAt ?? "";
};
```
and in `renderBoard`:
```ts
    applyCardFrame(element, patch.card, index);
    kept.add(element);
```

- [ ] **Step 4: Verify** — `bun test && bun run typecheck`. Expected: all green; no remaining references to `washAnimationDelay`/`WASH_CYCLE_MS` (`grep -rn "washAnimationDelay\|WASH_CYCLE_MS" app src test` returns nothing).

- [ ] **Step 5: Commit** — `git add -u && git commit -m "feat(app): stamp liveness on the card frame, retire the wash"`

---

### Task 5: main.ts wiring — decay tick and ingest pulses

**Files:**
- Modify: `app/src/main.ts`

**Interfaces:**
- Consumes: `livenessFrame`, `planPulses`, `PulseEntry`, `PULSE_SWEEP_MS` (Task 3); `cardKey` (existing), `applyCardFrame`-written `data-last-event`/`data-card-key` (Task 4 / existing renderBoard).
- Produces: user-visible behavior only; main.ts is composition glue and stays untested by the codebase's convention — all logic it applies was tested in Task 3.

- [ ] **Step 1: Implement the decay tick** — in `app/src/main.ts`, change the imports to exactly: `import { boardRenderSignature, cardKey, renderBoard } from "./cards";` and `import { elapsedLabel, livenessFrame, planPulses, type PulseEntry, PULSE_SWEEP_MS } from "./liveness";` (`elapsedLabel` moved in Task 3 and is used by the existing `tickStatusLines`; `cardKey` is new here for the pulse pass).

Add below `tickStatusLines`:
```ts
/**
 * Paint every working card's decay in place from its data-last-event stamp.
 * Inline styles are written (and removed — quiet and stampless cards must
 * fall back to the stylesheet) without touching the render signature, so
 * reconciliation and CSS animations are undisturbed, exactly like the
 * status-timer tick above.
 */
const tickLiveness = (): void => {
  const nowMs = Date.now();
  for (const card of document.querySelectorAll<HTMLElement>("#board .card.status-working")) {
    const stamp = card.dataset["lastEvent"];
    const frame = livenessFrame(stamp === undefined || stamp === "" ? null : stamp, card.classList.contains("sub"), nowMs);
    card.classList.toggle("quiet", frame.quiet);
    if (frame.edgeColor === null) {
      card.style.removeProperty("border-left-color");
    } else {
      card.style.borderLeftColor = frame.edgeColor;
    }
    if (frame.dotColor === null) {
      card.style.removeProperty("--st");
    } else {
      card.style.setProperty("--st", frame.dotColor);
    }
    const label = card.querySelector<HTMLElement>(".quiet-elapsed");
    if (label !== null) {
      const text = frame.quietLabel ?? "";
      if (label.textContent !== text) {
        label.textContent = text;
      }
    }
  }
};
```
and call it from the existing 1s interval:
```ts
  setInterval(() => {
    renderRailNow();
    tickStatusLines();
    tickLiveness();
  }, 1000);
```

- [ ] **Step 2: Implement the pulse pass** — add module state near the other `let` declarations:
```ts
let pulseEntries: ReadonlyMap<string, PulseEntry> = new Map();
```
In `applyBoard`, inside the `if (root !== null && signature !== renderedSignature)` block, after `renderBoard(root, page, degraded);`:
```ts
    // Pulse on stamp advance: compared against the previous ingest, keyed by
    // card, gated per card — and animated via element.animate so a re-fire
    // never has to fight a CSS class retrigger.
    const plan = planPulses(
      pulseEntries,
      page.cards.map((card) => ({ key: cardKey(card), lastEventAt: card.session.lastEventAt })),
      Date.now(),
    );
    pulseEntries = plan.next;
    for (const key of plan.fire) {
      root
        .querySelector<HTMLElement>(`[data-card-key="${CSS.escape(key)}"] .pulse-overlay`)
        ?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 0 }], {
          duration: PULSE_SWEEP_MS,
          easing: "ease-out",
        });
    }
    tickLiveness(); // fresh nodes paint immediately instead of waiting out the 1s tick
```
(`tickLiveness` is declared with `const` after `applyBoard` in file order — move the `tickLiveness` declaration ABOVE `applyBoard` so the reference is initialized; keep `tickStatusLines` where it is.)

- [ ] **Step 3: Verify** — `bun test && bun run typecheck && bunx biome check app/src/main.ts`. Expected: all green (no behavioral tests exist for main.ts; the compile gate is the check here).

- [ ] **Step 4: Commit** — `git add -u && git commit -m "feat(app): tick decay in place and pulse on stamp advance"`

---

### Task 6: stylesheet — wash out; quiet, pulse, breath in

**Files:**
- Modify: `app/styles.css` (working/wash block ~89-158; sub block ~164-183; status dot ~310-317)

**Interfaces:**
- Consumes: the `quiet` class, `--breath-delay`, `--st` inline overrides, `.pulse-overlay`, `.quiet-elapsed` (Tasks 4–5).

- [ ] **Step 1: Remove the wash** — in `app/styles.css`:
- In the shared overlay group, drop working (keep waiting/error):
```css
.card.status-waiting::after,
.card.status-error::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
}
```
- Delete the whole `.card.status-working::after { ... }` block (background/opacity/animation/`--wash-delay`) and the `@keyframes wash` block.
- Update the block comment above `.card.status-working` (~line 84): replace the "working breathes a shallow staggered wash" sentence with "working carries the liveness treatment: the 1s ticker decays the edge and dot from data-last-event, the shared-phase breath animates the dot, and ten silent minutes hollow the card to quiet". Also fix the `.card` comment at ~line 64 ("the wash overlay is ::after" → "the waiting/error tint is ::after; .pulse-overlay is the working card's event flash").
- The static `.card.status-working { --st: #20b8ff; border-left-color: rgb(32 184 255 / 0.9); }` and `.card.sub.status-working { border-left: ... 0.5); }` blocks STAY — they are the stampless (old-daemon) fallback the ticker deliberately leaves alone.

- [ ] **Step 2: Add the liveness CSS** — after the `@keyframes pulse` block:
```css
/* Liveness (working cards only; waiting/idle/error treatments unchanged).
   Decay: the 1s ticker inline-paints border-left-color and --st from
   data-last-event; these rules carry only what the ticker cannot. */

/* Quiet: ≥10 silent minutes. The solid edge gives way to a 2px inset rule,
   the dot hollows, the surface sinks, and the meta row states the silence
   as a fact ("quiet 12m") — never a claim like "stalled". */
.card.status-working.quiet {
  background: #171e28;
  border-left-color: transparent;
  box-shadow: inset 0.078vw 0 0 #55647a; /* 2px native rule in the edge slot */
}
.card.status-working.quiet .card-title {
  color: #8b9bb0;
}
.card.status-working.quiet .status-dot {
  background: transparent;
  border: max(1px, 0.078vw) solid #55647a;
  animation: none;
}
.quiet-elapsed {
  color: #5c6b80;
}
.quiet-elapsed:empty {
  display: none;
}

/* Pulse: a one-shot bloom fired by main.ts via element.animate when the
   card's stamp advances (coalesced per card); at rest it is invisible. */
.pulse-overlay {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: linear-gradient(90deg, rgb(32 184 255 / 0.34), transparent 46%);
  opacity: 0;
  pointer-events: none;
}

/* Breath: proof of life on one shared four-second cycle — the phase comes
   from the wall clock (--breath-delay), so every dot on the board inhales
   together and the one still dot (a quiet card) is the salient thing.
   opacity MULTIPLIES the decayed --st alpha; it must never replace it. */
.card.status-working:not(.quiet) .status-dot {
  animation: breath 4s ease-in-out infinite;
  animation-delay: var(--breath-delay, 0s);
}
@keyframes breath {
  0%,
  100% {
    opacity: 1;
    transform: scale(1.08);
  }
  50% {
    opacity: 0.72;
    transform: scale(0.92);
  }
}
```

- [ ] **Step 3: Verify** — `bun run build:app && bun test && bun run typecheck && bunx biome check app/styles.css`; then `grep -n "wash" app/styles.css app/src/*.ts` — expected: no hits (the plugin's wash lives in `src/plugin/render.ts`/`src/plugin`, untouched).

- [ ] **Step 4: Commit** — `git add -u && git commit -m "feat(app): quiet, pulse, and shared-breath styles replace the wash"`

---

### Task 7: deploy and verify on the panel

**Files:** none (build + install + observation)

- [ ] **Step 1: Full gate** — `bun run check` (biome ci + build + tests). Expected: green.

- [ ] **Step 2: Deploy the daemon** — the projection changed, so the daemon must ship: `bun scripts/install-local.ts`. Expected: daemon swap + launchd bootstrap succeed; the final install-plugin step fails with `kLSApplicationNotFoundErr` (no Elgato app on this Mac) — known and harmless. Verify exactly one holder: `lsof "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/registry.sqlite3"` lists one `stream-de` process.

- [ ] **Step 3: Deploy the app** — `bun run install:app`, then kill the running instance and relaunch: `pkill -f "Agent Strip.app/Contents/MacOS/agent-strip"; sleep 2; open -a "Agent Strip"`. Verify `ps auxww | grep agent-strip` shows exactly one process and `/Applications/Agent Strip.app/Contents/MacOS/agent-strip` has a fresh mtime.

- [ ] **Step 4: Verify the field end-to-end** — `jq '.sessions[0].lastEventAt' "$HOME/Library/Application Support/com.drewritter.stream-deck-agents/snapshot-v2.json"` — expected: an ISO timestamp (not null, not missing) for a live session.

- [ ] **Step 5: Verify visually** — wait ~60s after launch (the strip window can render displaced ~30px until the re-pin settles — do not judge geometry before that), then `screencapture -x -D <xeneon display id> /tmp/strip-liveness.png` (find the display id with `system_profiler SPDisplaysDataType` or capture all displays) and check: a fresh working card's edge is bright blue; a card silent ~a minute reads dimmer; dots visibly breathe in unison; no whole-card blue wash remains. If a session has been silent ten minutes, its card is hollow with `quiet <elapsed>` in the meta row.

- [ ] **Step 6: Commit any deploy-note doc changes and report** — surface the screenshot to Drew for the design-pass verdict before merging (strip visual changes get his eyes per the design-pass workflow).
