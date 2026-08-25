# Strip Rail Quota Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Xeneon strip rail so every block shares one aligned style, and quota rows show every per-provider rate window (session, weekly, and extras like claude's "Fable only") on a single bar.

**Architecture:** The daemon's quota collector always parses CodexBar's `extraRateWindows` and publishes the unselected ones as `extraWindows` on a v2 quota snapshot (the reader also accepts v1, so daemon and app update in any order). The strip's view model (`app/src/quota.ts`) reduces each provider's windows to an ordered list, picks the binding window (lowest percent remaining), and derives the tag pill, headline text, and tick positions; `app/src/rail.ts` renders them. Rail chrome tightens in `app/styles.css` (32% rail, smaller dots, one-line token rates).

**Tech Stack:** Bun + `bun:test`, strict TypeScript (both root and `app/` tsconfigs), Biome, Tauri webview (strip app), CodexBar CLI.

Spec: `docs/superpowers/specs/2026-08-25-strip-rail-quota-windows-design.md`

## Global Constraints

- Tests run with `bun test <file>`; type-check with `bun run typecheck` (covers root **and** `app/`); the full gate is `bun run check` (biome ci + build + tests).
- Biome style: 2-space indent, double quotes, semicolons, 120 columns. Strict lints include `noExplicitAny`, `noNonNullAssertion` (relaxed in `test/**`), `noConsole`, `noProcessEnv`, nursery `noFloatingPromises`.
- tsconfig strictness: `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` (use bracket access), `verbatimModuleSyntax` (use `import type`), `erasableSyntaxOnly`.
- `src/quota-snapshot.ts` is shared by the Bun core and the strip webview: no runtime-specific imports.
- TDD per task: write the failing test, watch it fail, implement minimally, watch it pass, commit.
- Commits: conventional messages (`feat:` / `fix:` / `docs:`). Never push. Commit only the files each task names.
- Dated files under `docs/superpowers/` are historical records: never edit existing ones; only add new ones.

---

### Task 1: Quota snapshot contract v2 — extraWindows

**Files:**
- Modify: `src/quota-snapshot.ts`
- Test: `test/quota-snapshot.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these):
  - `QUOTA_SNAPSHOT_SCHEMA_VERSION` = `2`
  - `QUOTA_EXTRA_WINDOWS_LIMIT` = `8`
  - `QuotaExtraWindow = { id: string; label: string; percentRemaining: number; resetAt: string | null }`
  - `ProviderQuota.extraWindows: QuotaExtraWindow[]` (always present after parsing — v1 input defaults to `[]`)
  - `QuotaSnapshot = { schemaVersion: 1 | 2; providers: ... }`
  - `parseQuotaSnapshot(value)` accepts schemaVersion 1 and 2, throws otherwise.

- [ ] **Step 1: Update the test factory and the schemaVersion rejection test**

In `test/quota-snapshot.test.ts`:

1. `claudeQuota()` gains a trailing field so it matches the new parsed shape:

```ts
const claudeQuota = (): ProviderQuota => ({
  percentRemaining: 62.5,
  resetAt: "2026-08-19T22:00:00.000Z",
  weeklyPercentRemaining: 88,
  weeklyResetAt: "2026-08-24T00:00:00.000Z",
  unavailable: false,
  fetchedAt: "2026-08-19T18:00:00.000Z",
  history: [{ fetchedAt: "2026-08-19T18:00:00.000Z", fractionRemaining: 0.625 }],
  extraWindows: [],
});
```

2. The import line gains `QUOTA_EXTRA_WINDOWS_LIMIT`:

```ts
import {
  type ProviderQuota,
  parseQuotaSnapshot,
  QUOTA_EXTRA_WINDOWS_LIMIT,
  QUOTA_HISTORY_LIMIT,
  type QuotaSnapshot,
} from "../src/quota-snapshot";
```

3. In the "rejects a non-object, a wrong schemaVersion, and a non-object providers" test, the v2 case is now valid — use 3 and the new message:

```ts
expect(() => parseQuotaSnapshot({ schemaVersion: 3, providers: {} })).toThrow("schemaVersion must be 1 or 2");
```

- [ ] **Step 2: Write the failing extraWindows tests**

Append to the `describe("parseQuotaSnapshot")` block:

```ts
  describe("extraWindows", () => {
    const fable = {
      id: "claude-weekly-scoped-fable",
      label: "Fable only",
      percentRemaining: 99,
      resetAt: "2026-08-28T01:00:00.000Z",
    };

    test("v1 providers default to no extra windows", () => {
      const parsed = parseQuotaSnapshot({ schemaVersion: 1, providers: { claude: claudeQuota() } });
      expect(parsed.providers["claude"]?.extraWindows).toEqual([]);
    });

    test("v2 round-trips extra windows", () => {
      const withExtras = { ...claudeQuota(), extraWindows: [fable] };
      const parsed = parseQuotaSnapshot({ schemaVersion: 2, providers: { claude: withExtras } });
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.providers["claude"]).toEqual(withExtras);
    });

    test("v2 requires the extraWindows array and bounds it", () => {
      const missing = {
        schemaVersion: 2,
        providers: { claude: { ...claudeQuota(), extraWindows: undefined as unknown as [] } },
      };
      expect(() => parseQuotaSnapshot(missing)).toThrow("extraWindows");
      const over = {
        schemaVersion: 2,
        providers: {
          claude: { ...claudeQuota(), extraWindows: Array.from({ length: QUOTA_EXTRA_WINDOWS_LIMIT + 1 }, () => fable) },
        },
      };
      expect(() => parseQuotaSnapshot(over)).toThrow("extraWindows");
    });

    test("rejects extras with bad percents, instants, or empty id/label", () => {
      const bad = (extra: unknown): unknown => ({
        schemaVersion: 2,
        providers: { claude: { ...claudeQuota(), extraWindows: [extra] } },
      });
      expect(() => parseQuotaSnapshot(bad({ ...fable, percentRemaining: 101 }))).toThrow("percentRemaining");
      expect(() => parseQuotaSnapshot(bad({ ...fable, resetAt: "soon" }))).toThrow("resetAt");
      expect(() => parseQuotaSnapshot(bad({ ...fable, id: "" }))).toThrow("id");
      expect(() => parseQuotaSnapshot(bad({ ...fable, label: "" }))).toThrow("label");
      expect(() => parseQuotaSnapshot(bad("fable"))).toThrow("extra window");
    });
  });
```

Note: a nested `describe` inside the existing one is valid `bun:test`. If the file's style prefers flat describes, a top-level `describe("parseQuotaSnapshot extraWindows", ...)` with the same tests is equivalent.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/quota-snapshot.test.ts`
Expected: FAIL — the new describe errors on missing `extraWindows` parsing (and possibly `QUOTA_EXTRA_WINDOWS_LIMIT` not exported yet). Existing tests still pass (v1 input parses under the current code, but the factory change makes `toEqual` comparisons fail until `extraWindows` exists — that is the failing state).

- [ ] **Step 4: Implement the contract change**

In `src/quota-snapshot.ts`:

1. Version and limit constants:

```ts
export const QUOTA_SNAPSHOT_SCHEMA_VERSION = 2;

/** Per-provider cap on published extra rate windows. */
export const QUOTA_EXTRA_WINDOWS_LIMIT = 8;
```

2. New type after `QuotaHistoryPoint`:

```ts
export type QuotaExtraWindow = {
  /** CodexBar's window id (e.g. "claude-weekly-scoped-fable"). */
  id: string;
  /** Display tag derived from CodexBar's title, provider name stripped, ≤14 code points. */
  label: string;
  /** Percent remaining, 0..100. */
  percentRemaining: number;
  /** Reset instant (canonical UTC ISO); null when unknown. */
  resetAt: string | null;
};
```

3. `ProviderQuota` gains (after `history`'s comment block):

```ts
  /** Bounded ring of session-window samples, oldest first. */
  history: QuotaHistoryPoint[];
  /** Extra rate windows not selected as session/weekly, in CodexBar order; empty for v1 input. */
  extraWindows: QuotaExtraWindow[];
```

4. `QuotaSnapshot` widens:

```ts
export type QuotaSnapshot = {
  schemaVersion: 1 | 2;
  providers: Partial<Record<QuotaProviderKey, ProviderQuota>>;
};
```

5. Extra-window parsers, next to `parseHistoryPoint`:

```ts
const parseExtraWindow = (value: unknown): QuotaExtraWindow => {
  if (!isRecord(value)) {
    return invalid("extra window must be an object");
  }
  if (typeof value["id"] !== "string" || value["id"].length === 0) {
    return invalid("extra window id must be a non-empty string");
  }
  if (typeof value["label"] !== "string" || value["label"].length === 0) {
    return invalid("extra window label must be a non-empty string");
  }
  if (!isPercent(value["percentRemaining"])) {
    return invalid("extra window percentRemaining must be a 0..100 number");
  }
  if (!isNullableIsoInstant(value["resetAt"])) {
    return invalid("extra window resetAt must be null or an ISO instant");
  }
  return {
    id: value["id"],
    label: value["label"],
    percentRemaining: value["percentRemaining"],
    resetAt: value["resetAt"],
  };
};

const parseExtraWindows = (value: unknown): QuotaExtraWindow[] => {
  if (!Array.isArray(value) || value.length > QUOTA_EXTRA_WINDOWS_LIMIT) {
    return invalid(`extraWindows must be an array of at most ${QUOTA_EXTRA_WINDOWS_LIMIT} windows`);
  }
  return value.map(parseExtraWindow);
};
```

6. `parseProviderQuota` gains a `legacy` flag (v1 input defaults extras to `[]`):

```ts
const parseProviderQuota = (value: unknown, legacy: boolean): ProviderQuota => {
  // ...existing field checks unchanged...
  return {
    percentRemaining: value["percentRemaining"],
    resetAt: value["resetAt"],
    weeklyPercentRemaining: value["weeklyPercentRemaining"],
    weeklyResetAt: value["weeklyResetAt"],
    unavailable: value["unavailable"],
    fetchedAt: value["fetchedAt"],
    history: value["history"].map(parseHistoryPoint),
    extraWindows: legacy ? [] : parseExtraWindows(value["extraWindows"]),
  };
};
```

7. `parseQuotaSnapshot` accepts both versions:

```ts
export const parseQuotaSnapshot = (value: unknown): QuotaSnapshot => {
  if (!isRecord(value)) {
    return invalid("must be an object");
  }
  const version: unknown = value["schemaVersion"];
  if (version !== 1 && version !== QUOTA_SNAPSHOT_SCHEMA_VERSION) {
    return invalid(`schemaVersion must be 1 or ${QUOTA_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!isRecord(value["providers"])) {
    return invalid("providers must be an object");
  }
  const providers: Partial<Record<QuotaProviderKey, ProviderQuota>> = {};
  for (const key of Object.keys(value["providers"])) {
    if (!QUOTA_PROVIDERS.has(key)) {
      continue;
    }
    providers[key as QuotaProviderKey] = parseProviderQuota(value["providers"][key], version === 1);
  }
  return { schemaVersion: version as 1 | 2, providers };
};
```

Also update the doc comment above `parseQuotaSnapshot`: it now reads v1 and v2 ("Throws on any other contract violation; no coercion." stays).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/quota-snapshot.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/quota-snapshot.ts test/quota-snapshot.test.ts
git commit -m "feat: quota snapshot contract v2 with extra rate windows"
```

---

### Task 2: Collector publishes extra rate windows

**Files:**
- Modify: `src/core/quota.ts`
- Modify: `test/fixtures/quota/codexbar-claude.json`
- Test: `test/quota.test.ts`

**Interfaces:**
- Consumes: `QuotaExtraWindow`, `QUOTA_EXTRA_WINDOWS_LIMIT` from `../quota-snapshot` (Task 1).
- Produces:
  - `ProviderQuotaReading = { session: QuotaWindowReading | null; weekly: QuotaWindowReading | null; extras: QuotaExtraWindow[] }`
  - `parseCodexbarUsage(body, provider?)` — same signature; the ok reading now carries `extras`.
  - `parseCodexbarWidgetSnapshot(body, nowMs)` — same signature; its readings always carry `extras: []`.

- [ ] **Step 1: Add the fable window to the claude fixture**

In `test/fixtures/quota/codexbar-claude.json`, insert after `"tertiary": null,`:

```json
      "extraRateWindows": [
        {
          "title": "Fable only",
          "id": "claude-weekly-scoped-fable",
          "window": {
            "windowMinutes": 10080,
            "usedPercent": 1,
            "resetsAt": "2026-08-28T01:00:00Z",
            "resetDescription": "Resets Aug 27 at 6pm (America/Los_Angeles)"
          }
        }
      ],
```

(The codex fixture already carries `Codex Spark 5-hour` and `Codex Spark Weekly` extras — no edit needed there.)

- [ ] **Step 2: Write the failing tests**

Append inside `describe("createQuotaCollector")` in `test/quota.test.ts`:

```ts
  test("extra rate windows publish with provider-stripped labels; selected windows stay out", async () => {
    const harness = makeHarness();
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["claude"]?.extraWindows).toEqual([
      { id: "claude-weekly-scoped-fable", label: "Fable only", percentRemaining: 99, resetAt: "2026-08-28T01:00:00.000Z" },
    ]);
    // Codex's Spark 5-hour is selected as its session window; only Spark Weekly publishes.
    expect(snapshot.providers["codex"]?.extraWindows).toEqual([
      { id: "codex-spark-weekly", label: "Spark Weekly", percentRemaining: 90, resetAt: "2026-08-27T06:04:44.000Z" },
    ]);
    expect(snapshot.providers["kimi"]?.extraWindows).toEqual([]);
  });

  test("the widget snapshot rescue publishes no extra windows", async () => {
    const harness = makeHarness({
      files: { [widgetPath(tempDir)]: widgetSnapshot("2026-08-19T17:50:00.000Z") },
    });
    harness.fail("qwen");
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["qwen"]?.extraWindows).toEqual([]);
  });

  test("extra labels cap at 14 code points and unnamed extras drop", async () => {
    const harness = makeHarness();
    harness.respondRaw("kimi", {
      exitCode: 0,
      stdout: JSON.stringify([
        {
          provider: "kimi",
          usage: {
            primary: { windowMinutes: 300, usedPercent: 16, resetsAt: "2026-08-19T19:00:00Z" },
            secondary: { windowMinutes: 10080, usedPercent: 12, resetsAt: "2026-08-26T18:00:00Z" },
            tertiary: null,
            extraRateWindows: [
              {
                id: "kimi-bonus",
                title: "Kimi Bonus Context Window",
                window: { windowMinutes: 1440, usedPercent: 50, resetsAt: "2026-08-20T18:00:00Z" },
              },
              { window: { windowMinutes: 1440, usedPercent: 10, resetsAt: null } },
            ],
          },
        },
      ]),
    });
    await createQuotaCollector(harness.deps).pollNow();
    const snapshot = parseQuotaSnapshot(JSON.parse(harness.writes()[0] ?? ""));
    expect(snapshot.providers["kimi"]?.extraWindows).toEqual([
      { id: "kimi-bonus", label: "Bonus Context…", percentRemaining: 50, resetAt: "2026-08-20T18:00:00.000Z" },
    ]);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/quota.test.ts`
Expected: FAIL — the new tests see `extraWindows: []` (or a contract throw) until the collector publishes extras.

- [ ] **Step 4: Implement extras collection**

In `src/core/quota.ts`:

1. Import the new contract pieces (extend the existing `../quota-snapshot` import):

```ts
import {
  type ProviderQuota,
  parseQuotaSnapshot,
  QUOTA_EXTRA_WINDOWS_LIMIT,
  QUOTA_HISTORY_LIMIT,
  QUOTA_PROVIDER_KEYS,
  type QuotaExtraWindow,
  type QuotaProviderKey,
  type QuotaSnapshot,
} from "../quota-snapshot";
```

2. Extend the reading type:

```ts
export type ProviderQuotaReading = {
  /** Null when the provider reports no session-class window (e.g. codex weekly-only). */
  session: QuotaWindowReading | null;
  weekly: QuotaWindowReading | null;
  /** Extra windows not selected as session/weekly (claude's fable, codex's spark weekly). */
  extras: QuotaExtraWindow[];
};
```

3. After the `RawCodexbarWindow` type, add extra parsing and label derivation:

```ts
type RawCodexbarExtra = { id: string | null; title: string | null; window: RawCodexbarWindow };

const parseCodexbarExtra = (value: unknown): RawCodexbarExtra | null => {
  if (!isRecord(value)) {
    return null;
  }
  const window = parseCodexbarWindow(value["window"]);
  if (window === null) {
    return null;
  }
  const id = value["id"];
  const title = value["title"];
  return {
    id: typeof id === "string" && id.length > 0 ? id : null,
    title: typeof title === "string" && title.length > 0 ? title : null,
    window,
  };
};

/** CodexBar's provider id → the rail's display name, for stripping it out of window titles. */
const CODEXBAR_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  zai: "GLM",
  alibabatokenplan: "Qwen",
};

const EXTRA_WINDOW_LABEL_MAX_CODE_POINTS = 14;

/** Extra-window tag: title minus the provider's own name, capped at 14 code points with an ellipsis. */
const extraWindowLabel = (title: string, codexbarProvider: string): string => {
  const displayName = CODEXBAR_DISPLAY_NAMES[codexbarProvider] ?? codexbarProvider;
  const stripped = title.replace(new RegExp(`^${displayName}\\s+`, "iu"), "").trim();
  const source = stripped.length === 0 ? title.trim() : stripped;
  const codePoints = [...source];
  if (codePoints.length <= EXTRA_WINDOW_LABEL_MAX_CODE_POINTS) {
    return source;
  }
  return `${codePoints.slice(0, EXTRA_WINDOW_LABEL_MAX_CODE_POINTS).join("").trimEnd()}…`;
};
```

4. `classifyCodexbarWindows` returns the selected raw windows (identity matters — extras exclude by reference):

```ts
type WindowSelection = { session: RawCodexbarWindow | null; weekly: RawCodexbarWindow | null };

const classifyCodexbarWindows = (windows: readonly RawCodexbarWindow[]): WindowSelection | null => {
  let weekly: RawCodexbarWindow | null = null;
  let session: RawCodexbarWindow | null = null;
  for (const window of windows) {
    if (window.windowMinutes >= DAY_WINDOW_MINUTES) {
      if (weekly === null || window.windowMinutes > weekly.windowMinutes) {
        weekly = window;
      }
    } else if (session === null || window.windowMinutes < session.windowMinutes) {
      session = window;
    }
  }
  if (session === null && weekly === null) {
    return null;
  }
  return { session, weekly };
};
```

5. Rewrite the tail of `parseCodexbarUsage` (everything after `const usage = entry["usage"];`), replacing the old windows/extras/classify block:

```ts
  const usage = entry["usage"];
  const providerId = provider ?? (typeof entry["provider"] === "string" ? entry["provider"] : "");
  const windows: RawCodexbarWindow[] = [];
  for (const key of ["primary", "secondary", "tertiary"] as const) {
    const window = parseCodexbarWindow(usage[key]);
    if (window !== null) {
      windows.push(window);
    }
  }
  // Extra rate windows always parse: the session/weekly selection draws from
  // them (codex's Spark 5-hour is its session window), and the rest publish.
  const rawExtras: RawCodexbarExtra[] = [];
  if (Array.isArray(usage["extraRateWindows"])) {
    for (const item of usage["extraRateWindows"]) {
      const extra = parseCodexbarExtra(item);
      if (extra !== null) {
        rawExtras.push(extra);
      }
    }
  }
  const selected = classifyCodexbarWindows([...windows, ...rawExtras.map((extra) => extra.window)]);
  if (selected === null) {
    return { kind: "invalid" };
  }
  const extras: QuotaExtraWindow[] = [];
  for (const extra of rawExtras) {
    if (extra.window === selected.session || extra.window === selected.weekly) {
      continue;
    }
    const name = extra.id ?? extra.title;
    if (name === null) {
      continue; // an unnamed window can't be tagged
    }
    extras.push({
      id: name,
      label: extraWindowLabel(extra.title ?? name, providerId),
      ...toWindowReading(extra.window),
    });
    if (extras.length >= QUOTA_EXTRA_WINDOWS_LIMIT) {
      break;
    }
  }
  return {
    kind: "ok",
    reading: {
      session: selected.session === null ? null : toWindowReading(selected.session),
      weekly: selected.weekly === null ? null : toWindowReading(selected.weekly),
      extras,
    },
  };
```

(The old code's "Codex can report primary: null with the 5-hour data under extraRateWindows" comment and conditional scan are deleted — extras now always participate.)

6. Widget fallback: in `parseCodexbarWidgetSnapshot`, the `readings.set(...)` becomes:

```ts
    const selection = classifyCodexbarWindows(windows);
    if (selection !== null) {
      readings.set(entry["provider"], {
        session: selection.session === null ? null : toWindowReading(selection.session),
        weekly: selection.weekly === null ? null : toWindowReading(selection.weekly),
        extras: [], // the widget snapshot carries no extraRateWindows
      });
    }
```

(The local was previously named `reading`; rename to `selection` for clarity.)

7. `emptyQuota` gains the field:

```ts
const emptyQuota = (): ProviderQuota => ({
  percentRemaining: null,
  resetAt: null,
  weeklyPercentRemaining: null,
  weeklyResetAt: null,
  unavailable: true,
  fetchedAt: null,
  history: [],
  extraWindows: [],
});
```

8. In `pollProvider`, the success-built quota gains extras:

```ts
      const quota: ProviderQuota = {
        percentRemaining: outcome.reading.session?.percentRemaining ?? null,
        resetAt: outcome.reading.session?.resetAt ?? null,
        weeklyPercentRemaining: outcome.reading.weekly?.percentRemaining ?? null,
        weeklyResetAt: outcome.reading.weekly?.resetAt ?? null,
        unavailable: false,
        fetchedAt,
        history,
        extraWindows: outcome.reading.extras,
      };
```

(The failure path's `{ ...state.quota, unavailable: true }` already preserves last-good extras.)

9. Update the module docblock: the clause "and usage.extraRateWindows is scanned when the main trio yields no session window (codex reports primary: null, Spark windows live there)" becomes "and usage.extraRateWindows always participates: an extra can be selected as the session window (codex reports primary: null, its Spark 5-hour lives there), and unselected extras publish as extraWindows with provider-name-stripped labels".

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/quota.test.ts test/quota-snapshot.test.ts && bun run typecheck`
Expected: PASS. Note the existing "publishes all five providers" test uses `toMatchObject` — it passes unchanged; the seeded-v1-file test exercises the v1 reader path.

- [ ] **Step 6: Commit**

```bash
git add src/core/quota.ts test/quota.test.ts test/fixtures/quota/codexbar-claude.json
git commit -m "feat: collect codexbar extra rate windows into the quota snapshot"
```

---

### Task 3: Strip view model — binding window, tags, ticks

**Files:**
- Modify: `app/src/quota.ts`
- Test: `test/strip-quota.test.ts`

**Interfaces:**
- Consumes: `ProviderQuota.extraWindows` (Task 1 contract).
- Produces (Task 4's rail renderer uses exactly these):
  - `QuotaWindowModel = { tag: string; percentRemaining: number; resetAtMs: number | null }`
  - `QuotaPanelModel = { provider: QuotaProviderKey; windows: readonly QuotaWindowModel[]; bindingIndex: number | null; state: QuotaPanelState; fetchedAtMs: number | null; history: readonly QuotaHistoryPoint[] }`
  - `reduceQuotaRead(read, now): QuotaPanelModel[]` — unchanged signature.
  - `bindingWindow(model): QuotaWindowModel | null`
  - `selectBindingIndex(windows): number | null`
  - `formatBindingTag(model): string | null`
  - `formatBindingPercent(model): string`
  - `formatBindingNote(model, now): string`
  - `tickPercents(model): number[]`
  - Kept unchanged: `formatPercentRemaining`, `formatResetCountdown`, `quotaBarColor`, `STALE_QUOTA_AGE_MS`, `QuotaPanelState`.
  - Removed: `headlinePercent`, `headlineResetAtMs`, `formatSessionPercent`, `formatSessionNote`, `formatWeeklySummary`.

- [ ] **Step 1: Rewrite the failing test file**

Replace `test/strip-quota.test.ts` wholesale with:

```ts
import { describe, expect, test } from "bun:test";
import {
  bindingWindow,
  formatBindingNote,
  formatBindingPercent,
  formatBindingTag,
  formatPercentRemaining,
  formatResetCountdown,
  type QuotaPanelModel,
  type QuotaWindowModel,
  quotaBarColor,
  reduceQuotaRead,
  selectBindingIndex,
  STALE_QUOTA_AGE_MS,
  tickPercents,
} from "../app/src/quota";
import type { ProviderQuota } from "../src/quota-snapshot";

const NOW = Date.parse("2026-08-19T18:00:00.000Z");

const quota = (overrides: Partial<ProviderQuota> = {}): ProviderQuota => ({
  percentRemaining: 62.5,
  resetAt: "2026-08-19T22:00:00.000Z",
  weeklyPercentRemaining: 88,
  weeklyResetAt: "2026-08-24T00:00:00.000Z",
  unavailable: false,
  fetchedAt: "2026-08-19T18:00:00.000Z",
  history: [],
  extraWindows: [],
  ...overrides,
});

const read = (providers: Record<string, ProviderQuota>): { mtimeMs: number; contents: string } => ({
  mtimeMs: NOW,
  contents: JSON.stringify({ schemaVersion: 1, providers }),
});

const windowModel = (tag: string, percentRemaining: number, resetAtMs: number | null = null): QuotaWindowModel => ({
  tag,
  percentRemaining,
  resetAtMs,
});

const model = (overrides: Partial<QuotaPanelModel> = {}): QuotaPanelModel => ({
  provider: "claude",
  windows: [windowModel("session", 62.5, Date.parse("2026-08-19T22:00:00.000Z")), windowModel("weekly", 88, Date.parse("2026-08-24T00:00:00.000Z"))],
  bindingIndex: 0,
  state: "ok",
  fetchedAtMs: NOW,
  history: [],
  ...overrides,
});

describe("reduceQuotaRead", () => {
  test("a missing or unparseable read yields no panels", () => {
    expect(reduceQuotaRead(null, NOW)).toEqual([]);
    expect(reduceQuotaRead({ mtimeMs: NOW, contents: "junk" }, NOW)).toEqual([]);
  });

  test("providers present map to ok panels with parsed windows in contract order", () => {
    const panels = reduceQuotaRead(read({ claude: quota() }), NOW);
    expect(panels.length).toBe(1);
    expect(panels[0]).toMatchObject({ provider: "claude", state: "ok", bindingIndex: 0 });
    expect(panels[0]?.windows).toEqual([
      { tag: "session", percentRemaining: 62.5, resetAtMs: Date.parse("2026-08-19T22:00:00.000Z") },
      { tag: "weekly", percentRemaining: 88, resetAtMs: Date.parse("2026-08-24T00:00:00.000Z") },
    ]);
  });

  test("a v2 read maps extra windows after session and weekly, and the minimum binds", () => {
    const contents = JSON.stringify({
      schemaVersion: 2,
      providers: {
        claude: quota({
          percentRemaining: 96,
          weeklyPercentRemaining: 49,
          extraWindows: [
            { id: "claude-weekly-scoped-fable", label: "Fable only", percentRemaining: 99, resetAt: "2026-08-28T01:00:00.000Z" },
          ],
        }),
      },
    });
    const panels = reduceQuotaRead({ mtimeMs: NOW, contents }, NOW);
    expect(panels[0]?.windows.map((entry) => entry.tag)).toEqual(["session", "weekly", "Fable only"]);
    expect(panels[0]?.bindingIndex).toBe(1);
  });

  test("a failed provider with last-good data is unavailable; an old success is stale", () => {
    expect(reduceQuotaRead(read({ claude: quota({ unavailable: true }) }), NOW)[0]?.state).toBe("unavailable");
    const oldFetch = new Date(NOW - STALE_QUOTA_AGE_MS - 1).toISOString();
    expect(reduceQuotaRead(read({ claude: quota({ fetchedAt: oldFetch }) }), NOW)[0]?.state).toBe("stale");
  });

  test("a provider that never fetched is unavailable with no windows", () => {
    const panel = reduceQuotaRead(
      read({
        codex: quota({ percentRemaining: null, resetAt: null, weeklyPercentRemaining: null, weeklyResetAt: null, fetchedAt: null, unavailable: true }),
      }),
      NOW,
    )[0];
    expect(panel).toMatchObject({ provider: "codex", state: "unavailable", fetchedAtMs: null, bindingIndex: null });
    expect(panel?.windows).toEqual([]);
  });

  test("panels follow the contract provider order across all five providers", () => {
    const panels = reduceQuotaRead(
      read({ qwen: quota(), zai: quota(), kimi: quota(), codex: quota(), claude: quota() }),
      NOW,
    );
    expect(panels.map((panel) => panel.provider)).toEqual(["claude", "codex", "kimi", "zai", "qwen"]);
  });
});

describe("selectBindingIndex", () => {
  test("the lowest percent binds and ties keep the earlier window", () => {
    const windows = [windowModel("session", 88), windowModel("weekly", 62.5), windowModel("Fable only", 62.5)];
    expect(selectBindingIndex(windows)).toBe(1);
    expect(selectBindingIndex([windowModel("weekly", 5)])).toBe(0);
    expect(selectBindingIndex([])).toBeNull();
  });
});

describe("formatBindingTag", () => {
  test("several windows say which binds; a single window is a bare name; none is null", () => {
    expect(formatBindingTag(model())).toBe("session binds");
    expect(formatBindingTag(model({ windows: [windowModel("weekly", 88)], bindingIndex: 0 }))).toBe("weekly");
    expect(formatBindingTag(model({ windows: [], bindingIndex: null }))).toBeNull();
  });
});

describe("formatBindingPercent and formatBindingNote", () => {
  test("ok panels show the binding percent and its countdown", () => {
    expect(formatBindingPercent(model())).toBe("63%");
    expect(formatBindingNote(model(), NOW)).toBe("4h");
  });

  test("no windows render an em dash and no note", () => {
    const bare = model({ windows: [], bindingIndex: null });
    expect(formatBindingPercent(bare)).toBe("—");
    expect(formatBindingNote(bare, NOW)).toBe("");
  });

  test("the binding window drives both texts", () => {
    const bound = model({
      windows: [windowModel("session", 96, NOW + 35 * 60_000), windowModel("weekly", 49, NOW + 42 * 3_600_000)],
      bindingIndex: 1,
    });
    expect(formatBindingPercent(bound)).toBe("49%");
    expect(formatBindingNote(bound, NOW)).toBe("42h");
    expect(bindingWindow(bound)?.tag).toBe("weekly");
  });

  test("unavailable panels with last-good data show the last-update age", () => {
    expect(formatBindingNote(model({ state: "unavailable", fetchedAtMs: NOW - 12 * 60_000 }), NOW)).toBe("updated 12m ago");
  });

  test("unavailable panels without data say so", () => {
    expect(formatBindingNote(model({ state: "unavailable", fetchedAtMs: null, windows: [], bindingIndex: null }), NOW)).toBe(
      "unavailable",
    );
  });

  test("a binding window without a reset instant has no note; past reset says resetting", () => {
    const noReset = model({ windows: [windowModel("session", 100)], bindingIndex: 0 });
    expect(formatBindingNote(noReset, NOW)).toBe("");
    const resetAtMs = NOW + 4 * 3_600_000;
    const resetting = model({ windows: [windowModel("session", 10, resetAtMs)], bindingIndex: 0 });
    expect(formatBindingNote(resetting, resetAtMs)).toBe("resetting…");
    expect(formatBindingNote(resetting, resetAtMs + 1)).toBe("resetting…");
  });
});

describe("tickPercents", () => {
  test("every non-binding window ticks; single and empty lists tick nothing", () => {
    const multi = model({
      windows: [windowModel("session", 97), windowModel("weekly", 93), windowModel("Fable only", 99)],
      bindingIndex: 1,
    });
    expect(tickPercents(multi)).toEqual([97, 99]);
    expect(tickPercents(model({ windows: [windowModel("weekly", 5)], bindingIndex: 0 }))).toEqual([]);
    expect(tickPercents(model({ windows: [], bindingIndex: null }))).toEqual([]);
  });
});

describe("formatResetCountdown", () => {
  const resetAt = NOW + 3 * 3_600_000 + 12 * 60_000;
  test("hours and minutes, bare hours, bare minutes, days, and elapsed", () => {
    expect(formatResetCountdown(resetAt, NOW)).toBe("3h 12m");
    expect(formatResetCountdown(NOW + 2 * 3_600_000, NOW)).toBe("2h");
    expect(formatResetCountdown(NOW + 42 * 60_000, NOW)).toBe("42m");
    expect(formatResetCountdown(NOW + 23 * 3_600_000, NOW)).toBe("23h");
    expect(formatResetCountdown(NOW + 24 * 3_600_000, NOW)).toBe("1d");
    expect(formatResetCountdown(NOW + 43 * 3_600_000, NOW)).toBe("2d");
    expect(formatResetCountdown(NOW + 49 * 3_600_000, NOW)).toBe("2d");
    expect(formatResetCountdown(NOW - 1, NOW)).toBe("resetting…");
  });
});

describe("formatPercentRemaining and quotaBarColor", () => {
  test("percent rounds to a whole number", () => {
    expect(formatPercentRemaining(62.5)).toBe("63%");
  });

  test("green above 25, amber from 10, red below 10", () => {
    expect(quotaBarColor(26)).toBe("#4ade80");
    expect(quotaBarColor(25)).toBe("#ffb020");
    expect(quotaBarColor(10)).toBe("#ffb020");
    expect(quotaBarColor(9)).toBe("#ff4d67");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/strip-quota.test.ts`
Expected: FAIL — the new imports (`bindingWindow`, `formatBindingTag`, …) do not exist yet.

- [ ] **Step 3: Rewrite the view model**

Replace `app/src/quota.ts` wholesale with:

```ts
/**
 * Pure view-model for the rail's quota panels: reduce the quota-snapshot read
 * to per-provider window lists (session, weekly, extras), pick the binding
 * window (the lowest percent remaining), and derive the tag pill, headline
 * texts, and bar ticks. Kept DOM-free so the logic is unit-testable; the
 * rendering layer is app/src/rail.ts.
 */

import {
  type ProviderQuota,
  parseQuotaSnapshot,
  QUOTA_PROVIDER_KEYS,
  type QuotaHistoryPoint,
  type QuotaProviderKey,
  type QuotaSnapshot,
} from "../../src/quota-snapshot";
import type { SnapshotPayload } from "./bridge";

/** Three missed 120s collector passes without a success marks the panel stale. */
export const STALE_QUOTA_AGE_MS = 3 * 120_000;

export type QuotaPanelState = "ok" | "stale" | "unavailable";

export type QuotaWindowModel = {
  /** Pill tag: "session", "weekly", or an extra window's published label. */
  tag: string;
  percentRemaining: number;
  resetAtMs: number | null;
};

export type QuotaPanelModel = {
  provider: QuotaProviderKey;
  /** Session, weekly, then extras in published order; empty when never fetched. */
  windows: readonly QuotaWindowModel[];
  /** Index of the binding (lowest-percent) window; null when windows is empty. */
  bindingIndex: number | null;
  state: QuotaPanelState;
  fetchedAtMs: number | null;
  history: readonly QuotaHistoryPoint[];
};

const parseInstant = (value: string | null): number | null => (value === null ? null : Date.parse(value));

const panelState = (quota: ProviderQuota, fetchedAtMs: number | null, now: number): QuotaPanelState => {
  if (quota.unavailable || fetchedAtMs === null) {
    return "unavailable";
  }
  return now - fetchedAtMs > STALE_QUOTA_AGE_MS ? "stale" : "ok";
};

/** The lowest percent remaining binds; ties keep the earlier window (session > weekly > extras). */
export const selectBindingIndex = (windows: readonly QuotaWindowModel[]): number | null => {
  let best: number | null = null;
  for (const [index, entry] of windows.entries()) {
    if (best === null || entry.percentRemaining < (windows[best]?.percentRemaining ?? Number.POSITIVE_INFINITY)) {
      best = index;
    }
  }
  return best;
};

const panelModel = (provider: QuotaProviderKey, quota: ProviderQuota, now: number): QuotaPanelModel => {
  const fetchedAtMs = parseInstant(quota.fetchedAt);
  const windows: QuotaWindowModel[] = [];
  if (quota.percentRemaining !== null) {
    windows.push({ tag: "session", percentRemaining: quota.percentRemaining, resetAtMs: parseInstant(quota.resetAt) });
  }
  if (quota.weeklyPercentRemaining !== null) {
    windows.push({ tag: "weekly", percentRemaining: quota.weeklyPercentRemaining, resetAtMs: parseInstant(quota.weeklyResetAt) });
  }
  for (const extra of quota.extraWindows) {
    windows.push({ tag: extra.label, percentRemaining: extra.percentRemaining, resetAtMs: parseInstant(extra.resetAt) });
  }
  return {
    provider,
    windows,
    bindingIndex: selectBindingIndex(windows),
    state: panelState(quota, fetchedAtMs, now),
    fetchedAtMs,
    history: quota.history,
  };
};

export const reduceQuotaRead = (read: SnapshotPayload | null, now: number): QuotaPanelModel[] => {
  if (read === null) {
    return [];
  }
  let snapshot: QuotaSnapshot;
  try {
    snapshot = parseQuotaSnapshot(JSON.parse(read.contents));
  } catch {
    return [];
  }
  const models: QuotaPanelModel[] = [];
  for (const provider of QUOTA_PROVIDER_KEYS) {
    const quota = snapshot.providers[provider];
    if (quota !== undefined) {
      models.push(panelModel(provider, quota, now));
    }
  }
  return models;
};

export const formatPercentRemaining = (percent: number): string => `${Math.round(percent)}%`;

export const formatResetCountdown = (resetAtMs: number, now: number): string => {
  const remainingMs = resetAtMs - now;
  if (remainingMs <= 0) {
    return "resetting…";
  }
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) {
    return `${Math.round(hours / 24)}d`;
  }
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
};

/** The binding window, or null when the provider has never fetched. */
export const bindingWindow = (model: QuotaPanelModel): QuotaWindowModel | null =>
  model.bindingIndex === null ? null : (model.windows[model.bindingIndex] ?? null);

/** Pill text: "<name> binds" when several windows compete, the bare name otherwise, null when no data. */
export const formatBindingTag = (model: QuotaPanelModel): string | null => {
  const binding = bindingWindow(model);
  if (binding === null) {
    return null;
  }
  return model.windows.length > 1 ? `${binding.tag} binds` : binding.tag;
};

/** Bright right text of the head line: binding percent, em dash when never fetched. */
export const formatBindingPercent = (model: QuotaPanelModel): string => {
  const binding = bindingWindow(model);
  return binding === null ? "—" : formatPercentRemaining(binding.percentRemaining);
};

/** Muted right text of the head line: unavailable age, binding reset countdown, or empty. */
export const formatBindingNote = (model: QuotaPanelModel, now: number): string => {
  const binding = bindingWindow(model);
  if (model.state === "unavailable") {
    if (model.fetchedAtMs === null || binding === null) {
      return "unavailable";
    }
    const ageMinutes = Math.max(0, Math.round((now - model.fetchedAtMs) / 60_000));
    return ageMinutes < 1 ? "updated just now" : `updated ${ageMinutes}m ago`;
  }
  if (binding === null || binding.resetAtMs === null) {
    return "";
  }
  if (binding.resetAtMs <= now) {
    return "resetting…";
  }
  return formatResetCountdown(binding.resetAtMs, now);
};

/** Percents of the non-binding windows, drawn as ticks on the bar. */
export const tickPercents = (model: QuotaPanelModel): number[] => {
  if (model.bindingIndex === null) {
    return [];
  }
  return model.windows.filter((_, index) => index !== model.bindingIndex).map((entry) => entry.percentRemaining);
};

/** Fill hue follows remaining headroom on the strip's existing status palette. */
export const quotaBarColor = (percentRemaining: number): string => {
  if (percentRemaining > 25) {
    return "#4ade80";
  }
  if (percentRemaining >= 10) {
    return "#ffb020";
  }
  return "#ff4d67";
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/strip-quota.test.ts`
Expected: PASS. Then `bun run typecheck` — EXPECTED FAILURE here: `app/src/rail.ts` still imports the removed helpers. That error is Task 4's job; do not "fix" it by keeping the old exports.

- [ ] **Step 5: Commit**

```bash
git add app/src/quota.ts test/strip-quota.test.ts
git commit -m "feat: strip quota view model binds the lowest window"
```

(The repo is briefly red under `bun run typecheck` between Tasks 3 and 4 — accepted ordering: the view-model change and its renderer are separate reviewable units, and Task 4 lands immediately after. Run them back-to-back.)

---

### Task 4: Rail rendering — tag pill, bar ticks, one-line rates

**Files:**
- Modify: `app/src/rail.ts`

**Interfaces:**
- Consumes (Task 3): `bindingWindow`, `formatBindingNote`, `formatBindingPercent`, `formatBindingTag`, `tickPercents`, `quotaBarColor`, `QuotaPanelModel`.
- Produces: nothing new (DOM structure consumed by `app/styles.css` classes `quota-tag`, `quota-tick`, `tokens-rate-sep` in Task 5).

No automated test file exists for `rail.ts` by project convention (the DOM layer is thin; logic lives in the view model). Verification is typecheck plus the full suite staying green.

- [ ] **Step 1: Update the import and the quota section**

In `app/src/rail.ts`, replace the `./quota` import with:

```ts
import {
  bindingWindow,
  formatBindingNote,
  formatBindingPercent,
  formatBindingTag,
  type QuotaPanelModel,
  quotaBarColor,
  tickPercents,
} from "./quota";
```

Replace the whole `quotaSection` function (and its doc comment) with:

```ts
/** Two-line compact panel: head (chip, label, binding-window tag, percent + note) over a bar that fills to the binding window and ticks every other window. */
const quotaSection = (model: QuotaPanelModel, nowMs: number): HTMLElement => {
  const section = document.createElement("section");
  section.className = "rail-quota";
  section.dataset["provider"] = model.provider;
  section.dataset["state"] = model.state;

  const head = document.createElement("div");
  head.className = "quota-head";
  const chip = document.createElement("span");
  chip.className = "quota-chip";
  chip.dataset["provider"] = model.provider;
  chip.textContent = PROVIDER_CHIP_LETTERS[model.provider];
  const name = document.createElement("span");
  name.textContent = PROVIDER_LABELS[model.provider];
  head.append(chip, name);
  const tag = formatBindingTag(model);
  if (tag !== null) {
    const pill = document.createElement("span");
    pill.className = "quota-tag";
    pill.textContent = tag;
    head.append(pill);
  }
  const right = document.createElement("span");
  right.className = "quota-right";
  if (model.state === "unavailable") {
    const note = document.createElement("span");
    note.className = "quota-note";
    note.textContent = formatBindingNote(model, nowMs);
    right.append(note);
  } else {
    const pct = document.createElement("span");
    pct.className = "quota-pct";
    pct.textContent = formatBindingPercent(model);
    right.append(pct);
    const note = formatBindingNote(model, nowMs);
    if (note !== "") {
      const noteSpan = document.createElement("span");
      noteSpan.className = "quota-note";
      noteSpan.textContent = `· ${note}`;
      right.append(noteSpan);
    }
  }
  head.append(right);

  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const binding = bindingWindow(model);
  if (binding !== null) {
    const fill = document.createElement("div");
    fill.className = "quota-bar-fill";
    fill.style.width = `${Math.max(0, Math.min(100, binding.percentRemaining))}%`;
    fill.style.background = quotaBarColor(binding.percentRemaining);
    bar.append(fill);
    for (const percent of tickPercents(model)) {
      const tick = document.createElement("span");
      tick.className = "quota-tick";
      tick.style.left = `${Math.max(0, Math.min(100, percent))}%`;
      bar.append(tick);
    }
  }
  section.append(head, bar);
  return section;
};
```

- [ ] **Step 2: Merge the token rate lines**

Replace `rateLineElement` and `tokensSection` with:

```ts
const rateSpan = (line: TokenUsageRateLine, unit: string): HTMLSpanElement => {
  const span = document.createElement("span");
  span.dataset["trend"] = line.trend;
  const arrow = line.trend === "up" ? "↑" : line.trend === "down" ? "↓" : "→";
  span.textContent = `${arrow} ${formatTokensCompact(line.tokens)}/${unit}`;
  return span;
};

const tokensSection = (model: TokenUsageRailModel): HTMLElement | null => {
  if (model.state === "hidden") {
    return null;
  }
  const section = document.createElement("section");
  section.className = "rail-tokens";
  section.dataset["state"] = model.state;
  const today = document.createElement("div");
  today.className = "tokens-today";
  today.textContent = `${formatTokensCompact(model.totalTokens)} today`;
  const rates = document.createElement("div");
  rates.className = "tokens-rate";
  const separator = document.createElement("span");
  separator.className = "tokens-rate-sep";
  separator.textContent = "·";
  rates.append(rateSpan(model.hour, "hr"), separator, rateSpan(model.tenMin, "10m"));
  section.append(today, rates);
  return section;
};
```

Also update the file's header comment: the rail's quota description becomes "per-provider quota panels (binding window, tag pill, bar ticks)".

- [ ] **Step 3: Typecheck and run the suite**

Run: `bun run typecheck && bun test`
Expected: PASS — the Task 3 breakage is resolved and no test regressed.

- [ ] **Step 4: Commit**

```bash
git add app/src/rail.ts
git commit -m "feat: strip rail quota rows show the binding window and ticks"
```

---

### Task 5: Rail chrome — 32% width, smaller dots, tag/tick styles

**Files:**
- Modify: `app/styles.css`

**Interfaces:**
- Consumes: DOM classes `quota-tag`, `quota-tick`, `tokens-rate-sep` from Task 4.
- Produces: nothing code-visible.

- [ ] **Step 1: Make the edits**

In `app/styles.css`:

1. `#strip`: `grid-template-columns: 1fr 24%;` → `grid-template-columns: 1fr 32%;`

2. `.dot`: `width: 1vw; height: 1vw;` → `width: 0.5vw; height: 0.5vw;`

3. `.page-dot`: `padding: 0.4vw;` → `padding: 0.2vw;` and `font-size: 1.1vw;` → `font-size: 0.6vw;`

4. Replace the three `.tokens-rate` rules with the merged-line styles:

```css
.tokens-rate {
  display: flex;
  gap: 0.5vw;
  color: #94a3b8;
  font-size: 1.2vw;
}
.tokens-rate [data-trend="up"] {
  color: #4ade80;
}
.tokens-rate [data-trend="down"] {
  color: #ff4d67;
}
.tokens-rate-sep {
  color: #4a5568;
}
```

5. Delete the now-unused `.quota-weekly` rule.

6. Add `position: relative;` to the `.quota-bar` rule, then append after `.quota-bar-fill`:

```css
.quota-tag {
  flex: none;
  padding: 0.1vh 0.4vw;
  border-radius: 0.3vw;
  background: #1c2430;
  color: #94a3b8;
  font-size: 0.95vw;
  line-height: 1.3;
  white-space: nowrap;
}
.quota-tick {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0.15vw;
  background: rgb(232 238 247 / 0.75);
  transform: translateX(-50%);
}
```

- [ ] **Step 2: Run the full gate plus the app bundle**

Run: `bun run check && bun run build:app`
Expected: PASS — Biome clean, both typechecks pass, all tests pass, the webview bundles.

- [ ] **Step 3: Commit**

```bash
git add app/styles.css
git commit -m "feat: widen the strip rail to 32% and tighten its chrome"
```

---

### Task 6: Docs — design.md and AGENTS.md

**Files:**
- Modify: `docs/design.md` (rail quota section)
- Modify: `AGENTS.md` (quota paragraph, token-usage paragraph)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `docs/design.md`**

Find the rail quota section (search for "Quota panels"). Update it to the new visible contract: quota rows carry a tag pill naming the binding window (`session` / `weekly` / extra label, with a ` binds` suffix when several windows compete); the bar fills to the binding window with a 2px neutral tick (`#E8EEF7` at 75%) at every other window's percent; the rail is 32% of the strip width; health dot 0.5vw; pager dots 0.6vw type; token rates render as one line (`↑ 4.7M/hr · ↑ 1.3M/10m`), each rate span colored by its own trend, separator muted.

- [ ] **Step 2: Update `AGENTS.md`**

In the quota paragraph (starts "Quota panels (claude, codex, kimi, GLM/zai, Qwen)"):

- The row description becomes: "compact two-line rows (head: chip, label, a tag pill naming the binding window, percent remaining plus its reset countdown; second line: the status-palette bar filled to the binding window with a neutral tick at every other window's percent — no sparkline)". Add the binding rule: "the binding window is the lowest percent remaining (ties: session > weekly > extras)".
- The classification clause "with `usage.extraRateWindows` scanned when the main trio has no session window (codex reports `primary: null`, Spark windows live there)" becomes: "`usage.extraRateWindows` always participates — an extra can be selected as the session window (codex's Spark 5-hour), and unselected extras publish as `extraWindows` (cap 8) with provider-name-stripped labels (claude's `Fable only`, codex's `Spark Weekly`); the widget-snapshot fallback publishes none".
- The contract mention becomes: "publishes `quota-snapshot.json` (`schemaVersion` 2; the strip's reader also accepts v1, so daemon and app update in either order; bounded history ring of session-window samples; contract in `src/quota-snapshot.ts`)".

In the token-usage paragraph, the rendering sentence gains the one-line rates: "the strip renders today's total plus both rolling rates on one line (`↑ 4.7M/hr · ↑ 1.3M/10m`), each rate colored by its own trend".

In the strip paragraph (starts "The Xeneon strip app is a third snapshot consumer"), note the rail occupies 32% of the strip width.

- [ ] **Step 3: Verify and commit**

Run: `bun run check`
Expected: PASS (docs-only change, but confirm the tree is clean).

```bash
git add docs/design.md AGENTS.md
git commit -m "docs: strip rail binding-window quota contract"
```

---

## Deploy (post-plan, manual)

Daemon and strip app update independently; either order works (v1-tolerant reader):

```bash
bun scripts/install-local.ts   # daemon + plugin
bun run install:app            # strip app into /Applications
```

## Self-Review Notes

- Spec coverage: rail layout → Tasks 4+5; binding rule/tags → Task 3; contract v2 → Task 1; collector → Task 2; tests → Tasks 1–3; docs → Task 6; non-goals honored (no tap interaction, no pace/credits/daily-tokens data, history ring untouched, keypad untouched).
- The known red-in-between state after Task 3 is deliberate and called out in that task; Tasks 3+4 run back-to-back.
- `test/fixtures/quota/quota-snapshot.json` stays at schemaVersion 1 on purpose — the round-trip test then covers the v1 read path forever.
