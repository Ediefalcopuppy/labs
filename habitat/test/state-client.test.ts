import { afterEach, describe, expect, test } from "bun:test";
import {
  getBackendState,
  saveBackendState,
} from "../src/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("state HTTP client", () => {
  test("round-trips the GET ETag through If-Match on save", async () => {
    const requests: Array<{ method: string; ifMatch: string | null }> = [];
    const responses = [
      new Response(JSON.stringify({ inventory: { water: 4 } }), {
        headers: { "content-type": "application/json", etag: '"habitat-state-3"' },
      }),
      new Response(JSON.stringify({ inventory: { water: 9 } }), {
        headers: { "content-type": "application/json", etag: '"habitat-state-4"' },
      }),
    ];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        method: init?.method ?? "GET",
        ifMatch: headers.get("if-match"),
      });
      return responses.shift()!;
    }) as typeof fetch;

    const state = await getBackendState<{ inventory: { water: number } }>();
    state.inventory.water = 9;
    const saved = await saveBackendState(state);

    expect(saved.inventory.water).toBe(9);
    expect(requests).toEqual([
      { method: "GET", ifMatch: null },
      { method: "POST", ifMatch: '"habitat-state-3"' },
    ]);
  });

  test("refuses to stamp an arbitrary state body with a process-global revision", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { headers: { etag: '"habitat-state-1"' } });
    }) as typeof fetch;

    await expect(saveBackendState({ inventory: { water: 9 } }))
      .rejects.toThrow("load the state");
    expect(fetchCalls).toBe(0);
  });
});
