# Multi-account quota implementation verification

Final SDD review: all seven task reviews and the whole-branch review are
complete. The whole-branch review of `d4e1943..25191a5` found two anonymous
Codex fallback defects; `823bd9a` preserves cached source timestamps and rejects
ambiguous anonymous batches. Scoped review of `25191a5..823bd9a` confirmed both
findings addressed with no new breakage. No review finding remains open or
parked. Final backend verification passed 1,440 tests; the unchanged UI retains
the browser, frontend, Rust, and bundle evidence recorded below. Native,
installed-refresh, and physical acceptance remain pending.

Local verification: 2026-09-09, branch `feat/multi-account-quota`. Feature base
`44eb544`; Tasks 1–6 end at `529f62d`. Task 7's production source is `20b216e`,
with the final browser driver correction at `25191a5`. The final backend fix is
the commit containing this revised record (inspect with
`git log -1 --format=%H -- docs/superpowers/plans/2026-09-08-multi-account-quota-verification.md` and `git show`).
The complete review diff is `git diff 44eb544..HEAD`.

## Evidence boundary

`bun scripts/quota-preview.ts` builds a temporary browser entry with Bun and
serves only synthetic data on loopback. The unchanged production `main.ts`
instantiates the actual details controller, reduces raw v3 quota reads, renders
cards/board/rail/token data, and wires board gestures. Only bridge IO, native
window management, and autostart are replaced. Preview-only density and clock
controls select the renderer's density and model time; the app default remains
comfortable. Session actions are recorded at the synthetic bridge for assertions.
SIGINT/SIGTERM remove generated assets. No provider process, production snapshot,
installation, authentication, account switch, or LaunchAgent is involved.

## Browser acceptance

The repeatable driver is `test/fixtures/quota/browser-check.mjs`. Run the preview,
then supply its printed URL, an existing Playwright module path, browser engine,
and an evidence directory:

```sh
node test/fixtures/quota/browser-check.mjs "$PREVIEW_URL" "$PLAYWRIGHT_MODULE" chromium "$EVIDENCE_DIR"
node test/fixtures/quota/browser-check.mjs "$PREVIEW_URL" "$WEBKIT_MODULE" webkit "$EVIDENCE_DIR"
```

No browser dependency was added or downloaded. macOS cached Playwright supplies
Chromium 148.0.7778.96 and WebKit 26.5. Each passed 28 layouts and two interaction
suites with no page errors: **56 layout cases and four interaction suites**.
These are browser engines, not the installed Tauri WKWebView shell.

The matrix covers 2560 × 720 with a 638 × 720 rail, comfortable 2 Claude + 2 Codex
+ Kimi/GLM/Qwen and compact 4 + 4 + the same singles. Each engine checks both
normal and fullscreen padding and all seven normalized scenarios, with token
chart and six unread sessions. Assertions cover containment, non-overlap,
unclipped readouts, all 7/11 rows, no rail scrolling, unchanged 40/31px rows,
and the 0.875 note-to-percentage type ratio. Screenshots are also inspected for
readability, especially `100%`, hours/minutes, days, capped scoped tags, source
age and `Sign in again`; geometry alone is insufficient.

Both engines and densities passed keyboard opening, focus trapping,
Escape/Close/outside-touch dismissal, focus restoration after rail replacement,
correct touch/mouse account targeting, and a real mouse stroke spanning a source
update plus a visible `2m` → `1m` countdown rollover. The rail stayed mounted
with `2m` during the stroke; after release the rail and details both showed
`1m`, and details showed the same account's newest 37% measurement. Sibling release
was rejected. Ten-window details stayed scrollable and preserved their actual
scroll offset and Close focus across updates. Removing the account dismissed
details to the rail; later ticks did not reopen them. Modal wheel gestures did
not page the board, and quota interactions emitted no synthetic session action.
After dismissal, real board taps, session context sheets, and horizontal swipes
still invoked the production wiring. Normal-padding and fullscreen screenshots
were inspected separately; all accepted rows/readouts remain visible.

Tracked screenshots from the real renderer using synthetic data:

- [Comfortable](../../assets/dealerboard-strip.png)
- [Compact](../../assets/dealerboard-strip-compact.png)

Browser verification found and corrected real layout defects: the original
52px base percentage column overflowed for `100%` (80px text in a 62.4px
comfortable box); it is now 70px base/84px comfortable. Readouts use their full
content width and borrow from the flexible meter instead of overlapping it.
Normal-padding content originally expanded to 725.219px comfortable and
747.25px compact in Chromium. Removing redundant single-meter vertical gaps
and reducing the internal group heading gap recovers capacity without changing
named density values, token/unread geometry, or rail padding.

## Required gates

All six gates originally ran after the production implementation edits at
`20b216e`. Both browser drivers then reran against the corrected countdown-race
driver at `25191a5`. After final review, the backend-only fix reran `bun run check`
(including root/app typecheck and the daemon/plugin build) and whitespace checks.
Frontend, Rust, native bundle, preview, browser driver, and screenshots are
unchanged from `25191a5`; their earlier evidence remains pinned to those sources.

| Command | Result |
| --- | --- |
| `bun run typecheck` | Exit 0; root and app TypeScript |
| `bun run check` | Exit 0 after final backend fix; Biome 145 files, daemon/plugin build, 1440 tests / 6472 expectations |
| `bun run build:app` | Exit 0; 37 modules, 87.45 KB frontend |
| `cargo test --manifest-path app/src-tauri/Cargo.toml` | Exit 0; 11 Rust tests |
| `bun run bundle:app` | Exit 0; release executable and `Dealerboard.app` bundle built locally |
| `git diff --check` | Exit 0; no whitespace errors |

`bun run check` emitted Rollup's `"this" has been rewritten to "undefined"`
warning for generated decorator helpers in `session-grid-action.js` and three
other occurrences. Build and tests passed; no quota source or test emitted an
unexpected error. Rust tests emitted no warnings.

Baseline-noise evidence for that warning: `git diff --exit-code 44eb544..20b216e
-- src/plugin rollup.config.mjs package.json bun.lock tsconfig.json` is empty.
`git ls-tree` confirms identical baseline/current blobs for the reported source,
Rollup configuration, manifest, lockfile and TypeScript configuration. The
existing generated JS contains `(this && this.__esDecorate)` at the warning
location. This establishes unchanged warning-producing inputs; a separate
baseline build was not rerun and no plugin cleanup was included.

The carried test minors are resolved: failed Codex inventory cases have short
descriptive names; the rail signature regression reduces the same raw source
read just before/after Codex's healthy-to-stale threshold. Focused command
`bun test test/quota.test.ts test/strip-rail.test.ts`: 96 passed, 0 failed,
330 expectations.

## Final review fixes

Both Important findings from the whole-branch review at `25191a5` are resolved:

- Anonymous Codex success now carries the adapter's canonical source `fetchedAt`
  through the collector outcome into the published measurement and session
  history. A collector-to-reducer regression repeats the same cache at source
  age 2, 4, 6, and 8 minutes, preserves source time throughout, and proves the
  real reducer changes from healthy to stale. Kimi, GLM, and Qwen still use their
  existing collection timestamps; named accounts and Claude retain their prior
  behavior.
- Ambient eligibility now counts all relevant Codex records, including source
  errors, and requires exactly one eligible anonymous record. Parser regressions
  reject success-plus-anonymous-error in both orders on exit 0 and exit 1 while
  ignoring unrelated providers. Collector/reducer regressions prove cold
  unavailable state, unchanged last-good ambient/named measurements, one fixed
  failure diagnostic across repeated failed reads, and no raw error leakage.

Focused regression command:
`bun test test/quota-codexbar-accounts.test.ts test/quota.test.ts --test-name-pattern 'cached anonymous|anonymous success plus'`:
6 passed, 0 failed, 43 expectations. Before implementation, 5 failed for the
reported defects and the existing named-account retention case passed.

Covering command:
`bun test test/quota-codexbar-accounts.test.ts test/quota-codexbar.test.ts test/quota-accounts.test.ts test/quota-claude-swap.test.ts test/quota.test.ts test/strip-quota.test.ts`:
164 passed, 0 failed, 467 expectations. The subsequent full check also covers the
final test type-narrowing correction. No production provider calls, installation,
authentication, new dependencies, UI changes, or native changes were involved.

## Separately pending acceptance

- Native development-shell launch: **pending**. `bun run dev:app` invokes
  `ensureAutostart`, which can modify the production LaunchAgent. Production
  bootstrap is verified only with the synthetic browser host boundary.
- Coordinated app/daemon installation and executable/PID validation: **pending**.
  Neither local builds nor browser checks prove installed behavior. Installers
  must be inspected immediately before an authorized installation.
- Independent scheduled account refresh with selection unchanged: **pending**.
  Both Codex source timestamps must independently advance across normal passes.
  Claude source caching and the 45-minute backstop need installed observation;
  a saved Claude sign-in requiring renewal leaves independent Claude refresh
  **incomplete** even when auth rendering passes. Do not force refresh or switch.
- Physical-strip comfortable typography and tap targets: **pending**. Native
  resolution screenshots do not prove physical readability or touch behavior.
- Source identity remains limited to Claude slots and Codex source-label-derived
  opaque IDs. Codex activity is unknown. Source errors stay normalized and no
  account identity, credential, or raw error text is exposed. v1/v2 quota reads
  and startup seeds are ignored until v3 recollection; install app/daemon together.

## Controller rulings preserved from the execution ledger

Ruling: Task 3 must distinguish subprocess timeout from normal nonzero exit before parsing stdout, using an explicit timeout outcome in the injected exec result — the existing spawnExec kills on its timer but can return accumulated JSON with a nonzero code, while the spec requires timeout to be a failed read — cost if wrong: a small internal result-field/test change; no wire-schema or cadence change.

Ruling: Verify production main.ts bootstrap in a browser with only the native host boundary replaced by synthetic data, and leave native launch acceptance pending — dev:app calls ensureAutostart, which can change the production LaunchAgent, outside authorized local implementation — cost if wrong: native-only startup behavior still needs a later authorized launch; browser proof is explicitly narrower.

Ruling: Remove redundant single-meter vertical gap/bar margin and reduce heading-to-account-stack gap from 3px to 1px at base scale — browser measurements show compact normal-padding content totals 747.25px against the required 720px; these unspecified internal gaps can recover 28px while preserving every specified density value and token/unread/padding geometry — cost if wrong: tighter meter spacing may need visual revision; no data behavior or named preset values change.
