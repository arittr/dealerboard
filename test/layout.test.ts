import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceLayoutPage,
  DEFAULT_LAYOUT_SETTINGS,
  type KeyModel,
  type LayoutSettingsV1,
  reduceLayout,
  STRIP_GEOMETRY,
} from "../src/plugin/layout";
import { SnapshotCache, type SnapshotView } from "../src/plugin/snapshot-reader";
import type { ProjectedAgentNode, ProjectedSession, SessionSnapshotV2 } from "../src/protocol";

const session = (logicalSlot: number, overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: `session-${logicalSlot}`,
  status: "idle",
  title: `Session ${logicalSlot}`,
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
  lastEventAt: null,
  ...overrides,
});

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);

const sessionsAt = (...slots: number[]): ProjectedSession[] => slots.map((slot) => session(slot));

const healthySnapshot = (
  sessions: ProjectedSession[],
  agents: ProjectedAgentNode[] | null = null,
): SessionSnapshotV2 => ({
  schemaVersion: 2,
  health: { status: "ok" },
  sessions,
  agents,
});

const healthyView = (
  sessions: ProjectedSession[],
  degraded = false,
  agents: ProjectedAgentNode[] | null = null,
): SnapshotView => ({
  snapshot: healthySnapshot(sessions, agents),
  degraded,
});

const settings = (overflowLatched: boolean, currentPage: number): LayoutSettingsV1 => ({
  schemaVersion: 1,
  overflowLatched,
  currentPage,
});

const sessionKeyAt = (keys: KeyModel[], index: number): Extract<KeyModel, { kind: "session" }> => {
  const key = keys[index];
  if (key?.kind !== "session") {
    throw new Error(`expected a session model at key ${index}, got ${key?.kind ?? "nothing"}`);
  }
  return key;
};

const labelFor = (overrides: Partial<ProjectedSession>): string =>
  sessionKeyAt(reduceLayout(healthyView([session(1, overrides)]), DEFAULT_LAYOUT_SETTINGS).keys, 0).label;

describe("reduceLayout without overflow", () => {
  test("uses legacy sessions only when an additive native graph is present", () => {
    const legacy = session(1, { descendantCount: 1 });
    const native: ProjectedAgentNode = {
      provider: "claude",
      sessionId: "native-child",
      role: "subagent",
      lineage: "native",
      parent: { provider: "claude", sessionId: legacy.sessionId },
      status: "working",
      title: "Child",
      project: null,
      model: null,
      openedAt: "2026-08-26T05:00:00.000Z",
      statusSince: null,
      activityLine: null,
      unreadSince: null,
      logicalSlot: null,
      ghosttyTerminalId: null,
      transcriptPath: null,
      originKind: null,
      originRef: null,
      originSubagent: false,
      originParentRef: null,
      lastEventAt: null,
    };
    const result = reduceLayout(healthyView([legacy], false, [native]), DEFAULT_LAYOUT_SETTINGS);
    expect(result.keys.filter((key) => key.kind === "session")).toHaveLength(1);
    expect(sessionKeyAt(result.keys, 0).session).toMatchObject({ sessionId: legacy.sessionId, descendantCount: 1 });
  });

  test("packs sessions densely in slot order, filling gaps", () => {
    const result = reduceLayout(healthyView(sessionsAt(2, 5)), DEFAULT_LAYOUT_SETTINGS);
    expect(result.keys).toHaveLength(15);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(2);
    expect(sessionKeyAt(result.keys, 1).session.logicalSlot).toBe(5);
    for (let index = 2; index < 15; index++) {
      expect(result.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
  });

  test("maps up to fifteen sessions onto keys in rank order", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 15))), DEFAULT_LAYOUT_SETTINGS);
    expect(result.keys).toHaveLength(15);
    for (let index = 0; index < 15; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(false);
  });

  test("sorts sessions by logical slot defensively", () => {
    const result = reduceLayout(healthyView([session(7), session(1), session(3)]), DEFAULT_LAYOUT_SETTINGS);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(1);
    expect(sessionKeyAt(result.keys, 1).session.logicalSlot).toBe(3);
    expect(sessionKeyAt(result.keys, 2).session.logicalSlot).toBe(7);
  });

  test("shifts later ranks left on removal and right on insertion at a freed slot", () => {
    // Slot 3 has ended: the slot-4 and slot-5 tiles sit one key left.
    const afterEnd = reduceLayout(healthyView(sessionsAt(1, 2, 4, 5)), DEFAULT_LAYOUT_SETTINGS);
    expect(sessionKeyAt(afterEnd.keys, 1).session.logicalSlot).toBe(2);
    expect(sessionKeyAt(afterEnd.keys, 2).session.logicalSlot).toBe(4);
    expect(sessionKeyAt(afterEnd.keys, 3).session.logicalSlot).toBe(5);
    expect(afterEnd.keys[4]).toEqual({ kind: "blank", degraded: false });

    // A new session allocated the freed slot 3 inserts at rank 2, shifting
    // the slot-4 and slot-5 tiles one key right.
    const afterStart = reduceLayout(healthyView(sessionsAt(1, 2, 3, 4, 5)), DEFAULT_LAYOUT_SETTINGS);
    expect(sessionKeyAt(afterStart.keys, 2).session.logicalSlot).toBe(3);
    expect(sessionKeyAt(afterStart.keys, 3).session.logicalSlot).toBe(4);
    expect(sessionKeyAt(afterStart.keys, 4).session.logicalSlot).toBe(5);
  });

  test("does not latch overflow at fifteen live sessions", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 15))), DEFAULT_LAYOUT_SETTINGS);
    expect(sessionKeyAt(result.keys, 14).session.logicalSlot).toBe(15);
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(false);
  });
});

describe("reduceLayout overflow latch", () => {
  test("latches overflow when the live count exceeds fifteen", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 16))), DEFAULT_LAYOUT_SETTINGS);
    expect(result.keys).toHaveLength(15);
    for (let index = 0; index < 14; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    expect(result.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 2, degraded: false });
    expect(result.settings).toEqual(settings(true, 0));
    expect(result.dirty).toBe(true);
  });

  test("latches on count, not slot numbers: sparse high slots pack densely", () => {
    // Sixteen live sessions at sparse slots 1..8 and 20..27: page one shows
    // the fourteen lowest ranks with no holes.
    const sparse = sessionsAt(...range(1, 8), ...range(20, 27));
    const result = reduceLayout(healthyView(sparse), DEFAULT_LAYOUT_SETTINGS);
    expect(result.settings).toEqual(settings(true, 0));
    expect(result.dirty).toBe(true);
    for (let index = 0; index < 8; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    for (let index = 8; index < 14; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 12);
    }
    expect(result.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 2, degraded: false });

    // A single high-slot session never latches and packs to the first key.
    const alone = reduceLayout(healthyView(sessionsAt(20)), DEFAULT_LAYOUT_SETTINGS);
    expect(alone.settings).toEqual(settings(false, 0));
    expect(sessionKeyAt(alone.keys, 0).session.logicalSlot).toBe(20);
    for (let index = 1; index < 15; index++) {
      expect(alone.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
  });

  test("holds the latch at fifteen live sessions", () => {
    const latched = reduceLayout(healthyView(sessionsAt(...range(1, 16))), DEFAULT_LAYOUT_SETTINGS).settings;
    const fifteen = sessionsAt(...range(1, 15));
    const held = reduceLayout(healthyView(fifteen), latched);
    expect(held.settings).toEqual(settings(true, 0));
    expect(held.dirty).toBe(false);
    expect(held.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 2, degraded: false });

    // The fifteenth rank sits alone on the second page.
    const secondPage = reduceLayout(healthyView(fifteen), settings(true, 1));
    expect(sessionKeyAt(secondPage.keys, 0).session.logicalSlot).toBe(15);
    for (let index = 1; index < 14; index++) {
      expect(secondPage.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
    expect(secondPage.keys[14]).toEqual({ kind: "next", page: 2, pageCount: 2, degraded: false });
    expect(secondPage.dirty).toBe(false);
  });

  test("releases the latch at fourteen live sessions", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 14))), settings(true, 0));
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(true);
    for (let index = 0; index < 14; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    expect(result.keys[14]).toEqual({ kind: "blank", degraded: false });
  });
});

describe("paging", () => {
  // Thirty live sessions make three dense pages: ranks 0..13, 14..27, and
  // the two remaining ranks 28..29.
  const fullView = healthyView(sessionsAt(...range(1, 30)));

  test("NEXT advances through dense fourteen-rank pages and wraps", () => {
    const first = reduceLayout(fullView, settings(true, 0));
    expect(sessionKeyAt(first.keys, 0).session.logicalSlot).toBe(1);
    expect(sessionKeyAt(first.keys, 13).session.logicalSlot).toBe(14);
    expect(first.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 3, degraded: false });

    const second = advanceLayoutPage(fullView, settings(true, 0));
    expect(second.settings).toEqual(settings(true, 1));
    expect(second.dirty).toBe(true);
    expect(sessionKeyAt(second.keys, 0).session.logicalSlot).toBe(15);
    expect(sessionKeyAt(second.keys, 13).session.logicalSlot).toBe(28);
    expect(second.keys[14]).toEqual({ kind: "next", page: 2, pageCount: 3, degraded: false });

    const third = advanceLayoutPage(fullView, settings(true, 1));
    expect(third.settings).toEqual(settings(true, 2));
    expect(sessionKeyAt(third.keys, 0).session.logicalSlot).toBe(29);
    expect(sessionKeyAt(third.keys, 1).session.logicalSlot).toBe(30);
    for (let index = 2; index < 14; index++) {
      expect(third.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
    expect(third.keys[14]).toEqual({ kind: "next", page: 3, pageCount: 3, degraded: false });

    const wrapped = advanceLayoutPage(fullView, settings(true, 2));
    expect(wrapped.settings).toEqual(settings(true, 0));
    expect(wrapped.dirty).toBe(true);
    expect(sessionKeyAt(wrapped.keys, 0).session.logicalSlot).toBe(1);
    expect(wrapped.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 3, degraded: false });
  });

  test("clamps an out-of-range current page to the last page", () => {
    const view = healthyView(sessionsAt(...range(1, 16)));
    const clamped = reduceLayout(view, settings(true, 9));
    expect(clamped.settings).toEqual(settings(true, 1));
    expect(clamped.dirty).toBe(true);
    expect(sessionKeyAt(clamped.keys, 0).session.logicalSlot).toBe(15);
    expect(sessionKeyAt(clamped.keys, 1).session.logicalSlot).toBe(16);
    expect(clamped.keys[14]).toEqual({ kind: "next", page: 2, pageCount: 2, degraded: false });
  });

  test("NEXT without the latch preserves the base reduction", () => {
    const view = healthyView(sessionsAt(1, 2, 3));
    const result = advanceLayoutPage(view, DEFAULT_LAYOUT_SETTINGS);
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(false);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(1);

    // A stored latch that no longer qualifies releases and stays unadvanced.
    const released = advanceLayoutPage(view, settings(true, 1));
    expect(released.settings).toEqual(settings(false, 0));
    expect(released.dirty).toBe(true);
  });
});

describe("settings validation and dirty marking", () => {
  test("falls back to defaults for invalid restored settings", () => {
    const invalidSettings: unknown[] = [
      null,
      undefined,
      "page",
      42,
      [],
      { schemaVersion: 2, overflowLatched: false, currentPage: 0 },
      { schemaVersion: 1, overflowLatched: "yes", currentPage: 0 },
      { schemaVersion: 1, overflowLatched: false, currentPage: -1 },
      { schemaVersion: 1, overflowLatched: false, currentPage: 1.5 },
      { schemaVersion: 1, overflowLatched: false },
      { overflowLatched: false, currentPage: 0 },
    ];
    for (const stored of invalidSettings) {
      const result = reduceLayout(healthyView([]), stored);
      expect(result.settings).toEqual(DEFAULT_LAYOUT_SETTINGS);
      expect(result.dirty).toBe(true);
      expect(result.keys).toHaveLength(15);
      for (const key of result.keys) {
        expect(key).toEqual({ kind: "blank", degraded: false });
      }
    }
  });

  test("tolerates unknown extra fields in restored settings", () => {
    const result = reduceLayout(healthyView([]), {
      schemaVersion: 1,
      overflowLatched: false,
      currentPage: 0,
      future: "field",
    });
    expect(result.settings).toEqual(DEFAULT_LAYOUT_SETTINGS);
    expect(result.dirty).toBe(false);
  });

  test("marks settings dirty only after NEXT or a validation, clamping, or latch change", () => {
    const full = healthyView(sessionsAt(...range(1, 16)));
    // Steady state: valid settings, stable snapshot → clean.
    expect(reduceLayout(full, settings(true, 1)).dirty).toBe(false);
    expect(reduceLayout(healthyView([]), DEFAULT_LAYOUT_SETTINGS).dirty).toBe(false);
    // Latch engage and release → dirty.
    expect(reduceLayout(full, DEFAULT_LAYOUT_SETTINGS).dirty).toBe(true);
    expect(reduceLayout(healthyView(sessionsAt(...range(1, 14))), settings(true, 0)).dirty).toBe(true);
    // Clamping → dirty.
    expect(reduceLayout(full, settings(true, 9)).dirty).toBe(true);
    // Validation repair → dirty.
    expect(reduceLayout(full, "garbage").dirty).toBe(true);
    // NEXT → dirty.
    expect(advanceLayoutPage(full, settings(true, 0)).dirty).toBe(true);
  });
});

describe("KeyModel structure", () => {
  test("falls back from title to project to provider plus short session id", () => {
    expect(labelFor({ title: "Fix the bug", project: "proj" })).toBe("Fix the bug");
    expect(labelFor({ title: null, project: "proj" })).toBe("proj");
    expect(labelFor({ title: "", project: "proj" })).toBe("proj");
    expect(labelFor({ title: null, project: null, provider: "kimi", sessionId: "abcdef1234567890" })).toBe(
      "kimi abcdef12",
    );
    expect(labelFor({ title: null, project: "", provider: "codex", sessionId: "12345678abcd" })).toBe("codex 12345678");
  });

  test("keeps provider, status, descendant count, and logical slot on the session model", () => {
    const original = session(4, {
      provider: "codex",
      status: "waiting",
      descendantCount: 3,
      title: "Review",
    });
    // A lone session packs to rank 0 regardless of its logical slot.
    const model = sessionKeyAt(reduceLayout(healthyView([original]), DEFAULT_LAYOUT_SETTINGS).keys, 0);
    expect(model.session).toEqual(original);
    expect(model.session.provider).toBe("codex");
    expect(model.session.status).toBe("waiting");
    expect(model.session.descendantCount).toBe(3);
    expect(model.session.logicalSlot).toBe(4);
    expect(model.label).toBe("Review");
    expect(model.degraded).toBe(false);
  });

  test("propagates the degraded flag to every key kind", () => {
    const overflow = reduceLayout(healthyView(sessionsAt(...range(1, 16)), true), DEFAULT_LAYOUT_SETTINGS);
    expect(overflow.keys).toHaveLength(15);
    for (const key of overflow.keys) {
      expect(key.degraded).toBe(true);
    }
    expect(overflow.keys[14]?.kind).toBe("next");

    const blanks = reduceLayout(healthyView([], true), DEFAULT_LAYOUT_SETTINGS);
    for (const key of blanks.keys) {
      expect(key).toEqual({ kind: "blank", degraded: true });
    }
  });
});

describe("SnapshotCache", () => {
  const withTempDir = (run: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-cache-test-"));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const publish = (path: string, content: string): void => {
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, content);
    renameSync(tempPath, path);
  };

  const publishSnapshot = (path: string, snapshot: SessionSnapshotV2): void => {
    const { agents, ...raw } = snapshot;
    publish(path, `${JSON.stringify(agents === null ? raw : snapshot)}\n`);
  };

  test("returns an empty degraded view when the snapshot is missing and no last-good exists", () => {
    withTempDir((dir) => {
      const view = new SnapshotCache(join(dir, "snapshot-v2.json")).read();
      expect(view.degraded).toBe(true);
      expect(view.snapshot.sessions).toEqual([]);
      expect(view.snapshot.health.status).toBe("error");
    });
  });

  test("reads a healthy snapshot without the degraded flag", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v2.json");
      publishSnapshot(path, healthySnapshot([session(1)]));
      const view = new SnapshotCache(path).read();
      expect(view.degraded).toBe(false);
      expect(view.snapshot.sessions).toEqual([session(1)]);
    });
  });

  test("does not reread while the file identity is unchanged", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v2.json");
      publishSnapshot(path, healthySnapshot([session(1)]));
      const cache = new SnapshotCache(path);
      expect(cache.read().degraded).toBe(false);
      // The identity is unchanged, so a real reread would hit EACCES and flip
      // the view to degraded; staying healthy proves the cache was served.
      chmodSync(path, 0o000);
      const view = cache.read();
      expect(view.degraded).toBe(false);
      expect(view.snapshot.sessions).toEqual([session(1)]);
    });
  });

  test("rereads after the file is atomically replaced", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v2.json");
      const cache = new SnapshotCache(path);
      publishSnapshot(path, healthySnapshot([session(1)]));
      expect(cache.read().snapshot.sessions).toEqual([session(1)]);
      publishSnapshot(path, healthySnapshot([session(1), session(2)]));
      const view = cache.read();
      expect(view.degraded).toBe(false);
      expect(view.snapshot.sessions).toEqual([session(1), session(2)]);
    });
  });

  test("returns the last-good snapshot as degraded when the file disappears", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v2.json");
      const cache = new SnapshotCache(path);
      publishSnapshot(path, healthySnapshot([session(1)]));
      expect(cache.read().degraded).toBe(false);
      rmSync(path);
      const view = cache.read();
      expect(view.degraded).toBe(true);
      expect(view.snapshot.sessions).toEqual([session(1)]);
    });
  });

  test("returns an empty degraded view for a fresh cache over malformed or unsupported content", () => {
    withTempDir((dir) => {
      const malformed = join(dir, "malformed.json");
      publish(malformed, "{ not json");
      const malformedView = new SnapshotCache(malformed).read();
      expect(malformedView.degraded).toBe(true);
      expect(malformedView.snapshot.sessions).toEqual([]);

      const unsupported = join(dir, "unsupported.json");
      publishSnapshot(unsupported, { ...healthySnapshot([]), schemaVersion: 1 } as never);
      const unsupportedView = new SnapshotCache(unsupported).read();
      expect(unsupportedView.degraded).toBe(true);
      expect(unsupportedView.snapshot.sessions).toEqual([]);
    });
  });

  test("returns last-good degraded for malformed or unsupported replacements", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v2.json");
      const cache = new SnapshotCache(path);
      publishSnapshot(path, healthySnapshot([session(1)]));
      expect(cache.read().degraded).toBe(false);

      publish(path, "{ not json");
      const malformed = cache.read();
      expect(malformed.degraded).toBe(true);
      expect(malformed.snapshot.sessions).toEqual([session(1)]);

      publishSnapshot(path, { ...healthySnapshot([session(9)]), schemaVersion: 1 } as never);
      const unsupported = cache.read();
      expect(unsupported.degraded).toBe(true);
      expect(unsupported.snapshot.sessions).toEqual([session(1)]);
    });
  });

  test("returns last-good degraded for an explicitly unhealthy snapshot and never caches it", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v2.json");
      const cache = new SnapshotCache(path);
      publishSnapshot(path, healthySnapshot([session(1)]));
      expect(cache.read().degraded).toBe(false);

      publishSnapshot(path, {
        schemaVersion: 2,
        health: { status: "error", message: "database busy" },
        sessions: [],
        agents: null,
      });
      const unhealthy = cache.read();
      expect(unhealthy.degraded).toBe(true);
      expect(unhealthy.snapshot.sessions).toEqual([session(1)]);

      publishSnapshot(path, healthySnapshot([session(2)]));
      const recovered = cache.read();
      expect(recovered.degraded).toBe(false);
      expect(recovered.snapshot.sessions).toEqual([session(2)]);
    });
  });

  test("treats a snapshot older than the stale threshold as a dead daemon", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v2.json");
      const cache = new SnapshotCache(path);
      publishSnapshot(path, healthySnapshot([session(1)]));
      expect(cache.read().degraded).toBe(false);

      // The daemon rewrites on a heartbeat, so an untouched old file means it
      // is hung or dead: the last-good snapshot renders degraded instead of
      // posing as live.
      utimesSync(path, new Date(0), new Date(0));
      const stale = cache.read();
      expect(stale.degraded).toBe(true);
      expect(stale.snapshot.sessions).toEqual([session(1)]);

      // A daemon that recovers republishes and the view heals.
      publishSnapshot(path, healthySnapshot([session(2)]));
      const recovered = cache.read();
      expect(recovered.degraded).toBe(false);
      expect(recovered.snapshot.sessions).toEqual([session(2)]);
    });
  });

  test("ages against the injected clock and honors a custom stale threshold", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v2.json");
      publishSnapshot(path, healthySnapshot([session(1)]));
      const mtimeMs = statSync(path).mtimeMs;
      let now = mtimeMs + 5_000;
      const cache = new SnapshotCache(path, { now: () => now, staleAfterMs: 10_000 });

      expect(cache.read().degraded).toBe(false);
      now += 10_001;
      expect(cache.read().degraded).toBe(true);

      // Identity is unchanged throughout, so recovery is driven purely by the
      // file being touched again — the daemon's heartbeat rewrite.
      utimesSync(path, new Date(now), new Date(now));
      expect(cache.read().degraded).toBe(false);
      expect(cache.read().snapshot.sessions).toEqual([session(1)]);
    });
  });
});

describe("reduceLayout with strip geometry", () => {
  test("packs up to fifteen sessions with no paging", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 15))), DEFAULT_LAYOUT_SETTINGS, STRIP_GEOMETRY);
    expect(result.keys).toHaveLength(15);
    expect(result.pageCount).toBe(1);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(1);
    expect(sessionKeyAt(result.keys, 14).session.logicalSlot).toBe(15);
  });

  test("pads a partial page with trailing blanks for the keypad-style grid", () => {
    const result = reduceLayout(healthyView(sessionsAt(1, 2)), DEFAULT_LAYOUT_SETTINGS, STRIP_GEOMETRY);
    expect(result.keys).toHaveLength(15);
    expect(result.keys[14]).toEqual({ kind: "blank", degraded: false });
  });

  test("engages paging above fifteen sessions, emitting no NEXT key", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 17))), DEFAULT_LAYOUT_SETTINGS, STRIP_GEOMETRY);
    expect(result.keys).toHaveLength(15);
    expect(result.pageCount).toBe(2);
    expect(result.settings).toEqual(settings(true, 0));
    expect(result.keys.every((key) => key.kind !== "next")).toBe(true);
  });

  test("holds the latch at exactly fifteen sessions and releases at fourteen", () => {
    const held = reduceLayout(healthyView(sessionsAt(...range(1, 15))), settings(true, 0), STRIP_GEOMETRY);
    expect(held.settings.overflowLatched).toBe(true);
    const released = reduceLayout(healthyView(sessionsAt(...range(1, 14))), settings(true, 0), STRIP_GEOMETRY);
    expect(released.settings).toEqual(settings(false, 0));
  });

  test("clamps an out-of-range page to the last page", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 17))), settings(true, 7), STRIP_GEOMETRY);
    expect(result.settings.currentPage).toBe(1);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(16);
  });

  test("a rail page jump via stored settings lands on the requested page", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 32))), settings(true, 2), STRIP_GEOMETRY);
    expect(result.pageCount).toBe(3);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(31);
  });
});
