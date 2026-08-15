# Four New Providers — P0 Core Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen the core to seven providers (`claude`, `codex`, `kimi`, `pi`, `omp`, `zcode`, `deepseek`) — protocol, projection, registry, decoder, CLI, controller, renderer, and a schema v5 migration — so later provider phases only add shims/config/docs.

**Architecture:** One shared provider-key tuple in `src/protocol.ts` that projection and CLI derive from (no more divergent literal sets). One new canonical registry event (`SessionTitleChanged`) with title-only, lease-preserving application. zcode-specific decoder rules (`PostToolUseFailure` interrupt signal, temp `transcript_path` suppression) provider-locked in the existing decoder. Schema v5 rebuilds `active_sessions` with the widened CHECK using FK-off-outside-transaction mechanics.

**Tech Stack:** Bun, `bun:sqlite`, `bun:test`, TypeScript strict, Biome. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-15-four-new-providers-design.md` (revision 2). Read §Core plumbing and §Decoder before starting.
- **The working tree contains unrelated uncommitted work.** Never `git add -A` or `git add .`; stage only the exact files each task lists.
- Style: 2 spaces, double quotes, semicolons, 120 columns. Biome strict: `noExplicitAny`, `noConsole`, `noProcessEnv` (env enters via `src/core/cli.ts` DI only), `noDefaultExport`, `noNonNullAssertion` (relaxed in `test/**`), nursery `noFloatingPromises`.
- tsconfig strictness includes `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` (bracket access), `verbatimModuleSyntax` (type imports use `import type` or inline `type` specifiers), `erasableSyntaxOnly` (no enums).
- Privacy contract: the decoder reads only `SAFE_FIELDS` keys plus the new `is_interrupt` boolean; booleans are classified in place and never stored; `PostToolUseFailure`'s `error` field is never read.
- Gate after every task: `bun test` for the touched test file; gate at plan end: `bun run check`.
- Do NOT run `bun scripts/install-local.ts` except in the final verification step, which requires the user's explicit go-ahead (it restarts the live daemon and plugin).

---

### Task 1: Shared provider keys and the `SessionTitleChanged` event type

**Files:**
- Modify: `src/protocol.ts`
- Test: `test/protocol.test.ts`

**Interfaces:**
- Produces: `PROVIDER_KEYS: readonly ["claude","codex","kimi","pi","omp","zcode","deepseek"]` (value export, `as const`); `Provider` redefined as `(typeof PROVIDER_KEYS)[number]`; `RegistryEvent` gains `{ kind: "SessionTitleChanged"; provider: Provider; sessionId: string; title: string; observedAt: string }`. Tasks 2–6 consume `PROVIDER_KEYS`; Task 3 consumes the new event member.

- [ ] **Step 1: Write the failing tests**

Append to `test/protocol.test.ts` inside the existing `describe("parseSessionSnapshot", ...)` block (reuse the `withSession` helper at the top of that file):

```ts
    test.each(["pi", "omp", "zcode", "deepseek"] as const)("accepts provider %s", (provider) => {
      const result = parseSessionSnapshot(withSession({ provider, ghosttyTerminalId: null }));
      expect(result.sessions[0]?.provider).toBe(provider);
    });

    test("still rejects an unknown provider", () => {
      expect(() => parseSessionSnapshot(withSession({ provider: "vscode" as never }))).toThrow(
        "session.provider is not a known provider",
      );
    });
```

Also add a type-level assertion the new event member exists (compile-time only, top level of the file is fine):

```ts
const titleEvent: RegistryEvent = {
  kind: "SessionTitleChanged",
  provider: "pi",
  sessionId: "s1",
  title: "Renamed session",
  observedAt: "2026-08-06T00:00:00.000Z",
};
void titleEvent;
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/protocol.test.ts`
Expected: FAIL — the `test.each` cases throw "session.provider is not a known provider", and the type assertion errors (`"SessionTitleChanged"` not assignable).

- [ ] **Step 3: Implement the protocol changes**

In `src/protocol.ts`, replace the `Provider` declaration (line 8) and the `PROVIDERS` set (line 74):

```ts
export const PROVIDER_KEYS = ["claude", "codex", "kimi", "pi", "omp", "zcode", "deepseek"] as const;

export type Provider = (typeof PROVIDER_KEYS)[number];
```

```ts
const PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_KEYS);
```

Add the new member to the `RegistryEvent` union, immediately after the `SessionObserved` member:

```ts
  | {
      kind: "SessionTitleChanged";
      provider: Provider;
      sessionId: string;
      /** Non-empty; the decoder bounds it to 256 code points like every string. */
      title: string;
      observedAt: string;
    }
```

Leave the `ghosttyTerminalId !== null && provider !== "claude"` check untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/protocol.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts test/protocol.test.ts
git commit -m "feat(protocol): add pi/omp/zcode/deepseek keys and SessionTitleChanged event"
```

---

### Task 2: Projection derives its provider set from `PROVIDER_KEYS`

**Files:**
- Modify: `src/core/projection.ts:15,58`
- Test: `test/projection.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_KEYS` from Task 1.
- Produces: `projectRows`/`readProjection` accept all seven providers (grid-blackout regression guard from review finding: an unwidened `projection.ts` set makes the daemon publish degraded health forever).

- [ ] **Step 1: Write the failing test**

Append a new describe block to `test/projection.test.ts` (reuse the `row` helper at the top of that file):

```ts
describe("new providers", () => {
  test("projects pi, omp, zcode, and deepseek rows including a child", () => {
    const sessions = projectRows([
      row("p1", { provider: "pi", slot: 1 }),
      row("o1", { provider: "omp", slot: 2 }),
      row("o1c", { provider: "omp", parent: "o1" }),
      row("z1", { provider: "zcode", slot: 3 }),
      row("d1", { provider: "deepseek", slot: 4 }),
    ]);

    expect(sessions.map((session) => session.provider)).toEqual(["pi", "omp", "zcode", "deepseek"]);
    expect(sessions[1]?.descendantCount).toBe(1);
    expect(sessions[1]?.status).toBe("working"); // live child lifts the tree
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/projection.test.ts`
Expected: FAIL with `ProjectionError` code `corrupt-row`.

- [ ] **Step 3: Replace the literal set**

In `src/core/projection.ts`, change the import on line 15 to add the value import:

```ts
import { PROVIDER_KEYS, type ProjectedSession, type Provider, type SessionSnapshotV2, type SessionStatus } from "../protocol";
```

Replace line 58:

```ts
const PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_KEYS);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/projection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/projection.ts test/projection.test.ts
git commit -m "fix(projection): derive provider set from protocol keys"
```

---

### Task 3: Registry applies `SessionTitleChanged` as a title-only update

**Files:**
- Modify: `src/core/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: the `SessionTitleChanged` union member from Task 1.
- Produces: `applyRegistryEvents` handles `SessionTitleChanged` — updates `title` only when the row exists and the stored title differs; preserves `updated_at` (the prune lease), status, and every other field; unknown identities are ignored (titles never late-join a row). Later consumed by the pi/dsh shims via the decoder (Task 4).

- [ ] **Step 1: Write the failing tests**

Append to `test/registry.test.ts` (reuse the `start` helper and `at()`; `applyRegistryEvents` and `listSessions` are already imported):

```ts
describe("SessionTitleChanged", () => {
  const titleChanged = (sessionId: string, title: string, second = 5): RegistryEvent => ({
    kind: "SessionTitleChanged",
    provider: "pi",
    sessionId,
    title,
    observedAt: at(second),
  });

  test("retitles an existing row without touching status or updated_at", () => {
    applyRegistryEvents(db, [start("s1", { provider: "pi", title: "Old", at: at(1) })]);
    applyRegistryEvents(db, [{ kind: "Activity", provider: "pi", sessionId: "s1", observedAt: at(2) }]);

    expect(applyRegistryEvents(db, [titleChanged("s1", "New title")])).toEqual(["applied"]);

    const row = listSessions(db)[0];
    expect(row?.title).toBe("New title");
    expect(row?.status).toBe("working");
    expect(row?.updatedAt).toBe(at(2));
  });

  test("is ignored for an unknown identity and never creates a row", () => {
    expect(applyRegistryEvents(db, [titleChanged("ghost", "Nope")])).toEqual(["ignored"]);
    expect(listSessions(db)).toEqual([]);
  });

  test("is ignored when the stored title already matches", () => {
    applyRegistryEvents(db, [start("s1", { provider: "pi", title: "Same", at: at(1) })]);
    expect(applyRegistryEvents(db, [titleChanged("s1", "Same")])).toEqual(["ignored"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/registry.test.ts`
Expected: FAIL — the first test's `applyRegistryEvents` throws or returns wrong results because `applyEvent` has no `SessionTitleChanged` case (also a typecheck error: switch not exhaustive).

- [ ] **Step 3: Implement the handler**

In `src/core/registry.ts`, add next to `applySessionObserved`:

```ts
/**
 * A pushed title (pi `/name`, dsh `session/title`) refreshes the row's title
 * only. `updated_at` deliberately stays put — it is the prune lease, and a
 * title push must not extend a dead session's life, matching
 * `updateSessionTitles`. Unknown identities are ignored: membership is
 * proven by prompts, not titles.
 */
const applySessionTitleChanged = (
  db: Database,
  event: Extract<RegistryEvent, { kind: "SessionTitleChanged" }>,
): MutationResult => {
  const result = db.run(
    "UPDATE active_sessions SET title = ? WHERE provider = ? AND session_id = ? AND title IS NOT ?",
    [event.title, event.provider, event.sessionId, event.title],
  );
  return result.changes > 0 ? "applied" : "ignored";
};
```

Add the case to `applyEvent`'s switch:

```ts
    case "SessionTitleChanged":
      return applySessionTitleChanged(db, event);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/registry.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/registry.ts test/registry.test.ts
git commit -m "feat(registry): apply SessionTitleChanged as a title-only update"
```

---

### Task 4: Decoder — `SessionTitleChanged`, zcode `PostToolUseFailure`, zcode transcript suppression

**Files:**
- Modify: `src/core/providers.ts`
- Test: `test/providers.test.ts`

**Interfaces:**
- Consumes: `SessionTitleChanged` (Task 1).
- Produces: hook name `SessionTitleChanged` (emitted by pi/dsh shims in later phases) decodes to the registry event; hook name `PostToolUseFailure` decodes to `Stop` iff provider is `zcode` and `is_interrupt === true`; zcode payloads never carry `transcript_path` into events; the explicit-null `transcript_path` whole-event drop becomes codex-only. The `decode` test helper's provider parameter type widens.

- [ ] **Step 1: Write the failing tests**

In `test/providers.test.ts`, first widen the helper's provider type:

```ts
const decode = (value: unknown, provider: "claude" | "codex" | "kimi" | "pi" | "omp" | "zcode" | "deepseek" = "claude"): RegistryEvent[] =>
  decodeNativeHook(provider, value, NOW);
```

Then append:

```ts
describe("SessionTitleChanged", () => {
  test("decodes a non-empty title", () => {
    expect(
      decode({ hook_event_name: "SessionTitleChanged", session_id: "s1", title: "Fresh name" }, "pi"),
    ).toEqual([
      {
        kind: "SessionTitleChanged",
        provider: "pi",
        sessionId: "s1",
        title: "Fresh name",
        observedAt: NOW,
      },
    ]);
  });

  test("decodes to zero events when the title is missing or empty", () => {
    expect(decode({ hook_event_name: "SessionTitleChanged", session_id: "s1" }, "pi")).toEqual([]);
    expect(decode({ hook_event_name: "SessionTitleChanged", session_id: "s1", title: "" }, "pi")).toEqual([]);
  });
});

describe("zcode PostToolUseFailure", () => {
  const failure = { hook_event_name: "PostToolUseFailure", session_id: "z1", is_interrupt: true };

  test("maps an interrupt to Stop for zcode only", () => {
    expect(decode(failure, "zcode")).toEqual([{ kind: "Stop", provider: "zcode", sessionId: "z1", observedAt: NOW }]);
    expect(decode(failure, "claude")).toEqual([]);
    expect(decode(failure, "kimi")).toEqual([]);
  });

  test("ignores non-interrupt failures and string-typed is_interrupt", () => {
    expect(decode({ ...failure, is_interrupt: false }, "zcode")).toEqual([]);
    expect(decode({ ...failure, is_interrupt: "true" }, "zcode")).toEqual([]);
    expect(decode({ hook_event_name: "PostToolUseFailure", session_id: "z1" }, "zcode")).toEqual([]);
  });
});

describe("zcode transcript suppression", () => {
  test("stores null instead of the deleted temp path", () => {
    expect(
      decode(
        {
          hook_event_name: "SessionStart",
          session_id: "z1",
          cwd: "/users/drew/proj",
          transcript_path: "/tmp/zcode-hook-123.jsonl",
        },
        "zcode",
      ),
    ).toEqual([
      {
        kind: "SessionStart",
        provider: "zcode",
        sessionId: "z1",
        title: null,
        project: "proj",
        ghosttyTerminalId: null,
        transcriptPath: null,
        observedAt: NOW,
      },
    ]);
  });

  test("other providers keep transcript_path", () => {
    const events = decode(
      { hook_event_name: "SessionStart", session_id: "s1", transcript_path: "/real/transcript.jsonl" },
      "claude",
    );
    expect(events[0]).toMatchObject({ transcriptPath: "/real/transcript.jsonl" });
  });
});

describe("ephemeral transcript_path filter scope", () => {
  test("explicit null drops the event for codex", () => {
    expect(decode({ hook_event_name: "SessionStart", session_id: "c1", transcript_path: null }, "codex")).toEqual([]);
  });

  test("explicit null does not drop the event for other providers", () => {
    expect(decode({ hook_event_name: "Stop", session_id: "k1", transcript_path: null }, "kimi")).toEqual([
      { kind: "Stop", provider: "kimi", sessionId: "k1", observedAt: NOW },
    ]);
  });
});
```

Note: the existing codex ambient-filter tests in this file keep passing unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/providers.test.ts`
Expected: FAIL — `SessionTitleChanged`/`PostToolUseFailure` decode to `[]`, zcode keeps its `transcript_path`, and the kimi explicit-null case decodes to `[]`.

- [ ] **Step 3: Implement the decoder changes**

In `src/core/providers.ts`:

(a) Add the boolean alias group to `SAFE_FIELDS`:

```ts
  transcriptPath: ["transcript_path", "transcriptPath"],
  isInterrupt: ["is_interrupt", "isInterrupt"],
```

(b) Add a boolean reader under `firstAllowlistedString`:

```ts
/** First actual boolean among the allowlisted aliases. Non-boolean values count as absent. */
const firstAllowlistedBoolean = (record: Record<string, unknown>, aliases: readonly string[]): boolean | undefined => {
  for (const alias of aliases) {
    const value = record[alias];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
};
```

(c) Provider-lock the ephemeral filter and add zcode suppression. Replace the early return in `decodeNativeHook`:

```ts
  // Codex Desktop's hidden ambient-suggestion threads declare no transcript;
  // the drop is codex's contract. Other providers never send an explicit
  // null (shims omit absent fields), so they are unaffected.
  if (provider === "codex" && "transcript_path" in value && value["transcript_path"] === null) {
    return [];
  }
```

In `sessionFacts`, suppress zcode's temp path:

```ts
    // zcode's transcript_path is a temp file deleted when the hook returns;
    // storing it would only mislead the titles resolver (zcode titles come
    // from its SQLite database instead).
    transcriptPath:
      provider === "zcode" ? null : (firstAllowlistedString(value, SAFE_FIELDS.transcriptPath) ?? null),
```

(d) Add the two switch cases (place `SessionTitleChanged` after `SessionStart`, `PostToolUseFailure` after `PostToolUse`):

```ts
    case "SessionTitleChanged": {
      // Shim-pushed title (pi session_info_changed, dsh session/title). The
      // registry decides whether the row exists and the title differs.
      const title = firstAllowlistedString(value, SAFE_FIELDS.title);
      if (title === undefined) {
        return [];
      }
      return [{ kind: "SessionTitleChanged", provider, sessionId, title, observedAt: now }];
    }
```

```ts
    case "PostToolUseFailure":
      // zcode has no interrupt event; a tool failure carrying is_interrupt is
      // the only signal. Tool-level failures without it are not turn events.
      // The `error` payload field is never read (privacy contract).
      return provider === "zcode" && firstAllowlistedBoolean(value, SAFE_FIELDS.isInterrupt) === true
        ? [statusEvent("Stop", provider, sessionId, now)]
        : [];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/providers.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/providers.ts test/providers.test.ts
git commit -m "feat(providers): decode SessionTitleChanged and zcode PostToolUseFailure"
```

---

### Task 5: CLI accepts the new provider keys

**Files:**
- Modify: `src/core/cli.ts:55-56,107-117`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_KEYS` from Task 1.
- Produces: `event <provider>` and `sessions clear <provider>` accept all seven keys; `USAGE` lists them (generated from the tuple so it cannot drift).

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.ts`, near the existing `unsupported_provider` tests (line ~543). Uses this file's exact helpers — `makeHarness` (line 53), `stdinOf` (line 30), `initRegistry` (line 90), and the `diagnostics`/`stderr()` accessors:

```ts
  test.each(["pi", "omp", "zcode", "deepseek"] as const)("event %s is accepted", async (provider) => {
    initRegistry();
    const harness = makeHarness({
      stdin: stdinOf(JSON.stringify({ hook_event_name: "Stop", session_id: `${provider}-1` })),
    });

    expect(await runCli(["event", provider], harness.deps)).toBe(0);
    expect(harness.diagnostics).toEqual([]);
  });

  test("usage lists every provider key", async () => {
    const harness = makeHarness();

    expect(await runCli(["bogus-command"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("event <claude|codex|kimi|pi|omp|zcode|deepseek>");
  });
```

(The Stop on a never-registered session applies as "ignored" with no diagnostics, so a clean run proves the provider arg parsed.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/cli.test.ts`
Expected: FAIL — each `event <provider>` run reports `unsupported_provider` in diagnostics, and usage lacks the new keys.

- [ ] **Step 3: Implement**

In `src/core/cli.ts`, import the tuple and replace `isProvider` and `USAGE`:

```ts
import { PROVIDER_KEYS, type Provider } from "../protocol";
```

```ts
const isProvider = (value: string | undefined): value is Provider =>
  value !== undefined && (PROVIDER_KEYS as readonly string[]).includes(value);
```

```ts
const USAGE = `usage: stream-deck-agents <command>

commands:
  init
  event <${PROVIDER_KEYS.join("|")}>
  daemon
  sessions list
  sessions clear <provider> <session-id>
  sessions clear-all
  sessions prune [max-age-hours]
`;
```

Also update the module header comment's grammar line (`event <claude|codex|kimi>` → the seven keys) to match reality.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cli.ts test/cli.test.ts
git commit -m "feat(cli): accept pi/omp/zcode/deepseek provider args"
```

---

### Task 6: Controller alerts on new-provider tile press

**Files:**
- Modify: `src/plugin/controller.ts:172-189`
- Test: `test/controller.test.ts`

**Interfaces:**
- Produces: pressing a pi/omp/zcode/deepseek tile shows the activation alert (identical UX to an unbound Claude tile); no activator port is invoked. Keeps the provider switch exhaustive at compile time (explicit cases, no `default`).

- [ ] **Step 1: Write the failing test**

Append to `test/controller.test.ts` near the "an unbound Claude tile alerts without invoking any activator" test (line ~645), using this file's exact helpers — `makeController({ view: healthyView([...]) })`, `session(slot, overrides)`, `appear(context, row, column)`, and the `*.sessionIds` / `alerts.contexts` fakes:

```ts
  test.each(["pi", "omp", "zcode", "deepseek"] as const)(
    "a %s tile press alerts without invoking any activator",
    async (provider) => {
      const harness = makeController({ view: healthyView([session(1, { provider })]) });
      await harness.controller.willAppear(appear("ctx-new", 0, 0));

      await harness.controller.keyDown("ctx-new");

      expect(harness.claudeActivation.sessionIds).toEqual([]);
      expect(harness.activation.sessionIds).toEqual([]);
      expect(harness.kimiActivation.sessionIds).toEqual([]);
      expect(harness.alerts.contexts).toEqual(["ctx-new"]);
    },
  );
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/controller.test.ts`
Expected: FAIL — `alerts.contexts` is empty because the switch falls through silently (also a typecheck error once `Provider` includes the new keys: switch not exhaustive only if the compiler flags it — the behavioral assertion is the real gate).

- [ ] **Step 3: Implement**

In `src/plugin/controller.ts` `keyDown`, add explicit cases after `"kimi"`:

```ts
      case "pi":
      case "omp":
      case "zcode":
      case "deepseek":
        // No activation binding exists for these providers yet; match the
        // unbound-Claude behavior instead of silently doing nothing.
        await this.showActivationAlert(context);
        return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/controller.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/plugin/controller.ts test/controller.test.ts
git commit -m "feat(plugin): alert on new-provider tile press"
```

---

### Task 7: Brand colors for the four new provider chips

**Files:**
- Modify: `src/plugin/render.ts:44-48`
- Test: `test/render.test.ts:150-159`

**Interfaces:**
- Produces: `PROVIDER_COLORS` entries pi `#0EA514`, omp `#F5F0EA`, zcode `#49A1E8`, deepseek `#426EFE` (brand-matched per spec §Rendering); marks are the existing first-two-letters rule (PI, OM, ZC, DE).

- [ ] **Step 1: Write the failing tests**

Extend the two existing tests in `test/render.test.ts` ("renders the provider mark for each provider", "colors the provider chip per harness"):

```ts
    expect(textNodesByClass(decode(sessionModel({ provider: "pi" }), 0), "mark")).toEqual(["PI"]);
    expect(textNodesByClass(decode(sessionModel({ provider: "omp" }), 0), "mark")).toEqual(["OM"]);
    expect(textNodesByClass(decode(sessionModel({ provider: "zcode" }), 0), "mark")).toEqual(["ZC"]);
    expect(textNodesByClass(decode(sessionModel({ provider: "deepseek" }), 0), "mark")).toEqual(["DE"]);
```

```ts
    expect(decode(sessionModel({ provider: "pi" }), 0)).toContain("#0EA514");
    expect(decode(sessionModel({ provider: "omp" }), 0)).toContain("#F5F0EA");
    expect(decode(sessionModel({ provider: "zcode" }), 0)).toContain("#49A1E8");
    expect(decode(sessionModel({ provider: "deepseek" }), 0)).toContain("#426EFE");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/render.test.ts`
Expected: FAIL — typecheck/runtime: `PROVIDER_COLORS` record is missing the new keys (`undefined` interpolated or a TS error).

- [ ] **Step 3: Implement**

```ts
const PROVIDER_COLORS: Record<Provider, string> = {
  claude: "#D97757",
  codex: "#A855F7",
  kimi: "#3B82F6",
  pi: "#0EA514",
  omp: "#F5F0EA",
  zcode: "#49A1E8",
  deepseek: "#426EFE",
};
```

Note: the omp cream chip prints dark `#10151C` letters like every chip (the mark text uses `COLOR_BACKGROUND`); the existing mark rule needs no change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugin/render.ts test/render.test.ts
git commit -m "feat(plugin): brand colors for pi/omp/zcode/deepseek chips"
```

---

### Task 8: Schema v5 — widened provider CHECK via table rebuild

**Files:**
- Modify: `src/core/schema.ts`
- Test: `test/schema.test.ts`

**Interfaces:**
- Produces: `LATEST_SCHEMA_VERSION` becomes `5`. v4 databases upgrade in place with rows, the partial unique index, and all constraints intact. The rebuild's FK toggles live **outside** any transaction (`PRAGMA foreign_keys` is a no-op inside one); `foreign_key_check` runs before commit and any violation rolls the rebuild back.

- [ ] **Step 1: Write the failing tests**

Append to `test/schema.test.ts` (it already builds legacy databases by hand — mirror `createVersion1Database` at line 54):

```ts
const createVersion4Database = (path: string): void => {
  const legacy = new Database(path, { create: true, readwrite: true });
  try {
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(`
      CREATE TABLE active_sessions (
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'kimi')),
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'waiting', 'error')),
        title TEXT,
        project TEXT,
        logical_slot INTEGER,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, session_id),
        FOREIGN KEY (provider, parent_session_id)
          REFERENCES active_sessions(provider, session_id) ON DELETE CASCADE,
        CHECK (
          (parent_session_id IS NULL AND logical_slot IS NOT NULL AND logical_slot > 0)
          OR
          (parent_session_id IS NOT NULL AND logical_slot IS NULL)
        )
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX active_sessions_unique_slot
        ON active_sessions(logical_slot)
        WHERE logical_slot IS NOT NULL;
      ALTER TABLE active_sessions ADD COLUMN ghostty_terminal_id TEXT
        CHECK (
          ghostty_terminal_id IS NULL
          OR (provider = 'claude' AND parent_session_id IS NULL AND length(ghostty_terminal_id) BETWEEN 1 AND 256)
        );
      ALTER TABLE active_sessions ADD COLUMN background_outstanding INTEGER NOT NULL DEFAULT 0
        CHECK (background_outstanding IN (0, 1));
      ALTER TABLE active_sessions ADD COLUMN transcript_path TEXT
        CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 256);
      PRAGMA user_version = 4;
    `);
    // A parent/child/grandchild chain plus a second root with a slot gap.
    // `insertSession` is this file's helper (line 27; provider is "claude").
    insertSession(legacy, "root", null, 1);
    insertSession(legacy, "child", "root", null);
    insertSession(legacy, "grandchild", "child", null);
    insertSession(legacy, "other-root", null, 3);
  } finally {
    legacy.close();
  }
};

const TS = "2026-08-06T00:00:00.000Z";
// Full 9-value insert matching INSERT_SESSION's placeholders.
const insertFull = (db: Database, provider: string, sessionId: string, parent: string | null, slot: number | null): void => {
  db.run(INSERT_SESSION, [provider, sessionId, parent, "idle", null, null, slot, TS, TS]);
};

describe("schema v5", () => {
  test("migrates a v4 database preserving rows, the index, and constraints", () => {
    const paths = resolveAppPaths(tempHome);
    createVersion4Database(paths.database);

    initializeDatabase(paths);

    const db = openRegistryDatabase(paths.database, "readwrite");
    try {
      expect(countSessions(db)).toBe(4);
      const index = db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'active_sessions_unique_slot'")
        .all();
      expect(index).toHaveLength(1);
      // The widened CHECK accepts the new providers.
      insertFull(db, "zcode", "z1", null, 4);
      expect(countSessions(db)).toBe(5);
      // The FK is live again after the rebuild: an orphan child is rejected.
      expect(() => insertFull(db, "zcode", "orphan", "missing-parent", null)).toThrow();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(5);
    } finally {
      db.close();
    }
  });

  test("rolls back and leaves the v4 database intact when the FK check fails", () => {
    const paths = resolveAppPaths(tempHome);
    createVersion4Database(paths.database);
    // Inject an orphan with FK enforcement off (impossible under normal operation).
    const legacy = new Database(paths.database, { readwrite: true });
    legacy.exec("PRAGMA foreign_keys = OFF");
    insertSession(legacy, "orphan", "missing-parent", null);
    legacy.close();

    expect(() => initializeDatabase(paths)).toThrow();

    const db = new Database(paths.database, { readonly: true, create: false });
    try {
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(4);
      expect(countSessions(db)).toBe(5); // old table, orphan included
    } finally {
      db.close();
    }
  });

  test("fails without mutating when another connection holds the write lock", () => {
    const paths = resolveAppPaths(tempHome);
    createVersion4Database(paths.database);

    const blocker = new Database(paths.database, { readwrite: true });
    blocker.exec("BEGIN IMMEDIATE");
    try {
      // The 250ms busy timeout fires; nothing is mutated.
      expect(() => initializeDatabase(paths)).toThrow();
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }

    const db = new Database(paths.database, { readonly: true, create: false });
    try {
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(4);
    } finally {
      db.close();
    }
  });
});
```

(If `openRegistryDatabase(..., "readwrite")` on the busy/constraint tests needs FK pragmas, it already sets them at open — `schema.ts:144-146`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/schema.test.ts`
Expected: FAIL — the first test's `zcode` insert violates the v4 CHECK (and `user_version` is 4).

- [ ] **Step 3: Implement the v5 migration**

In `src/core/schema.ts`:

(a) Bump the version and add the rebuild SQL:

```ts
export const LATEST_SCHEMA_VERSION = 5;
```

```ts
/**
 * v5 widens the provider CHECK. SQLite cannot alter a CHECK, so the table is
 * rebuilt: the old table is renamed aside (its self-FK is rewritten to the
 * archived name by SQLite and dropped with it), the v5 table is created
 * under the final name with a correct self-reference, rows are copied with
 * an explicit column list, and the partial unique index is recreated.
 */
const SCHEMA_VERSION_5 = `
ALTER TABLE active_sessions RENAME TO active_sessions_v4_archived;

CREATE TABLE active_sessions (
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'kimi', 'pi', 'omp', 'zcode', 'deepseek')),
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('idle', 'working', 'waiting', 'error')),
  title TEXT,
  project TEXT,
  logical_slot INTEGER,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ghostty_terminal_id TEXT
  CHECK (
    ghostty_terminal_id IS NULL
    OR (
      provider = 'claude'
      AND parent_session_id IS NULL
      AND length(ghostty_terminal_id) BETWEEN 1 AND 256
    )
  ),
  background_outstanding INTEGER NOT NULL DEFAULT 0
  CHECK (background_outstanding IN (0, 1)),
  transcript_path TEXT
  CHECK (transcript_path IS NULL OR length(transcript_path) BETWEEN 1 AND 256),
  PRIMARY KEY (provider, session_id),
  FOREIGN KEY (provider, parent_session_id)
    REFERENCES active_sessions(provider, session_id) ON DELETE CASCADE,
  CHECK (
    (parent_session_id IS NULL AND logical_slot IS NOT NULL AND logical_slot > 0)
    OR
    (parent_session_id IS NOT NULL AND logical_slot IS NULL)
  )
) WITHOUT ROWID;

INSERT INTO active_sessions
  (provider, session_id, parent_session_id, status, title, project, logical_slot,
   opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path)
SELECT
  provider, session_id, parent_session_id, status, title, project, logical_slot,
  opened_at, updated_at, ghostty_terminal_id, background_outstanding, transcript_path
FROM active_sessions_v4_archived;

DROP TABLE active_sessions_v4_archived;

CREATE UNIQUE INDEX active_sessions_unique_slot
  ON active_sessions(logical_slot)
  WHERE logical_slot IS NOT NULL;
`;
```

(b) Add the bespoke migration runner (pragma toggles must live outside the transaction — they are no-ops inside one):

```ts
/**
 * The v5 rebuild manages its own BEGIN/COMMIT: `PRAGMA foreign_keys` is a
 * no-op inside a transaction, so enforcement is disabled before BEGIN and
 * restored after COMMIT. `foreign_key_check` runs before committing; any
 * violation rolls the whole rebuild back, leaving the v4 table untouched.
 */
const migrateToV5 = (db: Database): void => {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  let committed = false;
  try {
    db.exec(SCHEMA_VERSION_5);
    const violations = db.query("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(`schema v5 rebuild left ${String(violations.length)} foreign key violation(s)`);
    }
    db.exec("PRAGMA user_version = 5");
    db.exec("COMMIT");
    committed = true;
  } finally {
    if (!committed) {
      db.exec("ROLLBACK");
    }
    db.exec("PRAGMA foreign_keys = ON");
  }
};
```

(c) Wire it into `initializeDatabase`: keep the existing `MIGRATIONS` loop (versions 1–4) exactly as-is, then after the `migrate()` call:

```ts
      migrate();
      if (version < 5) {
        migrateToV5(db);
      }
```

(The existing loop already bumps `user_version` through 4 inside its transaction; `migrateToV5` then handles 4 → 5.)

(d) Update the two existing version assertions that pin 4 — they are part of this task's implementation, not an afterthought:

- `test/schema.test.ts` line ~113: `"initializes a WAL database at user_version 4..."` — rename to say 5 and change the expectation to `{ user_version: 5 }`.
- `test/cli.test.ts` line ~107: `"creates a version 4 database..."` — rename and expect `user_version: 5` (check its exact assertion shape and mirror it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/schema.test.ts`
Expected: PASS — including the rollback test.

- [ ] **Step 5: Commit**

```bash
git add src/core/schema.ts test/schema.test.ts
git commit -m "feat(schema): migrate to v5 with widened provider check"
```

---

### Task 9: Installer stops the daemon before migrating

**Files:**
- Modify: `scripts/install-local.ts`

**Interfaces:**
- Produces: install order becomes build → package → dirs → executable → **bootout (if present)** → init/migrate → plist → bootstrap+kickstart → plugin install. The schema rebuild never runs against a live daemon (250ms busy timeout vs. the daemon's write cadence).

- [ ] **Step 1: Reorder the steps**

In `main()`, move the launchctl block so bootout happens before `init`, while bootstrap stays after the plist is written (bootstrap needs the plist file):

- After step 4 (`copyFileSync`/`chmodSync` of the executable), insert:

```ts
  // Stop the live daemon before init runs the schema migration; the rebuild
  // must not contend with the daemon's write cadence on a 250ms busy timeout.
  const uid =
    typeof process.getuid === "function"
      ? process.getuid()
      : fail("launchagent", "process.getuid is unavailable on this platform");
  const serviceTarget = `gui/${uid}/${LABEL}`;
  const probe = spawnSync(LAUNCHCTL, ["print", serviceTarget], { stdio: "ignore" });
  if (probe.status === 0) {
    run("launchagent", LAUNCHCTL, ["bootout", serviceTarget]);
  }
```

- The old step 7 then shrinks to bootstrap + kickstart only (the `uid`/`serviceTarget`/`probe` declarations move up; delete their duplicates).
- Update the header comment's step list to the new order, and fix the stale "Initialize schema version 2" comment above the init step to say "latest schema version".
- The "never edits provider configuration" contract text stays as-is (P0 still installs no shims; that machinery arrives with the first shim in P2).

- [ ] **Step 2: Verify statically**

Run: `bun run typecheck && bun run lint`
Expected: clean. (The installer has no unit tests; the live run is the final step below.)

- [ ] **Step 3: Commit**

```bash
git add scripts/install-local.ts
git commit -m "fix(scripts): stop the daemon before schema migration"
```

---

### Task 10: P0 gate — full check

- [ ] **Step 1: Run the full gate**

Run: `bun run check`
Expected: `biome ci .` clean, build succeeds, all tests pass.

- [ ] **Step 2: Live reinstall (requires the user's explicit go-ahead)**

Run: `bun scripts/install-local.ts`
Expected: daemon boots on schema v5, existing claude/codex/kimi tiles keep working. Confirm with the user before running — this restarts their daemon and plugin.
