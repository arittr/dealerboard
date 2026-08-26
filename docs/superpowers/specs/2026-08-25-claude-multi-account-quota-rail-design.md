# Claude multi-account quota rail — Design Spec

Date: 2026-08-25

## Goal

Show every Claude Code quota account reported by the installed `claude-swap`
tool as a separate quota meter under one Claude header in the Xeneon strip
rail. Drew's current two-account setup should render two stacked bars without
changing any other provider row.

This is account/subscription quota, not the registry's individual Claude Code
runtime sessions. Session cards and the Stream Deck keypad are unchanged.

## Current state and verified source behavior

The daemon currently runs
`codexbar usage --provider <provider> --format json --log-level critical` once
per provider and publishes one `ProviderQuota` per provider in
`quota-snapshot.json`. The strip reduces each provider to one binding window
(lowest percent remaining, with session > weekly > extras as the tie-break),
renders that window as the colored fill, and renders every non-binding window
as a neutral tick.

The following behavior was verified locally on 2026-08-25 with CodexBar
0.54.1 and claude-swap 0.25.0:

- `codexbar usage --provider claude --format json` emits one ambient Claude
  entry with one provider-scoped identity.
- `codexbar usage --provider claude --all-accounts --format json` does not
  enumerate claude-swap accounts. On this installation it returns
  `No token accounts configured for claude.`
- `codexbar cards --provider claude --brief --status` displays the two
  claude-swap accounts, but only as human-formatted table output.
- CodexBar's widget snapshot contains one Claude provider entry and no
  structured claude-swap account collection.
- `cswap list --json` emits a versioned object (`schemaVersion: 1`) with
  `activeAccountNumber` and `accounts[]`. Each account carries a numeric slot,
  usage status, 5-hour and 7-day windows, model-scoped weekly windows, source
  fetch timestamps, and optional last-good usage. It also carries sensitive
  email and organization fields that this project does not need.

This matches CodexBar's documented contract: its claude-swap adapter is used
by account cards, while `codexbar usage` and the widget snapshot retain their
ambient single-account behavior:

- <https://github.com/steipete/CodexBar/blob/main/docs/claude.md>
- <https://github.com/steipete/CodexBar/blob/main/docs/claude-multi-account-and-status-items.md>

## Chosen approach

Add a small, read-only claude-swap adapter beside the existing CodexBar quota
adapter. The quota collector continues collecting the ambient Claude entry and
all other providers exactly as it does today, then runs `cswap list --json`
once per collection pass. Structured, allowlisted account readings are added
to the Claude provider's existing snapshot entry.

The strip uses the account collection only when it contains at least two
accounts. Zero or one account preserves the current ambient Claude row. This
matches the requested multi-account behavior without changing the ordinary
single-account experience.

Account rows stay in numeric slot order. The active account gets a marker but
does not move to the top, so switching accounts never makes the two meters
swap physical positions.

### Rejected alternatives

- **Parse `codexbar cards`:** rejected because it is a presentation format,
  not a machine contract. Parsing its spacing, truncation, and prose would be
  brittle and would violate this repository's testing guidance for rendered
  command output.
- **Configure CodexBar token accounts and use `--all-accounts`:** rejected
  because it would duplicate Claude credentials into a second account store.
  CodexBar documents that plain OAuth access-token accounts lack durable
  refresh metadata, while claude-swap already owns the live sessions and their
  refresh lifecycle.
- **Replace the provider map with an array or add a second sidecar:** rejected
  as unnecessary contract churn. An additive account collection on Claude's
  existing quota entry is enough and preserves both deployment orders.

## Visible rail contract

### Multi-account Claude group

When the parsed Claude account collection contains at least two rows, the
existing Claude quota section becomes a group:

```text
[C] Claude
    1   session       26m · 100%
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ● 2   Fable           2d · 2%
        ━
```

- The provider header contains the existing Claude chip and `Claude` label
  exactly once. It carries no binding tag, countdown, or percent.
- Each account meter has a compact head line with:
  - its privacy-safe numeric claude-swap slot (`1`, `2`, ...),
  - a small Claude-orange dot when that slot equals `activeAccountNumber`,
  - the existing pill naming that account's binding window,
  - the existing right-aligned muted countdown followed by the bright
    tabular percent.
- Each account gets the existing 8px quota bar. Its binding window controls
  the fill width and headroom color. Every non-binding window renders as the
  existing neutral 2px tick at its own percentage.
- Numeric slot order is stable and ascending. Active state never reorders the
  meters.
- Email address, organization name, organization UUID, credential status
  detail, and account plan never render.
- Stale or unavailable state dims only the affected account meter. The shared
  Claude header and a healthy sibling remain at normal opacity.
- The two-account group adds one meter's height compared with today's Claude
  row. It must fit the fixed 600px rail at 2560x720 without shrinking the
  bars, clipping text, overlapping the pager, or changing board geometry.

The snapshot contract permits at most eight accounts to keep parsing and DOM
work bounded. The implementation renders every published account in stable
slot order; the physical visual acceptance gate is the current two-account
setup. Layout optimization for a larger account fleet is not part of this
change.

### Ambient fallback

The current single Claude row remains the fallback:

- claude-swap binary absent,
- no successful claude-swap collection has occurred,
- a successful collection reports zero or one account, or
- a new strip reads a snapshot from an older daemon with no account field.

A transient claude-swap failure after a successful multi-account collection
does not collapse the group. The collector republishes the last-good account
readings as unavailable, and the strip keeps both meters visible and dimmed
until the adapter recovers. A later successful zero- or one-account result is
authoritative and returns the strip to the ambient row.

## Snapshot contract

`src/quota-snapshot.ts` adds an account record and an account collection to
`ProviderQuota`:

```ts
type ProviderQuotaAccount = {
  id: string;
  label: string;
  active: boolean;
  percentRemaining: number | null;
  resetAt: string | null;
  weeklyPercentRemaining: number | null;
  weeklyResetAt: string | null;
  unavailable: boolean;
  fetchedAt: string | null;
  extraWindows: QuotaExtraWindow[];
};

type ProviderQuota = {
  // Existing ambient fields remain unchanged.
  accounts: ProviderQuotaAccount[];
};
```

For claude-swap rows:

- `id` is `claude-swap:<slot>` and is the stable data/DOM identity.
- `label` is the decimal slot number. It is display-ready and contains no
  personal information.
- `active` is derived from top-level `activeAccountNumber`, not from email or
  array position.
- `percentRemaining` / `resetAt` come from the 5-hour window.
- `weeklyPercentRemaining` / `weeklyResetAt` come from the 7-day window.
- `extraWindows` comes from valid model-scoped weekly rows, in source order.
  The display label uses the source's model name under the existing 14-code-
  point cap. Its internal id is
  `claude-swap:<slot>:scoped:<source-index>`.
- Percentages convert from claude-swap's used percentage to this project's
  remaining percentage with `100 - pct`.
- Reset and fetch timestamps normalize through `Date.parse` plus
  `toISOString`; an absent or unparseable reset becomes null.
- There is no per-account history ring. The current history belongs to the
  ambient provider row and remains unchanged; no rail surface consumes it.

`QUOTA_ACCOUNTS_LIMIT` is eight. Snapshot parsing rejects an over-limit
collection, duplicate ids or labels, more than one active account, invalid
percentages, invalid canonical fetch instants, or malformed extra windows.
Unknown fields inside an account are ignored.

### Versioning and deployment order

`schemaVersion` remains 2. `accounts` is an additive optional wire field:

- The writer emits `accounts` on the Claude entry and an empty collection on
  other provider entries.
- The new parser maps a missing `accounts` field to `[]` for schema v1 and v2
  input.
- An old strip parser already reconstructs only known provider fields, so it
  ignores `accounts` and keeps rendering the ambient Claude row from a new
  daemon.
- A new strip reading an old daemon's file sees `accounts: []` and keeps
  rendering the ambient row.

Keeping version 2 is deliberate: bumping to version 3 would make the current
strip reject the entire quota file during a daemon-first update, blanking
every provider panel for an otherwise additive Claude feature.

## Claude-swap adapter

Create `src/core/claude-swap-quota.ts` for the external schema boundary. It
contains the pure parser and the source-specific normalization; the existing
`src/core/quota.ts` remains responsible for scheduling, execution, last-good
state, and publication.

### Discovery and execution

Resolve the first existing path from:

```text
~/.local/bin/cswap
/opt/homebrew/bin/cswap
/usr/local/bin/cswap
```

The first path is the verified local installation. There is no environment
variable, shell lookup, CodexBar-config parsing, installation behavior, or
credential-file fallback.

Run exactly:

```text
cswap list --json
```

- Spawn directly with an argument array; never invoke a shell.
- `QuotaCollectorDependencies` gains an optional `claudeSwapExec` with the
  existing `QuotaExec` signature. Production resolves and spawns the
  claude-swap binary separately; tests inject this dependency without
  intercepting or changing the existing CodexBar `exec` dependency.
- Use a source-specific 5-second timeout.
- Capture stdout in memory and ignore stderr. Never log, diagnose, or persist
  raw stdout or caught error text.
- Execute once per existing 120-second quota pass. It is independent of the
  five serialized CodexBar provider probes and must not affect their outcome.

### Parsing

The parser requires a top-level object with `schemaVersion === 1`, an accounts
array, and a positive integer `activeAccountNumber`. Unknown schema versions
and malformed top-level shapes fail the account probe without affecting
ambient Claude quota.

Parse only:

- account `number`,
- `usageStatus`,
- `usage.fiveHour`, `usage.sevenDay`, and `usage.scoped`,
- `usageFetchedAt`,
- `lastGoodUsage.fiveHour`, `lastGoodUsage.sevenDay`, and
  `lastGoodUsage.scoped`, and
- `lastGoodFetchedAt`.

Explicitly ignore email, organization fields, aliases, credentials, token
diagnostics, mappings, and every other field.

Account normalization follows these rules:

1. Every account must carry a unique positive integer slot, and the valid
   account count must not exceed `QUOTA_ACCOUNTS_LIMIT`. An invalid or
   duplicate slot, or an over-limit list, fails the whole account probe so a
   partially parsed list cannot collapse a previously valid two-account
   group. For a non-empty list, `activeAccountNumber` must match exactly one
   account. A valid empty source array is a successful empty collection.
2. Sort accounts numerically by slot.
3. When `usageStatus === "ok"`, the current usage contains at least one valid
   5-hour, 7-day, or scoped window, and `usageFetchedAt` is a valid instant,
   publish it as available using that source instant.
4. Otherwise, when a valid `lastGoodUsage` contains at least one window and
   `lastGoodFetchedAt` is a valid instant,
   publish those numbers with `unavailable: true` and `lastGoodFetchedAt`.
   This keeps the meter visible when claude-swap reports a sentinel status
   such as `unavailable`, `token_expired`, `keychain_unavailable`, or an
   unknown future status.
5. With no usable current or last-good window, retain the account identity
   and active bit but publish empty windows, `unavailable: true`, and a null
   fetch instant. Its row reads `unavailable` and has an empty bar.
6. A malformed scoped row is dropped without discarding valid account-wide
   windows. Invalid current or last-good source timestamps never fall back to
   the collector's poll time and therefore never make cached data look fresh.

The raw source fetch time, rather than the collector's poll time, controls
stale state. Re-reading an old claude-swap cache every two minutes must not
make it look fresh.

## Collector state and failure containment

`src/core/quota.ts` gains a claude-account state beside the existing
per-provider ambient states:

- Seed the last-good account collection from an existing quota snapshot on
  daemon startup.
- A successful parse replaces the account collection, including a successful
  zero- or one-account result.
- No resolved claude-swap binary is a supported absence: replace the account
  collection with `[]`, emit no failure diagnostic, and use the ambient
  Claude row. Removing the tool therefore removes its account presentation.
- A failed spawn after path resolution, timeout, nonzero exit, malformed JSON,
  unsupported schema, invalid account identity, or over-limit account list
  preserves the seeded/last-good accounts and marks every retained account
  unavailable. With no last-good accounts, publish `accounts: []` and leave
  ambient Claude untouched.
- Account-adapter failure and recovery are independent of the ambient Claude
  probe. Neither may mark the other unavailable or erase its last-good data.
- Add a payload-free `quota_accounts_failed` diagnostic with
  `provider: "claude"`, emitted only on the account adapter's healthy-to-
  failed transition (including the first cold failure), then suppressed until
  a successful account pass resets it.
- The outer collector never-throws containment remains unchanged.

The CodexBar widget fallback remains ambient-only. It never manufactures,
rescues, or clears claude-swap account rows.

## Strip view-model and rendering

### `app/src/quota.ts`

Refactor the existing provider-level meter derivation into a reusable pure
function that converts any ambient or account quota reading into:

- ordered windows (session, weekly, then extras),
- binding index,
- state (`ok`, `stale`, `unavailable`),
- fetched-at instant, and
- the existing tag, reset, percent, secondary-window, and color derivations.

`QuotaPanelModel` retains the ambient meter and gains an ordered account-meter
collection with `id`, `label`, and `active`. The view model selects grouped
presentation only when at least two parsed accounts exist. It does not merge,
average, or select one account on behalf of the renderer.

### `app/src/rail.ts`

Split the current `quotaSection` into a provider header and a reusable meter
renderer:

- Ambient providers call the meter renderer with the existing provider chip
  and label, preserving their DOM and appearance.
- Grouped Claude calls the provider header once, then calls the same meter
  renderer for each account with slot/active leading content.
- Each account meter owns its state dataset so dimming is per account.
- The rail render signature includes account id, label, active bit, state,
  formatted countdown/percent, binding fill, and secondary windows. A changed
  account reading rebuilds the rail; unchanged readings retain the existing
  render-skip behavior.

### `app/styles.css`

Add only the grouping and account-leading styles needed for the shared header,
compact account head lines, active marker, per-account dimming, and vertical
spacing. Reuse the existing quota tag, right text, bar, fill, tick, and color
styles. No rail-width, typography-scale, board, card, or pager changes are in
scope.

## Privacy and safety

- Do not read claude-swap storage, Claude Code credential files, Keychain
  entries, or CodexBar's config file.
- Do not run `switch`, `auto`, `run`, `add`, export/import, purge, or any other
  mutating claude-swap command.
- Do not persist, display, or diagnose account email, organization identity,
  OAuth data, token status detail, or raw process output.
- Snapshot identity is the source-issued numeric slot, namespaced as
  `claude-swap:<slot>`; it is never an email or credential-derived value.
- Any parser or subprocess failure is contained to the account collection and
  never removes other provider quota panels.

## Testing

### Pure claude-swap parser

Add sanitized fixtures and focused tests for:

- two healthy accounts, numeric ordering, and active-slot derivation;
- 5-hour/7-day/scoped conversion from used to remaining percentage;
- canonical timestamp normalization and invalid reset-to-null behavior;
- unavailable current data with valid `lastGoodUsage`;
- unavailable data with no last-good windows;
- malformed scoped rows contained to that row;
- duplicate/invalid slots, empty accounts, invalid JSON, malformed top-level
  shape, and unknown schema version; and
- an input fixture containing email/organization fields whose normalized
  result and serialized snapshot contain none of those values.

### Snapshot contract

Extend `test/quota-snapshot.test.ts` for:

- schema v1 and v2 input without `accounts` defaulting to `[]`;
- a valid two-account v2 round trip;
- account cap, duplicate id/label, multiple-active, percentage, timestamp,
  and extra-window validation; and
- unknown account fields ignored.

### Collector

Extend `test/quota.test.ts` for:

- exact `cswap list --json` invocation once per pass;
- binary discovery and absent-binary ambient fallback;
- successful publication independent of ambient Claude success/failure;
- seed, transient failure, last-good unavailable, transition-only diagnostic,
  recovery, and authoritative zero/one-account replacement;
- widget fallback remaining ambient-only; and
- raw stdout and caught errors never entering diagnostics.

### Strip view-model and DOM

Extend `test/strip-quota.test.ts` and `test/strip-rail.test.ts` for:

- zero/one account retaining the ambient row;
- two accounts producing stable slot order even when slot 2 is active;
- independent binding selection, fills, non-binding ticks, reset text, and
  stale/unavailable state per account;
- one Claude provider header, two account bars, one active marker, and no
  email/organization text;
- one unavailable sibling dimming without dimming the group header or healthy
  sibling; and
- render-signature changes for account state/data but stability between
  unchanged countdown labels.

Tests assert structured models and DOM behavior, not generated HTML or command
strings beyond the exact public subprocess argument array.

## Documentation

Implementation updates:

- the quota paragraph in `AGENTS.md` with the claude-swap source, account
  snapshot, fallback, and privacy contract; and
- the live rail section in `docs/design.md` with the shared Claude header,
  stacked account meters, stable slot ordering, active marker, and per-account
  unavailable behavior.

Dated files under `docs/superpowers/` and `docs/verification/` remain
historical and are not edited after this design is accepted.

## Non-goals

- Switching, launching, authenticating, adding, removing, enabling, or
  disabling Claude accounts from the rail.
- Displaying account emails, organizations, aliases, plans, or credential
  status detail.
- Adding Codex or other-provider multi-account UI.
- Adding per-account history, sparklines, prediction, pace, or aggregation.
- Parsing CodexBar cards or changing CodexBar's configuration.
- Installing or updating claude-swap.
- Changing the Stream Deck plugin, keypad quota surfaces, session cards,
  board packing, rail width, or token-usage block.

## Verification and deployment gates

1. `bun run check` passes: Biome, typecheck, build, and the full test suite.
2. Focused parser/collector tests prove that fixture emails and organization
   fields never enter normalized output, snapshots, or diagnostics.
3. Install the core change with `bun scripts/install-local.ts`; verify the
   published v2 quota snapshot contains ambient Claude plus two privacy-safe
   account rows and that all other provider entries remain unchanged.
4. Build and install the strip app with `bun run bundle:app` and
   `bun run install:app`.
5. On the physical 2560x720 Xeneon Edge, verify one Claude header and two
   stacked account meters in numeric slot order. The active marker must match
   the current `activeAccountNumber`; each bar's binding percent, reset, and
   non-binding ticks must match a contemporaneous sanitized `cswap list
   --json` reading.
6. Verify an unavailable account with last-good data remains visible and dim
   while a healthy sibling and the shared header remain undimmed.
7. Verify Codex, Kimi, GLM/zai, and Qwen rows, the pager, token block, unread
   row, and session board remain visually unchanged and unclipped.

Code/test success is not the visual gate. The change is not complete until
Drew approves the installed physical strip rendering.
