import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClockService } from "../src/clock/service";
import { createClockStorage, type ClockStorage } from "../src/clock/storage";
import { DEFAULT_CLOCK_STATE, type PlanetTickNotice } from "../src/clock/types";
import { normalizeState } from "../src/state/service";
import type { HabitatRegistration } from "../src/state/types";
import { readSqliteState, writeSqliteState } from "../src/storage";

const STREAM_TOKEN = "fixture-stream-token";
const HABITAT_ID = "habitat_fixture";
const STREAM_URL = "wss://planet.turingguild.com/planet/stream";
const CONNECTED_AT = "2026-07-16T12:00:01.000Z";

let temp: string;
let path: string;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "habitat-clock-service-"));
  path = join(temp, "habitat.sqlite");
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

function poweredState() {
  return normalizeState({
    modules: [{
      id: "consumer-1",
      name: "consumer-1",
      blueprintId: "workbench",
      displayName: "Workbench",
      connectedTo: [],
      runtimeAttributes: { state: "online", powerDraw: 3 },
      capabilities: [],
    }],
    power: { powerConsumedTicks: 2 },
  });
}

function planetTick(overrides: Partial<PlanetTickNotice> = {}): PlanetTickNotice {
  const tick = overrides.tick ?? 900;
  const advancedBy = overrides.advancedBy ?? 10;
  return {
    type: "planet_tick",
    previousTick: overrides.previousTick ?? tick - advancedBy,
    tick,
    advancedBy,
    secondsPerTick: 1,
    issuedAt: "2026-07-16T12:00:00.000Z",
    ...overrides,
  };
}

function registration(
  overrides: Partial<HabitatRegistration> = {},
): HabitatRegistration {
  return {
    displayName: "Fixture Habitat",
    registeredAt: "2026-07-16T11:00:00.000Z",
    lastSyncedAt: "2026-07-16T11:00:00.000Z",
    habitatId: HABITAT_ID,
    streamUrl: STREAM_URL,
    stream: {
      protocolVersion: "2026-06-24",
      subscriptions: ["ticks"],
      currentTick: 800,
      tickIntervalMs: 1_000,
      ticksPerPulse: 10,
      status: "running",
    },
    ...overrides,
  };
}

function helloAck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "hello_ack",
    connectionId: "connection-1",
    habitatId: HABITAT_ID,
    subscriptions: ["ticks"],
    currentTick: 800,
    catchUpTicks: 0,
    tickIntervalMs: 1_000,
    ticksPerPulse: 10,
    clockStatus: "running",
    serverTime: "2026-07-16T12:00:00.000Z",
    ...overrides,
  };
}

type SocketMessageEvent = { data: unknown };
type SocketCloseEvent = { code: number; wasClean: boolean };

class FakeWebSocket {
  readonly sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: SocketMessageEvent) => void) | null = null;
  onclose: ((event: SocketCloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.closeCalls += 1;
  }

  open(): void {
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) });
  }

  unexpectedClose(code = 1006): void {
    this.onclose?.({ code, wasClean: false });
  }

  error(): void {
    this.onerror?.();
  }
}

class FakeReconnectScheduler {
  private nextId = 1;
  readonly scheduled = new Map<number, { callback: () => void; delayMs: number }>();

  schedule = (callback: () => void, delayMs: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.scheduled.set(id, { callback, delayMs });
    return id;
  };

  cancel = (id: unknown): void => {
    if (typeof id === "number") this.scheduled.delete(id);
  };

  runNext(): void {
    const next = this.scheduled.entries().next().value as
      | [number, { callback: () => void; delayMs: number }]
      | undefined;
    if (!next) throw new Error("No reconnect is scheduled.");
    this.scheduled.delete(next[0]);
    next[1].callback();
  }
}

type TestServiceOptions = {
  registration?: HabitatRegistration | undefined;
  streamToken?: string | undefined;
  getIrradiance?: () => Promise<number>;
  failOpen?: boolean;
  failOpenAttempts?: number;
};

function createTestService(
  storage: ClockStorage,
  options: TestServiceOptions = {},
) {
  const sockets: FakeWebSocket[] = [];
  const scheduler = new FakeReconnectScheduler();
  const events: Record<string, unknown>[] = [];
  const savedRegistration = Object.hasOwn(options, "registration")
    ? options.registration
    : registration();
  const streamToken = Object.hasOwn(options, "streamToken")
    ? options.streamToken
    : STREAM_TOKEN;
  let remainingFailedOpens = options.failOpenAttempts ?? 0;
  let registrationTokenLoads = 0;
  const service = createClockService({
    storage: {
      ...storage,
      getRegistrationToken: async () => {
        registrationTokenLoads += 1;
        return streamToken;
      },
    },
    getRegistration: async () => savedRegistration,
    getIrradiance: options.getIrradiance ?? (async () => 900),
    now: () => new Date(CONNECTED_AT),
    openWebSocket: (url: string) => {
      if (options.failOpen || remainingFailedOpens > 0) {
        remainingFailedOpens = Math.max(0, remainingFailedOpens - 1);
        throw new Error(`open failed for ${url}`);
      }
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    scheduleReconnect: scheduler.schedule,
    cancelReconnect: scheduler.cancel,
    onPublicEvent: (event: Record<string, unknown>) => events.push(event),
  });
  return {
    events,
    scheduler,
    service,
    sockets,
    failNextOpen() {
      remainingFailedOpens += 1;
    },
    registrationTokenLoads() {
      return registrationTokenLoads;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Condition did not become true.");
}

describe("clock service", () => {
  test("listen on persists connecting intent and rejects manual ticks without mutation", async () => {
    const initialState = normalizeState({ power: { powerConsumedTicks: 7 } });
    await writeSqliteState(path, initialState);
    const storage = createClockStorage(path);
    const { service } = createTestService(storage);

    const listening = service.listenOn();
    const manualTick = service.manualTick(1);

    expect(await listening).toEqual({
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "connecting",
      latestPlanetTick: null,
      latestAdvancedBy: null,
      lastConnectedAt: null,
      lastMessageAt: null,
      latestError: null,
      manualTicksAllowed: false,
    });
    const before = await readSqliteState(path);

    await expect(manualTick).rejects.toThrow("habitat clock listen off");

    expect(await readSqliteState(path)).toEqual(before);
    expect(await service.getStatus()).toEqual({
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "connecting",
      latestPlanetTick: null,
      latestAdvancedBy: null,
      lastConnectedAt: null,
      lastMessageAt: null,
      latestError: null,
      manualTicksAllowed: false,
    });
  });

  test("manual ticks apply shared simulation advancement in manual mode", async () => {
    const initialState = poweredState();
    await writeSqliteState(path, initialState);
    const { service } = createTestService(createClockStorage(path), {
      getIrradiance: async () => 900,
    });

    const result = await service.manualTick(10);

    expect(result.energyCost).toBe(30);
    expect(result.data.power.powerConsumedTicks).toBe(32);
    expect(await readSqliteState(path)).toEqual(result.data);
  });

  for (const clockState of [
    { label: "Kepler mode", mode: "kepler" as const, listeningEnabled: false },
    { label: "listener intent", mode: "manual" as const, listeningEnabled: true },
  ]) {
    test(`manual ticks reject persisted ${clockState.label} alone`, async () => {
      const initialState = poweredState();
      await writeSqliteState(path, initialState);
      const storage = createClockStorage(path);
      await storage.saveClockState({
        ...DEFAULT_CLOCK_STATE,
        mode: clockState.mode,
        listeningEnabled: clockState.listeningEnabled,
      });
      let irradianceCalls = 0;
      const { service } = createTestService(storage, {
        getIrradiance: async () => {
          irradianceCalls += 1;
          return 900;
        },
      });

      await expect(service.manualTick(1)).rejects.toThrow("habitat clock listen off");

      expect(irradianceCalls).toBe(0);
      expect(await readSqliteState(path)).toEqual(initialState);
    });
  }

  for (const advancedBy of [1, 10, 100]) {
    test(`remote advancedBy ${advancedBy} equals manual ${advancedBy}`, async () => {
      const manualPath = join(temp, `manual-${advancedBy}.sqlite`);
      const remotePath = join(temp, `remote-${advancedBy}.sqlite`);
      await writeSqliteState(manualPath, poweredState());
      await writeSqliteState(remotePath, poweredState());
      const { service: manual } = createTestService(createClockStorage(manualPath), {
        getIrradiance: async () => 900,
      });
      const { service: remote } = createTestService(createClockStorage(remotePath), {
        getIrradiance: async () => 900,
      });
      await remote.listenOn();

      const manualResult = await manual.manualTick(advancedBy);
      const remoteResult = await remote.applyValidatedNotice(planetTick({
        tick: 1_000 + advancedBy,
        advancedBy,
      }));

      expect(remoteResult).toEqual({ ...manualResult, applied: true });
      expect(await readSqliteState(remotePath)).toEqual(await readSqliteState(manualPath));
    });
  }

  test("duplicate and older absolute planet ticks do not advance or move the cursor", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    const { service } = createTestService(storage);
    await service.listenOn();
    const currentNotice = planetTick({ tick: 900, advancedBy: 10 });
    expect((await service.applyValidatedNotice(currentNotice)).applied).toBe(true);
    const stateAfterCurrent = await readSqliteState(path);
    const clockAfterCurrent = await storage.getClockState();

    expect(await service.applyValidatedNotice(currentNotice)).toEqual({ applied: false });
    expect(await service.applyValidatedNotice(planetTick({ tick: 899, advancedBy: 1 })))
      .toEqual({ applied: false });

    expect(await readSqliteState(path)).toEqual(stateAfterCurrent);
    expect(await storage.getClockState()).toEqual(clockAfterCurrent);
  });

  for (const invalid of [
    { label: "zero", value: 0 },
    { label: "negative", value: -1 },
    { label: "fractional", value: 1.5 },
    { label: "missing", value: undefined },
    { label: "nonnumeric", value: "10" },
  ]) {
    test(`invalid ${invalid.label} advancedBy is ignored without mutation`, async () => {
      await writeSqliteState(path, poweredState());
      const storage = createClockStorage(path);
      const { service } = createTestService(storage);
      await service.listenOn();
      const invalidNotice = { ...planetTick() } as Record<string, unknown>;
      if (invalid.value === undefined) {
        delete invalidNotice.advancedBy;
      } else {
        invalidNotice.advancedBy = invalid.value;
      }
      const beforeState = await readSqliteState(path);
      const beforeClock = await storage.getClockState();

      expect(await service.applyValidatedNotice(invalidNotice as unknown as PlanetTickNotice))
        .toEqual({ applied: false });
      expect(await readSqliteState(path)).toEqual(beforeState);
      expect(await storage.getClockState()).toEqual(beforeClock);
    });
  }

  for (const invalid of [
    {
      label: "unsafe tick",
      notice: planetTick({
        previousTick: Number.MAX_SAFE_INTEGER - 9,
        tick: Number.MAX_SAFE_INTEGER + 1,
        advancedBy: 10,
      }),
    },
    {
      label: "unsafe advancedBy",
      notice: planetTick({
        previousTick: 0,
        tick: Number.MAX_SAFE_INTEGER + 1,
        advancedBy: Number.MAX_SAFE_INTEGER + 1,
      }),
    },
  ]) {
    test(`${invalid.label} is rejected before local clock dependencies run`, async () => {
      await writeSqliteState(path, poweredState());
      let irradianceCalls = 0;
      const { service } = createTestService(createClockStorage(path), {
        getIrradiance: async () => {
          irradianceCalls += 1;
          throw new Error("unsafe notice reached irradiance lookup");
        },
      });
      await service.listenOn();

      await expect(service.applyValidatedNotice(invalid.notice)).resolves.toEqual({
        applied: false,
      });
      expect(irradianceCalls).toBe(0);
    });
  }

  test("listen off rejects new notices immediately and drains an accepted notice before persisting manual mode", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    const irradianceRequested = deferred<void>();
    const irradiance = deferred<number>();
    const { service } = createTestService(storage, {
      getIrradiance: async () => {
        irradianceRequested.resolve();
        return irradiance.promise;
      },
    });
    await service.listenOn();
    const acceptedNotice = service.applyValidatedNotice(planetTick());
    await irradianceRequested.promise;

    const switchingOff = service.listenOff();
    const lateNotice = service.applyValidatedNotice(planetTick({ tick: 910 }));

    expect(await lateNotice).toEqual({ applied: false });
    irradiance.resolve(900);
    expect((await acceptedNotice).applied).toBe(true);
    expect(await switchingOff).toEqual({
      mode: "manual",
      listeningEnabled: false,
      connectionState: "disconnected",
      latestPlanetTick: 900,
      latestAdvancedBy: 10,
      lastConnectedAt: null,
      lastMessageAt: "2026-07-16T12:00:00.000Z",
      latestError: null,
      manualTicksAllowed: true,
    });
    expect((await readSqliteState(path))?.power.powerConsumedTicks).toBe(32);
  });

  test("listen off supersedes a pending listen on acceptance generation", async () => {
    await writeSqliteState(path, poweredState());
    let irradianceCalls = 0;
    const { service } = createTestService(createClockStorage(path), {
      getIrradiance: async () => {
        irradianceCalls += 1;
        return 900;
      },
    });

    const switchingOn = service.listenOn();
    const switchingOff = service.listenOff();
    await switchingOn;
    await switchingOff;

    expect(await service.applyValidatedNotice(planetTick())).toEqual({ applied: false });
    expect(irradianceCalls).toBe(0);
    expect(await service.getStatus()).toEqual({
      mode: "manual",
      listeningEnabled: false,
      connectionState: "disconnected",
      latestPlanetTick: null,
      latestAdvancedBy: null,
      lastConnectedAt: null,
      lastMessageAt: null,
      latestError: null,
      manualTicksAllowed: true,
    });
  });

  test("listen on opens the saved URL and sends the exact token hello first", async () => {
    await writeSqliteState(path, poweredState());
    const { service, sockets } = createTestService(createClockStorage(path));

    await service.listenOn();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(STREAM_URL);
    expect(sockets[0].url).not.toContain(STREAM_TOKEN);
    expect(sockets[0].sent).toEqual([]);

    sockets[0].open();

    expect(sockets[0].sent).toHaveLength(1);
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: "hello",
      apiToken: STREAM_TOKEN,
      subscribe: ["ticks"],
    });
  });

  test("listen on refuses a registration that did not advertise ticks", async () => {
    await writeSqliteState(path, poweredState());
    const saved = registration({
      stream: {
        protocolVersion: "2026-06-24",
        subscriptions: ["alerts"],
        currentTick: 800,
        tickIntervalMs: 1_000,
        ticksPerPulse: 10,
        status: "running",
      },
    });
    const { service, sockets } = createTestService(createClockStorage(path), {
      registration: saved,
    });

    const status = await service.listenOn();

    expect(sockets).toEqual([]);
    expect(status).toEqual(expect.objectContaining({
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "error",
    }));
    expect(status.latestError).toContain("ticks");
    expect(JSON.stringify(status)).not.toContain(STREAM_TOKEN);
  });

  test("listen on contains malformed saved stream metadata", async () => {
    await writeSqliteState(path, poweredState());
    const malformed = registration({
      stream: { subscriptions: null } as unknown as HabitatRegistration["stream"],
    });
    const { service, sockets } = createTestService(createClockStorage(path), {
      registration: malformed,
    });

    const status = await service.listenOn();

    expect(sockets).toEqual([]);
    expect(status.connectionState).toBe("error");
    expect(status.latestError).toContain("metadata");
  });

  test("listen on refuses a saved stream URL that already contains the isolated token", async () => {
    await writeSqliteState(path, poweredState());
    const { service, sockets } = createTestService(createClockStorage(path), {
      registration: registration({ streamUrl: `${STREAM_URL}?token=${STREAM_TOKEN}` }),
    });

    const status = await service.listenOn();

    expect(sockets).toEqual([]);
    expect(status.connectionState).toBe("error");
    expect(JSON.stringify(status)).not.toContain(STREAM_TOKEN);
  });

  test("listen on never sends the isolated token to an untrusted stream host", async () => {
    await writeSqliteState(path, poweredState());
    const { registrationTokenLoads, service, sockets } = createTestService(createClockStorage(path), {
      registration: registration({ streamUrl: "wss://attacker.example/collect" }),
    });

    const status = await service.listenOn();

    expect(sockets).toEqual([]);
    expect(status.connectionState).toBe("error");
    expect(status.latestError).toContain("trusted Kepler");
    expect(registrationTokenLoads()).toBe(0);
    expect(JSON.stringify(status)).not.toContain(STREAM_TOKEN);
  });

  test("listen on rejects stream URL userinfo before loading the isolated token", async () => {
    await writeSqliteState(path, poweredState());
    const { registrationTokenLoads, service, sockets } = createTestService(
      createClockStorage(path),
      {
        registration: registration({
          streamUrl: "wss://intruder@planet.turingguild.com/planet/stream",
        }),
      },
    );

    const status = await service.listenOn();

    expect(sockets).toEqual([]);
    expect(status.connectionState).toBe("error");
    expect(status.latestError).toContain("trusted Kepler");
    expect(registrationTokenLoads()).toBe(0);
  });

  for (const encodedToken of [
    "%66ixture-stream-token",
    "fixture%2Dstream%2Dtoken",
  ]) {
    test(`listen on refuses an equivalent percent-encoded token URL (${encodedToken})`, async () => {
      await writeSqliteState(path, poweredState());
      const { service, sockets } = createTestService(createClockStorage(path), {
        registration: registration({ streamUrl: `${STREAM_URL}?token=${encodedToken}` }),
      });

      const status = await service.listenOn();

      expect(sockets).toEqual([]);
      expect(status.connectionState).toBe("error");
      expect(JSON.stringify(status)).not.toContain(STREAM_TOKEN);
    });
  }

  test("listen on contains malformed URL encoding before socket open", async () => {
    await writeSqliteState(path, poweredState());
    const { service, sockets } = createTestService(createClockStorage(path), {
      registration: registration({ streamUrl: `${STREAM_URL}?cursor=%ZZ` }),
    });

    const status = await service.listenOn();

    expect(sockets).toEqual([]);
    expect(status.connectionState).toBe("error");
    expect(status.latestError).toContain("URL");
    expect(JSON.stringify(status)).not.toContain(STREAM_TOKEN);
  });

  test("listen on preserves a legitimate percent-encoded non-token URL", async () => {
    await writeSqliteState(path, poweredState());
    const safeUrl = `${STREAM_URL}?topic=planet%20ticks`;
    const { service, sockets } = createTestService(createClockStorage(path), {
      registration: registration({ streamUrl: safeUrl }),
    });

    const status = await service.listenOn();

    expect(status.connectionState).toBe("connecting");
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(safeUrl);
  });

  for (const failure of [
    { label: "missing registration", options: { registration: undefined } },
    { label: "missing isolated token", options: { streamToken: undefined } },
    { label: "socket open failure", options: { failOpen: true } },
  ] as const) {
    test(`listen on retains Kepler intent after ${failure.label}`, async () => {
      await writeSqliteState(path, poweredState());
      const { service, sockets } = createTestService(
        createClockStorage(path),
        failure.options,
      );

      const status = await service.listenOn();

      expect(status).toEqual(expect.objectContaining({
        mode: "kepler",
        listeningEnabled: true,
        connectionState: "error",
        latestError: expect.any(String),
      }));
      expect(JSON.stringify(status)).not.toContain(STREAM_TOKEN);
      expect(sockets.length).toBeLessThanOrEqual(1);
    });
  }

  test("ticks before a valid acknowledgement and malformed JSON are contained", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    const { events, service, sockets } = createTestService(storage);
    await service.listenOn();
    sockets[0].open();
    const before = await readSqliteState(path);

    sockets[0].message(planetTick({ previousTick: 800, tick: 810, advancedBy: 10 }));
    await service.getStatus();
    await expect(service.handleRawMessage("{not-json")).resolves.toBeUndefined();

    expect(await readSqliteState(path)).toEqual(before);
    expect((await storage.getClockState()).latestPlanetTick).toBeNull();
    expect(events).toEqual([]);
  });

  for (const invalid of [
    { label: "connectionId", override: { connectionId: undefined } },
    { label: "subscriptions", override: { subscriptions: [] } },
    { label: "currentTick", override: { currentTick: -1 } },
    { label: "catchUpTicks", override: { catchUpTicks: 1.5 } },
    { label: "tickIntervalMs", override: { tickIntervalMs: 0 } },
    { label: "ticksPerPulse", override: { ticksPerPulse: 1.5 } },
    {
      label: "safe-integer currentTick",
      override: { currentTick: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      label: "safe-integer catchUpTicks",
      override: { catchUpTicks: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      label: "safe-integer tickIntervalMs",
      override: { tickIntervalMs: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      label: "safe-integer ticksPerPulse",
      override: { ticksPerPulse: Number.MAX_SAFE_INTEGER + 1 },
    },
    { label: "clockStatus", override: { clockStatus: "stopped" } },
    { label: "serverTime", override: { serverTime: "not-a-time" } },
    { label: "numeric serverTime", override: { serverTime: "123" } },
    {
      label: "impossible serverTime",
      override: { serverTime: "2026-02-30T12:00:00.000Z" },
    },
  ]) {
    test(`hello acknowledgement requires valid ${invalid.label}`, async () => {
      await writeSqliteState(path, poweredState());
      const storage = createClockStorage(path);
      const { events, service, sockets } = createTestService(storage);
      await service.listenOn();
      sockets[0].open();

      sockets[0].message(helloAck(invalid.override));
      const status = await service.getStatus();

      expect(status.connectionState).toBe("error");
      expect(status.latestError).toContain("acknowledgement");
      expect(JSON.stringify(status)).not.toContain(STREAM_TOKEN);
      expect(events).toEqual([]);
      expect((await storage.getClockState()).latestPlanetTick).toBeNull();
    });
  }

  test("a mismatched acknowledgement Habitat ID is rejected with a redacted error", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    const { service, sockets } = createTestService(storage);
    await service.listenOn();
    sockets[0].open();

    sockets[0].message(helloAck({ habitatId: "habitat_other" }));
    const status = await service.getStatus();

    expect(status.connectionState).toBe("error");
    expect(status.latestError).toContain("Habitat ID");
    expect(JSON.stringify(status)).not.toContain(STREAM_TOKEN);
    expect((await storage.getClockState()).latestPlanetTick).toBeNull();
  });

  test("a full acknowledgement connects and valid future ticks emit the public event", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    const { events, service, sockets } = createTestService(storage);
    await service.listenOn();
    sockets[0].open();

    sockets[0].message(helloAck());
    expect(await service.getStatus()).toEqual(expect.objectContaining({
      connectionState: "connected",
      lastConnectedAt: CONNECTED_AT,
      latestError: null,
    }));

    const notice = planetTick({
      previousTick: 800,
      tick: 810,
      advancedBy: 10,
      issuedAt: "2026-07-16T12:00:02.000Z",
    });
    sockets[0].message(notice);
    const status = await service.getStatus();

    expect(status.latestPlanetTick).toBe(810);
    expect(events).toEqual([{
      type: "planet_tick",
      tick: 810,
      advancedBy: 10,
      issuedAt: "2026-07-16T12:00:02.000Z",
      applied: true,
    }]);
    expect(JSON.stringify(events)).not.toContain(STREAM_TOKEN);
  });

  test("invalid, malformed, and non-future planet ticks never mutate or emit", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    const { events, service, sockets } = createTestService(storage);
    await service.listenOn();
    sockets[0].open();
    sockets[0].message(helloAck());
    await service.getStatus();
    const beforeState = await readSqliteState(path);
    const beforeClock = await storage.getClockState();
    const invalidNotices = [
      planetTick({ previousTick: -1, tick: 9, advancedBy: 10 }),
      planetTick({ previousTick: 800.5, tick: 810.5, advancedBy: 10 }),
      planetTick({ previousTick: 800, tick: 810.5, advancedBy: 10 }),
      planetTick({ previousTick: 800, tick: 810, advancedBy: 0 }),
      planetTick({ previousTick: 800, tick: 811, advancedBy: 10 }),
      planetTick({ previousTick: 800, tick: 810, advancedBy: 10, secondsPerTick: 0.24 }),
      planetTick({ previousTick: 800, tick: 810, advancedBy: 10, secondsPerTick: 60.01 }),
      planetTick({ previousTick: 800, tick: 810, advancedBy: 10, issuedAt: "invalid" }),
      planetTick({ previousTick: 800, tick: 810, advancedBy: 10, issuedAt: "123" }),
      planetTick({
        previousTick: 800,
        tick: 810,
        advancedBy: 10,
        issuedAt: "2026-02-30T12:00:00.000Z",
      }),
      planetTick({ previousTick: 790, tick: 800, advancedBy: 10 }),
      planetTick({ previousTick: 790, tick: 810, advancedBy: 20 }),
    ];

    for (const notice of invalidNotices) sockets[0].message(notice);
    await service.getStatus();

    expect(await readSqliteState(path)).toEqual(beforeState);
    expect(await storage.getClockState()).toEqual(beforeClock);
    expect(events).toEqual([]);
  });

  test("valid notices observed before close drain in FIFO order before session retirement", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    const { events, scheduler, service, sockets } = createTestService(storage);
    await service.listenOn();
    sockets[0].open();

    sockets[0].message(helloAck());
    sockets[0].message(planetTick({ previousTick: 800, tick: 810, advancedBy: 10 }));
    sockets[0].message(planetTick({ previousTick: 810, tick: 820, advancedBy: 10 }));
    sockets[0].unexpectedClose();
    const status = await service.getStatus();

    expect(status.connectionState).toBe("disconnected");
    expect(status.latestPlanetTick).toBe(820);
    expect(events.map((event) => event.tick)).toEqual([810, 820]);
    expect((await readSqliteState(path))?.power.powerConsumedTicks).toBe(62);
    expect(scheduler.scheduled.size).toBe(1);
  });

  test("valid notices observed before socket error drain in FIFO order before session retirement", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    const { events, scheduler, service, sockets } = createTestService(storage);
    await service.listenOn();
    sockets[0].open();

    sockets[0].message(helloAck());
    sockets[0].message(planetTick({ previousTick: 800, tick: 810, advancedBy: 10 }));
    sockets[0].message(planetTick({ previousTick: 810, tick: 820, advancedBy: 10 }));
    sockets[0].error();
    const status = await service.getStatus();

    expect(status.connectionState).toBe("error");
    expect(status.latestPlanetTick).toBe(820);
    expect(events.map((event) => event.tick)).toEqual([810, 820]);
    expect((await readSqliteState(path))?.power.powerConsumedTicks).toBe(62);
    expect(scheduler.scheduled.size).toBe(1);
  });

  test("unexpected close schedules exactly one replacement socket", async () => {
    await writeSqliteState(path, poweredState());
    const { scheduler, service, sockets } = createTestService(createClockStorage(path));
    await service.listenOn();
    sockets[0].open();
    sockets[0].message(helloAck());
    await service.getStatus();

    sockets[0].unexpectedClose();
    sockets[0].unexpectedClose();
    const disconnected = await service.getStatus();

    expect(disconnected.connectionState).toBe("disconnected");
    expect(disconnected.latestError).toContain("closed");
    expect(scheduler.scheduled.size).toBe(1);
    expect([...scheduler.scheduled.values()][0].delayMs).toBeGreaterThan(0);

    scheduler.runNext();
    await service.getStatus();

    expect(sockets).toHaveLength(2);
    expect(scheduler.scheduled.size).toBe(0);
  });

  test("unexpected close does not reconnect after persisted intent is cleared", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    const { scheduler, service, sockets } = createTestService(storage);
    await service.listenOn();
    sockets[0].open();
    sockets[0].message(helloAck());
    await service.getStatus();
    await storage.saveClockState({
      ...await storage.getClockState(),
      mode: "manual",
      listeningEnabled: false,
      connectionState: "disconnected",
    });

    sockets[0].unexpectedClose();
    await service.getStatus();

    expect(scheduler.scheduled.size).toBe(0);
  });

  test("socket error schedules one reconnect and ignores stale callbacks", async () => {
    await writeSqliteState(path, poweredState());
    const { events, scheduler, service, sockets } = createTestService(createClockStorage(path));
    await service.listenOn();
    sockets[0].open();

    sockets[0].error();
    await service.getStatus();
    expect(scheduler.scheduled.size).toBe(1);
    scheduler.runNext();
    await service.getStatus();
    expect(sockets).toHaveLength(2);

    sockets[0].message(helloAck());
    sockets[0].message(planetTick({ previousTick: 800, tick: 810, advancedBy: 10 }));
    await service.getStatus();
    expect(events).toEqual([]);
  });

  for (const disconnection of ["close", "error"] as const) {
    for (const failingOperation of ["read", "save"] as const) {
      test(`${disconnection} bookkeeping ${failingOperation} failure still schedules reconnect`, async () => {
        await writeSqliteState(path, poweredState());
        const baseStorage = createClockStorage(path);
        let failNextBookkeepingOperation = false;
        const bookkeepingFailure = deferred<void>();
        const storage: ClockStorage = {
          ...baseStorage,
          getClockState: async () => {
            if (failingOperation === "read" && failNextBookkeepingOperation) {
              failNextBookkeepingOperation = false;
              bookkeepingFailure.resolve();
              throw new Error("fixture disconnect read failure");
            }
            return baseStorage.getClockState();
          },
          saveClockState: async (state) => {
            if (failingOperation === "save" && failNextBookkeepingOperation) {
              failNextBookkeepingOperation = false;
              bookkeepingFailure.resolve();
              throw new Error("fixture disconnect save failure");
            }
            return baseStorage.saveClockState(state);
          },
        };
        const { scheduler, service, sockets } = createTestService(storage);
        await service.listenOn();
        sockets[0].open();
        sockets[0].message(helloAck());
        await service.getStatus();

        failNextBookkeepingOperation = true;
        if (disconnection === "close") sockets[0].unexpectedClose();
        else sockets[0].error();
        await bookkeepingFailure.promise;
        await waitUntil(() => scheduler.scheduled.size === 1);

        scheduler.runNext();
        await service.getStatus();
        expect(sockets).toHaveLength(2);
      });
    }
  }

  test("a failed reconnect attempt schedules another retry without clearing intent", async () => {
    await writeSqliteState(path, poweredState());
    const { failNextOpen, scheduler, service, sockets } = createTestService(createClockStorage(path));
    await service.listenOn();
    sockets[0].open();
    sockets[0].unexpectedClose();
    await service.getStatus();
    expect(scheduler.scheduled.size).toBe(1);

    failNextOpen();
    scheduler.runNext();
    await service.getStatus();

    expect(await service.getStatus()).toEqual(expect.objectContaining({
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "error",
    }));
    expect(scheduler.scheduled.size).toBe(1);

    scheduler.runNext();
    await service.getStatus();
    expect(sockets).toHaveLength(2);
    expect((await service.getStatus()).connectionState).toBe("connecting");
  });

  for (const failingOperation of ["read", "save"] as const) {
    test(`a reconnect clock-state ${failingOperation} failure schedules another retry`, async () => {
      await writeSqliteState(path, poweredState());
      const baseStorage = createClockStorage(path);
      let failNextReconnectOperation = false;
      const reconnectFailure = deferred<void>();
      const storage: ClockStorage = {
        ...baseStorage,
        getClockState: async () => {
          if (failingOperation === "read" && failNextReconnectOperation) {
            failNextReconnectOperation = false;
            reconnectFailure.resolve();
            throw new Error("fixture reconnect read failure");
          }
          return baseStorage.getClockState();
        },
        saveClockState: async (state) => {
          if (failingOperation === "save" && failNextReconnectOperation) {
            failNextReconnectOperation = false;
            reconnectFailure.resolve();
            throw new Error("fixture reconnect save failure");
          }
          return baseStorage.saveClockState(state);
        },
      };
      const { scheduler, service, sockets } = createTestService(storage);
      await service.listenOn();
      sockets[0].open();
      sockets[0].message(helloAck());
      await service.getStatus();
      sockets[0].unexpectedClose();
      await service.getStatus();

      failNextReconnectOperation = true;
      scheduler.runNext();
      await reconnectFailure.promise;
      await waitUntil(() => scheduler.scheduled.size === 1);

      scheduler.runNext();
      await service.getStatus();
      expect(sockets).toHaveLength(2);
      expect((await service.getStatus()).connectionState).toBe("connecting");
    });
  }

  test("an accepted notice retries a transient irradiance failure without reconnect catch-up loss", async () => {
    await writeSqliteState(path, poweredState());
    let irradianceAttempts = 0;
    const failedAttempt = deferred<void>();
    const storage = createClockStorage(path);
    const { events, scheduler, service, sockets } = createTestService(storage, {
      getIrradiance: async () => {
        irradianceAttempts += 1;
        if (irradianceAttempts === 1) {
          failedAttempt.resolve();
          throw new Error("fixture irradiance failure");
        }
        return 900;
      },
    });
    await service.listenOn();
    sockets[0].open();
    sockets[0].message(helloAck());
    await service.getStatus();

    sockets[0].message(planetTick({ previousTick: 800, tick: 810, advancedBy: 10 }));
    await failedAttempt.promise;
    await waitUntil(() => scheduler.scheduled.size === 1);
    scheduler.runNext();
    const status = await service.getStatus();

    expect(status.latestPlanetTick).toBe(810);
    expect(irradianceAttempts).toBe(2);
    expect(sockets).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ tick: 810, applied: true })]);
    expect((await readSqliteState(path))?.power.powerConsumedTicks).toBe(32);
  });

  test("status remains responsive while an accepted notice waits through a persistent local failure", async () => {
    await writeSqliteState(path, poweredState());
    const failedAttempt = deferred<void>();
    const storage = createClockStorage(path);
    const { scheduler, service, sockets } = createTestService(storage, {
      getIrradiance: async () => {
        failedAttempt.resolve();
        throw new Error("fixture persistent irradiance failure");
      },
    });
    await service.listenOn();
    sockets[0].open();
    sockets[0].message(helloAck());
    await service.getStatus();
    sockets[0].message(planetTick({ previousTick: 800, tick: 810, advancedBy: 10 }));
    await failedAttempt.promise;
    await waitUntil(() => scheduler.scheduled.size === 1);

    let statusResolved = false;
    const statusRequest = service.getStatus().then((status) => {
      statusResolved = true;
      return status;
    });
    await waitUntil(() => statusResolved);

    expect(await statusRequest).toEqual(expect.objectContaining({
      connectionState: "connected",
      latestPlanetTick: null,
    }));
    expect(scheduler.scheduled.size).toBe(1);
    await service.stop();
  });

  test("an accepted notice retry is idempotent when storage committed before reporting failure", async () => {
    await writeSqliteState(path, poweredState());
    const baseStorage = createClockStorage(path);
    const committedAttempt = deferred<void>();
    let storageAttempts = 0;
    const storage: ClockStorage = {
      ...baseStorage,
      applyPlanetTick: async (notice, mutator) => {
        storageAttempts += 1;
        const result = await baseStorage.applyPlanetTick(notice, mutator);
        if (storageAttempts === 1) {
          committedAttempt.resolve();
          throw new Error("fixture post-commit storage failure");
        }
        return result;
      },
    };
    const { events, scheduler, service, sockets } = createTestService(storage);
    await service.listenOn();
    sockets[0].open();
    sockets[0].message(helloAck());
    await service.getStatus();

    sockets[0].message(planetTick({ previousTick: 800, tick: 810, advancedBy: 10 }));
    await committedAttempt.promise;
    await waitUntil(() => scheduler.scheduled.size === 1);
    scheduler.runNext();
    const status = await service.getStatus();

    expect(status.latestPlanetTick).toBe(810);
    expect(storageAttempts).toBe(2);
    expect(events).toEqual([expect.objectContaining({ tick: 810, applied: false })]);
    expect((await readSqliteState(path))?.power.powerConsumedTicks).toBe(32);
  });

  test("listen off cancels a pending retry and prevents it from applying in manual mode", async () => {
    await writeSqliteState(path, poweredState());
    let irradianceAttempts = 0;
    const failedAttempt = deferred<void>();
    const storage = createClockStorage(path);
    const { scheduler, service, sockets } = createTestService(storage, {
      getIrradiance: async () => {
        irradianceAttempts += 1;
        if (irradianceAttempts === 1) {
          failedAttempt.resolve();
          throw new Error("fixture irradiance failure");
        }
        return 900;
      },
    });
    await service.listenOn();
    sockets[0].open();
    sockets[0].message(helloAck());
    await service.getStatus();
    sockets[0].message(planetTick({ previousTick: 800, tick: 810, advancedBy: 10 }));
    await failedAttempt.promise;
    await waitUntil(() => scheduler.scheduled.size === 1);

    const switchingOff = service.listenOff();
    expect(await service.applyValidatedNotice(
      planetTick({ previousTick: 810, tick: 820, advancedBy: 10 }),
    )).toEqual({ applied: false });
    expect(scheduler.scheduled.size).toBe(0);
    const status = await switchingOff;

    expect(status.mode).toBe("manual");
    expect(status.latestPlanetTick).toBeNull();
    expect((await readSqliteState(path))?.power.powerConsumedTicks).toBe(2);
  });

  test("stop cancels an accepted notice retry so shutdown completes cleanly", async () => {
    await writeSqliteState(path, poweredState());
    const failedAttempt = deferred<void>();
    const storage = createClockStorage(path);
    const { scheduler, service, sockets } = createTestService(storage, {
      getIrradiance: async () => {
        failedAttempt.resolve();
        throw new Error("fixture persistent irradiance failure");
      },
    });
    await service.listenOn();
    sockets[0].open();
    sockets[0].message(helloAck());
    await service.getStatus();
    sockets[0].message(planetTick({ previousTick: 800, tick: 810, advancedBy: 10 }));
    await failedAttempt.promise;
    await waitUntil(() => scheduler.scheduled.size === 1);

    const status = await service.stop();

    expect(status.connectionState).toBe("disconnected");
    expect(status.latestPlanetTick).toBeNull();
    expect(scheduler.scheduled.size).toBe(0);
  });

  test("stop cancels reconnect, closes cleanly, drains work, and preserves intent", async () => {
    await writeSqliteState(path, poweredState());
    const { scheduler, service, sockets } = createTestService(createClockStorage(path));
    await service.listenOn();
    sockets[0].open();
    sockets[0].unexpectedClose();
    await service.getStatus();
    expect(scheduler.scheduled.size).toBe(1);

    const status = await service.stop();

    expect(scheduler.scheduled.size).toBe(0);
    expect(status).toEqual(expect.objectContaining({
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "disconnected",
    }));
    expect(await service.applyValidatedNotice(planetTick())).toEqual({ applied: false });
    expect(sockets[0].closeCalls).toBe(0);
  });

  test("stop can explicitly clear persisted listening intent", async () => {
    await writeSqliteState(path, poweredState());
    const { service, sockets } = createTestService(createClockStorage(path));
    await service.listenOn();
    sockets[0].open();

    const status = await service.stop({ preserveListening: false });

    expect(sockets[0].closeCalls).toBe(1);
    expect(status).toEqual(expect.objectContaining({
      mode: "manual",
      listeningEnabled: false,
      connectionState: "disconnected",
    }));
  });

  test("stop is terminal and a concurrent listen on cannot revive the socket", async () => {
    await writeSqliteState(path, poweredState());
    const { service, sockets } = createTestService(createClockStorage(path));
    await service.listenOn();

    const stopping = service.stop({ preserveListening: true });
    const lateListen = service.listenOn();
    const repeatedStop = service.stop({ preserveListening: true });

    expect(lateListen).toBe(stopping);
    expect(repeatedStop).toBe(stopping);
    expect(await stopping).toEqual(expect.objectContaining({
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "disconnected",
    }));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closeCalls).toBe(1);
  });

  test("start resumes persisted Kepler intent only once", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    await storage.saveClockState({
      ...DEFAULT_CLOCK_STATE,
      mode: "kepler",
      listeningEnabled: true,
      connectionState: "disconnected",
    });
    const { service, sockets } = createTestService(storage);

    await service.start();
    await service.start();

    expect(sockets).toHaveLength(1);
    expect((await service.getStatus()).connectionState).toBe("connecting");
  });

  test("a reconnect acknowledgement sets a new no-catch-up session floor", async () => {
    await writeSqliteState(path, poweredState());
    const storage = createClockStorage(path);
    const { events, scheduler, service, sockets } = createTestService(storage);
    await service.listenOn();
    sockets[0].open();
    sockets[0].message(helloAck({ currentTick: 800 }));
    sockets[0].message(planetTick({ previousTick: 800, tick: 810, advancedBy: 10 }));
    await service.getStatus();

    sockets[0].unexpectedClose();
    await service.getStatus();
    scheduler.runNext();
    await service.getStatus();
    sockets[1].open();
    sockets[1].message(helloAck({ currentTick: 1_000 }));
    sockets[1].message(planetTick({ previousTick: 810, tick: 820, advancedBy: 10 }));
    sockets[1].message(planetTick({ previousTick: 1_000, tick: 1_010, advancedBy: 10 }));
    const status = await service.getStatus();

    expect(status.latestPlanetTick).toBe(1_010);
    expect(events.map((event) => event.tick)).toEqual([810, 1_010]);
  });
});
