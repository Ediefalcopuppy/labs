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
    expect(state.eva).toEqual({ deployed: true, x: 2, y: 3, carriedResources: { water: 2 } });
    expect(state.alerts).toEqual([{ id: "alert-1", status: "open" }]);
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
