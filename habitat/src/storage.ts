import { Database } from "bun:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const HABITAT_STATE_KEY = "habitat";
const HABITAT_STATE_REVISION = Symbol("habitat-state-revision");
const HABITAT_STATE_ETAG_PREFIX = "habitat-state-";

export class HabitatStateConflictError extends Error {
  constructor() {
    super("Habitat state changed since it was read; reload it and retry the command.");
    this.name = "HabitatStateConflictError";
  }
}

type RevisionCarrier = {
  [HABITAT_STATE_REVISION]?: number | null;
};

export function getHabitatStateRevision(state: unknown): number | null | undefined {
  if (!state || typeof state !== "object") return undefined;
  return (state as RevisionCarrier)[HABITAT_STATE_REVISION];
}

export function attachHabitatStateRevision<T extends object>(
  state: T,
  revision: number | null,
): T {
  Object.defineProperty(state, HABITAT_STATE_REVISION, {
    configurable: true,
    enumerable: false,
    value: revision,
    writable: true,
  });
  return state;
}

export function formatHabitatStateEtag(revision: number | null): string {
  return `"${HABITAT_STATE_ETAG_PREFIX}${revision === null ? "new" : revision}"`;
}

export function parseHabitatStateEtag(etag: string): number | null | undefined {
  const match = new RegExp(`^"${HABITAT_STATE_ETAG_PREFIX}(new|0|[1-9]\\d*)"$`).exec(etag);
  if (!match) return undefined;
  return match[1] === "new" ? null : Number(match[1]);
}

export function ensureHabitatStateTable(database: Database): void {
  database.run("CREATE TABLE IF NOT EXISTS habitat_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)");
  const columns = database
    .query<{ name: string }, []>("PRAGMA table_info(habitat_state)")
    .all();
  if (!columns.some((column) => column.name === "revision")) {
    database.run("ALTER TABLE habitat_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
  }
}

export function readHabitatStateRow(database: Database): unknown | undefined {
  ensureHabitatStateTable(database);
  const row = database
    .query<{ value_json: string; revision: number }, [string]>("SELECT value_json, revision FROM habitat_state WHERE key = ?")
    .get(HABITAT_STATE_KEY);
  if (!row) return undefined;
  const state = JSON.parse(row.value_json) as unknown;
  return state && typeof state === "object"
    ? attachHabitatStateRevision(state, row.revision)
    : state;
}

function readHabitatStateRevisionRow(database: Database): number {
  const row = database
    .query<{ revision: number }, [string]>("SELECT revision FROM habitat_state WHERE key = ?")
    .get(HABITAT_STATE_KEY);
  if (!row) throw new Error("Habitat state row was not persisted.");
  return row.revision;
}

export function writeHabitatStateRow(database: Database, state: unknown): number {
  ensureHabitatStateTable(database);
  database
    .query(`
      INSERT INTO habitat_state (key, value_json, revision)
      VALUES (?, ?, 0)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        revision = habitat_state.revision + 1
    `)
    .run(HABITAT_STATE_KEY, JSON.stringify(state));
  return readHabitatStateRevisionRow(database);
}

export function writeHabitatStateRowIfRevision(
  database: Database,
  state: unknown,
  expectedRevision: number | null,
): number {
  ensureHabitatStateTable(database);
  const serialized = JSON.stringify(state);
  if (expectedRevision === null) {
    const result = database
      .query("INSERT OR IGNORE INTO habitat_state (key, value_json, revision) VALUES (?, ?, 0)")
      .run(HABITAT_STATE_KEY, serialized);
    if (result.changes !== 1) throw new HabitatStateConflictError();
    return 0;
  }

  const result = database
    .query("UPDATE habitat_state SET value_json = ?, revision = revision + 1 WHERE key = ? AND revision = ?")
    .run(serialized, HABITAT_STATE_KEY, expectedRevision);
  if (result.changes !== 1) throw new HabitatStateConflictError();
  return expectedRevision + 1;
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function readSqliteState(path: string): Promise<unknown | undefined> {
  let database: Database | undefined;
  try {
    database = new Database(path, { create: false, readwrite: true });
    return readHabitatStateRow(database);
  } catch (error) {
    if (error instanceof Error && error.message.includes("unable to open database file")) {
      return undefined;
    }
    throw error;
  } finally {
    database?.close();
  }
}

export async function writeSqliteState(path: string, state: unknown): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const database = new Database(path);
  try {
    database.run("BEGIN IMMEDIATE");
    const expectedRevision = getHabitatStateRevision(state);
    const revision = expectedRevision === undefined
      ? writeHabitatStateRow(database, state)
      : writeHabitatStateRowIfRevision(database, state, expectedRevision);
    database.run("COMMIT");
    if (state && typeof state === "object") {
      attachHabitatStateRevision(state, revision);
    }
    return revision;
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
