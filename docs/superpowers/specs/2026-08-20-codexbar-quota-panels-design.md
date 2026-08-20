# CodexBar-Sourced Quota Panels (claude, codex, kimi, GLM/zai) — Design Spec

## Context

The strip rail currently shows quota panels for claude and codex only, fed by
the daemon's quota collector (`src/core/quota.ts`), which polls two provider
HTTP endpoints directly with OAuth tokens read from local credential files
(researched from CodexBar's source; see the header comment of `quota.ts`).

Goal: add **kimi** and **GLM (z.ai)** quota panels with sparklines, so all four
providers the user actually runs are visible on the rail.

Decision (user-chosen on 2026-08-20, over the recommended hybrid of keeping the
two direct OAuth fetchers): **all four providers are sourced from the locally
installed CodexBar CLI**. One mechanism for everything; the direct HTTP
fetchers, credential parsers, and the 429 cooldown are deleted. The accepted
costs: CodexBar's JSON shape is an unversioned external contract (contained by
strict parsing → `unavailable`, never a crash), and CodexBar "honors in-app
toggles" — disabling a provider in the menu bar app removes that strip panel.

## CodexBar facts (verified against CodexBar 0.53.0 on 2026-08-20)

- CLI entry point: `/opt/homebrew/bin/codexbar`, a symlink to
  `/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI`.
- Command: `codexbar usage --provider <key> --format json --log-level critical`
  prints a JSON array on stdout; one element per account (single-account here).
  Measured wall time: kimi ≈ 1.0s (source `"Kimi Code CLI"` — reads local CLI
  state), zai ≈ 1.4s (source `"api"`), claude/codex similar (claude.ai cookies
  / OpenAI oauth via CodexBar's stored credentials).
- Every provider normalizes to `usage.{primary,secondary,tertiary}`, each null
  or `{ windowMinutes, usedPercent, resetsAt, resetDescription }`:
  - claude: primary = 300min session, secondary = 10080min weekly.
  - codex: **primary observed `null`**; secondary = 10080min weekly; 5-hour and
    weekly Spark windows under `extraRateWindows[].window`.
  - kimi: primary = 10080min weekly ("12/100 requests"), secondary = 300min
    rate window — **reversed labels vs claude**.
  - zai: primary = 300min session credit quota, secondary = 10080min weekly
    credit quota; `usedPercent` is a float (e.g. 56.365).
- Because the primary/secondary labels are not positional, windows are
  classified by `windowMinutes`, never by which slot they arrived in.
- CodexBar's app-support dir contains lock files (`cookie-cache.lock`), so
  invocations are serialized — the collector probes providers sequentially, as
  the existing per-provider loop already does.

## Architecture

### `src/core/quota.ts` — collector rewrite

Removed: `QuotaFetch`/`QuotaFetchResponse`, `parseClaudeCredentials`,
`parseCodexAuth`, `normalizeClaudeUsage`, `normalizeCodexUsage`,
`ClaudeCredentials`, `CodexAuth`, `QUOTA_RATE_LIMIT_COOLDOWN_MS` and all
cooldown state (there is no HTTP and no 429 anymore; transient exec failures
just mark the provider failed for that pass).

Added:

- `CODEXBAR_BINARY_CANDIDATES = ["/opt/homebrew/bin/codexbar",
  "/usr/local/bin/codexbar",
  "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI"]` — first existing
  path wins; none → every provider probes as `absent`.
- `QuotaExec = (args: string[], timeoutMs: number) =>
  Promise<{ exitCode: number; stdout: string }>` — injected dependency; default
  impl spawns the resolved binary via `Bun.spawn` with stdout piped and stderr
  ignored, kills on timeout, and resolves (never rejects) with a non-zero
  sentinel exit code on spawn failure/timeout. stdout is parsed in memory only;
  nothing from the process is ever logged or persisted.
- `normalizeCodexbarUsage(body: string, provider: QuotaProviderKey)`:
  strict-parse the JSON array, take the first element, collect the non-null
  `usage.primary/secondary/tertiary` windows, then classify:
  - **weekly** = the window with the longest `windowMinutes`, only when that
    length is ≥ 1440 (a day); otherwise no weekly window.
  - **session** = the window with the shortest `windowMinutes` among those
    shorter than 1440 (a lone sub-day window still classifies as session).
  - If no session window was found, scan `usage.extraRateWindows[].window`
    with the same sub-1440 rule (codex's observed Spark 5-hour layout).
  A window validates only with a finite `0..100` `usedPercent`; invalid windows
  are skipped before classification. `resetsAt` normalizes through the existing
  `isoOrNull`. `percentRemaining = 100 - usedPercent`. Unparseable body, no
  usable session *or* weekly window, or missing entry → `null` (failed); a
  provider with only one window class still yields a reading (the other slot
  stays null, as the contract already allows).
- Probe per provider: binary missing → `absent`; exit code ≠ 0 or empty
  stdout → `failed`; `[]` (provider disabled in CodexBar or no account) →
  `absent` (panel disappears, matching today's "no credentials" semantics);
  otherwise normalize.

Kept exactly as-is: 120s cadence (`QUOTA_POLL_INTERVAL_MS`), 15s per-probe
timeout (`QUOTA_FETCH_TIMEOUT_MS`, reused as the exec timeout), seeding from
the previous snapshot on startup, history-ring append on success
(`QUOTA_HISTORY_LIMIT`), absent → omit provider from the file, failed →
`unavailable: true` with last-good numbers, transition-only `quota_failed`
diagnostics, `pollNow` reentrancy guard and never-throws contract.

### `src/quota-snapshot.ts` — contract

`QUOTA_PROVIDER_KEYS` becomes `["claude", "codex", "kimi", "zai"]` — the key is
`zai` (CodexBar's provider id); the "GLM" naming is display-only. Nothing else
changes: `ProviderQuota` shape, history point shape, `schemaVersion: 1`. The
parser already ignores unknown provider keys, so older strips reading a newer
file (and vice versa) degrade gracefully.

### `src/core/cli.ts` — wiring

`claudeCredentialsPath`/`codexAuthPath` dependencies are dropped from
`QuotaCollectorDependencies`; the collector self-resolves the binary via the
candidates list (existence check behind an injectable `fileExists` for tests).
`cli.ts` passes only `quotaSnapshotPath` and `diagnostics`. No environment
variables (`noProcessEnv`).

### Strip app

- `app/src/quota.ts`: untouched — the view-model already iterates
  `QUOTA_PROVIDER_KEYS` and is provider-agnostic. Sparklines for the new
  providers come from the daemon's own history ring, exactly like the existing
  panels (~4.3h window at the 120s cadence). CodexBar's own hourly/daily token
  charts and `pace` data are **not** used.
- `app/src/rail.ts`: `PROVIDER_LABELS` and `PROVIDER_CHIP_LETTERS` gain
  `kimi → "Kimi" / "K"` and `zai → "GLM" / "G"`.
- `app/styles.css`: `.quota-chip[data-provider="kimi"]` → `#3B82F6` (the tile
  palette's Kimi hue) and `.quota-chip[data-provider="zai"]` → `#2DD4BF`
  (teal; distinct within the rail's chip set — rail chips are a separate
  namespace from tile corner chips).
- Panel order follows `QUOTA_PROVIDER_KEYS`: Claude, Codex, Kimi, GLM.

## Error handling and containment

- Any CodexBar shape drift, non-zero exit, timeout, or spawn failure → that
  provider renders `unavailable` (dimmed, last-good numbers) and recovers on
  the next good pass; other providers are unaffected.
- CodexBar binary missing or provider disabled in the app → provider omitted
  from the snapshot; its panel disappears.
- Codex session-window caveat: CodexBar reported `primary: null` for the live
  account during research. If no session-class window exists for codex, the
  panel shows `—` for the session percent (existing null handling) while the
  weekly line and sparkline continue. The `extraRateWindows` fallback covers
  the observed Spark-window layout. Implementation includes a side-by-side
  check of CodexBar's codex/claude readings against the previous direct
  fetchers' numbers on the live account before the cutover is trusted.

## Testing

- Real CodexBar output captured per provider into `test/fixtures/` (the four
  JSON payloads from 2026-08-20, trimmed to the fields the parser reads).
- `test/quota.test.ts` rewritten around an injected `QuotaExec`: window
  classification (kimi's reversed labels, zai's float percents, codex's
  null-primary + `extraRateWindows` fallback), absent (binary missing, empty
  array), failed (non-zero exit, garbage stdout, no usable window), seeding,
  history append, no-cooldown behavior, and that stderr/stdout are never
  logged.
- `test/quota-snapshot.test.ts`: extended for the new provider keys.
- App-side quota/rail tests: labels/letters for the two new providers.
- `test/cli.test.ts`: updated collector wiring.

## Docs and deploy

- Rewrite the quota paragraph in `AGENTS.md` (exec-based collector, four
  providers via CodexBar, binary candidates, cooldown gone) and the quota
  section of `docs/design.md`.
- Deploy: daemon change → `bun scripts/install-local.ts` (full reinstall);
  strip change → `bun run bundle:app` + `bun run install:app`. The Stream Deck
  plugin is untouched (it never reads the quota file).

## Non-goals

- No fallback to the deleted direct fetchers, no feature flag — one mechanism.
- No use of CodexBar's charts, pace, or credits surfaces.
- No CodexBar version pinning or auto-install; absence is a supported state.

## Verification

1. `bun run check` green (Biome, typecheck, build, full test suite).
2. After `install-local.ts`: `quota-snapshot.json` contains all four providers
   with non-null percentages; the strip rail renders four panels with
   sparklines and weekly lines.
3. Rename every existing codexbar binary candidate (homebrew symlink and, if
   present, the app-bundle helper) → next passes omit all four providers
   (panels disappear); restore → panels return.
4. Disable a provider in the CodexBar app → its panel disappears; re-enable →
   returns.
