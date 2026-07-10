import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server";

describe("backend health", () => {
  test("GET /health returns ok", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
