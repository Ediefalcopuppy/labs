import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClockService } from "../src/clock/service";
import { createClockStorage } from "../src/clock/storage";
import { DEFAULT_CLOCK_STATE, type ClockEvent } from "../src/clock/types";
import { createApp } from "../src/server/routes";
import { createStateService, normalizeState } from "../src/state/service";
import { HabitatStateConflictError } from "../src/storage";

const STREAM_TOKEN = "fixture-route-stream-token";
const ISSUED_AT = "2026-07-16T12:00:00.000Z";

let temp: string;
let path: string;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "habitat-clock-routes-"));
  path = join(temp, "habitat.sqlite");
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

function createManualClock(options: { getIrradiance?: () => Promise<number> } = {}) {
  const storage = createClockStorage(path);
  const service = createClockService({
    storage,
    getRegistration: async () => undefined,
    getIrradiance: options.getIrradiance ?? (async () => 900),
  });
  return { service, storage };
}

function tickRequest(count = 1): RequestInit {
  return tickBodyRequest({ count });
}

function tickBodyRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function getStateSnapshot(app: ReturnType<typeof createApp>): Promise<{
  body: ReturnType<typeof normalizeState>;
  etag: string;
}> {
  const response = await app.request("/state");
  const etag = response.headers.get("etag");
  expect(response.status).toBe(200);
  expect(etag).not.toBeNull();
  return {
    body: await response.json() as ReturnType<typeof normalizeState>,
    etag: etag!,
  };
}

describe("clock HTTP routes", () => {
  test("never exposes the isolated token through remotely reachable status routes", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    await storage.saveRegistration(normalizeState({
      registration: {
        displayName: "Route Habitat",
        registeredAt: ISSUED_AT,
        lastSyncedAt: ISSUED_AT,
        habitatId: "habitat_route",
        streamUrl: "wss://planet.example.test/stream",
        stream: {
          protocolVersion: "1.0",
          subscriptions: ["ticks"],
          currentTick: 800,
          tickIntervalMs: 1_000,
          ticksPerPulse: 10,
          status: "paused",
        },
      },
    }), STREAM_TOKEN);
    const service = createClockService({
      storage,
      getRegistration: async () => (await stateService.getState()).registration,
    });
    const app = createApp(stateService, storage, service);

    const publicState = await app.request("/state").then((response) => response.json());
    const ordinaryStatus = await app.request("/commands/status").then((response) => response.json());
    const falseStatus = await app.request("/commands/status?includeStreamToken=false")
      .then((response) => response.json());
    const clockStatus = await app.request("/clock/status").then((response) => response.json());
    const optedInStatus = await app.request("/commands/status?includeStreamToken=true")
      .then((response) => response.json());

    expect(JSON.stringify(publicState).includes(STREAM_TOKEN)).toBe(false);
    expect(JSON.stringify(ordinaryStatus).includes(STREAM_TOKEN)).toBe(false);
    expect(JSON.stringify(falseStatus).includes(STREAM_TOKEN)).toBe(false);
    expect(JSON.stringify(clockStatus).includes(STREAM_TOKEN)).toBe(false);
    expect(JSON.stringify(optedInStatus).includes(STREAM_TOKEN)).toBe(false);
    expect(JSON.stringify(optedInStatus).includes("apiToken")).toBe(false);
  });

  test("unregister stops listening and removes public and secret registration state", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    await storage.saveRegistration(normalizeState({
      inventory: { water: 4 },
      registration: {
        displayName: "Route Habitat",
        registeredAt: ISSUED_AT,
        lastSyncedAt: ISSUED_AT,
        habitatId: "habitat_route",
      },
    }), STREAM_TOKEN);
    await storage.saveClockState({
      ...DEFAULT_CLOCK_STATE,
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "error",
    });
    const service = createClockService({
      storage,
      getRegistration: async () => (await stateService.getState()).registration,
    });
    const app = createApp(stateService, storage, service);

    const response = await app.request("/commands/unregister", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect((await response.json() as { displayName?: string }).displayName)
      .toBe("Route Habitat");
    const state = await stateService.getState();
    expect(state.registration).toBeUndefined();
    expect(state.inventory.water).toBe(4);
    expect(await storage.getRegistrationToken("habitat_route")).toBeUndefined();
    expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);
  });

  test("generic state replacement cannot redirect a saved registration stream", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    await storage.saveRegistration(normalizeState({
      inventory: { water: 4 },
      registration: {
        displayName: "Route Habitat",
        registeredAt: ISSUED_AT,
        lastSyncedAt: ISSUED_AT,
        habitatId: "habitat_route",
        streamUrl: "wss://planet.turingguild.com/planet/stream",
        stream: {
          protocolVersion: "2026-06-24",
          subscriptions: ["ticks"],
          currentTick: 800,
          tickIntervalMs: 1_000,
          ticksPerPulse: 10,
          status: "running",
        },
      },
    }), STREAM_TOKEN);
    const { service } = createManualClock();
    const app = createApp(stateService, storage, service);
    const snapshot = await getStateSnapshot(app);
    const malicious = normalizeState({
      inventory: { water: 99 },
      registration: {
        ...snapshot.body.registration,
        streamUrl: "wss://attacker.example/collect",
      },
    });

    const response = await app.request("/state", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": snapshot.etag,
      },
      body: JSON.stringify(malicious),
    });

    expect(response.status).toBe(200);
    const state = await stateService.getState();
    expect(state.inventory.water).toBe(99);
    expect(state.registration?.habitatId).toBe("habitat_route");
    expect(state.registration?.streamUrl).toBe("wss://planet.turingguild.com/planet/stream");
  });

  test("requires a client-bound If-Match value for generic state replacement", async () => {
    const stateService = createStateService({ storagePath: path });
    const { service, storage } = createManualClock();
    const app = createApp(stateService, storage, service);

    const response = await app.request("/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(normalizeState({ inventory: { water: 99 } })),
    });

    expect(response.status).toBe(428);
    expect((await stateService.getState()).inventory.water).toBeUndefined();
  });

  test("rejects a stale state ETag after a tick without erasing the tick", async () => {
    const stateService = createStateService({ storagePath: path });
    await stateService.saveState(normalizeState({
      inventory: { water: 4 },
      power: { powerConsumedTicks: 0 },
    }));
    const { service, storage } = createManualClock();
    const app = createApp(stateService, storage, service);
    const stale = await getStateSnapshot(app);

    await storage.applyManualTick((state) => {
      state.power.powerConsumedTicks += 10;
      return { data: state };
    });
    stale.body.inventory.water = 99;

    const response = await app.request("/state", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": stale.etag,
      },
      body: JSON.stringify(stale.body),
    });

    expect(response.status).toBe(412);
    const persisted = await stateService.getState();
    expect(persisted.inventory.water).toBe(4);
    expect(persisted.power.powerConsumedTicks).toBe(10);
  });

  test("whole-state reset also removes isolated registration secrets", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    await storage.saveRegistration(normalizeState({
      registration: {
        displayName: "Route Habitat",
        registeredAt: ISSUED_AT,
        lastSyncedAt: ISSUED_AT,
        habitatId: "habitat_route",
      },
    }), STREAM_TOKEN);
    const { service } = createManualClock();
    const app = createApp(stateService, storage, service);

    const response = await app.request("/state", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect((await stateService.getState()).registration).toBeUndefined();
    expect(await storage.getRegistrationToken("habitat_route")).toBeUndefined();
    expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);
  });

  test("reports status and controls persisted listener intent", async () => {
    const stateService = createStateService({ storagePath: path });
    const { service, storage } = createManualClock();
    const app = createApp(stateService, storage, service);

    expect(await app.request("/clock/status").then((response) => response.json())).toEqual(
      expect.objectContaining({
        mode: "manual",
        listeningEnabled: false,
        manualTicksAllowed: true,
      }),
    );

    const enabled = await app.request("/clock/listen/on", { method: "POST" });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual(expect.objectContaining({
      mode: "kepler",
      listeningEnabled: true,
      manualTicksAllowed: false,
    }));

    const disabled = await app.request("/clock/listen/off", { method: "POST" });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual(expect.objectContaining({
      mode: "manual",
      listeningEnabled: false,
      manualTicksAllowed: true,
    }));
  });

  test("blocks whole-state replacement and reset while the live clock owns simulation state", async () => {
    const stateService = createStateService({ storagePath: path });
    await stateService.saveState(normalizeState({ inventory: { water: 4 } }));
    const storage = createClockStorage(path);
    await storage.saveClockState({
      ...DEFAULT_CLOCK_STATE,
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "error",
    });
    const service = createClockService({
      storage,
      getRegistration: async () => undefined,
    });
    const app = createApp(stateService, storage, service);
    const snapshot = await getStateSnapshot(app);

    const replacement = await app.request("/state", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": snapshot.etag,
      },
      body: JSON.stringify(normalizeState({ inventory: { water: 99 } })),
    });
    const reset = await app.request("/state", { method: "DELETE" });

    expect(replacement.status).toBe(409);
    expect(reset.status).toBe(409);
    expect((await stateService.getState()).inventory.water).toBe(4);
  });

  test("checks persisted listener intent inside the reset transaction", async () => {
    const stateService = createStateService({ storagePath: path });
    await stateService.saveState(normalizeState({ inventory: { water: 4 } }));
    const storage = createClockStorage(path);
    await storage.saveClockState({
      ...DEFAULT_CLOCK_STATE,
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "error",
    });
    const actualService = createClockService({
      storage,
      getRegistration: async () => undefined,
    });
    const lyingPreflightService = {
      ...actualService,
      async getStatus() {
        return {
          ...DEFAULT_CLOCK_STATE,
          manualTicksAllowed: true,
        };
      },
    };
    const app = createApp(stateService, storage, lyingPreflightService as never);

    const response = await app.request("/state", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect((await stateService.getState()).inventory.water).toBe(4);
  });

  test("reports optimistic state conflicts as retryable HTTP conflicts", async () => {
    const stateService = {
      async getState() { return normalizeState({ inventory: { water: 4 } }); },
      async saveState() { throw new HabitatStateConflictError(); },
      async resetState() { throw new HabitatStateConflictError(); },
    };
    const app = createApp(stateService as never, createClockStorage(path));

    const response = await app.request("/commands/inventory/set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceId: "water", amount: 9 }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      message: expect.stringContaining("reload"),
    }));
  });

  test("delegates manual ticks to the clock service", async () => {
    const stateService = createStateService({ storagePath: path });
    await stateService.saveState(normalizeState({
      modules: [{
        id: "consumer-1",
        name: "consumer-1",
        blueprintId: "workbench",
        displayName: "Workbench",
        connectedTo: [],
        runtimeAttributes: { state: "online", powerDraw: 3 },
        capabilities: [],
      }],
      power: { powerConsumedTicks: 2 },
    }));
    const { service, storage } = createManualClock();
    const app = createApp(stateService, storage, service);

    const response = await app.request("/commands/tick", tickRequest(10));

    expect(response.status).toBe(200);
    const result = await response.json() as { energyCost: number; data: { power: { powerConsumedTicks: number } } };
    expect(result.energyCost).toBe(30);
    expect(result.data.power.powerConsumedTicks).toBe(32);
  });

  test("returns 409 only for the clock service's listener rejection", async () => {
    const serviceModule = await import("../src/clock/service");
    const ManualTickUnavailableError = (
      serviceModule as typeof serviceModule & {
        ManualTickUnavailableError?: new (message?: string) => Error;
      }
    ).ManualTickUnavailableError;
    expect(typeof ManualTickUnavailableError).toBe("function");
    if (!ManualTickUnavailableError) return;
    const storage = createClockStorage(path);
    await storage.saveClockState({
      ...DEFAULT_CLOCK_STATE,
      mode: "kepler",
      listeningEnabled: true,
    });
    const service = createClockService({
      storage,
      getRegistration: async () => undefined,
      getIrradiance: async () => {
        throw new Error("irradiance must not be requested");
      },
    });
    expect(await service.manualTick(1).catch((error: unknown) => error))
      .toBeInstanceOf(ManualTickUnavailableError);
    const stateService = {
      storagePath: path,
      async getState() { throw new Error("legacy manual tick path was used"); },
      async saveState() { throw new Error("legacy manual tick path was used"); },
      async resetState() { throw new Error("legacy manual tick path was used"); },
    };
    const app = createApp(stateService as never, storage, service);

    const response = await app.request("/commands/tick", tickRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      message: expect.stringContaining("habitat clock listen off"),
    }));
  });

  test("does not turn unrelated manual simulation failures into conflicts", async () => {
    const stateService = createStateService({ storagePath: path });
    const { service, storage } = createManualClock({
      getIrradiance: async () => {
        throw new Error("solar lookup failed");
      },
    });
    const app = createApp(stateService, storage, service);

    const response = await app.request("/commands/tick", tickRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(expect.objectContaining({
      message: "solar lookup failed",
    }));
  });

  test("rejects invalid manual tick counts with 400 before delegation", async () => {
    let irradianceCalls = 0;
    const stateService = createStateService({ storagePath: path });
    const { service, storage } = createManualClock({
      getIrradiance: async () => {
        irradianceCalls += 1;
        return 900;
      },
    });
    const app = createApp(stateService, storage, service);

    const response = await app.request("/commands/tick", tickRequest(0));

    expect(response.status).toBe(400);
    expect(irradianceCalls).toBe(0);
  });

  test("rejects null, array, and primitive tick bodies with 400", async () => {
    let irradianceCalls = 0;
    const stateService = createStateService({ storagePath: path });
    const { service, storage } = createManualClock({
      getIrradiance: async () => {
        irradianceCalls += 1;
        return 900;
      },
    });
    const app = createApp(stateService, storage, service);

    for (const body of [null, [], 1, "one", true]) {
      const response = await app.request("/commands/tick", tickBodyRequest(body));
      expect(response.status).toBe(400);
    }
    expect(irradianceCalls).toBe(0);
  });
});

describe("clock SSE", () => {
  test("streams only future public events without credential fields", async () => {
    const { ClockEventHub } = await import("../src/clock/events");
    const events = new ClockEventHub();
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    const service = createClockService({
      storage,
      getRegistration: async () => undefined,
      onPublicEvent: (event) => events.publish(event),
    });
    const app = createApp(stateService, storage, service, events);

    events.publish({
      type: "planet_tick",
      tick: 100,
      advancedBy: 10,
      issuedAt: ISSUED_AT,
      applied: true,
    });
    const response = await app.request("/clock/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const futureEvent: ClockEvent & { apiToken: string } = {
      type: "planet_tick",
      tick: 200,
      advancedBy: 100,
      issuedAt: ISSUED_AT,
      applied: false,
      apiToken: STREAM_TOKEN,
    };
    events.publish(futureEvent);
    const chunk = await reader!.read();
    const text = new TextDecoder().decode(chunk.value);
    await reader!.cancel();

    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"));
    expect(dataLines).toHaveLength(1);
    expect(JSON.parse(dataLines[0]!.slice("data:".length).trim())).toEqual({
      type: "planet_tick",
      tick: 200,
      advancedBy: 100,
      issuedAt: ISSUED_AT,
      applied: false,
    });
    expect(text).not.toContain("apiToken");
    expect(text).not.toContain(STREAM_TOKEN);
    expect(text).not.toContain('"tick":100');
  });

  test("abort and cancel unsubscribe safely", async () => {
    const { ClockEventHub } = await import("../src/clock/events");
    const events = new ClockEventHub();
    const abortController = new AbortController();
    const abortedReader = events.createResponse(abortController.signal).body!.getReader();

    abortController.abort();
    expect(await abortedReader.read()).toEqual({ done: true, value: undefined });

    const cancelledReader = events.createResponse().body!.getReader();
    await cancelledReader.cancel();
    expect(() => events.publish({
      type: "planet_tick",
      tick: 300,
      advancedBy: 1,
      issuedAt: ISSUED_AT,
      applied: true,
    })).not.toThrow();
  });

  test("disconnects a stalled subscriber before its queue can grow", async () => {
    const { ClockEventHub } = await import("../src/clock/events");
    const events = new ClockEventHub();
    const reader = events.createResponse().body!.getReader();

    events.publish({
      type: "planet_tick",
      tick: 400,
      advancedBy: 10,
      issuedAt: ISSUED_AT,
      applied: true,
    });
    events.publish({
      type: "planet_tick",
      tick: 500,
      advancedBy: 10,
      issuedAt: ISSUED_AT,
      applied: true,
    });

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"tick":400');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(() => events.publish({
      type: "planet_tick",
      tick: 600,
      advancedBy: 10,
      issuedAt: ISSUED_AT,
      applied: true,
    })).not.toThrow();
  });
});
