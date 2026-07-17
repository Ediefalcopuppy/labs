import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClockService } from "../src/clock/service";
import { createClockStorage } from "../src/clock/storage";
import { DEFAULT_CLOCK_STATE } from "../src/clock/types";
import { createApp, startServer } from "../src/server";
import {
  createServerFetchHandler,
  loadOrCreateOperatorToken,
} from "../src/server/operator";
import { createStateService, normalizeState } from "../src/state/service";

describe("backend health", () => {
  test("GET /health returns ok", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("systemd runs Habitat as the checkout owner with a secret-safe umask", async () => {
    const unit = await Bun.file(new URL("../systemd/habitat.service", import.meta.url)).text();

    expect(unit).toContain("User=ediefalco");
    expect(unit).toContain("UMask=0077");
  });
});

const STREAM_TOKEN = "fixture-lifecycle-stream-token";

class FakeWebSocket {
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; wasClean?: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(): void {}

  close(): void {
    this.closeCalls += 1;
  }
}

type SignalName = "SIGINT" | "SIGTERM";

class FakeSignals {
  readonly listeners = new Map<SignalName, Set<() => void>>();

  add = (signal: SignalName, listener: () => void): void => {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  };

  remove = (signal: SignalName, listener: () => void): void => {
    this.listeners.get(signal)?.delete(listener);
  };

  emit(signal: SignalName): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let temp: string;
let path: string;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "habitat-server-lifecycle-"));
  path = join(temp, "habitat.sqlite");
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("local operator API", () => {
  test("persists one restrictive local operator credential", async () => {
    const first = await loadOrCreateOperatorToken(path);
    const second = await loadOrCreateOperatorToken(path);

    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(second).toBe(first);
    expect((await stat(join(temp, "operator.key"))).mode & 0o777).toBe(0o600);
  });

  test("reveals the stream token only to a socket-level loopback request", async () => {
    const stateService = createStateService({ storagePath: path });
    const storage = createClockStorage(path);
    await storage.saveRegistration(normalizeState({
      registration: {
        displayName: "Local Operator Habitat",
        registeredAt: "2026-07-16T11:00:00.000Z",
        lastSyncedAt: "2026-07-16T11:00:00.000Z",
        habitatId: "habitat_local_operator",
      },
    }), STREAM_TOKEN);
    const app = createApp(stateService, storage);
    const fetchHandler = createServerFetchHandler({
      appFetch: (request) => app.fetch(request),
      stateService,
      storage,
      operatorToken: "fixture-local-operator-access",
    });
    const authorizedRequest = () => new Request("http://habitat.test/operator/status", {
      headers: { authorization: "Bearer fixture-local-operator-access" },
    });

    const remote = await fetchHandler(authorizedRequest(), {
      requestIP: () => ({ address: "203.0.113.10" }),
    });
    const unauthenticated = await fetchHandler(
      new Request("http://habitat.test/operator/status"),
      { requestIP: () => ({ address: "127.0.0.1" }) },
    );
    const local = await fetchHandler(authorizedRequest(), {
      requestIP: () => ({ address: "::ffff:127.0.0.1" }),
    });

    expect(remote.status).toBe(404);
    expect(await remote.text()).not.toContain(STREAM_TOKEN);
    expect(unauthenticated.status).toBe(404);
    expect(await unauthenticated.text()).not.toContain(STREAM_TOKEN);
    expect(local.status).toBe(200);
    const payload = await local.json() as { registration?: { apiToken?: string } };
    expect(payload.registration?.apiToken).toBe(STREAM_TOKEN);
  });
});

describe("backend clock lifecycle", () => {
  test("awaits persisted listener startup once and preserves intent on idempotent signal shutdown", async () => {
    const storage = createClockStorage(path);
    await storage.saveRegistration(normalizeState({
      registration: {
        displayName: "Lifecycle Habitat",
        registeredAt: "2026-07-16T11:00:00.000Z",
        lastSyncedAt: "2026-07-16T11:00:00.000Z",
        habitatId: "habitat_lifecycle",
        streamUrl: "wss://planet.turingguild.com/planet/stream",
        stream: {
          protocolVersion: "1.0",
          subscriptions: ["ticks"],
          currentTick: 800,
          tickIntervalMs: 1_000,
          ticksPerPulse: 10,
          status: "running",
        },
      },
    }), STREAM_TOKEN);
    await storage.saveClockState({
      ...DEFAULT_CLOCK_STATE,
      mode: "kepler",
      listeningEnabled: true,
    });

    const order: string[] = [];
    const sockets: FakeWebSocket[] = [];
    const signals = new FakeSignals();
    let serverStopCalls = 0;
    const serverStopGate = deferred<void>();
    const fakeServer = {
      async stop(): Promise<void> {
        serverStopCalls += 1;
        order.push("server.stop");
        await serverStopGate.promise;
      },
    };
    const runtime = await startServer(4_321, {
      storagePath: path,
      hostname: "127.0.0.1",
      serve: () => {
        order.push("serve");
        return fakeServer;
      },
      signals,
      clockDependencies: {
        getIrradiance: async () => 900,
        openWebSocket: (url: string) => {
          order.push("socket");
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket;
        },
      },
    });

    expect(order.slice(0, 2)).toEqual(["socket", "serve"]);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("wss://planet.turingguild.com/planet/stream");
    expect(signals.listeners.get("SIGINT")?.size).toBe(1);
    expect(signals.listeners.get("SIGTERM")?.size).toBe(1);
    expect(await runtime.app.request("/clock/status").then((response) => response.json()))
      .toEqual(expect.objectContaining({
        mode: "kepler",
        listeningEnabled: true,
        manualTicksAllowed: false,
      }));
    const eventReader = (await runtime.app.request("/clock/events")).body!.getReader();

    const stopping = runtime.stop();
    const stoppedAcceptingBeforeClockCleanup = serverStopCalls === 1;
    const lateListen = runtime.app.request("/clock/listen/on", { method: "POST" });
    serverStopGate.resolve();
    await stopping;
    expect((await lateListen).status).toBe(200);
    signals.emit("SIGINT");
    await runtime.stop();

    expect(stoppedAcceptingBeforeClockCleanup).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closeCalls).toBe(1);
    expect(serverStopCalls).toBe(1);
    expect(await eventReader.read()).toEqual({ done: true, value: undefined });
    expect(await storage.getClockState()).toEqual({
      ...DEFAULT_CLOCK_STATE,
      mode: "kepler",
      listeningEnabled: true,
    });
    expect(signals.listeners.get("SIGINT")?.size).toBe(0);
    expect(signals.listeners.get("SIGTERM")?.size).toBe(0);
  });

  test("startup failure closes an opened socket and preserves the original error", async () => {
    const storage = createClockStorage(path);
    await storage.saveRegistration(normalizeState({
      registration: {
        displayName: "Failing Startup Habitat",
        registeredAt: "2026-07-16T11:00:00.000Z",
        lastSyncedAt: "2026-07-16T11:00:00.000Z",
        habitatId: "habitat_startup_failure",
        streamUrl: "wss://planet.turingguild.com/planet/stream",
        stream: {
          protocolVersion: "1.0",
          subscriptions: ["ticks"],
          currentTick: 800,
          tickIntervalMs: 1_000,
          ticksPerPulse: 10,
          status: "running",
        },
      },
    }), STREAM_TOKEN);
    await storage.saveClockState({
      ...DEFAULT_CLOCK_STATE,
      mode: "kepler",
      listeningEnabled: true,
    });

    const startupError = new Error("startup status read failed");
    const cleanupError = new Error("cleanup status read failed");
    const sockets: FakeWebSocket[] = [];
    let clockFactoryCalls = 0;
    let clockStateReads = 0;
    let serveCalls = 0;
    const result = await startServer(4_322, {
      storagePath: path,
      hostname: "127.0.0.1",
      signals: new FakeSignals(),
      serve: () => {
        serveCalls += 1;
        return { stop() {} };
      },
      clockDependencies: {
        openWebSocket: (url: string) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket;
        },
      },
      createClock: (dependencies) => {
        clockFactoryCalls += 1;
        return createClockService({
          ...dependencies,
          storage: {
            ...dependencies.storage,
            async getClockState() {
              clockStateReads += 1;
              if (clockStateReads === 2) throw startupError;
              if (clockStateReads >= 3) throw cleanupError;
              return dependencies.storage.getClockState();
            },
          },
        });
      },
    }).then(
      (runtime) => ({ runtime }),
      (error: unknown) => ({ error }),
    );

    if ("runtime" in result) await result.runtime.stop();

    expect(clockFactoryCalls).toBe(1);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBe(startupError);
    expect(serveCalls).toBe(0);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closeCalls).toBe(1);
  });
});
