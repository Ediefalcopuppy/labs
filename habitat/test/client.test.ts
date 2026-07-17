import { afterEach, describe, expect, test } from "bun:test";
import { buildBackendUrl, getLocalOperatorCommand } from "../src/client";

const originalFetch = globalThis.fetch;
const originalBackendUrl = process.env.HABITAT_API_BASE_URL;
const originalOperatorToken = process.env.HABITAT_OPERATOR_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBackendUrl === undefined) delete process.env.HABITAT_API_BASE_URL;
  else process.env.HABITAT_API_BASE_URL = originalBackendUrl;
  if (originalOperatorToken === undefined) delete process.env.HABITAT_OPERATOR_TOKEN;
  else process.env.HABITAT_OPERATOR_TOKEN = originalOperatorToken;
});

describe("client config", () => {
  test("uses a default backend url", () => {
    expect(buildBackendUrl()).toContain("http://");
  });

  test("never sends the local operator credential to a non-loopback backend", async () => {
    process.env.HABITAT_API_BASE_URL = "https://remote.example";
    process.env.HABITAT_OPERATOR_TOKEN = "fixture-operator-token-with-safe-length";
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({});
    }) as typeof fetch;

    await expect(getLocalOperatorCommand("/operator/status"))
      .rejects.toThrow("loopback");
    expect(fetchCalls).toBe(0);
  });

  test("does not mistake a hostname beginning with 127 for loopback", async () => {
    process.env.HABITAT_API_BASE_URL = "http://127.attacker.example:3000";
    process.env.HABITAT_OPERATOR_TOKEN = "fixture-operator-token-with-safe-length";
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({});
    }) as typeof fetch;
    await expect(getLocalOperatorCommand("/operator/status")).rejects.toThrow("loopback");
    expect(fetchCalls).toBe(0);
  });

  test("authenticates the operator request on loopback", async () => {
    process.env.HABITAT_API_BASE_URL = "http://127.0.0.1:3000";
    process.env.HABITAT_OPERATOR_TOKEN = "fixture-operator-token-with-safe-length";
    let authorization: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ registered: true });
    }) as typeof fetch;

    await getLocalOperatorCommand("/operator/status");

    expect(authorization?.startsWith("Bearer ")).toBe(true);
    expect(authorization?.length).toBeGreaterThan("Bearer ".length + 31);
  });
});
