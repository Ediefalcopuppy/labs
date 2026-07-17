import { describe, expect, test } from "bun:test";
import { runConstructCommand, runTickCommand } from "../src/domain/commands";
import { canSpendInventory } from "../src/domain/inventory";
import { advanceSimulation } from "../src/domain/simulation";

function createStateService(state: unknown) {
  let currentState = structuredClone(state);
  return {
    async getState() {
      return structuredClone(currentState);
    },
    async saveState(nextState: unknown) {
      currentState = structuredClone(nextState);
      return structuredClone(currentState);
    },
    async resetState() {
      currentState = {};
      return {};
    },
  };
}

describe("inventory rules", () => {
  test("detects when materials are available", () => {
    expect(canSpendInventory({ steel: 2 }, { steel: 1 })).toBe(true);
    expect(canSpendInventory({ steel: 1 }, { steel: 2 })).toBe(false);
  });
});

describe("backend commands", () => {
  for (const count of [1, 10, 100]) {
    test(`shared simulation advancement matches the tick command for ${count} tick(s)`, async () => {
      const initialState = {
        modules: [
          {
            id: "consumer-1",
            name: "consumer-1",
            blueprintId: "workbench",
            displayName: "Workbench",
            connectedTo: [],
            runtimeAttributes: { state: "online", powerDraw: 3 },
            capabilities: [],
          },
          {
            id: "battery-1",
            name: "battery-1",
            blueprintId: "battery-bank",
            displayName: "Battery Bank",
            connectedTo: [],
            runtimeAttributes: {
              state: "online",
              isBattery: true,
              charge: 100,
              energyStorageKwh: 500,
            },
            capabilities: ["isBattery"],
          },
          {
            id: "solar-1",
            name: "solar-1",
            blueprintId: "small-solar-array",
            displayName: "Small Solar Array",
            connectedTo: [],
            runtimeAttributes: { state: "online", isCharger: true, powerGenerationKw: 9 },
            capabilities: ["isCharger"],
          },
          {
            id: "facility-1",
            name: "facility-1",
            blueprintId: "workshop-fabricator",
            displayName: "Workshop Fabricator",
            connectedTo: [],
            runtimeAttributes: { state: "online", moduleType: "workshop-fabricator" },
            capabilities: [],
          },
          {
            id: "supply-1",
            name: "supply-1",
            blueprintId: "supply-cache",
            displayName: "Supply Cache",
            connectedTo: [],
            runtimeAttributes: { state: "online" },
            capabilities: ["logistics"],
          },
        ],
        inventory: {},
        constructionJobs: [
          {
            id: "construction-1",
            moduleName: "greenhouse-1",
            blueprintId: "greenhouse",
            facilityModuleId: "facility-1",
            facilityModuleName: "Workshop Fabricator",
            totalBuildTicks: 100,
            remainingBuildTicks: 100,
            consumedMaterials: {},
            runtimeAttributes: {},
            capabilities: [],
          },
        ],
        power: { powerConsumedTicks: 0 },
        blueprints: [],
      };
      const stateService = createStateService(initialState);
      const directState = structuredClone(initialState);

      const commandResult = await runTickCommand({
        stateService: stateService as never,
        count,
        getIrradiance: async () => 900,
      });
      const directResult = advanceSimulation(directState as never, count, 900);

      expect(commandResult).toEqual(directResult);
      expect(await stateService.getState()).toEqual(directResult.data);
    });
  }

  test("tick restores module power, battery charging, solar charging, and construction advancement", async () => {
    const stateService = createStateService({
      modules: [
        {
          id: "consumer-1",
          name: "consumer-1",
          blueprintId: "workbench",
          displayName: "Workbench",
          connectedTo: [],
          runtimeAttributes: { state: "online", powerDraw: 3 },
          capabilities: [],
        },
        {
          id: "battery-1",
          name: "battery-1",
          blueprintId: "battery-bank",
          displayName: "Battery Bank",
          connectedTo: [],
          runtimeAttributes: { state: "online", isBattery: true, charge: 100, energyStorageKwh: 500 },
          capabilities: ["isBattery"],
        },
        {
          id: "solar-1",
          name: "solar-1",
          blueprintId: "small-solar-array",
          displayName: "Small Solar Array",
          connectedTo: [],
          runtimeAttributes: { state: "online", isCharger: true, powerGenerationKw: 9 },
          capabilities: ["isCharger"],
        },
        {
          id: "facility-1",
          name: "facility-1",
          blueprintId: "workshop-fabricator",
          displayName: "Workshop Fabricator",
          connectedTo: [],
          runtimeAttributes: { state: "online", moduleType: "workshop-fabricator" },
          capabilities: [],
        },
        {
          id: "supply-1",
          name: "supply-1",
          blueprintId: "supply-cache",
          displayName: "Supply Cache",
          connectedTo: [],
          runtimeAttributes: { state: "online" },
          capabilities: ["logistics"],
        },
      ],
      inventory: {},
      constructionJobs: [
        {
          id: "construction-1",
          moduleName: "greenhouse-1",
          blueprintId: "greenhouse",
          facilityModuleId: "facility-1",
          facilityModuleName: "Workshop Fabricator",
          totalBuildTicks: 1,
          remainingBuildTicks: 1,
          consumedMaterials: {},
          runtimeAttributes: {},
          capabilities: [],
        },
      ],
      power: { powerConsumedTicks: 0 },
      blueprints: [],
    });

    const result = await runTickCommand({
      stateService: stateService as never,
      count: 1,
      getIrradiance: async () => 900,
    });

    expect(result.energyCost).toBe(3);
    expect(result.advancedConstructionTicks).toBe(1);
    expect(result.pausedConstructionTicks).toBe(0);
    expect(result.completedJobs).toEqual(["greenhouse-1"]);
    expect(result.data.power.powerConsumedTicks).toBe(3);
    expect(result.data.modules.find((module: any) => module.id === "consumer-1")?.runtimeAttributes.powerConsumedTicks).toBe(3);
    expect(result.data.modules.find((module: any) => module.id === "battery-1")?.runtimeAttributes.charge).toBeGreaterThan(100);
  });

  test("construct allows multiple jobs for the same blueprint when facilities are available", async () => {
    const stateService = createStateService({
      modules: [
        {
          id: "facility-1",
          name: "facility-1",
          blueprintId: "workshop-fabricator",
          displayName: "Workshop Fabricator A",
          connectedTo: [],
          runtimeAttributes: { state: "online", moduleType: "workshop-fabricator" },
          capabilities: [],
        },
        {
          id: "facility-2",
          name: "facility-2",
          blueprintId: "workshop-fabricator",
          displayName: "Workshop Fabricator B",
          connectedTo: [],
          runtimeAttributes: { state: "online", moduleType: "workshop-fabricator" },
          capabilities: [],
        },
        {
          id: "supply-1",
          name: "supply-1",
          blueprintId: "supply-cache",
          displayName: "Supply Cache",
          connectedTo: [],
          runtimeAttributes: { state: "online" },
          capabilities: ["logistics"],
        },
        {
          id: "battery-1",
          name: "battery-1",
          blueprintId: "battery-bank",
          displayName: "Battery Bank",
          connectedTo: [],
          runtimeAttributes: { state: "online", isBattery: true, charge: 100 },
          capabilities: ["isBattery"],
        },
      ],
      inventory: {},
      constructionJobs: [
        {
          id: "construction-existing",
          moduleName: "existing-greenhouse",
          blueprintId: "greenhouse",
          facilityModuleId: "facility-1",
          facilityModuleName: "Workshop Fabricator A",
          totalBuildTicks: 4,
          remainingBuildTicks: 4,
          consumedMaterials: {},
          runtimeAttributes: {},
          capabilities: [],
        },
      ],
      power: { powerConsumedTicks: 0 },
      blueprints: [],
    });

    const result = await runConstructCommand({
      stateService: stateService as never,
      blueprintId: "greenhouse",
      getBlueprints: async () => [
        {
          blueprintId: "greenhouse",
          displayName: "Greenhouse",
          status: "published",
          output: { itemType: "module", moduleType: "greenhouse" },
          inputs: {},
          buildTicks: 4,
          requiredFacility: { moduleType: "workshop-fabricator" },
        },
      ] as never,
    });

    expect((result as { message: string }).message).toContain("Started construction");
    const nextState = await stateService.getState();
    expect(nextState.constructionJobs).toHaveLength(2);
    expect(nextState.constructionJobs.map((job: any) => job.facilityModuleId)).toEqual(["facility-1", "facility-2"]);
  });
});
