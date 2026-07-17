import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClockStorage } from "../src/clock/storage";
import { DEFAULT_CLOCK_STATE } from "../src/clock/types";
import { createApp } from "../src/server";
import { createStateService, normalizeState } from "../src/state/service";

const EXISTING_HABITAT_ID = "habitat_be05aee4_fe6e_4620_a16a_f100b260685b";
const EXISTING_HABITAT_UUID = "be05aee4-fe6e-4620-a16a-f100b260685b";
const REGISTRATION_BEARER = "fixture-course-registration-bearer";
const STREAM_TOKEN = "fixture-isolated-stream-token";

let temp: string;
let path: string;
let originalFetch: typeof globalThis.fetch;
let originalToken: string | undefined;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "habitat-clock-registration-"));
  path = join(temp, "habitat.sqlite");
  originalFetch = globalThis.fetch;
  originalToken = process.env.KEPLER_PLANET_TOKEN;
  process.env.KEPLER_PLANET_TOKEN = REGISTRATION_BEARER;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.KEPLER_PLANET_TOKEN;
  else process.env.KEPLER_PLANET_TOKEN = originalToken;
  await rm(temp, { recursive: true, force: true });
});

function liveRegistrationResponse() {
  return {
    habitatId: EXISTING_HABITAT_ID,
    streamUrl: "wss://planet.turingguild.com/planet/stream",
    apiToken: STREAM_TOKEN,
    stream: {
      protocolVersion: "1.0",
      subscriptions: ["ticks"],
      currentTick: 800,
      tickIntervalMs: 1000,
      ticksPerPulse: 10,
      status: "paused",
    },
    starterModules: [{
      id: "remote-core",
      blueprintId: "remote-blueprint",
      displayName: "Remote Core",
      connectedTo: [],
      runtimeAttributes: { state: "offline" },
      capabilities: [],
    }],
    starterHumans: [{
      id: "remote-human",
      displayName: "Remote Human",
      locationModuleId: "remote-core",
    }],
    contracts: {
      alerts: { schemaVersion: "1.0", schema: { type: "object" } },
    },
    blueprints: [{
      id: "remote-blueprint",
      name: "Remote Blueprint",
      inputs: { regolith: 2 },
    }],
  };
}

function stubRegistration(response = liveRegistrationResponse()) {
  const requests: Array<{ body: unknown; authorization: string | null }> = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push({
      body: JSON.parse(String(init?.body)),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify(response), { status: 200 });
  }) as typeof fetch;
  return requests;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function legacyState() {
  return normalizeState({
    zones: [{ name: "science", purpose: "research", status: "online" }],
    airlocks: [{ name: "main", pressureLevel: 1, locked: true }],
    doors: [{ name: "inner", airlockName: "main" }],
    modules: [{
      id: "local-core",
      name: "local-core",
      blueprintId: "local-blueprint",
      displayName: "Local Core",
      connectedTo: [],
      runtimeAttributes: { state: "online" },
      capabilities: ["local-only"],
    }],
    blueprints: [{ blueprintId: "local-blueprint", displayName: "Local Blueprint" }],
    inventory: { water: 19 },
    constructionJobs: [{
      id: "job-1",
      moduleName: "greenhouse",
      blueprintId: "local-blueprint",
      facilityModuleId: "local-core",
      facilityModuleName: "Local Core",
      totalBuildTicks: 20,
      remainingBuildTicks: 7,
      consumedMaterials: { regolith: 3 },
      runtimeAttributes: {},
      capabilities: [],
    }],
    power: { powerConsumedTicks: 23 },
    humans: [{ id: "local-human", name: "Local Human", moduleId: "local-core" }],
    eva: {
      deployed: true,
      humanId: "local-human",
      x: 4,
      y: -2,
      carriedResources: { ice: 2 },
      maxCarryingCapacityKg: 30,
    },
    alerts: [{ id: "alert-1", status: "open", message: "Local alert" }],
    registration: {
      displayName: "Legacy Habitat",
      registeredAt: "2026-06-24T00:00:00.000Z",
      lastSyncedAt: "2026-06-24T00:00:00.000Z",
      habitatId: EXISTING_HABITAT_ID,
    },
  });
}

async function postRegistration(
  app: ReturnType<typeof createApp>,
  name = "Replacement Name",
) {
  return app.request("/commands/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

describe("clock registration", () => {
  test("one-argument file-backed app stores registration in the state service database", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    stubRegistration();
    const app = createApp(stateService);
    const previousCwd = process.cwd();
    let response: Response;

    try {
      process.chdir(temp);
      response = await postRegistration(app, "New Habitat");
    } finally {
      process.chdir(previousCwd);
    }

    expect(response.status).toBe(200);
    expect((await stateService.getState()).registration?.habitatId)
      .toBe(EXISTING_HABITAT_ID);
    expect(await storage.getRegistrationToken(EXISTING_HABITAT_ID)).toBe(STREAM_TOKEN);
    expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);
  });

  test("app without a state storage path requires explicit registration storage", async () => {
    let state = normalizeState({});
    const stateService = {
      async getState() { return structuredClone(state); },
      async saveState(next: typeof state) {
        state = normalizeState(next);
        return structuredClone(state);
      },
      async resetState() {
        state = normalizeState({});
        return structuredClone(state);
      },
    };
    const requests = stubRegistration();
    const app = createApp(stateService as never);
    const fallbackPath = join(temp, ".habitat", "habitat.sqlite");
    const previousCwd = process.cwd();
    let response: Response;

    try {
      process.chdir(temp);
      response = await postRegistration(app, "New Habitat");
    } finally {
      process.chdir(previousCwd);
    }

    expect(await Bun.file(fallbackPath).exists()).toBe(false);
    expect(response.status).toBe(500);
    expect((await response.json()).message).toContain("registration storage");
    expect(requests).toHaveLength(0);
    expect(state.registration).toBeUndefined();
  });

  test("upgrades a pre-stream habitat in place without replacing live simulation state", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    const before = legacyState();
    await stateService.saveState(before);
    const requests = stubRegistration();
    const app = createApp(stateService, storage);

    const response = await postRegistration(app);

    expect(response.status).toBe(200);
    expect(requests).toEqual([{
      body: {
        displayName: "Legacy Habitat",
        habitatUuid: EXISTING_HABITAT_UUID,
      },
      authorization: `Bearer ${REGISTRATION_BEARER}`,
    }]);

    const state = await stateService.getState();
    expect(state.registration).toEqual(expect.objectContaining({
      displayName: "Legacy Habitat",
      registeredAt: "2026-06-24T00:00:00.000Z",
      habitatId: EXISTING_HABITAT_ID,
      habitatUuid: EXISTING_HABITAT_UUID,
      streamUrl: "wss://planet.turingguild.com/planet/stream",
      stream: expect.objectContaining({ subscriptions: ["ticks"], currentTick: 800 }),
      starterModules: liveRegistrationResponse().starterModules,
      starterHumans: liveRegistrationResponse().starterHumans,
      contracts: liveRegistrationResponse().contracts,
    }));
    expect({ ...state, registration: undefined }).toEqual({
      ...before,
      registration: undefined,
    });
    expect(await storage.getRegistrationToken(EXISTING_HABITAT_ID)).toBe(STREAM_TOKEN);
    expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);
    expect(JSON.stringify(state)).not.toContain(STREAM_TOKEN);
    expect(await response.json()).not.toHaveProperty("apiToken");
  });

  test("rejects an upgrade response for a different Habitat id without mutating state", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    const before = legacyState();
    await stateService.saveState(before);
    stubRegistration({
      ...liveRegistrationResponse(),
      habitatId: "habitat_11111111_2222_4333_8444_555555555555",
    });

    const response = await postRegistration(createApp(stateService, storage));

    expect(response.status).toBe(500);
    expect((await response.json()).message).toContain("different Habitat id");
    expect(await stateService.getState()).toEqual(before);
    expect(await storage.getRegistrationToken(EXISTING_HABITAT_ID)).toBeUndefined();
  });

  for (const streamUrl of [
    "wss://attacker.example/collect",
    `wss://planet.turingguild.com/planet/stream?token=${encodeURIComponent(STREAM_TOKEN)}`,
  ]) {
    test(`rejects unsafe registration stream URL before persisting it (${new URL(streamUrl).hostname})`, async () => {
      const stateService = createStateService({ storagePath: path });
      const storage = createClockStorage(path);
      const before = legacyState();
      await stateService.saveState(before);
      stubRegistration({ ...liveRegistrationResponse(), streamUrl });

      const response = await postRegistration(createApp(stateService, storage));

      expect(response.status).toBe(500);
      expect(await stateService.getState()).toEqual(before);
      expect(await storage.getRegistrationToken(EXISTING_HABITAT_ID)).toBeUndefined();
      expect(JSON.stringify(await stateService.getState())).not.toContain(STREAM_TOKEN);
    });
  }

  test("persists a one-time registration token after merging a concurrent state mutation", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    await stateService.saveState(legacyState());
    const fetchStarted = deferred<void>();
    const fetchResponse = deferred<Response>();
    globalThis.fetch = (async () => {
      fetchStarted.resolve();
      return fetchResponse.promise;
    }) as typeof fetch;
    const app = createApp(stateService, storage);

    const registering = postRegistration(app);
    await fetchStarted.promise;
    const concurrent = await stateService.getState();
    concurrent.inventory.water = 77;
    await stateService.saveState(concurrent);
    fetchResponse.resolve(new Response(JSON.stringify(liveRegistrationResponse()), { status: 200 }));
    const response = await registering;

    expect(response.status).toBe(200);
    expect((await stateService.getState()).inventory.water).toBe(77);
    expect((await stateService.getState()).registration?.habitatId).toBe(EXISTING_HABITAT_ID);
    expect(await storage.getRegistrationToken(EXISTING_HABITAT_ID)).toBe(STREAM_TOKEN);
  });

  test("serializes concurrent registration requests before issuing a remote side effect", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    await stateService.saveState(legacyState());
    const fetchStarted = deferred<void>();
    const fetchResponse = deferred<Response>();
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      fetchStarted.resolve();
      return fetchResponse.promise;
    }) as typeof fetch;
    const app = createApp(stateService, storage);

    const first = postRegistration(app);
    const second = postRegistration(app);
    await fetchStarted.promise;
    await Promise.resolve();
    expect(fetchCalls).toBe(1);
    fetchResponse.resolve(new Response(JSON.stringify(liveRegistrationResponse()), { status: 200 }));

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(500);
    expect(fetchCalls).toBe(1);
  });

  test("serializes unregister behind one-time registration token persistence", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    await stateService.saveState(legacyState());
    const fetchStarted = deferred<void>();
    const fetchResponse = deferred<Response>();
    globalThis.fetch = (async () => {
      fetchStarted.resolve();
      return fetchResponse.promise;
    }) as typeof fetch;
    const app = createApp(stateService, storage);

    const registering = postRegistration(app);
    await fetchStarted.promise;
    const unregistering = app.request("/commands/unregister", { method: "DELETE" });
    let unregisterSettled = false;
    void unregistering.then(() => {
      unregisterSettled = true;
    });
    await Bun.sleep(5);
    expect(unregisterSettled).toBe(false);
    fetchResponse.resolve(new Response(JSON.stringify(liveRegistrationResponse()), { status: 200 }));

    expect((await registering).status).toBe(200);
    expect((await unregistering).status).toBe(200);
    expect((await stateService.getState()).registration).toBeUndefined();
    expect(await storage.getRegistrationToken(EXISTING_HABITAT_ID)).toBeUndefined();
  });

  test("treats a habitat as complete only when stream metadata and its isolated token both exist", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    const state = legacyState();
    state.registration = {
      ...state.registration!,
      habitatUuid: EXISTING_HABITAT_UUID,
      streamUrl: "wss://planet.turingguild.com/planet/stream",
      stream: liveRegistrationResponse().stream,
    };
    await storage.saveRegistration(state, STREAM_TOKEN);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(liveRegistrationResponse()), { status: 200 });
    }) as typeof fetch;

    const response = await postRegistration(createApp(stateService, storage));

    expect(response.status).toBe(500);
    expect((await response.json()).message).toContain("already registered");
    expect(calls).toBe(0);
    expect(await stateService.getState()).toEqual(state);
  });

  test("repairs stream metadata when the public registration has no isolated token", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    const state = legacyState();
    state.registration = {
      ...state.registration!,
      habitatUuid: EXISTING_HABITAT_UUID,
      streamUrl: "wss://stale.example.test/stream",
      stream: liveRegistrationResponse().stream,
    };
    await stateService.saveState(state);
    const requests = stubRegistration();

    const response = await postRegistration(createApp(stateService, storage));

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect((await stateService.getState()).registration?.streamUrl)
      .toBe("wss://planet.turingguild.com/planet/stream");
    expect(await storage.getRegistrationToken(EXISTING_HABITAT_ID)).toBe(STREAM_TOKEN);
  });

  test("repairs an isolated token when the public registration has no stream metadata", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    const state = legacyState();
    await storage.saveRegistration(state, "fixture-stale-stream-token");
    const requests = stubRegistration();

    const response = await postRegistration(createApp(stateService, storage));

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect((await stateService.getState()).registration?.streamUrl)
      .toBe("wss://planet.turingguild.com/planet/stream");
    expect(await storage.getRegistrationToken(EXISTING_HABITAT_ID)).toBe(STREAM_TOKEN);
  });
});
