import { describe, expect, test } from "bun:test";
import type { RegistrationStorage } from "../src/registration/service";
import { createApp } from "../src/server";
import { normalizeState } from "../src/state/service";
import type { HabitatState } from "../src/state/types";

const STREAM_TOKEN = "fixture-habitat-stream-token";

function createMemoryStateService(initial: unknown = {}) {
  let state = normalizeState(initial);
  return {
    async getState() {
      return structuredClone(state);
    },
    async saveState(next: unknown) {
      state = normalizeState(next);
      return structuredClone(state);
    },
    async resetState() {
      state = normalizeState({});
      return structuredClone(state);
    },
  };
}

function createMemoryRegistrationStorage(
  stateService: ReturnType<typeof createMemoryStateService>,
): RegistrationStorage {
  const tokens = new Map<string, string>();
  return {
    async deleteRegistration() {
      const next = await stateService.getState();
      delete next.registration;
      tokens.clear();
      return stateService.saveState(next);
    },
    async getRegistrationToken(habitatId) {
      return tokens.get(habitatId);
    },
    async saveRegistration(next, streamToken) {
      const saved = await stateService.saveState(next);
      tokens.set(saved.registration!.habitatId!, streamToken);
      return saved;
    },
  };
}

function registrationResponse() {
  const starterModules = Array.from({ length: 6 }, (_, index) => ({
    id: `module-${index + 1}`,
    blueprintId: `blueprint-${index + 1}`,
    displayName: `Module ${index + 1}`,
    connectedTo: [],
    runtimeAttributes: {},
    capabilities: index === 0 ? ["basic-suitport"] : [],
  }));
  return {
    habitatId: "habitat-1",
    streamUrl: "wss://planet.turingguild.com/planet/stream",
    apiToken: STREAM_TOKEN,
    stream: { protocolVersion: "1.0", subscriptions: ["ticks"], currentTick: 800, tickIntervalMs: 1000, ticksPerPulse: 10, status: "paused" },
    contracts: { alerts: { schemaVersion: "1.0", schema: { type: "object" } } },
    starterModules,
    starterHumans: [
      { id: "human-1", displayName: "Avery", locationModuleId: "module-1" },
      { id: "human-2", displayName: "Blake", locationModuleId: "module-2" },
    ],
    blueprints: [
      { id: "blueprint-1", name: "Starter Core", inputs: { regolith: 2 } },
    ],
  };
}

async function withKeplerRegistrationResponse(run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.KEPLER_PLANET_TOKEN;
  let calls = 0;
  process.env.KEPLER_PLANET_TOKEN = "test-token";
  globalThis.fetch = (async (input, init) => {
    calls += 1;
    expect(String(input)).toBe("https://planet.turingguild.com/habitats/register");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: "Habitat One", habitatUuid: expect.any(String) });
    return new Response(JSON.stringify(registrationResponse()), { status: 200 });
  }) as typeof fetch;

  try {
    await run();
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.KEPLER_PLANET_TOKEN;
    else process.env.KEPLER_PLANET_TOKEN = originalToken;
  }
}

describe("registration hydration", () => {
  test("persists all starter modules and humans from one Kepler registration", async () => {
    const stateService = createMemoryStateService();
    const registrationStorage = createMemoryRegistrationStorage(stateService);
    const app = createApp(stateService as never, registrationStorage);

    await withKeplerRegistrationResponse(async () => {
      const response = await app.request("/commands/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Habitat One" }),
      });
      expect(response.status).toBe(200);
    });

    const state = await stateService.getState();
    expect(state.modules).toHaveLength(6);
    expect(state.humans).toEqual([
      expect.objectContaining({ id: "human-1", name: "Avery", moduleId: "module-1" }),
      expect.objectContaining({ id: "human-2", name: "Blake", moduleId: "module-2" }),
    ]);
    expect(state.registration).toEqual(expect.objectContaining({
      displayName: "Habitat One",
      habitatId: "habitat-1",
      habitatUuid: expect.any(String),
      streamUrl: "wss://planet.turingguild.com/planet/stream",
      stream: expect.objectContaining({ subscriptions: ["ticks"], currentTick: 800 }),
      starterModules: expect.any(Array),
      starterHumans: expect.any(Array),
    }));
    expect(state.blueprints).toEqual([
      expect.objectContaining({ blueprintId: "blueprint-1", displayName: "Starter Core" }),
    ]);
    expect(await registrationStorage.getRegistrationToken("habitat-1")).toBe(STREAM_TOKEN);
    expect(JSON.stringify(state)).not.toContain(STREAM_TOKEN);
  });

  test("leaves state unchanged when registration persistence fails", async () => {
    const initial = normalizeState({ inventory: { water: 3 } });
    const stateService = {
      async getState() { return structuredClone(initial); },
      async saveState() { throw new Error("simulated SQLite failure"); },
      async resetState() { return structuredClone(initial); },
    };
    const registrationStorage: RegistrationStorage = {
      async deleteRegistration() { return stateService.getState(); },
      async getRegistrationToken() { return undefined; },
      async saveRegistration(next) {
        return stateService.saveState(next as HabitatState);
      },
    };
    const app = createApp(stateService as never, registrationStorage);

    await withKeplerRegistrationResponse(async () => {
      const response = await app.request("/commands/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Habitat One" }),
      });
      expect(response.status).toBe(500);
    });

    expect(await stateService.getState()).toEqual(initial);
  });
});
