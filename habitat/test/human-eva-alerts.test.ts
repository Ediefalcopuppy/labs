import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server";
import { normalizeState } from "../src/state/service";

function createStateService(initial: unknown) {
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
      state = normalizeState(null);
      return structuredClone(state);
    },
  };
}

describe("human, EVA, and alert commands", () => {
  test("lists persisted humans through the canonical endpoint without duplicates", async () => {
    const service = createStateService({
      humans: [{ id: "human-1", name: "Mark", moduleId: "command-module" }],
    });
    const app = createApp(service as never);

    const first = await app.request("/humans");
    const second = await app.request("/humans");

    expect(await first.json()).toEqual([{ id: "human-1", name: "Mark", moduleId: "command-module" }]);
    expect(await second.json()).toEqual([{ id: "human-1", name: "Mark", moduleId: "command-module" }]);
    expect((await service.getState()).humans).toHaveLength(1);
  });

  test("rejects moving into a full module without changing the human location", async () => {
    const service = createStateService({
      humans: [{ id: "human-1", moduleId: "module-a" }, { id: "human-2", moduleId: "module-b" }],
      modules: [
        { id: "module-a", name: "module-a", blueprintId: "a", displayName: "A", connectedTo: [], runtimeAttributes: { crewCapacity: 1 }, capabilities: [] },
        { id: "module-b", name: "module-b", blueprintId: "b", displayName: "B", connectedTo: [], runtimeAttributes: { crewCapacity: 1 }, capabilities: [] },
      ],
    });
    const app = createApp(service as never);
    const response = await app.request("/commands/human/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ humanId: "human-1", moduleId: "module-b" }) });
    expect(response.status).toBe(500);
    expect((await response.json()).message).toContain("full");
    expect((await service.getState()).humans[0]?.moduleId).toBe("module-a");
  });

  test("moves a human by module name and stores the canonical module id", async () => {
    const service = createStateService({
      humans: [{ id: "human-1", moduleId: "module-a" }],
      modules: [
        { id: "module-a", name: "module-a", blueprintId: "a", displayName: "A", connectedTo: [], runtimeAttributes: { crewCapacity: 1 }, capabilities: [] },
        { id: "module-b", name: "suitport", blueprintId: "b", displayName: "Basic Suitport", connectedTo: [], runtimeAttributes: { crewCapacity: 1 }, capabilities: [] },
      ],
    });
    const response = await createApp(service as never).request("/commands/human/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ humanId: "human-1", moduleId: "suitport" }) });
    expect(response.status).toBe(200);
    expect((await service.getState()).humans[0]?.moduleId).toBe("module-b");
  });

  test("rejects deletion of an occupied module", async () => {
    const service = createStateService({
      humans: [{ id: "human-1", moduleId: "module-a" }],
      modules: [{ id: "module-a", name: "module-a", blueprintId: "a", displayName: "A", connectedTo: [], runtimeAttributes: { crewCapacity: 1 }, capabilities: [] }],
    });
    const app = createApp(service as never);
    const response = await app.request("/commands/module/module-a", { method: "DELETE" });
    expect(response.status).toBe(500);
    expect((await response.json()).message).toContain("occupied");
    expect((await service.getState()).modules).toHaveLength(1);
  });

  test("normalizes missing human, EVA, alert, and registration values", () => {
    const state = normalizeState({
      registration: {
        displayName: "Habitat",
        starterHumans: [{ id: "human-1" }],
        contacts: { alerts: true },
      },
      humans: [{ id: "human-1", x: 1 }],
      eva: { deployed: true, x: 2, y: 3, carriedResources: { water: 2 } },
      alerts: [{ id: "alert-1", status: "open" }],
    });

    expect(state.registration?.registeredAt).toBe("1970-01-01T00:00:00.000Z");
    expect(state.registration?.lastSyncedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(state.registration?.starterHumans).toEqual([{ id: "human-1" }]);
    expect(state.registration?.contacts).toEqual({ alerts: true });
    expect(state.eva).toEqual({ deployed: true, humanId: undefined, x: 2, y: 3, carriedResources: { water: 2 }, maxCarryingCapacityKg: 20 });
    expect(state.alerts).toEqual([{ id: "alert-1", status: "open" }]);
  });

  test("retains registration modules and alert contracts", () => {
    const state = normalizeState({
      registration: {
        displayName: "Habitat",
        starterModules: [{
          id: "module-core",
          blueprintId: "habitat-core",
          displayName: "Habitat Core",
          connectedTo: [],
          runtimeAttributes: {},
          capabilities: ["basic-suitport"],
        }],
        contracts: { alerts: { schemaVersion: "1.0", schema: { type: "object" } } },
      },
    });

    expect((state.registration as Record<string, unknown>).starterModules).toEqual([
      expect.objectContaining({ id: "module-core", capabilities: ["basic-suitport"] }),
    ]);
    expect((state.registration as Record<string, unknown>).contracts).toEqual({
      alerts: { schemaVersion: "1.0", schema: { type: "object" } },
    });
  });

  test("rejects non-adjacent EVA movement", async () => {
    const service = createStateService({ eva: { deployed: true, x: 0, y: 0, carriedResources: {} } });
    const app = createApp(service as never);
    const response = await app.request("/commands/eva/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 2, y: 0 }),
    });

    expect(response.status).toBe(500);
    expect((await response.json()).message).toContain("adjacent grid tile");
  });

  test("rejects zero and negative collection quantities", async () => {
    const service = createStateService({ eva: { deployed: true, x: 0, y: 0, carriedResources: {} } });
    const app = createApp(service as never);

    for (const quantityKg of [0, -1]) {
      const response = await app.request("/commands/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quantityKg }),
      });
      expect(response.status).toBe(500);
      expect((await response.json()).message).toContain("greater than zero");
    }
  });

  test("acknowledges an existing alert and persists the status", async () => {
    const service = createStateService({ alerts: [{ id: "alert-1", status: "open", message: "Check seal" }] });
    const app = createApp(service as never);
    const response = await app.request("/commands/alert/alert-1/acknowledge", { method: "POST" });

    expect(response.status).toBe(200);
    const state = await service.getState();
    expect(state.alerts[0]?.status).toBe("acknowledged");
  });

  test("debug add human persists a human on the backend", async () => {
    const service = createStateService();
    const app = createApp(service as never);
    const response = await app.request("/commands/debug/human", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "human-debug-1", name: "Debug Human", moduleId: "habitat-core", x: 1, y: -2 }),
    });

    expect(response.status).toBe(200);
    const state = await service.getState();
    expect(state.humans).toContainEqual({ id: "human-debug-1", name: "Debug Human", moduleId: "habitat-core", x: 1, y: -2, status: "available" });
  });

  test("resource scan uses the deployed EVA position when coordinates are omitted", async () => {
    const service = createStateService({
      registration: { displayName: "Habitat", habitatId: "habitat-1" },
      eva: { deployed: true, humanId: "human-1", x: 3, y: -2, carriedResources: {} },
    });
    const app = createApp(service as never);
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.KEPLER_PLANET_TOKEN;
    process.env.KEPLER_PLANET_TOKEN = "test-token";
    globalThis.fetch = (async (input) => {
      expect(String(input)).toContain("/world/scan?");
      expect(String(input)).toContain("habitatId=habitat-1");
      expect(String(input)).toContain("x=3");
      expect(String(input)).toContain("y=-2");
      return new Response(JSON.stringify({ tiles: [] }), { status: 200 });
    }) as typeof fetch;

    try {
      const response = await app.request("/commands/resource/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sensorStrength: 60, radius: 1 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tiles: [] });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.KEPLER_PLANET_TOKEN;
      else process.env.KEPLER_PLANET_TOKEN = originalToken;
    }
  });

  test("resource scan explains when saved EVA position is unavailable", async () => {
    const service = createStateService({ registration: { displayName: "Habitat", habitatId: "habitat-1" } });
    const app = createApp(service as never);
    const response = await app.request("/commands/resource/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sensorStrength: 60, radius: 1 }),
    });

    expect(response.status).toBe(500);
    expect((await response.json()).message).toContain("EVA must be deployed");
  });
});
