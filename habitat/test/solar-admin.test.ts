import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("admin solar irradiance", () => {
  test("proxies the admin PATCH payload to Kepler", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(String(input), init);
      return new Response(JSON.stringify({ mode: "manual", manualIrradianceWPerM2: 500 }), { status: 200 });
    }) as typeof fetch;

    const app = createApp({
      async getState() { return {} as never; },
      async saveState(state) { return state as never; },
      async resetState() { return {} as never; },
    } as never);
    const response = await app.request("/commands/solar/irradiance", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "manual", manualIrradianceWPerM2: 500, effectiveIrradianceWPerM2: 450, condition: "storm", updatedBy: "instructor" }),
    });

    expect(response.status).toBe(200);
    expect(request?.method).toBe("PATCH");
    expect(new URL(request!.url).pathname).toBe("/admin/world/solar-irradiance");
    expect(await request!.json()).toEqual({ mode: "manual", manualIrradianceWPerM2: 500, effectiveIrradianceWPerM2: 450, condition: "storm", updatedBy: "instructor" });
  });
});
