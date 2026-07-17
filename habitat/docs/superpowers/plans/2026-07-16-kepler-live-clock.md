# Kepler Live Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing Habitat backend to Kepler's authenticated live clock with durable mode/cursor state, concurrency-safe simulation advances, local SSE observation, CLI controls, restart recovery, and no token leakage.

**Architecture:** Retain the existing `habitat_state` JSON row and add versioned SQLite tables for clock state and the one authoritative stream token. A single backend-owned clock service serializes listening changes and manual/remote ticks; a storage transaction applies the shared simulation function and advances the absolute Kepler cursor together. The CLI and dashboard call only Hono endpoints, and `clock watch` consumes a token-free local SSE feed.

**Tech Stack:** TypeScript, Bun 1.3, `bun:sqlite`, Hono, Commander, native WebSocket, native Fetch/ReadableStream SSE, React/Vite, Bun test.

## Global Constraints

- Preserve the existing Hono backend, SQLite state, CLI, simulation behavior, dashboard, and deployed service.
- Use Bun and existing TypeScript conventions; do not add a WebSocket dependency.
- Never put or log the stream token in a URL, query string, event, screenshot, fixture output, or Git history.
- `habitat status` intentionally prints the complete saved stream token; all other general state and event surfaces omit it.
- Apply only future notices observed during an acknowledged live session; do not request or replay missed ticks.
- Use one final commit named `Connect Habitat to the Kepler live clock`, as explicitly required by the lab brief.

## File map

- Create `src/clock/types.ts`: persisted/status/protocol/event types and validators' shared shapes.
- Create `src/clock/storage.ts`: migration, registration-secret storage, clock row storage, and atomic simulation/cursor writes.
- Create `src/clock/events.ts`: future-only in-memory event hub and SSE response creation.
- Create `src/clock/service.ts`: serialized mode transitions, WebSocket handshake/reconnect state machine, notice application, and shutdown.
- Create `src/clock/cli.ts`: status formatters and local SSE parsing/watching.
- Create `src/domain/simulation.ts`: shared pure simulation advancement.
- Modify `src/state/types.ts`, `src/state/service.ts`, and `src/storage.ts`: registration metadata and migration-aware storage hooks.
- Modify `src/kepler/service.ts`: complete registration response normalization and stable UUID recovery.
- Modify `src/domain/commands.ts`: delegate manual simulation behavior to the shared operation.
- Modify `src/server/routes.ts` and `src/server.ts`: inject one clock service, mount controls/status/events, reject manual ticks, and own lifecycle.
- Modify `src/client.ts` and `src/index.ts`: global JSON/JSONL modes and `clock` CLI group.
- Modify `web/src/react-app.tsx` and `vite.config.ts`: local clock commands and `/clock` dev proxy.
- Modify `DEPLOYMENT.md`: live-clock behavior, restart semantics, and intentionally missed tick policy.
- Add `test/clock-storage.test.ts`, `test/clock-registration.test.ts`, `test/clock-service.test.ts`, `test/clock-routes.test.ts`, and `test/clock-cli.test.ts`.

---

### Task 1: Persist clock state and registration credentials additively

**Files:**
- Create: `src/clock/types.ts`
- Create: `src/clock/storage.ts`
- Modify: `src/state/types.ts`
- Modify: `src/state/service.ts`
- Modify: `src/storage.ts`
- Test: `test/clock-storage.test.ts`

**Interfaces:**
- Produces `ClockState`, `ClockStatus`, `RegistrationStream`, `PlanetTickNotice`, and `DEFAULT_CLOCK_STATE`.
- Produces `createClockStorage(path): ClockStorage` with `migrate`, `getClockState`, `saveClockState`, `saveRegistration`, `getRegistrationToken`, `applyManualTick`, and `applyPlanetTick`.
- `applyManualTick` and `applyPlanetTick` receive a synchronous state mutator so SQLite can commit state and cursor in one transaction.

- [ ] **Step 1: Write migration and persistence tests**

```ts
test("migration preserves the existing habitat JSON and defaults to manual mode", async () => {
  const path = join(temp, "habitat.sqlite");
  await writeSqliteState(path, normalizeState({ inventory: { water: 9 } }));
  const storage = createClockStorage(path);
  await storage.migrate();
  expect((await readSqliteState(path) as HabitatState).inventory.water).toBe(9);
  expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);
});

test("registration token is stored once outside the public state row", async () => {
  await storage.saveRegistration(state, "stream-secret");
  expect(JSON.stringify(await readSqliteState(path))).not.toContain("stream-secret");
  expect(await storage.getRegistrationToken("habitat_1")).toBe("stream-secret");
});

test("planet state and absolute cursor commit together", async () => {
  const result = await storage.applyPlanetTick(notice, (state) => {
    state.power.powerConsumedTicks += 100;
    return { data: state };
  });
  expect(result.applied).toBe(true);
  expect((await storage.getClockState()).latestPlanetTick).toBe(900);
  expect((await readSqliteState(path) as HabitatState).power.powerConsumedTicks).toBe(100);
});
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `bun test test/clock-storage.test.ts`

Expected: failure because `createClockStorage`, clock types, and migration tables do not exist.

- [ ] **Step 3: Implement exact persisted shapes and migrations**

```ts
export type ClockMode = "manual" | "kepler";
export type ClockConnectionState = "connected" | "connecting" | "disconnected" | "error";
export type ClockState = {
  mode: ClockMode;
  listeningEnabled: boolean;
  connectionState: ClockConnectionState;
  latestPlanetTick: number | null;
  latestAdvancedBy: number | null;
  lastConnectedAt: string | null;
  lastMessageAt: string | null;
  latestError: string | null;
};
export const DEFAULT_CLOCK_STATE: ClockState = {
  mode: "manual", listeningEnabled: false, connectionState: "disconnected",
  latestPlanetTick: null, latestAdvancedBy: null,
  lastConnectedAt: null, lastMessageAt: null, latestError: null,
};
```

Migration `1` must create `habitat_clock_state` and `habitat_registration_secrets`, insert the singleton default with `INSERT OR IGNORE`, record itself in `schema_migrations`, and never rewrite `habitat_state`. `saveRegistration` must write the JSON row and secret row inside one `BEGIN IMMEDIATE` transaction. `applyPlanetTick` must re-read both rows inside that transaction, reject non-Kepler mode and non-increasing absolute ticks, mutate a normalized state, update the cursor/amount/message time, and commit both rows together.

- [ ] **Step 4: Run storage and existing state tests**

Run: `bun test test/clock-storage.test.ts test/state-service.test.ts`

Expected: all tests pass and existing inventory/state values survive migration.

### Task 2: Persist complete registration stream data and upgrade in place

**Files:**
- Modify: `src/kepler/service.ts`
- Modify: `src/state/types.ts`
- Modify: `src/state/service.ts`
- Modify: `src/server/routes.ts`
- Modify: `test/registration-hydration.test.ts`
- Create: `test/clock-registration.test.ts`

**Interfaces:**
- Produces `KeplerHabitatRegistration` with `habitatId`, `streamUrl`, `apiToken`, `stream`, starter data, contracts, and blueprints.
- Produces `recoverHabitatUuid(habitatId: string): string | undefined`.
- Registration route uses `ClockStorage.saveRegistration(state, apiToken)` and always sets manual/off clock state.

- [ ] **Step 1: Replace the obsolete no-token assertion with persistence/security tests**

```ts
expect(state.registration).toEqual(expect.objectContaining({
  habitatId: "habitat_1", habitatUuid: expect.any(String),
  streamUrl: "wss://planet.turingguild.com/planet/stream",
  stream: expect.objectContaining({ subscriptions: ["ticks"], currentTick: 800 }),
}));
expect(await secrets.getRegistrationToken("habitat_1")).toBe("habitat-stream-token");
expect(JSON.stringify(state)).not.toContain("habitat-stream-token");
```

Add an upgrade test that starts with the existing ID `habitat_be05aee4_fe6e_4620_a16a_f100b260685b`, posts registration again, and asserts the outgoing body reuses `be05aee4-fe6e-4620-a16a-f100b260685b`, the saved display name, and the same returned Habitat ID without clearing inventory/modules/humans.

- [ ] **Step 2: Run registration tests and confirm red**

Run: `bun test test/registration-hydration.test.ts test/clock-registration.test.ts`

Expected: failures because the normalizer drops stream fields and existing registration is rejected.

- [ ] **Step 3: Implement strict current-contract normalization and UUID reuse**

```ts
export type RegistrationStream = {
  protocolVersion: string;
  subscriptions: string[];
  currentTick: number;
  tickIntervalMs: number;
  ticksPerPulse: number;
  status: "paused" | "running";
};

export function recoverHabitatUuid(id: string): string | undefined {
  const match = /^habitat_([0-9a-f]{8})_([0-9a-f]{4})_([0-9a-f]{4})_([0-9a-f]{4})_([0-9a-f]{12})$/i.exec(id);
  return match ? match.slice(1).join("-").toLowerCase() : undefined;
}
```

New registrations generate and persist one UUID. Existing registrations with no stream URL/token are allowed through once using their saved UUID or strict ID recovery; registrations already containing stream metadata plus a stored token remain rejected as already complete. Registration must save stream metadata and the secret atomically, then persist manual/off clock state.

- [ ] **Step 4: Run registration, Kepler service, and state tests**

Run: `bun test test/registration-hydration.test.ts test/clock-registration.test.ts test/kepler-service.test.ts test/state-service.test.ts`

Expected: all pass; no assertion or output contains the fixture token except equality against the isolated secret store.

### Task 3: Share simulation advancement and serialize manual/live ticks

**Files:**
- Create: `src/domain/simulation.ts`
- Modify: `src/domain/commands.ts`
- Create: `src/clock/service.ts`
- Test: `test/domain-commands.test.ts`
- Test: `test/clock-service.test.ts`

**Interfaces:**
- Produces `advanceSimulation(state, count, irradiance): SimulationAdvanceResult`.
- Produces `createClockService(dependencies): ClockService` with `getStatus`, `listenOn`, `listenOff`, `manualTick`, and `applyValidatedNotice`. Task 4 adds WebSocket lifecycle/raw-message methods; Task 5 attaches the event hub.

- [ ] **Step 1: Add equivalence, validation, and mode tests**

```ts
for (const count of [1, 10, 100]) {
  test(`remote advancedBy ${count} equals manual ${count}`, async () => {
    const manual = seededState();
    const remote = structuredClone(manual);
    advanceSimulation(manual, count, 900);
    advanceSimulation(remote, count, 900);
    expect(remote).toEqual(manual);
  });
}

test("manual tick is rejected without mutation whenever listener intent is on", async () => {
  await service.listenOn();
  const before = await repository.snapshot();
  await expect(service.manualTick(1)).rejects.toThrow("habitat clock listen off");
  expect(await repository.snapshot()).toEqual(before);
});
```

Add table tests for zero, negative, fractional, missing, and nonnumeric `advancedBy`, plus duplicate and older absolute ticks.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `bun test test/domain-commands.test.ts test/clock-service.test.ts`

Expected: clock service imports fail and manual/remote equivalence helpers are absent.

- [ ] **Step 3: Extract the shared simulation function and add a FIFO operation queue**

```ts
export function advanceSimulation(state: HabitatState, count: number, irradiance: number): SimulationAdvanceResult {
  const completedJobs: string[] = [];
  let advancedConstructionTicks = 0, pausedConstructionTicks = 0, energyCost = 0;
  for (let step = 0; step < count; step += 1) {
    const result = advanceConstructionTick(state, irradiance);
    completedJobs.push(...result.completedJobs);
    advancedConstructionTicks += result.advancedConstructionTicks;
    pausedConstructionTicks += result.pausedConstructionTicks;
    energyCost += result.energyCost;
  }
  return { completedJobs, advancedConstructionTicks, pausedConstructionTicks, energyCost, data: state };
}
```

Implement the service queue as a promise tail. `listenOn` queues persistence of Kepler/listening/connecting before opening a socket. `listenOff` immediately flips an in-memory acceptance generation and closes the socket, then queues persistence of manual/off after any in-flight tick. `manualTick` queues mode validation, irradiance fetch, and `ClockStorage.applyManualTick`.

- [ ] **Step 4: Run focused tests**

Run: `bun test test/domain-commands.test.ts test/clock-service.test.ts`

Expected: equivalence and mode/concurrency tests pass.

### Task 4: Implement the authenticated WebSocket protocol and reconnect behavior

**Files:**
- Modify: `src/clock/types.ts`
- Modify: `src/clock/service.ts`
- Modify: `test/clock-service.test.ts`

**Interfaces:**
- `ClockServiceDependencies.openWebSocket(url): WebSocketLike` is injectable.
- Extends `ClockService` with `start`, `stop`, and `handleRawMessage`.
- `hello` is exactly `{ type: "hello", apiToken, subscribe: ["ticks"] }`.
- Emits validated public event values through an injected callback as `{ type: "planet_tick", tick, advancedBy, issuedAt, applied }`; Task 5 owns subscriber/SSE delivery.

- [ ] **Step 1: Add fake-socket protocol tests**

Tests must assert: the token is absent from the URL, `hello` is the first sent message, only advertised `ticks` is subscribed, pre-ack ticks are ignored, malformed JSON is contained, full `hello_ack` is required, mismatched Habitat ID errors, reconnect creates one replacement socket, stop cancels reconnect, and a reconnect uses `ack.currentTick` as a no-catch-up floor.

```ts
expect(fake.url).toBe("wss://planet.turingguild.com/planet/stream");
expect(JSON.parse(fake.sent[0])).toEqual({ type: "hello", apiToken: STREAM_TOKEN, subscribe: ["ticks"] });
expect(fake.url).not.toContain(STREAM_TOKEN);
```

- [ ] **Step 2: Run the service test and confirm red**

Run: `bun test test/clock-service.test.ts`

Expected: failures for handshake, acknowledgement, reconnect, and notice validation.

- [ ] **Step 3: Implement the protocol state machine**

On socket open, send `hello`. Until a valid ack arrives, reject all ticks. On ack, require `connectionId`, matching `habitatId`, `subscriptions`, nonnegative `currentTick`/`catchUpTicks`, positive interval/pulse, valid `clockStatus`, and valid `serverTime`; persist connected time and set the session floor to `max(ack.currentTick, saved latest tick)`. Validate every tick, require `tick - previousTick === advancedBy`, and reject any notice whose `previousTick` is below the session floor. Unexpected close persists disconnected/error and schedules one reconnect with the injected delay; stale socket callbacks are ignored by generation.

- [ ] **Step 4: Run protocol and storage tests**

Run: `bun test test/clock-service.test.ts test/clock-storage.test.ts`

Expected: all handshake, validation, dedupe, reconnect, no-catch-up, and shutdown tests pass.

### Task 5: Add clock HTTP routes, SSE, manual rejection, and server lifecycle

**Files:**
- Create: `src/clock/events.ts`
- Modify: `src/server/routes.ts`
- Modify: `src/server.ts`
- Create: `test/clock-routes.test.ts`
- Modify: `test/server.test.ts`

**Interfaces:**
- `GET /clock/status` returns `ClockStatus` with `manualTicksAllowed: boolean`.
- `POST /clock/listen/on` and `/off` return the new status.
- `GET /clock/events` returns `text/event-stream` and no replay.
- `POST /commands/tick` delegates to `clock.manualTick` and returns HTTP 409 while listening.
- Produces `ClockEventHub` and wires it to the clock service's validated-event callback.

- [ ] **Step 1: Add route/SSE/lifecycle tests**

```ts
expect(await app.request("/clock/status").then((r) => r.json())).toEqual(expect.objectContaining({
  mode: "manual", listeningEnabled: false, manualTicksAllowed: true,
}));
expect((await app.request("/commands/tick", tickRequest)).status).toBe(409);
```

Open an SSE response, publish one event after subscription, assert exactly one `data:` object with `tick`, full `advancedBy`, `issuedAt`, and `applied`, then assert the serialized event lacks `apiToken` and the fixture token. Add start/stop tests proving persisted listening reconnects once and signal shutdown closes the socket without clearing listening intent.

- [ ] **Step 2: Run route tests and confirm red**

Run: `bun test test/clock-routes.test.ts test/server.test.ts`

Expected: 404/SPA fallback for clock routes and unconditional manual tick behavior.

- [ ] **Step 3: Mount routes before the SPA fallback and own one runtime**

Extend the typed HTTP error to support 400/409. Inject `ClockService` into `createApp`. Build one service in `startServer`, call `start()` before serving, retain the Bun server handle, and register idempotent SIGINT/SIGTERM cleanup that calls `clock.stop({ preserveListening: true })` and `server.stop()`.

`ClockEventHub.createResponse(signal)` must subscribe only when the response is opened, emit no history, unsubscribe on abort/cancel, and serialize only the public `ClockEvent` shape.

- [ ] **Step 4: Run all backend tests**

Run: `bun test test/clock-routes.test.ts test/server.test.ts test/human-eva-alerts.test.ts test/registration-hydration.test.ts`

Expected: all pass; existing routes remain unchanged.

### Task 6: Add stable CLI status/listen/watch and JSON/JSONL output

**Files:**
- Create: `src/clock/cli.ts`
- Modify: `src/client.ts`
- Modify: `src/index.ts`
- Create: `test/clock-cli.test.ts`

**Interfaces:**
- `formatClockStatus(status): string[]` and `formatHabitatStatus(payload): string[]`.
- `watchClockEvents({ signal, jsonl, write }): Promise<void>` consumes `GET /clock/events` only.
- Root options are `--json` and `--jsonl`; `habitat --json status` and `habitat --json clock status` print one JSON document, while `habitat --jsonl clock watch` prints one object per line.

- [ ] **Step 1: Add formatter, command, and streaming parser tests**

Tests must cover complete token display in status without printing the fixture during the test run, stable JSON field names, manual/listening status copy, listen on/off requests, chunk-split SSE parsing, one JSONL object per event, and AbortController cleanup. Assert no code path in watch calls `new WebSocket`.

- [ ] **Step 2: Run CLI tests and confirm red**

Run: `bun test test/clock-cli.test.ts`

Expected: imports/commands absent.

- [ ] **Step 3: Implement global modes and the clock command group**

```ts
const clock = new Command("clock").description("Control the Kepler live clock.");
clock.command("status").action(printClockStatus);
clock.command("listen").argument("<mode>", parseOnOff).action(setClockListening);
clock.command("watch").action(watchClock);
program.option("--json", "print one JSON document");
program.option("--jsonl", "print one JSON object per streamed event");
```

Change Habitat status to call `/commands/status?includeStreamToken=true`, add `--json` support, and print Habitat ID, stream URL, complete token, subscriptions, and registration-time clock metadata. The client SSE parser must use `response.body.getReader()`, preserve partial lines between chunks, combine `data:` lines per SSE event, and abort cleanly on Ctrl+C.

- [ ] **Step 4: Run CLI tests and command help smokes**

Run: `bun test test/clock-cli.test.ts && bun run src/index.ts --help && bun run src/index.ts clock --help`

Expected: tests pass and help lists global JSON modes plus `clock status|listen|watch`.

### Task 7: Keep the dashboard local-only and document operations

**Files:**
- Modify: `web/src/react-app.tsx`
- Modify: `vite.config.ts`
- Modify: `DEPLOYMENT.md`
- Modify: `test/web-ui-utils.test.ts`

**Interfaces:**
- Dashboard clock actions use relative `/clock/status`, `/clock/listen/on`, and `/clock/listen/off` requests only.
- No browser WebSocket is introduced.

- [ ] **Step 1: Add a dashboard command-list assertion**

```ts
expect(source).toContain('"/clock/status"');
expect(source).toContain('"/clock/listen/on"');
expect(source).not.toContain("new WebSocket");
```

- [ ] **Step 2: Run web tests and confirm red**

Run: `bun test test/web-ui-utils.test.ts`

Expected: clock command assertions fail.

- [ ] **Step 3: Add status/listen commands and operational documentation**

Add Clock Status, Clock Listen On, and Clock Listen Off to the React command drawer; add `/clock` to the Vite proxy. Document registration-token separation, commands, restart recovery, safe journal verification, and: “Habitat applies only future notices observed while live listening is enabled; reconnecting resumes from future notices without attempting local catch-up.”

- [ ] **Step 4: Verify the dashboard bundle**

Run: `bun test test/web-ui-utils.test.ts && bun run web:build`

Expected: tests pass and Vite completes without errors.

### Task 8: Full verification, live upgrade/service checks, security review, and delivery

**Files:**
- Modify only if verification reveals a rooted defect.
- Review every changed file and the Git index.

**Interfaces:**
- Final persisted mode is manual/off.
- Final commit message is exactly `Connect Habitat to the Kepler live clock`.

- [ ] **Step 1: Run the complete automated verification**

Run: `bun test && bun run check && bun run web:build`

Expected: zero failing tests, zero TypeScript errors, successful Vite bundle.

- [ ] **Step 2: Upgrade the existing live registration without revealing its token**

Start the local backend, run the registration upgrade once with the saved display name, and verify via a redacting assertion script that the saved Habitat ID is unchanged, the stream URL/token/metadata are present, the token is nonempty, and clock defaults are manual/off. Do not print the token or raw status response.

- [ ] **Step 3: Run manual/live/manual service smokes and restart checks**

Verify `clock listen off → status → tick 1`, `clock listen on → status → tick rejection`, and `clock listen off → status → tick 1`. If a live future Kepler notice arrives, verify its full `advancedBy` was applied and the journal contains only tick metadata. Restart in off and on modes where the deployed user service is available; confirm intent persistence/reconnect, then return to off. If this host lacks the deployed service or no instructor tick arrives, record the exact remaining evidence command without claiming success.

- [ ] **Step 4: Perform secret and diff review**

Run: `git diff --check`, inspect `git diff --stat` and `git diff`, search tracked changes for the known live token without printing matches, and confirm no `.env`, SQLite database, generated log, screenshot, or unrelated file is staged.

- [ ] **Step 5: Request code review and fix only evidenced issues**

Use the code-review workflow against the final diff. For each actionable finding, reproduce it with a focused failing test, implement the smallest root-cause fix, and rerun the affected suite followed by full verification.

- [ ] **Step 6: Commit and push**

```bash
git add habitat
git commit -m "Connect Habitat to the Kepler live clock"
git push origin main
```

Expected: commit succeeds on the existing repository and `origin/main` advances. If authentication is the only blocker, use the built-in approval/authentication flow and report it precisely.
