import { describe, expect, test } from "bun:test";
import { createStateService } from "../src/state/service";

describe("state service", () => {
  test("starts with empty normalized state", async () => {
    const service = createStateService({ storagePath: ":memory:" });
    const state = await service.getState();
    expect(state.modules).toEqual([]);
    expect(state.inventory).toEqual({});
    expect(state.constructionJobs).toEqual([]);
  });
});
