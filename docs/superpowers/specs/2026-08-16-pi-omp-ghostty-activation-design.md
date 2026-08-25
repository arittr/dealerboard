# pi and omp Ghostty terminal activation design

Date: 2026-08-16

Status: Approved by Drew on 2026-08-16; amended the same day after a three-reviewer swarm review (codex/gpt-5.6-sol, claude/claude-fable-5, grok/grok-4.6). The amendment fixes a unanimous critical finding (the v9→v10 migration path could brick an installed database), adds omp session-transition handling to scope (Drew's call), reorders the installer to keep plugin and daemon in lockstep, and folds in the reviewers' minor findings.

Extends: [`2026-08-07-claude-ghostty-activation-design.md`](2026-08-07-claude-ghostty-activation-design.md) and [`2026-08-15-four-new-providers-design.md`](2026-08-15-four-new-providers-design.md). This design reuses the Claude Ghostty binding mechanism end to end; it changes which providers may carry a binding, plus the omp shim's session-transition emissions and the installer's deploy ordering.

## Goal

Pressing a visible pi or omp session tile on the Stream Deck focuses the exact existing Ghostty terminal in which that session is running, when the session started directly in a manual Ghostty terminal — identical to the Claude tile behavior shipped in the extended design.

pi and omp are wired together because both shims spawn the hook helper detached directly from the provider process, so the helper's `process.ppid` is the provider's foreground PID — the same identity join Claude's binding relies on. (`detached: true` is setsid, not reparenting: the helper's immediate parent stays the provider while the provider lives, and neither shim overrides `env`, so `TERM_PROGRAM`/`TMUX` inherit.)

## User-visible contract

- Pressing a bound pi or omp tile brings Ghostty to the foreground and focuses the exact terminal captured for that session.
- Pressing an unbound pi or omp tile shows Stream Deck's native alert treatment and otherwise does nothing — the same as an unbound Claude tile today.
- Pressing a tile whose stored terminal no longer exists shows the same alert and otherwise does nothing.
- An omp session entered through an in-process transition (`/new`, `/resume`, `/fork`, history branch) binds the terminal of its hosting process when that transition is reported — see "omp session transitions" below.
- A Paseo-origin pi or omp tile with a known agent reference keeps routing to the Paseo deep link; the origin check precedes provider routing and is unchanged.
- Codex tiles keep `codex://threads/<thread>`, Kimi tiles keep the Web session URL, and zcode and deepseek tiles keep the alert-only behavior.
- A press never opens Ghostty, creates a terminal, launches or resumes a session, types text, or changes terminal state.
- Binding success or failure adds no badge, color, label, or animation; rendering is untouched.

## Scope decision

The `ghostty_terminal_id` column CHECK is widened from `provider = 'claude'` to `provider IN ('claude', 'pi', 'omp')`. Drew chose this whitelist explicitly over:

- **pi only** — rejected; omp is symmetric in spawn mechanics and named in scope.
- **All current providers** — rejected; zcode and deepseek gain nothing (no wiring planned) and should stay excluded at the schema layer.
- **Fully generic** (drop the provider clause) — rejected; the schema keeps stating which providers are meant to carry bindings, so a bug stamping one on the wrong provider is caught at the database layer.

The whitelist is encoded in five places, not three: the schema CHECK, `parseSession` (`src/protocol.ts`), the projection guard (`src/core/projection.ts`), `applySessionStart` (`src/core/registry.ts`), and the CLI enrichment branch (`src/core/cli.ts`). The SQL CHECK cannot import the constant; a schema test keeps the two in lockstep.

## Design

### Naming generalization

The binding machinery stops being Claude-specific, so the Claude-named pieces are renamed provider-neutrally (approach A, chosen over keeping misleading names):

- `src/core/claude-ghostty-binding.ts` → `src/core/ghostty-terminal-binding.ts`; `ClaudeGhosttyBindingContext`, `DiscoverClaudeGhosttyTerminal`, `createClaudeGhosttyTerminalDiscoverer`, and `discoverClaudeGhosttyTerminal` lose the `Claude` infix.
- The whitelist lives in `src/protocol.ts` as `GHOSTTY_BINDABLE_PROVIDERS` (`claude`, `pi`, `omp`), next to `PROVIDER_KEYS`. `protocol.ts` is the pure shared contract module (no runtime imports, bundled into the plugin), and every consumer — snapshot parser, projection, registry, CLI — already imports it; the binding module keeps its `node:child_process` import and must not leak into the plugin bundle through a shared import. Typing pin: declare it `new Set<Provider>([...])` typed as `ReadonlySet<Provider>`, and at call sites where the value is still a `string` (e.g. `parseSession`), narrow with the existing `as Provider` cast only after the `PROVIDERS.has` validation, matching `src/protocol.ts:195`'s existing pattern. `src/core/registry.ts`'s protocol import is currently type-only and becomes a mixed value/type import with explicit `type` modifiers under `verbatimModuleSyntax`.
- `src/plugin/claude-session-activation.ts` → `src/plugin/ghostty-terminal-activation.ts`; `ActivateClaudeSession`, `createClaudeSessionActivator`, and `activateClaudeSession` become `ActivateGhosttyTerminal`, `createGhosttyTerminalActivator`, and `activateGhosttyTerminal`.
- The diagnostic code `claude_terminal_unbound` becomes `ghostty_terminal_unbound` (`src/core/diagnostics.ts` union plus the CLI report call) — provider-neutral but still honestly Ghostty-specific. The `provider` and `sessionId` fields on the record already identify the session.
- The controller port `activateClaudeSession` becomes `activateGhosttyTerminal`.
- `test/claude-ghostty-binding.test.ts` and `test/claude-session-activation.test.ts` are renamed to match.

No behavior changes inside the renamed adapters: the AppleScript programs, gates (`TERM_PROGRAM=ghostty`, no `TMUX`, valid parent PID, exactly one native match, bounded id, `/dev/tty...` sanity check), 300 ms timeout, and fail-open null contract are all preserved as-is.

### Trusted SessionStart enrichment (CLI)

`src/core/cli.ts` widens the enrichment branch from `providerArg === "claude"` to membership in `GHOSTTY_BINDABLE_PROVIDERS`, still only when the first decoded event is a `SessionStart`. The enrichment input remains the helper's own inherited environment (`TERM_PROGRAM`, `TMUX`) and `process.ppid` — native hook JSON can never supply a terminal target, preserving the existing trust boundary (`decodeNativeHook` hard-nulls `ghosttyTerminalId` on every decoded start).

For pi and omp the helper is spawned detached directly from the provider process, so `process.ppid` is the provider's foreground PID, matching what Ghostty reports as the terminal's `pid` while the provider runs in the foreground. The 300 ms discovery fits comfortably inside the shims' 2 s settle timeout.

Late joins are unchanged: a `SessionObserved` that synthesizes a `SessionStart` still passes `ghosttyTerminalId: null`, so a session whose start hook was missed stays unbound — parity with Claude, no per-prompt AppleScript cost.

There is deliberately **no origin gate**: a Paseo-spawned pi/omp session whose environment carries `TERM_PROGRAM=ghostty` attempts discovery exactly like a terminal session and stores null because its PID can never be a Ghostty terminal's foreground PID (Paseo agents are not terminal foreground processes). This matches how Claude ships today; even a phantom binding would be unused because Paseo routing precedes provider routing. (A Paseo-run pi in RPC mode never emits at all, per the shim's `ctx.mode !== "tui"` ghost filter, so the case is mostly unreachable.)

A failed discovery reports `ghostty_terminal_unbound` with the provider and session id and applies the start with a null binding, exiting zero. Binding failure can never block or suppress the session.

### omp session transitions

One omp process hosts many sessions over its lifetime, and every `SessionStart` from it shares the same `process.ppid` — so every omp session binds the *same* Ghostty terminal: the one its process runs in. That is correct by construction and must not be "fixed" later.

But omp only emits `session_start` at process initialization. In-process transitions fire different events (verified against the installed OMP 17.3.4 source): `/new`, `/resume`, and `/fork` fire `session_switch`; history branching mints a new session id and fires `session_branch`; `session_shutdown` is process-exit only. Today the shim refreshes its captured identity on `session_switch`, emits nothing, and ignores `session_branch` — so a transitioned-to session could previously only late-join (null binding, alert-only tile), the common case after the first `/new`.

The omp shim therefore gains transition emissions (Drew's call, 2026-08-16):

- On an **identity-changing** `session_switch` (the captured session id differs from the incoming one) and on `session_branch`, the shim emits a `SessionStart` wire event for the new identity, serialized through the existing FIFO queue like every other emission.
- No `SessionEnd` is emitted for the previous identity. The previous row lingers exactly as it does today from late-join stranding (the existing live receipt `docs/verification/2026-08-16-pi-omp-p2.md` records this); process-exit `session_shutdown` and the 24 h stale prune remain the cleanup paths. Emitting `SessionEnd` would yank a possibly-still-relevant tile and change unread semantics — out of scope.
- A same-id `session_switch` (a reload of the current session) emits nothing: the row and binding are already correct, and a `SessionStart` reuse would needlessly clear `unread_since`.

Each transition `SessionStart` flows through the normal CLI path, so discovery runs and the new identity binds the hosting process's terminal. Whether the switch payload carries an allowlisted transcript path determines how quickly title resolution catches up; a missing one backfills on the next prompt's `SessionObserved`, as with any late join.

The pi shim is unchanged: pi ends the old row via `session_shutdown` → `SessionEnd` on `/new`/`/resume`/`/fork`, and the replacement session is expected to fire `session_start` (fresh discovery, new id). The shim code and the prior four-providers design hedge with "session_start *(or late-join)*", so the verification plan below includes a live probe confirming pi actually fires it; if the probe shows late-join instead, a `/new`'d pi session stays alert-only and that limitation is documented rather than patched in this change.

### Registry schema v10

SQLite cannot alter a CHECK, so v10 is a table rebuild. The review swarm found the ordering hazard that this section pins down precisely.

**The hazard:** today `migrateToV8` never runs on a v9 database because `version < LATEST_SCHEMA_VERSION` is false. The moment `LATEST_SCHEMA_VERSION` becomes 10, a v9 database re-enters the migration block, and an unconditional `migrateToV8` would commit `PRAGMA user_version = 8` — a durable downgrade of the stamp on a database that still has the v9 shape. `migratePostV8` then skips the v9 migration (its filter compares against the *original* version 9), and if anything interrupts before the v10 rebuild commits — a crash, or the rebuild's own rollback — the database is left stamped 8 with `acked_at` present. Every retried init would then die on `ALTER TABLE ... ADD COLUMN acked_at` (duplicate column), `openRegistryDatabase` would refuse the database, and recovery would require manual `PRAGMA user_version` surgery. A single transient v10 failure would permanently brick init.

**The pinned ordering in `initializeDatabase`:**

1. `migrateToV8` is gated on the *original* version: `if (version < 8) migrateToV8(db)`. A v8 or v9 database does not need the shape repair; a v7 database still gets it.
2. The v10 rebuild is **not** an entry in `MIGRATIONS` — that loop runs in one transaction, and `PRAGMA foreign_keys` is a no-op inside a transaction (the reason v5 is special-cased).
3. `migrateToV10` runs strictly last, after `migratePostV8`, special-cased like `migrateToV5`: `PRAGMA foreign_keys = OFF`, one transaction, `foreign_key_check` before commit, enforcement restored after. The archive table is named `active_sessions_v9_archived`, following the v4 precedent.
4. The v10 `CREATE TABLE` is a **verbatim clone** of the post-v9 table DDL — `WITHOUT ROWID`, composite primary key, self-referential foreign key with `ON DELETE CASCADE`, slot/parent CHECK, and the provider/status/background/model/origin/transcript column CHECKs — changing *only* the `ghostty_terminal_id` predicate. "Every current column" is not sufficient: dropping `WITHOUT ROWID` or the slot CHECK would silently change the storage contract. Rows are copied with an explicit full column list (`model`, `origin_kind`, `origin_ref`, `origin_subagent`, `unread_since`, `acked_at` included), and the partial unique slot index is recreated after the archive is dropped.
5. The `MIGRATIONS` ordering comment is updated to describe the v10 final step.

The new column CHECK:

```sql
ghostty_terminal_id IS NULL
OR (
  provider IN ('claude', 'pi', 'omp')
  AND parent_session_id IS NULL
  AND length(ghostty_terminal_id) BETWEEN 1 AND 256
)
```

`LATEST_SCHEMA_VERSION` becomes 10. Existing rows keep all values through the copy, including live Claude bindings. Older binaries refuse a v10 database via `UnsupportedSchemaVersion`, and the installer's newer-database refusal keys off `LATEST_SCHEMA_VERSION`, so it adapts without logic changes.

Fresh-init composition with the gate in place: v1–v4 ALTERs → v5 rebuild (claude-only CHECK) → v6/v7 ALTERs → v8 stamp (gated: runs, since fresh starts at 0) → v9 `acked_at` → v10 rebuild. Correct only because v10 is last.

### Registry, projection, and snapshot protocol

- `src/core/registry.ts` passes `event.ghosttyTerminalId` through for providers in `GHOSTTY_BINDABLE_PROVIDERS` instead of claude-only. Lifecycle semantics are unchanged from the Claude design: a repeated `SessionStart` overwrites the binding including ID-to-null; status and subagent events preserve it; `SessionEnd`, `sessions clear`, and `clear-all` delete it with the row. Child rows always insert null, and a `SessionStart` naming an existing child is ignored — no path gives a child or non-whitelisted row a binding.
- `src/core/projection.ts` widens the root-row guard to the whitelist (error renamed from `non-claude-terminal-binding` to `unbindable-provider-terminal-binding`). The child-row guard (`child-with-terminal-binding`) is unchanged.
- `src/protocol.ts` accepts a non-null `ghosttyTerminalId` for claude, pi, and omp in `parseSession` (using the typing pin from "Naming generalization"); the validation message is updated accordingly. The field remains null-only for every other provider and is never published for child rows.

**Mixed-version failure mode, stated explicitly:** an *old* plugin meeting a *new* daemon throws in `parseSession` on the first bound pi/omp row, and a parse failure degrades the **entire grid** to the last-good/OFFLINE treatment — every tile, not just pi/omp, and only once a pi/omp session actually binds (data-dependent, unlike unknown-provider keys which degrade immediately). The reverse — new plugin, old daemon — is safe because old snapshots always carry null pi/omp ids. Lockstep deploy is the mitigation, which makes the manifest `Version` bump load-bearing rather than ceremonial.

### Plugin press routing

`SessionGridController.keyDown` handles claude, pi, and omp identically: a non-null `ghosttyTerminalId` calls `activateGhosttyTerminal` with that exact ID; a null binding requests one native alert and returns. zcode and deepseek remain alert-only, and the exhaustiveness `never` proof is preserved. The Paseo-origin branch keeps precedence over provider routing — including for a Paseo-origin row that somehow carries a binding.

`src/plugin/plugin.ts` wires the renamed production activator into the renamed port.

### Installer ordering

The installer's current order is not actually lockstep (codex finding, to be re-verified by the implementer against `scripts/install-local.ts:170,224,271`): it swaps, migrates, and starts the new core *before* opening and confirming the new plugin, so a plugin-confirmation timeout exits with the new daemon running and the old plugin installed — exactly the whole-grid degrade case above, once any pi/omp session binds.

The install order is therefore changed to: schema-downgrade preflight first (unchanged), then install, confirm, and restart the version-bumped **plugin**, and only then swap/migrate/start the **core**, with the shim install last (unchanged). New plugin + old daemon is the safe direction, as established above. The partial-failure states are documented in the installer's comments: a core-side failure after the plugin updated leaves new-plugin/old-daemon (safe); a plugin-confirm timeout can no longer strand a new daemon with an old plugin. A re-run converges, as today.

## Failure behavior

Identical to the Claude design, now per pi/omp session as well:

| Condition | Result |
|---|---|
| Session starts directly in a compatible Ghostty terminal with exactly one PID match | Store the stable terminal ID. |
| Session starts outside Ghostty or under tmux | Store null; the tile still appears. |
| Session starts via Paseo | Discovery is attempted but the PID join cannot match (Paseo agents are not terminal foreground processes) → store null; even a phantom binding would be unused because Paseo routing precedes provider routing. |
| Ghostty lacks `pid`/`tty`, is not running, or rejects the query | Store null; no fallback. |
| Zero or multiple PID matches | Store null; do not guess. |
| Query timeout or malformed output | Store null; hook stays fail-open. |
| New `SessionStart` cannot bind | Overwrite any prior binding with null. |
| omp identity-changing `session_switch`/`session_branch` | Shim emits `SessionStart` for the new identity → fresh discovery binds the hosting process's terminal (same process, same terminal). |
| omp same-id `session_switch` (reload) | Shim emits nothing; row and binding are already correct. |
| pi `/new`/`/resume`/`/fork` | Old row ends via `SessionEnd`; the replacement binds if pi fires `session_start` (live probe confirms during verification), else it late-joins unbound. |
| Tile has a null binding, the stored terminal is gone, or activation rejects | One native alert; no retry, no launch. |
| Paseo-origin tile with a known ref | Paseo deep link, regardless of any stored binding. |
| Old plugin meets a new daemon snapshot with a bound pi/omp row | Whole-grid degrade to last-good/OFFLINE until the plugin updates; prevented by lockstep deploy. |

## Test strategy

TDD against structured behavior, mirroring the existing Claude coverage.

**Schema (the highest-risk change):**

- v9 → v10 rebuild with a fixture seeding *every* nullable/defaulted field to a non-default value (Claude binding, `model`, origin fields, `unread_since`, `acked_at`, background flag, transcript, both timestamps, child row): all values and slots survive; the partial index, self-FK cascade, and `WITHOUT ROWID` behavior are preserved.
- Fault injection: a v9 database whose v10 rebuild fails keeps `user_version = 9` and the original table, and a retry converges to 10 (this test fails without the `version < 8` gate). Separately, a database reaching the stamped-8-with-v9-shape state is covered by the gate test: with the gate, `migrateToV8` never re-runs for `version >= 8`.
- pi and omp rows accept bindings; zcode/deepseek rows and child rows are rejected by the CHECK.
- Migration from pre-v9 versions composes through the v5/v8/v9 path to v10; fresh init lands at 10; repeated init is idempotent; a future unknown version stays untouched.
- The schema CHECK's provider list is asserted equal to `GHOSTTY_BINDABLE_PROVIDERS` (lockstep test).

**CLI:** a pi and an omp `SessionStart` invoke discovery and stamp the event; a zcode `SessionStart` does not; discovery failure still applies the start with null and reports `ghostty_terminal_unbound` with the right provider; an omp transition-driven `SessionStart` enriches identically.

**omp shim (new):** identity-changing `session_switch` emits exactly one `SessionStart` for the new identity in FIFO order; `session_branch` emits `SessionStart` for the minted id; same-id `session_switch` emits nothing; no `SessionEnd` is emitted on any transition; process-exit `session_shutdown` behavior unchanged.

**Registry:** pi/omp `SessionStart` stores and overwrites the binding; zcode/deepseek store null; repeated start overwrites ID-to-null; child rows stay null.

**Projection:** whitelisted roots project their binding (add a pi and omp case); a non-whitelisted root with a binding throws the renamed error; child-with-binding still throws.

**Protocol:** snapshots with bound pi/omp sessions parse; a bound zcode or deepseek session rejects; bound child rows never appear (covered by projection).

**Controller:** bound pi and omp tiles pass their exact stored ID to `activateGhosttyTerminal` once; unbound tiles request one alert and invoke no activator; zcode/deepseek stay alert-only; a Paseo-origin pi tile *with* a non-null binding still routes to the Paseo deep link and never invokes the Ghostty activator; the existing `test.each(["pi","omp","zcode","deepseek"])` alert-only case (`test/controller.test.ts:681`) splits accordingly.

**Installer:** the plugin install/confirm/restart step is ordered before the core swap/start; the downgrade preflight still runs before both; a simulated plugin-confirm timeout leaves the old core untouched.

**Rename fallout (breaks typecheck or asserts the old contract if missed):**

| Site | What changes |
|---|---|
| `test/cli.test.ts` | `ClaudeGhosttyBindingContext`, `discoverClaudeGhosttyTerminal`, `claude_terminal_unbound`, `user_version: 9` pins (lines ~125, ~1226), "enriches only Claude" |
| `test/projection.test.ts:298-304` | `non-claude-terminal-binding` error string; add pi/omp-root-publishes cases |
| `test/controller.test.ts:231` | `activateClaudeSession` port name |
| `test/protocol.test.ts:195-197` | "rejects non-Claude" → accepts pi/omp, still rejects zcode/deepseek |
| `test/registry.test.ts:295-301` | "normalizes non-Claude" → pi/omp pass through, zcode/deepseek still null |
| `test/schema.test.ts` | every `user_version: 9` pin (lines 114, 171, 187, 578, 696, 748, 800, 850, 863, 949, 1010, 1056) |
| `test/claude-ghostty-binding.test.ts`, `test/claude-session-activation.test.ts` | renamed to match the modules |

**Binding and activation modules:** unchanged gate coverage, exercised under the new names.

## Repository verification

1. `bun test`
2. `bun run typecheck`
3. `bun run check` (Biome gate + build + tests)

Deployment is the full local installer (`bun scripts/install-local.ts`) with a manifest `Version` bump first, because the schema, snapshot contract, plugin, and installer change together.

Live acceptance after install:

- **Probe (pi):** start a pi session in a Ghostty terminal, confirm a non-null binding is stored; run `/new` and confirm whether pi fires `session_start` (replacement binds) or only late-joins (alert-only limitation, documented).
- **Probe (omp):** start omp in a Ghostty terminal, confirm binding; run `/new` (and a history branch if available), confirm the shim emits `SessionStart` and the new identity binds the same terminal.
- **Physical:** with Ghostty backgrounded, press bound pi and omp tiles and confirm each exact terminal foregrounds; press an unbound tile (e.g. a tmux-hosted session) and confirm one alert; confirm a Paseo-origin pi tile still opens the Paseo deep link.

## Expected implementation files

- `src/protocol.ts` — the `GHOSTTY_BINDABLE_PROVIDERS` whitelist and widened snapshot validation.
- `src/core/ghostty-terminal-binding.ts` — renamed discoverer.
- `src/core/cli.ts` — widened enrichment branch, renamed dep and report code.
- `src/core/diagnostics.ts` — renamed diagnostic code.
- `src/core/schema.ts` — gated `migrateToV8`, v10 rebuild migration, version bump, ordering comment.
- `src/core/registry.ts` — whitelist-based binding passthrough, mixed value/type protocol import.
- `src/core/projection.ts` — widened root guard, renamed error.
- `extensions/omp/stream-deck-agents.ts` — transition-driven `SessionStart` emissions.
- `src/plugin/ghostty-terminal-activation.ts` — renamed activator.
- `src/plugin/controller.ts` — pi/omp routing and renamed port.
- `src/plugin/plugin.ts` — production wiring.
- `scripts/install-local.ts` — plugin-before-core install ordering with documented partial-failure states.
- Renamed and extended tests under `test/` (blast-radius table above), plus omp shim tests.
- `AGENTS.md` — *add* a binding conventions paragraph (none exists today), update the schema-version sentence (v9 → v10), and note the omp transition emission in the lifecycle text.
- `docs/design.md` — press-routing contract (line ~65) and the schema-version reference (line ~93).
- `docs/hook-configuration.md` — pi/omp share Claude's direct-Ghostty/no-tmux prerequisites; document omp transition behavior.
- `com.drewritter.stream-deck-agents.sdPlugin/manifest.json` — tooltip/description copy (pi/omp Ghostty activation alongside the existing routes) plus the load-bearing `Version` bump.

No changes are expected in the renderer, layout reducer, scheduler, pi shim, hook payload shapes, origin detection, Paseo overlay, or title/model resolution.

## Explicitly out of scope

- zcode and deepseek terminal binding (schema whitelist excludes them).
- Codex and Kimi activation changes; both keep their existing routes.
- tmux, screen, SSH, or other terminal emulators; ancestor walking.
- Binding discovery on late join (`SessionObserved`) or any per-prompt re-discovery.
- `SessionEnd` emissions for omp transitions, and any change to stranded-row cleanup, unread semantics, or the stale prune.
- An origin gate on discovery (rejected: the PID join cannot match for Paseo agents; Claude ships the same way).
- Paseo-origin routing changes.
- Launching Ghostty, creating terminals, resuming sessions, or typing into a terminal.
- PID-, TTY-, cwd-, title-, recency-, or frontmost-based fallback targeting.
- Any visible-tile contract change: colors, marks, labels, and animation are untouched.
