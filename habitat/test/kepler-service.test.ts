import { describe, expect, test } from "bun:test";
import { normalizeKeplerCatalog } from "../src/kepler/service";

describe("kepler service", () => {
  test("normalizes blueprint catalog entries", () => {
    const catalog = normalizeKeplerCatalog([
      { id: "bp-1", name: "Starter", buildable: true } as never,
    ]);
    expect(catalog[0].id).toBe("bp-1");
    expect(catalog[0].name).toBe("Starter");
  });
});
