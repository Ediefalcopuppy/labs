import { describe, expect, test } from "bun:test";
import {
  forceConstructionStart,
  planConstructionStart,
  previewConstructionStart,
  spendConstructionPower,
} from "../src/construction";

describe("planConstructionStart", () => {
  test("rejects a blueprint that is not published", () => {
    expect(() =>
      planConstructionStart({
        blueprint: {
          blueprintId: "rover-bay",
          displayName: "Rover Bay",
          status: "draft",
          output: { itemType: "module" },
          inputs: {},
          buildTicks: 12,
        },
        habitat: {
          modules: [],
          inventory: {},
          constructionJobs: [],
          power: { powerConsumedTicks: 0 },
        },
      }),
    ).toThrow("published");
  });

  test("reports whether construction can start without changing local state", () => {
    const habitat = {
      modules: [
        {
          id: "fac-1",
          blueprintId: "workshop-fabricator",
          displayName: "Workshop Fabricator",
          connectedTo: [],
          runtimeAttributes: { state: "online", moduleType: "workshop-fabricator" },
          capabilities: [],
        },
        {
          id: "supply-1",
          blueprintId: "supply-cache",
          displayName: "Supply Cache",
          connectedTo: [],
          runtimeAttributes: { state: "online" },
          capabilities: ["logistics"],
        },
        {
          id: "battery-1",
          blueprintId: "battery-bank",
          displayName: "Battery Bank",
          connectedTo: [],
          runtimeAttributes: { state: "online", isBattery: true, charge: 80 },
          capabilities: ["isBattery"],
        },
      ],
      inventory: { steel: 4 },
      constructionJobs: [],
      power: { powerConsumedTicks: 0 },
    };

    const report = previewConstructionStart({
      blueprint: {
        blueprintId: "survey-rover",
        displayName: "Survey Rover",
        status: "published",
        output: { itemType: "module", moduleType: "survey-rover" },
        inputs: { steel: 4 },
        buildTicks: 12,
        requiredFacility: { moduleType: "workshop-fabricator" },
      },
      habitat,
    });

    expect(report.requiredFacilityExists).toBe(true);
    expect(report.fabricatorAvailable).toBe(true);
    expect(report.supplyCacheOnline).toBe(true);
    expect(report.prerequisitesMet).toBe(true);
    expect(report.inventoryHasMaterials).toBe(true);
    expect(report.moduleToBeCreated).toBe("Survey Rover");
    expect(report.resourcesToBeSpent).toEqual({ steel: 4 });
    expect(report.canStart).toBe(true);
    expect(habitat.inventory).toEqual({ steel: 4 });
    expect(habitat.constructionJobs).toEqual([]);
  });

  test("force creates a module plan without requiring facility readiness", () => {
    const forced = forceConstructionStart({
      blueprint: {
        blueprintId: "small-solar-array",
        displayName: "Small Solar Array",
        status: "published",
        output: { itemType: "module", moduleType: "small-solar-array" },
        inputs: {},
        buildTicks: 4,
      },
      habitat: {
        modules: [],
        inventory: {},
        constructionJobs: [],
        power: { powerConsumedTicks: 0 },
      },
    });

    expect(forced.moduleName).toBe("Small Solar Array");
    expect(forced.displayName).toBe("Small Solar Array");
    expect(forced.blueprintId).toBe("small-solar-array");
    expect(forced.totalBuildTicks).toBe(4);
    expect(forced.runtimeAttributes.state).toBe("online");
    expect(forced.runtimeAttributes.status).toBe("online");
  });

  test("spends construction power from batteries", () => {
    const habitat = {
      modules: [
        {
          id: "battery-1",
          name: "battery-1",
          blueprintId: "battery-bank",
          displayName: "Battery Bank",
          connectedTo: [],
          runtimeAttributes: { state: "online", isBattery: true, charge: 10 },
          capabilities: ["isBattery"],
        },
        {
          id: "battery-2",
          name: "battery-2",
          blueprintId: "battery-bank",
          displayName: "Battery Bank",
          connectedTo: [],
          runtimeAttributes: { state: "online", isBattery: true, charge: 10 },
          capabilities: ["isBattery"],
        },
      ],
      inventory: {},
      constructionJobs: [],
      power: { powerConsumedTicks: 0 },
    };

    const spent = spendConstructionPower(habitat, 2);

    expect(spent.spent).toBe(true);
    expect(habitat.modules[0].runtimeAttributes.charge).toBe(9);
    expect(habitat.modules[1].runtimeAttributes.charge).toBe(9);
  });

  test("treats legacy battery-bank modules as batteries", () => {
    const habitat = {
      modules: [
        {
          id: "battery-legacy",
          name: "battery-legacy",
          blueprintId: "battery-bank",
          displayName: "Battery Bank",
          connectedTo: [],
          runtimeAttributes: { state: "online", charge: 50 },
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
      inventory: { steel: 1 },
      constructionJobs: [],
      power: { powerConsumedTicks: 0 },
    };

    const report = previewConstructionStart({
      blueprint: {
        blueprintId: "survey-rover",
        displayName: "Survey Rover",
        status: "published",
        output: { itemType: "module", moduleType: "survey-rover" },
        inputs: {},
        buildTicks: 12,
        requiredFacility: { moduleType: "battery-bank" },
      },
      habitat,
    });

    expect(report.requiredFacilityExists).toBe(true);
  });

  test("treats energy-storage modules as batteries for construction power", () => {
    const habitat = {
      modules: [
        {
          id: "battery-storage",
          name: "battery-storage",
          blueprintId: "lithium-storage-bank",
          displayName: "Lithium Storage Bank",
          connectedTo: [],
          runtimeAttributes: { state: "online", energyStorageKwh: 220, charge: 40 },
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
      inventory: { steel: 1 },
      constructionJobs: [],
      power: { powerConsumedTicks: 0 },
    };

    const report = previewConstructionStart({
      blueprint: {
        blueprintId: "survey-rover",
        displayName: "Survey Rover",
        status: "published",
        output: { itemType: "module", moduleType: "survey-rover" },
        inputs: { steel: 1 },
        buildTicks: 12,
        requiredFacility: { moduleType: "lithium-storage-bank" },
      },
      habitat,
    });

    expect(report.requiredFacilityExists).toBe(true);
    expect(report.canStart).toBe(true);
  });
});
