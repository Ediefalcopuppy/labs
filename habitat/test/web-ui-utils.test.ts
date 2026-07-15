import { describe, expect, test } from "bun:test";

import { buildCommandRequest, getCommandById } from "../web/src/commands";
import { routeFromHash, viewToHash } from "../web/src/routes";

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
