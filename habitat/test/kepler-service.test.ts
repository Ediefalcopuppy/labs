import { afterEach, describe, expect, test } from "bun:test";
import * as keplerService from "../src/kepler/service";
import {
  normalizeKeplerCatalog,
  normalizeKeplerHabitatRegistration,
  registerKeplerHabitat,
} from "../src/kepler/service";

const originalFetch = globalThis.fetch;
const originalToken = process.env.KEPLER_PLANET_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.KEPLER_PLANET_TOKEN;
  else process.env.KEPLER_PLANET_TOKEN = originalToken;
});

describe("kepler service", () => {
  test("recovers only the current underscore-delimited habitat UUID format", () => {
    const recoverHabitatUuid = (
      keplerService as typeof keplerService & {
        recoverHabitatUuid?: (habitatId: string) => string | undefined;
      }
    ).recoverHabitatUuid;

    expect(recoverHabitatUuid?.("habitat_BE05AEE4_FE6E_4620_A16A_F100B260685B"))
      .toBe("be05aee4-fe6e-4620-a16a-f100b260685b");
    expect(recoverHabitatUuid?.("habitat-be05aee4-fe6e-4620-a16a-f100b260685b"))
      .toBeUndefined();
    expect(recoverHabitatUuid?.("prefix_be05aee4_fe6e_4620_a16a_f100b260685b"))
      .toBeUndefined();
    expect(recoverHabitatUuid?.("habitat_be05aee4_fe6e_4620_a16a_f100b260685"))
      .toBeUndefined();
  });

  test("rejects a registration response without the complete live stream contract", async () => {
    process.env.KEPLER_PLANET_TOKEN = "fixture-registration-bearer";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      habitatId: "habitat_1",
      starterModules: [],
      starterHumans: [],
      contracts: { alerts: { schemaVersion: "1.0", schema: {} } },
      blueprints: [],
    }), { status: 200 })) as typeof fetch;

    await expect(registerKeplerHabitat({
      displayName: "Habitat One",
      habitatUuid: "be05aee4-fe6e-4620-a16a-f100b260685b",
    })).rejects.toThrow("stream");
  });

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
