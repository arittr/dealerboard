# Evener Delegate Tracking and Exact-Session Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore correct active Evener child and nested-child tracking and make app and Stream Deck presses activate the exact Evener root session, including a paired upstream cold-deep-link repair.

**Architecture:** Dealerboard will build each AppWire refresh as a session-ID-keyed candidate, enrich it with stable delegate lineage, and publish events plus an authoritative child set through one atomic registry transaction. Exact activation will flow through one installed Dealerboard CLI command that derives a token-free canonical browser route; the native app and Stream Deck remain thin fixed-argv clients. The paired Evener frontend change makes `AppShell` react to navigation capability initialization so a cold `/s/{ref}` route actually opens its pane.

**Tech Stack:** Bun 1.3.14, TypeScript, Bun SQLite, AppWire v3 WebSocket RPC, Tauri 2/Rust 1.97.0, React 19, Zustand, Vitest, Biome, macOS `/usr/bin/open`, Elgato Stream Deck SDK.

## Global Constraints

- Treat `ref` as workspace transport identity, `sessionId`/`threadId` as run identity, and `delegateId` as stable delegate identity; never substitute one for another.
- Keep Dealerboard's visible model limited to active child runs. Do not add cards for dormant delegates, delegate history, or jobs.
- Keep native Evener child cards display-only and keep the deprecated Stream Deck layout top-level-only.
- Do not change registry schema version 17, snapshot-v2, the shared protocol, projection shape, app parsing, or board/Stream Deck layout.
- Use supported AppWire v3 only. Do not read Evener private state files and do not invent an AppWire activation method.
- Every `thread/read` for a listed local session must carry both its workspace `ref` and run `threadId`; the first read of each refresh replaces the socket subscription and later reads extend it.
- A refresh is all-or-nothing. No list/read error, malformed identity, ambiguous parent, limit breach, or notification-invalidated candidate may swap collector state or carry authoritative cleanup.
- `EvenerCollectorUpdate.activeChildSessionIds` is non-null only for a complete accepted refresh; every live incremental update carries `null`.
- Authoritative cleanup is scoped exactly to `provider = 'evener' AND parent_session_id IS NOT NULL`; Evener roots and every other provider are untouched.
- Keep `evener_collector_failed` as the bounded production diagnostic. Never log raw AppWire frames, thread bodies, turn content, complete delegate payloads, bearer tokens, or token-bearing URLs.
- Exact activation uses `sessionId` to construct `/s/${encodeURIComponent(`local:${sessionId}`)}`. Never use the shared list `ref`, `/rpc/s/...`, the hub root, the currently open session, or a generic fallback.
- Activation may use only configured loopback hosts. Normalize `0.0.0.0` and unspecified bind hosts to `127.0.0.1`; preserve supported custom ports; reject credentials and non-loopback hosts.
- Authentication remains collector-only. Activation must not read the bearer token or place one in a URL, argv, diagnostic, log, or child-process environment.
- App and Stream Deck launch only the installed Dealerboard binary with discrete argv `sessions`, `activate`, `evener`, `<session-id>`. The CLI launches only `/usr/bin/open` with discrete argv `-u`, `<exact-url>`. Never invoke a shell.
- Preserve Paseo-origin precedence and every existing Claude, Codex, Kimi, Paseo, and unbound-provider route.
- Preserve app `view_session` and Stream Deck `ackSession` as fire-and-forget gestures issued before activation. Activation failure flashes or alerts exactly once and does not roll either gesture back.
- Dealerboard and upstream Evener cold-load fixes are both required before exact-session activation is complete.

---

## File Structure

### Upstream Evener repository: `/Users/drewritter/prime-rad/evener`

- Modify `cmd/evener-hub/frontend/src/shell/AppShell.tsx`: subscribe to navigation mode and retry a pending exact-location lookup when capability initialization reaches `v1`.
- Modify `cmd/evener-hub/frontend/src/shell/AppShell.test.tsx`: reproduce the production `unknown -> v1` boot order without preinstalling mode or location.

### Dealerboard repository: `/Users/drewritter/projects/dealerboard`

- Modify `src/core/evener.ts`: own endpoint normalization, token-free exact-session URL construction, collector update contract, session-keyed candidate state, delegate parsing/linkage, targeted subscriptions, notification invalidation, and recursive close cleanup.
- Modify `src/core/registry.ts`: apply collector events and authoritative Evener-child reconciliation in one immediate SQLite transaction.
- Modify `src/core/cli.ts`: add the exact activation verb, fixed process boundary, and whole-update daemon wiring.
- Modify `app/src/routing.ts`: add the pure Evener route carrying `sessionId`.
- Modify `app/src/press.ts`: add the Evener activation port while retaining view-before-route and one-flash containment.
- Modify `app/src/bridge.ts`: expose the narrow `activate_evener_session` Tauri command.
- Modify `app/src/main.ts`: inject that bridge at both card-open call sites.
- Modify `app/src-tauri/src/main.rs`: run the installed CLI with fixed Evener activation argv and register the command.
- Create `src/plugin/evener-session-activation.ts`: adapt a session ID to the installed CLI command through the shared `ProcessExecutor`.
- Modify `src/plugin/controller.ts`: route Evener top-level keys to the new port after fire-and-forget ack.
- Modify `src/plugin/plugin.ts`: construct and inject the Evener activator.
- Modify `src/plugin/codex-session-activation.ts`: keep the shared process executor but remove the Evener bearer variable from every child environment.
- Modify `test/evener.test.ts`: cover endpoint security, current shared-ref fixtures, all-or-nothing candidate refresh, delegate lineage, routing, races, legacy compatibility, and close behavior.
- Modify `test/registry.test.ts`: cover authoritative scope, replacement, empty sets, null updates, and transaction rollback.
- Modify `test/cli.test.ts`: cover exact activation grammar/process behavior and daemon whole-update wiring.
- Modify `test/strip-routing.test.ts`: cover the exact Evener route and unchanged provider precedence.
- Modify `test/press.test.ts`: cover view-before-activation, exact identity, failure feedback, and display-only children.
- Create `test/evener-session-activation.test.ts`: cover the Stream Deck adapter's installed-binary argv.
- Modify `test/controller.test.ts`: cover ack-before-Evener activation and one-alert containment.
- Use existing `test/projection.test.ts`, `test/protocol.test.ts`, and `test/strip-board.test.ts` unchanged as downstream regression gates.
- Do not modify `src/core/schema.ts`, `src/protocol.ts`, app layout files, or Stream Deck layout files.

---

### Task 1: Repair Upstream Evener Cold Deep Links

**Repository:** `/Users/drewritter/prime-rad/evener`

**Files:**
- Modify: `cmd/evener-hub/frontend/src/shell/AppShell.tsx:478-495`
- Test: `cmd/evener-hub/frontend/src/shell/AppShell.test.tsx:419-429,962-980`

**Interfaces:**
- Consumes: `useNavigationStore`, `selectLocation(ref)`, `navigationStore.getState().lookupLocation(ref)`, `resetNotificationsForTests()`, `initNotifications()`, and the existing `navClient()` test harness.
- Produces: an `AppShell` effect that runs only when `locationRef !== null`, `navigationMode === "v1"`, no terminal lookup failure exists, and no fresh location resource exists.

- [ ] **Step 1: Add the production-order regression test**

Add this test adjacent to the current `/s/{ref}` deep-link test. It deliberately undoes the suite's synthetic `v1` setup and does not use the helpers that preload a location:

```tsx
test("cold /s/{ref} deep link opens after navigation initializes", async () => {
  const ref = "local:cold-deep-link";
  const client = navClient();
  let resolveLocation!: () => void;
  const locationReady = new Promise<void>((resolve) => {
    resolveLocation = resolve;
  });
  client.on("evener/navigation/read", async (params) => {
    if (params.resource === "location") {
      await locationReady;
    }
    return navigationRead(params);
  });

  resetNotificationsForTests();
  initNotifications();
  window.history.pushState({}, "", `/s/${encodeURIComponent(ref)}`);

  expect(navigationStore.getState().mode).toBe("unknown");
  expect(navigationStore.getState().resources.has(keyID({ kind: "location", ref }))).toBe(false);

  render(<AppShell client={client} />);

  await waitFor(() => expect(navigationStore.getState().mode).toBe("v1"));
  await waitFor(() =>
    expect(client.calls).toContainEqual({
      method: "evener/navigation/read",
      params: { resource: "location", ref },
    }),
  );
  expect(paneFor(ref)).toBeUndefined();

  act(() => resolveLocation());

  await waitFor(() => expect(paneFor(ref)?.slot).toBe("main"));
});
```

- [ ] **Step 2: Run the focused test and confirm the race is red**

Run from `cmd/evener-hub/frontend`:

```bash
npx vitest run --maxWorkers=4 src/shell/AppShell.test.tsx
```

Expected: the new test times out waiting for the `evener/navigation/read` location call while the existing AppShell tests pass.

- [ ] **Step 3: Subscribe AppShell to navigation mode and make it an effect dependency**

In `AppShell.tsx`, keep the location selector and add the reactive mode selector:

```tsx
const navigationMode = useNavigationStore((state) => state.mode);
const locationResource = useNavigationStore(selectLocation(locationRef ?? ""));
```

Replace the imperative mode check with the subscribed value and include it in the dependency list:

```tsx
useEffect(() => {
  if (locationRef === null || navigationMode !== "v1") {
    return;
  }
  if (locationFailed || (locationResource && !locationResource.stale)) {
    return;
  }
  void navigationStore.getState().lookupLocation(locationRef).catch(() => undefined);
}, [locationFailed, locationRef, locationResource, navigationMode]);
```

Do not change the navigation store, selectors, protocol, or route parser. Subscribing without adding the dependency, or adding the dependency without subscribing, does not fix the production race.

- [ ] **Step 4: Run the upstream focused gates**

Run from `cmd/evener-hub/frontend`:

```bash
npx vitest run --maxWorkers=4 src/shell/AppShell.test.tsx
npx biome ci src/shell/AppShell.tsx src/shell/AppShell.test.tsx
npm run typecheck
```

Expected: AppShell tests pass, Biome exits zero, and TypeScript exits zero. Then run from the upstream repository root:

```bash
make test-web
```

Expected: the complete frontend typecheck, Vitest, and Biome gate exits zero.

- [ ] **Step 5: Commit only the upstream deep-link repair**

```bash
git add cmd/evener-hub/frontend/src/shell/AppShell.tsx cmd/evener-hub/frontend/src/shell/AppShell.test.tsx
git commit -m "fix(web): resume cold session deep links after navigation init"
```

---

### Task 2: Split Evener Endpoint Resolution from Collector Authentication

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Modify: `src/core/evener.ts:30-157`
- Test: `test/evener.test.ts:1-160`

**Interfaces:**
- Consumes: `EvenerHubConfigDependencies`, `EVENER_DEFAULT_HUB_ADDRESS`, current environment-over-config address precedence, XDG roots, and collector token precedence.
- Produces:

```ts
export type EvenerHubEndpoints = Readonly<{
  appWireUrl: string;
  browserOrigin: string;
}>;

export const evenerHubEndpoints: (rawAddress: string) => EvenerHubEndpoints | null;
export const evenerAppWireUrl: (rawAddress: string) => string | null;
export const resolveEvenerHubEndpoints: (
  dependencies: EvenerHubConfigDependencies,
) => EvenerHubEndpoints | null;
export const evenerSessionUrl: (
  endpoints: EvenerHubEndpoints,
  sessionId: string,
) => string | null;
```

`resolveEvenerHubConnection` keeps its existing `(dependencies) => EvenerHubConnection | null` interface and remains the only resolver that reads `EVENER_HUB_AUTH_TOKEN` or `auth-token`.

- [ ] **Step 1: Write failing endpoint and canonical-route tests**

Extend the existing address tests with a table that asserts both endpoints:

```ts
expect(evenerHubEndpoints("127.0.0.1:9180")).toEqual({
  appWireUrl: "ws://127.0.0.1:9180/rpc",
  browserOrigin: "http://127.0.0.1:9180",
});
expect(evenerHubEndpoints("wss://localhost:9443/rpc?token=leak#fragment")).toEqual({
  appWireUrl: "wss://localhost:9443/rpc",
  browserOrigin: "https://localhost:9443",
});
expect(evenerHubEndpoints("http://0.0.0.0:9180/custom?x=1#y")).toEqual({
  appWireUrl: "ws://127.0.0.1:9180/rpc",
  browserOrigin: "http://127.0.0.1:9180",
});
expect(evenerHubEndpoints("https://example.com:9180")).toBeNull();
expect(evenerHubEndpoints("http://user:password@localhost:9180")).toBeNull();
```

Add canonical route assertions:

```ts
const endpoints = {
  appWireUrl: "ws://127.0.0.1:9180/rpc",
  browserOrigin: "http://127.0.0.1:9180",
};
expect(evenerSessionUrl(endpoints, "session/a b")).toBe(
  "http://127.0.0.1:9180/s/local%3Asession%2Fa%20b",
);
expect(evenerSessionUrl(endpoints, "")).toBeNull();
expect(evenerSessionUrl(endpoints, "\nunsafe")).toBeNull();
expect(evenerSessionUrl(endpoints, "x".repeat(257))).toBeNull();
expect(evenerSessionUrl(endpoints, "x".repeat(256))).not.toBeNull();
```

Assert the resulting URL contains none of `/rpc/s/`, `?`, `#`, or a sentinel token string.

- [ ] **Step 2: Write a failing no-token-read resolver test**

Use a `readText` spy that records paths. Return a config with a custom address and state root, then call only `resolveEvenerHubEndpoints`:

```ts
const reads: string[] = [];
const endpoints = resolveEvenerHubEndpoints({
  home: "/Users/test",
  environment: {},
  readText: (path) => {
    reads.push(path);
    return path.endsWith("hub.toml")
      ? 'addr = "127.0.0.1:9777"\nhub_state_root = "/state/evener"\n'
      : "must-not-be-read";
  },
  parseToml: Bun.TOML.parse,
});
expect(endpoints?.browserOrigin).toBe("http://127.0.0.1:9777");
expect(reads).toEqual(["/Users/test/.config/evener/hub.toml"]);
```

Retain existing tests proving `resolveEvenerHubConnection` still reads and validates the token with the same precedence.

- [ ] **Step 3: Run the focused test and confirm missing exports fail**

```bash
bun test test/evener.test.ts
```

Expected: the new imports or endpoint assertions fail because the split endpoint and session URL APIs do not exist.

- [ ] **Step 4: Implement shared settings resolution and URL construction**

Add an internal settings type so config parsing occurs once per resolver call without coupling endpoint resolution to token access:

```ts
type EvenerHubSettings = Readonly<{
  endpoints: EvenerHubEndpoints;
  stateRoot: string;
}>;
```

`evenerHubEndpoints` must:

1. trim the address and add `http://` to bare host/port forms;
2. expand `:PORT` to `127.0.0.1:PORT`;
3. parse with `URL` and reject any username or password;
4. normalize `0.0.0.0`, `::`, and `[::]` to `127.0.0.1`;
5. allow only `localhost`, `127.0.0.1`, `::1`, or `[::1]`;
6. allow only `http:`, `https:`, `ws:`, or `wss:`;
7. build one copy for AppWire with `ws/wss`, pathname `/rpc`, empty search/hash;
8. build a browser copy with `http/https`, pathname `/`, empty search/hash, and return `.origin`.

Keep compatibility through:

```ts
export const evenerAppWireUrl = (rawAddress: string): string | null =>
  evenerHubEndpoints(rawAddress)?.appWireUrl ?? null;
```

Extract the existing address/config/state-root precedence into `resolveEvenerHubSettings`. `resolveEvenerHubEndpoints` returns only `settings?.endpoints`. `resolveEvenerHubConnection` calls the same settings function, then and only then reads the environment or state-root token.

Validate session IDs without trimming or truncating accepted data:

```ts
const validSessionId = (sessionId: string): boolean =>
  sessionId.length > 0 &&
  sessionId === sessionId.trim() &&
  Array.from(sessionId).length <= MAX_WIRE_STRING_CODE_POINTS &&
  !/[\u0000-\u001f\u007f]/u.test(sessionId);

export const evenerSessionUrl = (endpoints: EvenerHubEndpoints, sessionId: string): string | null => {
  if (!validSessionId(sessionId)) {
    return null;
  }
  const url = new URL(endpoints.browserOrigin);
  url.pathname = `/s/${encodeURIComponent(`local:${sessionId}`)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
```

- [ ] **Step 5: Run the focused tests**

```bash
bun test test/evener.test.ts
```

Expected: endpoint, token-isolation, canonical route, and all pre-existing collector tests pass.

- [ ] **Step 6: Commit the endpoint boundary**

```bash
git add src/core/evener.ts test/evener.test.ts
git commit -m "feat(evener): resolve token-free session routes"
```

---

### Task 3: Add the Exact Evener CLI Activation Contract

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Modify: `src/core/cli.ts:4-13,30,55-75,129-141,323-458,460-602`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `resolveEvenerHubEndpoints(dependencies)`, `evenerSessionUrl(endpoints, sessionId)`, `AppPaths`, and `CliDependencies.environment`.
- Produces: CLI grammar `dealerboard sessions activate evener <session-id>` and this injectable process boundary:

```ts
export type CliProcessExecutor = (
  file: string,
  args: readonly string[],
) => Promise<void>;
```

Add `resolveEvenerHubEndpoints`, `evenerSessionUrl`, and `executeFile` to `CliDependencies`; change `runSessions` to return `Promise<number>`.

- [ ] **Step 1: Add failing grammar and fixed-argv tests**

Build a harness with an `executeFile` spy and no usable database. Assert:

```ts
expect(await runCli(["sessions", "activate", "evener", "session-a"], harness.deps)).toBe(0);
expect(executions).toEqual([
  {
    file: "/usr/bin/open",
    args: ["-u", "http://127.0.0.1:9180/s/local%3Asession-a"],
  },
]);
expect(databaseOpens).toBe(0);
```

Add cases for these argument arrays:

```ts
["sessions", "activate", "codex", "session-a"]
["sessions", "activate", "evener"]
["sessions", "activate", "evener", "session-a", "extra"]
["sessions", "activate", "evener", "\nunsafe"]
```

Each must return `1`, write bounded stderr, and execute no process. Add a custom `EVENER_HUB_ADDR=127.0.0.1:9777` case and assert the exact custom-port URL. Add rejected endpoint resolution, executor rejection, and simulated non-zero child cases; each must return `1`, print exactly `sessions activate failed\n`, and never attempt a fallback URL.

- [ ] **Step 2: Run the activation tests and confirm the command is red**

```bash
bun test test/cli.test.ts -t "sessions activate evener"
```

Expected: the command returns usage because `activate` is not implemented.

- [ ] **Step 3: Add the production process executor**

Implement a default that uses a fixed executable and discrete argv, waits for completion, and rejects non-zero status:

```ts
const executeFile: CliProcessExecutor = async (file, args) => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[0] !== "EVENER_HUB_AUTH_TOKEN" && entry[1] !== undefined,
    ),
  );
  const child = Bun.spawn([file, ...args], {
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error("child process failed");
  }
};
```

Do not include the URL, environment, argv, or child output in the thrown error or diagnostic. Supplying the filtered environment is mandatory: default process inheritance could otherwise forward the collector bearer variable to `/usr/bin/open`.

- [ ] **Step 4: Implement the exact activation branch**

Update the grammar comment and `USAGE` with:

```text
sessions activate evener <session-id>
```

Make `runSessions` async. Add an `activate` case that requires exactly the fixed provider literal and one session ID, resolves endpoints with `{ home: deps.paths.home, environment: deps.environment }`, builds the URL, and invokes:

```ts
await deps.executeFile("/usr/bin/open", ["-u", url]);
```

On endpoint, identity, spawn, or exit failure, write only `sessions activate failed\n` and return `1`. Change `runCli` to `return await runSessions(rest, deps)` and add defaults for the three new dependency seams in `resolveDependencies`.

- [ ] **Step 5: Run CLI and type tests**

```bash
bun test test/cli.test.ts -t "sessions activate evener"
bun test test/cli.test.ts
bun run typecheck
```

Expected: exact grammar and fixed argv pass, all existing CLI commands remain green, and typecheck exits zero.

- [ ] **Step 6: Commit the CLI boundary**

```bash
git add src/core/cli.ts test/cli.test.ts
git commit -m "feat(cli): activate exact Evener sessions"
```

---

### Task 4: Route App Presses Through the Evener Activation Port

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Modify: `app/src/routing.ts:10-43`
- Modify: `app/src/press.ts:20-78`
- Test: `test/strip-routing.test.ts`
- Test: `test/press.test.ts`

**Interfaces:**
- Consumes: `BoardSession.sessionId`, existing Paseo-origin precedence, and the CLI contract from Task 3.
- Produces:

```ts
export type SessionRoute =
  | { kind: "paseo"; agentId: string }
  | { kind: "ghostty"; terminalId: string }
  | { kind: "url"; url: string }
  | { kind: "evener"; sessionId: string }
  | { kind: "flash" };
```

and a new `PressDeps` port:

```ts
activateEvenerSession: (sessionId: string) => Promise<void>;
```

- [ ] **Step 1: Add the failing pure route test**

Add an Evener root fixture and assert:

```ts
expect(routeForSession(evenerSession({ sessionId: "evener-a" }))).toEqual({
  kind: "evener",
  sessionId: "evener-a",
});
```

Retain or add a Paseo-origin Evener fixture that still returns `{ kind: "paseo", agentId }`, proving origin precedence is unchanged.

- [ ] **Step 2: Add failing press behavior tests**

Inject spies for `view`, `activateEvenerSession`, and `flash`. Assert the call log after pressing a live Evener root is:

```ts
expect(calls).toEqual([
  ["view", "evener", "evener-a", { unreadSince: "2026-08-31T12:00:00.000Z" }],
  ["activateEvenerSession", "evener-a"],
]);
```

Make activation reject and assert one flash. Make `view` reject and activation resolve; assert activation still runs and no flash occurs. Press an Evener card with `displayOnly: true`; assert no view, activation, or flash. Retain the ended-card assertion: it views but never activates.

- [ ] **Step 3: Run the app press tests and confirm Evener is still unroutable**

```bash
bun test test/strip-routing.test.ts test/press.test.ts
```

Expected: the new route and activation assertions fail while current provider tests pass.

- [ ] **Step 4: Implement the route and press switch case**

In `routeForSession`, move only Evener out of the unbound provider group:

```ts
case "evener":
  return { kind: "evener", sessionId: session.sessionId };
```

Add the `PressDeps` port and this branch before `flash`:

```ts
case "evener":
  await deps.activateEvenerSession(route.sessionId);
  return;
```

Do not change the early `displayOnly` return, fire-and-forget view call, ended-card return, Paseo precedence, or catch block.

- [ ] **Step 5: Run the focused tests**

```bash
bun test test/strip-routing.test.ts test/press.test.ts
```

Expected: all route and press tests pass.

- [ ] **Step 6: Commit the pure app routing change**

```bash
git add app/src/routing.ts app/src/press.ts test/strip-routing.test.ts test/press.test.ts
git commit -m "feat(app): route Evener presses by session"
```

---

### Task 5: Wire the App Bridge and Tauri Host to the Installed CLI

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Modify: `app/src/bridge.ts:22-41`
- Modify: `app/src/main.ts:34-48,495-501,615-621`
- Modify: `app/src-tauri/src/main.rs:145-158,190-239,390-401,406-end`

**Interfaces:**
- Consumes: the app `activateEvenerSession(sessionId)` port from Task 4 and CLI grammar from Task 3.
- Produces: Tauri command `activate_evener_session` and fixed installed-binary argv `['sessions', 'activate', 'evener', sessionId]`.

- [ ] **Step 1: Add failing Rust unit tests for argv and failure propagation**

Add a private helper seam and tests that capture both executable and args without starting the real CLI:

```rust
#[test]
fn evener_activation_uses_fixed_installed_cli_argv() {
    let executable = Path::new("/tmp/dealerboard");
    let mut seen = None;
    let result = activate_evener_session_with(executable, "session-a", |program, args| {
        seen = Some((program.to_string(), args.iter().map(|value| value.to_string()).collect::<Vec<_>>()));
        Ok(())
    });

    assert!(result.is_ok());
    assert_eq!(
        seen,
        Some((
            executable.to_string_lossy().to_string(),
            vec!["sessions", "activate", "evener", "session-a"]
                .into_iter()
                .map(String::from)
                .collect(),
        )),
    );
}

#[test]
fn evener_activation_propagates_runner_failure() {
    let result = activate_evener_session_with(Path::new("/tmp/dealerboard"), "session-a", |_, _| {
        Err("non-zero".to_string())
    });
    assert_eq!(result, Err("non-zero".to_string()));
}
```

- [ ] **Step 2: Run the focused Rust test and confirm the helper is missing**

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml evener_activation
```

Expected: compilation fails because `activate_evener_session_with` does not exist.

- [ ] **Step 3: Implement and register the fixed-argv Tauri command**

Use a path string so the helper can pass borrowed argv into the existing `run` function safely:

```rust
fn activate_evener_session_with<F>(
    executable: &Path,
    session_id: &str,
    runner: F,
) -> Result<(), String>
where
    F: FnOnce(&str, &[&str]) -> Result<(), String>,
{
    let path = executable.to_string_lossy().to_string();
    runner(&path, &["sessions", "activate", "evener", session_id])
}

#[tauri::command]
async fn activate_evener_session(session_id: &str) -> Result<(), String> {
    let executable = app_support_root()?.join("bin/dealerboard");
    activate_evener_session_with(&executable, session_id, run)
}
```

Register `activate_evener_session` in `tauri::generate_handler!`. Do not call `/usr/bin/open` from Rust; the CLI is the one activation boundary.

Update the existing `run` helper's `Command` construction to call `.env_remove("EVENER_HUB_AUTH_TOKEN")` before `.status()`. This prevents the app-to-CLI hop from forwarding a bearer variable while preserving the fixed argv used by existing commands.

- [ ] **Step 4: Add and inject the TypeScript bridge**

In `app/src/bridge.ts` add:

```ts
export const activateEvenerSession = (sessionId: string): Promise<void> =>
  invoke<void>("activate_evener_session", { sessionId });
```

Import it in `app/src/main.ts` and add `activateEvenerSession` to both dependency objects passed at the board-click and action-sheet-open sites.

- [ ] **Step 5: Run app host and TypeScript gates**

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml evener_activation
cargo test --manifest-path app/src-tauri/Cargo.toml
bun test test/strip-routing.test.ts test/press.test.ts
bun run typecheck
```

Expected: Rust argv/failure tests, the full Rust suite, app tests, and TypeScript all pass.

- [ ] **Step 6: Commit the app host wiring**

```bash
git add app/src/bridge.ts app/src/main.ts app/src-tauri/src/main.rs
git commit -m "feat(app): invoke Evener activation through CLI"
```

---

### Task 6: Add Stream Deck Exact Evener Activation

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Create: `src/plugin/evener-session-activation.ts`
- Create: `test/evener-session-activation.test.ts`
- Modify: `src/plugin/codex-session-activation.ts:9-34`
- Modify: `src/plugin/controller.ts:21-56,175-224`
- Modify: `src/plugin/plugin.ts:15-31,53-64`
- Test: `test/controller.test.ts`

**Interfaces:**
- Consumes: `ProcessExecutor` and `executeFile` from `src/plugin/codex-session-activation.ts`, `AppPaths.executable`, and CLI grammar from Task 3.
- Produces:

```ts
export type ActivateEvenerSession = (sessionId: string) => Promise<void>;

export const createEvenerSessionActivator: (
  execute: ProcessExecutor,
  executablePath: string,
) => ActivateEvenerSession;
```

and `SessionGridPorts.activateEvenerSession`.

- [ ] **Step 1: Write the failing adapter test**

Create `test/evener-session-activation.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createEvenerSessionActivator } from "../src/plugin/evener-session-activation";

test("invokes the installed Dealerboard CLI with fixed Evener activation argv", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const activate = createEvenerSessionActivator(async (file, args) => {
    calls.push({ file, args });
  }, "/app/bin/dealerboard");

  await activate("session;still-data");

  expect(calls).toEqual([
    {
      file: "/app/bin/dealerboard",
      args: ["sessions", "activate", "evener", "session;still-data"],
    },
  ]);
});
```

Add a rejection test proving the executor's rejection propagates unchanged.

- [ ] **Step 2: Add failing controller tests**

Extend the controller harness with `activateEvenerSession`. For an Evener top-level session, record calls and assert ack is initiated before activation with the exact session ID. Add a rejected ack case proving activation still occurs. Add a rejected activation case proving `showAlert(context)` occurs exactly once. Keep one unbound provider case, such as `pi`, proving only Evener leaves the unbound branch.

- [ ] **Step 3: Run the focused plugin tests and confirm missing wiring**

```bash
bun test test/evener-session-activation.test.ts test/controller.test.ts
```

Expected: the adapter import and controller port are missing.

- [ ] **Step 4: Implement the adapter and controller branch**

Create the adapter:

```ts
import type { ProcessExecutor } from "./codex-session-activation";

export type ActivateEvenerSession = (sessionId: string) => Promise<void>;

export const createEvenerSessionActivator =
  (execute: ProcessExecutor, executablePath: string): ActivateEvenerSession =>
  (sessionId) =>
    execute(executablePath, ["sessions", "activate", "evener", sessionId]);
```

Import its type into `controller.ts`, add the port, and add:

```ts
case "evener":
  activateSession = this.ports.activateEvenerSession;
  activationTarget = session.sessionId;
  return runActivation();
```

Leave `pi`, `omp`, `zcode`, `deepseek`, `grok`, and `qwen` in the one-alert unbound group.

- [ ] **Step 5: Construct and inject the adapter**

In `plugin.ts`:

```ts
const activateEvenerSession = createEvenerSessionActivator(executeFile, appPaths.executable);
```

Inject it into `SessionGridController`. Preserve the shared `executeFile` implementation and do not add a shell or a second process helper.

Change the existing shared `execFile` call to pass an explicit environment formed from defined `process.env` entries except `EVENER_HUB_AUTH_TOKEN`. This sanitizes the plugin-to-CLI hop for Evener while keeping the same executor for Codex, Paseo, and ack operations:

```ts
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[0] !== "EVENER_HUB_AUTH_TOKEN" && entry[1] !== undefined,
  ),
);
execFile(file, [...args], { env: environment }, (error) => {
  if (error === null) {
    resolve();
    return;
  }
  reject(error);
});
```

- [ ] **Step 6: Run the focused plugin tests**

```bash
bun test test/evener-session-activation.test.ts test/controller.test.ts
bun run typecheck
```

Expected: adapter, ordering, failure containment, and type checks pass.

- [ ] **Step 7: Commit the Stream Deck activation path**

```bash
git add src/plugin/evener-session-activation.ts src/plugin/codex-session-activation.ts src/plugin/controller.ts src/plugin/plugin.ts test/evener-session-activation.test.ts test/controller.test.ts
git commit -m "feat(plugin): activate exact Evener sessions"
```

---

### Task 7: Add the Collector Update Contract and Atomic Registry Reconciliation

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Modify: `src/core/evener.ts:159-194,446-455`
- Modify: `src/core/registry.ts:136-150,575-616`
- Test: `test/evener.test.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: private `inWriteTransaction`, private `applyEvent`, `RegistryEvent`, and existing `MutationResult` ordering.
- Produces:

```ts
export type EvenerCollectorUpdate = {
  events: RegistryEvent[];
  activeChildSessionIds: readonly string[] | null;
};

export const applyEvenerCollectorUpdate: (
  db: Database,
  update: EvenerCollectorUpdate,
) => MutationResult[];
```

- [ ] **Step 1: Add failing collector-update contract tests**

Update existing `EvenerCollectorUpdate` fixtures and assertions so every live notification update includes:

```ts
{ events: expectedEvents, activeChildSessionIds: null }
```

Add a harness assertion that an authoritative update with no events still reaches `onUpdate`:

```ts
expect(updates.at(-1)).toEqual({
  events: [],
  activeChildSessionIds: [],
});
```

This prevents a restart with no live children from retaining stale rows merely because the event list is empty.

- [ ] **Step 2: Add failing registry reconciliation tests**

Using the real per-test SQLite database, cover these exact cases:

1. Preseed Evener root `root`, Evener children `keep` and `stale`, and a Codex child. Apply an update whose active set is `['keep']`; assert only `stale` is deleted.
2. Apply `activeChildSessionIds: null`; assert no omission-based deletion.
3. Apply `activeChildSessionIds: []`; assert every Evener child is deleted while the Evener root and other provider remain.
4. Preseed child A; apply `SubagentStart` for child B with authoritative set `['B']`; assert A is gone and B exists after one call.
5. Install a temporary SQLite `BEFORE DELETE` trigger that raises on the stale row. Include an event that would mutate a root, call `applyEvenerCollectorUpdate`, assert it throws, and assert both the event mutation and deletion rolled back.

- [ ] **Step 3: Run focused tests and confirm the API is red**

```bash
bun test test/evener.test.ts test/registry.test.ts
```

Expected: type or import failures for `activeChildSessionIds` and `applyEvenerCollectorUpdate`.

- [ ] **Step 4: Implement update emission helpers**

Replace the event-only `emit` helper with two explicit paths:

```ts
const emitUpdate = (update: EvenerCollectorUpdate): void => {
  if (update.events.length === 0 && update.activeChildSessionIds === null) {
    return;
  }
  try {
    dependencies.onUpdate(update);
  } catch {
    reportFailure();
  }
};

const emitIncremental = (events: RegistryEvent[]): void =>
  emitUpdate({ events, activeChildSessionIds: null });
```

Convert current notification and lifecycle call sites to `emitIncremental`. Reserve non-null IDs for the accepted-refresh path added in Task 8.

- [ ] **Step 5: Implement one-transaction registry reconciliation**

Import `EvenerCollectorUpdate` as a type in `registry.ts`. Inside one `inWriteTransaction`:

```ts
export const applyEvenerCollectorUpdate = (
  db: Database,
  update: EvenerCollectorUpdate,
): MutationResult[] =>
  inWriteTransaction(db, () => {
    const results = update.events.map((event) => applyEvent(db, event));
    if (update.activeChildSessionIds === null) {
      return results;
    }

    const active = new Set(update.activeChildSessionIds);
    const existing = db
      .query(
        "SELECT session_id FROM active_sessions WHERE provider = 'evener' AND parent_session_id IS NOT NULL",
      )
      .all() as Array<{ session_id: string }>;
    const remove = db.query(
      "DELETE FROM active_sessions WHERE provider = 'evener' AND parent_session_id IS NOT NULL AND session_id = ?",
    );
    for (const row of existing) {
      if (!active.has(row.session_id)) {
        remove.run(row.session_id);
      }
    }
    return results;
  });
```

Selecting then deleting omissions avoids invalid empty `NOT IN` SQL and SQLite bind limits at the 4,096-item collector ceiling.

- [ ] **Step 6: Run collector contract and registry tests**

```bash
bun test test/evener.test.ts test/registry.test.ts
```

Expected: update-shape, scope, A-to-B replacement, empty-set, null-set, and rollback tests pass.

- [ ] **Step 7: Commit the internal transaction boundary**

```bash
git add src/core/evener.ts src/core/registry.ts test/evener.test.ts test/registry.test.ts
git commit -m "feat(evener): reconcile active children atomically"
```

---

### Task 8: Build Refreshes as Session-Keyed All-or-Nothing Candidates

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Modify: `src/core/evener.ts:203-305,410-747`
- Test: `test/evener.test.ts`

**Interfaces:**
- Consumes: `EvenerCollectorUpdate` from Task 7, current bounded list pagination, `parseThread`, `hydrateState`, and current child visibility semantics.
- Produces these internal types and live indices:

```ts
type EvenerDelegateInfo = Readonly<{
  delegateId: string;
  ownerSessionId: string;
  rootSessionId: string;
  childSessionId: string;
  parentDelegateId: string | null;
  lifecycle: string;
  phase: string;
  status: string;
  terminal: boolean;
  resumable: boolean;
  needsAttention: boolean;
  model: string | null;
  projectionRevision: number;
}>;

type EvenerCollectorIndices = {
  statesBySessionId: Map<string, EvenerThreadState>;
  sessionIdsByRef: Map<string, Set<string>>;
  delegatesById: Map<string, EvenerDelegateInfo>;
  delegateByChildSession: Map<string, string>;
  subscribedSessionIds: Set<string>;
};
```

and an internal candidate carrying the same five collections until validation and event derivation complete.

- [ ] **Step 1: Extend test helpers for shared refs and multiple reads**

Change the existing `thread(sessionId, status, options)` helper so callers can supply `ref`, `parentRef`, `kind`, and `diagnostics` independently. Add a helper that returns every sent request matching a method rather than only the first. Keep test fixtures sanitized and structural: IDs, statuses, parentage, delegate fields, model names, and revisions only.

- [ ] **Step 2: Add failing shared-ref and targeted-read tests**

Use root `root`, child `child`, and grandchild `grandchild`, all with list `ref: 'local:root'`. Run the fixture in root-first and child-first order. For each refresh assert three distinct `thread/read` calls. Compare the calls by `threadId` rather than imposing a server-list order, and separately assert that only the first actual read has `replaceSubscription: true`:

```ts
expect(reads.map((request) => request.params.threadId).sort()).toEqual([
  "child",
  "grandchild",
  "root",
]);
expect(reads[0]?.params).toEqual(expect.objectContaining({
  ref: "local:root",
  includeTurns: false,
  subscribe: true,
  replaceSubscription: true,
}));
expect(reads.slice(1).every((request) => request.params.replaceSubscription === false)).toBe(true);
```

Respond to a simulated ref-only lookup with root data but to each targeted request with its requested session. Because this task does not parse delegate diagnostics yet, assert that all three targeted reads occur and the ambiguous shared-ref candidate publishes no partial update. Task 9 adds stable metadata and proves all three states become correctly linked cards.

- [ ] **Step 3: Add failing candidate-rejection tests**

Starting from one accepted baseline update, run each of these refreshes and assert there is no state swap and no non-null update:

- duplicate `sessionId` across list items;
- malformed local identity or status;
- repeated cursor, page limit, or item limit breach;
- one rejected `thread/list` page;
- one rejected or malformed `thread/read`;
- returned read `sessionId` not equal to requested `threadId`;
- a listed child closing before its targeted read.

After each failure, send an unambiguous notification for the old baseline session and prove the last-known-good state still handles it.

Assert the existing fixed `evener_collector_failed` diagnostic is emitted at most once for a continuous failure stretch and contains no thread payload, session content, or credential. Preserve the current disconnect/reconnect scheduler for transport, timeout, and malformed-response failures; notification-generation invalidation is the non-disconnecting retry path added in Task 10.

- [ ] **Step 4: Run the shared-ref tests and confirm current ref-key behavior fails**

```bash
bun test test/evener.test.ts -t "shared ref"
bun test test/evener.test.ts -t "candidate"
```

Expected: reads omit `threadId`, aliases overwrite each other, or partial updates leak before failure.

- [ ] **Step 5: Replace live ref-keyed storage with candidate indices**

Extend thread state only with recomputed linkage fields:

```ts
type EvenerThreadState = {
  ref: string;
  sessionId: string;
  parentRef: string | null;
  delegateId: string | null;
  parentSessionId: string | null;
  kind: string | null;
  title: string | null;
  project: string | null;
  model: string | null;
  rawStatus: AppWireStatus;
  askPending: boolean;
  pendingEscalationCount: number;
  failedTurn: boolean;
  registered: boolean;
  cleanupEmitted: boolean;
};
```

Parse list items into a temporary map keyed by `sessionId`. Previous-state carryover for `failedTurn`, `registered`, and `cleanupEmitted` must use only `statesBySessionId.get(sessionId)`, never `ref`. Reject duplicates rather than overwriting. Build `sessionIdsByRef` by adding each session ID to the ref's set.

Add a strict identity parser separate from the existing truncating metadata helper:

```ts
const wireIdentity = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  if (Array.from(value).length > MAX_WIRE_STRING_CODE_POINTS || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }
  return value;
};
```

Use `wireIdentity` for session IDs, refs, delegate IDs, and parent IDs. Keep `boundedString` only for display metadata where truncation is intentional. A malformed over-bound identity must reject the candidate rather than alias a valid truncated ID.

- [ ] **Step 6: Target every read and keep subscription effects candidate-local**

For every listed state not already `closed` or `notLoaded`, issue one sequential read with both identities. Set `replaceSubscription` from the candidate read index, not from the old live set:

```ts
const result = await request(target, "thread/read", {
  ref: listed.ref,
  threadId: listed.sessionId,
  includeTurns: false,
  subscribe: true,
  replaceSubscription: candidate.subscribedSessionIds.size === 0,
});
```

Parse the returned thread by its own identity, require its `sessionId` to equal the requested session, preserve the listed workspace `ref` contract, add the session ID to candidate subscription bookkeeping, and never swallow an individual read failure.

- [ ] **Step 7: Derive, swap, and publish only after full validation**

After all list pages and targeted reads validate, resolve only the existing unique-`parentRef` compatibility path, derive events in parent-before-child order using the existing visibility/status semantics, and compute active children from states that are children, registered, non-terminal, loaded, and not settled idle. An ambiguous shared-ref parent rejects the candidate without publishing. Task 9 extends this same parent resolver with stable delegate metadata. Then atomically replace all five live indices and emit:

```ts
emitUpdate({
  events,
  activeChildSessionIds: activeChildren.map((state) => state.sessionId),
});
```

A complete candidate with no events and no active children must still emit `{ events: [], activeChildSessionIds: [] }`.

- [ ] **Step 8: Run all collector tests**

```bash
bun test test/evener.test.ts
```

Expected: shared-ref order independence, targeted reads, all subscriptions, empty authoritative updates, candidate rejection, and legacy unique-ref tests pass.

- [ ] **Step 9: Commit the candidate refresh**

```bash
git add src/core/evener.ts test/evener.test.ts
git commit -m "fix(evener): refresh sessions by run identity"
```

---

### Task 9: Parse Stable Delegate Metadata and Resolve Nested Lineage

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Modify: `src/core/evener.ts:243-305,532-642`
- Test: `test/evener.test.ts`

**Interfaces:**
- Consumes: complete targeted-read results, `EvenerDelegateInfo`, and candidate indices from Task 8.
- Produces: populated `delegatesById` and `delegateByChildSession` candidate indices. Each published child state receives `delegateId` and an immediate `parentSessionId` resolved from the candidate.

- [ ] **Step 1: Add current-schema sanitized delegate fixtures**

Embed structural fixtures matching `thread.evener.diagnostics.delegates` with the supported fields. Use:

- root session `root`;
- delegate `dlg-parent`, owned by `root`, child session `child`, no parent delegate;
- delegate `dlg-nested`, owned by `root`, child session `grandchild`, parent delegate `dlg-parent`;
- all three thread rows sharing `ref: 'local:root'`.

Do not include prompts, turns, raw content, tokens, reasons, or complete live payloads.

- [ ] **Step 2: Add failing lineage and generation tests**

Assert in both list orders:

```ts
expect(subagentStarts).toContainEqual(expect.objectContaining({
  sessionId: "child",
  parentSessionId: "root",
}));
expect(subagentStarts).toContainEqual(expect.objectContaining({
  sessionId: "grandchild",
  parentSessionId: "child",
}));
```

Add generation A then B for one `delegateId`. The second accepted authoritative update must exclude A and include B. Applied through `applyEvenerCollectorUpdate`, the registry must contain only B.

- [ ] **Step 3: Add failing ambiguity and contradiction tests**

Cover:

- an older-hub child with no diagnostics and a unique `parentRef` resolves successfully;
- the same child with an ambiguous shared `parentRef` is withheld and the candidate is rejected;
- `parentDelegateId` names a missing delegate;
- a delegate names a missing owner or parent child session;
- two delegates claim the same child session;
- one delegate ID repeats with contradictory immutable identity;
- equal `projectionRevision` values disagree on tracked lifecycle fields.

Each invalid candidate must retain last-known-good state and carry no authoritative cleanup.

- [ ] **Step 4: Run lineage tests and confirm nested children currently flatten or disappear**

```bash
bun test test/evener.test.ts -t "delegate"
bun test test/evener.test.ts -t "nested"
```

Expected: current `parentRef` lookup cannot resolve an immediate nested parent when refs are shared.

- [ ] **Step 5: Parse and merge delegate projections deterministically**

Read only `thread.evener.diagnostics.delegates`. Require all identity strings to be non-empty bounded strings, booleans to be booleans, and `projectionRevision` to be a non-negative safe integer. For repeated `delegateId` projections:

- immutable `ownerSessionId`, `rootSessionId`, and `parentDelegateId` must agree across revisions;
- a higher revision replaces dynamic lifecycle/model fields;
- a lower revision is ignored after immutable checks;
- an equal revision must be field-for-field equal for the tracked fields;
- contradictory projections reject the complete candidate.

Build `delegateByChildSession` from the highest accepted projection and reject two delegate IDs claiming one child session.

- [ ] **Step 6: Resolve parent sessions and validate the graph**

For each child with a delegate projection:

```ts
const parentSessionId =
  delegate.parentDelegateId === null
    ? delegate.ownerSessionId
    : delegatesById.get(delegate.parentDelegateId)?.childSessionId ?? null;
```

Require the parent session to exist in `statesBySessionId`, reject self-parenting and cycles, and assign both `delegateId` and `parentSessionId`. Only when no stable metadata exists may `parentRef` resolve through `sessionIdsByRef`, and only when that set has exactly one member. Derive root and descendants in topological parent-before-child order.

- [ ] **Step 7: Run collector and registry replacement tests**

```bash
bun test test/evener.test.ts -t "delegate"
bun test test/evener.test.ts -t "nested"
bun test test/evener.test.ts test/registry.test.ts
```

Expected: immediate nested lineage, contradiction rejection, legacy unique refs, and A-to-B replacement pass.

- [ ] **Step 8: Commit delegate lineage**

```bash
git add src/core/evener.ts test/evener.test.ts
git commit -m "fix(evener): resolve nested delegate lineage"
```

---

### Task 10: Route Notifications by Session and Protect Refresh Generations

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Modify: `src/core/evener.ts:421-432,698-747,749-944`
- Test: `test/evener.test.ts`

**Interfaces:**
- Consumes: live session/ref indices from Task 8 and delegate topology from Task 9.
- Produces: one `stateForParams(params)` resolver with session-first semantics, an incrementing refresh generation, and refresh-only handling for `evener/delegate/updated`.

- [ ] **Step 1: Add failing session-targeted notification tests**

For root, child, and grandchild sharing one ref, send each supported notification with the child's `threadId` and assert only that child changes or emits:

- `thread/status/changed`;
- `turn/started`;
- `turn/completed`;
- `evener/thread/name/changed`;
- `thread/model/changed`;
- `evener/sandbox/escalation/requested`;
- `evener/sandbox/escalation/resolved`;
- `thread/started` whose embedded thread has its own session ID;
- `thread/closed`.

Use distinct titles, models, and statuses so any accidental root mutation is visible.

- [ ] **Step 2: Add failing unique and ambiguous ref fallback tests**

Send a ref-only notification to a legacy fixture where exactly one session owns the ref and assert it still applies. Then send the same shape where three sessions share the ref and assert:

```ts
expect(newUpdates).toEqual([]);
expect(timers.pendingDelays()).toContain(0);
```

Do not accept first-map-entry behavior.

- [ ] **Step 3: Add failing notification-during-refresh test**

Accept baseline state, begin another refresh, and hold one targeted read response. Send a lifecycle notification for a known child, then release the older read. Assert the notification update uses `activeChildSessionIds: null`, the stale candidate never emits, and a zero-delay refresh is scheduled. Complete that rerun and assert only it emits a non-null authoritative set.

Add `evener/delegate/updated` with an unknown delegate ID and assert it emits no direct registry event but schedules an immediate complete refresh.

- [ ] **Step 4: Run notification tests and confirm ref-only routing fails**

```bash
bun test test/evener.test.ts -t "notification"
bun test test/evener.test.ts -t "refresh generation"
```

Expected: shared-ref notifications mutate the wrong state or the delayed read overwrites the newer notification.

- [ ] **Step 5: Implement one session-first resolver**

```ts
const stateForParams = (params: Record<string, unknown>): EvenerThreadState | null => {
  const threadId = wireIdentity(params["threadId"]);
  if (threadId !== null) {
    return statesBySessionId.get(threadId) ?? null;
  }
  const ref = wireIdentity(params["ref"]);
  if (ref === null) {
    return null;
  }
  const sessionIds = sessionIdsByRef.get(ref);
  if (sessionIds === undefined || sessionIds.size !== 1) {
    return null;
  }
  const [sessionId] = sessionIds;
  return sessionId === undefined ? null : (statesBySessionId.get(sessionId) ?? null);
};
```

Every handler must call this resolver. When resolution fails, mutate nothing, emit nothing, and call `scheduleRefresh(0)`. `thread/started` must parse `params.thread` by its embedded `sessionId`, never inherit the outer shared ref's identity.

- [ ] **Step 6: Add refresh-generation invalidation**

Maintain `let refreshGeneration = 0`. Before applying any recognized lifecycle/topology notification, increment it. A refresh captures the generation before its first asynchronous request and checks it after each await and immediately before swapping candidate indices. A mismatch discards the candidate without disconnecting and schedules a zero-delay rerun. Keep `refreshing`/`refreshAgain` serialization so only one refresh owns the socket at a time.

Treat `evener/delegate/updated` as generation-invalidating, refresh-only input. It must not synthesize a thread or registry edge from notification params.

- [ ] **Step 7: Ensure incremental updates never reconcile omissions**

Route all status, turn, title, model, attention, escalation, started, and close event emissions through `emitIncremental`. Verify no handler can pass a non-null active set. A qualifying notification may update last-known-good state only when the resolver was unambiguous.

- [ ] **Step 8: Run all collector tests**

```bash
bun test test/evener.test.ts
```

Expected: targeted handlers, legacy unique-ref compatibility, ambiguous refresh scheduling, delegate invalidation, and stale-candidate rejection all pass.

- [ ] **Step 9: Commit notification routing and race protection**

```bash
git add src/core/evener.ts test/evener.test.ts
git commit -m "fix(evener): route lifecycle updates by session"
```

---

### Task 11: Remove Closed Session Subtrees Explicitly

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Modify: `src/core/evener.ts:749-863`
- Test: `test/evener.test.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `EvenerThreadState.parentSessionId`, all five live indices, session-first notification routing, and `emitIncremental`.
- Produces: one index-removal helper and post-order descendant close events.

- [ ] **Step 1: Add failing child-close and retained-root tests**

For an accepted root -> child -> grandchild graph:

1. Close only `grandchild` by `threadId`; assert one `SubagentStop` and removal from session, ref, delegate, and subscription lookups.
2. Rebuild the graph, mark the registry root unread so `SessionEnd` retains it, then close `root` by `threadId`.
3. Assert emitted event order is `SubagentStop(grandchild)`, `SubagentStop(child)`, `SessionEnd(root)`.
4. Apply the update to the real registry and assert the unread root remains but both child rows are gone.
5. Send the same close again and assert no duplicate stop events.

- [ ] **Step 2: Run close tests and confirm current direct-child deletion is insufficient**

```bash
bun test test/evener.test.ts -t "root close"
bun test test/registry.test.ts -t "retained root"
```

Expected: the grandchild stop is missing or retained child rows survive.

- [ ] **Step 3: Implement a complete index-removal helper**

Create a helper that accepts `sessionId` and:

- deletes the state from `statesBySessionId`;
- removes the session from `sessionIdsByRef.get(state.ref)` and deletes an empty set;
- removes the session from `subscribedSessionIds`;
- removes `delegateByChildSession[sessionId]` and its matching `delegatesById` entry;
- clears no unrelated delegate or session entry.

- [ ] **Step 4: Walk descendants post-order on root close**

Build children by `parentSessionId`, recursively visit descendants before their parents, and collect each existing child once. For a child close, emit one `SubagentStop` and remove that state only. For a root close, emit one `SubagentStop` for every descendant in post-order, then `SessionEnd` for the root, then remove the whole subtree from every index. Schedule the confirming refresh after the incremental events.

Do not depend on SQLite cascade: an unread root can survive `SessionEnd`, so explicit descendant stops are required.

- [ ] **Step 5: Run close and full collector tests**

```bash
bun test test/evener.test.ts test/registry.test.ts
```

Expected: child close, recursive root close, duplicate suppression, and retained-root cleanup pass.

- [ ] **Step 6: Commit recursive close behavior**

```bash
git add src/core/evener.ts test/evener.test.ts test/registry.test.ts
git commit -m "fix(evener): stop descendant sessions on root close"
```

---

### Task 12: Wire Whole Collector Updates Through the Daemon CLI Boundary

**Repository:** `/Users/drewritter/projects/dealerboard`

**Files:**
- Modify: `src/core/cli.ts:30-46,55-73,478-530`
- Test: `test/cli.test.ts:1593-end`

**Interfaces:**
- Consumes: `EvenerCollectorUpdate` and `applyEvenerCollectorUpdate(db, update)` from Task 7.
- Produces: daemon `onUpdate(update)` wiring that never destructures away `activeChildSessionIds`.

- [ ] **Step 1: Strengthen the existing daemon Evener boundary test**

Preseed the temp registry with:

- Evener root `root`;
- Evener child `stale` under `root`;
- Codex root and child;
- an incremental Evener update with `activeChildSessionIds: null`;
- then an authoritative update with `activeChildSessionIds: []` and no events.

Assert the incremental update deletes nothing. After the authoritative update, assert only Evener child `stale` is absent; both roots and the Codex child remain. Keep the existing assertion that a collector or registry callback failure is contained and does not unwind daemon startup.

- [ ] **Step 2: Run the focused daemon test and confirm stale cleanup is absent**

```bash
bun test test/cli.test.ts -t "daemon Evener collector boundary"
```

Expected: the stale child remains because current wiring passes only `events` to `applyRegistryEvents`.

- [ ] **Step 3: Add the update dependency and wire the whole object**

Import `applyEvenerCollectorUpdate`. Add an injectable dependency without repurposing hook-event `applyEvents`:

```ts
applyEvenerUpdate?: typeof applyEvenerCollectorUpdate;
```

Default it in `resolveDependencies`. In the daemon closure, select the dependency once and pass the complete update:

```ts
const applyUpdate = dependencies.applyEvenerUpdate ?? applyEvenerCollectorUpdate;
const evenerCollector = createCollector({
  connection: () => resolveConnection({ home: daemonPaths.home, environment }),
  diagnostics,
  onUpdate: (update) => {
    const db = openRegistryDatabase(daemonPaths.database, "readwrite");
    try {
      applyUpdate(db, update);
    } finally {
      db.close();
    }
  },
});
```

Keep `applyEvents` unchanged for native hook ingestion. Do not move collector ownership into `src/core/daemon.ts`.

- [ ] **Step 4: Run CLI, registry, and collector tests**

```bash
bun test test/cli.test.ts -t "daemon Evener collector boundary"
bun test test/cli.test.ts test/registry.test.ts test/evener.test.ts
```

Expected: whole-update wiring, scope, failure containment, and all collector tests pass.

- [ ] **Step 5: Commit daemon integration**

```bash
git add src/core/cli.ts test/cli.test.ts
git commit -m "fix(daemon): apply authoritative Evener updates"
```

---

### Task 13: Run Full Gates, Install Both Repairs, and Perform Live Acceptance

**Repositories:**
- `/Users/drewritter/prime-rad/evener`
- `/Users/drewritter/projects/dealerboard`

**Files:**
- Verify all files named in Tasks 1-12.
- Do not create committed fixtures containing live session IDs, prompts, tokens, credentials, or browser-auth URLs.

**Interfaces:**
- Consumes: every implementation and test interface from Tasks 1-12.
- Produces: passing upstream and Dealerboard gates plus live evidence for nested tracking, exact app/Stream Deck activation, and cold deep links.

- [ ] **Step 1: Run the complete upstream Evener web gate**

From `/Users/drewritter/prime-rad/evener`:

```bash
make test-web
```

Expected: typecheck, Vitest, and Biome all exit zero. A timeout, sandbox denial, or skipped command is not a pass.

- [ ] **Step 2: Run focused Dealerboard regression suites**

From `/Users/drewritter/projects/dealerboard`:

```bash
bun test test/evener.test.ts test/registry.test.ts test/cli.test.ts test/strip-routing.test.ts test/press.test.ts test/controller.test.ts test/evener-session-activation.test.ts
bun test test/projection.test.ts test/protocol.test.ts test/strip-board.test.ts
cargo test --manifest-path app/src-tauri/Cargo.toml
```

Expected: every command exits zero. The unchanged projection, protocol, and board tests prove no published schema or recursive-layout drift.

- [ ] **Step 3: Run the repository-wide Dealerboard gate**

```bash
bun run check
```

Expected: Biome CI, both TypeScript projects, daemon/plugin build, and the full Bun suite exit zero.

- [ ] **Step 4: Review the final diff for fixed boundaries and secret safety**

In Dealerboard:

```bash
git diff --check
git status --short
git diff -- src/core/schema.ts src/protocol.ts src/plugin/layout.ts app/src/board.ts
rg -n "EVENER_HUB_AUTH_TOKEN|auth-token|/rpc/s/|shell:\s*true|exec\(" src app test
```

Expected: no whitespace errors; no unexpected changes to schema/protocol/layout/display-only files; production activation code contains no token read, `/rpc/s/`, shell mode, or string-command execution. Test references to sentinel token names are acceptable only when asserting they are absent from activation output.

In upstream Evener:

```bash
git diff --check
git status --short
git diff -- cmd/evener-hub/frontend/src/shell/AppShell.tsx cmd/evener-hub/frontend/src/shell/AppShell.test.tsx
```

Expected: only the intended upstream source/test change remains relative to its task commit.

- [ ] **Step 5: Build and run a hub containing the upstream fix**

From `/Users/drewritter/prime-rad/evener`:

```bash
make build-hub
hub_pid="$(lsof -tiTCP:9180 -sTCP:LISTEN)"
printf 'hub pid: %s\n' "$hub_pid"
ps -p "$hub_pid" -o command=
```

Before replacing the running hub, confirm the command is the development Evener hub and that no unrelated active work depends on it. Stop it gracefully, restart the newly built hub with the exact recorded configuration, and verify `lsof -nP -iTCP:9180 -sTCP:LISTEN` reports a listener. Do not print or copy its bearer token.

- [ ] **Step 6: Install the Dealerboard daemon/plugin and app**

From `/Users/drewritter/projects/dealerboard`:

```bash
bun scripts/install-local.ts
bun run install:app
open -a Dealerboard
```

Expected: installer and app build exit zero, the daemon is running from the installed binary, the Stream Deck plugin is reloaded by the supported installer flow, and Dealerboard opens.

- [ ] **Step 7: Verify nested tracking across two refresh intervals**

Create one disposable active root -> child -> grandchild delegation in an Evener session. Use Evener's supported session/delegate inspection to record only the three canonical session IDs and immediate parent IDs; do not capture prompt or turn content. Wait at least two `EVENER_REFRESH_INTERVAL_MS` intervals, then inspect Dealerboard's published graph:

```bash
jq '{sessions: [.sessions[] | select(.provider == "evener") | {sessionId}], agents: [.agents[] | select(.provider == "evener") | {sessionId, parentSessionId}]}' \
  "$HOME/Library/Application Support/com.drewritter.dealerboard/snapshot-v2.json"
```

Expected: root, child, and grandchild are distinct; child points to root; grandchild points to child. Repeat after another two refresh intervals and confirm no duplicates or ghosts. End child generation A and start replacement generation B for the same stable delegate; after one accepted refresh, A is absent and B is present. End the root while its card is unread and confirm all descendant agent rows disappear.

- [ ] **Step 8: Verify exact app activation**

Keep two live top-level Evener sessions A and B. First open B in the Evener frontend. Press root card A in Dealerboard and verify both conditions:

1. the browser location is `/s/${encodeURIComponent(`local:${A}`)}`; and
2. the visible Evener pane is A rather than B, Welcome, or No session open.

Repeat from the app action sheet's Open action. Confirm the view gesture clears A's unread state independently of activation and that no native child card is pressable.

- [ ] **Step 9: Verify exact Stream Deck activation**

Open B again. Press A's top-level Stream Deck key and verify the same exact route and visible pane A. Confirm the ack gesture clears A's unread state. Verify a still-unbound provider continues to show the existing alert and that no child run appears in the top-level-only Stream Deck layout.

- [ ] **Step 10: Verify a fresh cold exact route**

With the authenticated browser profile, close the Evener frontend tab, then navigate a new tab directly to A's canonical route. Do not preload navigation state through a rail click. Verify the page transitions from bootstrap to visible pane A after navigation capability initialization. Reload that exact URL once and verify A opens again.

If the page remains on Welcome or No session open, the live acceptance fails even when the URL is syntactically correct. Do not substitute a generic hub-page open or rail click.

- [ ] **Step 11: Verify contained activation failure from automated boundaries**

Re-run the focused failure tests that inject unusable addresses, invalid session identity, non-zero CLI execution, rejected Tauri runner, rejected app activation, and rejected Stream Deck activation:

```bash
bun test test/evener.test.ts -t "session url"
bun test test/cli.test.ts -t "sessions activate evener"
bun test test/press.test.ts -t "Evener"
bun test test/controller.test.ts -t "Evener"
cargo test --manifest-path app/src-tauri/Cargo.toml evener_activation
```

Expected: no fallback process is called; app failure flashes exactly once; Stream Deck failure alerts exactly once; Rust and CLI failures propagate non-zero; prior view/ack gestures are not rolled back.

- [ ] **Step 12: Remove temporary live-verification artifacts**

Delete only scratch files created during this investigation or implementation, including these known paths when present:

```bash
rm -f \
  "$EVENER_SCRATCH_DIR/probe-evener-appwire.ts" \
  "$EVENER_SCRATCH_DIR/probe-evener-reads.ts" \
  "$EVENER_SCRATCH_DIR/probe-evener-navigation.ts" \
  "$EVENER_SCRATCH_DIR/evener-live-index.js"
```

Remove the browser automation capture directory created for this task if it lives under `$EVENER_SCRATCH_DIR`. Do not delete repository files or any pre-existing user data.

- [ ] **Step 13: Record final repository states**

In each repository, run:

```bash
git status --short
git log -12 --oneline
```

Expected: no uncommitted implementation or test changes remain; unrelated pre-existing work is untouched. Report upstream and Dealerboard commit hashes, every gate command and exit status, the live parent graph result, app/Stream Deck exact-session results, cold-load result, and any acceptance item that could not be executed. Do not report success for a blocked or skipped gate.
