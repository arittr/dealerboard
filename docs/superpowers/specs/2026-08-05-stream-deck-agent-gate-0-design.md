# Stream Deck Agents: Gate 0 Evidence Probe Design

Date: 2026-08-05

Status: Proposed evidence design. Pending Drew's review.

Product direction: [docs/design.md](../../design.md)

## Purpose

Gate 0 answers whether the current versions of Codex App and CLI, Claude Code CLI and background agents, Kimi Code CLI and Web, macOS, and the Stream Deck SDK expose enough stable information to build the product in `docs/design.md`.

This phase produces evidence, not the product. An unsupported result is a successful Gate 0 outcome if the limitation is demonstrated clearly. Gate 0 does not silently weaken the product or choose which providers to cut.

## Questions Gate 0 must answer

For each provider surface:

1. Can an observer recover the complete set of currently live sessions, including quiet sessions that predate the observer, without including cold history?
2. Can every live runtime attachment be joined to a stable logical session identifier and a deterministic incarnation?
3. Can current activity, attention, and failure facts be recovered without interpreting unknown as idle?
4. Can complete live parent/descendant lineage be recovered after observer restart?
5. Is there an authoritative removal signal or complete inventory omission?
6. Can an exact existing App task, terminal, or browser tab be activated without fuzzy matching?

For the shared runtime:

7. Does the Stream Deck SDK provide the expected 5x3 action-context lifecycle across profile changes, reconnects, and restart?
8. Which local transport works from the actual Stream Deck plugin runtime?
9. Can an owned-runtime LaunchAgent and fail-open hooks run reliably without an interactive shell or repository checkout?

## Scope boundary

Gate 0 may create disposable probes that observe a documented interface, record a native event stream, exercise a hook executor, or render a diagnostic Stream Deck image. It must not build:

- The product daemon, registry, allocator, reducer, or persistence format.
- Production provider adapters or a generalized adapter SDK.
- The production Stream Deck plugin or profile.
- An installer, updater, dashboard, database, or event log.
- Heuristic session discovery or focus based on titles, working directories, window order, recency, accessibility scraping, or screen scraping.
- A dependency on AgentDeck, Herdr, or another session registry.

Persisted provider stores may be inspected to falsify a hypothesis or understand an identifier. They do not count as a live-membership authority unless the provider documents that contract and the live probes confirm it.

## Safety and evidence rules

### Probe classes

- **Class A: read-only.** Version checks, help and schema inspection, supported inventory calls, process inspection, and observation of existing test sessions may run without changing provider configuration.
- **Class B: disposable runtime activity.** Starting named test sessions, background agents, local Web servers, or a temporary observer is allowed only within a clearly identified test workspace. The plan must state cleanup and must not use real task content.
- **Class C: configuration or UI mutation.** Installing a temporary hook, LaunchAgent, Stream Deck plugin/profile, or triggering logout, sleep, TCC, Apple Events, or profile changes requires Drew's explicit approval immediately before execution. Back up the exact target, make the smallest reversible change, and verify rollback.

No probe may archive, close, or modify a real session. No probe records prompts, transcripts, tool arguments, environment secrets, or provider tokens. Evidence should contain only the minimum native identifiers, event kinds, timestamps, process relationships, and capability results needed to support a conclusion.

### Evidence quality

Each claim must distinguish:

- A documented contract.
- A live observation on the recorded current version.
- An inference that still needs proof.

A capability is not proven by source inspection alone, one happy-path event, or a session that was created after the observer. Every positive capability result needs a quiet-start/restart case and a relevant negative or ambiguous case.

The probe clock may be used to order observations within one experiment. It is not treated as a provider clock or a product ordering primitive.

## Deliverables

Gate 0 produces one concise report at `docs/evidence/gate-0/report.md`. Supporting redacted command output, schemas, and event traces may live beside it when the report alone would not let another engineer reproduce the conclusion.

The report contains:

- Host, OS, Stream Deck, provider, CLI, App, and relevant SDK versions.
- One capability matrix with `PASS`, `PARTIAL`, `FAIL`, `UNSUPPORTED`, or `NOT RUN` for every listed surface and capability.
- A short evidence packet for every experiment: hypothesis, setup, exact steps, observed result, artifact links, conclusion, and limitation.
- Timing observations for polling, removal, hooks, reconnect, and sleep/wake where relevant.
- A list of supported interfaces used and any provider permission or security assumptions.
- The remaining product decisions for Drew; the report does not make those decisions automatically.

No machine-readable evidence schema is required in Gate 0. Add one later only if repeated automated conformance tests create a real consumer for it.

## Capability acceptance criteria

| Capability | `PASS` requires |
|---|---|
| Live membership | A complete supported inventory includes multiple quiet pre-existing live sessions, excludes cold history, and recovers after observer restart. |
| Logical identity | Native evidence joins every observed attachment to one stable provider session ID without title, path, or recency matching. Resuming the same logical session retains that identity. |
| Incarnation | The value survives observer restart while one attachment remains live and changes after that attachment authoritatively closes and a new attachment opens, even when the logical session is resumed. |
| Current state | Native facts distinguish working, waiting, idle, and error where those states exist. Unknown dimensions remain explicit, and current state recovers after observer restart. |
| Lineage | All live descendants, their parent links, and their termination are recoverable for descendants created both before and after the observer starts. Nested lineage is tested when the provider supports nesting. |
| Removal | Close, exit, detach, unload, or archive produces an authoritative end or a complete-snapshot omission within a measured bound, without deleting another incarnation. |
| Exact activation | Native identity selects the exact existing target under an ambiguity test with duplicate titles and working directories. Opening a replacement target does not pass. |
| Sleep/reconnect | Membership and state do not become falsely authoritative during sleep or source loss, and recover predictably after wake/reconnect. |

`PARTIAL` identifies exactly which clause is missing. `FAIL` means the observed behavior contradicts the required contract. `UNSUPPORTED` means no stable supported interface exists on the tested version. `NOT RUN` is allowed only when the report names the approval, hardware, or upstream prerequisite that prevented the experiment.

Strict provider support requires `PASS` for live membership, logical identity, incarnation, current state, lineage, and removal. Exact activation is reported independently because a truthful status-only first version may still be useful if Drew approves it after seeing the evidence.

## Shared scenario set

Each provider probe should reuse the smallest applicable subset of these scenarios so results are comparable:

1. **Quiet recovery:** Start two distinguishable test sessions before the observer. Leave both quiet, then start or restart the observer.
2. **Live arrival:** Start a third session while observation is active.
3. **State transitions:** Exercise working, waiting, idle, and one safe induced failure where the provider exposes those concepts. Record native transitions and recovery.
4. **Lineage:** Create a top-level test session with one or more descendants before observation and another after observation.
5. **Observer restart:** Restart only the probe while sessions remain live and quiet.
6. **Close and reopen:** Close one runtime attachment, confirm removal, then resume the same logical session in a new attachment.
7. **Ambiguity:** Run two live sessions with the same repository, working directory, and visible title.
8. **Source loss:** Stop the provider inventory source or local server without closing its sessions cleanly, then restore it.
9. **Sleep and wake:** With Drew's approval, sleep and wake the Mac while the observer and selected test sessions are active.

Native IDs and deliberately assigned test labels establish ground truth. A test label is not accepted as the discovery or activation mechanism.

## Provider probes

### Claude Code CLI and background agents

Use `claude agents --json` as the first inventory candidate and record its documented and observed schema.

Run the shared quiet-recovery, live-arrival, state, lineage, observer-restart, close/reopen, and ambiguity scenarios for:

- Two interactive Claude Code sessions.
- A background agent that outlives its initiating foreground turn, if the installed version supports that lifecycle.
- A descendant that exists before the probe starts.

Determine whether the inventory is complete for quiet interactive and background work, which native fields join an OS process and terminal to a Claude session, whether state and lineage are present or recoverable through another supported interface, and what event or omission authoritatively ends membership.

For activation, attempt to join the native Claude session or process identity to an exact Ghostty terminal target. Duplicate working directories and titles are mandatory. If Ghostty or Claude exposes no exact join key, record activation as `UNSUPPORTED`; do not add a fuzzy fallback.

### Codex App

First demonstrate the distinction between stored threads and currently loaded/live App tasks. The existing count of 288 unarchived top-level threads is a falsification case for using `archived = false` as liveness, not a membership input.

Using only supported external surfaces, determine whether a separate process can:

- Attach to or query the running App's current task inventory.
- Distinguish a loaded quiet task from a persisted but unloaded task.
- Recover activity, attention, failure, title, and lineage after observer restart.
- Observe unload, close, or archive as membership removal.

Run quiet-recovery with at least two loaded tasks plus one unarchived but unloaded control task. If the embedded app-server cannot be attached to or queried through a supported external contract, record the missing capabilities as `UNSUPPORTED`; do not substitute database recency or private IPC.

Test any documented `codex://threads/<id>` or equivalent route separately. It passes activation only if it focuses the exact existing task rather than opening or selecting a replacement by approximation.

### Codex CLI

Start two quiet Codex CLI sessions before the probe and one after it. Determine whether a supported combination of process metadata and native Codex output joins each live process to its rollout/session identity without reading transcript content.

Run state, lineage, observer-restart, close/reopen, and ambiguity scenarios. In particular, distinguish:

- One logical session resumed in a new CLI attachment.
- Two concurrent CLI attachments in the same repository.
- A process that exits cleanly versus a terminal or parent process that disappears.

Attempt exact Ghostty activation using only a proven PID, TTY, or native terminal identifier chain. Report the first missing join rather than filling it with title, path, or frontmost-window behavior.

### Kimi Code CLI

Run the same quiet-recovery, live-arrival, state, lineage, restart, close/reopen, and ambiguity scenarios as Codex CLI.

Inspect documented CLI inventory and hook surfaces first. A temporary hook, if required, is Class C and must emit only a timestamp, native session identifier, native event kind, and safe process metadata. Determine whether quiet sessions that existed before hook installation can be recovered and whether the hook plus inventory can be joined without transcript data.

Test daemon/probe absence, closed standard input, and slow/unreachable receiver behavior using the real Kimi hook executor shape. The hook must fail open within a measured bound. Hook success alone does not prove complete membership.

Attempt exact Ghostty activation under the same ambiguity rules as the other CLIs.

### Kimi Code Web

Start the supported local Kimi Web server in an isolated test workspace. Create controls for:

- A persisted cold session with no attached browser client.
- Two currently attached tabs.
- Two server processes sharing the same user-level session store, if the product permits that topology.

Determine whether supported APIs distinguish browser attachment from persisted session inventory, recover native state and lineage after probe restart, and report tab close, server exit, archive, and reconnect authoritatively. A running Web server plus a stored session list is not sufficient proof of a live browser attachment.

For activation, prove an identity chain to the exact existing browser tab with duplicate visible titles. Opening the session URL in a new tab is not activation success.

## Ordering and reconciliation trace

Gate 0 does not implement the candidate reducer. It records native inventory and event timelines to determine whether that reducer can be implemented truthfully.

For every surface that exposes both snapshots and events, capture these races:

1. A new attachment starts while an inventory call is in flight.
2. A session changes from working to waiting while inventory is in flight.
3. An attachment closes and a delayed earlier event arrives afterward.
4. A logical session is resumed after close while native IDs are reused or related.
5. The observer restarts with all sources quiet.

The report must identify which interface owns membership, which owns facts, whether native ordering metadata exists, and whether exact-incarnation end plus a local begin/commit fence is sufficient. If the evidence cannot distinguish incarnations or stale results, the corresponding surface fails strict support rather than receiving a more elaborate speculative protocol.

## Stream Deck and local transport probe

This is a Class C probe and must use a temporary, clearly named profile/action that does not overwrite Drew's normal profile.

A minimal diagnostic plugin records only SDK lifecycle events and can render a coordinate, a solid color, an offline image, and a native alert. With the physical 15-key device, verify:

- Exactly 15 live action contexts with correct row-major coordinates.
- `(deviceId, row, column)` rebinding across `willAppear`, `willDisappear`, profile switch away/back, plugin restart, Stream Deck app restart, unplug/replug, and approved sleep/wake.
- Behavior with zero devices and, if safely simulatable or physically available, more than one compatible device.
- `setImage`, key press delivery, `showAlert`, and stale-context rejection.
- Physical legibility of the proposed frame colors, two title lines, provider mark, and bare descendant badge.

Use the actual plugin runtime to test one minimal authenticated request over a mode-restricted Unix socket and one over loopback with a per-install bearer token. Record filesystem, sandbox, CORS, permission, reconnect, and latency behavior. Gate 0 recommends one transport based on this evidence; it does not define the production protocol.

Remove the temporary action and restore the previous profile after the probe. Preserve any user-modified material and report anything that could not be removed safely.

## LaunchAgent and hook execution probe

This Class C probe uses a disposable echo/health process, not the product daemon.

Install it from an owned absolute path with an owned runtime and a minimal LaunchAgent plist. Verify:

- Manual load/unload and launch at login without an interactive shell, shell profile, nvm, repository checkout, or ambient `PATH`.
- Crash restart, bounded logging, clean unload, reinstall, and compare-before-change cleanup.
- Access to the selected local transport and mode-restricted token or socket.
- Stream Deck app and hook-client behavior while the process is absent, starting, healthy, and restarting.
- Approved logout/login, sleep/wake, Background Items visibility, and any signing or TCC behavior required by the final capability set.

For each provider hook executor used by a probe, run the actual executor shape with closed standard input, a missing receiver, a slow receiver, and malformed native metadata. Measure the bound and confirm the provider remains usable. The probe must not install Apple Events automation or request TCC access unless an exact-activation candidate has already passed its identity join.

## Bounded investigation rules

- Test only the interfaces and scenarios named in this document.
- Prefer official documentation and provider-supported commands or APIs. Local source and artifacts may explain behavior but do not create a support contract.
- For one capability, investigate at most one documented primary interface and one clearly supported fallback interface. If neither supplies the required fact, record the limitation.
- Do not reverse engineer encrypted traffic, bypass code signing, inject into another process, scrape UI state, or build a long-running compatibility layer.
- Stop a provider probe once the first indispensable strict capability is conclusively `UNSUPPORTED`, except for cheap independent probes that inform a useful reduced tier or another surface.
- Time-box inconclusive exploration in the execution plan. Expiry yields `PARTIAL` or `NOT RUN`, not a heuristic implementation.

## Gate 0 completion and next decision

Gate 0 is complete when:

- Every listed experiment is represented in the report as run, deliberately skipped under a stop rule, or blocked by a named approval/prerequisite.
- Every target surface has an evidence-backed capability row.
- Temporary hooks, profiles, plugins, LaunchAgents, test sessions, and servers are removed or explicitly handed back to Drew.
- `docs/design.md` is revised to replace hypotheses with the observed capability boundary.
- Drew reviews the report and chooses strict universal support, explicit capability tiers, or a narrower first version.

Only after that decision should we write the full product implementation design and plan. The immediate next step after Drew approves this document is a detailed execution plan for these probes only.
