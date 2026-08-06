/**
 * One bounded animation scheduler shared by every action context.
 *
 * A single 250 ms interval drives all keys. Each context tracks the last sent
 * image, the newest desired image, an in-flight flag, an active flag, and the
 * last start time. A tick computes the current desired frame for every active
 * context, suppresses identical frames, replaces (never queues) pending work
 * while a send is in flight, and starts at most one update per context per
 * tick, never sooner than 250 ms after that key's previous start — a
 * four-starts-per-second ceiling per key, below the SDK's ten-updates-per-
 * second guidance. The first render after registration is immediate.
 *
 * Promise completion only clears the in-flight flag; it never sends outside a
 * tick. Removing a context drops its pending work, and a late completion
 * cannot restart it. The shared timer exists only while at least one context
 * is registered. The clock and image port are injected, so this module stays
 * free of SDK and runtime-specific APIs.
 */

export type SchedulerClock = {
  setInterval: (handler: () => void, intervalMs: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
};

export type SendImage = (context: string, image: string) => Promise<void>;

export type RenderFrame = (context: string, phase: number) => string;

export type FrameSchedulerOptions = {
  clock: SchedulerClock;
  sendImage: SendImage;
  renderFrame: RenderFrame;
};

const TICK_MS = 250;

type ContextState = {
  active: boolean;
  desiredImage: string | null;
  lastSentImage: string | null;
  lastStartedAt: number;
  inFlight: boolean;
};

export class FrameScheduler {
  private readonly contexts = new Map<string, ContextState>();
  private readonly clock: SchedulerClock;
  private readonly sendImage: SendImage;
  private readonly renderFrame: RenderFrame;
  private phase = 0;
  private timer: unknown = null;

  constructor(options: FrameSchedulerOptions) {
    this.clock = options.clock;
    this.sendImage = options.sendImage;
    this.renderFrame = options.renderFrame;
  }

  addContext(context: string): void {
    if (this.contexts.has(context)) {
      return;
    }
    const state: ContextState = {
      active: true,
      desiredImage: null,
      lastSentImage: null,
      lastStartedAt: Number.NEGATIVE_INFINITY,
      inFlight: false,
    };
    this.contexts.set(context, state);
    this.ensureTimer();
    // The first render is immediate; later renders wait for this key's own
    // 250 ms boundary.
    this.start(context, state, this.renderFrame(context, this.phase));
  }

  removeContext(context: string): void {
    const state = this.contexts.get(context);
    if (state === undefined) {
      return;
    }
    state.active = false;
    this.contexts.delete(context);
    if (this.contexts.size === 0) {
      this.stopTimer();
    }
  }

  stop(): void {
    this.stopTimer();
    for (const state of this.contexts.values()) {
      state.active = false;
    }
    this.contexts.clear();
  }

  private ensureTimer(): void {
    if (this.timer === null) {
      this.timer = this.clock.setInterval(this.tick, TICK_MS);
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private readonly tick = (): void => {
    this.phase += 1;
    const now = this.clock.now();
    for (const [context, state] of this.contexts) {
      if (!state.active) {
        continue;
      }
      const desired = this.renderFrame(context, this.phase);
      // Identical frames are suppressed; anything newer replaces the pending
      // value outright — there is deliberately no queue.
      state.desiredImage = desired === state.lastSentImage ? null : desired;
      if (state.inFlight || state.desiredImage === null) {
        continue;
      }
      if (now - state.lastStartedAt < TICK_MS) {
        continue;
      }
      this.start(context, state, state.desiredImage);
    }
  };

  private start(context: string, state: ContextState, image: string): void {
    state.inFlight = true;
    state.lastStartedAt = this.clock.now();
    state.lastSentImage = image;
    state.desiredImage = null;
    // Completion only clears inFlight; sends happen exclusively at the
    // immediate first render or inside a tick. A rejection is swallowed the
    // same way: the frame counts as attempted and is never retried out of
    // band.
    Promise.resolve(this.sendImage(context, image)).then(
      () => {
        state.inFlight = false;
      },
      () => {
        state.inFlight = false;
      },
    );
  }
}
