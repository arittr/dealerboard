# Multi-account quota implementation verification

Local verification: 2026-09-09, branch `feat/multi-account-quota`. Feature base
`44eb544`; Tasks 1–6 end at `529f62d`. Task 7's source is the commit containing
this record (inspect with `git log -1 --format=%H -- docs/superpowers/plans/2026-09-08-multi-account-quota-verification.md` and `git show`).
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
update plus countdown rollover. The rail stayed mounted during the stroke;
details opened with the same account's newest 37% measurement. Sibling release
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

All six gates ran after the final implementation edits.

| Command | Result |
| --- | --- |
| `bun run typecheck` | Exit 0; root and app TypeScript |
| `bun run check` | Exit 0; Biome 145 files, daemon/plugin build, 1434 tests / 6429 expectations |
| `bun run build:app` | Exit 0; 37 modules, 87.45 KB frontend |
| `cargo test --manifest-path app/src-tauri/Cargo.toml` | Exit 0; 11 Rust tests |
| `bun run bundle:app` | Exit 0; release executable and `Dealerboard.app` bundle built locally |
| `git diff --check` | Exit 0; no whitespace errors |

`bun run check` emitted Rollup's `"this" has been rewritten to "undefined"`
warning for generated decorator helpers in `session-grid-action.js` and three
other occurrences. Build and tests passed; no quota source or test emitted an
unexpected error. Rust tests emitted no warnings.

The carried test minors are resolved: failed Codex inventory cases have short
descriptive names; the rail signature regression reduces the same raw source
read just before/after Codex's healthy-to-stale threshold. Focused command
`bun test test/quota.test.ts test/strip-rail.test.ts`: 96 passed, 0 failed,
330 expectations.

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
