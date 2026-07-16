import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server";
import { normalizeState } from "../src/state/service";

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
    apiToken: "never-store-this",
    stream: { protocolVersion: "1.0", subscriptions: ["ticks"], currentTick: 0, tickIntervalMs: 1000, ticksPerPulse: 1, status: "paused" },
    contracts: { alerts: { schemaVersion: "1.0", schema: { type: "object" } } },
    starterModules,
    starterHumans: [
      { id: "human-1", displayName: "Avery", locationModuleId: "module-1" },
      { id: "human-2", displayName: "Blake", locationModuleId: "module-2" },
    ],
    blueprints: [],
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
    const app = createApp(stateService as never);

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
      starterModules: expect.any(Array),
      starterHumans: expect.any(Array),
    }));
    expect(JSON.stringify(state)).not.toContain("never-store-this");
  });

  test("leaves state unchanged when registration persistence fails", async () => {
    const initial = normalizeState({ inventory: { water: 3 } });
    const stateService = {
      async getState() { return structuredClone(initial); },
      async saveState() { throw new Error("simulated SQLite failure"); },
      async resetState() { return structuredClone(initial); },
    };
    const app = createApp(stateService as never);

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
