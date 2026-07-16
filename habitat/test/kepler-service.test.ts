import { describe, expect, test } from "bun:test";
import {
  normalizeKeplerCatalog,
  normalizeKeplerHabitatRegistration,
} from "../src/kepler/service";

describe("kepler service", () => {
  test("normalizes blueprint catalog entries", () => {
    const catalog = normalizeKeplerCatalog([
      { id: "bp-1", name: "Starter", buildable: true } as never,
    ]);
    expect(catalog[0].id).toBe("bp-1");
    expect(catalog[0].name).toBe("Starter");
  });

  test("preserves typed starter crew, modules, and alert contracts from registration", () => {
    const registration = normalizeKeplerHabitatRegistration({
      id: "habitat-1",
      habitatSlug: "habitat-one",
      displayName: "Habitat One",
      catalogVersion: "2026-06-24",
      status: "online",
      starterHumans: [
        {
          id: "human-1",
          displayName: "Avery",
          locationModuleId: "module-core",
        },
      ],
      starterModules: [
        {
          id: "module-core",
          blueprintId: "habitat-core",
          displayName: "Habitat Core",
          connectedTo: [],
          runtimeAttributes: { crewCapacity: 2 },
          capabilities: ["basic-suitport"],
        },
      ],
      contracts: {
        alerts: {
          schemaVersion: "1.0",
          schema: { type: "object" },
        },
      },
    } as never);

    expect(registration.starterHumans).toEqual([
      { id: "human-1", displayName: "Avery", locationModuleId: "module-core" },
    ]);
    expect((registration as Record<string, unknown>).starterModules).toEqual([
      expect.objectContaining({ id: "module-core", capabilities: ["basic-suitport"] }),
    ]);
    expect((registration as Record<string, unknown>).contracts).toEqual({
      alerts: { schemaVersion: "1.0", schema: { type: "object" } },
    });
  });
});
