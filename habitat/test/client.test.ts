import { describe, expect, test } from "bun:test";
import { buildBackendUrl } from "../src/client";

describe("client config", () => {
  test("uses a default backend url", () => {
    expect(buildBackendUrl()).toContain("http://");
  });
});
