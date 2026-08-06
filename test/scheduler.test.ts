import { describe, expect, test } from "bun:test";
import { FrameScheduler } from "../src/plugin/scheduler";

const TICK_MS = 250;

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve();
  }
};

type ScheduledInterval = { handler: () => void; ms: number; nextFire: number };

class FakeClock {
  private currentTime = 0;
  readonly intervalCalls: number[] = [];
  private readonly intervals = new Map<number, ScheduledInterval>();
  private nextId = 0;

  readonly now = (): number => this.currentTime;

  readonly setInterval = (handler: () => void, ms: number): number => {
    this.intervalCalls.push(ms);
    const id = ++this.nextId;
    this.intervals.set(id, { handler, ms, nextFire: this.currentTime + ms });
    return id;
  };

  readonly clearInterval = (handle: unknown): void => {
    this.intervals.delete(handle as number);
  };

  get activeIntervalCount(): number {
    return this.intervals.size;
  }

  async advance(ms: number): Promise<void> {
    // A real event loop drains microtasks long before a timer fires, so flush
    // before moving fake time as well as after every batch of due handlers.
    await flushMicrotasks();
    const target = this.currentTime + ms;
    for (;;) {
      let next = Number.POSITIVE_INFINITY;
      for (const interval of this.intervals.values()) {
        next = Math.min(next, interval.nextFire);
      }
      if (next > target) {
        break;
      }
      this.currentTime = next;
      for (const interval of this.intervals.values()) {
        if (interval.nextFire === next) {
          interval.nextFire += interval.ms;
          interval.handler();
        }
      }
      await flushMicrotasks();
    }
    this.currentTime = target;
    await flushMicrotasks();
  }
}

type Start = { context: string; image: string; at: number };

class FakeImagePort {
  readonly starts: Start[] = [];
  private readonly pendingResolutions: Array<() => void> = [];

  constructor(
    private readonly clock: FakeClock,
    private readonly autoResolve: boolean,
  ) {}

  readonly send = (context: string, image: string): Promise<void> => {
    this.starts.push({ context, image, at: this.clock.now() });
    if (this.autoResolve) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pendingResolutions.push(resolve);
    });
  };

  resolvePending(): void {
    const resolutions = this.pendingResolutions.splice(0);
    for (const resolve of resolutions) {
      resolve();
    }
  }
}

const startsFor = (port: FakeImagePort, context: string): Start[] =>
  port.starts.filter((start) => start.context === context);

const startTimesFor = (port: FakeImagePort, context: string): number[] =>
  startsFor(port, context).map((start) => start.at);

describe("FrameScheduler", () => {
  test("starts at most one update per context per 250 ms tick", async () => {
    const clock = new FakeClock();
    const port = new FakeImagePort(clock, true);
    const scheduler = new FrameScheduler({
      clock,
      sendImage: port.send,
      renderFrame: (context, phase) => `${context}-frame-${phase}`,
    });
    // No timer exists before the first context registers.
    expect(clock.intervalCalls).toEqual([]);

    scheduler.addContext("a");
    scheduler.addContext("b");
    expect(clock.intervalCalls).toEqual([TICK_MS]);

    await clock.advance(2000);
    const seen = new Set<string>();
    for (const start of port.starts) {
      const key = `${start.context}@${start.at}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Immediate start at t=0 plus ticks at 250..2000: nine starts per context.
    expect(startsFor(port, "a")).toHaveLength(9);
    expect(startsFor(port, "b")).toHaveLength(9);
  });

  test("suppresses repeated identical frames", async () => {
    const clock = new FakeClock();
    const port = new FakeImagePort(clock, true);
    const scheduler = new FrameScheduler({
      clock,
      sendImage: port.send,
      renderFrame: () => "static-frame",
    });
    scheduler.addContext("a");
    await clock.advance(2000);
    expect(port.starts).toHaveLength(1);
    expect(port.starts[0]!.image).toBe("static-frame");
  });

  test("replaces the pending frame while in flight instead of queueing", async () => {
    const clock = new FakeClock();
    const port = new FakeImagePort(clock, false);
    const scheduler = new FrameScheduler({
      clock,
      sendImage: port.send,
      renderFrame: (context, phase) => `${context}-phase-${phase}`,
    });
    scheduler.addContext("a");
    expect(port.starts.map((start) => start.image)).toEqual(["a-phase-0"]);

    // Three ticks pass while the first send stays in flight: no parallel
    // starts, and each newer desired frame replaces the pending one.
    await clock.advance(250);
    await clock.advance(250);
    await clock.advance(250);
    expect(port.starts).toHaveLength(1);

    port.resolvePending();
    await flushMicrotasks();
    await clock.advance(250);

    // Exactly one follow-up start, carrying the frame current at that tick —
    // a queue would instead flush the oldest pending frame first.
    expect(port.starts).toHaveLength(2);
    expect(port.starts[1]!.image).toBe("a-phase-4");
  });

  test("removing a context discards pending work and late completion never restarts it", async () => {
    const clock = new FakeClock();
    const port = new FakeImagePort(clock, false);
    const renders: string[] = [];
    const scheduler = new FrameScheduler({
      clock,
      sendImage: port.send,
      renderFrame: (context, phase) => {
        renders.push(context);
        return `${context}-phase-${phase}`;
      },
    });
    scheduler.addContext("a");
    await clock.advance(250);
    scheduler.removeContext("a");
    // The last context's removal stops the shared timer.
    expect(clock.activeIntervalCount).toBe(0);
    const rendersAtRemoval = renders.length;

    port.resolvePending();
    await flushMicrotasks();
    await clock.advance(1000);

    expect(port.starts).toHaveLength(1);
    expect(renders).toHaveLength(rendersAtRemoval);

    // Re-registration is a fresh context with its own immediate first render.
    scheduler.addContext("a");
    expect(port.starts).toHaveLength(2);
    expect(port.starts[1]!.at).toBe(clock.now());
  });

  test("shares one timer across 14 animated contexts, each within four starts per second", async () => {
    const clock = new FakeClock();
    const port = new FakeImagePort(clock, true);
    const scheduler = new FrameScheduler({
      clock,
      sendImage: port.send,
      renderFrame: (context, phase) => `${context}:${phase}`,
    });
    const contexts = Array.from({ length: 14 }, (_, index) => `ctx-${index}`);
    for (const context of contexts) {
      scheduler.addContext(context);
    }
    expect(clock.intervalCalls).toEqual([TICK_MS]);
    expect(clock.activeIntervalCount).toBe(1);

    await clock.advance(4000);

    for (const context of contexts) {
      const times = startTimesFor(port, context);
      // Immediate start plus sixteen ticks of continuous animation.
      expect(times).toHaveLength(17);
      for (const at of times) {
        const inWindow = times.filter((time) => time >= at && time < at + 1000);
        expect(inWindow.length).toBeLessThanOrEqual(4);
      }
    }
  });

  test("renders the first frame immediately and the next at the key's own 250 ms boundary", async () => {
    const clock = new FakeClock();
    const port = new FakeImagePort(clock, true);
    const scheduler = new FrameScheduler({
      clock,
      sendImage: port.send,
      renderFrame: (context, phase) => `${context}#${phase}`,
    });

    scheduler.addContext("a");
    expect(startTimesFor(port, "a")).toEqual([0]);

    await clock.advance(100); // now = 100, no tick has fired
    scheduler.addContext("b");
    // The first render for b is immediate even mid-interval.
    expect(startTimesFor(port, "b")).toEqual([100]);

    await clock.advance(150); // tick fires at 250
    // a sits exactly on its boundary and starts; b is 150 ms past its last
    // start and must wait for its own per-key boundary.
    expect(startTimesFor(port, "a")).toEqual([0, 250]);
    expect(startTimesFor(port, "b")).toEqual([100]);

    await clock.advance(250); // tick fires at 500
    expect(startTimesFor(port, "b")).toEqual([100, 500]);
    // The waited start carries the current frame, not the obsolete one.
    expect(startsFor(port, "b")[1]!.image).toBe("b#2");
  });

  test("stop clears the timer and every context", async () => {
    const clock = new FakeClock();
    const port = new FakeImagePort(clock, true);
    const scheduler = new FrameScheduler({
      clock,
      sendImage: port.send,
      renderFrame: (context, phase) => `${context}#${phase}`,
    });
    scheduler.addContext("a");
    scheduler.addContext("b");
    scheduler.stop();
    expect(clock.activeIntervalCount).toBe(0);
    await clock.advance(1000);
    expect(port.starts).toHaveLength(2);
  });
});
