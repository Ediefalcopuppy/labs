import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { normalizeState } from "../state/service";
import type { HabitatState } from "../state/types";
import {
  attachHabitatStateRevision,
  getHabitatStateRevision,
  readHabitatStateRow,
  writeHabitatStateRow,
  writeHabitatStateRowIfRevision,
} from "../storage";
import {
  DEFAULT_CLOCK_STATE,
  type ClockConnectionState,
  type ClockMode,
  type ClockState,
  type PlanetTickNotice,
} from "./types";

const CLOCK_STATE_ID = 1;
const CLOCK_SCHEMA_VERSION = 1;

type ClockStateRow = {
  mode: string;
  listening_enabled: number;
  connection_state: string;
  latest_planet_tick: number | null;
  latest_advanced_by: number | null;
  last_connected_at: string | null;
  last_message_at: string | null;
  latest_error: string | null;
};

export type StateMutationResult = {
  data: HabitatState;
};

export type StateMutator<T extends StateMutationResult = StateMutationResult> =
  (state: HabitatState) => T;

export type PlanetTickResult<T extends StateMutationResult> =
  | (T & { applied: true })
  | { applied: false };

export type ClockStorage = {
  migrate(): Promise<void>;
  getClockState(): Promise<ClockState>;
  saveClockState(state: ClockState): Promise<ClockState>;
  saveRegistration(state: HabitatState, streamToken: string): Promise<HabitatState>;
  deleteRegistration(): Promise<HabitatState>;
  getRegistrationToken(habitatId: string): Promise<string | undefined>;
  replaceState(state: HabitatState): Promise<HabitatState>;
  resetState(): Promise<HabitatState>;
  restoreState(state: HabitatState): Promise<HabitatState>;
  applyManualTick<T extends StateMutationResult>(mutator: StateMutator<T>): Promise<T>;
  applyPlanetTick<T extends StateMutationResult>(
    notice: PlanetTickNotice,
    mutator: StateMutator<T>,
  ): Promise<PlanetTickResult<T>>;
};

export class ClockStateReplacementUnavailableError extends Error {
  constructor() {
    super("Turn the Kepler clock listen off before replacing or resetting habitat state.");
    this.name = "ClockStateReplacementUnavailableError";
  }
}

function applyMigration(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS habitat_clock_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL CHECK (mode IN ('manual', 'kepler')),
      listening_enabled INTEGER NOT NULL CHECK (listening_enabled IN (0, 1)),
      connection_state TEXT NOT NULL CHECK (connection_state IN ('connected', 'connecting', 'disconnected', 'error')),
      latest_planet_tick INTEGER,
      latest_advanced_by INTEGER,
      last_connected_at TEXT,
      last_message_at TEXT,
      latest_error TEXT
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS habitat_registration_secrets (
      habitat_id TEXT PRIMARY KEY,
      stream_token TEXT NOT NULL
    )
  `);
  database.query(`
    INSERT OR IGNORE INTO habitat_clock_state (
      id,
      mode,
      listening_enabled,
      connection_state,
      latest_planet_tick,
      latest_advanced_by,
      last_connected_at,
      last_message_at,
      latest_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    CLOCK_STATE_ID,
    DEFAULT_CLOCK_STATE.mode,
    Number(DEFAULT_CLOCK_STATE.listeningEnabled),
    DEFAULT_CLOCK_STATE.connectionState,
    DEFAULT_CLOCK_STATE.latestPlanetTick,
    DEFAULT_CLOCK_STATE.latestAdvancedBy,
    DEFAULT_CLOCK_STATE.lastConnectedAt,
    DEFAULT_CLOCK_STATE.lastMessageAt,
    DEFAULT_CLOCK_STATE.latestError,
  );
  database.query(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (?, ?)
  `).run(CLOCK_SCHEMA_VERSION, new Date().toISOString());
}

function runImmediateTransaction<T>(database: Database, operation: () => T): T {
  database.run("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.run("COMMIT");
    return result;
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
}

function readClockStateRow(database: Database): ClockState {
  const row = database.query<ClockStateRow, [number]>(`
    SELECT
      mode,
      listening_enabled,
      connection_state,
      latest_planet_tick,
      latest_advanced_by,
      last_connected_at,
      last_message_at,
      latest_error
    FROM habitat_clock_state
    WHERE id = ?
  `).get(CLOCK_STATE_ID);

  if (!row) {
    throw new Error("Habitat clock state has not been migrated.");
  }

  return {
    mode: row.mode as ClockMode,
    listeningEnabled: row.listening_enabled === 1,
    connectionState: row.connection_state as ClockConnectionState,
    latestPlanetTick: row.latest_planet_tick,
    latestAdvancedBy: row.latest_advanced_by,
    lastConnectedAt: row.last_connected_at,
    lastMessageAt: row.last_message_at,
    latestError: row.latest_error,
  };
}

function writeClockStateRow(database: Database, state: ClockState): void {
  database.query(`
    INSERT INTO habitat_clock_state (
      id,
      mode,
      listening_enabled,
      connection_state,
      latest_planet_tick,
      latest_advanced_by,
      last_connected_at,
      last_message_at,
      latest_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mode = excluded.mode,
      listening_enabled = excluded.listening_enabled,
      connection_state = excluded.connection_state,
      latest_planet_tick = excluded.latest_planet_tick,
      latest_advanced_by = excluded.latest_advanced_by,
      last_connected_at = excluded.last_connected_at,
      last_message_at = excluded.last_message_at,
      latest_error = excluded.latest_error
  `).run(
    CLOCK_STATE_ID,
    state.mode,
    Number(state.listeningEnabled),
    state.connectionState,
    state.latestPlanetTick,
    state.latestAdvancedBy,
    state.lastConnectedAt,
    state.lastMessageAt,
    state.latestError,
  );
}

function requireManualClock(database: Database): void {
  const clockState = readClockStateRow(database);
  if (clockState.mode !== "manual" || clockState.listeningEnabled) {
    throw new ClockStateReplacementUnavailableError();
  }
}

function preserveCurrentRegistration(
  database: Database,
  state: HabitatState,
): HabitatState {
  const current = normalizeState(readHabitatStateRow(database));
  const normalized = normalizeState(state);
  if (current.registration) {
    normalized.registration = structuredClone(current.registration);
  } else {
    delete normalized.registration;
  }
  return normalized;
}

function attachWrittenRevision(state: HabitatState, revision: number): HabitatState {
  return attachHabitatStateRevision(state, revision);
}

function removeOrphanedRegistrationSecrets(
  database: Database,
  state: HabitatState,
): void {
  const habitatId = state.registration?.habitatId;
  if (habitatId) {
    database
      .query("DELETE FROM habitat_registration_secrets WHERE habitat_id <> ?")
      .run(habitatId);
    return;
  }
  database.run("DELETE FROM habitat_registration_secrets");
}

export function createClockStorage(path: string): ClockStorage {
  async function migrate(): Promise<void> {
    const storageDirectory = dirname(path);
    await mkdir(storageDirectory, { recursive: true });
    if (
      basename(storageDirectory) === ".habitat" &&
      !(await lstat(storageDirectory)).isSymbolicLink()
    ) {
      await chmod(storageDirectory, 0o700);
    }
    const database = new Database(path);
    try {
      runImmediateTransaction(database, () => applyMigration(database));
    } finally {
      database.close();
      await chmod(path, 0o600);
    }
  }

  async function withMigratedDatabase<T>(operation: (database: Database) => T): Promise<T> {
    await migrate();
    const database = new Database(path, { create: false, readwrite: true });
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }

  return {
    migrate,

    async getClockState(): Promise<ClockState> {
      return withMigratedDatabase((database) => readClockStateRow(database));
    },

    async saveClockState(state: ClockState): Promise<ClockState> {
      return withMigratedDatabase((database) => runImmediateTransaction(database, () => {
        writeClockStateRow(database, state);
        return readClockStateRow(database);
      }));
    },

    async saveRegistration(state: HabitatState, streamToken: string): Promise<HabitatState> {
      const expectedRevision = getHabitatStateRevision(state);
      const normalized = normalizeState(state);
      const habitatId = normalized.registration?.habitatId;
      if (!habitatId) {
        throw new Error("Habitat registration must include a habitatId before storing its stream token.");
      }

      return withMigratedDatabase((database) => runImmediateTransaction(database, () => {
        if (expectedRevision === undefined) {
          writeHabitatStateRow(database, normalized);
        } else {
          writeHabitatStateRowIfRevision(database, normalized, expectedRevision);
        }
        database.query(`
          INSERT INTO habitat_registration_secrets (habitat_id, stream_token)
          VALUES (?, ?)
          ON CONFLICT(habitat_id) DO UPDATE SET stream_token = excluded.stream_token
        `).run(habitatId, streamToken);
        writeClockStateRow(database, DEFAULT_CLOCK_STATE);
        return normalized;
      }));
    },

    async deleteRegistration(): Promise<HabitatState> {
      return withMigratedDatabase((database) => runImmediateTransaction(database, () => {
        const state = normalizeState(readHabitatStateRow(database));
        delete state.registration;
        writeHabitatStateRow(database, state);
        database.run("DELETE FROM habitat_registration_secrets");
        writeClockStateRow(database, DEFAULT_CLOCK_STATE);
        return state;
      }));
    },

    async getRegistrationToken(habitatId: string): Promise<string | undefined> {
      return withMigratedDatabase((database) => database
        .query<{ stream_token: string }, [string]>(`
          SELECT stream_token
          FROM habitat_registration_secrets
          WHERE habitat_id = ?
        `)
        .get(habitatId)?.stream_token);
    },

    async replaceState(state: HabitatState): Promise<HabitatState> {
      const expectedRevision = getHabitatStateRevision(state);
      if (expectedRevision === undefined) {
        throw new Error("State replacement requires the revision returned when the state was loaded.");
      }

      return withMigratedDatabase((database) => runImmediateTransaction(database, () => {
        requireManualClock(database);
        const replacement = preserveCurrentRegistration(database, state);
        const revision = writeHabitatStateRowIfRevision(
          database,
          replacement,
          expectedRevision,
        );
        return attachWrittenRevision(replacement, revision);
      }));
    },

    async resetState(): Promise<HabitatState> {
      return withMigratedDatabase((database) => runImmediateTransaction(database, () => {
        requireManualClock(database);
        const reset = normalizeState({});
        const revision = writeHabitatStateRow(database, reset);
        database.run("DELETE FROM habitat_registration_secrets");
        writeClockStateRow(database, DEFAULT_CLOCK_STATE);
        return attachWrittenRevision(reset, revision);
      }));
    },

    async restoreState(state: HabitatState): Promise<HabitatState> {
      return withMigratedDatabase((database) => runImmediateTransaction(database, () => {
        requireManualClock(database);
        const restored = preserveCurrentRegistration(database, state);
        const revision = writeHabitatStateRow(database, restored);
        removeOrphanedRegistrationSecrets(database, restored);
        writeClockStateRow(database, DEFAULT_CLOCK_STATE);
        return attachWrittenRevision(restored, revision);
      }));
    },

    async applyManualTick<T extends StateMutationResult>(mutator: StateMutator<T>): Promise<T> {
      return withMigratedDatabase((database) => runImmediateTransaction(database, () => {
        const state = normalizeState(readHabitatStateRow(database));
        const result = mutator(state);
        const data = normalizeState(result.data);
        writeHabitatStateRow(database, data);
        return { ...result, data };
      }) as T);
    },

    async applyPlanetTick<T extends StateMutationResult>(
      notice: PlanetTickNotice,
      mutator: StateMutator<T>,
    ): Promise<PlanetTickResult<T>> {
      return withMigratedDatabase((database) => runImmediateTransaction(database, () => {
        const clockState = readClockStateRow(database);
        const state = normalizeState(readHabitatStateRow(database));
        if (
          clockState.mode !== "kepler" ||
          (clockState.latestPlanetTick !== null && (
            notice.tick <= clockState.latestPlanetTick ||
            notice.previousTick < clockState.latestPlanetTick
          ))
        ) {
          return { applied: false };
        }

        const result = mutator(state);
        const data = normalizeState(result.data);
        writeHabitatStateRow(database, data);
        writeClockStateRow(database, {
          ...clockState,
          latestPlanetTick: notice.tick,
          latestAdvancedBy: notice.advancedBy,
          lastMessageAt: notice.issuedAt,
        });
        return { ...result, data, applied: true };
      }) as PlanetTickResult<T>);
    },
  };
}
