# Four new providers: pi, oh-my-pi, zcode, deepseek harness — design

Date: 2026-08-15
Status: approved design, revision 2 (post adversarial review), pre-plan

Revision 2 incorporates a three-reviewer adversarial pass (Fable 5/Claude,
GPT-5.6-Sol/Codex, K3/Kimi — all REVISE-THEN-SHIP). Every blocker/major
finding was verified against the code before adoption; the review log at the
bottom records dispositions, including the few declines.

## Summary

Add four session providers to stream-deck-agents alongside claude/codex/kimi:

| Provider key | Tool | Integration mechanism | Difficulty class |
|---|---|---|---|
| `zcode` | ZCode by Z.AI (closed-source Electron ADE, GLM models) | Config-only native hooks in `~/.zcode/cli/config.json` | (a) config-only |
| `pi` | pi by Mario Zechner / earendil-works (`@earendil-works/pi-coding-agent`) | Shipped TS extension shim, auto-discovered from `~/.pi/agent/extensions/` | (b) shim |
| `omp` | oh-my-pi by can1357 (`@oh-my-pi/pi-coding-agent`, bin `omp`) | Shipped TS extension shim, auto-discovered from `~/.omp/agent/extensions/` | (b) shim |
| `deepseek` | DeepSeek Harness (`deepseek-ai/deepseek-harness`, CLI `dsh`, pre-1.0 RC) | Shipped native Cordis plugin, loaded via profile `cordis.patch.yml` | (b) shim |

Research is dated 2026-08-15 and was spot-checked live by the reviewers.
pi/omp release multiple times per week (omp: multiple times per day), zcode
weekly, dsh is an explicit developer preview. Every external contract cited
below is re-verified against the installed build during its phase's live
verification.

## Decisions

- **Scope:** all four providers in one spec; implementation lands in phases
  (P0 core → P1 zcode → P2 pi + omp → P3 deepseek), each phase independently
  shippable and green on `bun run check`.
- **Subagent child rows:** omp and dsh only (native lifecycle events). zcode
  (Agent-tool `PreToolUse` proxy) and pi (third-party `subagent` extension
  heuristic) are deferred until live probes prove them.
- **Install:** `scripts/install-local.ts` copies the three shim files we own
  into the providers' extension dirs (details in §Install — token
  substitution, ownership markers, provider-dir-exists gating, ordering).
  Edits to user-owned config files (zcode `config.json`, dsh
  `cordis.patch.yml`) stay manual and documented in
  `docs/hook-configuration.md`.
- **Titles in v1:** omp pull (session-file title slot), zcode pull (SQLite
  `session.title`), pi and dsh push. Push uses a **new canonical registry
  event** (`SessionTitleChanged`, below) — the original plan to reuse
  `SessionObserved` does not work: `applySessionObserved` deliberately
  ignores title on existing rows (`registry.ts:200-211`), and the only other
  push path (titled `SessionStart`) force-resets status to idle.
- **Architecture: shims normalize, core stays canonical.** Shims emit the
  canonical hook event names with allowlisted payload fields; zcode's native
  hooks already speak Claude-style field names. The canonical vocabulary
  grows by exactly two: one new hook *name* (`PostToolUseFailure`, zcode
  native) and one new registry *event kind* (`SessionTitleChanged`). One
  principled exception: `PostToolUseFailure` handling lives in the core
  decoder because zcode has no shim — noted as a deliberate bend of the
  "churn lives in shipped templates" rule.
- **Verification:** all four tools are installed locally; every phase closes
  with live physical verification.
- **zcode gets a shorter stale lease** (1h instead of 24h): it has no
  SessionEnd, and the global 24h TTL would leave dead tiles holding logical
  slots for a day. Late-join resurrects a row on the next prompt.

## Core plumbing (P0)

### Every provider-locked site

Six places enumerate providers literally; all change in P0:

1. `src/protocol.ts` — `Provider` union + `PROVIDERS` set (snapshot parser).
2. `src/core/projection.ts:58` — second `PROVIDERS` set. **Unwidened, one
   new-provider row makes `toProjectionRow` throw `corrupt-row`, the whole
   `readProjection` rolls back, and the daemon publishes the degraded
   snapshot forever — a single zcode SessionStart blacks out every tile.**
3. `src/core/cli.ts:55,111` — `isProvider` + the `USAGE` grammar line.
4. `src/plugin/render.ts:44` — `PROVIDER_COLORS`.
5. `src/plugin/controller.ts:172` — `keyDown` provider switch. New providers
   fall through to a silent no-op today; v1 behavior is defined as
   `showActivationAlert` (same as an unbound Claude tile), covered by a
   controller test.
6. `src/core/schema.ts` — the `CHECK (provider IN (...))`, via the v5
   migration below.

`protocol.ts` exports one provider-key tuple; projection and cli derive
their sets from it. The SQL CHECK, the exhaustive `Record<Provider, …>`
maps, and the controller switch remain separately compiled/tested guards.

### New canonical event: `SessionTitleChanged`

`RegistryEvent` gains
`{ kind: "SessionTitleChanged"; provider; sessionId; title: string; observedAt }`.
Registry applies it as a title-only update when the row exists and the title
differs — preserving `updated_at` (the prune lease), status, project, and
background state, exactly like `updateSessionTitles`. An unknown identity is
**ignored**: titles never late-join a row (membership is still proven by
prompts). Decoder accepts it from the `SessionTitleChanged` hook name that
pi/dsh shims emit. Tests: title-after-start, repeated renames, unknown
identity ignored, no status/`updated_at` side effects.

### Registry schema v5

The provider CHECK cannot be altered in place, so v5 rebuilds
`active_sessions`. Exact prescribed sequence (reviewers verified the naive
version is unimplementable — `PRAGMA foreign_keys` is a no-op inside a
transaction and the partial unique index does not survive a drop):

1. The installer stops the daemon (`launchctl bootout`) **before** running
   `init`, and bootstraps it after — the current order (migrate at step 5,
   bootout at step 7) runs the rebuild against a live writer with a 250ms
   busy timeout.
2. `PRAGMA foreign_keys = OFF` **before** `BEGIN` (the pragma toggles live
   outside `bun:sqlite`'s `db.transaction()` wrapper; the rebuild uses
   explicit `BEGIN`/`COMMIT` execs).
3. `ALTER TABLE active_sessions RENAME TO active_sessions_v4_archived` —
   the v4 table moves aside first (SQLite rewrites its self-FK to the
   archived name, so it drops cleanly with it later).
4. `CREATE TABLE active_sessions` directly under the final name with the
   full DDL: `WITHOUT ROWID`, composite PK, every v2–v4 column and CHECK,
   and the widened provider list.
5. `INSERT INTO … SELECT` with an explicit column list, `DROP TABLE
   active_sessions_v4_archived`, then explicitly recreate the partial unique
   index `active_sessions_unique_slot`.
6. `PRAGMA foreign_key_check`; any violation rolls back. `COMMIT`;
   `PRAGMA foreign_keys = ON`.

`LATEST_SCHEMA_VERSION` becomes 5. Migration test: a v4 database containing
a parent/child/grandchild tree upgrades with all rows, columns, the index,
and constraints intact, a clean `foreign_key_check`, failed-migration
rollback, and a live second connection exercising the busy behavior.

### Decoder (`src/core/providers.ts`)

- `SAFE_FIELDS` gains `is_interrupt` — a **boolean-only** reader (the
  existing readers are string-only), classified in place and never stored;
  `PostToolUseFailure`'s `error` field is never read. The privacy note in
  `docs/hook-configuration.md` gains this third in-place signal.
- `PostToolUseFailure` → `Stop` when `is_interrupt === true`, else zero
  events. Provider-locked to zcode, consistent with the other special cases.
- zcode's `transcript_path` is a temp file deleted after the hook run: the
  decoder suppresses it to `null` **for zcode only** (stores null; does NOT
  trip the whole-event ephemeral drop, which remains Codex's explicit-null
  contract, unchanged). Covered by fixtures.
- Shim wire contract, stated once and binding on all three shims: emitted
  payloads contain only `SAFE_FIELDS` names plus `is_interrupt`; **raw
  native event objects are never spread** (dsh `agent/pre-step` carries full
  prompt messages; omp events carry `input.text` — the 64 KiB stdin +
  allowlist design exists precisely to keep prompt text inside the provider
  process); absent fields are **omitted, never sent as explicit `null`**
  (an explicit `transcript_path: null` drops the whole event sequence,
  which would silently eat e.g. SubagentStart).

### Rendering

`PROVIDER_COLORS` gains brand-matched chips (sites checked 2026-08-15):
pi `#0EA514` (pi.dev accent), omp `#F5F0EA` (omp.sh signature cream),
zcode `#49A1E8` (zcode.z.ai accent), deepseek `#426EFE` (deepseek.com brand).
Marks: PI, OM, ZC, DE. Known trade-offs, accepted: zcode/deepseek/kimi are
all blues (letters carry the distinction) and the omp cream sits near text
brightness — both eyeballed in the render verification. `docs/design.md`
updated.

### Helper CLI

`event <provider>` and `sessions clear <provider>` accept the four new keys
via the shared tuple. The stdin/exit-0/64 KiB contract is unchanged (zcode's
fat native payloads — full `tool_response`, full prompt — raise overflow
odds; an oversized payload is dropped wholesale and the transition is lost.
Accepted and documented for v1; the shims control their own payload sizes,
so only zcode is exposed).

## Provider integrations

### zcode (P1, config-only)

- **Config:** user merges this exact shape into `~/.zcode/cli/config.json`
  (matcher-group nesting verified live against the 2026-08-15 docs — the
  flat executor form is what strict validation silently kills):

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart":      [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "UserPromptSubmit":  [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PreToolUse":        [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PostToolUse":       [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PostToolUseFailure":[{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "PermissionRequest": [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }],
      "Stop":              [{ "hooks": [{ "type": "process", "command": "<helper>", "args": ["event", "zcode"], "timeoutMs": 2000 }] }]
    }
  }
}
```

  Docs state: `timeoutMs` is milliseconds, never `timeout` (seconds); hooks
  are snapshotted at session start, so new sessions are required; if the
  installed build rejects `args` (known bug on some 2026-06/07 builds), fall
  back to `type: "command"` with one quoted shell string. The "one unknown
  key disables the whole hooks section" warning is downgraded to
  build-history caution — current docs say unknown fields are ignored; the
  P1 verification probes hook delivery live regardless.
- **Event mapping:** SessionStart → register; UserPromptSubmit → late-join +
  working; PreToolUse → working; PostToolUse → working; PermissionRequest →
  waiting; Stop → idle; PostToolUseFailure(`is_interrupt: true`) → Stop.
  zcode's Stop does not fire on user interrupt; an interrupt between tool
  calls can leave the tile `working` until the next event or the (1h) lease —
  accepted, documented.
- **Titles (pull):** `titles.ts` gains a zcode resolver over
  `~/.zcode/cli/db/db.sqlite` (override root via `ZCODE_HOME`, injected via
  DI). **No (mtime,size) cache** — zcode's database is WAL, so committed
  titles can live in `db.sqlite-wal` without touching the main file's stat;
  the resolver simply re-queries on the existing 2s cadence (one indexed
  lookup per live zcode row) over a read-only connection, and skips the pass
  on `SQLITE_BUSY`. Connection lifecycle (held vs per-pass) is pinned in the
  plan. Test: a second connection commits a title in WAL without
  checkpointing, and the resolver still sees it.
- **Ghost probe (P1 gate):** whether side chats (`/side`, `/btw`),
  scheduled automation, and headless sessions fire SessionStart is
  undocumented — probe live and filter by `source`/`agent_type`/`cwd` if
  needed; "accept, the 1h lease covers it" is an allowed outcome but must be
  a decision, not an accident.
- **No subagent rows in v1.**

### pi (P2, shipped shim)

- **Template:** `extensions/pi/stream-deck-agents.ts` — one dependency-free
  TS file with local structural interfaces (no imports from pi packages, so
  jiti loads it bare). Covered by tsconfig typecheck and Biome lint (see
  §Build gate). Installer copies it to `~/.pi/agent/extensions/`.
- **Event mapping** (pi native → canonical):
  - `session_start` → SessionStart
  - `input`, only when `source === "interactive"` → UserPromptSubmit
  - `tool_execution_start` / `tool_execution_end` → PreToolUse / PostToolUse
    (deliberately not `tool_call`, which is fail-closed on throw)
  - `session_info_changed` → SessionTitleChanged carrying `title`
  - `session_shutdown` → SessionEnd for **every** reason, not just `quit`:
    `/new`, `/resume`, `/fork` open a fresh session under a new id, and the
    old row would otherwise linger as a dead tile until the prune. The
    following `session_start` (or the next prompt, via late-join)
    re-registers — this codebase's own philosophy.
- **Terminal-outcome latch (required):** pi fires `agent_end` before
  `agent_settled`, and `applyStop` unconditionally rewrites status — so
  StopFailure-then-Stop would flash the error tile and settle idle. The shim
  latches when the ending run's `agent_end` carried
  `stopReason === "error"`, emits `StopFailure` at `agent_settled` when
  latched and `Stop` otherwise, then clears the latch. Exactly one terminal
  event per turn. Tested with both upstream orderings.
- **Ghost filter (required):** emit nothing when
  `ctx.sessionManager.getSessionFile()` is undefined or `ctx.mode !==
  "tui"`. Extensions load in every pi process (print/json/rpc subagents
  included); without this every subprocess spawns a tile.
- **Payload:** `hook_event_name`, `session_id`
  (`ctx.sessionManager.getSessionId()`), `cwd`, `transcript_path`
  (`getSessionFile()`), `title` via **`pi.getSessionName()`** (ExtensionAPI
  method — the research sketch's `ctx.sessionManager` receiver is wrong),
  omitted when undefined, `tool_name` where relevant. Helper spawned
  detached via `child_process.spawn` with stdin piped, `unref`ed, never
  awaited; every handler body try/caught.
- **Interrupt probe (P2 gate):** whether `agent_settled` fires after an
  Escape abort is unverified in research and docs; pi's entire idle
  transition rests on it.
- **Titles:** push only (pi titles are manual via `/name`); unnamed sessions
  fall back to project name.
- **Gaps:** no permission/question surface (never `waiting`), no subagent
  rows in v1.

### omp (P2, shipped shim)

- **Template:** `extensions/omp/stream-deck-agents.ts`, same structural
  approach → `~/.omp/agent/extensions/`.
- **Event mapping** (omp native → canonical):
  - `session_start` → SessionStart
  - `input` (`source === "interactive"`) → UserPromptSubmit
  - Prefer `tool_execution_start` / `tool_execution_end` (fork parity with
    pi) for PreToolUse / PostToolUse if present in the installed omp;
    otherwise `tool_call` / `tool_result` with fully try/caught bodies
    (`tool_call` is fail-closed). Verified at implementation. The shim
    normalizes omp's `ask` tool to `tool_name: "AskUserQuestion"` so the
    decoder's existing waiting rule fires unchanged.
  - `tool_approval_requested` → PermissionRequest. The handler is
    **observe-only and returns undefined**; a live probe confirms approval
    UX is unchanged with the shim installed.
  - `session_stop` → Stop (awaited by omp — helper stays well under 1s, shim
    never blocks on it).
  - `session_shutdown` → SessionEnd. Verified 2026-08-15: this is
    **process-exit only**; session switches fire `session_before_switch` /
    `session_switch` instead.
- **Ghost filter (required, same as pi):** one omp process hosts many
  sessions over its lifetime, including headless ones; the shim emits only
  for sessions with a UI and a session file, and refreshes its current
  session identity on **every** `session_start` and `session_switch` — the
  subagent bus handler has no ctx, so a stale captured id would mis-parent
  rows (and `isValidProspectiveParent` would silently reject them).
- **Subagents:** `pi.events.on("task:subagent:lifecycle")` —
  `started` → SubagentStart, `completed`/`failed`/`aborted` → SubagentStop.
  The payload `id` is an **agent/registry identity, not a session-manager
  session id** — the shim treats it as a dedicated child identity and never
  mixes the two namespaces. The registry's role conflicts are
  first-writer-wins, so the ghost filter (no child `session_start` rows) is
  the only protection against a headless child becoming a permanent
  top-level tile; that race is exercised in tests with both orderings.
- **Titles (pull):** `titles.ts` gains an omp resolver reading the 256-byte
  `type: "title"` slot at the head of the session JSONL at the row's
  `transcript_path` (omp auto-titles after the first user message),
  mtime/size-cached like the Claude tail reader (a plain append-only file —
  caching is sound here). The slot's framing is under-documented: capture a
  real session file as a checked-in test fixture during implementation;
  fallback is the first parseable JSONL line after the slot, `title` field.
- **Gap:** no StopFailure — omp tiles never show `error` in v1 (interrupt
  settles as Stop; confirm live).

### deepseek harness (P3, shipped Cordis plugin)

- **Template:** `extensions/deepseek/stream-deck-agents.ts`, following dsh's
  plugin convention (named `apply(ctx)` export per the official plugin
  tutorial — not the pi/omp default-export factory), with all listeners
  registered inside `apply` and released via returned disposers. Installer
  copies it to `~/.dsh/stream-deck-agents.ts`; the user manually adds one
  `insert` row (absolute path) to each active profile's `cordis.patch.yml`
  (documented).
- **Waterfall/serial pass-through (required):** Cordis waterfall listeners
  must call `next()`; returning without it short-circuits the chain. Every
  waterfall/serial listener the plugin registers (`agent/pre-step`,
  `tools/*`, and the approval fallback below) wraps telemetry so its errors
  never escape and calls/returns `next()` exactly once. A fake-chain test
  proves downstream handlers still run when the shim throws.
- **Event mapping** (dsh native → canonical; the exact accessors for
  session id/cwd/tool identity from the agent-scoped payloads are pinned at
  implementation against `runtime-types.ts` — a P3 probe, since payloads
  are `{agent, …}`-shaped rather than flat):
  - `agent/session-start` → SessionStart
  - `agent/pre-step`, gated on `step === 0` (it fires **per step**, not per
    prompt) → UserPromptSubmit
  - `agent/status` → `running` → Activity (mid-turn liveness)
  - `tools/pre-execute` / `tools/post-execute` → PreToolUse / PostToolUse;
    shim normalizes `ask_user_question` → `"AskUserQuestion"`
  - `agent/turn-stopping` → Stop
  - `agent/error` → StopFailure, with the same **terminal-outcome latch** as
    pi: `agent/status → idle` (the interrupt backstop) is suppressed when an
    error was seen that turn — `applyStop` would otherwise clobber the error
  - `agent/status → idle` → Stop (unlatched case; covers interrupts, which
    have no event)
  - `session/disposed` → SessionEnd
  - `subagent/start` / `subagent/end` → SubagentStart / SubagentStop with
    real parent linkage (native events are scoped to the parent agent);
    skip `local === false` and empty ids (ACP/remote children have no local
    session).
- **Approvals and titles (go/no-go P3 probe):** `approval/asked` and
  `session/title` are **session-log records, not dispatchable Cordis events**
  (verified live by review). The plugin subscribes to the `session/event`
  stream and filters for those record types. If that subscription proves not
  to deliver live: `waiting` falls back to an observe-only `approval/request`
  waterfall listener (always `next()`, never a decision), and titles fall
  back to project name (still no zstd reader in the daemon).
- **Robustness:** helper spawned fire-and-forget via `child_process`; shim
  wire contract per §Decoder (no raw spreads, omit-don't-null).
- **Docs pin the dsh version verified against** and warn that dsh is pre-1.0
  with promised breaking changes; the plugin contract is re-validated per
  dsh upgrade.

## Install (`scripts/install-local.ts`)

The installer's contract changes deliberately: it now installs its own shim
files into provider extension dirs; it still never edits provider **config
files**. Header and failure text are updated to say so.

- **Helper-path injection:** shim templates carry a
  `__STREAM_DECK_AGENTS_EXECUTABLE__` token, replaced with
  `paths.executable` at copy time (same pattern as the plist tokens). The
  helper is not on PATH and its path contains a space; every shim swallows
  spawn errors, so a hardcoded-or-PATH lookup would be a silent total
  failure.
- **Ownership markers:** each installed shim's first line carries a managed
  marker comment with a version. The installer refuses to overwrite a
  same-named file without the marker (user content), writes atomically
  (temp file + rename), mode 0600, and re-copies on upgrade when the marker
  matches.
- **Gating:** a shim is copied only when the provider's dir exists
  (`~/.pi`, `~/.omp`, `~/.dsh`) — otherwise skipped with a printed note.
- **Ordering:** build → install executable → **stop daemon (bootout)** →
  init/migrate → bootstrap daemon → plugin install → **shims last**, so
  auto-discovered shims never activate before the compatible daemon and
  plugin are live.
- **Deploy note (AGENTS.md):** an older installed plugin bundle hard-fails
  `parseSessionSnapshot` on unknown provider keys and pins degraded;
  `install-local.ts` updates both halves together, and the plugin-only
  partial-deploy flow documented in AGENTS.md gets a lockstep warning.

## Build gate

`extensions/**/*.ts` is added to `tsconfig` include and Biome's lint set.
Biome's `noDefaultExport` gets a narrow override for the pi/omp shim
entrypoints only (their host contract is a default-exported factory); the
dsh plugin follows its loader's named-export convention and needs no
override. Without this, `bun run check` either ignores the shims or fails on
them.

## Docs

- `docs/hook-configuration.md`: four new provider sections (ZCode full
  nested config + traps; pi/omp noting the shim is installer-placed and what
  it does; DeepSeek plugin row + version pin), the updated privacy note
  (`is_interrupt` as the third in-place classified signal; `error` never
  read), and the backup/diff/restore ritual per provider. The "After all
  three providers" heading and the helper USAGE line get plural-corrected.
- `docs/design.md`: four new chips/colors.
- `AGENTS.md`: provider list, title sources, per-provider status gaps
  (zcode: no SessionEnd → 1h lease, no StopFailure; pi: never waiting; omp:
  no error), the PostToolUseFailure and SessionTitleChanged contracts, the
  shim wire contract, schema v5, and the deploy-ordering warning.

## Testing

- **Shim harness tests (the real pin):** each shim is dependency-free with a
  factory taking a structural host object, so `bun test` executes it
  directly — fake host API capturing `on()`/`events.on()` registrations,
  fire fake events, inject a fake spawn port, assert the exact JSON written
  to stdin. Covers: mapping correctness, ghost filtering (pi + omp),
  terminal-outcome latch both orderings (pi + dsh), `next()` pass-through
  under shim failure (dsh), `local === false` filtering (dsh), parent-ctx
  refresh across `session_switch` (omp), omit-don't-null field rules.
  Handwritten "fixture parity" alone would drift from the shim source the
  first time either side is edited.
- **Decoder fixtures:** zcode `PostToolUseFailure` with `is_interrupt` true
  and false (and rejection for other providers), zcode `transcript_path`
  suppressed to null without dropping the event, SubagentStart without
  `transcript_path` survives, `SessionTitleChanged` decode.
- **Registry:** `SessionTitleChanged` apply/ignore rules (existing row,
  changed title only, `updated_at` preserved, unknown identity ignored).
- **Migration:** v4 → v5 with a parent/child/grandchild tree; all rows,
  columns, index, and constraints survive; `foreign_key_check` clean;
  failed migration rolls back; live second connection busy behavior.
- **Projection:** new-provider rows project cleanly (grid-blackout
  regression).
- **Controller:** key press on a new-provider tile shows the activation
  alert.
- **CLI:** accepts the four new provider args; USAGE lists them.
- **Titles:** omp slot reader against a checked-in real session-file
  fixture; zcode resolver against a fixture SQLite db including a WAL-only
  committed title.
- Gate: `bun run check` (biome ci + build + bun test); lefthook pre-push
  enforces it.

## Physical verification (all four tools installed)

Per provider: start → tile appears; prompt → working; turn end → idle; quit
→ row removed (zcode excepted — 1h lease). Provider-specific probes:

- zcode: hook delivery confirmed live on the installed build (`args` form,
  `command` fallback); permission prompt → waiting; interrupt mid-tool →
  idle via PostToolUseFailure; ghost probe (side chats / headless /
  automation); title-latency probe (`session.title` freshness).
- pi: print-mode and subagent subprocesses produce no ghost tiles; a failing
  turn → error tile **and it stays** (latch); `/name` mid-session → tile
  retitles; `/new` → old row gone, new row present; Escape-abort → idle
  (agent_settled probe — phase gate).
- omp: approval prompt and `ask` question → waiting; approval UX unchanged
  with the shim installed; subagent run → descendant badge; child-session
  double-registration race probe; auto-title appears on tile; session switch
  mid-process keeps parentage correct.
- dsh: `session/event` subscription delivers `approval/asked` and
  `session/title` live (go/no-go); approval → waiting; interrupt → idle via
  the latched backstop; subagent run → badge with correct parent linkage;
  remote subagent produces no row.

Results recorded in a dated file under `docs/verification/` per convention.

## Out of scope (v1)

- zcode and pi subagent child rows (proxies unproven; revisit after probes).
- `background_outstanding` arming for new providers (dsh/zcode have
  background-bash analogs; completion signals are unverified).
- dsh zstd transcript reading (titles arrive via push instead).
- Tile-activation bindings for new providers (press shows the alert, same as
  an unbound Claude tile; Ghostty binding remains Claude-only).
- Raising the 64 KiB stdin cap (zcode's fat payloads accepted as a
  documented lost-transition risk in v1).

## Risks

- **Churn:** omp ships multiple times per day, pi multiple times per week,
  zcode weekly, dsh is pre-1.0. Shim event names/payloads are re-verified
  per provider upgrade; docs pin tested versions.
- **zcode config validation:** strict in June–July builds (`args` bug),
  tolerant per current docs — either way the P1 probe verifies hook delivery
  live, and hooks are snapshotted at session start.
- **omp subagent race:** a child `session_start` winning first-writer-wins
  would pin a permanent top-level tile; the ghost filter is the defense and
  the race is tested both ways.
- **dsh unknowns:** `session/event` live delivery (go/no-go probe with
  stated fallbacks), interrupt sequencing (latched backstop), payload
  accessors (pinned at implementation), pre-1.0 breakage (version pin).
- **pi interrupt:** the idle transition rests on `agent_settled` firing
  after Escape — P2 phase gate.

## Review log (2026-08-15)

Three staff-level adversarial reviews, identical brief, three
harnesses/models: Fable 5 (Claude, plan mode), GPT-5.6-Sol (Codex), K3
(Kimi, plan mode). Verdicts: REVISE-THEN-SHIP ×3. 54 findings total before
dedupe.

Accepted and folded in (verified against the code first): push-title path
replaced by `SessionTitleChanged` (all three); v5 migration mechanics
rewritten (all three); Stop-clobbers-error fixed shim-side via the
terminal-outcome latch (all three); `projection.ts`, `cli.ts`,
`controller.ts` provider gates added to P0 (all three); zcode config
nesting corrected (Sol, K3); zcode WAL cache removed (Sol, Fable); helper
path token injection (Fable, K3); installer contract/markers/ordering
(Sol, Fable, K3); omp ghost filter + session-switch parentage + child-id
namespacing (Sol, Fable, K3); dsh waterfall `next()` pass-through (Sol);
dsh `session/event` subscription + go/no-go probe (Fable, K3); `is_interrupt`
allowlist + privacy note (all three); pi SessionEnd-on-all-reasons (Fable,
K3); `pi.getSessionName()` receiver (K3); dsh `step === 0` gating (K3);
dsh `local === false` filter (K3); `extensions/` build-gate coverage
(Sol); shim harness tests (Sol, K3); zcode 1h lease (Sol, Fable);
deploy-ordering note (Fable).

Declined or adapted: raise the 64 KiB cap (declined — fail-open budget is
the contract; documented instead); zcode strict-schema warning kept but
downgraded to build-history caution (current docs contradict it); omp cream
and deepseek blue chips kept as proposed (shape + letters carry the
distinction; eyeballed in render verification); `tool_execution_start` for
omp changed to "prefer if present" rather than required (fork parity
unverified until implementation).

Revision 3 — post-implementation reconciliation of the v5 rebuild algorithm
wording in §Registry schema v5 (final review finding): the shipped migration
renames the v4 table aside and creates the final table directly, rather than
creating `active_sessions_v5` and renaming it into place.
