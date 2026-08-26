import { describe, expect, test } from "bun:test";
import {
  breathAnimationDelay,
  decayPaint,
  livenessFrame,
  type PulseEntry,
  planPulses,
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
    const prior = new Map<string, PulseEntry>([
      [CARD, { lastEventAt: "2026-08-25T00:00:01.000Z", lastPulseAtMs: null }],
    ]);
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
