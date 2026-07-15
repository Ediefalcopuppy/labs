import { describe, expect, test } from "bun:test";

import { buildCommandRequest, getCommandById } from "../web/src/commands";
import { routeFromHash, viewToHash } from "../web/src/routes";
import { constructionProgress, materialEntries } from "../web/src/ui-format";

describe("web routes", () => {
  test("round-trips a view through the hash route", () => {
    const view = "Solar & Power";

    expect(viewToHash(view)).toBe("#/solar-power");
    expect(routeFromHash("#/solar-power")).toBe(view);
  });

  test("falls back to Overview for unknown hashes", () => {
    expect(routeFromHash("#/does-not-exist")).toBe("Overview");
    expect(routeFromHash("")).toBe("Overview");
  });
});

describe("command requests", () => {
  test("encodes path params without leaving them in the request body", () => {
    const command = getCommandById("module-show");
    const request = buildCommandRequest(command, { name: "greenhouse-1" });

    expect(request.path).toBe("/commands/module/greenhouse-1");
    expect(request.body).toBeUndefined();
  });

  test("coerces numeric fields for POST command payloads", () => {
    const command = getCommandById("scan");
    const request = buildCommandRequest(command, {
      x: "12",
      y: "4",
      sensorStrength: "70",
      radiusTiles: "2",
    });

    expect(request.path).toBe("/commands/resource/scan");
    expect(request.body).toEqual({
      x: 12,
      y: 4,
      sensorStrength: 70,
      radiusTiles: 2,
    });
  });
});

describe("live page formatting", () => {
  test("ignores malformed blueprint material values instead of throwing", () => {
    expect(materialEntries({ steel: "12", water: 0, invalid: { amount: 4 }, broken: "nope" })).toEqual([
      ["steel", 12],
    ]);
  });

  test("formats construction progress for people rather than raw ratios", () => {
    expect(constructionProgress({ remainingBuildTicks: 1, totalBuildTicks: 10 })).toEqual({
      remaining: 1,
      total: 10,
      completed: 9,
      percent: 90,
      label: "1 tick remaining",
    });
  });
});
