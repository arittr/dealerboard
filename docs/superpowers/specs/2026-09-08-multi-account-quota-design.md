# Multiple-account quota collection and inline rail

Status: draft for Drew's review. This specifies the intended implementation; the committed mockups are not production behavior.

## Purpose

Show usage for multiple Codex and Claude accounts in a compact, dependable rail. Drew's main workflow is using one account while watching another account's reset countdown. Every account therefore needs its own visible remaining quota, limiting window, and reset countdown, whether or not it is selected in its provider's account switcher.

Use the available space for readable type today. Keep a smaller, explicitly selected density preset for a larger lineup.

## Design authority

The visual reference is [the comfortable and compact inline mockup](../mockups/2026-09-08-inline-density-presets.html), committed in `e20b96e`. Its comfortable treatment is the default. The underlying typography decision is preserved in [the type-treatment mockup](../mockups/2026-09-08-inline-condensed-type.html).

Decisions settled during visual brainstorming:

- Provider sections span the full rail width. Multiple accounts use condensed inline rows below one provider heading.
- Every numerical readout uses **reset countdown · remaining percentage**, including single-account providers.
- Countdown text uses the current rail's smaller, muted treatment; percentages are larger and bright. Countdown importance does not mean making both facts equally prominent.
- Account reset countdowns remain visible without opening details.
- The half-width provider grid and active-account-only presentation were rejected.
- Comfortable density uses more of the slat now; compact density is an explicit setting for growth. There is no automatic density switching.

The mockup's values are illustrative. Its amber numbers, speculative providers, synthetic secondary ticks, and other details from older iterations do not define new data behavior. This document takes precedence where a mockup is incomplete.

## Current implementation and observed evidence

The existing collector runs on a 120-second cadence. Multi-account Claude usage comes from `cswap list --json`; other providers, including Codex, use CodexBar. The snapshot and rendering layers currently special-case Claude accounts. The CodexBar parser selects the first matching provider record and cannot retain multiple Codex account results.

Read-only investigation established:

| Observation | Consequence |
| --- | --- |
| Claude account 2 returned `usageStatus: relogin_required`, with its last good reading on September 2. | Its present failure needs reauthentication. More frequent Dealerboard polling cannot repair that credential. |
| Dealerboard reduces that source status to `unavailable`. | The rail loses the actionable explanation. |
| Installed CodexBar 0.56.7 returned two successful account results from `usage --provider codex --all-accounts --json`. | Use the existing collector source rather than introduce another credential store. |
| A later invocation returned one successful result and one account error, with process exit code 1. | Nonzero exit must not discard valid, identified successes in a complete JSON response. |
| CodexBar's account results expose a string `account` label, including on errors, but no durable account ID or active-account flag. Its internal `cacheAccountKey` is not serialized. | Identity support must state its limits, and the active marker must not be guessed from list position. |

These are diagnostic observations, not installed Dealerboard acceptance evidence. Credential state can change before implementation or deployment.

Relevant existing files: `src/core/quota.ts`, `src/core/claude-swap-quota.ts`, `src/quota-snapshot.ts`, `app/src/quota.ts`, `app/src/rail.ts`, and `app/styles.css`.

## Scope

Implement multiple-account Codex collection, preserve actionable Claude account health, and give both providers the agreed inline presentation. Retain the current Kimi, GLM, and Qwen integrations. Preserve independent account identity, last-good values, and measurement timestamps through failures and daemon restarts.

Include a small read-only account detail view for all windows, measurement age, and recovery guidance. Use the application's existing overlay conventions; the detail view does not switch accounts or perform authentication.

This work does not add providers, manage credentials, automate account rotation, write into provider authentication stores, build an account-management application, add quota history charts, or redesign the agent board/token activity block. It does not add a settings screen just to expose density. No Linear tickets are used for Dealerboard.

## Collection and account identity

### Provider adapters

Keep the collector, shared quota snapshot, pure view model, and DOM renderer as the existing boundaries. Extract account-specific parsing where it makes the collector clearer; do not replace the daemon or introduce a generic plugin framework.

Claude continues to use `cswap list --json` as its account source. With two or more known accounts, do not issue an additional ambient Claude probe: it cannot supply the inactive account and duplicates upstream requests. Preserve the existing single-account/absent-cswap behavior.

Codex uses one `codexbar usage --provider codex --all-accounts --json` invocation per pass, replacing its ordinary single-account invocation. Reuse the existing window normalization for each record, including extra rate windows. Only records whose provider is Codex enter this adapter. Never combine separate accounts into a summed or averaged quota.

Keep the existing 120-second polling cadence and reentrancy guard. Respect source caching and backoff; do not add refresh-on-tap, retry loops, forced refresh flags, or provider model calls. Keep subprocesses bounded: the existing CodexBar 90-second invocation deadline and cswap 5-second deadline remain explicit limits. A timeout is a failed read, not an empty inventory. Slow multi-account batches must be reported honestly; any later timeout/scheduling redesign requires separate evidence and discussion.

### Identity and display labels

Claude uses the existing `claude-swap:<slot>` source identity and numeric slot label. Account order remains ascending by slot, independent of which slot is active.

For the currently available CodexBar JSON contract:

1. Require a nonempty `account` string for an identified account result. Trim surrounding whitespace; do not parse an email or organization out of the display string.
2. Derive a local opaque ID as `codexbar:` plus the full SHA-256 hex digest of the UTF-8 string `codex\0` followed by that trimmed label. Do not persist or publish the raw label.
3. Preserve an existing numeric display label for every retained ID. Assign newly observed IDs successive positive numbers after the highest retained label, in digest order. Seed the mapping from the existing quota snapshot at daemon startup. Do not reorder or renumber surviving accounts when source order changes or a peer disappears.
4. A source-label rename creates a new identity under this contract; do not transfer readings based on guessed equivalence. No durable identity across upstream label changes is promised.
5. Duplicate source labels are ambiguous. Do not merge their readings or assign identities using array indexes. Retain affected last-good state as unavailable and emit a sanitized diagnostic.

This supports distinct labeled accounts exposed by the installed source. It does not claim support for two upstream identities that export the same label. A future durable source ID can supersede this contract only through an explicit design change.

Use numeric labels on the strip. Publish no emails, organization names, raw source labels, credentials, raw subprocess output, or raw error messages in snapshots, logs, or detail views. Opaque hashes are local identifiers, not a guarantee that source labels cannot be guessed.

### Active account

Represent activity as `true`, `false`, or `null` (unknown). Claude supplies a known active slot. Codex activity is `null` until a supported source explicitly supplies it; no additional credential reads or ambient usage probe are introduced just to draw a dot.

Draw the active dot only for `true`. It means the account selected by the source's switcher, not proof that every running agent uses that account. Unknown activity leaves the marker empty and the detail view says that the active account is not reported. Do not call an account active, inactive, or available for switching solely because of list position. Mockup Codex dots are illustrative and do not authorize inventing this signal.

### Partial failure and inventory changes

Parse a complete JSON response even when CodexBar exits nonzero. An identifiable success updates only its own measurement. An identifiable error updates only that account's health, retaining its own last-good values and timestamp. A never-successful account is still represented with null measurements.

An entirely malformed/truncated response, timeout, or transport failure keeps known rows and marks their latest read unavailable. It never clears the group, restamps old measurements, or attributes an ambient reading to an account.

Removal requires a complete, successful, unambiguous inventory. Do not infer removal from a partial-error response, missing identity, malformed entry, or nonzero-exit response. Known accounts omitted from such a response remain visible as unavailable. Successful peers may still advance.

A successful complete inventory with zero accounts clears account grouping. An anonymous single Codex record may be used only as an ambient reading when no identified group is being retained; it must never overwrite a retained named account. One identified account renders in the single-provider form, using that account's own measurement and health. Two or more render as a group.

Seed both providers' retained account state from the quota snapshot. Commit the published provider/account state atomically after the pass's required reads, following the existing collector's abort-safety pattern. An interrupted pass cannot leave an in-memory identity map ahead of its published readings.

## Shared data and health contract

The account model needs the existing window fields, opaque ID, numeric display label, source measurement `fetchedAt`, tri-state `active`, and normalized health information. Preserve `unavailable` as the existing availability signal, and add an account `issue` of `null | auth_required | rate_limited | unavailable` for the renderer/detail view. Both fields are required in v3 account records, with `unavailable` exactly equal to whether `issue` is non-null. Staleness is derived from the measurement timestamp separately. Any populated measurement requires a valid source `fetchedAt`; a never-measured account has null measurement fields and timestamp.

Map source statuses intentionally:

| Source result | Account outcome |
| --- | --- |
| Valid successful measurement | Update its windows and source timestamp; clear issue. |
| Claude `relogin_required`, or an explicit source authentication-required error | `auth_required`; retain last-good data. |
| Explicit rate-limit failure | `rate_limited`; retain last-good data. |
| Token refresh deferred, missing credentials, keychain unavailable, other recognized fetch failure | `unavailable`; retain last-good data. Do not falsely prescribe re-login for every transient failure. |
| Source reports cached data as successful under its own pacing | Preserve its measurement timestamp; do not substitute collection time. |

Do not infer error class by matching arbitrary human error text. Use source status codes/types where exposed, otherwise use `unavailable`.

Separate collector liveness from measurement freshness. A successful inventory read can prove the collector is alive without proving each account was freshly measured. Group collection timestamps must not replace per-account `fetchedAt`.

Use named per-source age limits for the account view: Codex becomes stale after three missed 120-second measurement intervals (6 minutes); Claude uses a 45-minute backstop to accommodate its slower cached/backoff cadence. The inspected cswap polling policy has a 10-minute candidate ceiling and 30-minute post-429 interval ceiling. These are UI freshness limits, not polling intervals. A reported issue takes effect immediately, irrespective of age. The Claude backstop is a deliberate change from ignoring measurement age indefinitely; verify it against the installed source's normal pacing before shipping. If measured normal pacing exceeds it, revise this named limit with evidence rather than silently disabling freshness checks.

The account extensions change the shared contract. The proposed coordinated writer and reader use quota schema version 3 only. On first v3 startup, ignore v1/v2 snapshot contents for both display and retained-state seeding; replace them through fresh collection. Until that succeeds, display the ordinary unavailable state rather than convert old records. Once v3 is written, restart preservation applies to v3 records. This proposal removes the quota reader's historical v1/v2 acceptance branches; it needs Drew's approval with this spec before implementation. Do not add a v2-to-v3 migration, dual writer, or compatibility shim. Ship/install the reader and daemon together. Any backward-compatibility behavior requires Drew's explicit approval before implementation.

The exact TypeScript decomposition can follow surrounding code, but the wire contract must validate provider-appropriate ID prefixes, unique IDs and numeric labels, at most one known-active account, nullable ISO timestamps, bounded percentages, and the existing limits of eight accounts and eight extra windows per provider. The data limit is not a promise that all possible account combinations fit simultaneously on the strip.

## Rail behavior

### Anatomy and reading order

Keep the current 638 × 720 rail within the 2560 × 720 strip layout. The token activity block, unread indicator, provider colors, and agent-board geometry remain as they are.

For a group, render one provider heading, its account count, then one line per account:

`active marker / numeric label / limiting-window tag / inline meter / reset countdown · remaining percent`

For a single-account provider, retain the current provider heading/readout with a full-width meter beneath it. Both forms use the same countdown-first readout and type hierarchy. No provider tile grid, account carousel, account sorting by quota, or hidden inactive accounts.

Percentages mean **remaining**, never used. Continue selecting the lowest remaining window as binding, with the existing stable tie preference: session, weekly, then extras in source order. Render its real source label (including scoped windows such as Fable), percentage, and reset time together. Nonbinding windows remain neutral ticks on the meter; their full values and countdowns are available in details.

A single reset countdown is not a promise that the entire account becomes usable at that instant: another window can still constrain it. The detail view shows all windows. Do not estimate total availability or automatically recommend switching from this one countdown.

### Typography and sizing

Use the current rail colors: countdown/note `#94a3b8`, percentage `#e8eef7`, normal font weight, and a note-to-percentage size ratio of 0.875. Readout items share a baseline. Keep this treatment for exhausted accounts too; meter color conveys quota pressure, while stale/auth states convey collection health separately.

Define one internal setting, `QUOTA_DENSITY: "comfortable" | "compact"`, defaulting to `comfortable`. A small shared preset table/CSS-variable boundary controls quota sizing. Do not scatter independent comfortable/compact conditionals through account rendering. The setting is a developer configuration constant, not a new preferences UI or automatic account-count heuristic.

Native reference values from the selected mockup:

| Property | Comfortable (default) | Compact |
| --- | --- | --- |
| Quota type/geometry scale | 1.2 | 1.0 |
| Percentage size | 30px | 25px |
| Countdown size | 26.25px | 21.875px |
| Account row height | 40px | 31px |
| Gap between provider sections | 16px | 10px |
| Meter thickness | 6px | 5px |

Translate these through the application's existing viewport scaling conventions. Scale provider headings, account tags, and readout widths with the same quota scale; leave the token block's sizing independent. Pack quota sections with preset spacing rather than distributing arbitrary remaining space between them.

Comfortable must fit the current five providers with two Claude and two Codex accounts (seven total accounts). Compact must fit five providers with four Claude and four Codex accounts (eleven total). These are explicit acceptance examples, not a new automatic capacity algorithm. Before adding a provider or increasing the lineup, select/check the compact preset as needed. Larger combinations beyond those examples require a new layout/capacity decision; never silently drop accounts, clip content, or shrink type unpredictably.

### Reset and failure presentation

- Healthy, future reset: display its countdown and remaining percentage, including `0%` on an exhausted account.
- Reset time unknown: show the remaining percentage with a short unknown-reset indication; details explain that the source did not report a reset time. Do not invent a countdown.
- Reset time passes before a new measurement: show `resetting…`. Do not turn the quota into 100%, hide a constraining window, or announce availability based on the clock alone. Mark the carried meter as an old reading until it is refreshed.
- Stale or transiently unavailable, with a last-good binding reset still ahead: retain the dimmed last-good percentage, meter, and countdown. Expose stale/error state and reading age in details; a compact age cue must distinguish an old reading from a fresh one on the rail.
- Stale/unavailable after the last-good binding reset, or with no last-good measurement: suppress the obsolete percentage and filled meter. Show the age or unavailable state instead. Never present an old filled bar as current headroom.
- Authentication required: replace the normal numeric readout with `Sign in again`; retain historical windows internally for diagnosis. Suppress the ordinary percentage/meter fill so this state is immediately actionable. A known future reset can be inspected in details as historical schedule information.

Failure of one account must not dim or erase a successful sibling. Whole-collector liveness remains separately visible through the existing provider/daemon health treatment.

### Read-only details

Tapping an account or single-provider meter opens its own details, showing provider/numeric account label, known/unknown active status, each quota window and reset, source measurement age, and normalized health/recovery guidance. Never display raw upstream errors or credentials.

For Claude `auth_required`, explain that the saved sign-in needs renewal through cswap. The UI does not perform login, rotate credentials, launch an account switch, or force a refresh. Support close, outside-tap, Escape, and focus restoration. Keep rail taps separate from board paging gestures. The always-visible countdown remains sufficient for the normal wait-and-switch workflow.

## Implementation boundaries

| Area | Responsibility |
| --- | --- |
| `src/core/quota.ts` and provider adapters | Bounded collection, per-record normalization, identity/label retention, partial failure handling, atomic publication. |
| `src/quota-snapshot.ts` | Version-3 validation and shared account data contract. |
| `app/src/quota.ts` | Pure account view models, binding windows, freshness/error decisions, formatting. |
| `app/src/rail.ts` and the existing overlay boundary | Generic Claude/Codex grouped rendering and read-only account details. |
| `app/styles.css` plus one density definition | Inline layout, current typography hierarchy, comfortable/compact presets. |

Do not change `src/protocol.ts`, session identity, board packing, provider model invocation, or token-usage collection for this feature. Preserve unrelated provider behavior and the existing pre-commit hooks.

## Verification and acceptance

Use synthetic provider responses and injected subprocess dependencies for automated checks. Test behavior and structured results, not long rendered HTML/shell strings or incidental wording.

Required collection tests:

1. Two distinct Codex results produce separate readings; source order changes, active changes, and daemon restart do not mix identities or labels.
2. A nonzero-exit response containing one success and one identified error updates the successful account and retains the other's own last-good state.
3. Malformed/truncated JSON, timeout, duplicate labels, missing identity, and partial inventories cannot transfer readings or remove accounts accidentally.
4. A complete successful inventory can add/remove accounts and transition between grouped and single-provider presentation.
5. Claude `relogin_required` remains distinguishable from unavailable/rate-limited cases. A successful read clears only the relevant account's failure.
6. Source timestamps survive cached reads, failures, and restart. Collection time never makes an old measurement fresh. Aborted passes do not partially commit account state.
7. No raw identities, errors, or credential material enter snapshots or diagnostics.

Required view/interaction tests:

1. Binding window, percentage, and countdown refer to the same account/window, including scoped windows and secondary ticks.
2. Countdown-first order and muted-note/bright-percentage treatment apply to both single and grouped providers.
3. Exhaustion, unknown reset, reset crossing, stale reading, unavailable without history, and authentication-required states remain distinct and honest.
4. Codex unknown activity never creates a dot or an active-account claim.
5. Details target the clicked account and close without triggering board paging or account mutations.

Run the relevant quota parser/collector/rail tests, typecheck, and the repository's required `bun run check` before claiming implementation complete. Visual verification must use the real renderer at 2560 × 720 for both specified density examples, long countdowns, capped scoped labels, three-digit percentages, and error states. Confirm no overlap/clipping and preserved touch/focus behavior.

Installed acceptance is a separate gate: build/install the app and daemon together, verify the running artifacts, and observe advancing per-account source timestamps. Check the comfortable treatment on the physical strip for type readability and tap targets. Browser mockups alone are not physical proof.

Demonstrate independent refresh while leaving the selected account unchanged. Codex's diagnostic two-account success is not this integrated proof. Claude's known re-login requirement needs to be resolved through its source before both-account freshness can pass; until then, verify the correct auth-required UI and report refresh acceptance as incomplete. Do not call the inactive-account refresh problem fixed merely because its stale numbers are visible.

## Review boundary

This spec includes concrete proposed backend decisions that were not exercised by the visual mockups: source-label-based Codex identity, unknown Codex active state, partial-error inventory rules, freshness limits, and coordinated schema version 3 without a migration. Drew should review those alongside the settled layout. After approval, write an implementation plan; do not treat this spec or its mockup commits as implementation or deployment evidence.
