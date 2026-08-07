# Codex session deep-link identity probe

Date: 2026-08-07
Probe timestamp: 2026-08-07T19:34:53Z
App: Codex Desktop
App version observed in UI: Drew confirmed the current Codex Desktop app during the live probe; the numeric version was not exposed through the approved automation channel.
Official deep-link documentation: https://learn.chatgpt.com/docs/reference/commands.md#deep-links
URL shape tested: `codex://threads/<full-hook-session-id>` delivered through `/usr/bin/open -u`.

The installed registry was queried with the exact binary at:

`/Users/drewritter/Library/Application Support/com.drewritter.stream-deck-agents/bin/stream-deck-agents sessions list`

The represented Codex source in the installed hook configuration is Codex Desktop. No CLI-origin top-level Codex row was present in the probe registry output, so no separate CLI probe was represented. A nested row existed under the first Desktop task and was excluded from top-level activation coverage.

| Source surface | Full hook ID | Visible title / project | Unique marker | `/usr/bin/open` result | Foreground | Exact existing task selected | Duplicate created |
|---|---|---|---|---|---|---|---|
| Codex Desktop | `019fddb4-d664-7a80-b0fe-3ceda0c828a6` | Rebase PR 1919 / `superpowers` | `ACTIVATION-PROBE-A` | exit 0 | PASS — Drew observed Codex foreground | PASS — Drew confirmed the intended existing task | PASS — Drew observed no duplicate |
| Codex Desktop | `019fdd57-fd56-7352-8830-d6e5747cb76a` | Add Codex session foregrounding / `stream-deck-agents` | `ACTIVATION-PROBE-B` | exit 0 | PASS — Drew observed Codex foreground | PASS — Drew confirmed the intended existing task | PASS — Drew observed no duplicate |

## Gate result

**PASS.** Drew confirmed that each represented top-level Codex hook ID opened the foreground Codex Desktop app and selected the exact existing task without creating a duplicate. The two `/usr/bin/open -u` invocations returned exit code 0. No implementation code existed during this probe.

No app-bundle file was read, extracted, rewritten, or otherwise changed. The ChatGPT/Codex app bundle and its `Info.plist` were outside the probe.
