import { describe, expect, test } from "bun:test";
import type { DiagnosticRecord } from "../src/core/diagnostics";
import {
  appendDayCurvePoint,
  createTokenUsageCollector,
  laProviderDay,
  normalizeAgentsviewDaily,
  previousProviderDay,
  reconcileSeededDayCurves,
  resolveAgentsviewBin,
  TOKEN_USAGE_SAMPLE_LIMIT,
  type TokenUsageCollectorDependencies,
} from "../src/core/token-usage";
import { parseTokenUsageSnapshot, TOKEN_USAGE_DAY_CURVE_POINT_LIMIT } from "../src/token-usage-snapshot";

const NOW = "2026-08-20T17:00:00.000Z"; // 10:00 in Los Angeles (UTC-7)
const NOW_MS = Date.parse(NOW);
const DAY = "2026-08-20";

const report = (
  total: { input: number; output: number; cacheCreation: number; cacheRead: number },
  schemaVersion = 4,
): string =>
  JSON.stringify({
    schema_version: schemaVersion,
    daily: [
      {
        date: DAY,
        inputTokens: total.input,
        outputTokens: total.output,
        cacheCreationTokens: total.cacheCreation,
        cacheReadTokens: total.cacheRead,
        totalCost: { microdollars: 1 },
      },
    ],
  });

const FULL = report({ input: 100, output: 200, cacheCreation: 300, cacheRead: 400 });

describe("laProviderDay", () => {
  test("maps instants to the America/Los_Angeles calendar date", () => {
    expect(laProviderDay(new Date("2026-08-20T06:59:59.999Z"))).toBe("2026-08-19"); // 23:59:59 PDT
    expect(laProviderDay(new Date("2026-08-20T07:00:00.000Z"))).toBe(DAY); // 00:00 PDT
    expect(laProviderDay(new Date("2026-01-20T08:00:00.000Z"))).toBe("2026-01-20"); // midnight PST (UTC-8)
  });
});

describe("normalizeAgentsviewDaily", () => {
  test("sums input + output + cacheCreation + cacheRead for the day's row", () => {
    expect(normalizeAgentsviewDaily(FULL, DAY)).toBe(1000);
  });

  test("accepts the known v4, v5, and v6 report schemas", () => {
    const totals = { input: 100, output: 200, cacheCreation: 300, cacheRead: 400 };
    expect(normalizeAgentsviewDaily(report(totals, 4), DAY)).toBe(1000);
    expect(normalizeAgentsviewDaily(report(totals, 5), DAY)).toBe(1000);
    expect(normalizeAgentsviewDaily(report(totals, 6), DAY)).toBe(1000);
  });

  test("a report with no row for the day is a legitimate zero", () => {
    expect(normalizeAgentsviewDaily(JSON.stringify({ schema_version: 4, daily: [] }), DAY)).toBe(0);
  });

  test("returns null for malformed JSON, wrong schema, or a row with bad fields", () => {
    expect(normalizeAgentsviewDaily("junk", DAY)).toBeNull();
    expect(normalizeAgentsviewDaily(JSON.stringify({ schema_version: 3, daily: [] }), DAY)).toBeNull();
    const badRow = JSON.stringify({ schema_version: 4, daily: [{ date: DAY, inputTokens: -1 }] });
    expect(normalizeAgentsviewDaily(badRow, DAY)).toBeNull();
  });

  test("a malformed daily entry is a failed poll, never a legitimate zero", () => {
    expect(normalizeAgentsviewDaily(JSON.stringify({ schema_version: 4, daily: [null] }), DAY)).toBeNull();
    expect(normalizeAgentsviewDaily(JSON.stringify({ schema_version: 4, daily: [{ date: 123 }] }), DAY)).toBeNull();
    expect(
      normalizeAgentsviewDaily(JSON.stringify({ schema_version: 4, daily: [{ date: "garbage" }] }), DAY),
    ).toBeNull();
    const validToday = { date: DAY, inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 };
    // A malformed entry after the matching row is still validated — the
    // total is never accepted from a partially well-formed report.
    expect(normalizeAgentsviewDaily(JSON.stringify({ schema_version: 4, daily: [validToday, null] }), DAY)).toBeNull();
    expect(
      normalizeAgentsviewDaily(JSON.stringify({ schema_version: 4, daily: [validToday, { date: "garbage" }] }), DAY),
    ).toBeNull();
  });

  test("finite fields whose sum overflows are a failed poll, never Infinity", () => {
    // Each field passes the finite check, but the sum is Infinity — which
    // JSON.stringify would publish as null — so the row is rejected whole.
    const overflow = report({
      input: Number.MAX_VALUE,
      output: Number.MAX_VALUE,
      cacheCreation: Number.MAX_VALUE,
      cacheRead: Number.MAX_VALUE,
    });
    expect(normalizeAgentsviewDaily(overflow, DAY)).toBeNull();
  });

  test("a valid non-matching row is skipped without field validation", () => {
    const foreign = JSON.stringify({ schema_version: 4, daily: [{ date: "2026-08-19", inputTokens: "junk" }] });
    expect(normalizeAgentsviewDaily(foreign, DAY)).toBe(0);
  });
});

describe("resolveAgentsviewBin", () => {
  test("prefers AGENTSVIEW_BIN, then the homebrew path, then PATH", () => {
    expect(resolveAgentsviewBin({ AGENTSVIEW_BIN: "/custom/agy" }, () => true)).toBe("/custom/agy");
    expect(resolveAgentsviewBin({}, () => true)).toBe("/opt/homebrew/bin/agentsview");
    expect(resolveAgentsviewBin({}, () => false)).toBe("agentsview");
  });
});

describe("createTokenUsageCollector", () => {
  const makeHarness = (files: Record<string, string> = {}) => {
    const runs: { file: string; args: readonly string[] }[] = [];
    const diagnostics: DiagnosticRecord[] = [];
    const writes: string[] = [];
    let body = FULL;
    let throws = false;
    const deps: TokenUsageCollectorDependencies = {
      agentsviewBin: "agentsview",
      tokenUsageSnapshotPath: "/tmp/token-usage-snapshot.json",
      run: async (file, args) => {
        runs.push({ file, args });
        if (throws) {
          throw new Error("spawn failed");
        }
        return body;
      },
      readFile: (path) => files[path] ?? null,
      now: () => NOW,
      nowMs: () => NOW_MS,
      writeFile: (_path, payload) => {
        writes.push(payload);
      },
      diagnostics: (record) => {
        diagnostics.push(record);
      },
    };
    return {
      deps,
      runs,
      diagnostics,
      writes,
      respond: (nextBody: string) => {
        body = nextBody;
        throws = false;
      },
      fail: () => {
        throws = true;
      },
    };
  };

  test("a successful poll runs agentsview for the LA day and publishes the snapshot with one sample", async () => {
    const harness = makeHarness();
    await createTokenUsageCollector(harness.deps).pollNow();
    expect(harness.runs.length).toBe(1);
    expect(harness.runs[0]?.args).toEqual([
      "usage",
      "daily",
      "--json",
      "--timezone",
      "America/Los_Angeles",
      "--since",
      DAY,
    ]);
    expect(harness.writes.length).toBe(1);
    const snapshot = parseTokenUsageSnapshot(JSON.parse(harness.writes[0] ?? ""));
    expect(snapshot).toEqual({
      schemaVersion: 1,
      providerDay: DAY,
      totalTokens: 1000,
      unavailable: false,
      fetchedAt: NOW,
      samples: [{ fetchedAt: NOW, totalTokens: 1000, providerDay: DAY }],
      dayCurves: {
        today: { providerDay: DAY, points: [{ fetchedAt: NOW, totalTokens: 1000 }] },
        yesterday: null,
      },
    });
  });

  test("a failed poll keeps last-good data, marks unavailable, and logs only the transition", async () => {
    const harness = makeHarness();
    const collector = createTokenUsageCollector(harness.deps);
    await collector.pollNow();
    harness.fail();
    await collector.pollNow();
    await collector.pollNow();
    const snapshot = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(snapshot).toMatchObject({ totalTokens: 1000, unavailable: true, fetchedAt: NOW });
    expect(snapshot.samples.length).toBe(1); // failures never append samples
    const failures = harness.diagnostics.filter((record) => record.code === "token_usage_failed");
    expect(failures.length).toBe(1); // good→failed transition only
    expect(failures[0]?.component).toBe("token-usage");
  });

  test("a cold-start failure publishes an unavailable never-fetched snapshot and recovers cleanly", async () => {
    const harness = makeHarness();
    const collector = createTokenUsageCollector(harness.deps);
    harness.fail();
    await collector.pollNow();
    await collector.pollNow(); // a cold failure never logs — there was no good state to leave
    const cold = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(cold).toMatchObject({ totalTokens: 0, unavailable: true, fetchedAt: null, samples: [] });
    expect(harness.diagnostics.filter((record) => record.code === "token_usage_failed").length).toBe(0);
    harness.respond(FULL);
    await collector.pollNow();
    const recovered = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(recovered).toMatchObject({ totalTokens: 1000, unavailable: false, fetchedAt: NOW });
    harness.fail();
    await collector.pollNow();
    const failures = harness.diagnostics.filter((record) => record.code === "token_usage_failed");
    expect(failures.length).toBe(1); // the first good→failed transition only
  });

  test("the ring is capped and seeds from the previous publication", async () => {
    const seeded = {
      schemaVersion: 1,
      providerDay: DAY,
      totalTokens: 500,
      unavailable: false,
      fetchedAt: "2026-08-20T16:59:30.000Z",
      samples: Array.from({ length: TOKEN_USAGE_SAMPLE_LIMIT }, () => ({
        fetchedAt: "2026-08-20T16:00:00.000Z",
        totalTokens: 400,
        providerDay: DAY,
      })),
    };
    const harness = makeHarness({ "/tmp/token-usage-snapshot.json": `${JSON.stringify(seeded)}\n` });
    await createTokenUsageCollector(harness.deps).pollNow();
    const snapshot = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(snapshot.samples.length).toBe(TOKEN_USAGE_SAMPLE_LIMIT); // 288 seeded + 1 new, capped
    expect(snapshot.samples.at(-1)).toEqual({ fetchedAt: NOW, totalTokens: 1000, providerDay: DAY });
  });

  test("an unchanged state is not rewritten", async () => {
    const harness = makeHarness();
    const collector = createTokenUsageCollector(harness.deps);
    harness.fail();
    await collector.pollNow();
    await collector.pollNow(); // identical unavailable snapshot — no second write
    expect(harness.writes.length).toBe(1);
  });
});

const point = (second: number, total: number) => ({
  fetchedAt: new Date(Date.UTC(2026, 7, 25, 10, 0, second)).toISOString(),
  totalTokens: total,
});

describe("previousProviderDay", () => {
  test("steps calendar days including month and year seams", () => {
    expect(previousProviderDay("2026-08-25")).toBe("2026-08-24");
    expect(previousProviderDay("2026-08-01")).toBe("2026-07-31");
    expect(previousProviderDay("2026-01-01")).toBe("2025-12-31");
  });
});

describe("appendDayCurvePoint", () => {
  test("same-day points append with a running max (a helper correction never dips the curve)", () => {
    const first = appendDayCurvePoint(undefined, "2026-08-25", point(0, 100));
    const second = appendDayCurvePoint(first, "2026-08-25", point(30, 90));
    expect(second.today.points).toEqual([point(30, 100)]);
    expect(second.yesterday).toBeNull();
  });

  test("a new adjacent day promotes today to yesterday; a gap drops it", () => {
    const monday = appendDayCurvePoint(undefined, "2026-08-24", point(0, 5));
    const tuesday = appendDayCurvePoint(monday, "2026-08-25", point(0, 1));
    expect(tuesday.yesterday?.providerDay).toBe("2026-08-24");
    const thursday = appendDayCurvePoint(monday, "2026-08-27", point(0, 1));
    expect(thursday.yesterday).toBeNull();
  });

  test("drops a same-day point whose fetchedAt does not advance (a stepped-back clock never breaks the curve)", () => {
    // The reader rejects a curve whose timestamps are not strictly
    // increasing, so a repeated or backward instant must never be published.
    const base = appendDayCurvePoint(undefined, "2026-08-25", point(10, 100));
    expect(appendDayCurvePoint(base, "2026-08-25", point(10, 150))).toEqual(base);
    expect(appendDayCurvePoint(base, "2026-08-25", point(5, 200))).toEqual(base);
    const advanced = appendDayCurvePoint(base, "2026-08-25", {
      fetchedAt: "2026-08-25T10:30:00.000Z",
      totalTokens: 120,
    });
    expect(advanced.today.points.map((p) => p.totalTokens)).toEqual([100, 120]);
  });

  test("retains the latest observation in every populated half-hour bucket across a full day", () => {
    const start = Date.parse("2026-08-25T07:00:00.000Z");
    let curves = appendDayCurvePoint(undefined, "2026-08-25", {
      fetchedAt: new Date(start).toISOString(),
      totalTokens: 0,
    });
    for (let i = 1; i < 2_880; i++) {
      curves = appendDayCurvePoint(curves, "2026-08-25", {
        fetchedAt: new Date(start + i * 30_000).toISOString(),
        totalTokens: i,
      });
    }
    const points = curves.today.points;
    expect(points).toHaveLength(48);
    expect(points[0]?.fetchedAt).toBe("2026-08-25T07:29:30.000Z");
    expect(points[1]?.fetchedAt).toBe("2026-08-25T07:59:30.000Z");
    expect(points[24]?.fetchedAt).toBe("2026-08-25T19:29:30.000Z");
    expect(points[47]?.fetchedAt).toBe("2026-08-26T06:59:30.000Z");
    for (let i = 1; i < points.length; i++) {
      expect(Date.parse(points[i]?.fetchedAt ?? "") - Date.parse(points[i - 1]?.fetchedAt ?? "")).toBe(30 * 60_000);
    }
  });

  test("compacts legacy same-bucket duplicates without filling missing buckets", () => {
    const curves = {
      today: {
        providerDay: "2026-08-25",
        points: [
          { fetchedAt: "2026-08-25T07:01:00.000Z", totalTokens: 10 },
          { fetchedAt: "2026-08-25T07:29:30.000Z", totalTokens: 20 },
          { fetchedAt: "2026-08-25T12:03:00.000Z", totalTokens: 30 },
          { fetchedAt: "2026-08-25T12:29:30.000Z", totalTokens: 40 },
        ],
      },
      yesterday: null,
    };

    const appended = appendDayCurvePoint(curves, "2026-08-25", {
      fetchedAt: "2026-08-25T13:01:00.000Z",
      totalTokens: 50,
    });

    expect(appended.today.points).toEqual([
      { fetchedAt: "2026-08-25T07:29:30.000Z", totalTokens: 20 },
      { fetchedAt: "2026-08-25T12:29:30.000Z", totalTokens: 40 },
      { fetchedAt: "2026-08-25T13:01:00.000Z", totalTokens: 50 },
    ]);
  });

  test("a 25-hour fall-DST day fits below the unchanged compatibility limit", () => {
    const start = Date.parse("2026-11-01T07:00:00.000Z");
    let curves = appendDayCurvePoint(undefined, "2026-11-01", {
      fetchedAt: new Date(start).toISOString(),
      totalTokens: 0,
    });
    for (let i = 1; i < 3_000; i++) {
      curves = appendDayCurvePoint(curves, "2026-11-01", {
        fetchedAt: new Date(start + i * 30_000).toISOString(),
        totalTokens: i,
      });
    }

    expect(curves.today.points).toHaveLength(50);
    expect(curves.today.points.length).toBeLessThan(TOKEN_USAGE_DAY_CURVE_POINT_LIMIT);
  });

  test("appending to an at-limit accepted curve retains the latest points within the wire bound", () => {
    const start = Date.parse("2026-08-23T17:00:00.000Z");
    const points = Array.from({ length: TOKEN_USAGE_DAY_CURVE_POINT_LIMIT }, (_, index) => ({
      fetchedAt: new Date(start + index * 30 * 60_000).toISOString(),
      totalTokens: index,
    }));
    const accepted = parseTokenUsageSnapshot({
      schemaVersion: 1,
      providerDay: "2026-08-25",
      totalTokens: points.at(-1)?.totalTokens ?? 0,
      unavailable: false,
      fetchedAt: points.at(-1)?.fetchedAt ?? null,
      samples: [],
      dayCurves: {
        today: { providerDay: "2026-08-25", points },
        yesterday: null,
      },
    });
    const latest = { fetchedAt: "2026-08-25T17:00:00.000Z", totalTokens: 96 };

    const appended = appendDayCurvePoint(accepted.dayCurves, "2026-08-25", latest);

    expect(appended.today.points).toHaveLength(TOKEN_USAGE_DAY_CURVE_POINT_LIMIT);
    expect(appended.today.points[0]).toEqual(points[1]);
    expect(appended.today.points.at(-1)).toEqual(latest);
    for (let index = 1; index < appended.today.points.length; index++) {
      const previous = appended.today.points[index - 1];
      const current = appended.today.points[index];
      if (previous === undefined || current === undefined) {
        throw new Error("expected adjacent retained curve points");
      }
      expect(current.fetchedAt > previous.fetchedAt).toBe(true);
      expect(current.totalTokens >= previous.totalTokens).toBe(true);
    }
    expect(() =>
      parseTokenUsageSnapshot({
        ...accepted,
        totalTokens: latest.totalTokens,
        fetchedAt: latest.fetchedAt,
        dayCurves: appended,
      }),
    ).not.toThrow();
  });
});

describe("reconcileSeededDayCurves", () => {
  const seeded = appendDayCurvePoint(undefined, "2026-08-24", point(0, 7));

  test("same-day seed passes through; adjacent-day seed rotates; a gap drops everything", () => {
    expect(reconcileSeededDayCurves(seeded, "2026-08-24")).toEqual(seeded);
    const rotated = reconcileSeededDayCurves(seeded, "2026-08-25");
    expect(rotated?.yesterday?.providerDay).toBe("2026-08-24");
    expect(rotated?.today).toEqual({ providerDay: "2026-08-25", points: [] });
    expect(reconcileSeededDayCurves(seeded, "2026-08-27")).toBeUndefined();
    expect(reconcileSeededDayCurves(undefined, "2026-08-25")).toBeUndefined();
  });
});

describe("createTokenUsageCollector day curves", () => {
  const dayReport = (day: string, total: number): string =>
    JSON.stringify({
      schema_version: 4,
      daily: [{ date: day, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: total }],
    });

  // The base harness pins time, but day-curve points must be strictly
  // increasing in fetchedAt, so this fixture carries an advancing clock.
  const makeDayCurveHarness = (files: Record<string, string> = {}) => {
    let clockMs = Date.parse("2026-08-25T17:00:00.000Z"); // 10:00 in Los Angeles
    let total = 1000;
    let throws = false;
    const writes: string[] = [];
    const deps: TokenUsageCollectorDependencies = {
      agentsviewBin: "agentsview",
      tokenUsageSnapshotPath: "/tmp/token-usage-snapshot.json",
      run: async () => {
        if (throws) {
          throw new Error("spawn failed");
        }
        return dayReport("2026-08-25", total);
      },
      readFile: (path) => files[path] ?? null,
      now: () => new Date(clockMs).toISOString(),
      nowMs: () => clockMs,
      writeFile: (_path, payload) => {
        writes.push(payload);
      },
    };
    return {
      deps,
      writes,
      advanceMinutes: (minutes: number) => {
        clockMs += minutes * 60_000;
      },
      setInstant: (instant: string) => {
        clockMs = Date.parse(instant);
      },
      respond: (nextTotal: number) => {
        total = nextTotal;
        throws = false;
      },
      fail: () => {
        throws = true;
      },
    };
  };

  test("two successful polls in one half-hour publish the latest point", async () => {
    const harness = makeDayCurveHarness();
    const collector = createTokenUsageCollector(harness.deps);
    await collector.pollNow();
    harness.advanceMinutes(15);
    await collector.pollNow();
    const snapshot = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(snapshot.dayCurves?.today).toEqual({
      providerDay: "2026-08-25",
      points: [{ fetchedAt: "2026-08-25T17:15:00.000Z", totalTokens: 1000 }],
    });
    expect(snapshot.dayCurves?.yesterday).toBeNull();
  });

  test("a successful poll recovers retained same-day sample buckets without filling older gaps", async () => {
    const yesterday = {
      providerDay: "2026-08-24",
      points: [{ fetchedAt: "2026-08-24T22:00:00.000Z", totalTokens: 700 }],
    };
    const seededFile = `${JSON.stringify({
      schemaVersion: 1,
      providerDay: "2026-08-25",
      totalTokens: 600,
      unavailable: false,
      fetchedAt: "2026-08-25T16:49:00.000Z",
      samples: [
        { fetchedAt: "2026-08-25T14:01:00.000Z", totalTokens: 100, providerDay: "2026-08-25" },
        { fetchedAt: "2026-08-25T14:29:00.000Z", totalTokens: 120, providerDay: "2026-08-25" },
        { fetchedAt: "2026-08-25T14:59:00.000Z", totalTokens: 200, providerDay: "2026-08-25" },
        { fetchedAt: "2026-08-25T15:29:00.000Z", totalTokens: 190, providerDay: "2026-08-25" },
        { fetchedAt: "2026-08-25T15:59:00.000Z", totalTokens: 300, providerDay: "2026-08-25" },
        { fetchedAt: "2026-08-25T16:29:00.000Z", totalTokens: 350, providerDay: "2026-08-25" },
        { fetchedAt: "2026-08-25T16:44:00.000Z", totalTokens: 450, providerDay: "2026-08-25" },
      ],
      dayCurves: {
        today: {
          providerDay: "2026-08-25",
          points: [
            { fetchedAt: "2026-08-25T07:29:00.000Z", totalTokens: 10 },
            { fetchedAt: "2026-08-25T16:49:00.000Z", totalTokens: 600 },
          ],
        },
        yesterday,
      },
    })}\n`;
    const harness = makeDayCurveHarness({ "/tmp/token-usage-snapshot.json": seededFile });

    await createTokenUsageCollector(harness.deps).pollNow();

    const snapshot = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    const recoveredPoints = snapshot.dayCurves?.today.points ?? [];
    expect(recoveredPoints).toEqual([
      { fetchedAt: "2026-08-25T07:29:00.000Z", totalTokens: 10 },
      { fetchedAt: "2026-08-25T14:29:00.000Z", totalTokens: 120 },
      { fetchedAt: "2026-08-25T14:59:00.000Z", totalTokens: 200 },
      { fetchedAt: "2026-08-25T15:29:00.000Z", totalTokens: 200 },
      { fetchedAt: "2026-08-25T15:59:00.000Z", totalTokens: 300 },
      { fetchedAt: "2026-08-25T16:29:00.000Z", totalTokens: 350 },
      { fetchedAt: "2026-08-25T16:49:00.000Z", totalTokens: 600 },
      { fetchedAt: "2026-08-25T17:00:00.000Z", totalTokens: 1000 },
    ]);
    const halfHourBuckets = recoveredPoints.map((point) => Math.floor(Date.parse(point.fetchedAt) / (30 * 60_000)));
    expect(new Set(halfHourBuckets).size).toBe(halfHourBuckets.length);
    expect(snapshot.dayCurves?.yesterday).toEqual(yesterday);
  });

  test("a stepped-back successful poll cannot rewrite the curve or re-enter on a later poll", async () => {
    const seededFile = `${JSON.stringify({
      schemaVersion: 1,
      providerDay: "2026-08-25",
      totalTokens: 100,
      unavailable: false,
      fetchedAt: "2026-08-25T17:00:00.000Z",
      samples: [{ fetchedAt: "2026-08-25T17:00:00.000Z", totalTokens: 100, providerDay: "2026-08-25" }],
      dayCurves: {
        today: {
          providerDay: "2026-08-25",
          points: [{ fetchedAt: "2026-08-25T17:00:00.000Z", totalTokens: 100 }],
        },
        yesterday: null,
      },
    })}\n`;
    const harness = makeDayCurveHarness({ "/tmp/token-usage-snapshot.json": seededFile });
    const collector = createTokenUsageCollector(harness.deps);

    harness.setInstant("2026-08-25T16:00:00.000Z");
    harness.respond(200);
    await collector.pollNow();
    const afterBackwardPoll = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(afterBackwardPoll.dayCurves?.today.points).toEqual([
      { fetchedAt: "2026-08-25T17:00:00.000Z", totalTokens: 100 },
    ]);

    harness.setInstant("2026-08-25T18:00:00.000Z");
    harness.respond(300);
    await collector.pollNow();
    const afterAdvancingPoll = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(afterAdvancingPoll.dayCurves?.today.points).toEqual([
      { fetchedAt: "2026-08-25T17:00:00.000Z", totalTokens: 100 },
      { fetchedAt: "2026-08-25T18:00:00.000Z", totalTokens: 300 },
    ]);
  });

  test("a seeded curve from yesterday rotates into yesterday on today's poll", async () => {
    const seededCurve = {
      today: { providerDay: "2026-08-24", points: [{ fetchedAt: "2026-08-24T22:00:00.000Z", totalTokens: 700 }] },
      yesterday: null,
    };
    const seededFile = `${JSON.stringify({
      schemaVersion: 1,
      providerDay: "2026-08-24",
      totalTokens: 700,
      unavailable: false,
      fetchedAt: "2026-08-24T22:00:00.000Z",
      samples: [],
      dayCurves: seededCurve,
    })}\n`;
    const harness = makeDayCurveHarness({ "/tmp/token-usage-snapshot.json": seededFile });
    await createTokenUsageCollector(harness.deps).pollNow();
    const snapshot = parseTokenUsageSnapshot(JSON.parse(harness.writes.at(-1) ?? ""));
    expect(snapshot.dayCurves?.yesterday).toEqual(seededCurve.today);
    expect(snapshot.dayCurves?.today).toEqual({
      providerDay: "2026-08-25",
      points: [{ fetchedAt: "2026-08-25T17:00:00.000Z", totalTokens: 1000 }],
    });
  });

  test("a failed first poll still publishes the reconciled seed state, not the stale curve", async () => {
    const staleSeed = (day: string): string =>
      `${JSON.stringify({
        schemaVersion: 1,
        providerDay: day,
        totalTokens: 700,
        unavailable: true, // already failed — a failed first poll must still reconcile
        fetchedAt: `${day}T22:00:00.000Z`,
        samples: [],
        dayCurves: {
          today: { providerDay: day, points: [{ fetchedAt: `${day}T22:00:00.000Z`, totalTokens: 700 }] },
          yesterday: null,
        },
      })}\n`;

    // Adjacent-day seed rotates: the stale curve lands in yesterday, today starts empty.
    const adjacent = makeDayCurveHarness({ "/tmp/token-usage-snapshot.json": staleSeed("2026-08-24") });
    const adjacentCollector = createTokenUsageCollector(adjacent.deps);
    adjacent.fail();
    await adjacentCollector.pollNow();
    expect(adjacent.writes.length).toBe(1); // the reconciled state must reach the file, not just memory
    const rotated = parseTokenUsageSnapshot(JSON.parse(adjacent.writes[0] ?? ""));
    expect(rotated.unavailable).toBe(true);
    expect(rotated.dayCurves?.yesterday?.providerDay).toBe("2026-08-24");
    expect(rotated.dayCurves?.today).toEqual({ providerDay: "2026-08-25", points: [] });

    // Gapped seed drops the stale curve entirely.
    const gapped = makeDayCurveHarness({ "/tmp/token-usage-snapshot.json": staleSeed("2026-08-22") });
    const gappedCollector = createTokenUsageCollector(gapped.deps);
    gapped.fail();
    await gappedCollector.pollNow();
    expect(gapped.writes.length).toBe(1);
    const dropped = parseTokenUsageSnapshot(JSON.parse(gapped.writes[0] ?? ""));
    expect(dropped.unavailable).toBe(true);
    expect(dropped.dayCurves).toBeUndefined();
  });
});
