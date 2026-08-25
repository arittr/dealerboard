# Strip rail token-usage block — design

Replace the Xeneon strip rail's clock (`app/src/rail.ts` `rail-clock` section)
with glorp-style token metrics: total tokens today, tokens/hour, and
tokens/10-minutes, with trend arrows. Reference implementation:
`~/projects/glorp` (its TUI "today" panel and companion HUD).

## Architecture

Follows the quota-panel precedent exactly: the daemon owns a collector that
publishes a sidecar snapshot file; the strip is a pure consumer that reads it
through a Tauri command and renders from a pure view-model.
`snapshot-v2.json` and `src/protocol.ts` stay untouched.

```
agentsview (CLI) → src/core/token-usage.ts → token-usage-snapshot.json
     → read_token_usage_snapshot (Tauri) → app/src/token-usage.ts → rail.ts
```

## Data source

`agentsview` (installed at `/opt/homebrew/bin/agentsview`; glorp shells out to
the same helper). Command, run every 30s with a 15s timeout:

```sh
agentsview usage daily --json --timezone America/Los_Angeles --since <today-LA>
```

- Output is usage schema v4; any other `schema_version` counts as a failed
  poll.
- From the `daily[]` row whose `date` equals today's LA date:
  `total = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens`
  (glorp's `tokenmaxxing_total_v1` contract — cache reads count fully,
  reasoning output excluded). Per-agent breakdowns are not used (aggregate
  only).
- "Today" is the America/Los_Angeles calendar date, computed with
  `Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" })`
  (YYYY-MM-DD) — no hand-rolled DST like glorp's Rust.
- A missing `daily[]` row for today means zero usage so far: total 0, still a
  successful poll.

## Rates (deliberate simplification vs glorp)

glorp smears deltas into 10-minute buckets to feed its pet animation. We only
need numbers, so the collector instead keeps a ring of cumulative samples and
the strip differences them — exact window sums, much simpler:

- Ring: `{ fetchedAt, totalTokens, providerDay }` samples, oldest first,
  capped at 288 (30s cadence → ~2.4h, covering the 1h window plus its
  trend-comparison window).
- `/10m` rate: anchor = newest sample's `fetchedAt`; rate = newest total −
  total of the newest sample with `fetchedAt ≤ anchor − 10m` (same providerDay
  only; if none, the day's earliest sample — so the LA-midnight reset never
  yields a negative rate, and early-morning rates read as "since midnight").
- `/hr` rate: same with a 1h window.
- Trend arrows: current window vs the previous equal-width window; deadband
  `max(1000, 0.10 × previous)` → `↑` / `↓`, else `→`. If the previous window
  has no usable samples (warm-up), the arrow is `→`.

## Components

### `src/core/token-usage.ts` (new)

`createTokenUsageCollector(dependencies)` mirroring `createQuotaCollector`:
injected `runAgentsview` (spawn), `now`/`nowMs`, `schedule`, `writeFile`,
`diagnostics`, and `tokenUsageSnapshotPath`. Returns `{ start, stop, pollNow }`
with the same containment contract (`pollNow` never throws; one fixed
diagnostic on the good→failed transition only; agentsview output is never
logged). Publishes only when the JSON changes. Spawn failure (e.g. ENOENT) is
an ordinary failed poll. Seeding on start from the existing file mirrors the
quota collector so daemon restarts keep the ring.

### `src/token-usage-snapshot.ts` (new, shared contract)

Runtime-free module imported by writer and reader, like
`src/quota-snapshot.ts`:

```ts
export const TOKEN_USAGE_SNAPSHOT_SCHEMA_VERSION = 1;
export const TOKEN_USAGE_SAMPLE_LIMIT = 288;

export type TokenUsageSample = {
  fetchedAt: string;    // canonical UTC ISO
  totalTokens: number;  // cumulative LA-day total, non-negative finite
  providerDay: string;  // YYYY-MM-DD (America/Los_Angeles)
};

export type TokenUsageSnapshot = {
  schemaVersion: 1;
  providerDay: string;
  totalTokens: number;
  unavailable: boolean;       // most recent poll failed; last-good retained
  fetchedAt: string | null;   // last successful poll; null when never
  samples: TokenUsageSample[]; // bounded ring, oldest first
};

export const parseTokenUsageSnapshot = (value: unknown): TokenUsageSnapshot;
```

Strict validation, canonical-UTC ISO instants (same round-trip check as the
quota parser), throws on any contract violation, no coercion.

### Daemon wiring — `src/core/cli.ts` + paths

Started in `runDaemon` immediately after the quota collector, inside its own
try/catch with a fixed `token_usage_collector_failed` diagnostic, so it can
never prevent or unwind session publication. New `daemonPaths.tokenUsageSnapshot`
→ `token-usage-snapshot.json` in the same app-support directory as
`quota-snapshot.json` (the Rust `event_touches_snapshot` file-name filter is
already limited to `snapshot-v2.json`, so no watcher interference).

### Strip host — `app/src-tauri/src/main.rs`, `app/src/bridge.ts`

`read_token_usage_snapshot` Tauri command: a copy of `read_quota_snapshot`
reading `token-usage-snapshot.json`, with the fixed error string
`token_usage_snapshot_missing` for a missing file. Registered in the invoke
handler. `readTokenUsageSnapshot()` added to `bridge.ts`.

### Strip view — `app/src/token-usage.ts` (new), `app/src/rail.ts`, `app/styles.css`, `app/src/main.ts`

Pure view-model `buildTokenUsageModel(snapshot, nowMs)` →

```ts
type TokenUsageRailModel =
  | { state: "hidden" }                      // never fetched / no file
  | { state: "ok" | "stale"; today: string; hour: RateLine; tenMin: RateLine };
type RateLine = { label: string; trend: "up" | "down" | "flat" };
```

- `stale` when `unavailable` or the newest sample is older than 90s: same
  lines, dimmed.
- Formatting: glorp's compact form — `{:.1}k/M/B` with a trailing `.0`
  stripped (`842.1k`, `109k`, `12.3k`, `3.4M`).
- `renderRail` replaces the clock section with the token section (three lines:
  `842.1k today`, `↑ 109k/hr`, `→ 12.3k/10m`). `RailModel.now` stays — quota
  formatting still uses it; only the clock display is removed.
- Trend colors reuse the existing palette: up `#4ADE80`, down `#FF4D67`,
  flat `#94A3B8`.
- `main.ts` polls the token snapshot on the same cadence/path it already uses
  for the quota snapshot and passes the model into the rail.

## Tests (bun test, mirroring the quota test files)

- Core collector: agentsview JSON parsing (schema v4 enforced, malformed →
  failed poll), total-token contract, missing today row → 0, ring cap,
  providerDay rollover keeps rates same-day-only, unavailable transitions
  (diagnostic only on good→failed), publish-only-on-change, seeding.
- Contract parser: valid round-trip, wrong schemaVersion, bad instants,
  over-limit ring, non-number totals.
- Strip view-model: window differencing (exact bracket samples, fallback to
  earliest same-day sample), trend deadband edges, compact formatting
  (`.0` strip, k/M/B thresholds), hidden/ok/stale states.

## Docs and deploy

- Update `docs/design.md` (rail contract: clock removed, token block added)
  and `AGENTS.md` (new collector, snapshot file, strip command).
- Deploy: daemon change needs `bun scripts/install-local.ts`; strip change
  needs `bun run bundle:app` + `bun run install:app`.
