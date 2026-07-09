import { describe, expect, test } from "bun:test";
import { computeBatteryChargeAfterTick, spendConstructionPower } from "../src/construction";

describe("computeBatteryChargeAfterTick", () => {
  test("discharges batteries by one percent per 100 ticks", () => {
    const battery = {
      id: "battery-1",
      name: "battery-1",
      blueprintId: "battery-bank",
      displayName: "Battery Bank",
      connectedTo: [],
      runtimeAttributes: { state: "online", isBattery: true, charge: 1000 },
      capabilities: ["isBattery"],
    };

    const nextCharge = computeBatteryChargeAfterTick(battery, 0, 0);

    expect(nextCharge).toBe(999.99);
  });

  test("larger capacity multipliers lose less charge per tick", () => {
    const battery = {
      id: "battery-2",
      name: "battery-2",
      blueprintId: "battery-bank",
      displayName: "Battery Bank",
      connectedTo: [],
      runtimeAttributes: { state: "online", isBattery: true, chargeLossPerTickMult: 0.5, charge: 1000 },
      capabilities: ["isBattery"],
    };

    const nextCharge = computeBatteryChargeAfterTick(battery, 0, 0);

    expect(nextCharge).toBe(999.98);
  });

  test("construction power also drains batteries by the same scaled equation", () => {
    const habitat = {
      modules: [
        {
          id: "battery-1",
          name: "battery-1",
          blueprintId: "battery-bank",
          displayName: "Battery Bank",
          connectedTo: [],
          runtimeAttributes: { state: "online", isBattery: true, charge: 1000, chargeLossPerTickMult: 0.5 },
          capabilities: ["isBattery"],
        },
        {
          id: "battery-2",
          name: "battery-2",
          blueprintId: "battery-bank",
          displayName: "Battery Bank",
          connectedTo: [],
          runtimeAttributes: { state: "online", isBattery: true, charge: 1000, chargeLossPerTickMult: 0.5 },
          capabilities: ["isBattery"],
        },
      ],
      inventory: {},
      constructionJobs: [],
      power: { powerConsumedTicks: 0 },
    };

    const spent = spendConstructionPower(habitat, 2);

    expect(spent.spent).toBe(true);
    expect(habitat.modules[0].runtimeAttributes.charge).toBe(999.98);
    expect(habitat.modules[1].runtimeAttributes.charge).toBe(999.98);
  });
});
