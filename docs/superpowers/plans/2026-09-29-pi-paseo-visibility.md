# Pi Sessions in Paseo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pi sessions driven by Paseo register board cards by gating the pi shim on `ctx.hasUI` instead of `ctx.mode === "tui"`, exactly as the oh-my-pi shim already does.

**Architecture:** One predicate changes in `extensions/pi/dealerboard.ts`: the `liveSession` guard requires `ctx.hasUI === true` plus a session id and session file. `mode` leaves the structural `PiContext` and `hasUI` joins it. Every handler, payload, the terminal-outcome latch, the prompt source gate, and the FIFO spawn queue are untouched. Deployment is a shim reinstall plus a pi restart.

**Tech Stack:** TypeScript, Bun 1.3.14, bun:test, Biome 2.5.6. The shim is dependency-free by contract (loaded bare by pi's jiti loader); the host surface is a local structural type.

**Spec:** `docs/superpowers/specs/2026-09-29-pi-paseo-visibility-design.md`

## Global Constraints

- The shim stays dependency-free: no imports beyond `node:child_process`.
- Only the predicate, the `PiContext` type, and the module header change in the shim. Event registrations, payload shapes, `errorLatched`, `readSource(event) !== "interactive"`, the spawn queue, and every `try/catch` stay as they are.
- No change to `extensions/omp/dealerboard.ts`, `src/core/**`, `src/protocol.ts`, `app/**`, or the daemon.
- The gate accepts a context only when `hasUI === true` **and** `sessionId !== undefined` **and** `sessionFile !== undefined`.
- Code style: 2-space indent, double quotes, 120 columns; Biome `noDefaultExport` is off for `extensions/pi/dealerboard.ts` only.

## Review Focus

Input classes the spec implies; each is pinned to a test in its owning task, except the last, which is manual.

1. **An RPC context with `hasUI: true` and a session file** — the reported defect. A person expects a Paseo pi session to appear. → Task 1 (new regression test).
2. **A context with `hasUI: true` but no session file** — a UI-capable process that keeps no transcript. A person expects no card. → Task 1 (retained matrix case).
3. **A context with `hasUI: false` but a session file** — print/JSON with a transcript. A person expects no card. → Task 1 (retained matrix case).
4. **Ghost events must not latch the visible session's terminal outcome.** An event fired from a ghost context must leave the next real turn's `Stop`/`StopFailure` outcome intact. → Task 1 (retained latch-hygiene tests).
5. **`pi -p "…"` from a terminal must produce no card.** → Task 2 manual acceptance.

---

### Task 1: Gate the pi shim on `hasUI`

**Files:**
- Modify: `extensions/pi/dealerboard.ts` (`PiContext` `:31-35`, module header `:2-14`, `liveSession` `:247-258`)
- Modify: `test/pi-shim.test.ts` (context fixtures `:15-45`, ghost-filter suite `:298-345`)

**Interfaces:**
- Consumes: pi's `ExtensionContext.hasUI: boolean` (documented *"true in TUI and RPC modes"*).
- Produces: `PiContext = { hasUI: boolean; sessionManager: { getSessionId(): string | undefined; getSessionFile(): string | undefined }; model?: { id: string } }` — the `mode` member is gone.

- [ ] **Step 1: Rewrite the test fixtures and add the RPC regression case**

In `test/pi-shim.test.ts`, replace the four context fixtures (`:15-45`) with the `hasUI` matrix. Keep the fixture names that the rest of the file uses (`TUI_CTX`, `GHOST_CTX`); rename the two matrix fixtures:

```ts
const TUI_CTX: PiContext = {
  hasUI: true,
  sessionManager: {
    getSessionId: () => "pi-s1",
    getSessionFile: () => "/sessions/pi-s1.jsonl",
  },
};

// A Paseo-driven RPC session: hasUI is true for TUI and RPC alike.
const RPC_CTX: PiContext = {
  hasUI: true,
  sessionManager: {
    getSessionId: () => "pi-rpc",
    getSessionFile: () => "/sessions/pi-rpc.jsonl",
  },
};

// Headless: hasUI false, no session file.
const GHOST_CTX: PiContext = {
  hasUI: false,
  sessionManager: {
    getSessionId: () => "pi-ghost",
    getSessionFile: () => undefined,
  },
};

// Headless print/json process that still records a transcript.
const NO_UI_WITH_FILE: PiContext = {
  hasUI: false,
  sessionManager: {
    getSessionId: () => "pi-ghost",
    getSessionFile: () => "/sessions/pi-ghost.jsonl",
  },
};

// UI-capable process that keeps no transcript.
const UI_WITHOUT_FILE: PiContext = {
  hasUI: true,
  sessionManager: {
    getSessionId: () => "pi-ghost",
    getSessionFile: () => undefined,
  },
};
```

Then add the regression test to the `pi shim ghost filter` suite, and rename every remaining `NON_TUI_WITH_FILE` reference (in the two latch-hygiene tests) to `NO_UI_WITH_FILE`:

```ts
  test("an RPC context with a UI and a session file is reported end to end", () => {
    const { sent, fire } = makeHarness({ sessionName: "Paseo agent" });
    fire("session_start", {}, RPC_CTX);
    fire("input", { source: "interactive" }, RPC_CTX);
    fire("tool_execution_start", { toolName: "Bash" }, RPC_CTX);
    fire("agent_end", agentEnd("stop"), RPC_CTX);
    fire("agent_settled", {}, RPC_CTX);
    expect(sent).toEqual([
      {
        hook_event_name: "SessionStart",
        session_id: "pi-rpc",
        cwd: process.cwd(),
        transcript_path: "/sessions/pi-rpc.jsonl",
        title: "Paseo agent",
      },
      { hook_event_name: "UserPromptSubmit", session_id: "pi-rpc" },
      { hook_event_name: "PreToolUse", session_id: "pi-rpc", tool_name: "Bash" },
      { hook_event_name: "Stop", session_id: "pi-rpc" },
    ]);
  });
```

The event names are the shim's own: `tool_execution_start` maps to `PreToolUse`, and `agent_end` emits nothing — it only latches, so the single terminal `Stop`/`StopFailure` rides `agent_settled`.

Update the three existing ghost tests to fire `NO_UI_WITH_FILE` and `UI_WITHOUT_FILE` respectively (the test *names* stay accurate: "a headless process without a session file emits nothing", "a headless process with a session file emits nothing", "a UI context without a session file emits nothing").

- [ ] **Step 2: Run the suite to verify it fails**

Run: `bun test test/pi-shim.test.ts`
Expected: FAIL. The new RPC test emits nothing (the predicate still reads `ctx.mode`, which `RPC_CTX` does not carry), and the rewritten fixtures break the existing event-mapping tests for the same reason. Both are the point: the fixtures now describe the target behavior.

- [ ] **Step 3: Implement the predicate**

In `extensions/pi/dealerboard.ts`:

1. In `PiContext` (`:31-35`), replace `mode: string;` with `hasUI: boolean;`.
2. In `liveSession` (`:247-258`), replace the guard body so it reads:

```ts
    if (ctx.hasUI !== true || sessionId === undefined || sessionFile === undefined) {
      return undefined;
    }
```

3. Rewrite the doc comment above `liveSession` (currently *"Ghost filter: extensions load in every pi process — print/json/rpc modes and subagent subprocesses included. Only interactive TUI sessions with a session file are grid-visible."*) to state the new rule in omp's terms: extensions load in every pi process, including print/json and headless subprocesses, so only sessions with a UI (`hasUI`, true in TUI and RPC) and a session file are grid-visible.
4. In the module header (`:9-11`), replace the "Ghost filter" sentence so it no longer claims only interactive TUI sessions are reported.

Do not touch any other handler, the `errorLatched` logic, `readSource` gating, or the spawn queue.

- [ ] **Step 4: Run the suite to verify it passes**

Run: `bun test test/pi-shim.test.ts`
Expected: PASS, including the new RPC regression test and the retained latch-hygiene tests.

- [ ] **Step 5: Run the full gate**

Run: `bun run check`
Expected: PASS — Biome CI, both typechecks, `build:core`, and the full suite. The typecheck is what proves `mode` has no remaining reader.

- [ ] **Step 6: Commit**

```bash
git add extensions/pi/dealerboard.ts test/pi-shim.test.ts
git commit -m "fix(pi): report UI-capable pi sessions so Paseo agents appear"
```

---

### Task 2: Docs, changelog, and the deployment note

**Files:**
- Modify: `docs/hook-configuration.md` (pi "Behavior to expect" bullet, `:896-899`)
- Modify: `CHANGELOG.md` (`[Unreleased]`, `### Fixed`)

**Interfaces:**
- Consumes: Task 1's behavior.
- Produces: documentation that matches the shipped rule.

- [ ] **Step 1: Correct the pi behavior bullet**

In `docs/hook-configuration.md`, the pi bullet currently reads:

> - A tile appears when a session starts. Extensions load in every pi process, but only interactive TUI sessions are reported — print (`pi -p`), JSON, and RPC processes never produce tiles.

Replace it with wording that matches the new rule and names Paseo explicitly:

> - A tile appears when a session starts. Extensions load in every pi process, so the shim reports only sessions with a UI (`ctx.hasUI`, true in both the terminal and RPC modes Paseo uses) and a session file. Headless print (`pi -p`), JSON, and subprocess sessions never produce tiles.

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]`, in the existing `### Fixed` section, add:

```markdown
- Pi sessions driven by Paseo now register board cards. The shim required
  `ctx.mode === "tui"`, but Paseo runs pi headless in RPC mode, where pi
  reports `mode: "rpc"` with `hasUI: true` — so every Paseo pi session was
  filtered as a ghost. The gate now matches the oh-my-pi shim's
  `ctx.hasUI === true` rule, and headless print/JSON sessions stay invisible.
```

- [ ] **Step 3: Run the full gate**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/hook-configuration.md CHANGELOG.md
git commit -m "docs: describe the pi UI-visibility rule"
```

---

## Deployment and acceptance (manual — requires Drew)

The change reaches an installed machine only through the shim installer. This
step is not automatable from a test run and is the spec's acceptance gate.

- [ ] **Step 5: Install the shim and restart pi**

Run: `bun scripts/install-local.ts`

Note what this does beyond the shim: the installer also refreshes the installed
daemon binary from the current source tree, and the installed daemon is older
than `main`. If a daemon redeploy is unwanted, copy the shim alone instead —
`extensions/pi/dealerboard.ts` into `~/.pi/agent/extensions/dealerboard.ts`
with `__DEALERBOARD_EXECUTABLE__` substituted for the installed binary path —
and leave the daemon untouched. Confirm the substitution landed:

```bash
grep -n "HELPER = " ~/.pi/agent/extensions/dealerboard.ts
```

Expected: the `HELPER` constant holds the installed binary path, not the
`__DEALERBOARD_EXECUTABLE__` placeholder.

Then restart pi (or the Paseo workspace) so the new shim loads.

- [ ] **Step 6: Confirm on-glass**

1. Run a Paseo pi session and submit a prompt: a pi card must appear, go
   `working`, and settle to `idle` with its result.
2. Run `pi -p "hello"` from a terminal: no card appears.
3. `sessions list` shows the pi row from (1) and nothing from (2).
