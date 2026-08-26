/**
 * Pure liveness logic for the board's working cards: colour decay from the
 * session's last hook stamp, the advance-triggered pulse gate, and the shared
 * breath phase. No DOM here — main.ts applies frames, cards.ts stamps nodes.
 */

import type { SessionStatus } from "../../src/protocol";

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
  /** The corner gap ("48s"): silence age once the edge starts fading, until quiet owns it. */
  gapLabel: string | null;
};

const EMPTY_FRAME: LivenessFrame = { quiet: false, edgeColor: null, dotColor: null, quietLabel: null, gapLabel: null };

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
    return { quiet: true, edgeColor: null, dotColor: null, quietLabel: `quiet ${elapsedLabel(age)}`, gapLabel: null };
  }
  return {
    quiet: false,
    edgeColor: rgb(paint.color, paint.alpha * (subagent ? 0.5 : 1)),
    dotColor: rgb(paint.color, paint.alpha),
    quietLabel: null,
    gapLabel: age >= FADE_MS ? elapsedLabel(age) : null,
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
 * Every card's stamp is tracked whatever its status, but only a working card
 * fires and consumes its gate — the spec leaves the waiting, idle, and error
 * treatments unchanged. Tracking through a non-working interlude matters:
 * dropping those cards would reseed them on their return to working and
 * swallow the first real pulse. The returned map holds exactly the current
 * page's cards, so entries for departed cards never accumulate — and a card
 * returning to the page reseeds silently instead of pulsing on arrival.
 */
export const planPulses = (
  prior: ReadonlyMap<string, PulseEntry>,
  cards: readonly { key: string; lastEventAt: string | null; status: SessionStatus }[],
  nowMs: number,
): { fire: string[]; next: Map<string, PulseEntry> } => {
  const fire: string[] = [];
  const next = new Map<string, PulseEntry>();
  for (const { key, lastEventAt, status } of cards) {
    const entry = prior.get(key);
    if (
      status === "working" &&
      entry !== undefined &&
      shouldPulse(entry.lastEventAt, lastEventAt, entry.lastPulseAtMs, nowMs)
    ) {
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
