import { describe, expect, test } from "bun:test";
import { type AppearInfo, SessionGridController } from "../src/plugin/controller";
import type { LayoutSettingsV1 } from "../src/plugin/layout";
import type { SnapshotView } from "../src/plugin/snapshot-reader";
import type { ProjectedSession } from "../src/protocol";

const TICK_MS = 125;
const POLL_MS = 250;

const session = (logicalSlot: number, overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: `session-${logicalSlot}`,
  status: "idle",
  title: `Slot ${logicalSlot}`,
  project: "stream-deck-agents",
  descendantCount: 0,
  logicalSlot,
  ghosttyTerminalId: null,
  model: null,
  originKind: null,
  originRef: null,
  originSubagent: false,
  unreadSince: null,
  statusSince: null,
  activityLine: null,
  transcriptPath: null,
  originParentRef: null,
  ...overrides,
});

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);

const sessionsAt = (...slots: number[]): ProjectedSession[] => slots.map((slot) => session(slot));

const healthyView = (sessions: ProjectedSession[]): SnapshotView => ({
  snapshot: { schemaVersion: 2, health: { status: "ok" }, sessions, agents: null },
  degraded: false,
});

const settings = (overflowLatched: boolean, currentPage: number): LayoutSettingsV1 => ({
  schemaVersion: 1,
  overflowLatched,
  currentPage,
});

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

class FakeSnapshotPort {
  view: SnapshotView = healthyView([]);
  reads = 0;

  readonly read = (): SnapshotView => {
    this.reads += 1;
    return this.view;
  };
}

class FakeSettingsPort {
  stored: unknown = settings(false, 0);
  /** Number of getGlobalSettings calls that reject before reads succeed. */
  failures = 0;
  attempts = 0;
  readonly writes: LayoutSettingsV1[] = [];

  readonly get = (): Promise<unknown> => {
    this.attempts += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error("settings_ipc_failure"));
    }
    return Promise.resolve(this.stored);
  };

  readonly set = (value: LayoutSettingsV1): Promise<void> => {
    this.writes.push(value);
    return Promise.resolve();
  };
}

type Start = { context: string; image: string };

class FakeImagePort {
  readonly starts: Start[] = [];
  private readonly pendingResolutions: Array<() => void> = [];
  private readonly autoResolve: boolean;

  constructor(autoResolve: boolean) {
    this.autoResolve = autoResolve;
  }

  readonly send = (context: string, image: string): Promise<void> => {
    this.starts.push({ context, image });
    if (this.autoResolve) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pendingResolutions.push(resolve);
    });
  };

  resolvePending(): void {
    for (const resolve of this.pendingResolutions.splice(0)) {
      resolve();
    }
  }
}

class FakeActivationPort {
  readonly sessionIds: string[] = [];
  failure: Error | null = null;

  readonly activate = (sessionId: string): Promise<void> => {
    this.sessionIds.push(sessionId);
    return this.failure === null ? Promise.resolve() : Promise.reject(this.failure);
  };
}

type AckCall = { provider: string; sessionId: string };

class FakeAckPort {
  readonly calls: AckCall[] = [];
  failure: Error | null = null;

  readonly ack = (provider: string, sessionId: string): Promise<void> => {
    this.calls.push({ provider, sessionId });
    return this.failure === null ? Promise.resolve() : Promise.reject(this.failure);
  };
}

class FakeAlertPort {
  readonly contexts: string[] = [];
  failure: Error | null = null;

  readonly show = (context: string): Promise<void> => {
    this.contexts.push(context);
    return this.failure === null ? Promise.resolve() : Promise.reject(this.failure);
  };
}

type Harness = {
  controller: SessionGridController;
  clock: FakeClock;
  snapshot: FakeSnapshotPort;
  settingsPort: FakeSettingsPort;
  images: FakeImagePort;
  activation: FakeActivationPort;
  claudeActivation: FakeActivationPort;
  kimiActivation: FakeActivationPort;
  paseoActivation: FakeActivationPort;
  acks: FakeAckPort;
  alerts: FakeAlertPort;
};

const makeController = (
  options: { autoResolve?: boolean; stored?: unknown; view?: SnapshotView; settingsFailures?: number } = {},
): Harness => {
  const clock = new FakeClock();
  const snapshot = new FakeSnapshotPort();
  const settingsPort = new FakeSettingsPort();
  const images = new FakeImagePort(options.autoResolve ?? true);
  const activation = new FakeActivationPort();
  const claudeActivation = new FakeActivationPort();
  const kimiActivation = new FakeActivationPort();
  const paseoActivation = new FakeActivationPort();
  const acks = new FakeAckPort();
  const alerts = new FakeAlertPort();
  if (options.stored !== undefined) {
    settingsPort.stored = options.stored;
  }
  if (options.view !== undefined) {
    snapshot.view = options.view;
  }
  settingsPort.failures = options.settingsFailures ?? 0;
  const controller = new SessionGridController({
    readSnapshot: snapshot.read,
    getGlobalSettings: settingsPort.get,
    setGlobalSettings: settingsPort.set,
    setImage: images.send,
    activateCodexSession: activation.activate,
    activateClaudeSession: claudeActivation.activate,
    activateKimiSession: kimiActivation.activate,
    activatePaseoSession: paseoActivation.activate,
    ackSession: acks.ack,
    showAlert: alerts.show,
    clock,
  });
  return {
    controller,
    clock,
    snapshot,
    settingsPort,
    images,
    activation,
    claudeActivation,
    kimiActivation,
    paseoActivation,
    acks,
    alerts,
  };
};

const appear = (context: string, row: number, column: number, overrides: Partial<AppearInfo> = {}): AppearInfo => ({
  context,
  deviceId: "device-1",
  device: { columns: 5, rows: 3 },
  controller: "Keypad",
  coordinates: { row, column },
  ...overrides,
});

const startsFor = (port: FakeImagePort, context: string): Start[] =>
  port.starts.filter((start) => start.context === context);

const lastImageFor = (port: FakeImagePort, context: string): string => {
  const starts = startsFor(port, context);
  if (starts.length === 0) {
    throw new Error(`no image sent to ${context}`);
  }
  return decodeURIComponent(starts[starts.length - 1]!.image);
};

const fillGrid = async (controller: SessionGridController): Promise<string[]> => {
  const contexts: string[] = [];
  for (let index = 0; index < 15; index++) {
    const context = `ctx-${index}`;
    contexts.push(context);
    await controller.willAppear(appear(context, Math.floor(index / 5), index % 5));
  }
  return contexts;
};

describe("SessionGridController", () => {
  test("the first valid willAppear reads the snapshot and starts exactly one 250 ms poller", async () => {
    const { controller, clock, snapshot } = makeController({
      view: healthyView(sessionsAt(1, 2, 3)),
    });

    await controller.willAppear(appear("ctx-a", 0, 0));
    expect(snapshot.reads).toBe(1);
    // One scheduler animation clock plus exactly one snapshot poller.
    expect(clock.intervalCalls).toEqual([TICK_MS, POLL_MS]);
    expect(clock.activeIntervalCount).toBe(2);

    // Later contexts share both timers; no per-context pollers appear.
    await controller.willAppear(appear("ctx-b", 0, 1));
    await controller.willAppear(appear("ctx-c", 0, 2));
    expect(clock.intervalCalls).toEqual([TICK_MS, POLL_MS]);

    await clock.advance(1000);
    // One initial read plus one read per 250 ms poll tick.
    expect(snapshot.reads).toBe(5);
  });

  test("every appearing context immediately renders the current cached model", async () => {
    const { controller, snapshot, images } = makeController({
      view: healthyView([session(1, { title: "Alpha One" }), session(2, { title: "Beta Two" })]),
    });

    await controller.willAppear(appear("ctx-a", 0, 0));
    expect(lastImageFor(images, "ctx-a")).toContain("Alpha One");

    await controller.willAppear(appear("ctx-b", 0, 1));
    // The late context renders from cache: no new snapshot read, no tick wait.
    expect(snapshot.reads).toBe(1);
    expect(lastImageFor(images, "ctx-b")).toContain("Beta Two");
  });

  test("coordinates map to models row-major with index = row * 5 + column", async () => {
    const { controller, images } = makeController({
      view: healthyView(sessionsAt(...range(1, 15))),
    });

    await controller.willAppear(appear("ctx-corner", 2, 4));
    expect(lastImageFor(images, "ctx-corner")).toContain("Slot 15");

    await controller.willAppear(appear("ctx-mid", 1, 2));
    expect(lastImageFor(images, "ctx-mid")).toContain("Slot 8");
  });

  test("the last key renders NEXT once overflow latches", async () => {
    const { controller, images } = makeController({
      view: healthyView(sessionsAt(...range(1, 16))),
    });

    await controller.willAppear(appear("ctx-last", 2, 4));
    const image = lastImageFor(images, "ctx-last");
    expect(image).toContain("NEXT");
    expect(image).toContain("1/2");
  });

  test("systemDidWakeUp re-pushes every visible tile even when frames are unchanged", async () => {
    const { controller, clock, images, snapshot } = makeController({
      view: healthyView(sessionsAt(1, 2, 3)),
    });
    const contexts = await fillGrid(controller);
    await clock.advance(2000);
    // Static frames are dedup-suppressed: each key saw only its first render.
    for (const context of contexts) {
      expect(startsFor(images, context).length).toBe(1);
    }
    const readsBefore = snapshot.reads;

    controller.systemDidWakeUp();

    // The wake re-reads the snapshot and immediately re-sends every key, so a
    // device that lost its images while asleep converges without an app
    // restart.
    expect(snapshot.reads).toBe(readsBefore + 1);
    for (const context of contexts) {
      expect(startsFor(images, context).length).toBe(2);
    }
  });

  test("systemDidWakeUp with no visible keys is a no-op", () => {
    const { controller, clock, images } = makeController();

    controller.systemDidWakeUp();

    expect(images.starts).toEqual([]);
    expect(clock.activeIntervalCount).toBe(0);
  });

  test("systemDidWakeUp before settings ever loaded converges through bootstrap on fresh state", async () => {
    // A wake can arrive while every earlier appearance failed its settings
    // load. The refresh is skipped then, but reconcileSupport bootstraps the
    // load and convergeGrid reads the post-wake snapshot — the tiles must not
    // be stuck on state cached before the sleep.
    const { controller, snapshot, images } = makeController({
      settingsFailures: 1,
      view: healthyView(sessionsAt(1)),
    });
    await controller.willAppear(appear("ctx-a", 0, 0));
    // The settings load rejected: nothing rendered, no snapshot read yet.
    expect(images.starts).toEqual([]);
    expect(snapshot.reads).toBe(0);

    // The world moved on while the machine slept.
    snapshot.view = healthyView(sessionsAt(9));
    controller.systemDidWakeUp();
    await flushMicrotasks();

    expect(snapshot.reads).toBeGreaterThan(0);
    expect(lastImageFor(images, "ctx-a")).toContain("Slot 9");
  });

  test("a second connected device switches every key to the unsupported-layout treatment", async () => {
    const { controller, clock, snapshot, images } = makeController({
      view: healthyView(sessionsAt(1)),
    });
    await controller.willAppear(appear("ctx-a", 0, 0));
    expect(lastImageFor(images, "ctx-a")).toContain("Slot 1");

    controller.deviceDidConnect("device-2", { columns: 5, rows: 3 });
    const readsAtConnect = snapshot.reads;
    await clock.advance(250);
    const unsupported = lastImageFor(images, "ctx-a");
    expect(unsupported).toContain("UNSUPPORTED");
    expect(unsupported).not.toContain("Slot 1");

    // Polling stops while the layout is unsupported.
    await clock.advance(750);
    expect(snapshot.reads).toBe(readsAtConnect);

    // Recovery when the extra device leaves.
    controller.deviceDidDisconnect("device-2");
    await clock.advance(250);
    expect(lastImageFor(images, "ctx-a")).toContain("Slot 1");
  });

  test("a device that is not 5x3 never reads the snapshot or starts the poller", async () => {
    const { controller, clock, snapshot, images } = makeController({
      view: healthyView(sessionsAt(1)),
    });

    await controller.willAppear(appear("ctx-a", 0, 0, { device: { columns: 8, rows: 4 } }));
    expect(snapshot.reads).toBe(0);
    // Only the scheduler's animation clock exists; there is no snapshot poller.
    expect(clock.intervalCalls).toEqual([TICK_MS]);
    expect(lastImageFor(images, "ctx-a")).toContain("UNSUPPORTED");

    await clock.advance(1000);
    expect(snapshot.reads).toBe(0);
    // The static treatment dedupes to exactly one send.
    expect(startsFor(images, "ctx-a")).toHaveLength(1);
  });

  test("a non-keypad or coordinate-less context renders the unsupported treatment", async () => {
    const dial = makeController({ view: healthyView(sessionsAt(1)) });
    await dial.controller.willAppear(appear("ctx-dial", 0, 2, { controller: "Encoder" }));
    expect(dial.snapshot.reads).toBe(0);
    expect(lastImageFor(dial.images, "ctx-dial")).toContain("UNSUPPORTED");

    const multi = makeController({ view: healthyView(sessionsAt(1)) });
    await multi.controller.willAppear(appear("ctx-multi", 0, 0, { coordinates: undefined }));
    expect(multi.snapshot.reads).toBe(0);
    expect(lastImageFor(multi.images, "ctx-multi")).toContain("UNSUPPORTED");
  });

  test("a duplicate coordinate blanks the grid to the unsupported treatment until it disappears", async () => {
    const { controller, clock, snapshot, images } = makeController({
      view: healthyView(sessionsAt(1)),
    });
    await controller.willAppear(appear("ctx-a", 0, 0));
    expect(lastImageFor(images, "ctx-a")).toContain("Slot 1");

    await controller.willAppear(appear("ctx-dup", 0, 0));
    // The duplicate renders the treatment immediately; the original key never
    // mixes: its next frame is the treatment too, and polling has stopped.
    expect(lastImageFor(images, "ctx-dup")).toContain("UNSUPPORTED");
    const readsAtDuplicate = snapshot.reads;
    await clock.advance(250);
    expect(lastImageFor(images, "ctx-a")).toContain("UNSUPPORTED");
    expect(snapshot.reads).toBe(readsAtDuplicate);

    controller.willDisappear("ctx-dup");
    await clock.advance(250);
    expect(lastImageFor(images, "ctx-a")).toContain("Slot 1");
  });

  test("recovery into a supported grid bootstraps settings, snapshot, and polling", async () => {
    const { controller, clock, snapshot, images } = makeController({
      view: healthyView(sessionsAt(1)),
    });
    // A second device connects before any key appears, so the first
    // appearance is itself unsupported and nothing has loaded yet.
    controller.deviceDidConnect("device-2", { columns: 5, rows: 3 });
    await controller.willAppear(appear("ctx-a", 0, 0));
    expect(snapshot.reads).toBe(0);
    expect(lastImageFor(images, "ctx-a")).toContain("UNSUPPORTED");

    controller.deviceDidDisconnect("device-2");
    await flushMicrotasks();
    // The surviving context converges to the session model and the poller
    // starts without any further appearance.
    expect(snapshot.reads).toBe(1);
    await clock.advance(250);
    expect(lastImageFor(images, "ctx-a")).toContain("Slot 1");
    expect(snapshot.reads).toBe(2);
  });

  test("a settings-load rejection stays inside willAppear and the next event retries", async () => {
    const { controller, clock, snapshot, settingsPort, images } = makeController({
      settingsFailures: 1,
      view: healthyView(sessionsAt(1)),
    });

    // The rejection is contained: willAppear settles normally, and nothing is
    // read, written, or painted.
    await controller.willAppear(appear("ctx-a", 0, 0));
    expect(settingsPort.attempts).toBe(1);
    expect(snapshot.reads).toBe(0);
    expect(images.starts).toEqual([]);

    // The next lifecycle event retries the load and converges the grid.
    controller.deviceDidConnect("device-1", { columns: 5, rows: 3 });
    await flushMicrotasks();
    expect(settingsPort.attempts).toBe(2);
    expect(snapshot.reads).toBe(1);
    expect(lastImageFor(images, "ctx-a")).toContain("Slot 1");
    await clock.advance(250);
    expect(snapshot.reads).toBe(2);
  });

  test("a later successful appearance also converges contexts that hit the rejection", async () => {
    const { controller, settingsPort, images } = makeController({
      settingsFailures: 1,
      view: healthyView(sessionsAt(1, 2)),
    });

    // The first appearance hits the rejecting load; the second succeeds.
    await controller.willAppear(appear("ctx-a", 0, 0));
    await controller.willAppear(appear("ctx-b", 0, 1));
    expect(settingsPort.attempts).toBe(2);

    // Both contexts paint the cached model with no further lifecycle event.
    expect(lastImageFor(images, "ctx-b")).toContain("Slot 2");
    expect(lastImageFor(images, "ctx-a")).toContain("Slot 1");
  });

  test("more than fifteen contexts is an unsupported layout and never mixes treatments", async () => {
    const { controller, clock, images } = makeController({
      view: healthyView(sessionsAt(...range(1, 15))),
    });
    const contexts = await fillGrid(controller);
    expect(lastImageFor(images, "ctx-14")).toContain("Slot 15");

    // A sixteenth keypad slot cannot exist on the 5x3 grid, so it necessarily
    // arrives off-grid.
    await controller.willAppear(appear("ctx-extra", 3, 0));
    expect(lastImageFor(images, "ctx-extra")).toContain("UNSUPPORTED");
    await clock.advance(250);
    for (const context of contexts) {
      expect(lastImageFor(images, context)).toContain("UNSUPPORTED");
    }

    controller.willDisappear("ctx-extra");
    await clock.advance(250);
    expect(lastImageFor(images, "ctx-0")).toContain("Slot 1");
    expect(lastImageFor(images, "ctx-14")).toContain("Slot 15");
  });

  test("willDisappear unregisters the context and cancels its pending frames", async () => {
    const { controller, clock, images } = makeController({
      autoResolve: false,
      view: healthyView([session(1, { status: "working" }), session(2, { status: "working" })]),
    });
    await controller.willAppear(appear("ctx-a", 0, 0));
    await controller.willAppear(appear("ctx-b", 0, 1));

    controller.willDisappear("ctx-a");
    images.resolvePending();
    await flushMicrotasks();
    await clock.advance(1000);

    // The removed context keeps only its in-flight first frame; the surviving
    // animated context keeps rendering.
    expect(startsFor(images, "ctx-a")).toHaveLength(1);
    expect(startsFor(images, "ctx-b").length).toBeGreaterThan(1);
  });

  test("removing the final context stops snapshot polling and the animation clock", async () => {
    const { controller, clock, snapshot, images } = makeController({
      view: healthyView([session(1, { status: "working" })]),
    });
    await controller.willAppear(appear("ctx-a", 0, 0));
    await clock.advance(750);
    expect(snapshot.reads).toBeGreaterThan(1);
    expect(startsFor(images, "ctx-a").length).toBeGreaterThan(1);

    controller.willDisappear("ctx-a");
    expect(clock.activeIntervalCount).toBe(0);

    const reads = snapshot.reads;
    const starts = images.starts.length;
    await clock.advance(1000);
    expect(snapshot.reads).toBe(reads);
    expect(images.starts.length).toBe(starts);
  });

  test("device disconnect clears every context for that device", async () => {
    const { controller, clock, snapshot, images } = makeController({
      view: healthyView([session(1, { status: "working" }), session(2, { status: "working" })]),
    });
    await controller.willAppear(appear("ctx-a", 0, 0));
    await controller.willAppear(appear("ctx-b", 0, 1));

    controller.deviceDidDisconnect("device-1");
    expect(clock.activeIntervalCount).toBe(0);

    const reads = snapshot.reads;
    const starts = images.starts.length;
    await clock.advance(1000);
    expect(snapshot.reads).toBe(reads);
    expect(images.starts.length).toBe(starts);
  });

  test("key down routes full provider IDs and ignores every other key model", async () => {
    const fullCodexSessionId = "01900000-0000-7000-8000-000000000001";
    const stableClaudeTerminalId = "ghostty-terminal-id";
    const fullKimiSessionId = "session_360af549-9129-45c6-af08-08c74ffe25a0";
    const { controller, activation, claudeActivation, kimiActivation, alerts, settingsPort } = makeController({
      view: healthyView([
        session(1, {
          provider: "codex",
          sessionId: fullCodexSessionId,
          title: null,
          project: null,
        }),
        session(2, {
          provider: "claude",
          sessionId: "claude-session-id",
          ghosttyTerminalId: stableClaudeTerminalId,
        }),
        session(3, { provider: "kimi", sessionId: fullKimiSessionId }),
      ]),
    });
    await controller.willAppear(appear("ctx-codex", 0, 0));
    await controller.willAppear(appear("ctx-claude", 0, 1));
    await controller.willAppear(appear("ctx-kimi", 0, 2));
    await controller.willAppear(appear("ctx-blank", 0, 3));

    await controller.keyDown("ctx-codex");
    await controller.keyDown("ctx-claude");
    await controller.keyDown("ctx-kimi");
    await controller.keyDown("ctx-blank");
    await controller.keyDown("missing-context");
    controller.deviceDidConnect("device-2", { columns: 5, rows: 3 });
    await controller.keyDown("ctx-codex");
    controller.deviceDidDisconnect("device-2");
    controller.willDisappear("ctx-codex");
    await controller.keyDown("ctx-codex");

    expect(activation.sessionIds).toEqual([fullCodexSessionId]);
    expect(claudeActivation.sessionIds).toEqual([stableClaudeTerminalId]);
    expect(kimiActivation.sessionIds).toEqual([fullKimiSessionId]);
    expect(alerts.contexts).toEqual([]);
    expect(settingsPort.writes).toEqual([]);
  });

  test("a bound Claude tile activates its stable terminal ID, not its session ID", async () => {
    const { controller, claudeActivation, alerts } = makeController({
      view: healthyView([
        session(1, {
          provider: "claude",
          sessionId: "claude-session-id",
          ghosttyTerminalId: "ghostty-terminal-id",
        }),
      ]),
    });
    await controller.willAppear(appear("ctx-claude", 0, 0));

    await controller.keyDown("ctx-claude");

    expect(claudeActivation.sessionIds).toEqual(["ghostty-terminal-id"]);
    expect(alerts.contexts).toEqual([]);
  });

  test("an unbound Claude tile alerts without invoking any activator", async () => {
    const harness = makeController({ view: healthyView([session(1)]) });
    await harness.controller.willAppear(appear("ctx-claude", 0, 0));

    await harness.controller.keyDown("ctx-claude");

    expect(harness.claudeActivation.sessionIds).toEqual([]);
    expect(harness.activation.sessionIds).toEqual([]);
    expect(harness.kimiActivation.sessionIds).toEqual([]);
    expect(harness.alerts.contexts).toEqual(["ctx-claude"]);
  });

  test.each(["pi", "omp", "zcode", "deepseek", "grok", "qwen", "evener"] as const)(
    "a %s tile press alerts without invoking any activator",
    async (provider) => {
      const harness = makeController({ view: healthyView([session(1, { provider })]) });
      await harness.controller.willAppear(appear("ctx-new", 0, 0));

      await harness.controller.keyDown("ctx-new");

      expect(harness.claudeActivation.sessionIds).toEqual([]);
      expect(harness.activation.sessionIds).toEqual([]);
      expect(harness.kimiActivation.sessionIds).toEqual([]);
      expect(harness.alerts.contexts).toEqual(["ctx-new"]);
    },
  );

  test("pressing a paseo-origin tile routes to paseo activation and acks the session", async () => {
    const harness = makeController({
      view: healthyView([
        session(1, {
          provider: "kimi",
          sessionId: "session_1",
          originKind: "paseo",
          originRef: "agent-1",
        }),
      ]),
    });
    await harness.controller.willAppear(appear("ctx-paseo", 0, 0));

    await harness.controller.keyDown("ctx-paseo");

    expect(harness.paseoActivation.sessionIds).toEqual(["agent-1"]);
    expect(harness.acks.calls).toEqual([{ provider: "kimi", sessionId: "session_1" }]);
    expect(harness.kimiActivation.sessionIds).toEqual([]);
    expect(harness.alerts.contexts).toEqual([]);
  });

  test("pressing any session tile acks even when activation is unavailable", async () => {
    const harness = makeController({ view: healthyView([session(1, { provider: "zcode", sessionId: "z-1" })]) });
    await harness.controller.willAppear(appear("ctx-zcode", 0, 0));

    await harness.controller.keyDown("ctx-zcode");

    expect(harness.acks.calls).toEqual([{ provider: "zcode", sessionId: "z-1" }]);
    expect(harness.alerts.contexts).toEqual(["ctx-zcode"]);
  });

  test("a failed ack never alerts and does not block the activation", async () => {
    const harness = makeController({
      view: healthyView([session(1, { provider: "codex", sessionId: "codex-1" })]),
    });
    harness.acks.failure = new Error("ack failed");
    await harness.controller.willAppear(appear("ctx-codex", 0, 0));

    await harness.controller.keyDown("ctx-codex");
    await flushMicrotasks();

    expect(harness.acks.calls).toEqual([{ provider: "codex", sessionId: "codex-1" }]);
    expect(harness.activation.sessionIds).toEqual(["codex-1"]);
    expect(harness.alerts.contexts).toEqual([]);
  });

  test("paseo origin with null ref falls back to provider routing", async () => {
    const harness = makeController({
      view: healthyView([
        session(1, {
          provider: "codex",
          sessionId: "codex-1",
          originKind: "paseo",
          originRef: null,
        }),
      ]),
    });
    await harness.controller.willAppear(appear("ctx-codex", 0, 0));

    await harness.controller.keyDown("ctx-codex");

    expect(harness.activation.sessionIds).toEqual(["codex-1"]);
    expect(harness.paseoActivation.sessionIds).toEqual([]);
    expect(harness.acks.calls).toEqual([{ provider: "codex", sessionId: "codex-1" }]);
  });

  test("a rejected Claude focus alerts once with no retry", async () => {
    const harness = makeController({
      view: healthyView([session(1, { ghosttyTerminalId: "stale-terminal" })]),
    });
    harness.claudeActivation.failure = new Error("missing terminal");
    await harness.controller.willAppear(appear("ctx-claude", 0, 0));

    await harness.controller.keyDown("ctx-claude");

    expect(harness.claudeActivation.sessionIds).toEqual(["stale-terminal"]);
    expect(harness.alerts.contexts).toEqual(["ctx-claude"]);
  });

  test("a rejected Claude focus contains an alert rejection", async () => {
    const harness = makeController({
      view: healthyView([session(1, { ghosttyTerminalId: "stale-terminal" })]),
    });
    harness.claudeActivation.failure = new Error("missing terminal");
    harness.alerts.failure = new Error("alert failed");
    await harness.controller.willAppear(appear("ctx-claude", 0, 0));

    await harness.controller.keyDown("ctx-claude");

    expect(harness.claudeActivation.sessionIds).toEqual(["stale-terminal"]);
    expect(harness.alerts.contexts).toEqual(["ctx-claude"]);
  });

  test("a degraded bound Claude tile remains activatable", async () => {
    const view = healthyView([session(1, { ghosttyTerminalId: "exact-terminal" })]);
    view.degraded = true;
    const harness = makeController({ view });
    await harness.controller.willAppear(appear("ctx-claude", 0, 0));

    await harness.controller.keyDown("ctx-claude");

    expect(harness.claudeActivation.sessionIds).toEqual(["exact-terminal"]);
  });

  test("a degraded last-good Codex tile remains activatable", async () => {
    const view = healthyView([session(1, { provider: "codex", sessionId: "degraded-thread" })]);
    view.degraded = true;
    const { controller, activation } = makeController({ view });
    await controller.willAppear(appear("ctx-codex", 0, 0));

    await controller.keyDown("ctx-codex");

    expect(activation.sessionIds).toEqual(["degraded-thread"]);
  });

  test("repeated Codex presses issue repeated activation requests", async () => {
    const { controller, activation } = makeController({
      view: healthyView([session(1, { provider: "codex", sessionId: "repeat-thread" })]),
    });
    await controller.willAppear(appear("ctx-codex", 0, 0));

    await controller.keyDown("ctx-codex");
    await controller.keyDown("ctx-codex");

    expect(activation.sessionIds).toEqual(["repeat-thread", "repeat-thread"]);
  });

  test("repeated Claude presses issue repeated activation requests", async () => {
    const { controller, claudeActivation } = makeController({
      view: healthyView([session(1, { ghosttyTerminalId: "repeat-terminal" })]),
    });
    await controller.willAppear(appear("ctx-claude", 0, 0));

    await controller.keyDown("ctx-claude");
    await controller.keyDown("ctx-claude");

    expect(claudeActivation.sessionIds).toEqual(["repeat-terminal", "repeat-terminal"]);
  });

  test("key down on NEXT advances the page and persists settings", async () => {
    const { controller, clock, settingsPort, images } = makeController({
      stored: settings(true, 0),
      view: healthyView(sessionsAt(...range(1, 16))),
    });
    await fillGrid(controller);
    expect(settingsPort.writes).toEqual([]);
    expect(lastImageFor(images, "ctx-0")).toContain("Slot 1");

    await controller.keyDown("ctx-14");
    expect(settingsPort.writes).toEqual([settings(true, 1)]);
    await clock.advance(250);
    expect(lastImageFor(images, "ctx-0")).toContain("Slot 15");
    expect(lastImageFor(images, "ctx-14")).toContain("2/2");

    // A second press wraps to the first page and persists again.
    await controller.keyDown("ctx-14");
    expect(settingsPort.writes).toEqual([settings(true, 1), settings(true, 0)]);
    await clock.advance(250);
    expect(lastImageFor(images, "ctx-0")).toContain("Slot 1");
  });

  test("after NEXT, key down activates the Claude target on the current page", async () => {
    const sessions = range(1, 16).map((slot) => session(slot, { ghosttyTerminalId: `terminal-${slot}` }));
    const { controller, claudeActivation, settingsPort } = makeController({
      stored: settings(true, 0),
      view: healthyView(sessions),
    });
    await fillGrid(controller);

    await controller.keyDown("ctx-0");
    await controller.keyDown("ctx-14");
    await controller.keyDown("ctx-0");

    expect(settingsPort.writes).toEqual([settings(true, 1)]);
    expect(claudeActivation.sessionIds).toEqual(["terminal-1", "terminal-15"]);
  });

  test("a reflowed key activates its current Claude owner, never its removed owner", async () => {
    const { controller, clock, snapshot, claudeActivation } = makeController({
      view: healthyView([
        session(1, { sessionId: "removed-session", ghosttyTerminalId: "removed-terminal" }),
        session(2, { sessionId: "current-session", ghosttyTerminalId: "current-terminal" }),
      ]),
    });
    await controller.willAppear(appear("ctx-claude", 0, 0));

    snapshot.view = healthyView([session(2, { sessionId: "current-session", ghosttyTerminalId: "current-terminal" })]);
    await clock.advance(POLL_MS);
    await controller.keyDown("ctx-claude");

    expect(claudeActivation.sessionIds).toEqual(["current-terminal"]);
  });

  test("activation failure shows one alert and contains alert failure", async () => {
    const { controller, activation, alerts, settingsPort } = makeController({
      view: healthyView([session(1, { provider: "codex", sessionId: "failing-thread" })]),
    });
    await controller.willAppear(appear("ctx-codex", 0, 0));
    activation.failure = new Error("launch failed");

    await controller.keyDown("ctx-codex");
    alerts.failure = new Error("alert failed");
    await controller.keyDown("ctx-codex");

    expect(activation.sessionIds).toEqual(["failing-thread", "failing-thread"]);
    expect(alerts.contexts).toEqual(["ctx-codex", "ctx-codex"]);
    expect(settingsPort.writes).toEqual([]);
  });

  test("page clamping persists settings once and ordinary refreshes never rewrite them", async () => {
    const { controller, clock, snapshot, settingsPort } = makeController({
      stored: settings(true, 5),
      view: healthyView(sessionsAt(...range(1, 16))),
    });
    await controller.willAppear(appear("ctx-a", 0, 0));
    // Page 5 does not exist; the nearest earlier non-empty page is 1.
    expect(settingsPort.writes).toEqual([settings(true, 1)]);

    // Repeated polls of an unchanged snapshot never rewrite the settings.
    await clock.advance(1000);
    expect(settingsPort.writes).toHaveLength(1);

    // A changed snapshot that keeps the same paging writes nothing either.
    snapshot.view = healthyView(sessionsAt(...range(1, 17)));
    await clock.advance(500);
    expect(snapshot.reads).toBeGreaterThan(1);
    expect(settingsPort.writes).toHaveLength(1);
  });

  test("invalid stored settings are normalized and persisted exactly once", async () => {
    const { controller, clock, settingsPort } = makeController({
      stored: { bogus: true },
      view: healthyView(sessionsAt(1, 2, 3)),
    });
    await controller.willAppear(appear("ctx-a", 0, 0));
    expect(settingsPort.writes).toEqual([settings(false, 0)]);

    await clock.advance(1000);
    expect(settingsPort.writes).toHaveLength(1);
  });
});
