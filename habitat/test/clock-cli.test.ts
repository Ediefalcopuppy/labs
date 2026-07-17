import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatClockStatus,
  formatHabitatStatus,
  watchClockEvents,
  watchClockEventsOnSigint,
} from "../src/clock/cli";
import type { ClockEvent, ClockStatus } from "../src/clock/types";
import { normalizeState } from "../src/state/service";

const STREAM_TOKEN = "fixture-cli-stream-token-complete";
const ISSUED_AT = "2026-07-16T12:00:00.000Z";
const repositoryRoot = join(import.meta.dir, "..");

const originalFetch = globalThis.fetch;
const originalWebSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWebSocketDescriptor) {
    Object.defineProperty(globalThis, "WebSocket", originalWebSocketDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

function manualClockStatus(overrides: Partial<ClockStatus> = {}): ClockStatus {
  return {
    mode: "manual",
    listeningEnabled: false,
    connectionState: "disconnected",
    latestPlanetTick: null,
    latestAdvancedBy: null,
    lastConnectedAt: null,
    lastMessageAt: null,
    latestError: null,
    manualTicksAllowed: true,
    ...overrides,
  };
}

function habitatStatusPayload() {
  const state = normalizeState({
    registration: {
      displayName: "Test Habitat",
      registeredAt: "2026-07-16T10:00:00.000Z",
      lastSyncedAt: "2026-07-16T11:00:00.000Z",
      habitatId: "habitat_test",
      streamUrl: "wss://planet.example.test/stream",
      stream: {
        protocolVersion: "1.0",
        subscriptions: ["ticks"],
        currentTick: 800,
        tickIntervalMs: 1_000,
        ticksPerPulse: 10,
        status: "paused",
      },
    },
    modules: [{
      id: "core",
      name: "core",
      blueprintId: "core",
      displayName: "Core",
      connectedTo: [],
      runtimeAttributes: { state: "online", powerDraw: 4 },
      capabilities: [],
    }],
    power: { powerConsumedTicks: 12 },
  });

  return {
    ...state,
    registration: {
      ...state.registration!,
      apiToken: STREAM_TOKEN,
    },
  };
}

async function runCli(
  args: string[],
  responses: Record<string, unknown>,
  environment: Record<string, string> = {},
) {
  const preload = join(repositoryRoot, "test/fixtures/clock-cli-preload.ts");
  const isolated = await mkdtemp(join(tmpdir(), "habitat-clock-cli-"));
  try {
    const child = Bun.spawn([
      process.execPath,
      "run",
      "--preload",
      preload,
      "src/index.ts",
      ...args,
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HABITAT_API_BASE_URL: "http://127.0.0.1:3000",
        HABITAT_CLI_TEST_RESPONSES: JSON.stringify(responses),
        HABITAT_OPERATOR_TOKEN: "fixture-cli-operator-access",
        HABITAT_SQLITE_PATH: join(isolated, "habitat.sqlite"),
        NO_COLOR: "1",
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const requests = stderr
      .split("\n")
      .filter((line) => line.startsWith("__HABITAT_TEST_REQUEST__ "))
      .map((line) => line.slice("__HABITAT_TEST_REQUEST__ ".length));
    const unexpectedStderr = stderr
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("__HABITAT_TEST_REQUEST__ "))
      .join("\n");
    return { stdout, stderr: unexpectedStderr, exitCode, requests };
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

function responseFromTextChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    headers: { "content-type": "text/event-stream" },
  });
}

function splitAt(text: string, lengths: number[]): string[] {
  const chunks: string[] = [];
  let offset = 0;
  for (const length of lengths) {
    chunks.push(text.slice(offset, offset + length));
    offset += length;
  }
  if (offset < text.length) chunks.push(text.slice(offset));
  return chunks;
}

describe("clock CLI formatting", () => {
  test("shows unambiguous manual and listening status copy", () => {
    const manual = formatClockStatus(manualClockStatus());
    const listening = formatClockStatus(manualClockStatus({
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "connected",
      manualTicksAllowed: false,
    }));

    expect(manual.includes("Clock mode: manual")).toBe(true);
    expect(manual.includes("Kepler listening: off")).toBe(true);
    expect(manual.includes("Manual ticks allowed: yes")).toBe(true);
    expect(listening.includes("Clock mode: kepler")).toBe(true);
    expect(listening.includes("Kepler listening: on")).toBe(true);
    expect(listening.includes("Manual ticks allowed: no")).toBe(true);
  });

  test("shows complete registration stream details without exposing the fixture in assertions", () => {
    const lines = formatHabitatStatus(habitatStatusPayload());
    const tokenLine = lines.find((line) => line.startsWith("Stream token: "));

    expect(tokenLine !== undefined).toBe(true);
    expect(tokenLine?.endsWith(STREAM_TOKEN) === true).toBe(true);
    expect(tokenLine?.length === "Stream token: ".length + STREAM_TOKEN.length).toBe(true);
    expect(lines.includes("Habitat id: habitat_test")).toBe(true);
    expect(lines.includes("Stream URL: wss://planet.example.test/stream")).toBe(true);
    expect(lines.includes("Subscriptions: ticks")).toBe(true);
    expect(lines.includes("Registration clock status: paused")).toBe(true);
    expect(lines.includes("Registration current tick: 800")).toBe(true);
    expect(lines.includes("Registration tick interval: 1000 ms")).toBe(true);
    expect(lines.includes("Registration ticks per pulse: 10")).toBe(true);
  });

  test("uses the canonical state-aware power-draw calculation", () => {
    const payload = habitatStatusPayload();
    payload.modules[0]!.runtimeAttributes = {
      state: "online",
      powerDraw: 1,
      powerDrawByState: { online: 7, offline: 0 },
      onlinePowerDraw: 5,
    };

    const lines = formatHabitatStatus(payload);

    expect(lines.includes("Total current module power draw: 7")).toBe(true);
    expect(lines.includes("Energy cost for one tick: 7")).toBe(true);
  });

});

describe("clock SSE client", () => {
  test("parses CRLF and arbitrary chunks, joins data fields, and emits a trailing event once", async () => {
    const first: ClockEvent = {
      type: "planet_tick",
      tick: 41,
      advancedBy: 10,
      issuedAt: ISSUED_AT,
      applied: true,
    };
    const second: ClockEvent = {
      type: "planet_tick",
      tick: 42,
      advancedBy: 1,
      issuedAt: ISSUED_AT,
      applied: false,
    };
    const streamText = [
      "\r\n",
      ": heartbeat\r\n",
      "event: clock\r\n",
      "id: 41\r\n",
      "retry: 1000\r\n",
      "data: {\"type\":\"planet_tick\",\r\n",
      `data: \"tick\":${first.tick},\"advancedBy\":${first.advancedBy},\"issuedAt\":\"${first.issuedAt}\",\"applied\":true}\r\n`,
      "\r\n",
      ": another comment\n",
      `data: ${JSON.stringify(second)}`,
    ].join("");
    const chunks = splitAt(streamText, [1, 2, 7, 13, 1, 19, 3, 29, 1, 2, 11]);
    const requested: Array<{ url: string; signal: AbortSignal | null }> = [];
    let webSocketCalls = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: class {
        constructor() {
          webSocketCalls += 1;
        }
      },
    });
    globalThis.fetch = (async (input, init) => {
      requested.push({
        url: String(input),
        signal: init?.signal instanceof AbortSignal ? init.signal : null,
      });
      return responseFromTextChunks(chunks);
    }) as typeof fetch;
    const output: string[] = [];
    const controller = new AbortController();

    await watchClockEvents({
      signal: controller.signal,
      jsonl: true,
      write: (text) => output.push(text),
    });

    expect(requested).toHaveLength(1);
    expect(new URL(requested[0]!.url).pathname).toBe("/clock/events");
    expect(requested[0]!.signal).toBe(controller.signal);
    expect(webSocketCalls).toBe(0);
    expect(output).toHaveLength(2);
    expect(output.every((line) => line.endsWith("\n"))).toBe(true);
    const parsed = output.map((line) => JSON.parse(line) as ClockEvent);
    expect(parsed.map((event) => event.tick)).toEqual([41, 42]);
    expect(Object.keys(parsed[0]!).sort()).toEqual([
      "advancedBy",
      "applied",
      "issuedAt",
      "tick",
      "type",
    ]);
  });

  test("removes its SIGINT handler after aborting only the watch request", async () => {
    let installed: (() => void) | undefined;
    let removed: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const signalTarget = {
      on(event: "SIGINT", listener: () => void) {
        expect(event).toBe("SIGINT");
        installed = listener;
      },
      off(event: "SIGINT", listener: () => void) {
        expect(event).toBe("SIGINT");
        removed = listener;
      },
    };

    const watching = watchClockEventsOnSigint({
      jsonl: true,
      write: () => undefined,
      signalTarget,
      watch: async ({ signal }) => {
        observedSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    await Promise.resolve();

    expect(typeof installed).toBe("function");
    expect(observedSignal?.aborted).toBe(false);
    installed!();
    await watching;

    expect(observedSignal?.aborted).toBe(true);
    expect(removed === installed).toBe(true);
  });
});

describe("clock Commander wiring", () => {
  test("allows a pre-stream registration to upgrade in place through the existing register command", async () => {
    const existing = normalizeState({
      registration: {
        displayName: "Legacy Habitat",
        registeredAt: ISSUED_AT,
        lastSyncedAt: ISSUED_AT,
        habitatId: "habitat_legacy",
      },
    });
    const upgraded = {
      ...existing,
      registration: {
        ...existing.registration!,
        streamUrl: "wss://planet.example.test/stream",
        stream: {
          protocolVersion: "1.0",
          subscriptions: ["ticks"],
          currentTick: 800,
          tickIntervalMs: 1_000,
          ticksPerPulse: 10,
          status: "running" as const,
        },
      },
    };
    const result = await runCli(["register", "--name", "Replacement Name"], {
      "GET /operator/status": existing,
      "POST /commands/register": upgraded,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.requests).toEqual(["GET /operator/status", "POST /commands/register"]);
    expect(result.stdout.includes("Legacy Habitat")).toBe(true);
    expect(result.stdout.includes("Replacement Name")).toBe(false);
  });

  test("allows registration repair when stream metadata exists but the local secret is missing", async () => {
    const existing = habitatStatusPayload();
    delete existing.registration?.apiToken;
    const result = await runCli(["register", "--name", "Ignored Name"], {
      "GET /operator/status": existing,
      "POST /commands/register": existing,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.requests).toEqual(["GET /operator/status", "POST /commands/register"]);
  });

  test("unregister delegates complete cleanup to the backend", async () => {
    const existing = habitatStatusPayload();
    const result = await runCli(["unregister"], {
      "GET /state": existing,
      "DELETE /commands/unregister": { displayName: existing.registration?.displayName },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.requests).toEqual(["GET /state", "DELETE /commands/unregister"]);
  });

  test("prints one stable Habitat JSON document with root --json before or after status", async () => {
    const payload = habitatStatusPayload();
    const responses = { "GET /operator/status": payload };
    const requests: string[] = [];

    for (const args of [["--json", "status"], ["status", "--json"]]) {
      const result = await runCli(args, responses);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      requests.push(...result.requests);
      const parsed = JSON.parse(result.stdout) as ReturnType<typeof habitatStatusPayload>;
      expect(Object.keys(parsed).includes("registration")).toBe(true);
      expect(Object.keys(parsed.registration).includes("apiToken")).toBe(true);
      expect(parsed.registration.apiToken === STREAM_TOKEN).toBe(true);
      expect(parsed.registration.streamUrl).toBe("wss://planet.example.test/stream");
      expect(Object.keys(parsed.registration.stream ?? {}).sort()).toEqual([
        "currentTick",
        "protocolVersion",
        "status",
        "subscriptions",
        "tickIntervalMs",
        "ticksPerPulse",
      ]);
    }

    expect(requests).toEqual([
      "GET /operator/status",
      "GET /operator/status",
    ]);
  });

  test("prints clock JSON and sends listen on/off only to local HTTP routes", async () => {
    const responses = {
      "GET /clock/status": manualClockStatus(),
      "POST /clock/listen/on": manualClockStatus({
        mode: "kepler",
        listeningEnabled: true,
        connectionState: "connecting",
        manualTicksAllowed: false,
      }),
      "POST /clock/listen/off": manualClockStatus(),
    };

    const commands = [
      ["--json", "clock", "status"],
      ["clock", "status", "--json"],
      ["--json", "clock", "listen", "on"],
      ["clock", "listen", "off", "--json"],
    ];
    const documents = [];
    const requests: string[] = [];
    for (const args of commands) {
      const result = await runCli(args, responses);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      requests.push(...result.requests);
      documents.push(JSON.parse(result.stdout) as ClockStatus);
    }

    expect(documents.map((document) => Object.keys(document).sort())).toEqual(
      Array.from({ length: 4 }, () => [
        "connectionState",
        "lastConnectedAt",
        "lastMessageAt",
        "latestAdvancedBy",
        "latestError",
        "latestPlanetTick",
        "listeningEnabled",
        "manualTicksAllowed",
        "mode",
      ]),
    );
    expect(requests).toEqual([
      "GET /clock/status",
      "GET /clock/status",
      "POST /clock/listen/on",
      "POST /clock/listen/off",
    ]);
  });

  test("keeps an existing command-local --json option working", async () => {
    const result = await runCli(["registration", "details", "--json"], {
      "GET /commands/registration/details": {
        registration: { displayName: "Test Habitat" },
        kepler: { status: "online" },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["kepler", "registration"]);
  });

  test("wires JSONL watch to one local SSE request and one object per event", async () => {
    const event: ClockEvent = {
      type: "planet_tick",
      tick: 900,
      advancedBy: 100,
      issuedAt: ISSUED_AT,
      applied: true,
    };
    const result = await runCli(["--jsonl", "clock", "watch"], {
      "GET /clock/events": { eventStream: `data: ${JSON.stringify(event)}\n\n` },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.requests).toEqual(["GET /clock/events"]);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as ClockEvent;
    expect(parsed.tick).toBe(900);
    expect(parsed.advancedBy).toBe(100);
    expect(Object.keys(parsed).sort()).toEqual([
      "advancedBy",
      "applied",
      "issuedAt",
      "tick",
      "type",
    ]);
  });
});
