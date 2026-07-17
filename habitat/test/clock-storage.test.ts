import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createClockStorage,
  type StateMutationResult,
} from "../src/clock/storage";
import {
  DEFAULT_CLOCK_STATE,
  type ClockState,
  type PlanetTickNotice,
} from "../src/clock/types";
import { createStateService, normalizeState } from "../src/state/service";
import type { HabitatState } from "../src/state/types";
import {
  attachHabitatStateRevision,
  getHabitatStateRevision,
  readSqliteState,
  writeSqliteState,
} from "../src/storage";

const STREAM_TOKEN = "fixture-stream-token";

const notice: PlanetTickNotice = {
  type: "planet_tick",
  previousTick: 800,
  tick: 900,
  advancedBy: 100,
  secondsPerTick: 1,
  issuedAt: "2026-07-16T12:00:00.000Z",
};

let temp: string;
let path: string;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "habitat-clock-storage-"));
  path = join(temp, "habitat.sqlite");
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

function keplerClockState(overrides: Partial<ClockState> = {}): ClockState {
  return {
    ...DEFAULT_CLOCK_STATE,
    mode: "kepler",
    listeningEnabled: true,
    connectionState: "connected",
    ...overrides,
  };
}

describe("clock storage", () => {
  test("migration restricts the storage directory and database to the local user", async () => {
    const habitatDirectory = join(temp, ".habitat");
    const habitatPath = join(habitatDirectory, "habitat.sqlite");
    await mkdir(habitatDirectory);
    await chmod(habitatDirectory, 0o755);
    const storage = createClockStorage(habitatPath);

    await storage.migrate();

    expect((await stat(habitatDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(habitatPath)).mode & 0o777).toBe(0o600);
  });

  test("migration does not change permissions on an arbitrary existing parent", async () => {
    await chmod(temp, 0o755);
    const storage = createClockStorage(path);

    await storage.migrate();

    expect((await stat(temp)).mode & 0o777).toBe(0o755);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("migration does not chmod the target of a .habitat directory symlink", async () => {
    const sharedDirectory = join(temp, "shared");
    const workspaceDirectory = join(temp, "workspace");
    const linkedHabitatDirectory = join(workspaceDirectory, ".habitat");
    const linkedPath = join(linkedHabitatDirectory, "habitat.sqlite");
    await mkdir(sharedDirectory);
    await mkdir(workspaceDirectory);
    await chmod(sharedDirectory, 0o755);
    await symlink(sharedDirectory, linkedHabitatDirectory);

    await createClockStorage(linkedPath).migrate();

    expect((await stat(sharedDirectory)).mode & 0o777).toBe(0o755);
    expect((await stat(linkedPath)).mode & 0o777).toBe(0o600);
  });

  test("migration preserves the existing habitat JSON and defaults to manual mode", async () => {
    await writeSqliteState(path, normalizeState({ inventory: { water: 9 } }));
    const storage = createClockStorage(path);

    await storage.migrate();
    await storage.migrate();

    expect((await readSqliteState(path) as HabitatState).inventory.water).toBe(9);
    expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);

    const database = new Database(path, { create: false, readwrite: true });
    try {
      expect(database.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 1",
      ).get()?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("legacy habitat rows gain an additive revision without losing JSON", async () => {
    const legacy = normalizeState({ inventory: { water: 11 } });
    const database = new Database(path);
    try {
      database.run("CREATE TABLE habitat_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
      database.query("INSERT INTO habitat_state (key, value_json) VALUES (?, ?)")
        .run("habitat", JSON.stringify(legacy));
    } finally {
      database.close();
    }

    const state = await createStateService({ storagePath: path }).getState();

    expect(state.inventory.water).toBe(11);
    const migrated = new Database(path, { create: false, readwrite: true });
    try {
      const columns = migrated.query<{ name: string }, []>("PRAGMA table_info(habitat_state)").all();
      expect(columns.some((column) => column.name === "revision")).toBe(true);
      expect(migrated.query<{ revision: number }, []>(
        "SELECT revision FROM habitat_state WHERE key = 'habitat'",
      ).get()?.revision).toBe(0);
    } finally {
      migrated.close();
    }
  });

  test("clock state round-trips through the singleton row", async () => {
    const storage = createClockStorage(path);
    const saved = keplerClockState({
      latestPlanetTick: 800,
      latestAdvancedBy: 10,
      lastConnectedAt: "2026-07-16T11:59:00.000Z",
      lastMessageAt: "2026-07-16T12:00:00.000Z",
      latestError: "fixture error",
    });

    await storage.saveClockState(saved);

    expect(await storage.getClockState()).toEqual(saved);
  });

  test("registration token is stored once outside the public state row", async () => {
    const storage = createClockStorage(path);
    const state = normalizeState({
      inventory: { water: 9 },
      registration: {
        displayName: "Habitat One",
        registeredAt: "2026-07-16T12:00:00.000Z",
        lastSyncedAt: "2026-07-16T12:00:00.000Z",
        habitatId: "habitat_1",
        apiToken: STREAM_TOKEN,
      },
    });

    await storage.saveRegistration(state, STREAM_TOKEN);
    await storage.saveRegistration(state, STREAM_TOKEN);

    expect(JSON.stringify(await readSqliteState(path))).not.toContain(STREAM_TOKEN);
    expect(await storage.getRegistrationToken("habitat_1")).toBe(STREAM_TOKEN);

    const database = new Database(path, { create: false, readwrite: true });
    try {
      expect(database.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM habitat_registration_secrets",
      ).get()?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("registration resets an enabled clock to the manual default", async () => {
    const storage = createClockStorage(path);
    await storage.saveClockState(keplerClockState({ latestPlanetTick: 800 }));
    const state = normalizeState({
      registration: {
        displayName: "Habitat One",
        registeredAt: "2026-07-16T12:00:00.000Z",
        lastSyncedAt: "2026-07-16T12:00:00.000Z",
        habitatId: "habitat_1",
      },
    });

    await storage.saveRegistration(state, STREAM_TOKEN);

    expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);
  });

  test("unregister atomically removes public registration and its isolated token", async () => {
    const storage = createClockStorage(path);
    const state = normalizeState({
      inventory: { water: 9 },
      registration: {
        displayName: "Habitat One",
        registeredAt: "2026-07-16T12:00:00.000Z",
        lastSyncedAt: "2026-07-16T12:00:00.000Z",
        habitatId: "habitat_1",
      },
    });
    await storage.saveRegistration(state, STREAM_TOKEN);
    await storage.saveClockState(keplerClockState({ latestPlanetTick: 800 }));

    const result = await storage.deleteRegistration();

    expect(result.registration).toBeUndefined();
    expect(result.inventory.water).toBe(9);
    expect(await storage.getRegistrationToken("habitat_1")).toBeUndefined();
    expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);
    expect(JSON.stringify(await readSqliteState(path)).includes(STREAM_TOKEN)).toBe(false);
  });

  test("full reset atomically clears habitat state, secrets, and clock state", async () => {
    const storage = createClockStorage(path);
    await storage.saveRegistration(normalizeState({
      inventory: { water: 9 },
      registration: {
        displayName: "Habitat One",
        registeredAt: notice.issuedAt,
        lastSyncedAt: notice.issuedAt,
        habitatId: "habitat_1",
      },
    }), STREAM_TOKEN);
    await storage.saveClockState(keplerClockState({ latestPlanetTick: 800 }));
    await storage.saveClockState(DEFAULT_CLOCK_STATE);

    const reset = await storage.resetState();

    expect(reset).toEqual(normalizeState({}));
    expect(await storage.getRegistrationToken("habitat_1")).toBeUndefined();
    expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);
  });

  test("full reset rolls back state and secret deletion when the clock reset fails", async () => {
    const storage = createClockStorage(path);
    const before = normalizeState({
      inventory: { water: 9 },
      registration: {
        displayName: "Habitat One",
        registeredAt: notice.issuedAt,
        lastSyncedAt: notice.issuedAt,
        habitatId: "habitat_1",
      },
    });
    await storage.saveRegistration(before, STREAM_TOKEN);
    const database = new Database(path, { create: false, readwrite: true });
    try {
      database.run(`
        CREATE TRIGGER abort_full_reset_clock_write
        BEFORE UPDATE ON habitat_clock_state
        BEGIN
          SELECT RAISE(ABORT, 'fixture reset clock failure');
        END
      `);
    } finally {
      database.close();
    }

    await expect(storage.resetState()).rejects.toThrow("reset clock failure");

    expect(await readSqliteState(path)).toEqual(before);
    expect(await storage.getRegistrationToken("habitat_1")).toBe(STREAM_TOKEN);
  });

  test("restore preserves server registration and token while resetting the clock cursor", async () => {
    const storage = createClockStorage(path);
    await storage.saveRegistration(normalizeState({
      inventory: { water: 9 },
      registration: {
        displayName: "Habitat One",
        registeredAt: notice.issuedAt,
        lastSyncedAt: notice.issuedAt,
        habitatId: "habitat_1",
        streamUrl: "wss://planet.turingguild.com/planet/stream",
      },
    }), STREAM_TOKEN);
    await storage.saveClockState(DEFAULT_CLOCK_STATE);
    const database = new Database(path, { create: false, readwrite: true });
    try {
      database.query(`
        UPDATE habitat_clock_state
        SET latest_planet_tick = ?, latest_advanced_by = ?, last_message_at = ?
        WHERE id = 1
      `).run(900, 100, notice.issuedAt);
    } finally {
      database.close();
    }

    const restored = await storage.restoreState(normalizeState({
      inventory: { water: 3 },
      registration: {
        displayName: "Backup Impostor",
        registeredAt: notice.issuedAt,
        lastSyncedAt: notice.issuedAt,
        habitatId: "habitat_attacker",
        streamUrl: "wss://attacker.example/collect",
      },
    }));

    expect(restored.inventory.water).toBe(3);
    expect(restored.registration?.displayName).toBe("Habitat One");
    expect(restored.registration?.habitatId).toBe("habitat_1");
    expect(restored.registration?.streamUrl).toBe("wss://planet.turingguild.com/planet/stream");
    expect(await storage.getRegistrationToken("habitat_1")).toBe(STREAM_TOKEN);
    expect(await storage.getRegistrationToken("habitat_attacker")).toBeUndefined();
    expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);
  });

  test("coordinated state replacement, reset, and restore reject persisted listener intent", async () => {
    const storage = createClockStorage(path);
    await writeSqliteState(path, normalizeState({ inventory: { water: 4 } }));
    await storage.saveClockState(keplerClockState({ latestPlanetTick: 800 }));
    const replacement = normalizeState({ inventory: { water: 99 } });
    const current = await createStateService({ storagePath: path }).getState();
    const currentRevision = getHabitatStateRevision(current);
    if (currentRevision !== undefined) attachHabitatStateRevision(replacement, currentRevision);

    await expect(storage.replaceState(replacement)).rejects.toThrow("clock listen off");
    await expect(storage.resetState()).rejects.toThrow("clock listen off");
    await expect(storage.restoreState(replacement)).rejects.toThrow("clock listen off");
    expect((await readSqliteState(path) as HabitatState).inventory.water).toBe(4);
    expect((await storage.getClockState()).latestPlanetTick).toBe(800);
  });

  test("registration state and token roll back when the clock reset aborts", async () => {
    const before = normalizeState({ inventory: { water: 4 } });
    await writeSqliteState(path, before);
    const storage = createClockStorage(path);
    const enabledClock = keplerClockState({ latestPlanetTick: 800 });
    await storage.saveClockState(enabledClock);

    const database = new Database(path, { create: false, readwrite: true });
    try {
      database.run(`
        CREATE TRIGGER abort_registration_clock_reset
        BEFORE UPDATE ON habitat_clock_state
        BEGIN
          SELECT RAISE(ABORT, 'fixture clock reset failure');
        END
      `);
    } finally {
      database.close();
    }

    const next = normalizeState({
      inventory: { water: 9 },
      registration: {
        displayName: "Habitat One",
        registeredAt: "2026-07-16T12:00:00.000Z",
        lastSyncedAt: "2026-07-16T12:00:00.000Z",
        habitatId: "habitat_1",
      },
    });

    await expect(storage.saveRegistration(next, STREAM_TOKEN))
      .rejects.toThrow("clock reset failure");

    expect(await readSqliteState(path)).toEqual(before);
    expect(await storage.getRegistrationToken("habitat_1")).toBeUndefined();
    expect(await storage.getClockState()).toEqual(enabledClock);
  });

  test("registration requires a public habitat id before storing a token", async () => {
    const storage = createClockStorage(path);

    await expect(storage.saveRegistration(normalizeState({}), STREAM_TOKEN))
      .rejects.toThrow("habitatId");
    expect(await readSqliteState(path)).toBeUndefined();
  });

  test("manual state mutations commit normalized habitat state", async () => {
    await writeSqliteState(path, { inventory: { water: 4 }, power: { powerConsumedTicks: 2 } });
    const storage = createClockStorage(path);

    const result = await storage.applyManualTick((state) => {
      state.power.powerConsumedTicks += 3;
      return { data: state, advancedConstructionTicks: 3 };
    });

    expect(result.advancedConstructionTicks).toBe(3);
    expect(result.data.power.powerConsumedTicks).toBe(5);
    expect((await readSqliteState(path) as HabitatState).power.powerConsumedTicks).toBe(5);
    expect((await readSqliteState(path) as HabitatState).alerts).toEqual([]);
  });

  test("manual state mutations roll back when the mutator throws", async () => {
    await writeSqliteState(path, normalizeState({ power: { powerConsumedTicks: 2 } }));
    const storage = createClockStorage(path);

    await expect(storage.applyManualTick((): StateMutationResult => {
      throw new Error("fixture mutation failure");
    })).rejects.toThrow("fixture mutation failure");

    expect((await readSqliteState(path) as HabitatState).power.powerConsumedTicks).toBe(2);
  });

  test("planet state and absolute cursor commit together", async () => {
    await writeSqliteState(path, normalizeState({ power: { powerConsumedTicks: 0 } }));
    const storage = createClockStorage(path);
    await storage.saveClockState(keplerClockState());

    const result = await storage.applyPlanetTick(notice, (state) => {
      state.power.powerConsumedTicks += notice.advancedBy;
      return { data: state };
    });

    expect(result.applied).toBe(true);
    expect(await storage.getClockState()).toEqual(keplerClockState({
      latestPlanetTick: 900,
      latestAdvancedBy: 100,
      lastMessageAt: notice.issuedAt,
    }));
    expect((await readSqliteState(path) as HabitatState).power.powerConsumedTicks).toBe(100);
  });

  test("planet ticks are ignored outside Kepler mode", async () => {
    await writeSqliteState(path, normalizeState({ power: { powerConsumedTicks: 2 } }));
    const storage = createClockStorage(path);
    let calls = 0;

    const result = await storage.applyPlanetTick(notice, (state) => {
      calls += 1;
      state.power.powerConsumedTicks += notice.advancedBy;
      return { data: state };
    });

    expect(result).toEqual({ applied: false });
    expect(calls).toBe(0);
    expect((await readSqliteState(path) as HabitatState).power.powerConsumedTicks).toBe(2);
    expect(await storage.getClockState()).toEqual(DEFAULT_CLOCK_STATE);
  });

  test("non-increasing planet ticks do not mutate state or cursor", async () => {
    await writeSqliteState(path, normalizeState({ power: { powerConsumedTicks: 2 } }));
    const storage = createClockStorage(path);
    const current = keplerClockState({
      latestPlanetTick: notice.tick,
      latestAdvancedBy: notice.advancedBy,
      lastMessageAt: notice.issuedAt,
    });
    await storage.saveClockState(current);
    let calls = 0;

    const result = await storage.applyPlanetTick(notice, (state) => {
      calls += 1;
      state.power.powerConsumedTicks += notice.advancedBy;
      return { data: state };
    });

    expect(result).toEqual({ applied: false });
    expect(calls).toBe(0);
    expect((await readSqliteState(path) as HabitatState).power.powerConsumedTicks).toBe(2);
    expect(await storage.getClockState()).toEqual(current);
  });

  test("overlapping planet ranges do not apply already-consumed ticks twice", async () => {
    await writeSqliteState(path, normalizeState({ power: { powerConsumedTicks: 0 } }));
    const storage = createClockStorage(path);
    await storage.saveClockState(keplerClockState({ latestPlanetTick: 800 }));

    expect((await storage.applyPlanetTick(notice, (state) => {
      state.power.powerConsumedTicks += notice.advancedBy;
      return { data: state };
    })).applied).toBe(true);

    let overlapMutations = 0;
    const overlapping = {
      ...notice,
      previousTick: 850,
      tick: 950,
      issuedAt: "2026-07-16T12:01:00.000Z",
    };
    const result = await storage.applyPlanetTick(overlapping, (state) => {
      overlapMutations += 1;
      state.power.powerConsumedTicks += overlapping.advancedBy;
      return { data: state };
    });

    expect(result).toEqual({ applied: false });
    expect(overlapMutations).toBe(0);
    expect((await readSqliteState(path) as HabitatState).power.powerConsumedTicks).toBe(100);
    expect((await storage.getClockState()).latestPlanetTick).toBe(900);
  });

  test("a stale ordinary state write cannot erase a committed planet tick", async () => {
    await writeSqliteState(path, normalizeState({
      inventory: { water: 4 },
      power: { powerConsumedTicks: 0 },
    }));
    const storage = createClockStorage(path);
    const stateService = createStateService({ storagePath: path });
    await storage.saveClockState(keplerClockState({ latestPlanetTick: 800 }));
    const stale = await stateService.getState();

    expect((await storage.applyPlanetTick(notice, (state) => {
      state.power.powerConsumedTicks += notice.advancedBy;
      return { data: state };
    })).applied).toBe(true);
    stale.inventory.water = 9;

    await expect(stateService.saveState(stale)).rejects.toThrow("changed since it was read");
    const persisted = await readSqliteState(path) as HabitatState;
    expect(persisted.inventory.water).toBe(4);
    expect(persisted.power.powerConsumedTicks).toBe(100);
    expect((await storage.getClockState()).latestPlanetTick).toBe(900);
  });

  test("planet state and cursor both roll back when the mutator throws", async () => {
    await writeSqliteState(path, normalizeState({ power: { powerConsumedTicks: 2 } }));
    const storage = createClockStorage(path);
    const current = keplerClockState({ latestPlanetTick: 800 });
    await storage.saveClockState(current);

    await expect(storage.applyPlanetTick(notice, (): StateMutationResult => {
      throw new Error("fixture mutation failure");
    })).rejects.toThrow("fixture mutation failure");

    expect((await readSqliteState(path) as HabitatState).power.powerConsumedTicks).toBe(2);
    expect(await storage.getClockState()).toEqual(current);
  });
});
