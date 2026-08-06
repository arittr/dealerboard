import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceLayoutPage,
  DEFAULT_LAYOUT_SETTINGS,
  type KeyModel,
  type LayoutSettingsV1,
  reduceLayout,
} from "../src/plugin/layout";
import { SnapshotCache, type SnapshotView } from "../src/plugin/snapshot-reader";
import type { ProjectedSession, SessionSnapshotV1 } from "../src/protocol";

const session = (
  logicalSlot: number,
  overrides: Partial<ProjectedSession> = {},
): ProjectedSession => ({
  provider: "claude",
  sessionId: `session-${logicalSlot}`,
  status: "idle",
  title: `Session ${logicalSlot}`,
  project: "stream-deck-agents",
  descendantCount: 0,
  logicalSlot,
  ...overrides,
});

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const sessionsAt = (...slots: number[]): ProjectedSession[] => slots.map((slot) => session(slot));

const healthySnapshot = (sessions: ProjectedSession[]): SessionSnapshotV1 => ({
  schemaVersion: 1,
  health: { status: "ok" },
  sessions,
});

const healthyView = (sessions: ProjectedSession[], degraded = false): SnapshotView => ({
  snapshot: healthySnapshot(sessions),
  degraded,
});

const settings = (overflowLatched: boolean, currentPage: number): LayoutSettingsV1 => ({
  schemaVersion: 1,
  overflowLatched,
  currentPage,
});

const sessionKeyAt = (
  keys: KeyModel[],
  index: number,
): Extract<KeyModel, { kind: "session" }> => {
  const key = keys[index];
  if (key?.kind !== "session") {
    throw new Error(`expected a session model at key ${index}, got ${key?.kind ?? "nothing"}`);
  }
  return key;
};

const labelFor = (overrides: Partial<ProjectedSession>): string =>
  sessionKeyAt(reduceLayout(healthyView([session(1, overrides)]), DEFAULT_LAYOUT_SETTINGS).keys, 0)
    .label;

describe("reduceLayout without overflow", () => {
  test("maps slots 1 through 15 to key indexes 0 through 14", () => {
    const result = reduceLayout(
      healthyView(sessionsAt(...range(1, 15))),
      DEFAULT_LAYOUT_SETTINGS,
    );
    expect(result.keys).toHaveLength(15);
    for (let index = 0; index < 15; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(false);
  });

  test("leaves gaps blank instead of compacting sessions", () => {
    const result = reduceLayout(healthyView(sessionsAt(2, 5)), DEFAULT_LAYOUT_SETTINGS);
    expect(result.keys).toHaveLength(15);
    expect(result.keys[0]).toEqual({ kind: "blank", degraded: false });
    expect(sessionKeyAt(result.keys, 1).session.logicalSlot).toBe(2);
    expect(result.keys[2]).toEqual({ kind: "blank", degraded: false });
    expect(result.keys[3]).toEqual({ kind: "blank", degraded: false });
    expect(sessionKeyAt(result.keys, 4).session.logicalSlot).toBe(5);
    for (let index = 5; index < 15; index++) {
      expect(result.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
  });

  test("sorts sessions by logical slot defensively", () => {
    const result = reduceLayout(
      healthyView([session(7), session(1), session(3)]),
      DEFAULT_LAYOUT_SETTINGS,
    );
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(1);
    expect(sessionKeyAt(result.keys, 2).session.logicalSlot).toBe(3);
    expect(sessionKeyAt(result.keys, 6).session.logicalSlot).toBe(7);
  });

  test("does not latch overflow for a live slot 15 alone", () => {
    const result = reduceLayout(
      healthyView(sessionsAt(...range(1, 15))),
      DEFAULT_LAYOUT_SETTINGS,
    );
    expect(sessionKeyAt(result.keys, 14).session.logicalSlot).toBe(15);
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(false);
  });
});

describe("reduceLayout overflow latch", () => {
  test("latches overflow only when a live slot exceeds 15", () => {
    const result = reduceLayout(
      healthyView(sessionsAt(...range(1, 16))),
      DEFAULT_LAYOUT_SETTINGS,
    );
    expect(result.keys).toHaveLength(15);
    for (let index = 0; index < 14; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    expect(result.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 2, degraded: false });
    expect(result.settings).toEqual(settings(true, 0));
    expect(result.dirty).toBe(true);
  });

  test("shows slots 15 through 28 on the second page", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 16))), settings(true, 1));
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(15);
    expect(sessionKeyAt(result.keys, 1).session.logicalSlot).toBe(16);
    for (let index = 2; index < 14; index++) {
      expect(result.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
    expect(result.keys[14]).toEqual({ kind: "next", page: 2, pageCount: 2, degraded: false });
    expect(result.settings).toEqual(settings(true, 1));
    expect(result.dirty).toBe(false);
  });

  test("keeps the latch while any slot at least 15 is live, including slot 15 alone", () => {
    // Overflow latches on slot 16, then the slot-16 session disappears while
    // slot 15 (moved to page two) remains live: the latch must hold.
    const latched = reduceLayout(
      healthyView(sessionsAt(...range(1, 16))),
      DEFAULT_LAYOUT_SETTINGS,
    ).settings;
    const after = reduceLayout(healthyView(sessionsAt(...range(1, 15))), latched);
    expect(after.settings).toEqual(settings(true, 0));
    expect(after.dirty).toBe(false);
    expect(sessionKeyAt(after.keys, 13).session.logicalSlot).toBe(14);
    expect(after.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 2, degraded: false });

    const secondPage = reduceLayout(healthyView(sessionsAt(...range(1, 15))), settings(true, 1));
    expect(sessionKeyAt(secondPage.keys, 0).session.logicalSlot).toBe(15);
    expect(secondPage.dirty).toBe(false);

    // Slot 15 as the only live session still holds the latch.
    const onlyFifteen = reduceLayout(healthyView(sessionsAt(15)), settings(true, 1));
    expect(onlyFifteen.settings).toEqual(settings(true, 1));
    expect(onlyFifteen.dirty).toBe(false);
    expect(sessionKeyAt(onlyFifteen.keys, 0).session.logicalSlot).toBe(15);
    expect(onlyFifteen.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 1, degraded: false });
  });

  test("ends the latch when no live slot remains at 15 or above", () => {
    const result = reduceLayout(healthyView(sessionsAt(...range(1, 14))), settings(true, 0));
    expect(result.settings).toEqual(settings(false, 0));
    expect(result.dirty).toBe(true);
    expect(result.keys).toHaveLength(15);
    for (let index = 0; index < 14; index++) {
      expect(sessionKeyAt(result.keys, index).session.logicalSlot).toBe(index + 1);
    }
    expect(result.keys[14]).toEqual({ kind: "blank", degraded: false });
  });
});

describe("paging", () => {
  // Slots 1..14 fill page one; slot 29 sits alone on the third page, leaving
  // the slots-15..28 page wholly empty so NEXT must skip it.
  const gappedView = healthyView([...sessionsAt(...range(1, 14)), session(29)]);

  test("NEXT advances in blocks of 14, skips wholly empty pages, and wraps", () => {
    const first = reduceLayout(gappedView, settings(true, 0));
    expect(first.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 2, degraded: false });

    const advanced = advanceLayoutPage(gappedView, settings(true, 0));
    expect(advanced.settings).toEqual(settings(true, 2));
    expect(advanced.dirty).toBe(true);
    expect(sessionKeyAt(advanced.keys, 0).session.logicalSlot).toBe(29);
    for (let index = 1; index < 14; index++) {
      expect(advanced.keys[index]).toEqual({ kind: "blank", degraded: false });
    }
    expect(advanced.keys[14]).toEqual({ kind: "next", page: 2, pageCount: 2, degraded: false });

    const wrapped = advanceLayoutPage(gappedView, settings(true, 2));
    expect(wrapped.settings).toEqual(settings(true, 0));
    expect(wrapped.dirty).toBe(true);
    expect(sessionKeyAt(wrapped.keys, 0).session.logicalSlot).toBe(1);
    expect(wrapped.keys[14]).toEqual({ kind: "next", page: 1, pageCount: 2, degraded: false });
  });

  test("NEXT leaves settings clean when only one page is non-empty", () => {
    const result = advanceLayoutPage(healthyView(sessionsAt(16)), settings(true, 1));
    expect(result.settings).toEqual(settings(true, 1));
    expect(result.dirty).toBe(false);
  });

  test("clamps an empty current page to the nearest earlier non-empty page", () => {
    // Pages: 0 has slots 1..14, 1 has slot 15, 2 (29..42) is empty, 3 has 43.
    const view = healthyView([...sessionsAt(...range(1, 15)), session(43)]);
    const clamped = reduceLayout(view, settings(true, 2));
    expect(clamped.settings).toEqual(settings(true, 1));
    expect(clamped.dirty).toBe(true);
    expect(sessionKeyAt(clamped.keys, 0).session.logicalSlot).toBe(15);
    expect(clamped.keys[14]).toEqual({ kind: "next", page: 2, pageCount: 3, degraded: false });

    const outOfRange = reduceLayout(view, settings(true, 9));
    expect(outOfRange.settings).toEqual(settings(true, 3));
    expect(outOfRange.dirty).toBe(true);
    expect(sessionKeyAt(outOfRange.keys, 0).session.logicalSlot).toBe(43);
    expect(outOfRange.keys[14]).toEqual({ kind: "next", page: 3, pageCount: 3, degraded: false });
  });

  test("clamps to the earliest later page when no earlier page is non-empty", () => {
    const view = healthyView(sessionsAt(15, 43));
    const result = reduceLayout(view, settings(true, 0));
    expect(result.settings).toEqual(settings(true, 1));
    expect(result.dirty).toBe(true);
    expect(sessionKeyAt(result.keys, 0).session.logicalSlot).toBe(15);
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
    expect(reduceLayout(healthyView(sessionsAt(...range(1, 14))), settings(true, 0)).dirty).toBe(
      true,
    );
    // Clamping → dirty.
    expect(reduceLayout(healthyView(sessionsAt(15)), settings(true, 0)).dirty).toBe(true);
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
    expect(
      labelFor({ title: null, project: null, provider: "kimi", sessionId: "abcdef1234567890" }),
    ).toBe("kimi abcdef12");
    expect(labelFor({ title: null, project: "", provider: "codex", sessionId: "12345678abcd" }))
      .toBe("codex 12345678");
  });

  test("keeps provider, status, descendant count, and logical slot on the session model", () => {
    const original = session(4, {
      provider: "codex",
      status: "waiting",
      descendantCount: 3,
      title: "Review",
    });
    const model = sessionKeyAt(
      reduceLayout(healthyView([original]), DEFAULT_LAYOUT_SETTINGS).keys,
      3,
    );
    expect(model.session).toEqual(original);
    expect(model.session.provider).toBe("codex");
    expect(model.session.status).toBe("waiting");
    expect(model.session.descendantCount).toBe(3);
    expect(model.session.logicalSlot).toBe(4);
    expect(model.label).toBe("Review");
    expect(model.degraded).toBe(false);
  });

  test("propagates the degraded flag to every key kind", () => {
    const overflow = reduceLayout(
      healthyView(sessionsAt(...range(1, 16)), true),
      DEFAULT_LAYOUT_SETTINGS,
    );
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

  const publishSnapshot = (path: string, snapshot: SessionSnapshotV1): void => {
    publish(path, `${JSON.stringify(snapshot)}\n`);
  };

  test("returns an empty degraded view when the snapshot is missing and no last-good exists", () => {
    withTempDir((dir) => {
      const view = new SnapshotCache(join(dir, "snapshot-v1.json")).read();
      expect(view.degraded).toBe(true);
      expect(view.snapshot.sessions).toEqual([]);
      expect(view.snapshot.health.status).toBe("error");
    });
  });

  test("reads a healthy snapshot without the degraded flag", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v1.json");
      publishSnapshot(path, healthySnapshot([session(1)]));
      const view = new SnapshotCache(path).read();
      expect(view.degraded).toBe(false);
      expect(view.snapshot.sessions).toEqual([session(1)]);
    });
  });

  test("does not reread while the file identity is unchanged", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v1.json");
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
      const path = join(dir, "snapshot-v1.json");
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
      const path = join(dir, "snapshot-v1.json");
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
      publishSnapshot(unsupported, { ...healthySnapshot([]), schemaVersion: 2 } as never);
      const unsupportedView = new SnapshotCache(unsupported).read();
      expect(unsupportedView.degraded).toBe(true);
      expect(unsupportedView.snapshot.sessions).toEqual([]);
    });
  });

  test("returns last-good degraded for malformed or unsupported replacements", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v1.json");
      const cache = new SnapshotCache(path);
      publishSnapshot(path, healthySnapshot([session(1)]));
      expect(cache.read().degraded).toBe(false);

      publish(path, "{ not json");
      const malformed = cache.read();
      expect(malformed.degraded).toBe(true);
      expect(malformed.snapshot.sessions).toEqual([session(1)]);

      publishSnapshot(path, { ...healthySnapshot([session(9)]), schemaVersion: 2 } as never);
      const unsupported = cache.read();
      expect(unsupported.degraded).toBe(true);
      expect(unsupported.snapshot.sessions).toEqual([session(1)]);
    });
  });

  test("returns last-good degraded for an explicitly unhealthy snapshot and never caches it", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v1.json");
      const cache = new SnapshotCache(path);
      publishSnapshot(path, healthySnapshot([session(1)]));
      expect(cache.read().degraded).toBe(false);

      publishSnapshot(path, {
        schemaVersion: 1,
        health: { status: "error", message: "database busy" },
        sessions: [],
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

  test("does not infer health from file age", () => {
    withTempDir((dir) => {
      const path = join(dir, "snapshot-v1.json");
      const cache = new SnapshotCache(path);
      publishSnapshot(path, healthySnapshot([session(1)]));
      expect(cache.read().degraded).toBe(false);
      utimesSync(path, new Date(0), new Date(0));
      const view = cache.read();
      expect(view.degraded).toBe(false);
      expect(view.snapshot.sessions).toEqual([session(1)]);
    });
  });
});
